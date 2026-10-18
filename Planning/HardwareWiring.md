# EdgeAI ControlLab — Step-by-Step Hardware Wiring Guide

> **Your exact components and their exact pin labels, wired one connection at a time.**

---

## Components Inventory

| # | Component | Pins (as listed on your hardware) |
|---|-----------|-------------------------------|
| 1 | **ESP32-S3 WROOM-1** | IO4, IO5, IO6, IO7, IO10, IO11, IO12, IO15, IO16, IO17, IO18, 3V3, 5V, GND |
| 2 | **JGA12-N20 DC Motor** (12V 300RPM w/ encoder) | M1, GND, C1, C2, VCC, M2 |
| 3 | **TB6612FNG Motor Driver** | PWMA, AIN2, AIN1, STBY, BIN1, BIN2, PWMB, GND, GND(pad), BO1, BO2, AO1, AO2, GND, VCC, VM |
| 4 | **INA219 Current Sensor** | VCC, GND, SCL, SDA, VIN−, VIN+ |
| 5 | **MPU6050 IMU** | VCC, GND, SCL, SDA, XDA, XCL, ADO, INT |
| 6 | **DS18B20 Temp Sensor** | Left=GND, Middle=DATA, Right=VCC *(flat side facing you)* |
| 7 | **HC-SR04 Ultrasonic** | VCC, TRIG, ECHO, GND |
| 8 | **OLED Display (SSD1306)** | GND, VDD, SCK, SDA |
| 9 | **LM2596 Buck Converter** | IN+, IN−, OUT+, OUT− |

---

## Before You Start — Safety Checklist

> [!CAUTION]
> 1. **Tune the LM2596 first!** Connect only the 12V adapter to IN+/IN−. Turn the potentiometer screw until a multimeter reads **exactly 5.0V** on OUT+/OUT−. Only then proceed.
> 2. **Never connect 12V directly to the ESP32.** Only the buck converter's 5V output goes to the ESP32.
> 3. **Common ground is mandatory.** Every GND must connect to the same ground bus on the breadboard.
> 4. **Do NOT use GPIO 0, 19, 20, 45, or 46** — these are boot-strapping and USB pins on the ESP32-S3.

---

## STEP 1 — Set Up the Breadboard Power Rails

You need **two power buses** on your breadboard:
- **5V bus** (red rail) — from the LM2596 output
- **GND bus** (blue rail) — common ground for everything

Also create a **3.3V sub-rail** using the ESP32's onboard 3.3V regulator output.

---

## STEP 2 — Wire the LM2596 Buck Converter (Power Supply)

| Step | From | From Pin | To | To Pin | Wire Color |
|------|------|----------|----|--------|------------|
| 2.1 | **12V DC Adapter** | Positive (+) | **LM2596** | **IN+** | Red |
| 2.2 | **12V DC Adapter** | Negative (−) | **LM2596** | **IN−** | Black |
| 2.3 | **LM2596** | **OUT+** | **Breadboard** | **5V Bus (red rail)** | Red |
| 2.4 | **LM2596** | **OUT−** | **Breadboard** | **GND Bus (blue rail)** | Black |

> [!IMPORTANT]
> Verify with a multimeter: OUT+ to OUT− should read **5.0V ± 0.1V** before proceeding.

---

## STEP 3 — Power the ESP32-S3

| Step | From | From Pin | To | To Pin | Wire Color |
|------|------|----------|----|--------|------------|
| 3.1 | **Breadboard** | **5V Bus** | **ESP32-S3** | **5V** (or VIN) | Red |
| 3.2 | **ESP32-S3** | **GND** | **Breadboard** | **GND Bus** | Black |
| 3.3 | **ESP32-S3** | **3V3** | **Breadboard** | **3.3V sub-rail** (separate row) | Orange |

> After this step, plug in the 12V adapter. The ESP32 power LED should turn on. If it doesn't, disconnect immediately and check polarity.

---

## STEP 4 — Wire the TB6612FNG Motor Driver

