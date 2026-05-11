#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build Xpdf's command-line rasterizer/info tools as browser-ready
# Emscripten modules. The harness drives pdftoppm/pdfinfo via MEMFS.
#
# Outputs:
#   ${OUT}/xpdf/pdftoppm.{js,wasm}
#   ${OUT}/xpdf/pdfinfo.{js,wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

ensure_zlib
ensure_libpng
ensure_freetype

XPDF_VERSION="${XPDF_VERSION:-4.06}"
XPDF_SRC="${SRC_DIR}/xpdf-${XPDF_VERSION}"
XPDF_TARBALL="${SRC_DIR}/xpdf-${XPDF_VERSION}.tar.gz"

# Use CMakeLists.txt as a marker for a complete extraction — a directory
# may exist from a previous run that crashed mid-tar and never produced
# a buildable tree, in which case we want to re-extract from scratch.
if [ ! -f "${XPDF_SRC}/CMakeLists.txt" ]; then
    rm -rf "${XPDF_SRC}"
    mkdir -p "${SRC_DIR}"
    if [ ! -f "${XPDF_TARBALL}" ]; then
        curl -fSL -o "${XPDF_TARBALL}.tmp" \
            "https://dl.xpdfreader.com/xpdf-${XPDF_VERSION}.tar.gz"
        mv "${XPDF_TARBALL}.tmp" "${XPDF_TARBALL}"
    fi
    tar -xf "${XPDF_TARBALL}" -C "${SRC_DIR}"
fi

mkdir -p "${OUT}/xpdf"

XPDF_LINK_FLAGS=(
    -s ALLOW_MEMORY_GROWTH=1
    -s MAXIMUM_MEMORY=2GB
    -s WASM=1
    -s MODULARIZE=1
    -s EXPORT_ES6=1
    -s SINGLE_FILE=0
    -s ENVIRONMENT=web,worker
    -s NO_EXIT_RUNTIME=1
    -s INVOKE_RUN=0
    -s FORCE_FILESYSTEM=1
    -s EXPORTED_RUNTIME_METHODS='["FS","callMain"]'
    -s ASSERTIONS=0
)

emcmake cmake -G Ninja -S "${XPDF_SRC}" -B "${XPDF_SRC}/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_EXECUTABLE_SUFFIX=.js \
    -DCMAKE_CXX_FLAGS="-DNDEBUG -fno-exceptions" \
    -DCMAKE_EXE_LINKER_FLAGS="${XPDF_LINK_FLAGS[*]}" \
    -DMULTITHREADED=OFF \
    -DUSE_EXCEPTIONS=OFF \
    -DNO_FONTCONFIG=ON \
    -DFREETYPE_DIR="${WASM_PREFIX}" \
    -DFREETYPE_INCLUDE_DIR_ft2build="${WASM_PREFIX}/include/freetype2" \
    -DFREETYPE_INCLUDE_DIR_freetype="${WASM_PREFIX}/include/freetype2" \
    -DFREETYPE_LIBRARY="${WASM_PREFIX}/lib/libfreetype.a" \
    -DFREETYPE_OTHER_LIBS="${WASM_PREFIX}/lib/libpng.a;${WASM_PREFIX}/lib/libz.a" \
    -DZLIB_ROOT="${WASM_PREFIX}" \
    -DPNG_PNG_INCLUDE_DIR="${WASM_PREFIX}/include" \
    -DPNG_LIBRARY="${WASM_PREFIX}/lib/libpng.a"

cmake --build "${XPDF_SRC}/build" --target pdftoppm pdfinfo

cp "${XPDF_SRC}/build/xpdf/pdftoppm.js" "${OUT}/xpdf/pdftoppm.js"
cp "${XPDF_SRC}/build/xpdf/pdftoppm.wasm" "${OUT}/xpdf/pdftoppm.wasm"
cp "${XPDF_SRC}/build/xpdf/pdfinfo.js" "${OUT}/xpdf/pdfinfo.js"
cp "${XPDF_SRC}/build/xpdf/pdfinfo.wasm" "${OUT}/xpdf/pdfinfo.wasm"

for license_file in COPYING COPYING3 README; do
    if [ -f "${XPDF_SRC}/${license_file}" ]; then
        cp "${XPDF_SRC}/${license_file}" "${OUT}/xpdf/${license_file}"
    fi
done

chmod ugo-x "${OUT}/xpdf/"*.wasm
sed -i '1 i\/* THIS FILE IS GENERATED - DO NOT EDIT */' "${OUT}/xpdf/pdftoppm.js"
sed -i '1 i\/* THIS FILE IS GENERATED - DO NOT EDIT */' "${OUT}/xpdf/pdfinfo.js"

echo "xpdf: ${OUT}/xpdf ($(du -sh "${OUT}/xpdf" | cut -f1))"

cat > "${OUT}/xpdf/source.json" <<EOF
{
  "name": "xpdf",
  "url": "https://dl.xpdfreader.com/xpdf-${XPDF_VERSION}.tar.gz",
  "version": "${XPDF_VERSION}",
  "fingerprint": "xpdf=${XPDF_VERSION}"
}
EOF
