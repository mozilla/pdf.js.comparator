// Browser-friendly diff libraries. The heavier wasm diffs run in
// workers so they don't block page rendering.
import pixelmatch from "https://esm.sh/pixelmatch@7";
import resemble from "https://esm.sh/resemblejs@5";
import { ssim } from "https://esm.sh/ssim.js@3";

// Minimal request/response wrapper around worker messages.
const spawn = (url, { module = true } = {}) => {
  const worker = new Worker(url, module ? { type: "module" } : undefined);
  const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Lazy workers may fail before anyone awaits `ready`.
  ready.catch(() => {});
  worker.addEventListener("message", (e) => {
    if (e.data.type === "ready") {
      resolveReady();
      return;
    }
    if (e.data.type === "init-error") {
      rejectReady(new Error(e.data.error));
      return;
    }
    const { id, payload, error } = e.data;
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    if (error) cb.reject(new Error(error));
    else cb.resolve(payload);
  });
  worker.addEventListener("error", (e) => {
    const err = e.error || new Error(e.message || "worker error");
    // Reject `ready` (no-op if already settled) and every in-flight
    // call. Without this, runtime worker errors leave pending calls
    // hanging forever — the renderer cards never resolve.
    rejectReady(err);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });
  return {
    ready,
    call: async (type, payload, transfers = []) => {
      await ready; // throws if init failed; caller catches it
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload }, transfers);
      });
    },
    // Kill the worker and reject anything still in flight. Used to drop a
    // worker whose wasm runtime aborted (see namedWorkerGetter.drop) so
    // it can be replaced by a fresh instance.
    terminate: () => {
      const err = new Error("worker terminated");
      rejectReady(err);
      for (const { reject } of pending.values()) reject(err);
      pending.clear();
      worker.terminate();
    },
  };
};

// Absolute base URL for wasm/pdf.js artifacts. Override with ?base=URL.
const BASE = new URL(
  new URL(window.location.href).searchParams.get("base") || "./out",
  window.location.href,
).href;
const WORKER_VERSION = "2026-05-11-java-error-iife";
const withVersion = (href, version) => {
  const url = new URL(href, window.location.href);
  url.searchParams.set("v", version);
  return url.href;
};
const artifactVersion = async (name) => {
  try {
    const url = new URL(`${BASE}/${name}/source.json`, window.location.href);
    url.searchParams.set("t", Date.now());
    const response = await fetch(url.href, { cache: "no-store" });
    if (response.ok) {
      const source = await response.json();
      return (
        source.fingerprint || source.commit || source.version || WORKER_VERSION
      );
    }
  } catch {
    // Older local builds may not have source.json files.
  }
  return WORKER_VERSION;
};
// Cache the per-renderer fingerprint so each spawned worker can load
// a wasm bundle that matches the source.json currently on disk —
// bumping a renderer publish busts only that renderer's cache.
const artifactVersionCache = new Map();
const cachedArtifactVersion = (name) => {
  if (!artifactVersionCache.has(name)) {
    artifactVersionCache.set(name, artifactVersion(name));
  }
  return artifactVersionCache.get(name);
};
const workerUrl = (script, params = {}, version = WORKER_VERSION) =>
  `./workers/${script}?${new URLSearchParams({
    ...params,
    base: BASE,
    v: version,
  })}`;

// Keep the pdf.js main module and worker from the same build.
const PDFJS_BASE = `${BASE}/pdfjs`;
const PDFJS_VERSION = await artifactVersion("pdfjs");
const pdfjsLib = await import(
  withVersion(`${PDFJS_BASE}/pdf.mjs`, PDFJS_VERSION)
);
pdfjsLib.GlobalWorkerOptions.workerSrc = withVersion(
  `${PDFJS_BASE}/pdf.worker.mjs`,
  PDFJS_VERSION,
);

// Renderer workers are spawned lazily, one instance per engine.
// Each worker's URL embeds both the worker-code version (so editing
// workers/*.js busts the cache) and the per-renderer artifact
// fingerprint (so republishing the wasm busts it too). The combined
// string flows through to the worker's inner imports — wasm modules,
// render-result-transport.js, java-error.js — so they all invalidate
// together when either source changes.
const CLI_RENDERERS = ["gs", "xpdf"];
const workerVersionFor = async (name) =>
  `${WORKER_VERSION}-${await cachedArtifactVersion(name)}`;
const namedWorkerGetter = (script, rendererParam, workerOptions = {}) => {
  const cache = new Map();
  const get = (name) => {
    if (!cache.has(name)) {
      cache.set(
        name,
        (async () =>
          spawn(
            workerUrl(
              script,
              { [rendererParam]: name },
              await workerVersionFor(name),
            ),
            workerOptions,
          ))(),
      );
    }
    return cache.get(name);
  };
  // Forget a cached worker (terminating it) so the next get() spawns a
  // fresh module. Recovers from a renderer that crashed its wasm runtime
  // — e.g. an xpdf out-of-bounds trap — which would otherwise keep
  // failing on every subsequent render through the same aborted module.
  get.drop = (name) => {
    const entry = cache.get(name);
    if (!entry) return;
    cache.delete(name);
    entry.then((w) => w.terminate()).catch(() => {});
  };
  return get;
};
const getRendererWorker = namedWorkerGetter("renderer-worker.js", "wasm");
const getCliRendererWorker = namedWorkerGetter(
  "cli-renderer-worker.js",
  "renderer",
);

