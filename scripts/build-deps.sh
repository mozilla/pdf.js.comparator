#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation

# Source this from per-renderer build scripts. Each `ensure_*` function:
# - Skips work when the sentinel artifact in ${WASM_PREFIX}/lib is present
#   AND its sibling .stamp file matches the currently-pinned tag — i.e.
#   bumping a *_TAG env var triggers a rebuild on the next run.
# - Otherwise clones the dep into ${SRC_DIR}/<name> and builds + installs
#   into ${WASM_PREFIX} via emscripten.
#
# It also exposes a few helpers used by the per-renderer build scripts:
#   clone_pinned <dir> <repo> <ref>      shallow-fetch any ref (branch, tag,
#                                        or commit) and detach HEAD on it
#   renderer_pkg_cflags / renderer_pkg_libs
#                                        pkg-config wrappers stripping -pthread
#   renderer_emcc_flags                  prints the shared em++ flag set used
#                                        by every renderer wasm
#   finalize_renderer_output <js>        chmod the sibling .wasm + prepend a
#                                        GENERATED banner to the .js

set -euo pipefail

# In the docker build the base image sets EMSDK=/emsdk and WASM_PREFIX is
# overridden via ENV. On a CI runner (or local non-docker invocation), our
# setup-emsdk action sets EMSDK to a workspace-relative path; fall back to
# its sysroot so we don't try to write into a root-owned /emsdk directory.
if [ -z "${WASM_PREFIX:-}" ]; then
    if [ -n "${EMSDK:-}" ]; then
        WASM_PREFIX="${EMSDK}/upstream/emscripten/cache/sysroot"
    else
        WASM_PREFIX="${SRC_DIR:-/src}/.wasm-sysroot"
    fi
fi
SRC_DIR="${SRC_DIR:-/src}"
PKG_CONFIG_PATH="${WASM_PREFIX}/lib/pkgconfig"
PKG_CONFIG_LIBDIR="${WASM_PREFIX}/lib/pkgconfig"
export PKG_CONFIG_PATH PKG_CONFIG_LIBDIR

# Pinned upstream revisions. Each ensure_* records the tag it built into a
# .stamp file next to the produced library, so bumping a *_TAG triggers a
# rebuild (no more "wipe ${WASM_PREFIX} by hand" caveat).
ZLIB_TAG="${ZLIB_TAG:-v1.3.1}"
LIBPNG_TAG="${LIBPNG_TAG:-v1.6.43}"
FREETYPE_TAG="${FREETYPE_TAG:-VER-2-13-3}"
LIBJPEG_TURBO_TAG="${LIBJPEG_TURBO_TAG:-3.0.4}"
OPENJPEG_TAG="${OPENJPEG_TAG:-v2.5.2}"
LCMS2_TAG="${LCMS2_TAG:-lcms2.16}"
PIXMAN_TAG="${PIXMAN_TAG:-pixman-0.44.0}"
CAIRO_TAG="${CAIRO_TAG:-1.18.2}"
POPPLER_TAG="${POPPLER_TAG:-poppler-24.10.0}"

mkdir -p "${SRC_DIR}" "${WASM_PREFIX}"

# Detect macOS so a tasteless `nproc` doesn't crash local builds.
_nproc() {
    if command -v nproc >/dev/null; then nproc
    else getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4
    fi
}

# Returns 0 if <lib>'s sentinel exists AND its stamp matches <tag>.
stamp_is_fresh() {
    local lib="$1" tag="$2"
    [ -f "${lib}" ] || return 1
    [ "$(cat "${lib}.stamp" 2>/dev/null || true)" = "${tag}" ]
}
stamp_write() {
    printf '%s\n' "$2" > "$1.stamp"
}

