// EdgeAI ControlLab — ESP32-S3 firmware
//
// Core 1, high priority : 100 Hz control task (encoder -> PID -> PWM, INA219 + MPU6050, fault checks)
// Core 1, loop()        : serial commands in, JSON telemetry out
// Core 0, low priority  : HC-SR04, DS18B20, OLED
//
// Serial protocol (newline-terminated, LAB_SERIAL_BAUD):
//   out: one JSON object per control sample, same fields as backend/main.py MotorSimulation.step()
//        plus "vib" (g RMS), "dist" (cm), "volt" (V). Info lines start with '#'.
//   in : the dashboard's control packet {"kp","ki","kd","targetSpeed","controllerMode",
//        "excitationSignal","isEStop"}, or text commands (type "help").

#include <Arduino.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <ESP32Encoder.h>
#include <Adafruit_INA219.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>
#include <esp_system.h>
#include "config.h"
#include "sysid.h"
#include "anomaly.h"

enum class Mode : uint8_t { PID, Manual, Adaptive, Raw };
enum class Excitation : uint8_t { None, Step, SineSweep, Impulse };
enum class Fault : uint8_t { Idle, Nominal, EStop, Overcurrent, Overheat, Stall };

static const char *faultName(Fault f) {
  switch (f) {
    case Fault::Idle:        return "IDLE";
    case Fault::Nominal:     return "NOMINAL";
    case Fault::EStop:       return "ESTOP";
    case Fault::Overcurrent: return "OVERCURRENT";
    case Fault::Overheat:    return "OVERHEAT";
    case Fault::Stall:       return "STALL";
  }
  return "?";
}

static const char *modeName(Mode m) {
  switch (m) {
    case Mode::PID:      return "PID";
    case Mode::Manual:   return "Manual";
    case Mode::Adaptive: return "Adaptive AI";
    case Mode::Raw:      return "Raw PWM";
  }
  return "?";
}

struct Settings {
  // Tuned on the real JGA12-N20 @12V (K=1.23 RPM/PWM, tau=45 ms): ~0.5 s settle, no overshoot.
  float kp = 0.2f, ki = 4.4f, kd = 0.0f;
  float targetRpm = 150.0f;
  float rawPwm = 0.0f;
  Mode mode = Mode::PID;
  Excitation excitation = Excitation::None;
  bool estop = false;
  bool armed = false;        // motor stays off until the host sends a control packet
  bool clearFaults = false;  // one-shot request handled by the control task
  bool tunerNN = true;       // Adaptive AI gain source: neural tuner (true) or lambda rule (false)
};

struct Sample {
  uint32_t index;
  float ref, rpm, pwm, error, current, temp, vib, dist, volt;
  Fault fault;
  float idK, idTau, aKp, aKi;
  uint32_t idN;
  bool idOk, tempModel, distFixed;
  int idD;
  float nnKp, nnKi;
  bool tunerNN;
  AnomalyState an;
  Mode mode;
  float gKp, gKi, gKd;  // gains actually applied this period
};

static portMUX_TYPE settingsMux = portMUX_INITIALIZER_UNLOCKED;
static Settings settings;
static QueueHandle_t telemetryQueue;
static volatile bool telemetryOn = true;
// Host-link watchdog: the motor only runs while lines keep arriving (the backend sends "ping").
// If USB drops (motor noise can knock it off), the motor stops instead of running unattended.
static volatile uint32_t lastHostMs = 0;
static volatile bool hostTimedOut = false;
static volatile bool oneWireDiagRequested = false;  // "onewire" command, run by the aux task

static ESP32Encoder encoder;
static Adafruit_INA219 ina219(ADDR_INA219);
static Adafruit_SSD1306 oled(128, 64, &Wire, -1, 400000UL, 400000UL);
static OneWire oneWire(PIN_ONEWIRE);
static DallasTemperature ds18b20(&oneWire);

static bool hasIna = false, hasMpu = false;
static volatile bool hasOled = false;  // kept alive by the aux task (re-init on loss / power glitch)
static volatile bool hasTemp = false;  // re-probed by the aux task, so the sensor can be fixed live

// Written by the aux task, read by the control task (aligned 32-bit stores are atomic).
static volatile float motorTempC = -127.0f;  // DS18B20 reading (aux task); only valid while hasTemp
static volatile float distanceCm = -1.0f;    // HC-SR04 reading (aux task); -1 = no echo
// What the OLED/telemetry actually show: the sensor value when present, else the thermal model /
// fixed distance (flagged as such in telemetry: "tsrc":"model", "dsrc":"fixed").
static volatile float shownTempC = THERMAL_AMBIENT_C, shownDistCm = DIST_FALLBACK_CM;
static volatile bool tempIsModel = true, distIsFixed = true;
// Online identification snapshot for the OLED / status (the estimator itself lives in the control task).
static volatile float idK = 0, idTau = 0, idKp = 0, idKi = 0;
static volatile bool idOk = false;
static volatile bool idResetRequested = false;
static volatile bool baselineResetRequested = false;
static volatile int idDelay = 0;
static volatile float idNnKp = 0, idNnKi = 0;
static volatile Anomaly lastAnomaly = Anomaly::Learning;
static volatile float lastAnomalyScore = 0;
// Snapshot for the OLED.
static volatile float lastRpm = 0, lastPwm = 0, lastCurrent = 0, lastRef = 0;
static volatile Fault lastFault = Fault::Idle;
static volatile int64_t lastCount = 0;

