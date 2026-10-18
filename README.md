# EdgeAI ControlLab: AI-Native Universal Adaptive Control Platform

> **An intelligent, edge-computing control engineering ecosystem integrating real-time system identification, TinyML adaptive gain synthesis, multi-modal fault diagnosis, and a high-fidelity 3D digital twin.**

---

## 1. Project Overview

**EdgeAI ControlLab** is a next-generation control systems platform engineered to bridge classical control theory with modern Edge Artificial Intelligence. Conventional industrial controllers (such as fixed-gain PIDs) rely on manual tuning (Ziegler-Nichols, Cohen-Coon) or linear approximations around a single operating point. When physical systems encounter non-linear friction, thermal drift, supply fluctuations, or dynamic load changes, classical fixed-gain controllers experience performance degradation, instability, or mechanical fatigue.

EdgeAI ControlLab transforms a physical mechatronic plant into a self-identifying, self-tuning, and self-protecting intelligent machine. By combining a dual-core 240 MHz **ESP32-S3** microcontroller with embedded sensor fusion, lightweight neural inference, and a low-latency web-based digital twin, the platform autonomously:
1. **Identifies** the physical plant’s mathematical model ($G(s)$) using active system identification signals (step, chirp, PRBS).
2. **Synthesizes** optimal closed-loop PID gains ($K_p, K_i, K_d$) on-the-fly via trained deep learning models.
3. **Monitors** physical plant health and detects electrical, thermal, and mechanical anomalies in real time.
4. **Visualizes** live physical kinematics and control-plane metrics across time and frequency domains simultaneously in an interactive 3D digital twin.

---

## 2. System Architecture

The ecosystem operates across three interconnected layers: **Firmware (Edge Plant)**, **Backend (Analytical Engine & Telemetry Hub)**, and **Frontend (Digital Twin & Control Station)**.

```
       +-------------------------------------------------------------+
       |                     PHYSICAL RIG / PLANT                    |
       |  JGA12-N20 Motor | TB6612FNG Driver | Magnetic Quad Encoder |
       |  INA219 Power    | MPU6050 IMU      | DS18B20 Temp          |
       +------------------------------+------------------------------+
                                      | Dual I2C, 1-Wire, PWM, QEI
                                      v
       +-------------------------------------------------------------+
       |               EMBEDDED EDGE FIRMWARE (ESP32-S3)             |
       |  • Core 1: 1 kHz Deterministic Control Loop & QEI Sampling  |
       |  • Core 0: Telemetry Packaging, WebSockets, Local Anomaly   |
       |  • Onboard RLS System Identification & NN Inference Engine  |
       |  • Hardware E-Stop & PWM Overcurrent Safety Interlocks      |
       +------------------------------+------------------------------+
                                      | Low-Latency Bi-Directional WS
                                      v
       +-------------------------------------------------------------+
       |                  BACKEND ANALYTICAL ENGINE                  |
       |  • FastAPI High-Throughput WebSocket Server                 |
       |  • Neural Network Gain Tuner (ML-based parameter synthesis) |
       |  • Dynamic Transfer Function Estimator & Bode Computation   |
       |  • Historical Run SQLite Persistence & Audit Trail          |
       +------------------------------+------------------------------+
                                      | JSON Streams / RPC
                                      v
       +-------------------------------------------------------------+
       |            FRONTEND DIGITAL TWIN & DASHBOARD                |
       |  • Interactive Three.js 3D Rigid-Body Dynamic Motor Twin    |
       |  • Live Time-Domain Telemetry (Setpoint, Tach, Error, Effort)|
       |  • Real-Time Frequency Response (Bode & Stability Margins)  |
       |  • Anomaly Matrix, Gain Synthesizer, & Safety Cockpit       |
       +-------------------------------------------------------------+
```

---

## 3. Core Capabilities & Mathematical Principles

### 3.1 Online System Identification
Rather than assuming a rigid linear plant equation, the controller excites the physical plant using step, impulse, or swept-frequency signals. From the input-output response, it computes:
* **First-Order Plus Dead Time (FOPDT) / Second-Order Transfer Functions**:
  $$G(s) = \frac{K}{\tau s + 1} e^{-\theta s} \quad \text{or} \quad G(s) = \frac{K \omega_n^2}{s^2 + 2\zeta\omega_n s + \omega_n^2}$$
* **Continuous Parameter Extraction**: Static gain ($K$), damping ratio ($\zeta$), natural frequency ($\omega_n$), rise time ($t_r$), peak overshoot ($M_p$), and settling time ($t_s$).

### 3.2 AI-Based Adaptive Gain Synthesis
Instead of trial-and-error manual tuning, a dedicated neural network trained across thousands of parameter permutations directly maps the identified plant characteristics ($\zeta, \omega_n, \tau, \theta$, target overshoot, maximum rise time) to optimal controller parameters:
$$(K_p, K_i, K_d) = \mathcal{N}_\theta(\text{Plant Features}, \text{Design Targets})$$
The predicted gains maximize phase margin and tracking agility while eliminating steady-state error and preventing actuator saturation.

