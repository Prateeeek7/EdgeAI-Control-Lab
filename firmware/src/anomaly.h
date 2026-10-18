#pragma once
// On-device anomaly detection (runs inside the 100 Hz control task).
//
// 1. Digital twin: once the identifier is confident, a copy of the learned model
//        twin[k] = a*twin[k-1] + b*u[k-d] + c
//    runs in parallel with the real motor, fed the same PWM. A load, friction or supply problem
//    makes the real speed leave the twin. (In closed loop the controller holds the speed, but then
//    the PWM rises and the twin, driven by that PWM, runs ahead of the motor: same signature.)
// 2. Healthy baseline: for BASELINE_S seconds of driven operation the detector learns how the
//    twin residual, the motor current and the vibration normally behave (mean/spread, and current
//    and vibration as linear functions of speed and PWM). The twin model is frozen at the end.
// 3. Scoring: every sample, residuals are turned into z-scores against that baseline and smoothed;
//    the identifier's live K is compared with the baseline K (slow drift = persistent load or
//    supply change); the motor temperature is compared with its overheat limit.
// 4. Diagnosis from the pattern of z-scores (signs matter: slower than the twin while drawing more
//    current is a mechanical load; slower without more current is a drive/supply loss, etc.).
// Nothing here stops the motor; hard limits stay in the fault logic. This is early warning.
#include <math.h>

enum class Anomaly : uint8_t { Learning, Normal, Load, DriveLoss, Overspeed, Vibration, Drift, Thermal };

inline const char *anomalyName(Anomaly a) {
  switch (a) {
    case Anomaly::Learning:  return "LEARNING";
    case Anomaly::Normal:    return "NORMAL";
    case Anomaly::Load:      return "LOAD";
    case Anomaly::DriveLoss: return "DRIVE_LOSS";
    case Anomaly::Overspeed: return "OVERSPEED";
    case Anomaly::Vibration: return "VIBRATION";
    case Anomaly::Drift:     return "DRIFT";
    case Anomaly::Thermal:   return "THERMAL";
  }
  return "?";
}

struct AnomalyState {
  Anomaly cls = Anomaly::Learning;
  float score = 0;              // 0 = healthy .. 1 = strongly anomalous
  float zSpeed = 0, zCurrent = 0, zVib = 0;  // smoothed z-scores vs the healthy baseline
  float kDriftPct = 0;          // live K vs baseline K, %
  float thermal = 0;            // 0 .. 1 towards the overheat limit
  float twinRpm = 0;            // digital-twin speed
  float baselineProgress = 0;   // 0 .. 1 while learning the baseline
};

class AnomalyDetector {
 public:
  static constexpr float BASELINE_S = 6.0f;

  void reset() {
    s_ = AnomalyState{};
    pending_ = Anomaly::Normal;
    pendingN_ = 0;
    baselineDone_ = false;
    baseTime_ = 0;
    nR_ = 0; meanR_ = 0; m2R_ = 0;
    for (auto &r : Ai_) for (auto &v : r) v = 0;
    for (auto &v : bi_) v = 0;
    for (auto &b : vibBins_) b = VibBin{};
    twinValid_ = false;
    uMin_ = 1e9f; uMax_ = -1e9f;
    sdI_ = 0; n2_ = 0; ssI_ = 0;
  }