// ---------------------------------------------------------------- motor ----
static void motorWrite(float pwm) {
  if (pwm <= 0.0f) {
    ledcWrite(PWM_CHANNEL, 0);
    digitalWrite(PIN_AIN1, LOW);  // coast
    digitalWrite(PIN_AIN2, LOW);
    return;
  }
  digitalWrite(PIN_STBY, HIGH);
  digitalWrite(PIN_AIN1, MOTOR_DIR_INVERT ? LOW : HIGH);   // forward
  digitalWrite(PIN_AIN2, MOTOR_DIR_INVERT ? HIGH : LOW);
  const uint32_t maxDuty = (1u << PWM_RES_BITS) - 1;
  ledcWrite(PWM_CHANNEL, (uint32_t)lroundf(pwm / 255.0f * maxDuty));
}

static void motorDisable() {
  motorWrite(0);
  digitalWrite(PIN_STBY, LOW);
}

// --------------------------------------------------------------- MPU6050 ---
static bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ADDR_MPU);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool mpuInit() {
  return mpuWrite(0x6B, 0x00)    // wake, internal clock
      && mpuWrite(0x1A, 0x03)    // DLPF ~44 Hz
      && mpuWrite(0x1C, 0x08);   // accel +-4 g (8192 LSB/g)
}

// Returns acceleration magnitude in g, or NAN on bus error.
static float mpuReadAccelG() {
  Wire.beginTransmission(ADDR_MPU);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return NAN;
  if (Wire.requestFrom((int)ADDR_MPU, 6) != 6) return NAN;
  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();
  return sqrtf((float)ax * ax + (float)ay * ay + (float)az * az) / 8192.0f;
}

// ---------------------------------------------------------------- HC-SR04 --
static volatile uint32_t echoRiseUs = 0, echoWidthUs = 0;
static volatile bool echoDone = false;

static void IRAM_ATTR onEcho() {
  uint32_t now = micros();
  if (digitalRead(PIN_ECHO)) {
    echoRiseUs = now;
  } else {
    echoWidthUs = now - echoRiseUs;
    echoDone = true;
  }
}

// ---------------------------------------------------------- control task ---
static float referenceFor(Excitation ex, float target, uint32_t t) {
  // Same waveforms as backend/main.py, but t restarts whenever the excitation changes.
  switch (ex) {
    case Excitation::Step:
      return ((t / 100) % 2 == 0) ? 50.0f : target;
    case Excitation::SineSweep: {
      t %= 2000;  // restart the sweep every 20 s instead of letting the frequency run away
      float freq = 0.2f + t / 500.0f;
      return target + sinf(t * 0.05f * freq) * 40.0f;
    }
    case Excitation::Impulse:
      return (t % 200 == 0) ? target + 100.0f : target;
    default:
      return target;
  }
}

