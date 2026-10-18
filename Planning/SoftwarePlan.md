Below is a software design prompt that you can directly give to Cursor, Claude Code, Lovable, Bolt, v0, or any AI coding agent. It is written as a **software requirements specification**, not a UI prompt. The goal is to create something that looks like **Siemens TIA Portal, NI LabVIEW, MATLAB App Designer, Keysight ADS, or ETAP**, not a modern AI SaaS product.

---

# Software Development Prompt

## Project Name

**EdgeAI ControlLab**

### AI-Native Universal Adaptive Control Platform with Digital Twin

---

## Objective

Develop a **professional industrial engineering software platform** for designing, monitoring, analyzing, and controlling dynamic physical systems.

The software must integrate real-time embedded hardware (ESP32/STM32), classical control engineering, AI-assisted adaptive controller tuning, system identification, digital twin visualization, historical experiment management, and advanced engineering analytics.

The software should resemble an **industrial engineering workstation**, **NOT an AI product**.

---

# Design Language

The interface must feel like:

* MATLAB App Designer
* Simulink Desktop
* Siemens TIA Portal
* National Instruments LabVIEW
* ETAP
* ANSYS Electronics Desktop
* Keysight ADS
* LTSpice
* Oscilloscope Software
* SCADA Monitoring Software

NOT

* ChatGPT
* Claude
* Perplexity
* Lovable
* Vercel Dashboard
* Blue gradients
* Glassmorphism
* Floating cards
* Rounded blobs

---

# UI Principles

Professional.

Dense.

Engineering focused.

Minimal animations.

High information density.

Multi-panel layout.

Industrial monitoring aesthetics.

---

# Color Palette

Primary Background

```
#F5F6F7
```

Secondary Panels

```
#FFFFFF
```

Navigation

```
#2B2F36
```

Accent

```
#0B5FA5
```

Success

```
#2E7D32
```

Warning

```
#F9A825
```

Danger

```
#C62828
```

Grid

```
#D9D9D9
```

Text

```
#1F1F1F
```

---

No gradients.

No neon.

No glass.

No transparency.

No blur.

No oversized shadows.

---

# Overall Layout

```
-----------------------------------------------------------
Top Toolbar
-----------------------------------------------------------

| Left Navigation | Main Workspace              | Inspector |

|                 |                             |           |
|                 |                             |           |
|                 |                             |           |
|                 |                             |           |

-----------------------------------------------------------
Bottom Status Console
-----------------------------------------------------------
```

---

# Left Navigation

Collapsible.

Professional icons.

Sections

```
Dashboard

Experiments

Hardware

Digital Twin

System Identification

Controllers

PID Auto Tuning

Frequency Analysis

State Space

Signal Generator

Data Acquisition

AI Models

Fault Detection

Simulation

Analytics

Reports

Settings
```

Each section opens into professional engineering pages.

---

# Dashboard

Industrial overview.

No cards with huge numbers.

Instead create widgets like SCADA software.

Include

Live Status

Controller Status

Current Plant

Communication Status

Sampling Rate

CPU Usage

Memory

Network

Control Frequency

AI Status

Active Controller

System Type

Transfer Function

Current Gain

Current Error

Controller Mode

Experiment Time

Hardware Connection

Latency

---

# Hardware Page

Display

ESP32

Sensors

GPIO Status

ADC Channels

PWM Outputs

I2C

SPI

UART

BLE

WiFi

Current Consumption

Voltage

Temperature

Firmware Version

Sampling Frequency

Communication Logs

Allow configuration.

---

# Digital Twin

The main engineering page.

Large interactive visualization.

Live animation.

Plant updates continuously.

Overlay

Input

Output

Control Signal

Disturbance

Error

State Variables

Velocity

Acceleration

Power

Current

Torque

Temperature

All updated live.

---

# System Identification

This page should feel like MATLAB System Identification Toolbox.

Include

Raw Input

Raw Output

Step Response

Impulse Response

Transfer Function Estimation

Model Order Selection

Goodness of Fit

Estimated Delay

Pole Zero Estimation

Residual Analysis

Prediction Error

Noise Model

Export Model

Import Dataset

---

# Controller Design

Professional tuning workspace.

Tabs

PID

PI

PD

Lead

Lag

Lag Lead

State Feedback

LQR

Observer

Adaptive Controller

Each page should contain

Parameter table

Live tuning sliders

Equation editor

Performance metrics

Controller comparison

Stability indicator

---

# Stability Analysis

Dedicated page.

Generate

Root Locus

Pole Zero Map

Nyquist Plot

Nichols Chart

Bode Magnitude

Bode Phase

Gain Margin

Phase Margin

Bandwidth

Dominant Pole

Damping Ratio

Natural Frequency

Cursor measurements

Zoom

Export figure

---

# Signal Generator

Virtual laboratory.

Generate

Step

Ramp

Impulse

Pulse

Square

Triangle

Sine

Chirp

PRBS

Custom waveform

Noise injection

Amplitude

Offset

Sampling Rate

Frequency

Duty Cycle

Duration

---

# Time Domain Analysis

Professional oscilloscope style.

Display

Input

Output

Reference

Error

Controller Output

Integral

Derivative

Moving Average

