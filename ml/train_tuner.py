"""Train the neural PI tuner that runs on the ESP32.

Pipeline
  1. Sample thousands of random DC-motor speed plants (gain, time constant, dead time, PWM dead-zone,
     sensor noise) and simulate them exactly the way the firmware sees them: 10 ms loop, 5-sample
     speed window, PWM clamp 0..255, the firmware's PI law with conditional integration.
  2. For each plant, run the same identification the ESP32 runs (first-order + 3-sample delay +
     offset, informative-sample gating) on an open-loop excitation record -> (K_id, tau_id).
     These identified values, not the true ones, are the network inputs, so the network learns to
     correct for the model mismatch the on-device identifier has.
  3. Label each plant with the PI gains that minimise a closed-loop cost (time-weighted absolute
     error over a step sequence + overshoot + control activity), found by a vectorised grid search
     and a local refinement.
  4. Train a small MLP  [log K_id, log tau_id] -> [log Kp, log Ki]  with Adam, evaluate it against
     the grid optimum and the lambda-tuning rule on held-out plants, compute permutation feature
     importance, and export:
        firmware/src/nn_tuner_weights.h   (float arrays for the ESP32)
        backend/models/nn_tuner.json      (same weights + training report for the backend/dashboard)

Run:  python3 ml/train_tuner.py            (about 1-3 minutes on a laptop)
"""
import json
import math
import os
import time
from datetime import datetime, timezone
from multiprocessing import Pool

import warnings

import numpy as np

# numpy 2.x on macOS Accelerate raises spurious "divide by zero/overflow in matmul" warnings on
# perfectly finite inputs; the results are checked (validation MSE, closed-loop costs) below.
warnings.filterwarnings("ignore", message=".*encountered in matmul")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS = 0.01
WINDOW = 5          # firmware SPEED_WINDOW
ID_DELAYS = range(1, 7)  # firmware runs one identifier per candidate delay and keeps the best
LAMBDA_T = 0.15  # firmware lambda-tuning closed-loop time constant (baseline for comparison)


# ----------------------------------------------------------------------------- plants -------------
def sample_plant(rng):
    return dict(
        K=float(np.exp(rng.uniform(np.log(0.3), np.log(3.0)))),       # RPM per PWM step
        tau=float(np.exp(rng.uniform(np.log(0.02), np.log(0.6)))),    # s
        delay=int(rng.integers(1, 6)),                                # samples of pure delay
        u0=float(rng.uniform(0.0, 15.0)),                             # PWM dead-zone
        noise=float(rng.uniform(0.1, 0.6)),                           # RPM, speed-estimate noise
    )


class Measured:
    """Speed measurement like the firmware: count difference over a 5-sample window = mean speed."""

    def __init__(self, shape):
        self.buf = np.zeros((WINDOW,) + shape)
        self.i = 0

    def push(self, x):
        self.buf[self.i % WINDOW] = x
        self.i += 1
        return self.buf.mean(axis=0)


def simulate_open_loop(p, u, rng):
    a = math.exp(-TS / p["tau"])
    n = len(u)
    x = 0.0
    meas = Measured(())
    y = np.zeros(n)
    for k in range(n):
        ue = u[k - p["delay"]] if k >= p["delay"] else 0.0
        x = a * x + (1 - a) * p["K"] * max(ue - p["u0"], 0.0)
        y[k] = meas.push(x) + rng.normal(0, p["noise"])
    return y


def identify(u, y):
    """Batch version of the firmware identifier bank: for each delay d fit
    y[k] = a y[k-1] + b u[k-d] + c on the same informative samples (speed moving, or drive changed in
    the last 7 samples) and keep the delay with the smallest one-step prediction error."""
    D = max(ID_DELAYS)
    k = np.arange(D + 2, len(y))
    drive_changed = np.abs(u[k - 1] - u[k - D - 1]) > 1.0
    informative = (np.abs(y[k] - y[k - 1]) > 0.6) | drive_changed
    driven = np.all([u[k - j] > 0 for j in range(1, D + 2)], axis=0)
    k = k[informative & driven]
    best = None
    for d in ID_DELAYS:
        X = np.c_[y[k - 1], u[k - d], np.ones(len(k))]
        th, *_ = np.linalg.lstsq(X, y[k], rcond=None)
        rms = float(np.sqrt(np.mean((y[k] - X @ th) ** 2)))
        if best is None or rms < best[0]:
            best = (rms, d, th)
    _, d, (a, b, c) = best
    a = min(max(a, 0.30), 0.995)
    return b / (1 - a), -TS / math.log(a), d