static void controlTask(void *) {
  int64_t countHistory[SPEED_WINDOW] = {0};
  int64_t timeHistory[SPEED_WINDOW];
  for (auto &t : timeHistory) t = esp_timer_get_time() - SPEED_WINDOW * CONTROL_PERIOD_MS * 1000;
  int histPos = 0;
  int64_t lastUs = esp_timer_get_time();
  float integral = 0, lastRpmLocal = 0, lastKi = 0;
  float vibMean = 1.0f, vibVar = 0, vib = 0;
  float current = 0, volt = 0;  // read after the PWM update, so they are one sample old
  int overCurrentN = 0, stallN = 0;
  Fault latched = Fault::Nominal;
  Excitation lastEx = Excitation::None;
  uint32_t index = 0, exIndex = 0;
  OnlineId id;
  id.reset();
  AnomalyDetector anomaly;
  anomaly.reset();
  // Applied-PWM history for the delayed model input, and how many consecutive past samples were
  // usable (driving, PWM > 0, no D term feeding noise into the PWM).
  constexpr int UH = OnlineId::U_HISTORY;
  float uHist[UH] = {0};  // uHist[0] = PWM applied last period, uHist[i] = i+1 periods ago
  int drivenRun = 0;      // consecutive periods with the motor driven (PWM > 0, no fault)
  float yPrev = 0;
  int usableRun = 0;
  float thermalC = THERMAL_AMBIENT_C;

  TickType_t wake = xTaskGetTickCount();
  for (;;) {
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(CONTROL_PERIOD_MS));

    Settings s;
    portENTER_CRITICAL(&settingsMux);
    if (settings.armed && millis() - lastHostMs > HOST_TIMEOUT_MS) {
      settings.armed = false;
      hostTimedOut = true;
    }
    s = settings;
    settings.clearFaults = false;
    portEXIT_CRITICAL(&settingsMux);

    // Speed from encoder counts over a short window, divided by the *measured* elapsed time:
    // a cycle delayed by I2C contention (OLED refresh on core 0) no longer shows up as a speed spike.
    int64_t nowUs = esp_timer_get_time();
    int64_t count = encoder.getCount();
    if (ENCODER_INVERT) count = -count;
    int64_t oldest = countHistory[histPos], oldestUs = timeHistory[histPos];
    countHistory[histPos] = count;
    timeHistory[histPos] = nowUs;
    histPos = (histPos + 1) % SPEED_WINDOW;
    float rpm = (float)(count - oldest) / COUNTS_PER_REV / ((nowUs - oldestUs) * 1e-6f) * 60.0f;
    float dt = constrain((nowUs - lastUs) * 1e-6f, 0.002f, 0.05f);
    lastUs = nowUs;
    lastCount = count;

    // Online system identification: learn y[k] = a*y[k-1] + b*u[k-1] + c from live data. Skip samples
    // where the driver was coasting (u = 0): that is a different, unpowered dynamic.
    if (idResetRequested) { idResetRequested = false; id.reset(); anomaly.reset(); }
    if (baselineResetRequested) { baselineResetRequested = false; anomaly.reset(); }
    if (usableRun >= UH) id.update(rpm, yPrev, uHist, dt);
    const IdEstimate &est = id.estimate();

    if (s.excitation != lastEx) { lastEx = s.excitation; exIndex = 0; }
    float ref = (s.mode == Mode::Raw) ? 0.0f : referenceFor(s.excitation, s.targetRpm, exIndex);
    ref = constrain(ref, 0.0f, MAX_TARGET_RPM);
    float error = ref - rpm;

    if (s.clearFaults) { latched = Fault::Nominal; overCurrentN = stallN = 0; }

    // Control law
    float pwm = 0;
    bool cleanForId = true;
    float gKp = 0, gKi = 0, gKd = 0;
    switch (s.mode) {
      case Mode::PID:
      case Mode::Adaptive: {
        float kp = s.kp, ki = s.ki, kd = s.kd;
        // Adaptive AI: self-tuned PI from the on-device model, once the estimate is trustworthy.
        // Adaptive is a PI controller: no D term at all. Derivative on the 10 ms speed estimate feeds
        // measurement noise straight into the PWM, which also biases the closed-loop identification
        // (it drove K negative with the dashboard's default Kd=0.05).
        if (s.mode == Mode::Adaptive) {
          kd = 0;
          if (est.confident) {
            kp = s.tunerNN ? est.nnKp : est.kp;
            ki = s.tunerNN ? est.nnKi : est.ki;
          }
        }
        // Bumpless transfer: when Ki changes (self-tuning, or new gains from the dashboard), rescale
        // the integral so Ki*integral, i.e. the PWM it contributes, stays continuous.
        if (lastKi > 1e-6f && ki > 1e-6f && ki != lastKi) integral *= lastKi / ki;
        lastKi = ki;
        float dRpm = (rpm - lastRpmLocal) / dt;  // derivative on measurement: no kick on setpoint steps
        float unsat = kp * error + ki * (integral + error * dt) - kd * dRpm;
        // Conditional integration: stop winding up while the output is saturated in that direction.
        if (!((unsat > 255.0f && error > 0) || (unsat < 0.0f && error < 0)))
          integral = constrain(integral + error * dt, -INTEGRAL_LIMIT, INTEGRAL_LIMIT);
        pwm = kp * error + ki * integral - kd * dRpm;
        cleanForId = kd <= 0.0f;
        gKp = kp; gKi = ki; gKd = kd;
        break;
      }
      case Mode::Manual: pwm = s.targetRpm * 0.6f; break;
      case Mode::Raw:    pwm = s.rawPwm; break;
    }
    pwm = constrain(pwm, 0.0f, 255.0f);
    lastRpmLocal = rpm;

    // Faults (latched ones need E-stop toggle or "reset"). Only judge stall/current while driving.
    bool driving = s.armed && !s.estop;
    if (!driving) { overCurrentN = stallN = 0; }
    if (latched == Fault::Nominal && driving) {
      if (current >= CURRENT_TRIP_A) latched = Fault::Overcurrent;
      overCurrentN = (current > CURRENT_SUSTAIN_A) ? overCurrentN + 1 : 0;
      if (overCurrentN >= CURRENT_SUSTAIN_N) latched = Fault::Overcurrent;
      if (shownTempC > OVERHEAT_C) latched = Fault::Overheat;
      stallN = (pwm > STALL_PWM && rpm < STALL_RPM) ? stallN + 1 : 0;
      if (stallN >= STALL_SAMPLES) latched = Fault::Stall;
    }

    Fault fault;
    if (s.estop)                       fault = Fault::EStop;
    else if (latched != Fault::Nominal) fault = latched;
    else if (!s.armed)                 fault = Fault::Idle;
    else                               fault = Fault::Nominal;

    if (fault == Fault::Nominal) {
      motorWrite(pwm);
    } else {
      motorDisable();
      pwm = 0;
      integral = 0;
    }

    // Slow I2C reads after the motor update (they may wait behind an OLED transfer).
    // Shunt register only: 1 transaction, vs 3 for getCurrent_mA() + getBusVoltage_V().
    if (hasIna) {
      current = fabsf(ina219.getShuntVoltage_mV()) / INA219_SHUNT_OHMS / 1000.0f;  // sign flips with direction
      if (index % 10 == 0) volt = ina219.getBusVoltage_V();
    }
    // A supply glitch can reset the MPU6050 into sleep (frozen readings): re-wake it every second.
    if (index % 100 == 0) hasMpu = mpuInit();
    if (hasMpu) {
      float g = mpuReadAccelG();
      if (!isnan(g)) {
        vibMean += 0.01f * (g - vibMean);
        float d = g - vibMean;
        vibVar += 0.05f * (d * d - vibVar);
      }
      vib = sqrtf(vibVar);
    }

    // Thermal model ("virtual sensor") used while no DS18B20 is fitted: copper loss from the measured
    // current plus a speed-proportional friction/iron loss, first-order towards T_amb + P*R_th.
    // Heats with THERMAL_TAU_HEAT_S, cools more slowly with THERMAL_TAU_COOL_S (still housing).
    {
      float powerW = current * current * THERMAL_R_WINDING + THERMAL_FRICTION_W * fabsf(rpm) / 300.0f;
      float targetC = THERMAL_AMBIENT_C + powerW * THERMAL_R_TH;
      float tauS = (targetC > thermalC) ? THERMAL_TAU_HEAT_S : THERMAL_TAU_COOL_S;
      thermalC += (targetC - thermalC) * dt / tauS;
    }
    bool tempModel = !hasTemp;
    float temp = tempModel ? thermalC : (float)motorTempC;
    bool distFixed = distanceCm <= 0.0f;
    float dist = distFixed ? DIST_FALLBACK_CM : (float)distanceCm;
    shownTempC = temp; tempIsModel = tempModel;
    shownDistCm = dist; distIsFixed = distFixed;

    // Anomaly detection against the learned healthy baseline (advisory; hard limits are above).
    anomaly.update(drivenRun >= UH, est.confident, id.bestTheta(), est.delay, est.K, rpm, uHist,
                   current, vib, temp, OVERHEAT_C, THERMAL_AMBIENT_C, dt);
    const AnomalyState &an = anomaly.state();

    Sample smp{index, ref, rpm, pwm, error, current, temp, vib, dist, volt, fault,
               est.K, est.tau, est.kp, est.ki, est.updates, est.confident, tempModel, distFixed,
               est.delay, est.nnKp, est.nnKi, s.tunerNN, an, s.mode, gKp, gKi, gKd};
    xQueueSend(telemetryQueue, &smp, 0);  // drop if the host link is behind

    lastRpm = rpm; lastPwm = pwm; lastCurrent = current; lastRef = ref; lastFault = fault;
    idK = est.K; idTau = est.tau; idKp = est.kp; idKi = est.ki; idOk = est.confident;
    idDelay = est.delay; idNnKp = est.nnKp; idNnKi = est.nnKi;
    lastAnomaly = an.cls; lastAnomalyScore = an.score;
    yPrev = rpm;
    for (int i = UH - 1; i > 0; i--) uHist[i] = uHist[i - 1];
    uHist[0] = pwm;
    bool usable = fault == Fault::Nominal && cleanForId && pwm > 0.0f;
    usableRun = usable ? usableRun + 1 : 0;
    drivenRun = (fault == Fault::Nominal && pwm > 0.0f) ? drivenRun + 1 : 0;
    index++;
    exIndex++;
  }
}

