#pragma once
// Neural PI tuner inference (weights from ml/train_tuner.py -> nn_tuner_weights.h).
// Input: identified model (K RPM/PWM, tau s, delay samples). Output: PI gains.
// MLP 3-16-16-2, tanh hidden layers, linear output = normalised [log Kp, log Ki].
#include <math.h>
#include "nn_tuner_weights.h"

inline void nnTunerPredict(float K, float tau, float delay, float &kp, float &ki) {
  float x[16], h1[16], h2[16];
  const float in[3] = {logf(K), logf(tau), delay};
  for (int i = 0; i < NN_SIZES[0]; i++) x[i] = (in[i] - NN_X_MEAN[i]) / NN_X_STD[i];

  for (int j = 0; j < NN_SIZES[1]; j++) {
    float z = NN_B0[j];
    for (int i = 0; i < NN_SIZES[0]; i++) z += x[i] * NN_W0[i * NN_SIZES[1] + j];
    h1[j] = tanhf(z);
  }
  for (int j = 0; j < NN_SIZES[2]; j++) {
    float z = NN_B1[j];
    for (int i = 0; i < NN_SIZES[1]; i++) z += h1[i] * NN_W1[i * NN_SIZES[2] + j];
    h2[j] = tanhf(z);
  }
  float out[2];
  for (int j = 0; j < NN_SIZES[3]; j++) {
    float z = NN_B2[j];
    for (int i = 0; i < NN_SIZES[2]; i++) z += h2[i] * NN_W2[i * NN_SIZES[3] + j];
    out[j] = z * NN_Y_STD[j] + NN_Y_MEAN[j];
  }
  kp = expf(out[0]);
  ki = expf(out[1]);
}
