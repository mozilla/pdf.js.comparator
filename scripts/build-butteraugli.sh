#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the butteraugli image-diff wasm. Standalone, no shared deps with the
# PDF renderers; the input is two RGBA buffers, the output is a heatmap +
# scalar score.
#
# Outputs: ${OUT}/butteraugli/butteraugli.{js,wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

BUTTERAUGLI_REF="${BUTTERAUGLI_REF:-HEAD}"
BUTTERAUGLI_SRC="${SRC_DIR}/butteraugli"

clone_pinned "${BUTTERAUGLI_SRC}" \
    https://github.com/google/butteraugli.git "${BUTTERAUGLI_REF}"
BUTTERAUGLI_COMMIT="$(git -C "${BUTTERAUGLI_SRC}" rev-parse HEAD)"

mkdir -p "${OUT}/butteraugli"

em++ -o "${OUT}/butteraugli/butteraugli.js" \
    "${ROOT}/src/butteraugli/diff.cpp" \
    "${BUTTERAUGLI_SRC}/butteraugli/butteraugli.cc" \
    --std=c++20 \
    -I"${BUTTERAUGLI_SRC}" \
    $(renderer_emcc_flags) \
    -s EXPORT_NAME="'Butteraugli'" \
    -s EXPORTED_FUNCTIONS='["_butteraugli_compare","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","writeArrayToMemory"]' \
    -DNDEBUG \
    -O3 -fno-exceptions -flto

finalize_renderer_output "${OUT}/butteraugli/butteraugli.js"

cat > "${OUT}/butteraugli/source.json" <<EOF
{
  "name": "butteraugli",
  "repo": "https://github.com/google/butteraugli.git",
  "ref": "${BUTTERAUGLI_REF}",
  "commit": "${BUTTERAUGLI_COMMIT}",
  "fingerprint": "butteraugli=${BUTTERAUGLI_COMMIT}"
}
EOF