// CheerpJ workers are classic workers, not ES module workers.
let pdfboxWorker = null;
const getPdfboxWorker = async () => {
  if (!pdfboxWorker) {
    pdfboxWorker = spawn(
      workerUrl("pdfbox-worker.js", {}, await workerVersionFor("pdfbox")),
      { module: false },
    );
  }
  return pdfboxWorker;
};
getPdfboxWorker.drop = () => {
  const w = pdfboxWorker;
  pdfboxWorker = null;
  w?.terminate();
};
const DIFF_WASMS = ["butteraugli", "dssim", "flip"];
const diffWorkers = Object.fromEntries(
  await Promise.all(
    DIFF_WASMS.map(async (name) => [
      name,
      spawn(
        workerUrl(
          "diff-worker.js",
          { wasm: name },
          await workerVersionFor(name),
        ),
      ),
    ]),
  ),
);

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const dom = {
  antialias: $("antialias"),
  compareA: $("compare-a"),
  compareB: $("compare-b"),
  diffs: $("diffs"),
  dpi: $("dpi"),
  file: $("file"),
  page: $("page"),
  pages: $("pages"),
  renders: $("renders"),
  status: $("status"),
  transparent: $("transparent"),
};

const el = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
};
const setStatus = (msg, err = false) => {
  dom.status.textContent = msg;
  dom.status.classList.toggle("err", err);
};
const errorMessage = (err) => err?.message || String(err);
// Hard reset of the output area — used when a new PDF is loaded (or
// loading fails), where there's nothing worth keeping. Re-renders of the
// same PDF instead reconcile the existing cards in place (see
// createRenderSlots / renderDiffs) so the page height — and the scroll
// position — stay stable.
const clearOutput = () => {
  renderSlots.clear();
  dom.renders.replaceChildren();
  dom.diffs.replaceChildren();
};
const setDisplaySize = (node, width, height, dpr) => {
  node.style.width = `${width / dpr}px`;
  node.style.height = `${height / dpr}px`;
};
const createCanvas = (width, height, dpr) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  setDisplaySize(canvas, width, height, dpr);
  return canvas;
};
const wrapCanvas = (canvas) => {
  const wrap = el("div", "canvas-wrap");
  wrap.appendChild(canvas);
  return wrap;
};

// Per-renderer placeholder cards. Reserved when a render starts so the
// user sees one slot per selected engine (with a spinner) instead of
// a blank area, then swapped in-place as each engine finishes — or
// flipped to a failed state when its worker rejects.
const renderSlots = new Map();
// (Re)set a card to its loading skeleton, reusing the element so an
// in-flight or failed slot is never duplicated.
const fillRenderSkeleton = (card, name) => {
  card.className = "render skeleton";
  card.dataset.renderer = name;
  const h3 = el("h3");
  const row = el("span", "render-row");
  row.appendChild(el("span", "spinner"));
  row.appendChild(document.createTextNode(rendererLabel(name)));
  h3.appendChild(row);
  card.replaceChildren(h3, el("div", "canvas-wrap", "loading…"));
};
const makeRenderSkeleton = (name) => {
  const card = el("div");
  fillRenderSkeleton(card, name);
  return card;
};
const createRenderSlots = (names) => {
  const wanted = new Set(names);
  // Drop cards for renderers that are no longer selected.
  for (const [name, card] of renderSlots) {
    if (!wanted.has(name)) {
      card.remove();
      renderSlots.delete(name);
    }
  }
  // Reuse a card that already holds a rendered canvas — keep that canvas
  // on screen (marked "refreshing") while the new render is in flight,
  // rather than collapsing it back to a skeleton. Tearing the cards down
  // would shrink the page and make the browser reset the scroll
  // position; renderers with no prior result fall back to the skeleton.
  let prev = null;
  for (const name of names) {
    let card = renderSlots.get(name);
    if (!card) {
      // No card yet — create a fresh skeleton.
      card = makeRenderSkeleton(name);
      renderSlots.set(name, card);
    } else if (card.querySelector("canvas")) {
      // Prior result present — keep it visible (dimmed) while the new
      // render is in flight.
      card.classList.remove("failed");
      card.classList.add("refreshing");
    } else if (!card.classList.contains("skeleton")) {
      // Card exists but has no canvas (a previous failure). Reset it to a
      // skeleton in place — reusing the element so we never leave a
      // duplicate card behind for an in-flight/failed renderer.
      fillRenderSkeleton(card, name);
    }
    const ref = prev ? prev.nextSibling : dom.renders.firstChild;
    if (ref !== card) dom.renders.insertBefore(card, ref);
    prev = card;
  }
};
const fillRenderSlot = (name, h3Text, canvas) => {
  let slot = renderSlots.get(name);
  if (!slot) {
    slot = el("div", "render");
    slot.dataset.renderer = name;
    dom.renders.appendChild(slot);
    renderSlots.set(name, slot);
  }
  slot.classList.remove("skeleton", "failed", "refreshing");
  slot.replaceChildren(el("h3", "", h3Text), wrapCanvas(canvas));
};
const failRenderSlot = (name, err) => {
  const slot = renderSlots.get(name);
  if (!slot) return;
  slot.classList.remove("skeleton", "refreshing");
  slot.classList.add("failed");
  slot.replaceChildren(
    el("h3", "", `${rendererLabel(name)} — failed`),
    el("div", "canvas-wrap", errorMessage(err)),
  );
};