  // Call every control period.
  //   driving: motor powered this period and the PWM history is valid
  //   theta/delay: identifier's current best model (normalised y/300, u/255), K0 check via kLive
  //   uHist[i] = PWM applied i+1 periods ago
  void update(bool driving, bool modelConfident, const float theta[3], int delay, float kLive,
              float rpm, const float *uHist, float currentA, float vibG, float tempC,
              float overheatC, float ambientC, float dt) {
    s_.thermal = fminf(fmaxf((tempC - ambientC) / (overheatC - ambientC), 0.0f), 1.0f);
    if (!driving || !modelConfident) {
      twinValid_ = false;  // coasting/idle is not modelled; restart the twin from the real speed
      s_.twinRpm = rpm;    // while not driven, report the real speed instead of a stale twin value
      if (!baselineDone_) s_.cls = Anomaly::Learning;
      decay();
      return;
    }
    const float *th = baselineDone_ ? frozen_ : theta;
    int d = baselineDone_ ? frozenDelay_ : delay;
    if (!twinValid_) { twin_ = rpm; twinValid_ = true; }
    twin_ = (th[0] * (twin_ / 300.0f) + th[1] * (uHist[d - 1] / 255.0f) + th[2]) * 300.0f;
    s_.twinRpm = twin_;
    float r = rpm - twin_;
    float pwm = uHist[0];

    if (!baselineDone_) {
      learn(r, rpm, pwm, currentA, vibG);
      baseTime_ += dt;
      uMin_ = fminf(uMin_, pwm);
      uMax_ = fmaxf(uMax_, pwm);
      s_.baselineProgress = fminf(baseTime_ / BASELINE_S, 1.0f);
      s_.cls = Anomaly::Learning;
      if (baseTime_ >= BASELINE_S && (uMax_ - uMin_) >= 30.0f && nR_ > 200) finishBaseline(theta, delay, kLive);
      return;
    }

    // z-scores against the healthy baseline, smoothed over ~0.3 s
    float zr = (r - meanR_) / sdR_;
    float zi = (currentA - (ci_[0] + ci_[1] * rpm + ci_[2] * pwm)) / sdI_;
    float zv = vibZ(rpm, vibG);
    const float A = 0.03f;
    s_.zSpeed += A * (zr - s_.zSpeed);
    s_.zCurrent += A * (zi - s_.zCurrent);
    s_.zVib += A * (zv - s_.zVib);
    s_.kDriftPct += 0.005f * ((kLive / k0_ - 1.0f) * 100.0f - s_.kDriftPct);
    classify();
  }

  void decay() {
    s_.zSpeed *= 0.97f; s_.zCurrent *= 0.97f; s_.zVib *= 0.97f;
    if (baselineDone_) classify();
  }

  bool baselineReady() const { return baselineDone_; }
  const AnomalyState &state() const { return s_; }

 private:
  void learn(float r, float rpm, float pwm, float i, float v) {
    nR_++;
    float dl = r - meanR_;
    meanR_ += dl / nR_;
    m2R_ += dl * (r - meanR_);
    const float xi[3] = {1.0f, rpm / 300.0f, pwm / 255.0f};
    for (int a = 0; a < 3; a++) {
      for (int b = 0; b < 3; b++) Ai_[a][b] += xi[a] * xi[b];
      bi_[a] += xi[a] * i;
    }
    learnVib(rpm, v);
    // keep raw second moments for the residual spread after the fit
    ssI_ += i * i; n2_++;
  }

  void finishBaseline(const float theta[3], int delay, float kLive) {
    sdR_ = fmaxf(sqrtf(m2R_ / (nR_ - 1)), 1.0f);  // RPM; floor at the encoder resolution scale
    // Ridge-regularised least squares for the current and vibration baselines.
    float A3[3][3];
    for (int a = 0; a < 3; a++) for (int b = 0; b < 3; b++) A3[a][b] = Ai_[a][b] + (a == b ? 1e-3f * n2_ : 0);
    solve3(A3, bi_, ci_);
    // Residual spreads: E[(x - fit)^2] = E[x^2] - 2 fit.b/n + fit' A fit / n (normal-equation identity)
    float varI = ssI_;
    for (int a = 0; a < 3; a++) {
      varI -= 2 * ci_[a] * bi_[a];
      for (int b = 0; b < 3; b++) varI += ci_[a] * Ai_[a][b] * ci_[b];
    }
    sdI_ = fmaxf(sqrtf(fmaxf(varI / n2_, 0)), 0.004f);   // A; floor ~ INA219 noise
    // rescale the fitted coefficients from the normalised regressors back to rpm / pwm units
    ci_[1] /= 300.0f; ci_[2] /= 255.0f;
    for (int i = 0; i < 3; i++) frozen_[i] = theta[i];
    frozenDelay_ = delay;
    k0_ = kLive;
    s_.kDriftPct = 0;
    s_.zSpeed = s_.zCurrent = s_.zVib = 0;
    baselineDone_ = true;
    s_.baselineProgress = 1.0f;
    s_.cls = Anomaly::Normal;
  }

