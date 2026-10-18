#pragma once
#include <stdint.h>

// ---- Pin map (matches hardware_wiring_guide.md) ---------------------------
constexpr int PIN_I2C_SDA = 4;   // OLED, INA219, MPU6050
constexpr int PIN_I2C_SCL = 5;
constexpr int PIN_ENC_A   = 6;   // JGA12-N20 C1
constexpr int PIN_ENC_B   = 7;   // JGA12-N20 C2
constexpr int PIN_ONEWIRE = 10;  // DS18B20 DQ (4.7k pull-up to 3V3)
constexpr int PIN_TRIG    = 11;  // HC-SR04 TRIG
constexpr int PIN_ECHO    = 12;  // HC-SR04 ECHO via 1k/2k divider
constexpr int PIN_PWMA    = 15;  // TB6612FNG PWMA
constexpr int PIN_AIN1    = 16;  // TB6612FNG AIN1
constexpr int PIN_AIN2    = 17;  // TB6612FNG AIN2
constexpr int PIN_STBY    = 18;  // TB6612FNG STBY (HIGH = enabled)

// ---- I2C addresses --------------------------------------------------------
constexpr uint8_t ADDR_OLED   = 0x3C;
constexpr uint8_t ADDR_INA219 = 0x40;
constexpr uint8_t ADDR_MPU    = 0x68;
constexpr float   INA219_SHUNT_OHMS = 0.1f;  // R100 shunt on the common INA219 module

// ---- Motor / encoder ------------------------------------------------------
// JGA12-N20 12V 300RPM: magnetic encoder, 7 pulses per motor rev per channel, ~1:100 gearbox.
// If the reported RPM is ~N times off at a known speed, fix ENCODER_PPR or GEAR_RATIO.
constexpr float ENCODER_PPR    = 7.0f;
constexpr float GEAR_RATIO     = 100.0f;
constexpr float COUNTS_PER_REV = ENCODER_PPR * 4.0f * GEAR_RATIO;  // full quadrature, output shaft
// Flip if RPM reads negative while the motor spins forward (the STALL fault will trip otherwise).
constexpr bool  ENCODER_INVERT = false;
// Keep false while the INA219 is in series with the motor on the AO1 leg: inverting puts the INA219
// on the PWM-switched high side, where the 20 kHz common-mode swing corrupts the current reading
// (measured: constant 1.64 A at 0.05 A real -> false OVERCURRENT). Flip with ENCODER_INVERT.
constexpr bool  MOTOR_DIR_INVERT = false;

constexpr uint32_t PWM_FREQ_HZ   = 20000;
constexpr uint8_t  PWM_RES_BITS  = 10;
constexpr uint8_t  PWM_CHANNEL   = 0;

// ---- Control loop ---------------------------------------------------------
constexpr uint32_t CONTROL_PERIOD_MS = 10;     // 100 Hz, same as the backend simulator
constexpr float    DT                = CONTROL_PERIOD_MS / 1000.0f;
constexpr int      SPEED_WINDOW      = 5;      // RPM from count difference over 5 samples (50 ms)
constexpr float    MAX_TARGET_RPM    = 400.0f;
constexpr float    INTEGRAL_LIMIT    = 400.0f;

// ---- Safety ---------------------------------------------------------------
constexpr float    CURRENT_TRIP_A      = 2.0f;  // instant cut-off
constexpr float    CURRENT_SUSTAIN_A   = 1.2f;  // TB6612FNG continuous rating
constexpr int      CURRENT_SUSTAIN_N   = 20;    // samples (200 ms) above sustain limit
constexpr float    OVERHEAT_C          = 58.0f;
constexpr float    STALL_PWM           = 150.0f;
constexpr float    STALL_RPM           = 15.0f;
constexpr int      STALL_SAMPLES       = 50;    // 0.5 s
constexpr uint32_t HOST_TIMEOUT_MS     = 1500;  // stop the motor if the host goes quiet

// ---- Placeholders while a sensor is missing (flagged in telemetry, marked ~ / * on the OLED) --
constexpr float    DIST_FALLBACK_CM    = 5.5f;   // HC-SR04 fixed distance when no echo
// Motor thermal model (used when no DS18B20 is detected). Tuned to a believable N20 rise:
// ~+4 C at 150 RPM, ~+9 C at 300 RPM no-load, heating tau 90 s, cooling tau 240 s.
constexpr float    THERMAL_AMBIENT_C   = 28.5f;
constexpr float    THERMAL_R_WINDING   = 40.0f;  // ohm
constexpr float    THERMAL_FRICTION_W  = 0.10f;  // at 300 RPM
constexpr float    THERMAL_R_TH        = 25.0f;  // K/W, housing to air
constexpr float    THERMAL_TAU_HEAT_S  = 90.0f;
constexpr float    THERMAL_TAU_COOL_S  = 240.0f;

#ifndef LAB_SERIAL_BAUD
#define LAB_SERIAL_BAUD 1000000
#endif
