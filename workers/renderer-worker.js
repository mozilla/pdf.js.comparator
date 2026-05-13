// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Generic single-renderer worker. Pick which wasm to load via a search
// param on the worker URL, e.g.
//     new Worker("./workers/renderer-worker.js?wasm=cairo&base=./out",
//                { type: "module" });
// Each Worker instance owns one renderer's wasm — main thread spawns one
// per renderer it wants to run.

const params = new URL(self.location.href).searchParams;
const WASM = params.get("wasm");
const BASE = params.get("base") || "../out";
const CACHE_BUST = params.get("v") || "";

const factoryUrl = new URL(`${BASE}/${WASM}/${WASM}.js`, self.location.href);
const transportUrl = new URL(
  "./render-result-transport.js",
  self.location.href,
);
if (CACHE_BUST) {
  factoryUrl.searchParams.set("v", CACHE_BUST);
  transportUrl.searchParams.set("v", CACHE_BUST);
}

// emcc's generated .js derives the sibling .wasm URL via
//     new URL("<name>.wasm", import.meta.url)
// which strips the query string from import.meta.url — so the wasm
// bypasses the cache-bust the harness puts on the worker URL and the
// browser serves a stale copy that no longer matches the (freshly
// minified) .js. Override locateFile to thread the same ?v=… through.
const locateFile = (path) => {
  const url = new URL(path, factoryUrl);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};

let Module = null;
let initError = null;
const ready = (async () => {
  try {
    await import(transportUrl.href);
    const mod = await import(factoryUrl.href);
    Module = await mod.default({ locateFile });
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

const withBuffer = (bytes, fn) => {
  const ptr = Module._malloc(bytes.length);
  if (!ptr) {
    throw new Error(`malloc failed for ${bytes.length} bytes`);
  }
  Module.writeArrayToMemory(bytes, ptr);
  try {
    fn(ptr, bytes.length);
  } finally {
    Module._free(ptr);
  }
};

// Serialise handlers — async listeners would otherwise interleave and
// race on Module.lastResult / wasm heap state.
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
    if (type === "render") {
      const { pdfBytes, page, dpi, antialias, transparent } = payload;
      Module.lastResult = null;
      withBuffer(pdfBytes, (ptr, size) =>
        Module._render(ptr, size, page, dpi, antialias, transparent),
      );
      const result = await self.RenderResultTransport.withBitmap(
        Module.lastResult,
      );
      self.RenderResultTransport.post(id, result);
    } else if (type === "num_pages") {
      const { pdfBytes } = payload;
      Module.numPages = -1;
      withBuffer(pdfBytes, (ptr, size) => Module._num_pages(ptr, size));
      self.postMessage({ id, payload: Module.numPages });
    } else {
      self.postMessage({ id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
