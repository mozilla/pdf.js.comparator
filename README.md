<!-- SPDX-License-Identifier: MIT  Copyright (c) 2026 Mozilla Foundation -->

# pdf.js.comparator

<!-- Per-workflow CI badges. GitHub doesn't aggregate; this strip shows
     every per-renderer build at a glance. -->

[![cairo](https://github.com/mozilla/pdf.js.comparator/actions/workflows/cairo.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/cairo.yml)
[![splash](https://github.com/mozilla/pdf.js.comparator/actions/workflows/splash.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/splash.yml)
[![pdfium](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfium.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfium.yml)
[![mupdf](https://github.com/mozilla/pdf.js.comparator/actions/workflows/mupdf.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/mupdf.yml)
[![pdfjs](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfjs.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfjs.yml)
[![pdfbox](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfbox.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/pdfbox.yml)
[![icepdf](https://github.com/mozilla/pdf.js.comparator/actions/workflows/icepdf.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/icepdf.yml)
[![ghostscript](https://github.com/mozilla/pdf.js.comparator/actions/workflows/gs.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/gs.yml)
[![xpdf](https://github.com/mozilla/pdf.js.comparator/actions/workflows/xpdf.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/xpdf.yml)
[![butteraugli](https://github.com/mozilla/pdf.js.comparator/actions/workflows/butteraugli.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/butteraugli.yml)
[![dssim](https://github.com/mozilla/pdf.js.comparator/actions/workflows/dssim.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/dssim.yml)
[![flip](https://github.com/mozilla/pdf.js.comparator/actions/workflows/flip.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/flip.yml)
[![deploy](https://github.com/mozilla/pdf.js.comparator/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/mozilla/pdf.js.comparator/actions/workflows/deploy.yml)

Side-by-side visual comparison of pdf.js against multiple reference PDF
renderers — **cairo** (poppler+cairo), **splash** (poppler's in-tree
software rasterizer), **pdfium**, **mupdf**, **PDFBox**, **Ghostscript**,
**Xpdf**, and **ICEpdf** — with six image-diff algorithms
layered on top.

**[Open the live harness ›](https://mozilla.github.io/pdf.js.comparator/)** — pulls in whichever wasm bundles you tick and runs everything in the browser; no install needed.

Each renderer is one independent browser artifact, loaded in its own Web
Worker. Native renderers use wasm, Java renderers run through CheerpJ, and
CLI-style renderers run through MEMFS. The harness drops down to whichever
renderers you ticked, runs them in parallel, and lays the rendered pages out
beside each other plus pair-wise diff cards (pixelmatch / Resemble / SSIM /
butteraugli / DSSIM / FLIP).

## Layout

```
scripts/
  build-deps.sh          # ensure_zlib, ensure_libpng, … (idempotent)
  build-cairo.sh         # ensure_* + final em++ link → out/cairo/cairo.{js,wasm}
  build-splash.sh        # poppler+Splash (no cairo) → out/splash/splash.{js,wasm}
  build-pdfium.sh        # … → out/pdfium/pdfium.{js,wasm}
  build-mupdf.sh         # … → out/mupdf/mupdf.{js,wasm}
  build-gs.sh            # fetch Ghostscript wasm → out/gs/
  build-xpdf.sh          # Xpdf pdftoppm/pdfinfo → out/xpdf/
  build-pdfbox.sh        # fetch PDFBox jar + CheerpJ patches → out/pdfbox/
  build-icepdf.sh        # fetch ICEpdf jars + CheerpJ patches → out/icepdf/
  build-butteraugli.sh   # standalone → out/butteraugli/butteraugli.{js,wasm}
  build-dssim.sh         # Rust → out/dssim/dssim.{js,_bg.wasm}
  build-flip.sh          # standalone → out/flip/flip.{js,wasm}
src/
  common/{render_api.h, myjs.js}
  cairo/renderer.cpp
  splash/renderer.cpp
  pdfium/renderer.cpp
  mupdf/renderer.cpp
  butteraugli/diff.cpp
  flip/diff.cpp
workers/
  renderer-worker.js     # generic; ?wasm=<name> picks the bundle
  cli-renderer-worker.js # Ghostscript / Xpdf CLI wasm modules
  icepdf-worker.js       # ICEpdf under CheerpJ
  pdfbox-worker.js       # PDFBox under CheerpJ
  diff-worker.js         # owns butteraugli + dssim + FLIP wasms
  java-error.js          # shared CheerpJ-error unwrap (importScripts'd)
harness.html             # the viewer
.github/workflows/       # one yml per wasm + a deploy yml
```

Each shared library (zlib / libpng / freetype / libjpeg / openjpeg /
lcms2 / pixman / cairo / poppler) lives in `scripts/build-deps.sh` as an
`ensure_*` function that early-exits if its sentinel artifact is already
in `${WASM_PREFIX}/lib`. The first renderer-build script to need a dep
builds it; the rest skip.

## Build

### Local, via Docker

```sh
node build.js -Cc                       # build all, extract to ./out/
node build.js -Cc -t cairo              # build & extract one renderer
node build.js -Cc --no-cache            # force a clean rebuild
```

The Dockerfile is multi-stage:

```
base ──── deps ────┬── cairo
    │              ├── pdfium
    │              └── mupdf
    ├── splash (own cairo-less poppler)
    ├── butteraugli (no shared-libs dep)
    ├── flip (no shared-libs dep)
    │
    ├── xpdf
    ├── gs
    ├── java-base ─── pdfbox
    ├── java-base ─── icepdf
    └── rust-base ─── dssim
                                                final  ←  COPY --from each sibling
```

Each per-renderer stage is a sibling — BuildKit fans them out in parallel,
a failure in one leaves the others' cached layers intact, and editing
`src/cairo/renderer.cpp` only invalidates the cairo stage (not pdfium /
mupdf / butteraugli / dssim / FLIP / xpdf / the Java renderers).

The `final` stage is `FROM nginx:1.27-alpine` and carries the static viewer plus the
browser artifacts under `/www`. `node build.js -c` extracts the artifacts
via `docker create` + `docker cp`; `node build.js --serve` runs the same
image with nginx.

### Directly, on a Linux machine with emsdk + Rust

Every script works standalone provided `emcc`, `wasm-pack`, `javac`, `jar`,
`pkg-config`, `meson`, `cmake`, `ninja`, `autoconf` are on `PATH`. This is
what the per-renderer GitHub Actions runners do — see
`.github/workflows/*.yml`.

```sh
OUT=$PWD/out SRC_DIR=$PWD/.build-src bash scripts/build-cairo.sh
```

## Run the viewer

```sh
python3 -m http.server 8000
# open http://localhost:8000/harness.html
```

The harness defaults to fetching wasms from `./out/<name>/`. To point at
a different host (e.g. the gh-pages deployment), append `?base=<url>`.

Or serve directly from the Docker image:

```sh
node build.js --create --serve --port 8000
# open http://localhost:8000/harness.html
```

If that port is already taken, either pass another one (`--port 8001`) or
stop the existing container/server first.

## CI / publishing

The gh-pages branch is assembled by **two independent kinds of workflow**.
Configure GitHub Pages to serve from the `gh-pages` branch root.

`.github/workflows/deploy.yml` is the lightweight harness deployer. On
pushes to `main` that touch `harness.html`, `workers/**`, `build.js`,
`eslint.config.mjs`, `src/common/**`, or the deploy workflow itself, it
runs `npm run lint` + `npm run format:check`, then publishes
`index.html` / `harness.html` / `workers/` at the gh-pages root via the
local `publish-to-gh-pages` action with keep_files semantics. It does
**not** rebuild any renderer — the heavy wasm/JAR builds belong to the
per-renderer workflows, which each publish under their own subpath.

Each per-renderer workflow drives one renderer end-to-end (resolve
upstream → build → publish to `gh-pages/out/<name>/`). They share the
reusable `_renderer.yml`. Scheduled runs skip when the source.json
fingerprint matches gh-pages; manual, push, and `repository_dispatch`
runs always rebuild.

| Workflow          | Source resolution                                                   |
| ----------------- | ------------------------------------------------------------------- |
| `cairo.yml`       | newest `cairo` `X.Y.Z` tag + newest `poppler-X.Y.Z` tag             |
| `splash.yml`      | newest `poppler-X.Y.Z` tag (poppler-only; no cairo backend)         |
| `pdfium.yml`      | `pdfium`, `abseil`, `fast_float` all track HEAD (`PDFIUM_REF=main`) |
| `mupdf.yml`       | newest `X.Y.Z` tag from `git ls-remote` (override with `MUPDF_REF`) |
| `xpdf.yml`        | pinned xpdf version (the upstream cert chain breaks live scrape)    |
| `butteraugli.yml` | upstream HEAD                                                       |
| `flip.yml`        | upstream HEAD                                                       |
| `gs.yml`          | latest `ghostscript-wasm-esm` on npm                                |
| `pdfbox.yml`      | latest `org.apache.pdfbox:pdfbox-app` on Maven Central              |
| `icepdf.yml`      | latest ICEpdf jar set + direct Maven dependency versions            |
| `dssim.yml`       | latest `dssim-core` crate                                           |
| `pdfjs.yml`       | mozilla/pdf.js `master`                                             |

pdf.js is intentionally rolling: `scripts/build-pdfjs.sh` defaults to
`PDFJS_REF=master`, writes the resolved upstream commit to
`out/pdfjs/source.json`, and `pdfjs.yml` polls every four hours. Scheduled
runs publish only when the upstream commit differs from the one currently
on `gh-pages`. For exact per-commit updates, wire a webhook or small relay
to dispatch `pdfjs-master` to this repository when `mozilla/pdf.js` master
advances.

The script defaults are still pinned for deterministic local builds.
Workflows pass the resolved upstream versions through `$GITHUB_ENV`
(see `scripts/resolve-upstream.mjs`).

## Licensing

| Component                    | License                                           |
| ---------------------------- | ------------------------------------------------- |
| poppler                      | GPL-2.0+                                          |
| pdfium                       | Apache-2.0 / BSD-3                                |
| **MuPDF**                    | **AGPL-3.0** (or commercial license from Artifex) |
| cairo                        | LGPL-2.1 / MPL-1.1                                |
| pixman                       | MIT                                               |
| freetype                     | FTL / GPL-2.0                                     |
| libpng                       | libpng (BSD-like)                                 |
| libjpeg-turbo                | IJG / BSD-3                                       |
| openjpeg                     | BSD-2                                             |
| lcms2                        | MIT                                               |
| zlib                         | zlib                                              |
| butteraugli                  | Apache-2.0                                        |
| dssim                        | AGPL-3.0 / commercial                             |
| FLIP                         | BSD-3                                             |
| PDFBox                       | Apache-2.0                                        |
| Ghostscript                  | AGPL-3.0 / commercial                             |
| Xpdf                         | GPL-2.0 / GPL-3.0                                 |
| ICEpdf                       | Apache-2.0                                        |
| JAI ImageIO / JPEG2000       | BSD-3-like with Sun notice / JJ2000               |
| This repository's own source | MIT (see [LICENSE](LICENSE))                      |

This repository's own source — the wrappers in `src/`, all of `workers/`,
`scripts/`, `build.js`, `harness.html`, the Dockerfile, and the workflow
files — is MIT-licensed. See [LICENSE](LICENSE).

The wasm/JAR bundles produced at build time, however, inherit the license of
the renderer they include — `mupdf.wasm` is AGPL-3.0, `cairo.wasm` is
GPL-2.0+ (from poppler), `gs.wasm` is AGPL-3.0, and so on. The harness loads
each renderer as a separate runtime artifact, so the deployed site as a
whole is also constrained by the strongest copyleft among the bundles a
visitor actually fetches. Toggling MuPDF / DSSIM / Ghostscript off leaves
the cairo + pdfium subset, whose floor is GPL-2.0+ (from poppler).
Distributing the produced binaries still requires complying with each
upstream's license terms; changing this repository's source license does
not change that.