### 4A — Power pins of TB6612FNG

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 4.1 | **12V DC Adapter** | Positive (+) | **TB6612FNG** | **VM** | Motor supply voltage (12V) |
| 4.2 | **Breadboard** | **3.3V sub-rail** | **TB6612FNG** | **VCC** | Logic supply (3.3V) |
| 4.3 | **TB6612FNG** | **GND** (any of the GND pins) | **Breadboard** | **GND Bus** | Common ground |
| 4.4 | **TB6612FNG** | **second GND** (pad GND) | **Breadboard** | **GND Bus** | Redundant ground (recommended) |

### 4B — Control pins (ESP32 → TB6612FNG)

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 4.5 | **ESP32-S3** | **IO15** | **TB6612FNG** | **PWMA** | PWM speed control (20 kHz) |
| 4.6 | **ESP32-S3** | **IO16** | **TB6612FNG** | **AIN1** | Motor direction control 1 |
| 4.7 | **ESP32-S3** | **IO17** | **TB6612FNG** | **AIN2** | Motor direction control 2 |
| 4.8 | **ESP32-S3** | **IO18** | **TB6612FNG** | **STBY** | Standby (HIGH = active) |

> [!TIP]
> If you want the driver always active, you can alternatively tie **STBY** directly to **3.3V** instead of IO18.

### 4C — Motor output pins (TB6612FNG → Motor)

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 4.9 | **TB6612FNG** | **AO1** | *→ routed through INA219 (see Step 6)* | — | Motor terminal 1 (via current sensor) |
| 4.10 | **TB6612FNG** | **AO2** | **JGA12-N20 Motor** | **M2** | Motor terminal 2 (direct) |

> The BIN1, BIN2, PWMB, BO1, BO2 pins are for **Channel B** (a second motor). Leave them **unconnected**.

---

## STEP 5 — Wire the JGA12-N20 Motor Encoder

The JGA12-N20 has a built-in quadrature encoder. The encoder pins are separate from the motor drive pins:

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 5.1 | **JGA12-N20** | **VCC** | **Breadboard** | **3.3V sub-rail** | Encoder power (3.3V) |
| 5.2 | **JGA12-N20** | **GND** | **Breadboard** | **GND Bus** | Encoder ground |
| 5.3 | **JGA12-N20** | **C1** | **ESP32-S3** | **IO6** | Encoder Phase A (interrupt) |
| 5.4 | **JGA12-N20** | **C2** | **ESP32-S3** | **IO7** | Encoder Phase B (interrupt) |

> [!NOTE]
> **M1** and **M2** are motor power leads (M2 connected to TB6612 AO2 in Step 4, M1 connected via INA219 in Step 6).
> **C1** and **C2** are encoder signal outputs. **VCC** and **GND** power the encoder's Hall-effect sensors.

---

## STEP 6 — Wire the INA219 Current Sensor (In-Series with Motor)

The INA219 measures motor current by being placed **in series** on the motor's positive lead.

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 6.1 | **INA219** | **VCC** | **Breadboard** | **3.3V sub-rail** | Sensor logic power |
| 6.2 | **INA219** | **GND** | **Breadboard** | **GND Bus** | Sensor ground |
| 6.3 | **INA219** | **SCL** | **ESP32-S3** | **IO5** | I2C Clock (shared bus) |
| 6.4 | **INA219** | **SDA** | **ESP32-S3** | **IO4** | I2C Data (shared bus) |
| 6.5 | **TB6612FNG** | **AO1** | **INA219** | **VIN+** | Current flows in from driver |
| 6.6 | **INA219** | **VIN−** | **JGA12-N20** | **M1** | Current flows out to motor |

> [!IMPORTANT]
> **This completes the motor power circuit:**
> ```
> TB6612 AO1 ──→ INA219 VIN+ ──→ INA219 VIN− ──→ Motor M1
> TB6612 AO2 ──→ Motor M2 (direct)
> ```
> The INA219 sits in series on one leg, measuring every milliamp flowing through the motor.

---

