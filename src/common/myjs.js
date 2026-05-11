// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Shared JS shim used by every renderer wasm (cairo, pdfium, mupdf, …).
// Each wasm is single-purpose: one render call → one image.

mergeInto(LibraryManager.library, {
  pushRenderImage: function (ptr, width, height, pageWPt, pageHPt) {
    const size = width * height * 4;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      ptr < 0 ||
      ptr + size > HEAPU8.length
    ) {
      console.error(`invalid render image: ptr=${ptr} size=${width}x${height}`);
      return;
    }

    Module.lastResult = {
      width: width,
      height: height,
      page_width_pt: pageWPt,
      page_height_pt: pageHPt,
      data: new Uint8ClampedArray(HEAPU8.subarray(ptr, ptr + size)),
    };
  },
  setNumPages: function (numPages) {
    Module.numPages = numPages;
  },
});