# Reusable git fetch idiom: works for branches, tags, and bare commits, and
# recovers from a half-cloned tree.
clone_pinned() {
    local dir="$1" repo="$2" ref="$3"
    if [ ! -d "${dir}/.git" ]; then
        mkdir -p "${dir}"
        git -C "${dir}" init -q
        git -C "${dir}" remote add origin "${repo}"
    fi
    git -C "${dir}" fetch --depth 1 origin "${ref}"
    git -C "${dir}" checkout --force --detach FETCH_HEAD
    git -C "${dir}" clean -ffd
}

# Meson cross file for pixman + cairo (both meson-only). Written once,
# reused by ensure_pixman and ensure_cairo.
ensure_meson_cross_file() {
    local f=/opt/emscripten-cross.ini
    [ -f "${f}" ] && return 0
    mkdir -p "$(dirname "${f}")"
    cat > "${f}" <<'EOF'
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
strip = 'emstrip'
pkg-config = 'pkg-config'

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF
}

ensure_zlib() {
    local lib="${WASM_PREFIX}/lib/libz.a"
    stamp_is_fresh "${lib}" "${ZLIB_TAG}" && return 0
    cd "${SRC_DIR}"
    [ -d zlib ] || git clone --depth 1 --branch "${ZLIB_TAG}" \
        https://github.com/madler/zlib.git
    cd zlib
    make distclean 2>/dev/null || true
    emconfigure ./configure --static --prefix="${WASM_PREFIX}"
    emmake make -j"$(_nproc)" install
    stamp_write "${lib}" "${ZLIB_TAG}"
}

ensure_libpng() {
    local lib="${WASM_PREFIX}/lib/libpng.a"
    stamp_is_fresh "${lib}" "${LIBPNG_TAG}" && return 0
    ensure_zlib
    cd "${SRC_DIR}"
    [ -d libpng ] || git clone --depth 1 --branch "${LIBPNG_TAG}" \
        https://github.com/pnggroup/libpng.git
    cd libpng
    rm -rf build
    emcmake cmake -G Ninja -B build \
        -DCMAKE_INSTALL_PREFIX="${WASM_PREFIX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DPNG_SHARED=OFF -DPNG_STATIC=ON \
        -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
        -DPNG_HARDWARE_OPTIMIZATIONS=OFF
    cmake --build build --target install
    stamp_write "${lib}" "${LIBPNG_TAG}"
}

ensure_freetype() {
    local lib="${WASM_PREFIX}/lib/libfreetype.a"
    stamp_is_fresh "${lib}" "${FREETYPE_TAG}" && return 0
    ensure_zlib
    ensure_libpng
    cd "${SRC_DIR}"
    [ -d freetype ] || git clone --depth 1 --branch "${FREETYPE_TAG}" \
        https://gitlab.freedesktop.org/freetype/freetype.git
    cd freetype
    rm -rf build
    emcmake cmake -G Ninja -B build \
        -DCMAKE_INSTALL_PREFIX="${WASM_PREFIX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DFT_DISABLE_HARFBUZZ=ON \
        -DFT_DISABLE_BROTLI=ON \
        -DFT_DISABLE_BZIP2=ON \
        -DFT_REQUIRE_ZLIB=ON \
        -DFT_REQUIRE_PNG=ON
    cmake --build build --target install
    stamp_write "${lib}" "${FREETYPE_TAG}"
}

ensure_libjpeg() {
    local lib="${WASM_PREFIX}/lib/libjpeg.a"
    stamp_is_fresh "${lib}" "${LIBJPEG_TURBO_TAG}" && return 0
    cd "${SRC_DIR}"
    [ -d libjpeg-turbo ] || git clone --depth 1 --branch "${LIBJPEG_TURBO_TAG}" \
        https://github.com/libjpeg-turbo/libjpeg-turbo.git
    cd libjpeg-turbo
    rm -rf build
    emcmake cmake -G Ninja -B build \
        -DCMAKE_INSTALL_PREFIX="${WASM_PREFIX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
        -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF
    cmake --build build --target install
    stamp_write "${lib}" "${LIBJPEG_TURBO_TAG}"
}

