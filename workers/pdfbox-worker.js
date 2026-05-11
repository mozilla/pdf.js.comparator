// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Classic worker (not type=module) — CheerpJ's loader is a script that
// defines globals (cheerpjInit, cheerpjRunLibrary, …), which we pull in
// via importScripts. importScripts is only available on classic workers.

const params = new URLSearchParams(self.location.search);
const BASE = params.get("base") || "../out";
const CACHE_BUST = params.get("v") || "";
const localScript = (path) => {
  const url = new URL(path, self.location.href);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};
importScripts(
  localScript("./render-result-transport.js"),
  localScript("./java-error.js"),
  "https://cjrtnc.leaningtech.com/4.3/loader.js",
);
// Keep PDFBox on the same CheerpJ runtime family as the shared JVM renderer
// worker. The implicit CheerpJ default is Java 8, which can leave browsers
// mixing cached runtime files after switching between Java renderers.
const CHEERPJ_VERSION = 11;
const DEFAULT_JARS = ["pdfbox-cheerpj-patches.jar", "pdfbox-app.jar"];
const CHEERPJ_JAVA_PROPERTIES = [
  // CheerpJ does not provide the native LCMS color-management library. Tell
  // PDFBox to use the PDF's alternate ICC color space instead of loading
  // java.awt.color.ICC_Profile, which would call System.loadLibrary("lcms").
  "org.apache.pdfbox.rendering.UseAlternateInsteadOfICCColorSpace=true",
  "org.apache.pdfbox.rendering.UsePureJavaCMYKConversion=true",
];

// Resolved by `ready` below. Cached refs to Java classes/methods we
// invoke per render.
let Loader = null;
let PDFRenderer = null;
let ImageType = null;

const resourceUrl = (path) => {
  const url = new URL(`${BASE}/pdfbox/${path}`, self.location.href);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};

const getJarNames = async () => {
  try {
    const resp = await fetch(resourceUrl("pdfbox.jars.json"));
    if (resp.ok) {
      const manifest = await resp.json();
      if (Array.isArray(manifest.jars) && manifest.jars.length) {
        return manifest.jars;
      }
    }
  } catch {
    // Fall back to the checked-in default list below.
  }
  return DEFAULT_JARS;
};

const installJar = async (name) => {
  const url = resourceUrl(name);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch ${url} -> ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const path = `/str/pdfbox-${name}`;
  const addStringFile =
    typeof cheerpOSAddStringFile === "function"
      ? cheerpOSAddStringFile
      : cheerpjAddStringFile;
  if (typeof addStringFile !== "function") {
    throw new Error("CheerpJ string-file API is not available");
  }
  addStringFile(path, bytes);
  return path;
};

const setJavaProperties = async (lib) => {
  const System = await lib.java.lang.System;
  for (const property of CHEERPJ_JAVA_PROPERTIES) {
    const eq = property.indexOf("=");
    const key = eq >= 0 ? property.slice(0, eq) : property;
    const value = eq >= 0 ? property.slice(eq + 1) : "";
    await System.setProperty(key, value);
  }
};

const { message: javaErrorMessage } = self.JavaError;

// Capture init failure so each handle() can report it back instead of
// silently hanging via a rejected promise chain.
let initError = null;

const ready = (async () => {
  try {
    await cheerpjInit({
      version: CHEERPJ_VERSION,
      javaProperties: CHEERPJ_JAVA_PROPERTIES,
    });

    // Fetch the jars ourselves and inject them into CheerpJ's virtual FS.
    // CheerpJ 4 silently no-ops `cheerpjRunLibrary(httpUrl)` when given an
    // external HTTP URL, so it needs VFS paths.
    const jarNames = await getJarNames();
    const classPath = (await Promise.all(jarNames.map(installJar))).join(":");
    const lib = await cheerpjRunLibrary(classPath);
    await setJavaProperties(lib);
    Loader = await lib.org.apache.pdfbox.Loader;
    PDFRenderer = await lib.org.apache.pdfbox.rendering.PDFRenderer;
    ImageType = await lib.org.apache.pdfbox.rendering.ImageType;
    self.postMessage({ type: "ready" });
  } catch (err) {
    const detail = await javaErrorMessage(err);
    console.error("pdfbox init failed:", detail);
    initError = new Error(`pdfbox init failed: ${detail}`);
    self.postMessage({ type: "init-error", error: initError.message });
  }
})();