def excitation(rng, n=1500):
    u = np.zeros(n)
    k = 0
    while k < n:
        hold = int(rng.choice([5, 10, 20, 40, 80]))
        u[k:k + hold] = rng.uniform(0.35, 0.8) * 255
        k += hold
    return u


# --------------------------------------------------------------------- closed loop ----------------
def reference(p):
    ymax = p["K"] * (255 - p["u0"])
    n = 450
    r = np.zeros(n)
    r[10:160] = 0.45 * ymax
    r[160:300] = 0.80 * ymax
    r[300:] = 0.30 * ymax
    return r, ymax


def closed_loop_cost(p, kp, ki, rng, return_trace=False):
    """Vectorised over candidate gain arrays kp, ki (same shape). Firmware PI law, exact."""
    r, ymax = reference(p)
    a = math.exp(-TS / p["tau"])
    shape = np.shape(kp)
    x = np.zeros(shape)
    integ = np.zeros(shape)
    meas = Measured(shape)
    upast = np.zeros((p["delay"],) + shape)
    noise = rng.normal(0, p["noise"], size=len(r))  # same noise for every candidate
    cost = np.zeros(shape)
    tv = np.zeros(shape)
    peak_err = np.zeros(shape)
    u_prev = np.zeros(shape)
    t_since = 0
    seg_start_ref = 0.0
    trace = []
    for k in range(len(r)):
        y = meas.push(x) + noise[k]
        if k > 0 and r[k] != r[k - 1]:
            t_since = 0
            seg_start_ref = r[k - 1]
        e = r[k] - y
        unsat = kp * e + ki * (integ + e * TS)
        hold = ((unsat > 255) & (e > 0)) | ((unsat < 0) & (e < 0))
        integ = np.where(hold, integ, np.clip(integ + e * TS, -400, 400))
        u = np.clip(kp * e + ki * integ, 0, 255)
        # plant (with pure delay on the input)
        ue = upast[0] if p["delay"] > 0 else u
        if p["delay"] > 0:
            upast = np.roll(upast, -1, axis=0)
            upast[-1] = u
        x = a * x + (1 - a) * p["K"] * np.maximum(ue - p["u0"], 0.0)
        if r[k] > 0:
            t = t_since * TS
            cost += (0.2 + t) * np.abs(e) / ymax * TS
            step = r[k] - seg_start_ref
            if step != 0:  # overshoot relative to the step direction
                peak_err = np.maximum(peak_err, -np.sign(step) * e / ymax)
        tv += np.abs(u - u_prev) / 255.0
        u_prev = u
        t_since += 1
        if return_trace:
            trace.append((r[k], float(np.ravel(y)[0]), float(np.ravel(u)[0])))
    # Overshoot: mild quadratic penalty plus a steep one beyond 5 % (lab requirement: <= 5 %).
    os_ = np.maximum(peak_err, 0)
    cost += 10.0 * os_ ** 2 + 5.0 * np.maximum(os_ - 0.05, 0) + 0.002 * tv
    return (cost, trace) if return_trace else cost


def lambda_gains(K, tau, d):
    den = K * (LAMBDA_T + d * TS)
    return float(np.clip(tau / den, 0.05, 1.5)), float(np.clip(1.0 / den, 0.2, 10.0))


def label_plant(seed):
    rng = np.random.default_rng(seed)
    p = sample_plant(rng)
    u = excitation(rng)
    y = simulate_open_loop(p, u, rng)
    K_id, tau_id, d_id = identify(u, y)
    if not (0.05 < K_id < 20 and 0.003 < tau_id < 5):
        return None
    # grid in dimensionless gains (kp*K, ki*K), then refine around the best point
    gk = np.exp(np.linspace(np.log(0.01), np.log(3.0), 36))
    gi = np.exp(np.linspace(np.log(0.3), np.log(60.0), 36))
    KP, KI = np.meshgrid(gk / p["K"], gi / p["K"], indexing="ij")
    cost = closed_loop_cost(p, KP, KI, np.random.default_rng(seed + 1))
    i, j = np.unravel_index(np.argmin(cost), cost.shape)
    kp0, ki0 = KP[i, j], KI[i, j]
    fk = np.exp(np.linspace(-0.25, 0.25, 11))
    KP2, KI2 = np.meshgrid(kp0 * fk, ki0 * fk, indexing="ij")
    cost2 = closed_loop_cost(p, KP2, KI2, np.random.default_rng(seed + 1))
    i, j = np.unravel_index(np.argmin(cost2), cost2.shape)
    kp, ki = float(KP2[i, j]), float(KI2[i, j])
    best = float(cost2[i, j])
    lkp, lki = lambda_gains(K_id, tau_id, d_id)
    lam_cost = float(closed_loop_cost(p, np.array(lkp), np.array(lki), np.random.default_rng(seed + 1)))
    return dict(seed=seed, plant=p, K_id=float(K_id), tau_id=float(tau_id), d_id=int(d_id), kp=kp, ki=ki,
                cost_opt=best, cost_lambda=lam_cost)


