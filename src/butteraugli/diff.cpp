// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Wrapper around google/butteraugli's standalone C++ library. Takes two
// RGBA8 buffers from JS, writes a grayscale heatmap (also RGBA8), and
// returns butteraugli's 3-norm distance value.

#include <cstddef>
#include <cstdint>
#include <vector>

#include <emscripten.h>

#include "butteraugli/butteraugli.h"

extern "C" double EMSCRIPTEN_KEEPALIVE
butteraugli_compare(const uint8_t *a, const uint8_t *b,
                    int width, int height,
                    uint8_t *diff_out /* RGBA8, width*height*4, may be null */)
{
  if (width <= 0 || height <= 0 || !a || !b) return -1.0;

  using butteraugli::ImageF;

  // ImageF is move-only, so build the vectors with emplace rather than a
  // copy-fill. Three planes (R, G, B), float in [0, 1], each width*height.
  std::vector<ImageF> rgb0; rgb0.reserve(3);
  std::vector<ImageF> rgb1; rgb1.reserve(3);
  for (int c = 0; c < 3; ++c) {
    rgb0.emplace_back(width, height);
    rgb1.emplace_back(width, height);
  }
  // Composite each pixel over a white background so transparent areas
  // don't show up as renderer differences. This matches src/flip/diff.cpp
  // so the two metrics treat alpha identically.
  auto compose = [](uint8_t v, uint8_t a) {
    const float alpha = a / 255.0f;
    return v / 255.0f * alpha + (1.0f - alpha);
  };
  for (int y = 0; y < height; ++y) {
    float *r0 = rgb0[0].Row(y), *g0 = rgb0[1].Row(y), *b0 = rgb0[2].Row(y);
    float *r1 = rgb1[0].Row(y), *g1 = rgb1[1].Row(y), *b1 = rgb1[2].Row(y);
    const uint8_t *pa = a + static_cast<size_t>(y) * width * 4;
    const uint8_t *pb = b + static_cast<size_t>(y) * width * 4;
    for (int x = 0; x < width; ++x) {
      const uint8_t aa = pa[4 * x + 3];
      const uint8_t ba = pb[4 * x + 3];
      r0[x] = compose(pa[4 * x + 0], aa);
      g0[x] = compose(pa[4 * x + 1], aa);
      b0[x] = compose(pa[4 * x + 2], aa);
      r1[x] = compose(pb[4 * x + 0], ba);
      g1[x] = compose(pb[4 * x + 1], ba);
      b1[x] = compose(pb[4 * x + 2], ba);
    }
  }

  ImageF diffmap;
  double diffvalue = -1.0;
  const float hf_asymmetry = 1.0f;
  if (!butteraugli::ButteraugliInterface(rgb0, rgb1, hf_asymmetry, diffmap,
                                         diffvalue)) {
    return -1.0;
  }

  if (diff_out) {
    for (int y = 0; y < height; ++y) {
      const float *row = diffmap.Row(y);
      uint8_t *out = diff_out + static_cast<size_t>(y) * width * 4;
      for (int x = 0; x < width; ++x) {
        float v = row[x] * 64.0f;
        if (v < 0.0f) v = 0.0f;
        if (v > 255.0f) v = 255.0f;
        const uint8_t g = static_cast<uint8_t>(v);
        out[4 * x + 0] = g;
        out[4 * x + 1] = g;
        out[4 * x + 2] = g;
        out[4 * x + 3] = 255;
      }
    }
  }
  return diffvalue;
}