// PDFBox returns pixels as ARGB ints (one int per pixel; alpha in the top
// byte, then R, G, B). Convert to RGBA bytes for the harness.
const argbIntsToRgbaBytes = (argbInts, width, height) => {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < argbInts.length; ++i) {
    const v = argbInts[i] | 0;
    const o = i * 4;
    out[o + 0] = (v >>> 16) & 0xff;
    out[o + 1] = (v >>> 8) & 0xff;
    out[o + 2] = (v >>> 0) & 0xff;
    out[o + 3] = (v >>> 24) & 0xff;
  }
  return out;
};

const closeQuietly = async (resource, label) => {
  if (!resource || typeof resource.close !== "function") {
    return;
  }
  try {
    await resource.close();
  } catch (err) {
    console.warn(`${label} close failed:`, await javaErrorMessage(err));
  }
};

const openPdfDocument = async (pdfBytes) => {
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength <= 0) {
    throw new Error("invalid PDF bytes");
  }

  const javaBytes = new Int8Array(
    pdfBytes.buffer,
    pdfBytes.byteOffset,
    pdfBytes.byteLength,
  );
  return Loader.loadPDF(javaBytes);
};

const doRender = async (pdfBytes, pageNumber, dpi, transparent) => {
  const doc = await openPdfDocument(pdfBytes);
  try {
    const renderer = await new PDFRenderer(doc);
    // PDFBox's quality downscaling path calls Image.getScaledInstance(),
    // which asks AWT for a Toolkit/display. This worker has no CheerpJ
    // display, so keep image scaling inside Graphics2D instead.
    await renderer.setImageDownscalingOptimizationThreshold(0);
    const imgType = transparent ? await ImageType.ARGB : await ImageType.RGB;
    // pageNumber is 1-indexed in our public API; PDFBox is 0-indexed.
    const image = await renderer.renderImageWithDPI(
      pageNumber - 1,
      dpi,
      imgType,
    );
    const width = await image.getWidth();
    const height = await image.getHeight();
    const argb = await image.getRGB(0, 0, width, height, null, 0, width);
    return { width, height, data: argbIntsToRgbaBytes(argb, width, height) };
  } finally {
    await closeQuietly(doc, "pdfbox document");
  }
};

const doNumPages = async (pdfBytes) => {
  const doc = await openPdfDocument(pdfBytes);
  try {
    return await doc.getNumberOfPages();
  } finally {
    await closeQuietly(doc, "pdfbox document");
  }
};

// Serialise handlers like the other workers — CheerpJ's heap is shared
// across calls; concurrent renders on the same JVM would race. The
// chain is force-resolved (`.catch(() => {})`) so an init failure
// doesn't poison subsequent handle() calls — each one checks
// `initError` and reports it as a normal error response.
let queue = ready.catch(() => {});
self.addEventListener("message", (e) => {
  queue = queue.then(() => handle(e));
});

const handle = async (e) => {
  const { id, type, payload } = e.data;
  if (initError) {
    self.postMessage({ id, error: initError.message });
    return;
  }
  try {
    if (type === "render") {
      const { pdfBytes, page, dpi, transparent } = payload;
      const { width, height, data } = await doRender(
        pdfBytes,
        page,
        dpi,
        !!transparent,
      );
      // Get the page dimensions in points: PDFBox reports them on the
      // PDPage's MediaBox; we approximate here from pixels-back since we
      // already have width / dpi.
      const page_width_pt = (width / dpi) * 72;
      const page_height_pt = (height / dpi) * 72;
      const image = await self.RenderResultTransport.withBitmap({
        width,
        height,
        page_width_pt,
        page_height_pt,
        data,
      });
      self.RenderResultTransport.post(id, image);
    } else if (type === "num_pages") {
      const n = await doNumPages(payload.pdfBytes);
      self.postMessage({ id, payload: n });
    } else {
      self.postMessage({ id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    const detail = await javaErrorMessage(err);
    console.error("pdfbox handle failed:", detail);
    self.postMessage({ id, error: detail });
  }
};
