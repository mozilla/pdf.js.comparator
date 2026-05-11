// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Generic single-diff-algorithm worker. Pick which wasm to load via a
// search param on the worker URL:
//     new Worker("./workers/diff-worker.js?wasm=butteraugli&base=…",
//                { type: "module" });
// One Worker per diff wasm; the harness spawns one each and runs them in
// parallel.

const params = new URL(self.location.href).searchParams;
const WASM = params.get("wasm");
const BASE = params.get("base") || "../out";
const CACHE_BUST = params.get("v") || "";

const moduleUrl = (path) => {
  const url = new URL(`${BASE}/${path}`, self.location.href);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};

let runner = null; // (a, b) -> { name, label, diffPixels, time }
let initError = null;

const validatePair = (a, b) => {
  if (
    !a ||
    !b ||
    a.width !== b.width ||
    a.height !== b.height ||
    !Number.isInteger(a.width) ||
    !Number.isInteger(a.height) ||
    a.width <= 0 ||
    a.height <= 0
  ) {
    throw new Error("diff inputs must have matching positive dimensions");
  }
  const size = a.width * a.height * 4;
  if (
    !Number.isSafeInteger(size) ||
    a.data?.length !== size ||
    b.data?.length !== size
  ) {
    throw new Error("diff input buffer size mismatch");
  }
  return size;
};

// Shared runner factory for the malloc-based wasm modules (butteraugli +
// flip). Both have the same shape: allocate three width*height*4 buffers,
// pass two inputs + one output, and read the score back. The only
// per-module bits are the C function name + how to format the score.
const mallocCompareRunner =
  (mod, { name, fn, label, validateScore }) =>
  (a, b) => {
    const t0 = performance.now();
    const size = validatePair(a, b);
    const { width, height } = a;
    const aPtr = mod._malloc(size);
    const bPtr = mod._malloc(size);
    const dPtr = mod._malloc(size);
    try {
      if (!aPtr || !bPtr || !dPtr) {
        throw new Error(`${name} malloc failed for ${size} bytes`);
      }
      mod.writeArrayToMemory(a.data, aPtr);
      mod.writeArrayToMemory(b.data, bPtr);
      const score = mod[fn](aPtr, bPtr, width, height, dPtr);
      if (validateScore && !validateScore(score)) {
        throw new Error(`${name} compare failed: ${score}`);
      }
      const diff = new Uint8ClampedArray(size);
      diff.set(mod.HEAPU8.subarray(dPtr, dPtr + size));
      return {
        name,
        label: label(score),
        diffPixels: diff,
        time: performance.now() - t0,
      };
    } finally {
      mod._free(aPtr);
      mod._free(bPtr);
      mod._free(dPtr);
    }
  };

const ready = (async () => {
  try {
    if (WASM === "butteraugli") {
      const mod = await import(moduleUrl("butteraugli/butteraugli.js"));
      const butteraugli = await mod.default();
      runner = mallocCompareRunner(butteraugli, {
        name: "butteraugli",
        fn: "_butteraugli_compare",
        label: (score) => `score = ${score.toFixed(3)}`,
      });
    } else if (WASM === "dssim") {
      const mod = await import(moduleUrl("dssim/dssim.js"));
      await mod.default();
      runner = (a, b) => {
        const t0 = performance.now();
        validatePair(a, b);
        const r = mod.compare(a.data, b.data, a.width, a.height);
        return {
          name: "dssim",
          label: `dissim = ${r.score.toFixed(4)}`,
          diffPixels: new Uint8ClampedArray(r.heatmap),
          time: performance.now() - t0,
        };
      };
    } else if (WASM === "flip") {
      const mod = await import(moduleUrl("flip/flip.js"));
      const flip = await mod.default();
      runner = mallocCompareRunner(flip, {
        name: "flip",
        fn: "_flip_compare",
        label: (score) => `mean = ${score.toFixed(4)}`,
        validateScore: (score) => Number.isFinite(score) && score >= 0,
      });
    } else {
      throw new Error(`unknown wasm: ${WASM}`);
    }
    self.postMessage({ type: "ready" });
  } catch (err) {
    initError = err;
    self.postMessage({
      type: "init-error",
      error: err.message || String(err),
    });
    throw err;
  }
})();

// Serialise handlers (async listeners would otherwise interleave and
// race on the wasm heap).
let queue = ready.catch(() => {});
self.addEventListener("message", (e) => {
  queue = queue.then(() => handle(e));
});

const handle = async (e) => {
  const { id, type, payload } = e.data;
  if (initError) {
    self.postMessage({ id, error: initError.message || String(initError) });
    return;
  }
  try {
    if (type === "diff") {
      const result = runner(payload.a, payload.b);
      self.postMessage({ id, payload: result }, [result.diffPixels.buffer]);
    } else {
      self.postMessage({ id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
