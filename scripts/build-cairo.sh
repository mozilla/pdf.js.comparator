#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the cairo (poppler+cairo) PDF renderer wasm.
#
# Outputs: ${OUT}/cairo/cairo.{js,wasm}
#
# Inputs: src/cairo/renderer.cpp + src/common/{render_api.h,myjs.js},
# plus poppler's cairo backend source files (CairoOutputDev.cc etc.) which
# poppler doesn't bundle into libpoppler.a.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

ensure_poppler
POPPLER_SRC="${SRC_DIR}/poppler"
CAIRO_SOURCE_FINGERPRINT="cairo=${CAIRO_TAG};poppler=${POPPLER_TAG}"

mkdir -p "${OUT}/cairo"

PKG_DEPS="poppler cairo libpng freetype2 libopenjp2 libjpeg lcms2 zlib"
CFLAGS="$(renderer_pkg_cflags ${PKG_DEPS})"
LIBS="$(renderer_pkg_libs ${PKG_DEPS})"

em++ -o "${OUT}/cairo/cairo.js" \
    "${ROOT}/src/cairo/renderer.cpp" \
    "${POPPLER_SRC}/poppler/CairoOutputDev.cc" \
    "${POPPLER_SRC}/poppler/CairoFontEngine.cc" \
    "${POPPLER_SRC}/poppler/CairoRescaleBox.cc" \
    --std=c++20 \
    ${CFLAGS} \
    -I"${ROOT}/src/common" \
    -I"${POPPLER_SRC}" \
    -I"${POPPLER_SRC}/build" \
    ${LIBS} \
    $(renderer_emcc_flags) \
    -s EXPORT_NAME="'CairoRenderer'" \
    -s NO_FILESYSTEM=1 \
    -s EXPORTED_FUNCTIONS='["_render","_num_pages","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","writeArrayToMemory"]' \
    -DNDEBUG \
    -flto \
    -O3 -msimd128 -msse -fno-exceptions \
    --js-library "${ROOT}/src/common/myjs.js"

finalize_renderer_output "${OUT}/cairo/cairo.js"

cat > "${OUT}/cairo/source.json" <<EOF
{
  "name": "cairo",
  "dependencies": {
    "cairo": {
      "repo": "https://gitlab.freedesktop.org/cairo/cairo.git",
      "ref": "${CAIRO_TAG}"
    },
    "poppler": {
      "repo": "https://gitlab.freedesktop.org/poppler/poppler.git",
      "ref": "${POPPLER_TAG}"
    }
  },
  "fingerprint": "${CAIRO_SOURCE_FINGERPRINT}"
}
EOF
