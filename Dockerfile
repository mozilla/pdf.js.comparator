# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# syntax=docker/dockerfile:1.7
#
# Multi-stage build. Layout:
#
#   base ──── deps ────┬── cairo
#       │              ├── pdfium
#       │              └── mupdf
#       ├── xpdf
#       ├── butteraugli (no shared-libs dep)
#       ├── flip (no shared-libs dep)
#       ├── gs / pdfjs (download-only)
#       ├── java-base ─── icepdf
#       ├── java-base ─── pdfbox
#       │
#       └── rust-base ─── dssim
#
#                                final  ←  COPY --from each sibling
#
# Each per-renderer stage is independent of the others — BuildKit builds
# them in parallel, a failure in one doesn't discard the others' cached
# work, and editing src/<one>/renderer.cpp invalidates only that stage.

# ---- Base: tooling --------------------------------------------------------
# Use the floating `:latest` tag so we automatically pick up the newest
# Ubuntu base, which is what carries a meson >= 1.3 (cairo requires it).
# Pinning a specific emsdk regressed meson to 0.61 from Ubuntu 22.04.
# The matching .github/actions/setup-emsdk also resolves `latest`.
FROM emscripten/emsdk:latest AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build meson pkg-config \
        autoconf automake libtool gperf python3 git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV WASM_PREFIX=/emsdk/upstream/emscripten/cache/sysroot \
    SRC_DIR=/src \
    OUT=/js \
    PKG_CONFIG_PATH=/emsdk/upstream/emscripten/cache/sysroot/lib/pkgconfig \
    PKG_CONFIG_LIBDIR=/emsdk/upstream/emscripten/cache/sysroot/lib/pkgconfig

# ---- Shared deps ----------------------------------------------------------
# Heavy one-shot step: zlib → libpng → freetype → libjpeg → openjpeg →
# lcms2 → pixman → cairo → poppler. Inherited by every renderer that
# needs them; invalidated when build-deps.sh or synced source args change.
FROM base AS deps
ARG CAIRO_TAG
ARG POPPLER_TAG
COPY scripts/build-deps.sh /code/scripts/
RUN CAIRO_TAG="${CAIRO_TAG}" POPPLER_TAG="${POPPLER_TAG}" \
    bash -c '. /code/scripts/build-deps.sh && \
    ensure_zlib && ensure_libpng && ensure_freetype && \
    ensure_libjpeg && ensure_openjpeg && ensure_lcms2 && \
    ensure_pixman && ensure_cairo && ensure_poppler'

# ---- Rust toolchain (only the dssim stage needs it) -----------------------
FROM base AS rust-base
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo \
    PATH=/opt/rust/cargo/bin:/emsdk/upstream/bin:/emsdk:/emsdk/upstream/emscripten:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
            --target wasm32-unknown-unknown >/dev/null && \
    cargo install --locked --version ^0.13 wasm-pack >/dev/null