  void classify() {
    const float zs = s_.zSpeed, zi = s_.zCurrent, zv = s_.zVib;
    // Severity: z-scores mapped so |z| = 3 is the edge of normal and |z| = 8 saturates.
    auto sev = [](float z) { return fminf(fmaxf((fabsf(z) - 3.0f) / 5.0f, 0.0f), 1.0f); };
    float drift = fminf(fmaxf((fabsf(s_.kDriftPct) - 10.0f) / 30.0f, 0.0f), 1.0f);
    float therm = fminf(fmaxf((s_.thermal - 0.6f) / 0.4f, 0.0f), 1.0f);
    float raw = fmaxf(fmaxf(sev(zs), sev(zv)), fmaxf(fmaxf(sev(zi) * 0.7f, drift), therm));
    s_.score += 0.02f * (raw - s_.score);  // ~0.5 s smoothing, consistent with the class persistence

    Anomaly c;
    if (therm > 0.5f)                    c = Anomaly::Thermal;
    else if (zs < -4.0f && zi > 2.0f)    c = Anomaly::Load;       // slower than the twin, more current
    else if (zs < -4.0f)                 c = Anomaly::DriveLoss;  // slower without extra current
    else if (zs > 4.0f)                  c = Anomaly::Overspeed;  // faster than the twin: load released
    else if (zv > 5.0f)                  c = Anomaly::Vibration;  // MPU readings are bursty: higher bar
    else if (zi > 5.0f)                  c = Anomaly::Load;       // current up while speed held
    else if (drift > 0.0f)               c = Anomaly::Drift;
    else                                 c = Anomaly::Normal;
    // Persistence: a new diagnosis must hold for 0.3 s (0.5 s to return to NORMAL) before it is
    // reported, so a single transient (e.g. the vibration burst of a sudden speed change) does
    // not flicker an alarm.
    if (c == s_.cls) { pending_ = c; pendingN_ = 0; return; }
    if (c != pending_) { pending_ = c; pendingN_ = 0; }
    // vibration faults (bearing wear, imbalance) are persistent: require 1 s
    uint32_t need = c == Anomaly::Normal ? 50u : c == Anomaly::Vibration ? 100u : 30u;
    if (++pendingN_ >= need) { s_.cls = c; pendingN_ = 0; }
  }

  static void solve3(float A[3][3], const float b[3], float x[3]) {
    float d = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
              A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (fabsf(d) < 1e-12f) { x[0] = b[0] / fmaxf(A[0][0], 1e-6f); x[1] = x[2] = 0; return; }
    for (int c = 0; c < 3; c++) {
      float M[3][3];
      for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) M[i][j] = (j == c) ? b[i] : A[i][j];
      x[c] = (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
              M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / d;
    }
  }

  AnomalyState s_;
  Anomaly pending_ = Anomaly::Normal;
  uint32_t pendingN_ = 0;
  bool baselineDone_ = false;
  float baseTime_ = 0;
  // twin
  bool twinValid_ = false;
  float twin_ = 0;
  float frozen_[3] = {0, 0, 0};
  int frozenDelay_ = 3;
  float k0_ = 1;
  // baseline statistics
  uint32_t nR_ = 0;
  float meanR_ = 0, m2R_ = 0, sdR_ = 1;
  float Ai_[3][3] = {}, bi_[3] = {}, ci_[3] = {};
  float ssI_ = 0, sdI_ = 0.004f;
  // Vibration baseline per 40 RPM speed band (vibration is not monotonic in speed: the bench motor
  // peaks around 180-260 RPM and drops above). Welford mean/variance per band.
  struct VibBin { uint32_t n = 0; float mean = 0, m2 = 0; };
  static constexpr int VIB_BINS = 8;
  static constexpr float VIB_BIN_RPM = 40.0f;
  static constexpr uint32_t VIB_BIN_MIN = 150;  // samples (1.5 s) before a band is scored
  VibBin vibBins_[VIB_BINS];

  static int vibBin(float rpm) { int b = (int)(fmaxf(rpm, 0) / VIB_BIN_RPM); return b < VIB_BINS ? b : VIB_BINS - 1; }
  void learnVib(float rpm, float v) {
    VibBin &b = vibBins_[vibBin(rpm)];
    b.n++;
    float d = v - b.mean;
    b.mean += d / b.n;
    b.m2 += d * (v - b.mean);
  }
  // z-score of the vibration against its own speed band. A band never seen during the baseline is
  // learned from its first VIB_BIN_MIN samples instead of being extrapolated into.
  float vibZ(float rpm, float v) {
    VibBin &b = vibBins_[vibBin(rpm)];
    if (b.n < VIB_BIN_MIN) { learnVib(rpm, v); return 0.0f; }
    float sd = sqrtf(b.m2 / (b.n - 1));
    sd = fmaxf(fmaxf(sd, 0.25f * b.mean), 0.002f);  // floor: bursty sensor, never divide by ~0
    return (v - b.mean) / sd;
  }
  uint32_t n2_ = 0;
  float uMin_ = 1e9f, uMax_ = -1e9f;
};
