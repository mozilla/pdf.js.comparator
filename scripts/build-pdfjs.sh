#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build pdf.js from source: clone mozilla/pdf.js, npm install, gulp dist,
# copy the resulting dist artifacts to ${OUT}/pdfjs/.
#
# Outputs:
#   ${OUT}/pdfjs/pdf.mjs               — main module
#   ${OUT}/pdfjs/pdf.worker.mjs        — worker
#   ${OUT}/pdfjs/wasm/                 — wasm decoders (openjpeg, …)
#   ${OUT}/pdfjs/cmaps/                — CJK character maps
#   ${OUT}/pdfjs/standard_fonts/       — PDF base-14 font fallbacks
#   ${OUT}/pdfjs/iccs/                 — standard ICC profiles
#
# Override which pdf.js to build via PDFJS_REF=<branch|tag|commit>.
# Default tracks mozilla/pdf.js master.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

. "${HERE}/build-deps.sh"

PDFJS_REF="${PDFJS_REF:-${PDFJS_TAG:-master}}"
PDFJS_SRC="${SRC_DIR}/pdfjs"

clone_pinned "${PDFJS_SRC}" https://github.com/mozilla/pdf.js.git "${PDFJS_REF}"
cd "${PDFJS_SRC}"
PDFJS_COMMIT="$(git rev-parse HEAD)"

# --ignore-scripts skips canvas's native build (we only need pdf.js's gulp
# build, which doesn't import canvas — it's a test-only dep).
npm ci --no-audit --no-fund --ignore-scripts

# `gulp dist` lays out the npm-package contents in build/dist/.
npx --no-install gulp dist

# Stage the new dist into a temp dir so a partial failure can't wipe the
# previous good output before the new one is in place.
STAGE="$(mktemp -d -t pdfjs-stage.XXXXXX)"
trap 'rm -rf "${STAGE}"' EXIT
cp build/dist/build/pdf.mjs        "${STAGE}/"
cp build/dist/build/pdf.worker.mjs "${STAGE}/"
for sub in wasm cmaps standard_fonts iccs; do
    if [ -d "build/dist/${sub}" ]; then
        cp -r "build/dist/${sub}" "${STAGE}/"
    fi
done

cat > "${STAGE}/source.json" <<EOF
{
  "name": "pdfjs",
  "repo": "https://github.com/mozilla/pdf.js.git",
  "ref": "${PDFJS_REF}",
  "commit": "${PDFJS_COMMIT}",
  "fingerprint": "${PDFJS_COMMIT}"
}
EOF

mkdir -p "${OUT}/pdfjs"
rm -rf "${OUT}/pdfjs"/*
mv "${STAGE}"/* "${OUT}/pdfjs/"

echo "pdfjs: dist written to ${OUT}/pdfjs/ (${PDFJS_COMMIT})"
