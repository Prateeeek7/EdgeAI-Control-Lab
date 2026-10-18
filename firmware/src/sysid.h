#pragma once
// On-device system identification + self-tuning (runs inside the 100 Hz control task).
//
// Model (discrete first-order + input delay + offset):
//     y[k] = a*y[k-1] + b*u[k-d] + c
// A bank of recursive-least-squares identifiers, one per candidate delay d = 1..6 samples, learns
// from the same informative samples; the one with the smallest one-step prediction error wins.
// (Offline on the lab motor, d = 3 fitted best: 94.0 % free-run fit vs 87.9 % for d = 1.)
// Signals are normalised (y/300 RPM, u/255 PWM) so float32 stays well conditioned. From (a, b, c):
//     K   = b / (1 - a)          steady-state gain, RPM per PWM step
//     tau = -Ts / ln(a)          time constant, s
// Two tuners turn the model into PI gains:
//   - lambda (IMC) rule:  Kp = tau / (K (lambda + d*Ts)),  Ki = 1 / (K (lambda + d*Ts))
//   - neural tuner (nn_tuner.h), trained offline on 4000 simulated motors to approximate the
//     closed-loop-optimal gains from (K, tau, d) as identified by exactly this algorithm.
#include <math.h>
#include "nn_tuner.h"

struct IdEstimate {
  float K = 0, tau = 0, offsetRpm = 0;
  int delay = 0;                // samples
  float kp = 0, ki = 0;         // lambda-rule gains (smoothed)
  float nnKp = 0, nnKi = 0;     // neural-tuner gains (smoothed)
  float rmsErr = 0;             // one-step prediction error of the chosen model, RPM
  float pred = 0;               // chosen model's one-step prediction of the current speed, RPM
  uint32_t updates = 0;         // informative samples used so far
  bool confident = false;
};

// One 3-parameter RLS identifier for a fixed input delay.
class Rls3 {
 public:
  static constexpr float LAMBDA = 0.995f;  // forgetting: ~2 s memory of informative samples

  void reset() {
    float a0 = expf(-0.01f / 0.1f);  // prior: K ~ 1 RPM/PWM, tau ~ 0.1 s
    theta[0] = a0;
    theta[1] = (1 - a0) * 255.0f / 300.0f;
    theta[2] = 0;
    for (int i = 0; i < 3; i++)
      for (int j = 0; j < 3; j++) P[i][j] = (i == j) ? 100.0f : 0.0f;
    errVar = 0;
    n = 0;
  }

  float predict(const float phi[3]) const { return theta[0] * phi[0] + theta[1] * phi[1] + theta[2] * phi[2]; }

  void update(const float phi[3], float yn) {
    float e = yn - predict(phi);
    float eRpm = e * 300.0f;
    errVar += (n < 50 ? 1.0f / (n + 1) : 0.02f) * (eRpm * eRpm - errVar);  // mean, then ~50-sample EWMA
    float Pphi[3];
    for (int i = 0; i < 3; i++) Pphi[i] = P[i][0] * phi[0] + P[i][1] * phi[1] + P[i][2] * phi[2];
    float denom = LAMBDA + phi[0] * Pphi[0] + phi[1] * Pphi[1] + phi[2] * Pphi[2];
    float k[3] = {Pphi[0] / denom, Pphi[1] / denom, Pphi[2] / denom};
    for (int i = 0; i < 3; i++) theta[i] += k[i] * e;
    for (int i = 0; i < 3; i++)
      for (int j = 0; j < 3; j++) P[i][j] = (P[i][j] - k[i] * Pphi[j]) / LAMBDA;
    float trace = 0;
    for (int i = 0; i < 3; i++)
      for (int j = i + 1; j < 3; j++) P[i][j] = P[j][i] = 0.5f * (P[i][j] + P[j][i]);
    for (int i = 0; i < 3; i++) trace += P[i][i];
    if (trace > 1000.0f)  // keep the filter from becoming hypersensitive
      for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) P[i][j] *= 1000.0f / trace;
    theta[0] = fminf(fmaxf(theta[0], 0.30f), 0.995f);  // physically plausible pole
    n++;
  }

  float theta[3];
  float P[3][3];
  float errVar = 0;
  uint32_t n = 0;
};

class OnlineId {
 public:
  static constexpr float Y_SCALE = 300.0f, U_SCALE = 255.0f;
  static constexpr int MIN_DELAY = 1, MAX_DELAY = 6;
  static constexpr int N_MODELS = MAX_DELAY - MIN_DELAY + 1;
  static constexpr int U_HISTORY = MAX_DELAY + 2;  // PWM samples the caller must provide

  void reset() {
    for (auto &m : models_) m.reset();
    best_ = 3 - MIN_DELAY;  // start from the offline-best delay
    est_ = IdEstimate{};
    kSlow_ = tauSlow_ = 0;
    wasConfident_ = false;
    uMin_ = 1e9f; uMax_ = -1e9f;
  }