## STEP 7 — Wire the MPU6050 IMU (Vibration Sensor)

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 7.1 | **MPU6050** | **VCC** | **Breadboard** | **3.3V sub-rail** | Sensor power |
| 7.2 | **MPU6050** | **GND** | **Breadboard** | **GND Bus** | Sensor ground |
| 7.3 | **MPU6050** | **SCL** | **ESP32-S3** | **IO5** | I2C Clock (shared bus) |
| 7.4 | **MPU6050** | **SDA** | **ESP32-S3** | **IO4** | I2C Data (shared bus) |

> Leave **XDA**, **XCL**, **ADO**, and **INT** **unconnected** for now.
> - **ADO** left floating = address `0x68` (default).
> - **INT** can optionally connect to an ESP32 GPIO for data-ready interrupts later.

---

## STEP 8 — Wire the OLED Display (SSD1306)

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 8.1 | **OLED** | **GND** | **Breadboard** | **GND Bus** | Display ground |
| 8.2 | **OLED** | **VDD** | **Breadboard** | **3.3V sub-rail** | Display power |
| 8.3 | **OLED** | **SCK** | **ESP32-S3** | **IO5** | I2C Clock (shared bus) |
| 8.4 | **OLED** | **SDA** | **ESP32-S3** | **IO4** | I2C Data (shared bus) |

> [!NOTE]
> **Three I2C devices now share the same two wires (IO4 and IO5):**
> | Device | I2C Address |
> |--------|-------------|
> | OLED SSD1306 | `0x3C` |
> | INA219 | `0x40` |
> | MPU6050 | `0x68` |
>
> This works because each device has a unique address. The ESP32 communicates with them individually via software.

---

## STEP 9 — Wire the DS18B20 Temperature Sensor

The DS18B20 uses the **1-Wire protocol**. Looking at the **flat side** of the TO-92 package facing you:

```
  Flat side facing you:
  ┌─────────┐
  │ DS18B20 │
  └─┬──┬──┬─┘
    │  │  │
   GND DQ VCC
  (Left)(Mid)(Right)
```

You need a **4.7kΩ pull-up resistor** between DATA (DQ) and VCC.

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 9.1 | **DS18B20** | **Left pin (GND)** | **Breadboard** | **GND Bus** | Sensor ground |
| 9.2 | **DS18B20** | **Right pin (VCC)** | **Breadboard** | **3.3V sub-rail** | Sensor power |
| 9.3 | **DS18B20** | **Middle pin (DQ/DATA)** | **ESP32-S3** | **IO10** | 1-Wire data signal |
| 9.4 | **4.7kΩ Resistor** | Leg 1 | **DS18B20 Middle pin (DQ)** row | — | Pull-up resistor |
| 9.5 | **4.7kΩ Resistor** | Leg 2 | **Breadboard** | **3.3V sub-rail** | Pulls data line HIGH when idle |

```
  3.3V ────────┬────────────────
               │
             [4.7kΩ]
               │
  IO10 ────────┼──── DS18B20 Middle Pin (DQ)
               │
  GND ─────────┴──── DS18B20 Left Pin (GND)
```

---

## STEP 10 — Wire the HC-SR04 Ultrasonic Sensor

> [!WARNING]
> The HC-SR04 ECHO pin outputs a **5V** pulse. The ESP32-S3 GPIOs are **3.3V tolerant only**. You **MUST** use a voltage divider to step the echo signal down.

### 10A — Power and Trigger (direct connections)

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 10.1 | **HC-SR04** | **VCC** | **Breadboard** | **5V Bus** | Sensor needs 5V power |
| 10.2 | **HC-SR04** | **GND** | **Breadboard** | **GND Bus** | Sensor ground |
| 10.3 | **HC-SR04** | **TRIG** | **ESP32-S3** | **IO11** | Trigger pulse output (3.3V is fine) |

### 10B — Echo pin with voltage divider

Build this circuit on the breadboard:

```
HC-SR04 ECHO ──── [1kΩ] ────┬──── ESP32 IO12
                             │
                           [2kΩ]
                             │
                            GND
```