ensure_openjpeg() {
    local lib="${WASM_PREFIX}/lib/libopenjp2.a"
    stamp_is_fresh "${lib}" "${OPENJPEG_TAG}" && return 0
    cd "${SRC_DIR}"
    [ -d openjpeg ] || git clone --depth 1 --branch "${OPENJPEG_TAG}" \
        https://github.com/uclouvain/openjpeg.git
    cd openjpeg
    rm -rf build
    emcmake cmake -G Ninja -B build \
        -DCMAKE_INSTALL_PREFIX="${WASM_PREFIX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_CODEC=OFF -DBUILD_DOC=OFF \
        -DBUILD_TESTING=OFF -DBUILD_PKGCONFIG_FILES=ON
    cmake --build build --target install
    stamp_write "${lib}" "${OPENJPEG_TAG}"
}

ensure_lcms2() {
    local lib="${WASM_PREFIX}/lib/liblcms2.a"
    stamp_is_fresh "${lib}" "${LCMS2_TAG}" && return 0
    cd "${SRC_DIR}"
    [ -d lcms2 ] || git clone --depth 1 --branch "${LCMS2_TAG}" \
        https://github.com/mm2/Little-CMS.git lcms2
    cd lcms2
    make distclean 2>/dev/null || true
    ./autogen.sh
    emconfigure ./configure --prefix="${WASM_PREFIX}" \
        --disable-shared --enable-static \
        --without-jpeg --without-tiff
    emmake make -j"$(_nproc)" install
    stamp_write "${lib}" "${LCMS2_TAG}"
}

ensure_pixman() {
    local lib="${WASM_PREFIX}/lib/libpixman-1.a"
    stamp_is_fresh "${lib}" "${PIXMAN_TAG}" && return 0
    ensure_meson_cross_file
    cd "${SRC_DIR}"
    [ -d pixman ] || git clone --depth 1 --branch "${PIXMAN_TAG}" \
        https://gitlab.freedesktop.org/pixman/pixman.git
    cd pixman
    rm -rf build
    meson setup build \
        --cross-file=/opt/emscripten-cross.ini \
        --prefix="${WASM_PREFIX}" \
        --buildtype=release \
        --default-library=static \
        -Dtests=disabled -Ddemos=disabled \
        -Dmmx=disabled -Dsse2=disabled -Dssse3=disabled \
        -Dvmx=disabled -Darm-simd=disabled -Dneon=disabled \
        -Da64-neon=disabled -Dloongson-mmi=disabled \
        -Dmips-dspr2=disabled -Dgnu-inline-asm=disabled
    meson install -C build
    stamp_write "${lib}" "${PIXMAN_TAG}"
}

ensure_cairo() {
    local lib="${WASM_PREFIX}/lib/libcairo.a"
    stamp_is_fresh "${lib}" "${CAIRO_TAG}" && return 0
    ensure_meson_cross_file
    ensure_zlib
    ensure_libpng
    ensure_freetype
    ensure_pixman
    cd "${SRC_DIR}"
    [ -d cairo ] || git clone --depth 1 --branch "${CAIRO_TAG}" \
        https://gitlab.freedesktop.org/cairo/cairo.git
    cd cairo
    # util/cairo-script builds csi-* test execs that meson links with
    # -pthread, which forces emscripten into shared-memory mode and
    # conflicts with our single-threaded libpng/zlib. Skip the whole subdir.
    # Guard the patch so re-runs after a stamp bump don't re-sed an already-
    # patched meson.build.
    if grep -q "^subdir('util')" meson.build; then
        sed -i "/subdir(.util.)/d" meson.build
    fi
    rm -rf build
    meson setup build \
        --cross-file=/opt/emscripten-cross.ini \
        --prefix="${WASM_PREFIX}" \
        --buildtype=release \
        --default-library=static \
        -Dpng=enabled -Dzlib=enabled -Dfreetype=enabled \
        -Dfontconfig=disabled \
        -Dxlib=disabled -Dxcb=disabled \
        -Dquartz=disabled \
        -Dtee=disabled \
        -Dsymbol-lookup=disabled \
        -Dtests=disabled -Dgtk_doc=false \
        -Dspectre=disabled -Dglib=disabled
    meson install -C build
    stamp_write "${lib}" "${CAIRO_TAG}"
}

