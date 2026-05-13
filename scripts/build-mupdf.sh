#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the MuPDF PDF renderer wasm.
#
# MuPDF builds via its own Makefile with cross-compile via CC/CXX/AR.
# We use system freetype/jpeg/openjpeg/lcms2/zlib (USE_SYSTEM_*=yes), and
# patch load-jpx.c so its `opj_*` allocator overrides are __attribute__
# ((weak)) — otherwise they collide with the strong defs in libopenjp2.a.
#
# Outputs: ${OUT}/mupdf/mupdf.{js,wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

ensure_zlib
ensure_libpng
ensure_freetype
ensure_libjpeg
ensure_openjpeg
ensure_lcms2

# Local docker fallback. Pinned to the latest mupdf release before
# 1.26.2, which is when mupdf's OS=wasm Makerules started forcing
# `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` — that change is correct
# for upstream but the wasm output doesn't load cleanly in our browser
# stack against the current emsdk's legacy-EH C++ runtime. Keep the pin
# in lockstep with resolveMupdf in scripts/resolve-upstream.mjs.
MUPDF_REF="${MUPDF_REF:-${MUPDF_TAG:-1.26.1}}"
MUPDF_SRC="${SRC_DIR}/mupdf"

# ---- Phase 1: fetch + patch ------------------------------------------------
clone_pinned "${MUPDF_SRC}" https://github.com/ArtifexSoftware/mupdf.git \
    "${MUPDF_REF}"
git -C "${MUPDF_SRC}" submodule update --init --recursive --depth 1
MUPDF_COMMIT="$(git -C "${MUPDF_SRC}" rev-parse HEAD)"
# Use the resolved commit (not MUPDF_REF) so the stamp correctly invalidates
# when MUPDF_REF=master / a branch advances upstream.
MUPDF_SOURCE_FINGERPRINT="mupdf=${MUPDF_COMMIT}"
MUPDF_SOURCE_STAMP="${WASM_PREFIX}/lib/libmupdf.source"

# Make MuPDF's opj_* allocator overrides weakly-linked so libopenjp2's
# strong defs win at the final em++ link.
if ! grep -q '__attribute__((weak))' \
        "${MUPDF_SRC}/source/fitz/load-jpx.c"; then
    sed -i -E 's/^(void\s*\**\s*opj_(aligned_32_malloc|aligned_malloc|aligned_free|calloc|realloc|malloc|free)\s*\()/__attribute__((weak)) \1/' \
        "${MUPDF_SRC}/source/fitz/load-jpx.c"
fi

# mupdf >=1.26.2 added `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` to its
# OS=wasm Makerules itself; earlier versions set nothing and rely on the
# caller. The MUPDF_REF default is pinned below that boundary, so we'd
# normally hit the "set nothing" branch and inject emscripten-longjmp.
# Detected from Makerules so a manual bump to a newer tag is still
# self-consistent (build will fail at compile rather than at runtime).
if grep -q "fwasm-exceptions" "${MUPDF_SRC}/Makerules" 2>/dev/null; then
    MUPDF_EH_MODE=wasm
    MUPDF_EXTRA_XCFLAGS=""
else
    MUPDF_EH_MODE=emscripten
    MUPDF_EXTRA_XCFLAGS="-sSUPPORT_LONGJMP=emscripten"
fi
echo "mupdf: EH model = ${MUPDF_EH_MODE}"

