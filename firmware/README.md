# EdgeAI ControlLab firmware (ESP32-S3)

Pins follow `../hardware_wiring_guide.md` exactly (constants in `src/config.h`).

## Flash

Plug the board in and check which port shows up:

```bash
ls /dev/cu.usb*
```

- `/dev/cu.usbserial*` / `/dev/cu.wchusbserial*` → **COM/UART port** → env `esp32s3_uart` (default)
- `/dev/cu.usbmodem*` → **native USB port** → env `esp32s3_usb`

```bash
pio run -e esp32s3_uart -t upload
pio device monitor -e esp32s3_uart
```

If upload hangs at `Connecting...`: hold **BOOT**, tap **RST**, release BOOT, retry.

## Bench bring-up (serial monitor)

The motor stays **IDLE** after boot until it gets a command. It also stops if no line arrives
for 1.5 s (host-link watchdog), so a single typed `pwm`/`rpm` is a short jog. The backend sends
`ping` every 0.5 s to keep it running. Type:

| Command | Does |
|---|---|
| `tele off` / `tele on` | pause the 100 Hz JSON stream so the monitor is readable |
| `scan` | I2C scan — expect `0x3C 0x40 0x68` |
| `status` | sensors found, encoder count, RPM, current, temp, distance, fault |
| `pwm 80` | open-loop drive (0–255) — motor spin test |
| `rpm 150` | closed-loop PID to 150 RPM |
| `stop` | motor off |
| `reset` | clear a latched fault (OVERCURRENT / OVERHEAT / STALL) |
| `ping` | heartbeat, keeps the motor running |
| `idreset` | wipe the on-device learned model (start learning again) |
| `onewire` | DS18B20 line diagnostic (pull-up / presence / ROM) |

Checks:
1. `pwm 80`, then `status` a few times: `rpm` should be **positive**. If negative, set `ENCODER_INVERT = true` in `src/config.h` (otherwise the STALL fault trips in PID mode).
2. At `pwm 255` the RPM should be near 300 (no-load). If it is off by a constant factor, fix `ENCODER_PPR` / `GEAR_RATIO`.
3. Current at no load ~0.05–0.3 A. Trips: ≥2.0 A instantly, >1.2 A for 200 ms.

## Edge AI on the ESP32

Three things run inside the 100 Hz control task, all learned from the live motor:

### 1. Online identification (`src/sysid.h`)
A bank of recursive-least-squares identifiers fits `y[k] = a*y[k-1] + b*u[k-d] + c` for every
delay d = 1..6 samples on the same informative samples, and keeps the one that predicts best
(switching only on a 10 % win). That gives `K = b/(1-a)` (RPM per PWM), `tau = -Ts/ln(a)` and the
delay. It trusts the model only after a real transient (≥ 40 PWM of drive range), ≥ 60 informative
samples and settled estimates, and it pauses learning while a D term is active (the D term feeds
speed noise into the PWM and biases closed-loop identification).
Bench motor: K ≈ 1.22 RPM/PWM, tau ≈ 60 ms, d = 3 (30 ms); batch fits on logged data agree
(96 % free-run fit).

### 2. Neural PI tuner (`src/nn_tuner.h`, weights in `src/nn_tuner_weights.h`)
An MLP 3-16-16-2 maps the identified (K, tau, d) to PI gains. It was trained by
`ml/train_tuner.py` on 4000 simulated motors simulated exactly as the ESP32 sees them, labelled
with closed-loop-optimal gains (≤ 5 % overshoot). Held out: median cost 1.016× the optimum
vs 1.98× for the lambda rule; better than the lambda rule on 99 % of motors.
On the bench motor: steps settle in **0.15–0.27 s** (lambda rule 0.53–0.73 s), ≤ 1.3 % overshoot.
**Adaptive AI** mode applies these gains (or the lambda-rule gains: `"tuner":"lambda"` /
`tuner lambda`), smoothed, with bumpless transfer.

### 3. Anomaly detection (`src/anomaly.h`)
After the model is trusted, the detector learns a healthy baseline for 6 s of running: the spread
of the gap between the motor and a **digital twin** (a frozen copy of the learned model fed the same
PWM), motor current as a function of speed and PWM, and vibration per 40 RPM speed band. Then it
scores z-scores against that baseline, the drift of the live K from the healthy K, and the thermal
margin, and diagnoses LOAD, DRIVE_LOSS, OVERSPEED, VIBRATION, DRIFT or THERMAL. A diagnosis must
persist 0.3 s (vibration 1 s) before it is reported. Advisory only: the hard limits still cut the
motor. Stress test on the bench (30 s of steps, sweeps, jumps to 80/260 RPM, mode switches):
no false alarms.

Commands: `idreset` (relearn the model and baseline), `baseline` (relearn the baseline only),
`tuner nn|lambda`; JSON `{"cmd":"idreset"|"baseline"|"status"}`, `{"tuner":"nn"|"lambda"}`.

Telemetry adds `idK idTau idD idN idOk aKp aKi` (lambda) `nKp nKi` (neural) `tun`, anomaly
`an acl zs zi zv kdr twin abp therm`, and the applied `mode gKp gKi gKd`.

## Placeholder values for missing sensors

- **Temperature:** without a DS18B20, `temp` comes from a motor thermal model (copper loss from the
  measured current plus speed-dependent friction; heats with tau 90 s, cools with 240 s). It is flagged
  `"tsrc":"model"`, shown as `T..C~` on the OLED and "(thermal model)" on the dashboard.
- **Distance:** without an HC-SR04 echo, `dist` is a fixed 5.5 cm, flagged `"dsrc":"fixed"` (`*` on the
  OLED, "(fixed)" on the dashboard).

Both switch to the real sensor automatically once it responds.

## Run with the dashboard

```bash
cd ../backend
CONTROLLAB_SERIAL=/dev/cu.usbserial-XXXX venv/bin/uvicorn main:app --port 8088
```

Close the PlatformIO serial monitor first (only one program can open the port). Without
`CONTROLLAB_SERIAL` the backend runs the simulator as before. When the last dashboard tab
disconnects, the backend sends an E-stop to the motor.

Telemetry fields: `time ref output(RPM) input(PWM 0-255) error current(A) temp(°C) fault`
plus `vib` (g RMS), `dist` (cm), `volt` (V), `tsrc`/`dsrc` (sensor or placeholder), and the
identification fields above. With the current INA219 wiring `volt` reads ~0 while driving; ignore it.