# ------------------------------------------------------------------------------ MLP -------------
class MLP:
    def __init__(self, sizes, rng):
        self.W = [rng.normal(0, math.sqrt(1.0 / m), (m, n)) for m, n in zip(sizes[:-1], sizes[1:])]
        self.b = [np.zeros(n) for n in sizes[1:]]

    def forward(self, x):
        acts = [x]
        for li, (W, b) in enumerate(zip(self.W, self.b)):
            z = acts[-1] @ W + b
            acts.append(np.tanh(z) if li < len(self.W) - 1 else z)
        return acts

    def predict(self, x):
        return self.forward(x)[-1]

    def train(self, X, Y, Xv, Yv, epochs=4000, lr=3e-3, wd=1e-5, rng=None):
        params = self.W + self.b
        m = [np.zeros_like(q) for q in params]
        v = [np.zeros_like(q) for q in params]
        best = (1e9, None)
        n = len(X)
        for ep in range(1, epochs + 1):
            idx = rng.permutation(n)
            for s in range(0, n, 256):
                bi = idx[s:s + 256]
                acts = self.forward(X[bi])
                g = 2 * (acts[-1] - Y[bi]) / len(bi)
                gW, gb = [], []
                for li in reversed(range(len(self.W))):
                    gW.insert(0, acts[li].T @ g + wd * self.W[li])
                    gb.insert(0, g.sum(axis=0))
                    if li > 0:
                        g = (g @ self.W[li].T) * (1 - acts[li] ** 2)
                grads = gW + gb
                params = self.W + self.b
                for q, gq, mq, vq in zip(params, grads, m, v):
                    mq *= 0.9; mq += 0.1 * gq
                    vq *= 0.999; vq += 0.001 * gq * gq
                    q -= lr * (mq / (1 - 0.9 ** ep)) / (np.sqrt(vq / (1 - 0.999 ** ep)) + 1e-8)
            if ep % 50 == 0:
                val = float(np.mean((self.predict(Xv) - Yv) ** 2))
                if val < best[0]:
                    best = (val, ([w.copy() for w in self.W], [c.copy() for c in self.b]))
            if ep % 1000 == 0:
                lr *= 0.5
        self.W, self.b = best[1]
        return best[0]