  // y, y1: current and previous speed, RPM. uHist[i] = PWM applied i+1 periods ago (i < U_HISTORY).
  void update(float y, float y1, const float *uHist, float ts) {
    const float yn = y / Y_SCALE, y1n = y1 / Y_SCALE;
    // Learn only from samples that carry information: speed moving, or the drive changed in the
    // last MAX_DELAY+1 periods. In steady state the regressor is constant and forgetting would blow
    // up P ("covariance wind-up"). The gate is shared so the delay models compete on equal data.
    bool informative = fabsf(y - y1) > 0.6f || fabsf(uHist[0] - uHist[MAX_DELAY]) > 1.0f;

    float phiBest[3] = {y1n, uHist[MIN_DELAY + best_ - 1] / U_SCALE, 1.0f};
    est_.pred = models_[best_].predict(phiBest) * Y_SCALE;

    if (informative) {
      for (int m = 0; m < N_MODELS; m++) {
        float phi[3] = {y1n, uHist[MIN_DELAY + m - 1] / U_SCALE, 1.0f};
        models_[m].update(phi, yn);
      }
      // Keep the delay whose model predicts best; switch only on a clear (10 %) win.
      int cand = 0;
      for (int m = 1; m < N_MODELS; m++)
        if (models_[m].errVar < models_[cand].errVar) cand = m;
      if (cand != best_ && models_[cand].errVar < 0.9f * models_[best_].errVar) best_ = cand;
      est_.updates++;
      uMin_ = fminf(uMin_, uHist[0]);
      uMax_ = fmaxf(uMax_, uHist[0]);
    }
    derive(ts, informative);
  }

  const IdEstimate &estimate() const { return est_; }
  const float *bestTheta() const { return models_[best_].theta; }

 private:
  static constexpr float TUNE_LAMBDA = 0.15f;  // desired closed-loop time constant, s
  static constexpr float MIN_U_SPAN = 40.0f;   // PWM range the data must cover before trusting it

  void derive(float ts, bool updated) {
    const Rls3 &m = models_[best_];
    float a = m.theta[0];
    est_.delay = MIN_DELAY + best_;
    est_.K = m.theta[1] * Y_SCALE / U_SCALE / (1.0f - a);
    est_.tau = -ts / logf(a);
    est_.offsetRpm = m.theta[2] * Y_SCALE / (1.0f - a);
    est_.rmsErr = sqrtf(m.errVar);
    // Trust the model only once K and tau have stopped moving (compared with slow averages of
    // themselves over ~20 informative samples) and the data contained a real transient. Small
    // wiggles alone give unreliable K (checked offline: -0.5 .. 1.5 from a +-4 PWM probe).
    if (updated) {
      if (kSlow_ == 0) { kSlow_ = est_.K; tauSlow_ = est_.tau; }
      kSlow_ += 0.05f * (est_.K - kSlow_);
      tauSlow_ += 0.05f * (est_.tau - tauSlow_);
    }
    bool plausible = est_.K > 0.2f && est_.K < 5.0f && est_.tau > 0.005f && est_.tau < 2.0f;
    bool settled = fabsf(est_.K - kSlow_) < 0.05f * kSlow_ && fabsf(est_.tau - tauSlow_) < 0.15f * tauSlow_;
    bool rich = (uMax_ - uMin_) >= MIN_U_SPAN;
    if (!wasConfident_) wasConfident_ = est_.updates > 60 && plausible && settled && rich;
    est_.confident = wasConfident_ && plausible;
    if (!est_.confident) return;

    float denom = est_.K * (TUNE_LAMBDA + est_.delay * ts);
    float kp = fminf(fmaxf(est_.tau / denom, 0.05f), 1.5f);
    float ki = fminf(fmaxf(1.0f / denom, 0.2f), 10.0f);
    float nkp, nki;
    // Network inputs are clamped to its training range (K 0.3..3 RPM/PWM, tau 0.02..0.6 s, d 1..6).
    nnTunerPredict(fminf(fmaxf(est_.K, 0.3f), 3.0f), fminf(fmaxf(est_.tau, 0.02f), 0.6f), (float)est_.delay, nkp, nki);
    nkp = fminf(fmaxf(nkp, 0.02f), 3.0f);
    nki = fminf(fmaxf(nki, 0.2f), 40.0f);
    if (est_.kp == 0) { est_.kp = kp; est_.ki = ki; est_.nnKp = nkp; est_.nnKi = nki; }
    est_.kp += 0.01f * (kp - est_.kp);  // ~1 s smoothing so gains never jump
    est_.ki += 0.01f * (ki - est_.ki);
    est_.nnKp += 0.01f * (nkp - est_.nnKp);
    est_.nnKi += 0.01f * (nki - est_.nnKi);
  }

  Rls3 models_[N_MODELS];
  int best_ = 2;
  float kSlow_ = 0, tauSlow_ = 0;
  bool wasConfident_ = false;
  float uMin_ = 1e9f, uMax_ = -1e9f;
  IdEstimate est_;
};