# ---- Phase 2: libmupdf.a + libmupdf-third.a -------------------------------
# MuPDF ships an OS=wasm target which sets CC=emcc / CXX=em++ / AR=emar
# and the HAVE_X11=no / HAVE_GLUT=no flags automatically; output goes to
# build/wasm/release/. We supplement with USE_SYSTEM_* so it links against
# the shared libs in ${WASM_PREFIX} instead of its own bundled copies.
if [ ! -f "${WASM_PREFIX}/lib/libmupdf.a" ] || \
        [ "$(cat "${MUPDF_SOURCE_STAMP}" 2>/dev/null || true)" != "${MUPDF_SOURCE_FINGERPRINT}" ]; then
    cd "${MUPDF_SRC}"
    # MuPDF's Makefile has `ifndef OUT` and uses $OUT if it's set in the
    # environment — but our scripts use $OUT to mean "where the wasm
    # bundle gets installed" (e.g. /js/mupdf/), not "where MuPDF puts
    # its intermediate build/". Unset it for the make invocations so
    # MuPDF computes its own path (build/<prefix>/release/).
    # `make generate` first (host compiler) — emits CSS / glyph tables that
    # the cross build then references.
    env -u OUT make -j"$(nproc)" generate
    env -u OUT make -j"$(nproc)" \
        OS=wasm \
        build=release \
        XCFLAGS="-O2 -fno-exceptions -DTOFU=0 -DTOFU_CJK=0 \
            ${MUPDF_EXTRA_XCFLAGS} \
            -I${WASM_PREFIX}/include -I${WASM_PREFIX}/include/freetype2 \
            -I${WASM_PREFIX}/include/openjpeg-2.5" \
        USE_SYSTEM_FREETYPE=yes \
        USE_SYSTEM_LIBJPEG=yes \
        USE_SYSTEM_OPENJPEG=yes \
        USE_SYSTEM_LCMS2=yes \
        USE_SYSTEM_ZLIB=yes \
        libs

    out_dir="$(find build -maxdepth 3 -name libmupdf.a -printf '%h\n' \
        2>/dev/null | head -n1)"
    if [ -z "${out_dir}" ]; then
        echo "mupdf: libmupdf.a not found anywhere under build/; aborting." >&2
        exit 1
    fi
    cp "${out_dir}/libmupdf.a"       "${WASM_PREFIX}/lib/"
    cp "${out_dir}/libmupdf-third.a" "${WASM_PREFIX}/lib/"
    # Wipe the previous version's headers before re-installing — otherwise
    # MuPDF symbols removed upstream linger and may be #included by mistake.
    rm -rf "${WASM_PREFIX}/include/mupdf"
    cp -r include/mupdf              "${WASM_PREFIX}/include/"
    printf '%s\n' "${MUPDF_SOURCE_FINGERPRINT}" > "${MUPDF_SOURCE_STAMP}"
fi

# ---- Phase 3: link the renderer wasm --------------------------------------
mkdir -p "${OUT}/mupdf"

PKG_DEPS="freetype2 libopenjp2 libjpeg lcms2 zlib"
CFLAGS="$(renderer_pkg_cflags ${PKG_DEPS})"
LIBS="$(renderer_pkg_libs ${PKG_DEPS}) -lmupdf -lmupdf-third"

em++ -o "${OUT}/mupdf/mupdf.js" \
    "${ROOT}/src/mupdf/renderer.cpp" \
    --std=c++20 \
    ${CFLAGS} \
    -I"${ROOT}/src/common" \
    ${LIBS} \
    $(renderer_emcc_flags "${MUPDF_EH_MODE}") \
    -s EXPORT_NAME="'MupdfRenderer'" \
    -s NO_FILESYSTEM=1 \
    -s EXPORTED_FUNCTIONS='["_render","_num_pages","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","writeArrayToMemory"]' \
    -DNDEBUG \
    -flto \
    -O3 -msimd128 -msse -fno-exceptions \
    --js-library "${ROOT}/src/common/myjs.js"

finalize_renderer_output "${OUT}/mupdf/mupdf.js"

cat > "${OUT}/mupdf/source.json" <<EOF
{
  "name": "mupdf",
  "repo": "https://github.com/ArtifexSoftware/mupdf.git",
  "ref": "${MUPDF_REF}",
  "commit": "${MUPDF_COMMIT}",
  "fingerprint": "${MUPDF_SOURCE_FINGERPRINT}"
}
EOF