// -------------------------------------------------------------- aux task ---
static void drawOled() {
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("EdgeAI ControlLab");
  Mode m;
  float kp, ki, kd;
  bool nn;
  portENTER_CRITICAL(&settingsMux);
  m = settings.mode; kp = settings.kp; ki = settings.ki; kd = settings.kd; nn = settings.tunerNN;
  portEXIT_CRITICAL(&settingsMux);
  oled.printf("Mode: %s\n", modeName(m));
  oled.printf("Ref %5.1f RPM %5.1f\n", (float)lastRef, (float)lastRpm);
  oled.printf("PWM %5.1f  I %.3fA\n", (float)lastPwm, (float)lastCurrent);
  oled.printf("T%5.1fC  D%4.1fcm\n", (float)shownTempC, (float)shownDistCm);
  if (m == Mode::Adaptive && idOk)
    oled.printf("%s P%.2f I%.1f\n", nn ? "NN" : "LAM", nn ? (float)idNnKp : (float)idKp, nn ? (float)idNnKi : (float)idKi);
  else
    oled.printf("P%.2f I%.2f D%.3f\n", kp, ki, kd);
  if (idOk) oled.printf("ID K%.2f t%2.0fms d%d\n", (float)idK, (float)idTau * 1000.0f, (int)idDelay);
  else      oled.printf("ID learning...\n");
  oled.setCursor(0, 56);
  oled.printf("[%s] %s", faultName(lastFault), anomalyName(lastAnomaly));
  oled.display();
}

