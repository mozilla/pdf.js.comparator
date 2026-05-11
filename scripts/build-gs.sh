#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Fetch a browser-ready Ghostscript wasm bundle. The harness runs it as a
# CLI-style Emscripten module in workers/cli-renderer-worker.js.
#
# Outputs:
#   ${OUT}/gs/gs.{mjs,wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"

GS_WASM_ESM_VERSION="${GS_WASM_ESM_VERSION:-1.0.1}"
BASE_URL="https://cdn.jsdelivr.net/npm/ghostscript-wasm-esm@${GS_WASM_ESM_VERSION}"

mkdir -p "${OUT}/gs"
curl -fSL -o "${OUT}/gs/gs.mjs" "${BASE_URL}/gs.mjs"
curl -fSL -o "${OUT}/gs/gs.wasm" "${BASE_URL}/gs.wasm"
curl -fSL -o "${OUT}/gs/LICENSE" "${BASE_URL}/LICENSE"

chmod ugo-x "${OUT}/gs/gs.wasm"
echo "gs: ${OUT}/gs/gs.mjs + gs.wasm ($(du -h "${OUT}/gs/gs.wasm" | cut -f1))"

cat > "${OUT}/gs/source.json" <<EOF
{
  "name": "ghostscript",
  "package": "ghostscript-wasm-esm",
  "version": "${GS_WASM_ESM_VERSION}",
  "fingerprint": "ghostscript-wasm-esm=${GS_WASM_ESM_VERSION}"
}
EOF
