// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

#include "render_api.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include <emscripten.h>

extern "C" {
#include "mupdf/fitz.h"
}

// Logged from inside fz_catch — EM_ASM and setjmp/longjmp can't share a
// function, so EM_JS lifts the body to a separate JS scope.
EM_JS(void, mupdf_log_err, (const char *msg), {
  console.error("mupdf render: " + UTF8ToString(msg));
});

namespace {
fz_context *getContext() {
  static fz_context *ctx = nullptr;
  if (!ctx) {
    ctx = fz_new_context(nullptr, nullptr, FZ_STORE_UNLIMITED);
    if (ctx) fz_register_document_handlers(ctx);
  }
  return ctx;
}
}  // namespace

extern "C" void EMSCRIPTEN_KEEPALIVE num_pages(const uint8_t *data,
                                               size_t size) {
  fz_context *ctx = getContext();
  if (!ctx) { setNumPages(-1); return; }
  fz_stream *stm = nullptr;
  fz_document *doc = nullptr;
  int n = -1;
  fz_try(ctx) {
    stm = fz_open_memory(ctx, data, size);
    doc = fz_open_document_with_stream(ctx, "application/pdf", stm);
    n = fz_count_pages(ctx, doc);
  } fz_always(ctx) {
    fz_drop_document(ctx, doc);
    fz_drop_stream(ctx, stm);
  } fz_catch(ctx) {
    n = -1;
  }
  setNumPages(n);
}

extern "C" void EMSCRIPTEN_KEEPALIVE render(const uint8_t *data,
                                            size_t data_size,
                                            int page_number, double resolution,
                                            int antialias, int transparent) {
  if (!std::isfinite(resolution) || resolution <= 0.0) resolution = 96.0;
  fz_context *ctx = getContext();
  if (!ctx) {
    mupdf_log_err("fz_new_context returned null");
    return;
  }

  fz_stream *stm = nullptr;
  fz_document *doc = nullptr;
  fz_page *page = nullptr;
  fz_pixmap *pix = nullptr;
  fz_device *dev = nullptr;
  uint8_t *rgba = nullptr;
  size_t rgba_size = 0;
  int width = 0, height = 0;
  double page_w_pt = 0.0, page_h_pt = 0.0;

  fz_try(ctx) {
    fz_set_aa_level(ctx, antialias ? 8 : 0);
    stm = fz_open_memory(ctx, data, data_size);
    doc = fz_open_document_with_stream(ctx, "application/pdf", stm);
    if (page_number < 1 || page_number > fz_count_pages(ctx, doc)) {
      fz_throw(ctx, FZ_ERROR_GENERIC, "page out of range");
    }
    page = fz_load_page(ctx, doc, page_number - 1);

    const fz_rect bounds = fz_bound_page(ctx, page);
    page_w_pt = bounds.x1 - bounds.x0;
    page_h_pt = bounds.y1 - bounds.y0;
    // Compute width/height the same way cairo/pdfium do so cross-renderer
    // pixel-perfect diffs aren't systematically off-by-one. The draw
    // transform also has to translate from the page's bounds.{x0,y0} back
    // to (0,0) — fz_round_rect implicitly did that for us before.
    const float scale = static_cast<float>(resolution / 72.0);
    RenderBitmapSize bitmap_size{};
    if (!computeRenderBitmapSize(page_w_pt, page_h_pt, resolution,
                                 &bitmap_size)) {
      fz_throw(ctx, FZ_ERROR_GENERIC, "render target too large");
    }
    width = bitmap_size.width;
    height = bitmap_size.height;
    rgba_size = bitmap_size.bytes;
    const fz_irect bbox = {0, 0, width, height};
    const fz_matrix transform = fz_concat(
        fz_translate(-bounds.x0 * scale, -bounds.y0 * scale),
        fz_scale(scale, scale));

    pix = fz_new_pixmap_with_bbox(ctx, fz_device_rgb(ctx), bbox, nullptr,
                                  /*alpha=*/1);
    if (transparent) fz_clear_pixmap(ctx, pix);
    else             fz_clear_pixmap_with_value(ctx, pix, 0xFF);

    dev = fz_new_draw_device(ctx, transform, pix);
    fz_run_page(ctx, page, dev, fz_identity, nullptr);
    fz_close_device(ctx, dev);

    rgba = static_cast<uint8_t *>(std::malloc(rgba_size));
    if (rgba) {
      // fz_new_pixmap_with_bbox normally allocates stride = w*n with no
      // padding, but assert in case a future MuPDF starts aligning rows.
      const size_t expected_stride = static_cast<size_t>(width) * 4;
      if (static_cast<size_t>(pix->stride) != expected_stride) {
        for (int y = 0; y < height; ++y) {
          std::memcpy(rgba + y * expected_stride,
                      pix->samples + static_cast<size_t>(y) * pix->stride,
                      expected_stride);
        }
      } else {
        std::memcpy(rgba, pix->samples, rgba_size);
      }
    }
  } fz_always(ctx) {
    fz_drop_device(ctx, dev);
    fz_drop_pixmap(ctx, pix);
    fz_drop_page(ctx, page);
    fz_drop_document(ctx, doc);
    fz_drop_stream(ctx, stm);
  } fz_catch(ctx) {
    const char *msg = fz_caught_message(ctx);
    mupdf_log_err(msg ? msg : "(no message)");
    std::free(rgba);
    return;
  }

  if (rgba) {
    pushRenderImage(rgba, width, height, page_w_pt, page_h_pt);
    std::free(rgba);
  } else {
    mupdf_log_err("malloc returned null");
  }
}