static void auxTask(void *) {
  pinMode(PIN_TRIG, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);
  attachInterrupt(PIN_ECHO, onEcho, CHANGE);  // ISR runs on this core (0)

  uint32_t lastTempReq = 0, lastOled = 0, lastProbe = 0, lastOledCheck = 0;
  if (hasTemp) { ds18b20.requestTemperatures(); lastTempReq = millis(); }

  for (;;) {
    // Ultrasonic ping; wait out the echo before touching 1-Wire (it masks interrupts on this core).
    echoDone = false;
    digitalWrite(PIN_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_TRIG, LOW);
    vTaskDelay(pdMS_TO_TICKS(30));
    distanceCm = (echoDone && echoWidthUs < 25000) ? echoWidthUs / 58.0f : -1.0f;
    vTaskDelay(pdMS_TO_TICKS(30));  // let remaining echoes die out (60 ms ping cycle)

    uint32_t now = millis();
    if (oneWireDiagRequested) {
      oneWireDiagRequested = false;
      pinMode(PIN_ONEWIRE, INPUT);  // no internal pull-up: only the external 4.7k can pull it high
      delay(2);
      int idle = digitalRead(PIN_ONEWIRE);
      uint8_t presence = oneWire.reset();
      uint8_t addr[8];
      oneWire.reset_search();
      bool found = oneWire.search(addr);
      Serial.printf("# 1-Wire IO%d: idle=%s presence=%s rom=%s\n", PIN_ONEWIRE,
                    idle ? "HIGH (pull-up ok)" : "LOW (no pull-up, or DATA shorted to GND)",
                    presence ? "yes" : "NO (nothing answering)",
                    found ? (OneWire::crc8(addr, 7) == addr[7] ? "ok" : "CRC error (noisy line)") : "none");
      if (found) Serial.printf("#   family 0x%02X %s\n", addr[0], addr[0] == 0x28 ? "(DS18B20)" : "(not a DS18B20)");
    }
    if (!hasTemp && now - lastProbe >= 2000) {
      lastProbe = now;
      ds18b20.begin();
      if (ds18b20.getDeviceCount() > 0) {
        ds18b20.setResolution(11);
        ds18b20.setWaitForConversion(false);
        ds18b20.requestTemperatures();
        lastTempReq = now;
        hasTemp = true;
        Serial.println("# DS18B20 detected");
      }
    } else if (hasTemp && now - lastTempReq >= 400) {
      float t = ds18b20.getTempCByIndex(0);
      if (t > -100.0f) motorTempC = t;
      ds18b20.requestTemperatures();
      lastTempReq = now;
    }

    // Keep the OLED always on: every second check it still ACKs and re-init it when it comes back.
    // While present, re-assert the settings a brownout would reset (display on, charge pump,
    // horizontal addressing, orientation) — idempotent, so no flicker.
    if (now - lastOledCheck >= 1000) {
      lastOledCheck = now;
      Wire.beginTransmission(ADDR_OLED);
      bool present = Wire.endTransmission() == 0;
      if (!present) {
        if (hasOled) Serial.println("# OLED lost, retrying");
        hasOled = false;
      } else if (!hasOled) {
        if (oled.begin(SSD1306_SWITCHCAPVCC, ADDR_OLED, false, false)) {
          Serial.println("# OLED on");
          hasOled = true;
          lastOled = 0;  // redraw right away
        }
      } else {
        static const uint8_t keepAlive[] = {
            SSD1306_MEMORYMODE, 0x00, SSD1306_CHARGEPUMP, 0x14,
            SSD1306_SEGREMAP | 0x1, SSD1306_COMSCANDEC, SSD1306_DISPLAYALLON_RESUME,
            SSD1306_NORMALDISPLAY, SSD1306_DISPLAYON};
        for (uint8_t c : keepAlive) oled.ssd1306_command(c);
      }
    }

    if (hasOled && now - lastOled >= 250) {
      lastOled = now;
      drawOled();
    }
  }
}

// --------------------------------------------------------- host commands ---
static Mode parseMode(const char *s, Mode fallback) {
  if (!s) return fallback;
  if (!strcmp(s, "PID")) return Mode::PID;
  if (!strcmp(s, "Manual")) return Mode::Manual;
  if (!strcmp(s, "Adaptive AI")) return Mode::Adaptive;
  return fallback;
}

