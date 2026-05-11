// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "FLIP.h"

namespace {

float srgb_to_linear(float value) {
  if (value <= 0.04045f) {
    return value / 12.92f;
  }
  return std::pow((value + 0.055f) / 1.055f, 2.4f);
}

float normalized_byte(uint8_t value) {
  return static_cast<float>(value) / 255.0f;
}

void rgba_to_linear_rgb(const uint8_t *rgba, int width, int height,
                        std::vector<float> &rgb) {
  const size_t pixels = static_cast<size_t>(width) *
                        static_cast<size_t>(height);
  rgb.resize(pixels * 3);
  for (size_t i = 0; i < pixels; ++i) {
    const uint8_t *src = rgba + i * 4;
    const float alpha = normalized_byte(src[3]);
    for (int channel = 0; channel < 3; ++channel) {
      const float srgb =
          normalized_byte(src[channel]) * alpha + (1.0f - alpha);
      rgb[i * 3 + channel] = srgb_to_linear(srgb);
    }
  }
}

uint8_t float_to_byte(float value) {
  value = std::clamp(value, 0.0f, 1.0f);
  return static_cast<uint8_t>(std::lround(value * 255.0f));
}

} // namespace

extern "C" {

float flip_compare(const uint8_t *reference, const uint8_t *test, int width,
                   int height, uint8_t *rgba_out) {
  if (!reference || !test || !rgba_out || width <= 0 || height <= 0) {
    return -1.0f;
  }

  std::vector<float> reference_rgb;
  std::vector<float> test_rgb;
  rgba_to_linear_rgb(reference, width, height, reference_rgb);
  rgba_to_linear_rgb(test, width, height, test_rgb);

  FLIP::Parameters parameters;
  float mean_error = -1.0f;
  float *magma_map = nullptr;
  FLIP::evaluate(reference_rgb.data(), test_rgb.data(), width, height,
                 false, // useHDR
                 parameters,
                 true, // applyMagmaMapToOutput
                 true, // computeMeanFLIPError
                 mean_error, &magma_map);

  if (!magma_map) {
    return -1.0f;
  }

  const size_t pixels = static_cast<size_t>(width) *
                        static_cast<size_t>(height);
  for (size_t i = 0; i < pixels; ++i) {
    rgba_out[i * 4 + 0] = float_to_byte(magma_map[i * 3 + 0]);
    rgba_out[i * 4 + 1] = float_to_byte(magma_map[i * 3 + 1]);
    rgba_out[i * 4 + 2] = float_to_byte(magma_map[i * 3 + 2]);
    rgba_out[i * 4 + 3] = 255;
  }

  delete[] magma_map;
  return mean_error;
}

}
