#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the splash (poppler+Splash) PDF renderer wasm.
#
# Outputs: ${OUT}/splash/splash.{js,wasm}
#
# Inputs: src/splash/renderer.cpp + src/common/{render_api.h,myjs.js}.
# Unlike build-cairo.sh we don't pull in any extra .cc files — Splash's
# sources (poppler/SplashOutputDev.cc, splash/*.cc) are bundled into
# libpoppler.a by poppler's default CMake build. Cairo is intentionally
# absent from both the dep chain (ensure_poppler_nocairo) and the link
# step so this renderer can move ahead of the cairo renderer's poppler
# pin when needed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

ensure_poppler_nocairo
POPPLER_SRC="${SRC_DIR}/poppler"
SPLASH_SOURCE_FINGERPRINT="splash=${POPPLER_TAG}"

mkdir -p "${OUT}/splash"

PKG_DEPS="poppler libpng freetype2 libopenjp2 libjpeg lcms2 zlib"
CFLAGS="$(renderer_pkg_cflags ${PKG_DEPS})"
LIBS="$(renderer_pkg_libs ${PKG_DEPS})"

em++ -o "${OUT}/splash/splash.js" \
    "${ROOT}/src/splash/renderer.cpp" \
    --std=c++20 \
    ${CFLAGS} \
    -I"${ROOT}/src/common" \
    -I"${POPPLER_SRC}" \
    -I"${POPPLER_SRC}/build" \
    ${LIBS} \
    $(renderer_emcc_flags) \
    -s EXPORT_NAME="'SplashRenderer'" \
    -s NO_FILESYSTEM=1 \
    -s EXPORTED_FUNCTIONS='["_render","_num_pages","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","writeArrayToMemory"]' \
    -DNDEBUG \
    -flto \
    -O3 -msimd128 -msse -fno-exceptions \
    --js-library "${ROOT}/src/common/myjs.js"

finalize_renderer_output "${OUT}/splash/splash.js"

cat > "${OUT}/splash/source.json" <<EOF
{
  "name": "splash",
  "dependencies": {
    "poppler": {
      "repo": "https://gitlab.freedesktop.org/poppler/poppler.git",
      "ref": "${POPPLER_TAG}"
    }
  },
  "fingerprint": "${SPLASH_SOURCE_FINGERPRINT}"
}
EOF