# Java tooling for rebuilding source-only browser jars.
FROM base AS java-base
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-21-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/*

# ---- Per-renderer sibling stages ------------------------------------------
# Each runs its own build-<name>.sh against the shared sysroot. Because
# they FROM the same `deps`/`base`, BuildKit can fan them out in parallel,
# and a failure in one leaves the others' cached layers intact.

FROM deps AS cairo
ARG CAIRO_TAG
ARG POPPLER_TAG
COPY scripts/build-deps.sh   /code/scripts/
COPY scripts/build-cairo.sh  /code/scripts/
COPY src/common              /code/src/common/
COPY src/cairo               /code/src/cairo/
RUN CAIRO_TAG="${CAIRO_TAG}" POPPLER_TAG="${POPPLER_TAG}" \
    bash /code/scripts/build-cairo.sh

FROM deps AS pdfium
ARG PDFIUM_REF
ARG FAST_FLOAT_REF
ARG ABSEIL_TAG
ARG PDFIUM_CACHE_BUST
COPY scripts/build-deps.sh    /code/scripts/
COPY scripts/build-pdfium.sh  /code/scripts/
COPY src/common               /code/src/common/
COPY src/pdfium               /code/src/pdfium/
RUN echo "pdfium ref=${PDFIUM_REF} fast_float=${FAST_FLOAT_REF} abseil=${ABSEIL_TAG} cache=${PDFIUM_CACHE_BUST}" && \
    PDFIUM_REF="${PDFIUM_REF}" FAST_FLOAT_REF="${FAST_FLOAT_REF}" ABSEIL_TAG="${ABSEIL_TAG}" \
    bash /code/scripts/build-pdfium.sh

FROM deps AS mupdf
ARG MUPDF_REF
ARG MUPDF_CACHE_BUST
COPY scripts/build-deps.sh   /code/scripts/
COPY scripts/build-mupdf.sh  /code/scripts/
COPY src/common              /code/src/common/
COPY src/mupdf               /code/src/mupdf/
RUN echo "mupdf ref=${MUPDF_REF} cache=${MUPDF_CACHE_BUST}" && \
    MUPDF_REF="${MUPDF_REF}" bash /code/scripts/build-mupdf.sh

# Xpdf command-line tools built to wasm and driven via MEMFS.
FROM base AS xpdf
ARG XPDF_VERSION
ARG XPDF_CACHE_BUST
COPY scripts/build-deps.sh  /code/scripts/
COPY scripts/build-xpdf.sh  /code/scripts/
RUN echo "xpdf version=${XPDF_VERSION} cache=${XPDF_CACHE_BUST}" && \
    XPDF_VERSION="${XPDF_VERSION}" bash /code/scripts/build-xpdf.sh

# butteraugli has no shared-libs dependency, but sources build-deps.sh for
# its shared emcc-flag/finalize/clone_pinned helpers.
FROM base AS butteraugli
ARG BUTTERAUGLI_REF
ARG BUTTERAUGLI_CACHE_BUST
COPY scripts/build-deps.sh        /code/scripts/
COPY scripts/build-butteraugli.sh /code/scripts/
COPY src/butteraugli              /code/src/butteraugli/
RUN echo "butteraugli ref=${BUTTERAUGLI_REF} cache=${BUTTERAUGLI_CACHE_BUST}" && \
    BUTTERAUGLI_REF="${BUTTERAUGLI_REF}" bash /code/scripts/build-butteraugli.sh

# FLIP has no shared-libs dependency, but sources build-deps.sh for helpers.
FROM base AS flip
ARG FLIP_REF
ARG FLIP_CACHE_BUST
COPY scripts/build-deps.sh /code/scripts/
COPY scripts/build-flip.sh /code/scripts/
COPY src/flip              /code/src/flip/
RUN echo "flip ref=${FLIP_REF} cache=${FLIP_CACHE_BUST}" && \
    FLIP_REF="${FLIP_REF}" bash /code/scripts/build-flip.sh

# Ghostscript wasm: download the Emscripten CLI package.
FROM base AS gs
ARG GS_WASM_ESM_VERSION
ARG GS_CACHE_BUST
COPY scripts/build-gs.sh /code/scripts/
RUN echo "gs version=${GS_WASM_ESM_VERSION} cache=${GS_CACHE_BUST}" && \
    GS_WASM_ESM_VERSION="${GS_WASM_ESM_VERSION}" bash /code/scripts/build-gs.sh

# pdf.js dist build — needs Node (bundled in the emsdk base) + git.
# Source: mozilla/pdf.js; output is the npm-package layout at /js/pdfjs/.
FROM base AS pdfjs
ARG PDFJS_REF
ARG PDFJS_CACHE_BUST
COPY scripts/build-deps.sh  /code/scripts/
COPY scripts/build-pdfjs.sh /code/scripts/
RUN echo "pdf.js ref=${PDFJS_REF} cache=${PDFJS_CACHE_BUST}" && \
    PDFJS_REF="${PDFJS_REF}" bash /code/scripts/build-pdfjs.sh

# PDFBox: download the pdfbox-app.jar and build CheerpJ compatibility patches.
FROM java-base AS pdfbox
ARG PDFBOX_VERSION
ARG PDFBOX_CACHE_BUST
COPY scripts/build-pdfbox.sh /code/scripts/
RUN echo "pdfbox version=${PDFBOX_VERSION} cache=${PDFBOX_CACHE_BUST}" && \
    PDFBOX_VERSION="${PDFBOX_VERSION}" bash /code/scripts/build-pdfbox.sh

# ICEpdf: download the jar set and build small CheerpJ compatibility patches.
FROM java-base AS icepdf
ARG ICEPDF_VERSION
ARG BOUNCYCASTLE_VERSION
ARG TWELVEMONKEYS_VERSION
ARG ICEPDF_PDFBOX_VERSION
ARG JBIG2_IMAGEIO_VERSION
ARG JAI_IMAGEIO_CORE_VERSION
ARG JAI_IMAGEIO_JPEG2000_VERSION
ARG COMMONS_LOGGING_VERSION
ARG ICEPDF_CACHE_BUST
COPY scripts/build-icepdf.sh /code/scripts/
RUN echo "icepdf version=${ICEPDF_VERSION} cache=${ICEPDF_CACHE_BUST}" && \
    ICEPDF_VERSION="${ICEPDF_VERSION}" \
    BOUNCYCASTLE_VERSION="${BOUNCYCASTLE_VERSION}" \
    TWELVEMONKEYS_VERSION="${TWELVEMONKEYS_VERSION}" \
    PDFBOX_VERSION="${ICEPDF_PDFBOX_VERSION}" \
    JBIG2_IMAGEIO_VERSION="${JBIG2_IMAGEIO_VERSION}" \
    JAI_IMAGEIO_CORE_VERSION="${JAI_IMAGEIO_CORE_VERSION}" \
    JAI_IMAGEIO_JPEG2000_VERSION="${JAI_IMAGEIO_JPEG2000_VERSION}" \
    COMMONS_LOGGING_VERSION="${COMMONS_LOGGING_VERSION}" \
    bash /code/scripts/build-icepdf.sh

# dssim is Rust-only.
FROM rust-base AS dssim
ARG DSSIM_CORE_VERSION
ARG DSSIM_CACHE_BUST
COPY scripts/build-dssim.sh /code/scripts/
RUN echo "dssim-core version=${DSSIM_CORE_VERSION} cache=${DSSIM_CACHE_BUST}" && \
    DSSIM_CORE_VERSION="${DSSIM_CORE_VERSION}" bash /code/scripts/build-dssim.sh

# ---- Final: static site + wasm bundles -----------------------------------
# Small nginx-based image with explicit module/wasm MIME types for
# `build.js --serve`. No build tooling is carried into the final image; if you
# need to rebuild, change source and rerun `docker build`, which fans back out
# to the sibling stages. Pinned to a stable nginx release so the deploy
# image is reproducible.
FROM nginx:1.27-alpine AS final
WORKDIR /www
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY harness.html /www/index.html
COPY harness.html /www/harness.html
COPY workers      /www/workers
COPY --from=cairo       /js/cairo       /www/out/cairo
COPY --from=pdfium      /js/pdfium      /www/out/pdfium
COPY --from=mupdf       /js/mupdf       /www/out/mupdf
COPY --from=butteraugli /js/butteraugli /www/out/butteraugli
COPY --from=dssim       /js/dssim       /www/out/dssim
COPY --from=flip        /js/flip        /www/out/flip
COPY --from=pdfjs       /js/pdfjs       /www/out/pdfjs
COPY --from=pdfbox      /js/pdfbox      /www/out/pdfbox
COPY --from=gs          /js/gs          /www/out/gs
COPY --from=xpdf        /js/xpdf        /www/out/xpdf
COPY --from=icepdf      /js/icepdf      /www/out/icepdf
EXPOSE 8000