// Placeholder diff pair shown while renderers are still in flight —
// so the comparison area is visible (with a "waiting for renderers…"
// badge) from the moment a render starts, instead of popping in only
// after the slowest renderer finishes. renderDiffs() later replaces
// it with the real progress bar + skeleton cards.
const showDiffWaiting = () => {
  const compareA = dom.compareA.value;
  const compareB = dom.compareB.value;
  const label = `${rendererLabel(compareA)} ↔ ${rendererLabel(compareB)}`;
  const existing = dom.diffs.querySelector(".pair");
  if (existing) {
    // Keep the previous diff result on screen (marked stale) instead of
    // collapsing the area to a placeholder — that holds the page height,
    // and the scroll position, steady while the new render is in flight.
    existing.classList.add("refreshing");
    const h2 = existing.querySelector("h2");
    if (h2) h2.textContent = label;
    setDiffBadge(existing, "waiting for renderers…");
    return;
  }
  const pair = el("div", "pair");
  const head = el("div", "pair-head");
  head.appendChild(el("h2", "", label));
  pair.appendChild(head);
  setDiffBadge(pair, "waiting for renderers…");
  dom.diffs.replaceChildren(pair);
};

const pdfjsDocumentOptions = (data) => ({
  data,
  verbosity: 0,
  // Use the same auxiliary data a production pdf.js viewer would.
  wasmUrl: `${PDFJS_BASE}/wasm/`,
  cMapUrl: `${PDFJS_BASE}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
  iccUrl: `${PDFJS_BASE}/iccs/`,
});

const openPdfjsDocument = async (data) => {
  const loadingTask = pdfjsLib.getDocument(pdfjsDocumentOptions(data));
  try {
    return {
      doc: await loadingTask.promise,
      loadingTask,
    };
  } catch (err) {
    if (typeof loadingTask.destroy === "function") {
      await loadingTask.destroy();
    }
    throw err;
  }
};

const destroyPdfjsDocument = async (doc, loadingTask) => {
  if (typeof doc.destroy === "function") {
    await doc.destroy();
  } else if (typeof loadingTask?.destroy === "function") {
    await loadingTask.destroy();
  } else if (typeof doc.cleanup === "function") {
    await doc.cleanup();
  }
};

const getPdfjsPageCount = async (sourcePdfBytes) => {
  const dataCopy = sourcePdfBytes.slice();
  const { doc, loadingTask } = await openPdfjsDocument(dataCopy);
  try {
    return doc.numPages || 0;
  } finally {
    await destroyPdfjsDocument(doc, loadingTask);
  }
};

const renderPdfjsAfterOperatorList = async (pdfPage, renderParams) => {
  const originalRenderPageChunk = pdfPage._renderPageChunk;
  if (typeof originalRenderPageChunk !== "function") {
    await pdfPage.render(renderParams).promise;
    return;
  }

  let operatorListComplete = false;
  let pendingContinue = null;
  const flushPendingContinue = () => {
    if (!operatorListComplete || !pendingContinue) {
      return;
    }
    const continueRendering = pendingContinue;
    pendingContinue = null;
    continueRendering();
  };

  // For stable captures, wait for the full operator list before drawing.
  pdfPage._renderPageChunk = function (operatorListChunk, intentState) {
    if (operatorListChunk?.lastChunk) {
      try {
        return originalRenderPageChunk.call(
          this,
          operatorListChunk,
          intentState,
        );
      } finally {
        operatorListComplete = true;
        flushPendingContinue();
      }
    }

    const renderTasks = intentState?.renderTasks;
    if (!renderTasks?.size) {
      return originalRenderPageChunk.call(this, operatorListChunk, intentState);
    }

    intentState.renderTasks = new Set();
    try {
      return originalRenderPageChunk.call(this, operatorListChunk, intentState);
    } finally {
      intentState.renderTasks = renderTasks;
    }
  };

  try {
    const renderTask = pdfPage.render(renderParams);
    renderTask.onContinue = (continueRendering) => {
      if (operatorListComplete) {
        continueRendering();
        return;
      }
      pendingContinue = continueRendering;
    };
    await renderTask.promise;
  } finally {
    pdfPage._renderPageChunk = originalRenderPageChunk;
  }
};

const renderPdfjs = async (pdfBytes, page, dpi, transparent) => {
  // pdf.js transfers and detaches its input buffer.
  const dataCopy = pdfBytes.slice();
  const { doc, loadingTask } = await openPdfjsDocument(dataCopy);
  try {
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!transparent) {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await renderPdfjsAfterOperatorList(pdfPage, {
      canvasContext: ctx,
      viewport,
      canvas,
    });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const view = pdfPage.view; // [x1, y1, x2, y2] in pt
    return {
      renderer: "pdfjs",
      width: canvas.width,
      height: canvas.height,
      data: img.data,
      page_width_pt: view[2] - view[0],
      page_height_pt: view[3] - view[1],
    };
  } finally {
    await destroyPdfjsDocument(doc, loadingTask);
  }
};

// Main-thread diff backends. Wasm diffs use `runWasmDiffs`.
const COMPARATORS = [
  {
    name: "pixelmatch",
    run: (a, b) => {
      const { width, height } = a;
      const diff = new Uint8ClampedArray(width * height * 4);
      const n = pixelmatch(a.data, b.data, diff, width, height, {
        threshold: 0.1,
        includeAA: false,
      });
      const pct = ((n / (width * height)) * 100).toFixed(2);
      return { label: `${n} px diff (${pct}%)`, diffPixels: diff };
    },
  },
  {
    name: "resemblejs",
    run: (a, b) =>
      new Promise((resolve) => {
        const ia = new ImageData(a.data, a.width, a.height);
        const ib = new ImageData(b.data, b.width, b.height);
        resemble(ia)
          .compareTo(ib)
          .ignoreAntialiasing()
          .onComplete((d) => {
            resolve({
              label: `${parseFloat(d.misMatchPercentage).toFixed(2)}% mismatch`,
              diffURL: d.getImageDataUrl(),
            });
          });
      }),
  },
  {
    name: "ssim.js",
    run: (a, b) => {
      const r = ssim(
        { width: a.width, height: a.height, data: a.data },
        { width: b.width, height: b.height, data: b.data },
      );
      return { label: `MSSIM = ${r.mssim.toFixed(4)}` };
    },
  },
];

// Short docs surfaced in the hover tooltip on each diff card's "?" icon,
// so a viewer can tell what each metric measures without leaving the page.
const DIFF_DOCS = {
  pixelmatch:
    "Pixel-by-pixel comparison (Mapbox pixelmatch). Counts pixels whose colour differs beyond a perceptual threshold, ignoring antialiasing; the diff image highlights those pixels. Readout: differing-pixel count and percentage.",
  resemblejs:
    "Resemble.js comparison. Reports a mismatch percentage and renders a diff image with the changed regions highlighted. Antialiasing differences are ignored.",
  "ssim.js":
    "Structural Similarity (SSIM): a perceptual metric modelling luminance, contrast and structure rather than raw pixel deltas. MSSIM is the mean over the image — 1.0000 = identical, lower = more different.",
  butteraugli:
    "Butteraugli (Google/libjxl) estimates the psychovisual difference between the two images — how noticeable a human would find it. Higher = more perceptible difference.",
  dssim:
    "DSSIM: a multi-scale, SSIM-based dissimilarity metric (Rust dssim-core). 0 = identical; the score grows with perceived difference, weighted toward what the eye actually notices.",
  flip: "NVIDIA ꟻLIP: a perceptual difference metric for rendered images, modelling what a viewer notices when alternating between the two. Produces an error map and a mean score — higher = more visible difference.",
};

// Diff card heading: the metric name on the left and, opposite it, a "?"
// help icon whose hover/focus tooltip documents what the metric means.
const diffCardHeading = (name, { spinner = false } = {}) => {
  const h3 = el("h3", "diff-head");
  const title = el("span", "diff-title");
  if (spinner) title.appendChild(el("span", "spinner"));
  title.appendChild(document.createTextNode(name));
  h3.appendChild(title);
  const doc = DIFF_DOCS[name];
  if (doc) {
    const help = el("span", "diff-help", "?");
    help.tabIndex = 0;
    help.setAttribute("role", "img");
    help.setAttribute("aria-label", `What ${name} measures`);
    help.appendChild(el("span", "diff-tip", doc));
    h3.appendChild(help);
  }
  return h3;
};

// Each wasm diff gets its own transferable copy of the image pair.
const runWasmDiffs = async (a, b) => {
  const cloneImg = (i) => ({
    renderer: i.renderer,
    width: i.width,
    height: i.height,
    data: new Uint8ClampedArray(i.data),
  });
  const results = await Promise.allSettled(
    DIFF_WASMS.map(async (name) => {
      const aCopy = cloneImg(a);
      const bCopy = cloneImg(b);
      return diffWorkers[name].call("diff", { a: aCopy, b: bCopy }, [
        aCopy.data.buffer,
        bCopy.data.buffer,
      ]);
    }),
  );
  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      name: DIFF_WASMS[index],
      error: result.reason?.message || String(result.reason),
    };
  });
};

const rendererLabel = (name) => (name === "pdfjs" ? "pdf.js" : name);
const rendererSummary = (images) =>
  images.map((img) => `${img.renderer} ${img.width}×${img.height}`).join(" + ");

const appendDiffMessage = (pair, className, text) => {
  pair.appendChild(el("div", className, text));
};

// Update (or create) the badge on the right of a pair's header without
// rebuilding the header, so the diff card can be reused in place.
const setDiffBadge = (pair, text, done = false) => {
  const head = pair.querySelector(".pair-head");
  if (!head) return;
  let badge = head.querySelector(".pair-badge");
  if (!badge) {
    badge = el("span", "pair-badge");
    head.appendChild(badge);
  }
  badge.classList.toggle("done", done);
  badge.replaceChildren();
  if (!done) badge.appendChild(el("span", "spinner"));
  badge.appendChild(document.createTextNode(text));
};

const cropImage = (img, width, height) => {
  if (img.width === width && img.height === height) {
    return img;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const srcStart = y * img.width * 4;
    data.set(img.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  return { ...img, width, height, data };
};

// Tiny dimension differences are usually renderer rounding noise.
const renderDiffs = async (
  images,
  dpr,
  myGen,
  myDiffGen,
  compareA,
  compareB,
) => {
  if (staleDiff(myGen, myDiffGen)) return;

  const pairLabel = `${rendererLabel(compareA)} ↔ ${rendererLabel(compareB)}`;

  // Reuse the existing pair (and its diff cards) so a prior result stays
  // visible while new diffs compute — rebuilding from scratch would
  // collapse the area and reset the scroll position.
  let pair = dom.diffs.querySelector(".pair");
  if (!pair) {
    pair = el("div", "pair");
    pair.appendChild(el("div", "pair-head"));
    dom.diffs.replaceChildren(pair);
  }
  pair.classList.remove("refreshing");
  const head = pair.querySelector(".pair-head");
  head.replaceChildren(el("h2", "", `${pairLabel} comparison`));
  setDiffBadge(pair, "computing diffs…");
  const headBadge = head.querySelector(".pair-badge");

  // Skipped states have no canvases worth keeping — clear everything
  // below the header and show the reason.
  const showSkip = (msg) => {
    while (head.nextSibling) head.nextSibling.remove();
    appendDiffMessage(pair, "diff-note", msg);
  };

  if (compareA === compareB) {
    showSkip("skipped — pick two different renderers");
    return;
  }

  let a = images.find((img) => img.renderer === compareA);
  let b = images.find((img) => img.renderer === compareB);
  if (!a || !b) {
    const missing = [!a ? compareA : null, !b ? compareB : null]
      .filter(Boolean)
      .map(rendererLabel);
    showSkip(`skipped — renderer not available: ${missing.join(", ")}`);
    return;
  }

  let croppedNote = null;
  if (a.width !== b.width || a.height !== b.height) {
    const widthDelta = Math.abs(a.width - b.width);
    const heightDelta = Math.abs(a.height - b.height);
    if (widthDelta > 2 || heightDelta > 2) {
      showSkip(
        `skipped — dimensions differ (${a.width}×${a.height} vs ${b.width}×${b.height})`,
      );
      return;
    }

    const width = Math.min(a.width, b.width);
    const height = Math.min(a.height, b.height);
    croppedNote = `cropped to ${width}×${height} for diff (${a.width}×${a.height} vs ${b.width}×${b.height})`;
    a = cropImage(a, width, height);
    b = cropImage(b, width, height);
  }

  const resetCard = (card, name) => {
    card.classList.remove("loading", "failed", "refreshing");
    card.replaceChildren(diffCardHeading(name));
  };
  const loadingCard = (card, name) => {
    card.classList.remove("failed");
    card.classList.add("loading");
    card.replaceChildren(
      diffCardHeading(name, { spinner: true }),
      el("div", "diff-placeholder", "computing…"),
    );
  };
  const failCard = (card, name, error) => {
    resetCard(card, name);
    card.classList.add("failed");
    card.appendChild(
      el("div", "diff-placeholder", error?.message || String(error)),
    );
  };
  const fillCard = (card, name, res, dt) => {
    resetCard(card, name);
    if (res.diffPixels) {
      const cv = createCanvas(a.width, a.height, dpr);
      cv.getContext("2d").putImageData(
        new ImageData(res.diffPixels, a.width, a.height),
        0,
        0,
      );
      card.appendChild(wrapCanvas(cv));
    } else if (res.diffURL) {
      const img = document.createElement("img");
      img.src = res.diffURL;
      img.className = "diff-image";
      setDisplaySize(img, a.width, a.height, dpr);
      card.appendChild(img);
    } else {
      card.appendChild(el("div", "ssim-readout", res.label));
    }
    card.appendChild(el("div", "", `${res.label} · ${dt.toFixed(0)} ms`));
  };

  const wasmDiffNames = DIFF_WASMS;
  const allNames = [...COMPARATORS.map((c) => c.name), ...wasmDiffNames];

  // Drop any stale note from a previous run; the cards row and progress
  // bar below are reused.
  pair
    .querySelectorAll(":scope > .diff-note, :scope > .diff-info")
    .forEach((n) => n.remove());

  // Reuse the cards row, keeping each card's previous diff result visible
  // (dimmed) until its replacement lands. Cards with nothing to keep
  // (first run, or a previously loading/failed card) show the skeleton.
  let row = pair.querySelector(".pair-row");
  if (!row) row = el("div", "pair-row");
  const cards = allNames.map((name) => {
    let card = row.querySelector(`.diff[data-diff="${name}"]`);
    if (card?.querySelector("canvas, img.diff-image, .ssim-readout")) {
      card.classList.remove("failed");
      card.classList.add("refreshing");
    } else {
      card = el("div", "diff");
      card.dataset.diff = name;
      loadingCard(card, name);
    }
    row.appendChild(card);
    return card;
  });

  // Progress bar (reused), sitting directly under the h2.
  let progress = pair.querySelector(".diff-progress");
  if (!progress) {
    progress = el("div", "diff-progress");
    progress.appendChild(el("div", "diff-progress-fill"));
  }
  progress.classList.remove("done");
  const progressFill = progress.querySelector(".diff-progress-fill");
  progressFill.style.width = "0%";

  // Order the reused/created pieces under the head: an optional "cropped"
  // note, then the progress bar, then the cards row.
  let anchor = head;
  if (croppedNote) {
    const info = el("div", "diff-info", croppedNote);
    pair.insertBefore(info, anchor.nextSibling);
    anchor = info;
  }
  if (anchor.nextSibling !== progress)
    pair.insertBefore(progress, anchor.nextSibling);
  anchor = progress;
  if (anchor.nextSibling !== row) pair.insertBefore(row, anchor.nextSibling);

  let diffDoneCount = 0;
  const diffStart = performance.now();
  const bumpDiffStatus = () => {
    diffDoneCount++;
    if (staleDiff(myGen, myDiffGen)) return;
    const pct = (diffDoneCount / allNames.length) * 100;
    progressFill.style.width = `${pct}%`;
    headBadge.replaceChildren();
    if (diffDoneCount >= allNames.length) {
      progress.classList.add("done");
      headBadge.classList.add("done");
      headBadge.textContent = `${allNames.length} diff${allNames.length === 1 ? "" : "s"} in ${(performance.now() - diffStart).toFixed(0)} ms`;
    } else {
      headBadge.appendChild(el("span", "spinner"));
      headBadge.appendChild(
        document.createTextNode(
          `computing diffs… ${diffDoneCount}/${allNames.length}`,
        ),
      );
    }
    setStatus(
      diffDoneCount < allNames.length
        ? `diffing ${pairLabel}: ${diffDoneCount}/${allNames.length} done`
        : `${pairLabel}: ${allNames.length} diff${allNames.length === 1 ? "" : "s"} ready`,
    );
  };
  setStatus(`diffing ${pairLabel}: 0/${allNames.length} done`);

  // Let the browser paint the skeleton cards before the synchronous
  // JS comparators (pixelmatch / ssim.js / resemble) start blocking
  // the main thread — otherwise the loading state never shows.
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  if (staleDiff(myGen, myDiffGen)) return;

  // JS comparators are CPU-bound on the main thread. Run them
  // serially with a frame yield before each so the progress bar
  // advances and each skeleton card has time to paint before its
  // comparator blocks the thread.
  const mainPromise = (async () => {
    for (let idx = 0; idx < COMPARATORS.length; idx++) {
      const cmp = COMPARATORS[idx];
      const card = cards[idx];
      await new Promise((r) => requestAnimationFrame(r));
      if (staleDiff(myGen, myDiffGen)) return;
      const t0 = performance.now();
      try {
        const res = await cmp.run(a, b);
        if (staleDiff(myGen, myDiffGen)) return;
        fillCard(card, cmp.name, res, performance.now() - t0);
      } catch (e) {
        if (staleDiff(myGen, myDiffGen)) return;
        failCard(card, cmp.name, e);
      } finally {
        bumpDiffStatus();
      }
    }
  })();

  // wasm diffs run in their own workers — fan out one call each so
  // the progress bar advances per diff instead of in one batch at
  // the end.
  const cloneImg = (i) => ({
    renderer: i.renderer,
    width: i.width,
    height: i.height,
    data: new Uint8ClampedArray(i.data),
  });
  const wasmPromises = wasmDiffNames.map(async (name) => {
    const idx = allNames.indexOf(name);
    if (idx < 0) return;
    const card = cards[idx];
    const aCopy = cloneImg(a);
    const bCopy = cloneImg(b);
    const t0 = performance.now();
    try {
      const r = await diffWorkers[name].call("diff", { a: aCopy, b: bCopy }, [
        aCopy.data.buffer,
        bCopy.data.buffer,
      ]);
      if (staleDiff(myGen, myDiffGen)) return;
      fillCard(card, name, r, r.time ?? performance.now() - t0);
    } catch (e) {
      if (staleDiff(myGen, myDiffGen)) return;
      failCard(card, name, e);
    } finally {
      bumpDiffStatus();
    }
  });

  await Promise.all([mainPromise, ...wasmPromises]);
};

let pdfBytes = null;

// Generation counters discard stale async render/diff work.
let renderGen = 0;
let diffGen = 0;
let lastRender = null;
let pageSizePtCache = new Map();
let autoDpi = true;
const stale = (gen) => gen !== renderGen;
const staleDiff = (gen, diff) => stale(gen) || diff !== diffGen;

const renderSelectedDiff = async () => {
  if (!lastRender || stale(lastRender.renderGen)) {
    // Renders haven't settled yet for the current generation — keep
    // the "waiting for renderers…" placeholder visible (and refresh
    // its labels if the user just switched the comparison pair).
    if (pdfBytes) {
      showDiffWaiting();
    } else {
      dom.diffs.replaceChildren();
    }
    return;
  }
  const myDiffGen = ++diffGen;
  await renderDiffs(
    lastRender.images,
    lastRender.dpr,
    lastRender.renderGen,
    myDiffGen,
    dom.compareA.value,
    dom.compareB.value,
  );
};

const getPageSizePt = async (pageNumber, sourcePdfBytes) => {
  if (pageSizePtCache.has(pageNumber)) {
    return pageSizePtCache.get(pageNumber);
  }

  const dataCopy = sourcePdfBytes.slice();
  const { doc, loadingTask } = await openPdfjsDocument(dataCopy);
  try {
    const pdfPage = await doc.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const size = { width: viewport.width, height: viewport.height };
    pageSizePtCache.set(pageNumber, size);
    return size;
  } finally {
    await destroyPdfjsDocument(doc, loadingTask);
  }
};

const updateAutoDpi = async (pageNumber, rendererCount, sourcePdfBytes) => {
  if (!autoDpi || !pdfBytes || rendererCount <= 0) {
    return;
  }

  const pageSize = await getPageSizePt(pageNumber, sourcePdfBytes);
  if (pdfBytes !== sourcePdfBytes) {
    return;
  }
  if (!Number.isFinite(pageSize.width) || pageSize.width <= 0) {
    return;
  }

  const renderStyle = getComputedStyle(dom.renders);
  const gap = parseFloat(renderStyle.columnGap || renderStyle.gap || "0") || 0;
  const borderPx = 2;
  const available =
    dom.renders.clientWidth ||
    dom.renders.getBoundingClientRect().width ||
    document.documentElement.clientWidth;
  const usable =
    available - gap * Math.max(0, rendererCount - 1) - borderPx * rendererCount;
  const targetCssWidth = Math.max(1, Math.floor(usable / rendererCount) - 2);
  const dpi = Math.max(
    1,
    Math.min(300, Math.floor((targetCssWidth * 72) / pageSize.width)),
  );
  dom.dpi.value = String(dpi);
};

const selectedRendererGroups = () => {
  const groups = {
    all: [],
    cli: [],
    pdfbox: false,
    pdfjs: false,
    wasm: [],
  };
  for (const cb of $$(".renderer:checked")) {
    const name = cb.value;
    groups.all.push(name);
    if (name === "pdfjs") groups.pdfjs = true;
    else if (name === "pdfbox") groups.pdfbox = true;
    else if (CLI_RENDERERS.includes(name)) groups.cli.push(name);
    else groups.wasm.push(name);
  }
  return groups;
};

const drawRenderedImage = (img, dpr) => {
  const canvas = createCanvas(img.width, img.height, dpr);
  const ctx = canvas.getContext("2d");
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    img.bitmap.close?.();
    delete img.bitmap;
  } else if (img.data) {
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  }
  return canvas;
};

const appendRenderedImage = ({ img, result, dpr, page, wanted, gen }) => {
  if (stale(gen) || !img) return;

  result.images.push(img);
  result.page_width_pt ??= img.page_width_pt;
  result.page_height_pt ??= img.page_height_pt;

  fillRenderSlot(
    img.renderer,
    `${img.renderer} — ${img.renderTime.toFixed(0)} ms`,
    drawRenderedImage(img, dpr),
  );

  const got = result.images.map((rendered) => rendered.renderer);
  const remaining = wanted.length - got.length;
  setStatus(
    remaining > 0
      ? `rendering page ${page}: ${got.length}/${wanted.length} ready — ${rendererSummary(result.images)}`
      : `page ${page}: ${rendererSummary(result.images)}`,
  );
};

const timedRender = async (name, render, appendImage, onError) => {
  const start = performance.now();
  try {
    const img = await render();
    appendImage({
      ...img,
      renderer: name,
      renderTime: performance.now() - start,
    });
  } catch (e) {
    console.error(`${name} render error:`, e);
    (onError || failRenderSlot)(name, e);
  }
};

const renderWorkerImage = (
  name,
  workerPromise,
  sourcePdfBytes,
  payload,
  appendImage,
  onError,
  dispose,
) =>
  timedRender(
    name,
    async () => {
      // `workerPromise` may be a Promise (cache-busted spawning is
      // async because it depends on artifactVersion fetch) or an
      // already-resolved worker handle. Awaiting both is fine.
      const worker = await workerPromise;
      const copy = sourcePdfBytes.slice();
      return worker.call("render", { ...payload, pdfBytes: copy }, [
        copy.buffer,
      ]);
    },
    appendImage,
    // A render failure may mean the worker's wasm runtime aborted and is
    // now unusable; drop it so the next render spawns a fresh one.
    (n, err) => {
      dispose?.();
      (onError || failRenderSlot)(n, err);
    },
  );

// Diff workers start eagerly; renderer workers remain lazy. Update
// the status pill as each one resolves so the user sees concrete
// progress instead of a stuck "loading wasm…".
setStatus(`loading diff engines (0/${DIFF_WASMS.length})…`);
let diffReadyCount = 0;
const diffReady = await Promise.allSettled(
  DIFF_WASMS.map((name) =>
    diffWorkers[name].ready.finally(() => {
      diffReadyCount++;
      setStatus(
        `loading diff engines (${diffReadyCount}/${DIFF_WASMS.length})…`,
      );
    }),
  ),
);
const failedDiffs = diffReady
  .map((result, index) =>
    result.status === "rejected" ? DIFF_WASMS[index] : null,
  )
  .filter(Boolean);
dom.file.disabled = false;
if (failedDiffs.length) {
  setStatus(`ready — pick a PDF (diff unavailable: ${failedDiffs.join(", ")})`);
} else {
  setStatus("ready — pick a PDF");
}

const loadPdfFile = async (file) => {
  if (!file) return;
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    setStatus(`not a PDF: ${file.name}`, true);
    return;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    setStatus(`could not read ${file.name}: ${errorMessage(err)}`, true);
    return;
  }
  pdfBytes = bytes;
  renderGen++;
  lastRender = null;
  pageSizePtCache = new Map();
  autoDpi = true;
  diffGen++;
  clearOutput();
  setStatus(`loading ${file.name}…`);
  let n = 0;
  try {
    n = await getPdfjsPageCount(bytes);
  } catch (err) {
    if (pdfBytes !== bytes) {
      return;
    }
    dom.pages.textContent = "";
    pdfBytes = null;
    setStatus(`could not parse ${file.name}: ${errorMessage(err)}`, true);
    return;
  }
  if (pdfBytes !== bytes) {
    return;
  }
  if (n <= 0) {
    dom.pages.textContent = "";
    pdfBytes = null;
    setStatus(`could not parse ${file.name}`, true);
    return;
  }
  dom.pages.textContent = `(of ${n})`;
  dom.page.max = n;
  if (parseInt(dom.page.value, 10) > n) dom.page.value = "1";
  setStatus(`${file.name} — ${n} page${n === 1 ? "" : "s"}`);
  doRender();
};

dom.file.addEventListener("change", async (e) => {
  await loadPdfFile(e.target.files?.[0]);
  e.target.value = "";
});

const isFileDrag = (event) =>
  Array.from(event.dataTransfer?.types || []).includes("Files");
const droppedFile = (event) =>
  Array.from(event.dataTransfer?.files || []).find(
    (file) =>
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf"),
  ) || event.dataTransfer?.files?.[0];

// While a file is dragged over the page, `dragover` fires continuously;
// when the drag ends the browser doesn't always tell us — notably,
// pressing Esc to cancel an OS file drag fires no dragend/dragleave on
// the page, which used to leave the drop zone stuck highlighted. So
// instead of a dragenter/dragleave counter, we arm a short watchdog on
// every dragover and clear the highlight once the events stop.
let dragClearTimer = 0;
const resetDrag = () => {
  clearTimeout(dragClearTimer);
  dragClearTimer = 0;
  document.body.classList.remove("drag-over");
};
const onDragOver = (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.type === "dragover") event.dataTransfer.dropEffect = "copy";
  document.body.classList.add("drag-over");
  clearTimeout(dragClearTimer);
  dragClearTimer = setTimeout(resetDrag, 200);
};
document.addEventListener("dragenter", onDragOver);
document.addEventListener("dragover", onDragOver);
document.addEventListener("drop", async (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  resetDrag();
  await loadPdfFile(droppedFile(event));
});
window.addEventListener("dragend", resetDrag);
window.addEventListener("blur", resetDrag);

// Coalesce rapid render-affecting changes (e.g. holding the page
// spinner) into a single render. Beyond saving wasted work, it stops a
// burst of back-to-back CLI invocations from piling up on one worker —
// which is what trips xpdf's wasm into an out-of-bounds abort.
let renderDebounce = 0;
const scheduleRender = () => {
  clearTimeout(renderDebounce);
  renderDebounce = setTimeout(() => doRender(), 200);
};

// Render-affecting inputs rerasterize; comparison inputs only rediff.
for (const input of [dom.page, dom.antialias, dom.transparent]) {
  input.addEventListener("change", scheduleRender);
}
dom.dpi.addEventListener("change", () => {
  autoDpi = false;
  scheduleRender();
});
for (const input of [dom.compareA, dom.compareB]) {
  input.addEventListener("change", () => renderSelectedDiff());
}
for (const cb of $$(".renderer")) {
  cb.addEventListener("change", scheduleRender);
}

async function doRender() {
  if (!pdfBytes) return;
  const sourcePdfBytes = pdfBytes;
  const gen = ++renderGen;
  // Clamp the requested page into [1, pageCount] before rendering — the
  // user can type or paste an out-of-range value past the input's max —
  // and reflect the corrected value back into the field.
  const pageCount = parseInt(dom.page.max, 10) || 1;
  const page = Math.min(
    pageCount,
    Math.max(1, parseInt(dom.page.value, 10) || 1),
  );
  if (String(page) !== dom.page.value) dom.page.value = String(page);
  const antialias = dom.antialias.checked ? 1 : 0;
  const transparent = dom.transparent.checked ? 1 : 0;
  const selected = selectedRendererGroups();

  if (!selected.all.length) {
    setStatus("pick at least one renderer", true);
    return;
  }

  await updateAutoDpi(page, selected.all.length, sourcePdfBytes);
  if (stale(gen)) return;

  const dpi = parseFloat(dom.dpi.value) || 96;

  // Keep canvases crisp on high-DPI displays.
  const dpr = window.devicePixelRatio || 1;
  const renderDpi = dpi * dpr;

  const t0 = performance.now();
  const result = { resolution: dpi, images: [] };
  // Reconcile the existing cards in place (rather than clearOutput()) so
  // re-renders — e.g. on a DPI change — keep the page height, and the
  // user's scroll position, stable instead of snapping back to the top.
  createRenderSlots(selected.all);
  showDiffWaiting();
  setStatus(
    `rendering page ${page}: 0/${selected.all.length} ready (${selected.all.join(", ")})`,
  );

  const appendImage = (img) =>
    appendRenderedImage({
      img,
      result,
      dpr,
      page,
      wanted: selected.all,
      gen,
    });
  // Ignore a failure from a superseded render so a slow engine that
  // errors after a newer DPI change can't clobber the current card.
  const failImage = (name, err) => {
    if (!stale(gen)) failRenderSlot(name, err);
  };

  const commonPayload = { page, dpi: renderDpi, transparent };
  const antialiasPayload = { ...commonPayload, antialias };
  const renderTasks = [
    ...selected.wasm.map((name) =>
      renderWorkerImage(
        name,
        getRendererWorker(name),
        sourcePdfBytes,
        antialiasPayload,
        appendImage,
        failImage,
        () => getRendererWorker.drop(name),
      ),
    ),
    ...selected.cli.map((name) =>
      renderWorkerImage(
        name,
        getCliRendererWorker(name),
        sourcePdfBytes,
        antialiasPayload,
        appendImage,
        failImage,
        () => getCliRendererWorker.drop(name),
      ),
    ),
  ];

  if (selected.pdfjs) {
    renderTasks.push(
      timedRender(
        "pdfjs",
        () => renderPdfjs(sourcePdfBytes, page, renderDpi, !!transparent),
        appendImage,
        failImage,
      ),
    );
  }

  if (selected.pdfbox) {
    renderTasks.push(
      renderWorkerImage(
        "pdfbox",
        getPdfboxWorker(),
        sourcePdfBytes,
        commonPayload,
        appendImage,
        failImage,
        () => getPdfboxWorker.drop(),
      ),
    );
  }

  await Promise.allSettled(renderTasks);
  if (stale(gen)) return;

  const dt = performance.now() - t0;
  const got = result.images.map((i) => i.renderer);
  const missing = selected.all.filter((name) => !got.includes(name));
  if (missing.length) {
    setStatus(
      `render failed for: ${missing.join(", ")} (got: ${got.join(", ") || "none"})`,
      true,
    );
  } else {
    const dims = `${result.page_width_pt?.toFixed(1)}×${result.page_height_pt?.toFixed(1)} pt`;
    setStatus(
      `page ${page}: ${dims} → ` +
        rendererSummary(result.images) +
        ` @ ${renderDpi.toFixed(0)} DPI (dpr ${dpr.toFixed(2)}) in ${dt.toFixed(0)} ms`,
    );
  }

  lastRender = { images: result.images, dpr, renderGen: gen };
  await renderSelectedDiff();
}
