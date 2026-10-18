# Neural PI tuner: training

`train_tuner.py` produces the network that runs on the ESP32 (`firmware/src/nn_tuner_weights.h`)
and its copy for the backend (`backend/models/nn_tuner.json`, served at `/api/nn_info`).

```bash
python3 ml/train_tuner.py            # ~1.5 min on a laptop, needs numpy
```

1. 4000 random speed plants (K 0.3–3 RPM/PWM, tau 20–600 ms, dead time 1–5 samples, PWM dead-zone,
   sensor noise), simulated like the firmware: 10 ms loop, 5-sample speed window, PWM 0..255, the
   firmware's PI law.
2. Each plant is identified with the same algorithm as the ESP32 (first order + offset, delay bank
   1..6, informative-sample gating). The identified (K, tau, d) are the network inputs.
3. Labels: PI gains minimising a time-weighted absolute error over a step sequence, with an
   overshoot penalty that is steep beyond 5 %, plus a small control-activity term (grid search and
   refinement).
4. MLP 3-16-16-2 (tanh), Adam, early stopping on a 20 % hold-out. The report records held-out
   closed-loop cost against the optimum and against the lambda rule, plus permutation feature
   importance.

After retraining, rebuild and flash the firmware so the ESP32 picks up the new weights.
