// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation
//
// Poppler renderer using the in-tree Splash software rasterizer — the same
// backend pdftoppm uses by default. Mirrors src/cairo/renderer.cpp but with
// no cairo dependency; Splash writes packed RGB into a SplashBitmap and
// keeps a separate 1-byte alpha plane, both of which we repack to RGBA
// before handing the buffer back to JS.

#include "render_api.h"

#include <cmath>
#include <cstdlib>
#include <memory>
#include <utility>

#include <emscripten.h>

#include "GlobalParams.h"
#include "Object.h"
#include "PDFDoc.h"
#include "Page.h"
#include "SplashOutputDev.h"
#include "Stream.h"
#include "goo/GooString.h"
#include "splash/SplashBitmap.h"
#include "splash/SplashTypes.h"

namespace {

void ensureGlobalParams() {
  if (!globalParams) {
    globalParams = std::make_unique<GlobalParams>();
  }
}

// PDFDoc's BaseStream* constructor takes ownership and `delete`s it from
// ~PDFDoc, so we hand off a raw pointer rather than a unique_ptr.
std::unique_ptr<PDFDoc> makeDoc(const uint8_t *data, size_t size) {
  ensureGlobalParams();
  auto *stream = new MemStream(reinterpret_cast<const char *>(data), 0,
                               static_cast<Goffset>(size), Object());
  auto doc = std::make_unique<PDFDoc>(stream);
  if (!doc->isOk()) {
    return nullptr;
  }
  return doc;
}

// Splash splashModeRGB8 stores 3 bytes/pixel, padded per row to the
// `bitmapRowPad` we passed in (4); rowSize gives the padded stride. The
// alpha plane (always allocated for non-mono modes) is 1 byte/pixel with
// no padding. Repack into packed RGBA.
uint8_t *bitmapToRGBA(SplashBitmap *bitmap, bool use_alpha_plane) {
  const int width = bitmap->getWidth();
  const int height = bitmap->getHeight();
  size_t out_size = 0;
  if (!computeBitmapByteSize(width, height, &out_size)) {
    return nullptr;
  }
  uint8_t *out = static_cast<uint8_t *>(std::malloc(out_size));
  if (!out) {
    return nullptr;
  }
  const unsigned char *rgb_base = bitmap->getDataPtr();
  const int rgb_stride = bitmap->getRowSize();
  const unsigned char *alpha_base =
      use_alpha_plane ? bitmap->getAlphaPtr() : nullptr;
  for (int y = 0; y < height; ++y) {
    const uint8_t *src = rgb_base + static_cast<size_t>(y) * rgb_stride;
    const uint8_t *asrc =
        alpha_base ? alpha_base + static_cast<size_t>(y) * width : nullptr;
    uint8_t *dst = out + static_cast<size_t>(y) * width * 4;
    for (int x = 0; x < width; ++x) {
      dst[4 * x + 0] = src[3 * x + 0];
      dst[4 * x + 1] = src[3 * x + 1];
      dst[4 * x + 2] = src[3 * x + 2];
      dst[4 * x + 3] = asrc ? asrc[x] : 255;
    }
  }
  return out;
}

}  // namespace

extern "C" void EMSCRIPTEN_KEEPALIVE num_pages(const uint8_t *data,
                                               size_t size) {
  auto doc = makeDoc(data, size);
  setNumPages(doc ? doc->getNumPages() : -1);
}

extern "C" void EMSCRIPTEN_KEEPALIVE render(const uint8_t *data,
                                            size_t data_size,
                                            int page_number, double resolution,
                                            int antialias, int transparent) {
  if (!std::isfinite(resolution) || resolution <= 0.0) {
    resolution = 96.0;
  }

  auto doc = makeDoc(data, data_size);
  if (!doc) return;
  if (page_number < 1 || page_number > doc->getNumPages()) return;
  Page *page = doc->getPage(page_number);
  if (!page) return;

  double page_w = page->getCropWidth();
  double page_h = page->getCropHeight();
  const int rotate = page->getRotate();
  if (rotate == 90 || rotate == 270) std::swap(page_w, page_h);

  // Paper colour: white for opaque rendering, cleared (zeros) for
  // transparent so the alpha plane carries actual page coverage rather
  // than uniform 255 from the paint-over-paper step.
  SplashColor paper;
  if (transparent) {
    paper[0] = paper[1] = paper[2] = 0;
  } else {
    paper[0] = paper[1] = paper[2] = 255;
  }

  auto output = std::make_unique<SplashOutputDev>(
      splashModeRGB8, /*bitmapRowPad=*/4, /*reverseVideo=*/false, paper,
      /*bitmapTopDown=*/true);
  output->setFontAntialias(antialias != 0);
  output->setVectorAntialias(antialias != 0);
  output->startDoc(doc.get());
  doc->displayPageSlice(
      output.get(), page_number, resolution, resolution,
      /*rotate=*/0, /*useMediaBox=*/false, /*crop=*/true, /*printing=*/false,
      -1, -1, -1, -1);

  SplashBitmap *bitmap = output->getBitmap();
  if (!bitmap) return;
  uint8_t *rgba = bitmapToRGBA(bitmap, transparent != 0);
  if (!rgba) return;
  pushRenderImage(rgba, bitmap->getWidth(), bitmap->getHeight(), page_w,
                  page_h);
  std::free(rgba);
}
