// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

#pragma once

#include <cstddef>
#include <cstdint>
#include <algorithm>
#include <cmath>
#include <limits>

struct RenderBitmapSize {
  int width;
  int height;
  size_t bytes;
};

inline constexpr int kMaxBitmapDimension = 32767;
inline constexpr size_t kMaxBitmapBytes = 512ULL * 1024ULL * 1024ULL;

inline bool computeBitmapByteSize(int width, int height, size_t *bytes) {
  if (!bytes || width <= 0 || height <= 0 ||
      width > kMaxBitmapDimension || height > kMaxBitmapDimension) {
    return false;
  }

  const auto w = static_cast<size_t>(width);
  const auto h = static_cast<size_t>(height);
  if (w > std::numeric_limits<size_t>::max() / h ||
      w * h > std::numeric_limits<size_t>::max() / 4 ||
      w * h * 4 > kMaxBitmapBytes) {
    return false;
  }

  *bytes = w * h * 4;
  return true;
}

inline bool computeRenderBitmapSize(double page_w_pt, double page_h_pt,
                                    double resolution,
                                    RenderBitmapSize *out) {
  if (!out || !std::isfinite(page_w_pt) || !std::isfinite(page_h_pt) ||
      !std::isfinite(resolution) || page_w_pt < 0.0 || page_h_pt < 0.0 ||
      resolution <= 0.0) {
    return false;
  }

  const double scale = resolution / 72.0;
  const double width_d = std::max(1.0, std::ceil(page_w_pt * scale));
  const double height_d = std::max(1.0, std::ceil(page_h_pt * scale));
  if (!std::isfinite(width_d) || !std::isfinite(height_d) ||
      width_d > kMaxBitmapDimension || height_d > kMaxBitmapDimension) {
    return false;
  }

  const int width = static_cast<int>(width_d);
  const int height = static_cast<int>(height_d);
  size_t bytes = 0;
  if (!computeBitmapByteSize(width, height, &bytes)) {
    return false;
  }

  *out = {width, height, bytes};
  return true;
}

// Each renderer wasm exposes _render(...) and _num_pages(...) and calls
// these JS-side callbacks (defined in common/myjs.js) on success.

extern "C" void pushRenderImage(const uint8_t *rgba, int width, int height,
                                double page_w_pt, double page_h_pt);
extern "C" void setNumPages(int num_pages);
