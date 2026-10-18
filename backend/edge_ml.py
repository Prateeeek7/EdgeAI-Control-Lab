"""Identification and tuning shared by the API.

Uses the same model structure and the same trained network as the ESP32 firmware, so a model
identified here from logged data and a model identified on the board are directly comparable.
"""
import json
import math
import os
from typing import Dict, List, Optional

import numpy as np

TS = 0.01
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "nn_tuner.json")


class NeuralTuner:
    """MLP trained by ml/train_tuner.py: (log K, log tau, delay) -> (log Kp, log Ki)."""

    def __init__(self, path: str = MODEL_PATH):
        with open(path) as f:
            m = json.load(f)
        self.report = m["report"]
        self.xm, self.xs = np.array(m["x_mean"]), np.array(m["x_std"])
        self.ym, self.ys = np.array(m["y_mean"]), np.array(m["y_std"])
        self.W = [np.array(w) for w in m["W"]]
        self.b = [np.array(c) for c in m["b"]]

    def predict(self, K: float, tau: float, delay: int) -> Dict[str, float]:
        # same input clamping as the firmware (training range)
        K = min(max(K, 0.3), 3.0)
        tau = min(max(tau, 0.02), 0.6)
        h = (np.array([math.log(K), math.log(tau), float(delay)]) - self.xm) / self.xs
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            h = h @ W + b
            if i < len(self.W) - 1:
                h = np.tanh(h)
        out = h * self.ys + self.ym
        return {"kp": float(min(max(math.exp(out[0]), 0.02), 3.0)),
                "ki": float(min(max(math.exp(out[1]), 0.2), 40.0)), "kd": 0.0}


def lambda_rule(K: float, tau: float, delay: int, lam: float = 0.15) -> Dict[str, float]:
    den = K * (lam + delay * TS)
    return {"kp": float(min(max(tau / den, 0.05), 1.5)), "ki": float(min(max(1.0 / den, 0.2), 10.0)), "kd": 0.0}


def _simulate(theta: np.ndarray, u: np.ndarray, y0: float, d: int, order: int) -> np.ndarray:
    ys = np.full(len(u), y0, dtype=float)
    start = max(order, d) + 1
    for k in range(start, len(u)):
        if order == 1:
            ys[k] = theta[0] * ys[k - 1] + theta[1] * u[k - d] + theta[2]
        else:
            ys[k] = theta[0] * ys[k - 1] + theta[1] * ys[k - 2] + theta[2] * u[k - d] + theta[3]
    return ys


def identify(time: List[float], u_in: List[float], y_in: List[float]) -> Dict:
    """Least-squares fits on a logged record (PWM -> RPM).

    First order + delay + offset:   y[k] = a y[k-1] + b u[k-d] + c        (d = 1..6, best kept)
    Second order + delay + offset:  y[k] = a1 y[k-1] + a2 y[k-2] + b u[k-d] + c
    Fit % is the free-run simulation fit (NRMSE), the honest test of a dynamic model.
    """
    u, y = np.asarray(u_in, float), np.asarray(y_in, float)
    if len(y) < 60:
        raise ValueError("need at least 60 samples")
    if np.ptp(u) < 10:
        raise ValueError("the drive (PWM) barely changed in this record: run an excitation step first")
    ts = float(np.median(np.diff(time))) if len(time) > 2 else TS
    driven = u > 0
    out: Dict = {"samples": int(len(y)), "ts": ts}
    denom = np.linalg.norm(y - y.mean()) or 1.0

    best1: Optional[Dict] = None
    for d in range(1, 7):
        k = np.arange(max(d, 1) + 1, len(y))
        k = k[driven[k - d]]
        X = np.c_[y[k - 1], u[k - d], np.ones(len(k))]
        th, *_ = np.linalg.lstsq(X, y[k], rcond=None)
        a = float(np.clip(th[0], 0.3, 0.999))
        th[0] = a
        sim = _simulate(th, u, float(y[0]), d, 1)
        fit = 100 * (1 - np.linalg.norm(y - sim) / denom)
        if best1 is None or fit > best1["fit_pct"]:
            best1 = dict(delay=d, K=float(th[1] / (1 - a)), tau=float(-ts / math.log(a)),
                         offset=float(th[2] / (1 - a)), fit_pct=float(fit),
                         rmse=float(np.sqrt(np.mean((y - sim) ** 2))))
    out["first_order"] = best1

    d = best1["delay"]
    k = np.arange(max(d, 2) + 1, len(y))
    k = k[driven[k - d]]
    X = np.c_[y[k - 1], y[k - 2], u[k - d], np.ones(len(k))]
    th, *_ = np.linalg.lstsq(X, y[k], rcond=None)
    a1, a2, b, c = map(float, th)
    sim = _simulate(th, u, float(y[0]), d, 2)
    fit2 = 100 * (1 - np.linalg.norm(y - sim) / denom)
    poles_z = np.roots([1, -a1, -a2])

    def to_s(pz: complex) -> complex:
        # A real discrete pole at or below zero has no physical continuous equivalent (it appears
        # when the data are really first order); treat it as a very fast real pole instead.
        pz = complex(pz)
        if abs(pz.imag) < 1e-9 and pz.real <= 1e-6:
            return complex(math.log(1e-6) / ts, 0.0)
        return complex(np.log(pz) / ts)

    poles_s = [to_s(p) for p in poles_z]
    if all(abs(p.imag) < 1e-9 for p in poles_s):
        wn = math.sqrt(abs(poles_s[0].real * poles_s[1].real))
        zeta = -(poles_s[0].real + poles_s[1].real) / (2 * wn) if wn > 0 else 1.0
    else:
        wn = abs(poles_s[0])
        zeta = -poles_s[0].real / wn
    def finite(v: float) -> Optional[float]:
        return float(v) if math.isfinite(v) else None

    out["second_order"] = dict(delay=d, K=finite(b / (1 - a1 - a2)), zeta=finite(zeta), wn=finite(wn),
                               poles=[[p.real, p.imag] for p in poles_s], fit_pct=float(fit2),
                               rmse=float(np.sqrt(np.mean((y - sim) ** 2))))
    return out