static Excitation parseExcitation(const char *s, Excitation fallback) {
  if (!s) return fallback;
  if (!strcmp(s, "None")) return Excitation::None;
  if (!strcmp(s, "Step")) return Excitation::Step;
  if (!strcmp(s, "Sine Sweep") || !strcmp(s, "Chirp")) return Excitation::SineSweep;
  if (!strcmp(s, "Impulse")) return Excitation::Impulse;
  return fallback;
}

static void i2cScan() {
  Serial.print("# I2C:");
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf(" 0x%02X", a); found++; }
  }
  Serial.println(found ? "" : " none (check SDA=IO4, SCL=IO5, 3V3, GND)");
}

static const char *resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "POWER-ON (board lost all power, or first plug-in)";
    case ESP_RST_BROWNOUT: return "BROWNOUT (supply sagged below ~2.4V: short/overload/weak USB)";
    case ESP_RST_PANIC:    return "PANIC (firmware crash)";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "WATCHDOG (firmware hang)";
    case ESP_RST_SW:       return "SOFTWARE";
    case ESP_RST_EXT:      return "EXTERNAL (RST pin)";
    default:               return "OTHER";
  }
}

static void printStatus() {
  Settings s;
  portENTER_CRITICAL(&settingsMux);
  s = settings;
  portEXIT_CRITICAL(&settingsMux);
  Serial.printf("# uptime=%lus last reset: %s\n", (unsigned long)(millis() / 1000), resetReason());
  Serial.printf("# sensors: INA219=%s MPU6050=%s OLED=%s DS18B20=%s\n",
                hasIna ? "ok" : "MISSING", hasMpu ? "ok" : "MISSING",
                hasOled ? "ok" : "MISSING", hasTemp ? "ok" : "MISSING");
  Serial.printf("# mode=%s armed=%d estop=%d kp=%.3f ki=%.3f kd=%.3f target=%.1f rawPwm=%.0f\n",
                modeName(s.mode), s.armed, s.estop, s.kp, s.ki, s.kd, s.targetRpm, s.rawPwm);
  Serial.printf("# encoder=%lld rpm=%.1f pwm=%.1f current=%.3fA temp=%.2fC dist=%.1fcm fault=%s\n",
                (long long)lastCount, (float)lastRpm, (float)lastPwm, (float)lastCurrent,
                (float)shownTempC, (float)shownDistCm, faultName(lastFault));
  Serial.printf("# temp source=%s dist source=%s | id: %s K=%.3f RPM/PWM tau=%.1f ms -> auto Kp=%.3f Ki=%.3f\n",
                tempIsModel ? "thermal model" : "DS18B20", distIsFixed ? "fixed 5.5cm" : "HC-SR04",
                idOk ? "ok" : "learning", (float)idK, (float)idTau * 1000.0f, (float)idKp, (float)idKi);
  Serial.printf("# id delay=%d samples | neural tuner Kp=%.3f Ki=%.3f (adaptive uses %s) | anomaly=%s score=%.2f\n",
                (int)idDelay, (float)idNnKp, (float)idNnKi, s.tunerNN ? "NN" : "lambda",
                anomalyName(lastAnomaly), (float)lastAnomalyScore);
  // Machine-readable summary for the backend (/api/hardware).
  Serial.printf("# info {\"fw\":\"%s %s\",\"uptime_s\":%lu,\"reset\":\"%s\",\"sensors\":{\"ina219\":%s,"
                "\"mpu6050\":%s,\"oled\":%s,\"ds18b20\":%s,\"hcsr04\":%s},\"encoder_ppr\":%.0f,"
                "\"gear_ratio\":%.0f,\"counts_per_rev\":%.0f,\"control_hz\":%lu,\"pwm_hz\":%lu,"
                "\"supply_nominal_v\":12.0,\"current_trip_a\":%.1f,\"current_sustain_a\":%.1f,"
                "\"overheat_c\":%.0f,\"host_timeout_ms\":%lu,\"nn\":\"MLP %d-%d-%d-%d\"}\n",
                __DATE__, __TIME__, (unsigned long)(millis() / 1000), resetReason(),
                hasIna ? "true" : "false", hasMpu ? "true" : "false", hasOled ? "true" : "false",
                hasTemp ? "true" : "false", distIsFixed ? "false" : "true", ENCODER_PPR, GEAR_RATIO,
                COUNTS_PER_REV, (unsigned long)(1000 / CONTROL_PERIOD_MS), (unsigned long)PWM_FREQ_HZ,
                CURRENT_TRIP_A, CURRENT_SUSTAIN_A, OVERHEAT_C, (unsigned long)HOST_TIMEOUT_MS,
                NN_SIZES[0], NN_SIZES[1], NN_SIZES[2], NN_SIZES[3]);
}