Zoom

Pan

Crosshair

Cursor

FFT overlay

Markers

Measurements

---

# Frequency Domain

Generate automatically

FFT

PSD

Spectrogram

Waterfall Plot

Frequency Response

Coherence

Gain

Phase

Bandwidth

Noise Floor

---

# State Space

Display

A Matrix

B Matrix

C Matrix

D Matrix

Eigenvalues

Eigenvectors

State Variables

Observer

Controllability Matrix

Observability Matrix

State Transition Matrix

Simulation

---

# AI Module

Professional engineering interface (TensorBoard/MATLAB-style).

Strictly NO chatbot panel or conversational chat bubbles.

Instead, the UI must have:

* **Training Monitor Panel:** Live loss and accuracy curves (updated during training iterations), learning rate decay graphs.
* **Hyperparameter Grid:** Standard dense spreadsheet-style input table to tune parameters (e.g., number of estimators, depth, learning rate, neural network layer sizes).
* **Feature Engineering & Importance:** Bar chart showing relative Gini-importance of each engineering input feature (e.g., Rise Time, Damping Ratio, Overshoot).
* **Model Selection:** Dropdown selector for active models (e.g., Random Forest, XGBoost, MLP Neural Net) with instant model comparison metrics (MSE, R², Inference time).
* **Regression Analytics:** Multi-plot widget containing Confusion Matrix, Residual Plot, and Prediction Confidence bands overlaying actual step responses.
* **Retrain & Deploy Control Console:** Buttons to import datasets, trigger retrain runs, and push binary weight tables down to ESP32-S3 over local endpoints.

---

# Fault Detection

Industrial maintenance.

Detect

Sensor Failure

Encoder Failure

Motor Stall

High Current

Over Temperature

Oscillation

Instability

Communication Failure

Bearing Wear

Controller Saturation

Generate alarms.

Event timeline.

---

# Experiment Manager

Database of experiments.

Each experiment stores

Plant

Date

Controller

Transfer Function

State Space

Model Version

Performance

Energy

Overshoot

Rise Time

Settling Time

Error

Operator

Hardware

Export PDF

Duplicate Experiment

Compare Runs

---

# Reports

Generate automatically

Engineering Report

Transfer Function

Control Parameters

Plots

Performance

AI Results

Stability Analysis

Hardware Information

Conclusion

PDF Export

LaTeX Export

CSV Export

---

# Backend

FastAPI

Python

Async architecture

REST

WebSocket

Redis

Celery

PostgreSQL

SQLAlchemy

Docker

---

# Frontend

React

TypeScript

Vite

TanStack Router

TanStack Query

Zustand

React Flow

Plotly / ECharts (For static and complex stability plots)

uPlot (For high-speed 100 Hz canvas-based live time-series streaming)

Three.js (For Digital Twin GLTF mechanical animation)

Monaco Editor (For writing custom PID scripts/formulas)

AG Grid / MUI Data Grid (For dense telemetry lists and database records)

*Note: Avoid high-overhead chart wrappers. Telemetry rendering must use WebGL/Canvas to prevent DOM lagging during 100 Hz data acquisition.*

---

# Database

Experiments

Hardware

Users

Controller Parameters

AI Models

Telemetry

Logs

Events

Configurations

Transfer Functions

State Space Models

Datasets

---

# AI Features

* Automatic system identification
* PID gain prediction
* Controller recommendation
* Performance prediction
* Fault classification
* Remaining useful life estimation
* Adaptive controller retuning
* Model drift detection
* Anomaly detection
* Predictive maintenance

---

# Engineering Features

* **High-Speed Telemetry Protocol (100 Hz):** WebSocket packet transmission using binary ArrayBuffers / Float32Array to avoid JSON serialization bottlenecks.
* **ESP32 Ring Buffer Sync:** Onboard RAM ring buffer on ESP32-S3 to queue telemetry points during network dropouts, auto-syncing bulk data with the backend when connection recovers.
* **Digital Oscilloscope & Logic Analyzer Dashboard:** Canvas-based plotting interface supporting dual-cursor time measurements, trigger level setup, and edge triggers.
* **Frequency Domain Toolkit:** On-the-fly FFT (Fast Fourier Transform), Power Spectral Density (PSD), and Spectrogram generators computed on the client side using Web Assembly (Wasm) or fast JS algorithms.
* **Classical Control Analysis Tools:** Dynamic generation of Bode Plots, Root Locus, Nyquist diagrams, and Pole-Zero maps using mathematical models estimated by the backend server.
* **State-Space Sandbox:** Interactive matrix inputs (A, B, C, D) allowing live editing of state feedback and observer design.
* **Hardware-in-the-Loop (HIL) Support:** Mode to route control outputs back to hardware simulator models.
* **Experiment Replay Module:** VCR-like controls (Play, Pause, Scrub) to replay recorded experiments from the database at real-time or variable speed.

---

## What makes this unique

The software should not feel like an IoT dashboard. It should feel like a **professional control engineering IDE**—a desktop-class engineering environment delivered through the browser. The emphasis is on dense technical information, analytical tools, reproducible experiments, and industrial usability. A faculty member or engineer should immediately recognize it as a serious engineering platform rather than a generic monitoring website.
