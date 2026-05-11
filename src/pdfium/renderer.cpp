// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

#include "render_api.h"

#include <cmath>
#include <cstdlib>
#include <limits>
#include <memory>

#include <emscripten.h>

#include "fpdfview.h"

namespace {

void ensureInit() {
  static bool initialized = false;
  if (!initialized) {
    FPDF_InitLibrary();
    initialized = true;
  }
}

struct DocGuard {
  FPDF_DOCUMENT doc = nullptr;
  ~DocGuard() { if (doc) FPDF_CloseDocument(doc); }
};
struct PageGuard {
  FPDF_PAGE page = nullptr;
  ~PageGuard() { if (page) FPDF_ClosePage(page); }
};
struct BitmapGuard {
  FPDF_BITMAP bitmap = nullptr;
  ~BitmapGuard() { if (bitmap) FPDFBitmap_Destroy(bitmap); }
};

}  // namespace

extern "C" void EMSCRIPTEN_KEEPALIVE num_pages(const uint8_t *data,
                                               size_t size) {
  if (size > static_cast<size_t>(std::numeric_limits<int>::max())) {
    setNumPages(-1);
    return;
  }
  ensureInit();
  DocGuard doc{FPDF_LoadMemDocument(data, static_cast<int>(size), nullptr)};
  setNumPages(doc.doc ? FPDF_GetPageCount(doc.doc) : -1);
}

extern "C" void EMSCRIPTEN_KEEPALIVE render(const uint8_t *data,
                                            size_t data_size,
                                            int page_number, double resolution,
                                            int antialias, int transparent) {
  if (!std::isfinite(resolution) || resolution <= 0.0) resolution = 96.0;
  if (data_size > static_cast<size_t>(std::numeric_limits<int>::max())) return;
  ensureInit();

  DocGuard doc{FPDF_LoadMemDocument(data, static_cast<int>(data_size), nullptr)};
  if (!doc.doc) return;
  if (page_number < 1 || page_number > FPDF_GetPageCount(doc.doc)) return;
  PageGuard page{FPDF_LoadPage(doc.doc, page_number - 1)};
  if (!page.page) return;

  const double page_w_pt = FPDF_GetPageWidthF(page.page);
  const double page_h_pt = FPDF_GetPageHeightF(page.page);

  RenderBitmapSize bitmap_size{};
  if (!computeRenderBitmapSize(page_w_pt, page_h_pt, resolution,
                               &bitmap_size)) {
    return;
  }
  const int width = bitmap_size.width;
  const int height = bitmap_size.height;

  // FPDFBitmap_Destroy does NOT free the caller-supplied buffer, so
  // we own `buf` independently of `bm`. Wrap in unique_ptr so any future
  // exception-prone code (e.g. pushRenderImage) can't leak it.
  std::unique_ptr<uint8_t, decltype(&std::free)> buf{
      static_cast<uint8_t *>(std::malloc(bitmap_size.bytes)), &std::free};
  if (!buf) return;

  BitmapGuard bm{FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA,
                                     buf.get(), width * 4)};
  if (!bm.bitmap) return;

  FPDFBitmap_FillRect(bm.bitmap, 0, 0, width, height,
                      transparent ? 0x00000000 : 0xFFFFFFFF);

  int flags = FPDF_REVERSE_BYTE_ORDER;  // pdfium writes RGBA on this flag
  if (!antialias) {
    flags |= FPDF_RENDER_NO_SMOOTHTEXT | FPDF_RENDER_NO_SMOOTHIMAGE |
             FPDF_RENDER_NO_SMOOTHPATH;
  }
  FPDF_RenderPageBitmap(bm.bitmap, page.page, 0, 0, width, height,
                        /*rotate=*/0, flags);

  pushRenderImage(buf.get(), width, height, page_w_pt, page_h_pt);
}