static void printHelp() {
  Serial.println("# commands: help | status | scan | tele on | tele off | stop | reset | pwm <0-255> | rpm <target> | ping | onewire | idreset | baseline | tuner nn|lambda");
  Serial.printf("#   motor stops if no line arrives for %lu ms (a single typed pwm/rpm command = short jog)\n",
                (unsigned long)HOST_TIMEOUT_MS);
  Serial.println("#   or a JSON control packet, e.g. {\"kp\":1.2,\"ki\":0.4,\"kd\":0.05,\"targetSpeed\":150,"
                 "\"controllerMode\":\"PID\",\"excitationSignal\":\"None\",\"isEStop\":false}");
}

static void handleJson(const char *line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) { Serial.println("# bad JSON"); return; }

  portENTER_CRITICAL(&settingsMux);
  Settings &s = settings;
  if (doc["kp"].is<float>()) s.kp = constrain(doc["kp"].as<float>(), 0.0f, 50.0f);
  if (doc["ki"].is<float>()) s.ki = constrain(doc["ki"].as<float>(), 0.0f, 50.0f);
  if (doc["kd"].is<float>()) s.kd = constrain(doc["kd"].as<float>(), 0.0f, 5.0f);
  if (doc["targetSpeed"].is<float>()) s.targetRpm = constrain(doc["targetSpeed"].as<float>(), 0.0f, MAX_TARGET_RPM);
  s.mode = parseMode(doc["controllerMode"] | (const char *)nullptr, s.mode);
  s.excitation = parseExcitation(doc["excitationSignal"] | (const char *)nullptr, s.excitation);
  if (doc["isEStop"].is<bool>()) {
    bool e = doc["isEStop"].as<bool>();
    if (s.estop && !e) s.clearFaults = true;  // releasing E-stop clears latched faults
    s.estop = e;
  }
  const char *tuner = doc["tuner"] | (const char *)nullptr;
  if (tuner) s.tunerNN = strcmp(tuner, "lambda") != 0;
  s.armed = true;
  portEXIT_CRITICAL(&settingsMux);

  // One-shot commands from the dashboard
  const char *cmd = doc["cmd"] | (const char *)nullptr;
  if (cmd) {
    if (!strcmp(cmd, "idreset")) { idResetRequested = true; Serial.println("# identification reset"); }
    else if (!strcmp(cmd, "baseline")) { baselineResetRequested = true; Serial.println("# anomaly baseline relearn"); }
    else if (!strcmp(cmd, "status")) printStatus();
  }
}

static void handleText(char *line) {
  if (!strcmp(line, "ping")) return;  // heartbeat, lastHostMs already updated
  if (!strcmp(line, "help")) { printHelp(); return; }
  if (!strcmp(line, "status")) { printStatus(); return; }
  if (!strcmp(line, "scan")) { i2cScan(); return; }
  if (!strcmp(line, "onewire")) { oneWireDiagRequested = true; return; }
  if (!strcmp(line, "idreset")) { idResetRequested = true; Serial.println("# identification reset"); return; }
  if (!strcmp(line, "baseline")) { baselineResetRequested = true; Serial.println("# anomaly baseline relearn"); return; }
  if (!strcmp(line, "tuner nn")) { portENTER_CRITICAL(&settingsMux); settings.tunerNN = true; portEXIT_CRITICAL(&settingsMux); return; }
  if (!strcmp(line, "tuner lambda")) { portENTER_CRITICAL(&settingsMux); settings.tunerNN = false; portEXIT_CRITICAL(&settingsMux); return; }
  if (!strcmp(line, "tele on")) { telemetryOn = true; return; }
  if (!strcmp(line, "tele off")) { telemetryOn = false; return; }

  portENTER_CRITICAL(&settingsMux);
  if (!strcmp(line, "stop")) {
    settings.armed = false;
    settings.rawPwm = 0;
  } else if (!strcmp(line, "reset")) {
    settings.clearFaults = true;
    settings.estop = false;
  } else if (!strncmp(line, "pwm ", 4)) {
    settings.mode = Mode::Raw;
    settings.rawPwm = constrain(atof(line + 4), 0.0, 255.0);
    settings.armed = true;
  } else if (!strncmp(line, "rpm ", 4)) {
    settings.mode = Mode::PID;
    settings.targetRpm = constrain(atof(line + 4), 0.0, (double)MAX_TARGET_RPM);
    settings.armed = true;
  } else {
    portEXIT_CRITICAL(&settingsMux);
    Serial.println("# unknown command, type: help");
    return;
  }
  portEXIT_CRITICAL(&settingsMux);
}

static void pollSerial() {
  static char buf[384];
  static size_t len = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (len == 0) continue;
      buf[len] = 0;
      len = 0;
      lastHostMs = millis();
      if (buf[0] == '{') handleJson(buf);
      else handleText(buf);
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    } else {
      len = 0;  // overlong line, drop it
    }
  }
}