ensure_poppler() {
    local lib="${WASM_PREFIX}/lib/libpoppler.a"
    stamp_is_fresh "${lib}" "${POPPLER_TAG}" && return 0
    ensure_zlib
    ensure_libpng
    ensure_freetype
    ensure_libjpeg
    ensure_openjpeg
    ensure_lcms2
    ensure_pixman
    ensure_cairo
    cd "${SRC_DIR}"
    [ -d poppler ] || git clone --depth 1 --branch "${POPPLER_TAG}" \
        https://gitlab.freedesktop.org/poppler/poppler.git
    cd poppler
    rm -rf build
    emcmake cmake -G Ninja -B build \
        -DCMAKE_INSTALL_PREFIX="${WASM_PREFIX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DENABLE_UNSTABLE_API_ABI_HEADERS=ON \
        -DENABLE_BOOST=OFF \
        -DENABLE_CPP=OFF \
        -DENABLE_GLIB=OFF \
        -DENABLE_GOBJECT_INTROSPECTION=OFF \
        -DENABLE_QT5=OFF -DENABLE_QT6=OFF \
        -DENABLE_UTILS=OFF \
        -DENABLE_GTK_DOC=OFF \
        -DBUILD_GTK_TESTS=OFF -DBUILD_QT5_TESTS=OFF \
        -DBUILD_QT6_TESTS=OFF -DBUILD_CPP_TESTS=OFF \
        -DBUILD_MANUAL_TESTS=OFF \
        -DENABLE_LIBOPENJPEG=openjpeg2 \
        -DENABLE_DCTDECODER=libjpeg \
        -DENABLE_LIBTIFF=OFF \
        -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF \
        -DENABLE_LIBCURL=OFF \
        -DFONT_CONFIGURATION=generic \
        -DRUN_GPERF_IF_PRESENT=OFF
    cmake --build build --target install
    stamp_write "${lib}" "${POPPLER_TAG}"
}

# Common em++ link flags / pkg-config helpers used by every renderer's
# final link step. Sourced by callers; they invoke them after their renderer
# sources are picked.

renderer_pkg_cflags() {
    pkg-config --cflags "$@" | sed 's/-pthread//g'
}
renderer_pkg_libs() {
    pkg-config --static --libs "$@" | sed 's/-pthread//g'
}

# Shared em++ flag set used by every renderer/diff wasm. Per-renderer
# scripts append source files, EXPORT_NAME, EXPORTED_FUNCTIONS, and any
# CFLAGS/LIBS from pkg-config.
renderer_emcc_flags() {
    cat <<'EOF'
-s ALLOW_MEMORY_GROWTH=1
-s MAXIMUM_MEMORY=2GB
-s WASM=1
-s MODULARIZE=1
-s WASM_ASYNC_COMPILATION=1
-s EXPORT_ES6=1
-s SINGLE_FILE=0
-s ENVIRONMENT=web,worker
-s ERROR_ON_UNDEFINED_SYMBOLS=1
-s NO_EXIT_RUNTIME=1
-s MALLOC=emmalloc
-s ASSERTIONS=0
EOF
}

# Postprocess the produced .js + .wasm: drop the +x bit on the wasm (npm/
# git would otherwise mark it executable), and prepend a generated-file
# banner to the .js so editors don't tempt anyone into patching it.
finalize_renderer_output() {
    local js="$1"
    local wasm="${js%.js}.wasm"
    if [ -f "${wasm}" ]; then
        chmod a-x "${wasm}"
    fi
    sed -i '1 i\/* THIS FILE IS GENERATED - DO NOT EDIT */' "${js}"
}