# --------------------------------------------------------------------------- main --------------
def main():
    t0 = time.time()
    n_plants = int(os.environ.get("N_PLANTS", "4000"))
    with Pool() as pool:
        rows = [r for r in pool.map(label_plant, range(1000, 1000 + n_plants), chunksize=20) if r]
    print(f"labelled {len(rows)} plants in {time.time() - t0:.0f} s")

    X = np.array([[math.log(r["K_id"]), math.log(r["tau_id"]), float(r["d_id"])] for r in rows])
    Y = np.array([[math.log(r["kp"]), math.log(r["ki"])] for r in rows])
    xm, xs = X.mean(0), X.std(0)
    ym, ys = Y.mean(0), Y.std(0)
    Xn, Yn = (X - xm) / xs, (Y - ym) / ys

    rng = np.random.default_rng(0)
    perm = rng.permutation(len(rows))
    n_val = len(rows) // 5
    va, tr = perm[:n_val], perm[n_val:]
    net = MLP([3, 16, 16, 2], rng)
    val_mse = net.train(Xn[tr], Yn[tr], Xn[va], Yn[va], rng=rng)

    def nn_gains(K_id, tau_id, d_id):
        z = (np.array([[math.log(K_id), math.log(tau_id), float(d_id)]]) - xm) / xs
        out = net.predict(z)[0] * ys + ym
        return float(np.exp(out[0])), float(np.exp(out[1]))

    # held-out closed-loop evaluation: NN vs grid optimum vs lambda rule
    ratios_nn, ratios_lam = [], []
    for i in va[:400]:
        r = rows[i]
        kp, ki = nn_gains(r["K_id"], r["tau_id"], r["d_id"])
        c = float(closed_loop_cost(r["plant"], np.array(kp), np.array(ki), np.random.default_rng(r["seed"] + 1)))
        ratios_nn.append(c / r["cost_opt"])
        ratios_lam.append(r["cost_lambda"] / r["cost_opt"])
    ratios_nn, ratios_lam = np.array(ratios_nn), np.array(ratios_lam)

    # permutation importance (increase in validation MSE when a feature is shuffled)
    base = float(np.mean((net.predict(Xn[va]) - Yn[va]) ** 2))
    importance = {}
    for fi, name in enumerate(["identified gain K", "identified time constant tau", "identified delay d"]):
        Xp = Xn[va].copy()
        Xp[:, fi] = rng.permutation(Xp[:, fi])
        importance[name] = float(np.mean((net.predict(Xp) - Yn[va]) ** 2) - base)
    tot = sum(max(v, 0) for v in importance.values()) or 1.0
    importance = {k: round(max(v, 0) / tot, 3) for k, v in importance.items()}

    real_K, real_tau, real_d = 1.17, 0.073, 3  # offline fit of the lab's JGA12-N20 (firmware README)
    report = dict(
        trained_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        n_plants=len(rows), n_train=len(tr), n_val=len(va),
        architecture="MLP 3-16-16-2, tanh hidden, linear output",
        inputs=["log K_id (RPM/PWM)", "log tau_id (s)", "d_id (samples)"], outputs=["log Kp", "log Ki"],
        identified_delay_histogram={str(d): int(sum(1 for r in rows if r["d_id"] == d)) for d in ID_DELAYS},
        plant_ranges=dict(K=[0.3, 3.0], tau_s=[0.02, 0.6], delay_samples=[1, 5], deadzone_pwm=[0, 15],
                          noise_rpm=[0.1, 0.6]),
        val_mse_normalised=round(val_mse, 4),
        cost_ratio_vs_optimum=dict(nn_median=round(float(np.median(ratios_nn)), 3),
                                   nn_p90=round(float(np.percentile(ratios_nn, 90)), 3),
                                   lambda_median=round(float(np.median(ratios_lam)), 3),
                                   lambda_p90=round(float(np.percentile(ratios_lam, 90)), 3)),
        nn_better_than_lambda_pct=round(float(np.mean(ratios_nn < ratios_lam) * 100), 1),
        feature_importance=importance,
        lab_motor_prediction=dict(K_id=real_K, tau_id=real_tau, d_id=real_d,
                                  kp=round(nn_gains(real_K, real_tau, real_d)[0], 3),
                                  ki=round(nn_gains(real_K, real_tau, real_d)[1], 3)),
        train_seconds=round(time.time() - t0, 1),
    )
    model = dict(report=report, x_mean=xm.tolist(), x_std=xs.tolist(), y_mean=ym.tolist(),
                 y_std=ys.tolist(), W=[w.tolist() for w in net.W], b=[c.tolist() for c in net.b])
    with open(os.path.join(ROOT, "backend", "models", "nn_tuner.json"), "w") as f:
        json.dump(model, f, indent=1)
    write_header(model)
    print(json.dumps(report, indent=1))


def write_header(model):
    def arr(name, a):
        flat = np.ravel(np.array(a, dtype=np.float32))
        body = ", ".join(f"{v:.7g}f" for v in flat)
        return f"static const float {name}[{len(flat)}] = {{{body}}};\n"

    r = model["report"]
    sizes = [len(model["W"][0])] + [len(b) for b in model["b"]]
    out = ["// Generated by ml/train_tuner.py -- do not edit.\n",
           f"// Trained {r['trained_at']} on {r['n_plants']} simulated motors. Held-out cost vs optimum:\n",
           f"//   NN median {r['cost_ratio_vs_optimum']['nn_median']}x, lambda rule median "
           f"{r['cost_ratio_vs_optimum']['lambda_median']}x.\n",
           "#pragma once\n\n",
           f"static const int NN_SIZES[{len(sizes)}] = {{{', '.join(map(str, sizes))}}};\n",
           arr("NN_X_MEAN", model["x_mean"]), arr("NN_X_STD", model["x_std"]),
           arr("NN_Y_MEAN", model["y_mean"]), arr("NN_Y_STD", model["y_std"])]
    for i, (W, b) in enumerate(zip(model["W"], model["b"])):
        out.append(arr(f"NN_W{i}", W))  # row-major [in][out]
        out.append(arr(f"NN_B{i}", b))
    with open(os.path.join(ROOT, "firmware", "src", "nn_tuner_weights.h"), "w") as f:
        f.writelines(out)


if __name__ == "__main__":
    main()