static void sendTelemetry() {
  Sample s;
  char out[768];
  while (xQueueReceive(telemetryQueue, &s, 0) == pdTRUE) {
    if (!telemetryOn) continue;
    int n = snprintf(out, sizeof(out),
        "{\"time\":%.2f,\"ref\":%.1f,\"output\":%.2f,\"input\":%.1f,\"error\":%.2f,"
        "\"current\":%.3f,\"temp\":%.2f,\"fault\":\"%s\",\"vib\":%.4f,\"dist\":%.1f,\"volt\":%.2f,"
        "\"idK\":%.3f,\"idTau\":%.4f,\"aKp\":%.3f,\"aKi\":%.3f,\"idN\":%lu,\"idOk\":%s,"
        "\"tsrc\":\"%s\",\"dsrc\":\"%s\",\"idD\":%d,\"nKp\":%.3f,\"nKi\":%.3f,\"tun\":\"%s\","
        "\"an\":%.3f,\"acl\":\"%s\",\"zs\":%.2f,\"zi\":%.2f,\"zv\":%.2f,\"kdr\":%.1f,\"twin\":%.1f,"
        "\"abp\":%.2f,\"therm\":%.2f,\"mode\":\"%s\",\"gKp\":%.3f,\"gKi\":%.3f,\"gKd\":%.3f}\n",
        s.index * DT, s.ref, s.rpm, s.pwm, s.error, s.current, s.temp, faultName(s.fault),
        s.vib, s.dist, s.volt, s.idK, s.idTau, s.aKp, s.aKi, (unsigned long)s.idN,
        s.idOk ? "true" : "false", s.tempModel ? "model" : "sensor", s.distFixed ? "fixed" : "sensor",
        s.idD, s.nnKp, s.nnKi, s.tunerNN ? "nn" : "lambda",
        s.an.score, anomalyName(s.an.cls), s.an.zSpeed, s.an.zCurrent, s.an.zVib, s.an.kDriftPct,
        s.an.twinRpm, s.an.baselineProgress, s.an.thermal, modeName(s.mode), s.gKp, s.gKi, s.gKd);
    if (Serial.availableForWrite() >= n) Serial.write(out, n);  // never block the loop on a stalled host
  }
}

// ------------------------------------------------------------------ setup ---
void setup() {
  // Motor driver off before anything else.
  pinMode(PIN_STBY, OUTPUT);
  digitalWrite(PIN_STBY, LOW);
  pinMode(PIN_AIN1, OUTPUT);
  pinMode(PIN_AIN2, OUTPUT);
  digitalWrite(PIN_AIN1, LOW);
  digitalWrite(PIN_AIN2, LOW);
  ledcSetup(PWM_CHANNEL, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcAttachPin(PIN_PWMA, PWM_CHANNEL);
  ledcWrite(PWM_CHANNEL, 0);

  Serial.setTxBufferSize(4096);
  Serial.setRxBufferSize(1024);
  Serial.begin(LAB_SERIAL_BAUD);
  delay(300);
  Serial.println();
  Serial.println("# EdgeAI ControlLab firmware " __DATE__ " " __TIME__);

  ESP32Encoder::useInternalWeakPullResistors = puType::up;
  encoder.attachFullQuad(PIN_ENC_A, PIN_ENC_B);
  encoder.setFilter(250);  // ~3 us glitch filter (APB cycles)
  encoder.clearCount();

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  Wire.setTimeOut(10);
  i2cScan();

  hasIna = ina219.begin(&Wire);
  hasMpu = mpuInit();
  hasOled = oled.begin(SSD1306_SWITCHCAPVCC, ADDR_OLED);
  if (hasOled) {
    oled.clearDisplay();
    oled.setTextColor(SSD1306_WHITE);
    oled.setCursor(0, 0);
    oled.println("EdgeAI ControlLab");
    oled.println("booting...");
    oled.display();
  }

  ds18b20.begin();
  hasTemp = ds18b20.getDeviceCount() > 0;
  if (hasTemp) {
    ds18b20.setResolution(11);            // 375 ms conversion
    ds18b20.setWaitForConversion(false);  // never block on 1-Wire
  }

  printStatus();
  printHelp();
  Serial.println("# motor is IDLE until a control packet, 'pwm <n>' or 'rpm <n>' arrives");

  telemetryQueue = xQueueCreate(32, sizeof(Sample));
  xTaskCreatePinnedToCore(controlTask, "control", 8192, nullptr, configMAX_PRIORITIES - 2, nullptr, 1);
  xTaskCreatePinnedToCore(auxTask, "aux", 4096, nullptr, 1, nullptr, 0);
}

void loop() {
  pollSerial();
  if (hostTimedOut) {
    hostTimedOut = false;
    Serial.println("# host link silent: motor stopped (send commands/ping to keep it running)");
  }
  sendTelemetry();
  vTaskDelay(1);
}