### 3.3 Frequency-Domain & Stability Analytics
Using the identified system transfer function, the system dynamically plots:
* **Bode Diagrams**: Magnitude ($\text{dB}$) and Phase ($\deg$) versus frequency ($\text{rad/s}$).
* **Stability Margins**: Gain Margin ($G_m$) and Phase Margin ($\Phi_m$) calculated at gain and phase crossover frequencies.
* **Pole-Zero Constellations**: Pole migration tracking on the complex $s$-plane to ensure strict Left-Half Plane (LHP) boundedness.

### 3.4 Multi-Modal Anomaly Detection
The platform continuously gathers multi-spectral physical telemetry:
* **Electrical**: Current drawn, bus voltage, and power dissipation via INA219.
* **Vibrational / Kinematic**: 3-axis acceleration and angular rate via MPU6050 to detect bearing eccentricities, misalignment, or mechanical chatter.
* **Thermal**: Junction and ambient temperature tracking via DS18B20 to guard against motor coil insulation breakdown.
* **Stall / Load Shocks**: Instantaneous detection of counter-electromotive force drops under rotor lock.

---

## 4. Hardware Implementation

| Subsystem | Hardware Component | Role & Functionality |
| :--- | :--- | :--- |
| **Compute Core** | **ESP32-S3 WROOM-1** (Xtensa LX7, 240 MHz) | Dual-core real-time control, hardware interrupts for quadrature encoders, edge inference, and telemetry server. |
| **Actuator** | **JGA12-N20 Metal Gearmotor** (12V, 300 RPM) | Low-inertia DC motor with integrated gear train and magnetic Hall quadrature encoder. |
| **Motor Drive** | **TB6612FNG Dual H-Bridge** | High-efficiency MOSFET H-bridge supporting up to 1.2A continuous / 3.2A peak with 20 kHz PWM. |
| **Power Telemetry** | **INA219 High-Side Power Monitor** | $12\text{-bit}$ current and voltage sensing over I2C to evaluate motor power draw and mechanical loading. |
| **Inertial Sensing**| **MPU6050 6-DOF IMU** | Tri-axial accelerometer and gyroscope capturing rotational vibration signatures and structural oscillations. |
| **Thermal Sensing** | **DS18B20 1-Wire Digital Thermometer** | Contact thermal sensor monitoring motor casing temperature to trigger thermal throttling. |
| **Proximity** | **HC-SR04 Ultrasonic Sensor** | Non-contact distance measurement for multi-plant configurations (e.g., liquid level or magnetic levitation rigs). |
| **Local Display** | **0.96" SSD1306 I2C OLED** | Real-time on-device status screen showing IP, active gains, RPM, and emergency trip messages. |
| **Power Conditioning** | **LM2596 DC-DC Buck Regulator** | High-efficiency step-down converter delivering stable 5.0V logic power from an external 12V industrial supply. |

---

## 5. Software Architecture

### 5.1 Embedded Firmware (`firmware/`)
* **Framework**: PlatformIO / Arduino-ESP32 with FreeRTOS.
* **Task Allocation**:
  * **Core 1 (High Priority)**: $1\text{ kHz}$ hardware-timer-triggered PID control loop, optical/magnetic encoder pulse decoding, PWM output.
  * **Core 0 (Background)**: Sensor acquisition (I2C/1-Wire), serial/WebSocket telemetry streaming, safety watchdog checks.
* **Deterministic Safety**: Hardware Emergency Stop (E-Stop) interlock that instantly pulls the motor driver `STBY` and `PWM` pins LOW upon fault detection.

### 5.2 Backend Service (`backend/`)
* **Engine**: FastAPI (Python 3.10+) with Uvicorn async event loop.
* **Telemetry Streaming**: Bi-directional asynchronous WebSockets streaming live state vectors at 20-50 Hz.
* **Machine Learning Runtime**: Fast inference pipeline for gain prediction, frequency response calculation, and time-domain metric extraction.
* **Data Persistence**: SQLite-backed experiment run database storing time-series histories for offline validation and replay.

### 5.3 Web Dashboard & 3D Digital Twin (`frontend/`)
* **Framework**: React 18, TypeScript, Vite.
* **3D Visualization**: **Three.js** canvas rendering an animated mechatronic twin whose rotor angle and angular velocity reflect the physical rig with sub-20ms latency.
* **Cyberpunk Industrial UI**:
  * Dual-viewport split layout: Real-time telemetry oscilloscopes in the upper tier; parameter synthesis, Bode analytics, and system identification in the lower tier.
  * Active emergency stop switch, manual disturbance injection, and direct gain override controls.

---

## 6. Engineering Significance & Applications

1. **Precision Motion Control & Robotics**:
   Provides an adaptive paradigm for robotic manipulators and robotic joint actuators where varying payloads dynamically shift the plant's inertia and center of mass.
2. **CNC & Additive Manufacturing Drive Systems**:
   Demonstrates real-time compensation for friction hysteresis, lead-screw backlash, and thermal expansion during extended machining cycles.
3. **Industry 4.0 Predictive Maintenance**:
   Combines operational control telemetry with vibration and thermal monitoring to flag motor bearing wear, loose couplings, and mechanical resistance long before failure occurs.
4. **Educational & Control Systems Research**:
   Serves as an open, accessible testbed illustrating the full syllabus of control engineering—from transfer functions and state-space models to frequency-domain stability and AI-driven optimal control.
