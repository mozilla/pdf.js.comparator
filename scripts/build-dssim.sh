#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Build the DSSIM image-diff wasm. Rust-based; uses wasm-pack rather than
# emcc so it stands alone from the PDF-renderer toolchain.
#
# Outputs: ${OUT}/dssim/dssim.{js,_bg.wasm}

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-/src}"

DSSIM_CORE_VERSION="${DSSIM_CORE_VERSION:-${DSSIM_TAG:-3.4.0}}"

if ! command -v wasm-pack >/dev/null; then
    echo "wasm-pack not found in PATH" >&2
    exit 1
fi

# Wrapper crate: a thin compare(a, b, w, h) that wraps dssim-core. Lives
# under SRC_DIR rather than ROOT so it doesn't pollute the repo source.
# Versioned dir name so bumping DSSIM_CORE_VERSION can't reuse a stale
# Cargo.lock from a previous build.
DSSIM_WRAPPER="${SRC_DIR}/dssim-wasm-${DSSIM_CORE_VERSION}"
mkdir -p "${DSSIM_WRAPPER}/src"
cat > "${DSSIM_WRAPPER}/Cargo.toml" <<EOF
[package]
name = "dssim-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
dssim-core = "${DSSIM_CORE_VERSION}"
imgref = "1"
rgb = "0.8"
wasm-bindgen = "0.2"

[profile.release]
opt-level = "s"
lto = true
EOF
cat > "${DSSIM_WRAPPER}/src/lib.rs" <<'EOF'
use dssim_core::{Dssim, RGBAPLU};
use imgref::ImgVec;
use rgb::Rgba;
use wasm_bindgen::prelude::*;

fn to_dssim_image(buf: &[u8], width: usize, height: usize) -> ImgVec<RGBAPLU> {
    let pixels: Vec<Rgba<u8>> = buf
        .chunks_exact(4)
        .map(|c| Rgba::new(c[0], c[1], c[2], c[3]))
        .collect();
    let img = ImgVec::new(pixels, width, height);
    img.map_buf(|buf| {
        buf.iter()
            .map(|p| RGBAPLU {
                r: (p.r as f32 / 255.0).powf(2.2) * (p.a as f32 / 255.0),
                g: (p.g as f32 / 255.0).powf(2.2) * (p.a as f32 / 255.0),
                b: (p.b as f32 / 255.0).powf(2.2) * (p.a as f32 / 255.0),
                a: p.a as f32 / 255.0,
            })
            .collect()
    })
}

#[wasm_bindgen]
pub struct DssimResult {
    score: f64,
    map: Vec<u8>,
}

#[wasm_bindgen]
impl DssimResult {
    #[wasm_bindgen(getter)]
    pub fn score(&self) -> f64 { self.score }
    #[wasm_bindgen(getter)]
    pub fn heatmap(self) -> Vec<u8> { self.map }
}

#[wasm_bindgen]
pub fn compare(a: &[u8], b: &[u8], width: usize, height: usize)
    -> Result<DssimResult, JsError>
{
    if a.len() != width * height * 4 || b.len() != width * height * 4 {
        return Err(JsError::new("buffer size doesnt match width*height*4"));
    }
    let mut dssim = Dssim::new();
    dssim.set_save_ssim_maps(1);

    let img_a = dssim.create_image(&to_dssim_image(a, width, height))
        .ok_or_else(|| JsError::new("create_image(a) failed"))?;
    let img_b = dssim.create_image(&to_dssim_image(b, width, height))
        .ok_or_else(|| JsError::new("create_image(b) failed"))?;
    let (val, maps) = dssim.compare(&img_a, &img_b);

    let mut heatmap = vec![0u8; width * height * 4];
    const BOOST: f32 = 30.0;
    if let Some(map) = maps.first() {
        let mw = map.map.width();
        let mh = map.map.height();
        let buf = map.map.buf();
        for y in 0..height {
            for x in 0..width {
                let mx = (x * mw) / width;
                let my = (y * mh) / height;
                let v = buf[my * mw + mx];
                let dissim = (1.0 - v.clamp(0.0, 1.0)).max(0.0);
                let g = ((dissim * BOOST).min(1.0) * 255.0) as u8;
                let i = (y * width + x) * 4;
                heatmap[i + 0] = g;
                heatmap[i + 1] = g;
                heatmap[i + 2] = g;
                heatmap[i + 3] = 255;
            }
        }
    }
    Ok(DssimResult { score: val.into(), map: heatmap })
}
EOF

# Stage into a tempdir so a partial wasm-pack failure can't wipe the
# previous good output (wasm-pack writes its own package.json etc.).
STAGE="$(mktemp -d -t dssim-stage.XXXXXX)"
trap 'rm -rf "${STAGE}"' EXIT
cd "${DSSIM_WRAPPER}"
wasm-pack build --release --target web --out-dir "${STAGE}" --out-name dssim

mkdir -p "${OUT}/dssim"
rm -rf "${OUT}/dssim"/*
mv "${STAGE}"/* "${OUT}/dssim/"

# Record the Cargo.lock hash separately for forensic purposes. We can't
# include it in `fingerprint` because the resolver doesn't run cargo and
# therefore can't know what Cargo.lock would hash to, so any value here
# would guarantee a mismatch and rebuild on every cron tick. The crate
# version is what the resolver knows, so that's what gates the rebuild.
LOCK_HASH="$(sha256sum "${DSSIM_WRAPPER}/Cargo.lock" | awk '{print $1}')"

cat > "${OUT}/dssim/source.json" <<EOF
{
  "name": "dssim",
  "crate": "dssim-core",
  "version": "${DSSIM_CORE_VERSION}",
  "lock_sha256": "${LOCK_HASH}",
  "fingerprint": "dssim-core=${DSSIM_CORE_VERSION}"
}
EOF
