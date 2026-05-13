// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

#include "render_api.h"

#include <cmath>
#include <cstdlib>
#include <memory>
#include <utility>

#include <cairo.h>
#include <emscripten.h>

// Poppler installs its top-level headers directly into <sysroot>/include/poppler/
// and pkg-config adds that as -I, so user code includes them by bare name.
// Only goo/ keeps its subdir prefix because GooString.h actually lives in goo/.
#include "CairoOutputDev.h"
#include "GlobalParams.h"
#include "Object.h"
#include "PDFDoc.h"
#include "Page.h"
#include "Stream.h"
#include "goo/GooString.h"

namespace {

void ensureGlobalParams() {
  if (!globalParams) {
    globalParams = std::make_unique<GlobalParams>();
  }
}

std::unique_ptr<PDFDoc> makeDoc(const uint8_t *data, size_t size) {
  ensureGlobalParams();
  // PDFDoc takes ownership of the BaseStream via unique_ptr — poppler
  // 26.x removed the older raw-pointer overload.
  auto stream = std::unique_ptr<BaseStream>(new MemStream(
      reinterpret_cast<const char *>(data), 0,
      static_cast<Goffset>(size), Object()));
  auto doc = std::make_unique<PDFDoc>(std::move(stream));
  if (!doc->isOk()) {
    return nullptr;
  }
  return doc;
}

// Cairo's ARGB32 image surface stores pixels as machine-endian uint32 with
// premultiplied alpha. On wasm (little-endian) the byte order in memory is
// B, G, R, A. We repack to straight RGBA.
uint8_t *surfaceToRGBA(cairo_surface_t *surface, int width, int height) {
  cairo_surface_flush(surface);
  const uint8_t *src_base = cairo_image_surface_get_data(surface);
  const int stride = cairo_image_surface_get_stride(surface);
  size_t out_size = 0;
  if (!computeBitmapByteSize(width, height, &out_size)) {
    return nullptr;
  }
  uint8_t *out = static_cast<uint8_t *>(std::malloc(out_size));
  if (!out) {
    return nullptr;
  }
  for (int y = 0; y < height; ++y) {
    const uint8_t *src = src_base + y * stride;
    uint8_t *dst = out + static_cast<size_t>(y) * width * 4;
    for (int x = 0; x < width; ++x) {
      const uint8_t b = src[4 * x + 0];
      const uint8_t g = src[4 * x + 1];
      const uint8_t r = src[4 * x + 2];
      const uint8_t a = src[4 * x + 3];
      if (a == 0) {
        dst[4 * x + 0] = 0; dst[4 * x + 1] = 0;
        dst[4 * x + 2] = 0; dst[4 * x + 3] = 0;
      } else if (a == 255) {
        dst[4 * x + 0] = r; dst[4 * x + 1] = g;
        dst[4 * x + 2] = b; dst[4 * x + 3] = 255;
      } else {
        // Cairo's premul rounding can occasionally produce c > a, so the
        // unpremul quotient overflows 8 bits without an explicit clamp.
        const int ur = (r * 255 + a / 2) / a;
        const int ug = (g * 255 + a / 2) / a;
        const int ub = (b * 255 + a / 2) / a;
        dst[4 * x + 0] = static_cast<uint8_t>(ur > 255 ? 255 : ur);
        dst[4 * x + 1] = static_cast<uint8_t>(ug > 255 ? 255 : ug);
        dst[4 * x + 2] = static_cast<uint8_t>(ub > 255 ? 255 : ub);
        dst[4 * x + 3] = a;
      }
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

  RenderBitmapSize bitmap_size{};
  if (!computeRenderBitmapSize(page_w, page_h, resolution, &bitmap_size)) {
    return;
  }
  const int width = bitmap_size.width;
  const int height = bitmap_size.height;

  cairo_surface_t *surface =
      cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
  if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
    cairo_surface_destroy(surface);
    return;
  }
  cairo_t *cr = cairo_create(surface);
  if (cairo_status(cr) != CAIRO_STATUS_SUCCESS) {
    cairo_destroy(cr);
    cairo_surface_destroy(surface);
    return;
  }
  if (!transparent) {
    cairo_save(cr);
    cairo_set_source_rgb(cr, 1.0, 1.0, 1.0);
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_paint(cr);
    cairo_restore(cr);
  }
  cairo_set_antialias(cr,
      antialias ? CAIRO_ANTIALIAS_DEFAULT : CAIRO_ANTIALIAS_NONE);

  auto output = std::make_unique<CairoOutputDev>();
  output->setCairo(cr);
  output->setPrinting(false);
  output->startDoc(doc.get());
  doc->displayPageSlice(
      output.get(), page_number, resolution, resolution,
      /*rotate=*/0, /*useMediaBox=*/false, /*crop=*/true, /*printing=*/false,
      -1, -1, -1, -1);
  output.reset();
  cairo_destroy(cr);

  uint8_t *rgba = surfaceToRGBA(surface, width, height);
  cairo_surface_destroy(surface);
  if (!rgba) return;
  pushRenderImage(rgba, width, height, page_w, page_h);
  std::free(rgba);
}