| Step | From | From Pin | To | To Pin | Purpose |
|------|------|----------|----|--------|---------|
| 10.4 | **HC-SR04** | **ECHO** | **1kΩ Resistor** | Leg 1 | Echo 5V signal input |
| 10.5 | **1kΩ Resistor** | Leg 2 | **Junction point** on breadboard | — | Divider midpoint |
| 10.6 | **Junction point** | — | **ESP32-S3** | **IO12** | Divided signal (~3.3V) to ESP32 |
| 10.7 | **2kΩ Resistor** | Leg 1 | **Junction point** (same row) | — | Lower leg of divider |
| 10.8 | **2kΩ Resistor** | Leg 2 | **Breadboard** | **GND Bus** | Completes divider to ground |

> **Math check:** $V_{out} = 5V \times \frac{2k\Omega}{1k\Omega + 2k\Omega} = 5V \times \frac{2}{3} = 3.33V$ ✓

---

## Complete Wiring Summary Table

| ESP32-S3 Pin | Function | Connected To | Protocol |
|:---|:---|:---|:---|
| **IO4** | I2C SDA | OLED SDA, INA219 SDA, MPU6050 SDA | I2C |
| **IO5** | I2C SCL | OLED SCK, INA219 SCL, MPU6050 SCL | I2C |
| **IO6** | Encoder Phase A | JGA12-N20 **C1** | Interrupt |
| **IO7** | Encoder Phase B | JGA12-N20 **C2** | Interrupt |
| **IO10** | 1-Wire Data | DS18B20 **Middle pin (DQ)** | 1-Wire |
| **IO11** | Ultrasonic Trigger | HC-SR04 **TRIG** | Digital Out |
| **IO12** | Ultrasonic Echo | HC-SR04 **ECHO** (through divider) | Digital In |
| **IO15** | Motor PWM | TB6612FNG **PWMA** | PWM |
| **IO16** | Motor Dir 1 | TB6612FNG **AIN1** | Digital Out |
| **IO17** | Motor Dir 2 | TB6612FNG **AIN2** | Digital Out |
| **IO18** | Driver Standby | TB6612FNG **STBY** | Digital Out |
| **5V** | Power Input | LM2596 **OUT+** | Power |
| **3V3** | 3.3V Output | 3.3V sub-rail on breadboard | Power |
| **GND** | Ground | Common GND bus | Power |

---

## Full Power Flow Diagram

```
12V DC Adapter (+) ──┬──────────────────── TB6612FNG VM (motor power)
                     │
                     └──── LM2596 IN+
                              │
12V DC Adapter (−) ──┬──── LM2596 IN−
                     │
                     └──── Common GND Bus ←── All GND pins tied here

LM2596 OUT+ (5V) ───┬──── ESP32-S3 5V pin
                     │
                     └──── HC-SR04 VCC (needs 5V)

LM2596 OUT− ───────────── Common GND Bus

ESP32-S3 3V3 ────────┬──── TB6612FNG VCC (logic)
                      ├──── INA219 VCC
                      ├──── MPU6050 VCC
                      ├──── OLED VDD
                      ├──── DS18B20 Right pin (VCC)
                      └──── JGA12-N20 VCC (encoder power)
```

---

## Post-Wiring Verification Checklist

After completing all connections, verify each subsystem one at a time:

- [ ] **Power Test:** Plug in 12V. Measure 5V on breadboard rail. ESP32 LED turns on.
- [ ] **I2C Bus Scan:** Upload a basic I2C scanner sketch. Expect addresses `0x3C`, `0x40`, `0x68`.
- [ ] **Motor Spin Test:** Write a sketch to set IO16=HIGH, IO17=LOW, IO18=HIGH, then analogWrite IO15 at 30% duty. Motor should spin.
- [ ] **Encoder Test:** Rotate motor shaft by hand. Print C1/C2 pulses on Serial Monitor.
- [ ] **Temperature Test:** Read DS18B20 on IO10. Expect ~25°C room temperature.
- [ ] **Ultrasonic Test:** Place hand 10cm from HC-SR04. Read distance on Serial Monitor.
- [ ] **OLED Test:** Display "EdgeAI ControlLab" text on screen.
- [ ] **Current Test:** Read INA219 current while motor is spinning. Expect 0.1–0.5A at no load.
