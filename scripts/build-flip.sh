#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the FLIP image-diff wasm. Standalone, no shared deps with the PDF
# renderers; the input is two RGBA buffers, the output is a magma heatmap +
# scalar mean FLIP error.
#
# Outputs: ${OUT}/flip/flip.{js,wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

FLIP_REF="${FLIP_REF:-HEAD}"
FLIP_SRC="${SRC_DIR}/flip"

clone_pinned "${FLIP_SRC}" https://github.com/NVlabs/flip.git "${FLIP_REF}"
FLIP_COMMIT="$(git -C "${FLIP_SRC}" rev-parse HEAD)"

mkdir -p "${OUT}/flip"

em++ -o "${OUT}/flip/flip.js" \
    "${ROOT}/src/flip/diff.cpp" \
    --std=c++20 \
    -I"${FLIP_SRC}/src/cpp" \
    $(renderer_emcc_flags) \
    -s EXPORT_NAME="'Flip'" \
    -s EXPORTED_FUNCTIONS='["_flip_compare","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","writeArrayToMemory"]' \
    -DNDEBUG \
    -O3 -fno-exceptions -flto -Wno-unknown-pragmas

finalize_renderer_output "${OUT}/flip/flip.js"

cat > "${OUT}/flip/source.json" <<EOF
{
  "name": "flip",
  "repo": "https://github.com/NVlabs/flip.git",
  "ref": "${FLIP_REF}",
  "commit": "${FLIP_COMMIT}",
  "fingerprint": "${FLIP_COMMIT}"
}
EOF
