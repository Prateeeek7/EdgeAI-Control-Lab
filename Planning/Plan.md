# **EdgeAI ControlLab: AI-Native Universal Adaptive Control Platform**

### *An Intelligent Self-Tuning Universal Control System with Digital Twin and AI-Based System Identification*

This project is designed as a **next-generation control engineering platform** rather than a conventional PID controller. The goal is to build a hardware-software ecosystem capable of identifying an unknown physical system, modeling its dynamics, automatically tuning an optimal controller using Artificial Intelligence, and visualizing the complete control process through a web-based digital twin. It directly covers nearly every major concept in your Control Systems syllabus, including mathematical modeling, transfer functions, time and frequency response, controller design, stability analysis, and state-space representation. 

---

# 1. Project Working

The system begins by connecting a physical plant such as a DC motor, servo motor, BLDC motor, thermal chamber, or water tank to an ESP32-S3 controller. Initially, the controller does not know the mathematical model of the system. Instead of manually deriving equations, the ESP32 injects predefined excitation signals such as step, impulse, sine sweep, or chirp signals and records the resulting output through sensors. Using this input-output data, the software estimates the plant's transfer function and extracts important dynamic characteristics like rise time, settling time, overshoot, damping ratio, natural frequency, delay, and steady-state error.

These extracted parameters are transmitted to an AI model that predicts the most suitable controller parameters (PID gains or future advanced controllers). Unlike traditional methods such as Ziegler-Nichols, the AI has learned from thousands of simulated systems and predicts controller gains that achieve faster settling, lower overshoot, and improved stability. The predicted controller is deployed back to the ESP32, which continuously monitors system performance. If environmental conditions change—for example, motor load increases or friction changes—the controller detects degradation in performance, re-identifies the plant dynamics, and automatically retunes itself. This creates a self-learning adaptive control system that continuously optimizes its behavior while maintaining stability.

---

# 2. Electronics Hardware

The hardware platform is intentionally modular so that multiple plants can be connected without redesigning the controller.

### Core Controller

* ESP32-S3 Development Board
* USB Programming Interface
* OLED Display (optional)

### Motor Control Platform

* DC Motor with Quadrature Encoder
* L298N or TB6612 Motor Driver
* INA219 Current Sensor
* Hall Effect Encoder
* Rotary Encoder (optional)

### Additional Sensors

* Temperature Sensor (DS18B20)
* MPU6050 IMU
* Voltage Sensor
* ACS712 Current Sensor
* Ultrasonic Sensor (for tank systems)
* Pressure Sensor (optional)

### Communication

* Wi-Fi
* Bluetooth
* MQTT (optional)
* WebSocket

### Power

* 12V Supply
* Buck Converter (12V→5V)
* Battery (optional)

The same controller can later be connected to different physical systems, making the project reusable for multiple experiments.

---

# 3. Control System Parameters

Instead of simply controlling motor speed, the project continuously estimates and analyzes almost every important control parameter.

### Time Domain

* Rise Time
* Peak Time
* Settling Time
* Overshoot
* Steady-State Error
* Delay Time
* Tracking Error

### System Characteristics

* Transfer Function
* Poles
* Zeros
* System Order
* System Type
* Gain
* Damping Ratio
* Natural Frequency

### Stability

* Routh-Hurwitz Stability
* Root Locus
* Pole Movement
* Stability Margin

### Frequency Domain

* Bode Plot
* Nyquist Plot
* Polar Plot
* Gain Margin
* Phase Margin
* Resonant Peak
* Bandwidth

### State Space

* State Variables
* State Matrix
* Eigenvalues
* Eigenvectors
* Controllability
* Observability
* State Transition Matrix

Every one of these concepts maps directly to the topics in your syllabus. 

---

# 4. AI/ML Module

Artificial Intelligence is not merely used as an add-on but forms the decision-making layer of the controller.

The first AI model performs **system identification** by learning the relationship between measured responses and the underlying plant dynamics. From a short experiment, it estimates parameters that would traditionally require manual modeling.

The second model predicts optimal controller gains. Inputs include overshoot, rise time, settling time, steady-state error, damping ratio, and estimated transfer-function parameters. Outputs are optimized values of Kp, Ki, and Kd. Models such as Random Forest, XGBoost, or lightweight neural networks are suitable because they are fast and can eventually be compressed for edge deployment.

A third module performs **fault diagnosis** by monitoring deviations in vibration, current consumption, and control error. It can classify issues such as overload, increased friction, sensor faults, or motor degradation before they significantly affect performance.

Finally, an adaptive learning module monitors long-term operation. If repeated control performance deteriorates because of changing plant conditions, it triggers a new identification cycle and updates the controller parameters automatically, creating a closed-loop self-learning system.

---

# 5. Web Platform

The web application serves as the project's digital twin and remote laboratory.

The dashboard streams live telemetry from the ESP32 and visualizes both the physical system and the estimated mathematical model. Users can start experiments, apply reference inputs, compare controllers, and monitor system stability in real time. Every experiment is automatically stored in a database, enabling historical comparison and report generation.

The dashboard includes live plots of step response, control effort, error, motor speed, and sensor values. It dynamically generates Bode plots, Nyquist plots, Root Locus diagrams, Pole-Zero maps, and state-space visualizations using the identified system model. A comparison interface allows users to evaluate classical tuning methods against AI-generated controllers, showing metrics such as overshoot, settling time, energy consumption, and tracking accuracy.

The AI assistant on the dashboard explains the behavior of the system in engineering terms. For example, it can indicate that excessive overshoot is caused by low damping or recommend increasing phase margin to improve robustness. Reports summarizing controller performance, system identification results, and experiment history can be exported automatically.

---

# 6. Software Stack

| Layer              | Technology                       |
| ------------------ | -------------------------------- |
| Embedded Firmware  | ESP-IDF / Arduino Framework      |
| AI Model Training  | Python, Scikit-learn, TensorFlow |
| Backend API        | FastAPI                          |
| Frontend           | React + TypeScript               |
| Database           | PostgreSQL or MongoDB            |
| Live Communication | WebSocket / MQTT                 |
| Visualization      | Plotly.js, Three.js              |
| Deployment         | Docker + Nginx                   |

---

# 7. Project Workflow

```text
Physical System
        │
        ▼
ESP32 acquires sensor data
        │
        ▼
System Identification
        │
        ▼
Transfer Function Estimation
        │
        ▼
AI predicts Controller Parameters
        │
        ▼
Controller deployed
        │
        ▼
Closed-loop Control
        │
        ▼
Performance Monitoring
        │
        ▼
Automatic Retuning if Needed
        │
        ▼
Real-time Digital Twin Dashboard
```

---

# 8. Expected Outcomes

By the end of the project, the platform will be able to:

* Automatically identify the dynamics of an unknown plant.
* Estimate its transfer function and state-space model.
* Generate optimized controller gains using AI instead of manual tuning.
* Perform stability analysis using classical control techniques.
* Continuously monitor system health and retune the controller when operating conditions change.
* Provide a web-based digital twin with live visualization, analytics, controller comparison, and automated experiment reports.

This project goes beyond a typical "PID-controlled motor." It becomes a **general-purpose intelligent control platform** that combines embedded electronics, classical control theory, AI/ML, and full-stack software engineering. That breadth makes it suitable not only as a final-year project but also as a foundation for future research, especially if you extend it to support multiple plants and compare AI-based tuning with established methods such as Ziegler–Nichols or Cohen–Coon.
