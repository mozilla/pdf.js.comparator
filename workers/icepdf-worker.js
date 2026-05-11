// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Classic worker: CheerpJ's loader defines globals via importScripts. This
// worker is icepdf-specific (it references icepdf classes by name); a
// second JVM renderer should get its own peer file rather than parameterise
// this one — the JVM class graphs don't usefully share a worker.

const params = new URLSearchParams(self.location.search);
const BASE = params.get("base") || "../out";
const CACHE_BUST = params.get("v") || "";
const RENDERER = "icepdf";
const CHEERPJ_VERSION = 11;
const DEFAULT_JARS = [
  "icepdf-cheerpj-patches.jar",
  "icepdf-core.jar",
  "icepdf-fonts.jar",
  "bcprov-jdk18on.jar",
  "bcpkix-jdk18on.jar",
  "bcutil-jdk18on.jar",
  "imageio-tiff.jar",
  "imageio-core.jar",
  "imageio-metadata.jar",
  "common-lang.jar",
  "common-io.jar",
  "common-image.jar",
  "fontbox.jar",
  "pdfbox-io.jar",
  "commons-logging.jar",
  "jbig2-imageio.jar",
  "jai-imageio-core.jar",
  "jai-imageio-jpeg2000.jar",
];

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

const { message: javaErrorMessage } = self.JavaError;

let lib = null;
let initError = null;
let Document = null;
let Page = null;
let GraphicsRenderingHints = null;
let BufferedImage = null;
let Color = null;

const resourceUrl = (path) => {
  const url = new URL(`${BASE}/${RENDERER}/${path}`, self.location.href);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};

const getJarNames = async () => {
  try {
    const resp = await fetch(resourceUrl(`${RENDERER}.jars.json`));
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
  const path = `/str/${RENDERER}-${name}`;
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

const ready = (async () => {
  try {
    await cheerpjInit({ version: CHEERPJ_VERSION });
    const jarNames = await getJarNames();
    const classPath = (await Promise.all(jarNames.map(installJar))).join(":");
    lib = await cheerpjRunLibrary(classPath);
    Document = await lib.org.icepdf.core.pobjects.Document;
    Page = await lib.org.icepdf.core.pobjects.Page;
    GraphicsRenderingHints =
      await lib.org.icepdf.core.util.GraphicsRenderingHints;
    BufferedImage = await lib.java.awt.image.BufferedImage;
    Color = await lib.java.awt.Color;
    await Document.setCachingEnabled(false);
    self.postMessage({ type: "ready" });
  } catch (err) {
    const detail = await javaErrorMessage(err);
    console.error(`${RENDERER} init failed:`, detail);
    initError = new Error(`${RENDERER} init failed: ${detail}`);
    self.postMessage({ type: "init-error", error: initError.message });
  }
})();

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

const asJavaBytes = (pdfBytes) => {
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength <= 0) {
    throw new Error("invalid PDF bytes");
  }
  return new Int8Array(
    pdfBytes.buffer,
    pdfBytes.byteOffset,
    pdfBytes.byteLength,
  );
};

const disposeQuietly = async (resource, label) => {
  if (!resource || typeof resource.dispose !== "function") {
    return;
  }
  try {
    await resource.dispose();
  } catch (err) {
    console.warn(`${label} dispose failed:`, await javaErrorMessage(err));
  }
};

const openIcePdfDocument = async (pdfBytes) => {
  const doc = await new Document();
  await doc.setByteArray(
    asJavaBytes(pdfBytes),
    0,
    pdfBytes.byteLength,
    "input.pdf",
  );
  return doc;
};

const renderIcePdf = async ({ pdfBytes, page, dpi, transparent }) => {
  const doc = await openIcePdfDocument(pdfBytes);
  try {
    const scale = dpi / 72;
    const dimension = await doc.getPageDimension(page - 1, 0, scale);
    const width = Math.max(1, Math.ceil(await dimension.getWidth()));
    const height = Math.max(1, Math.ceil(await dimension.getHeight()));
    const image = await new BufferedImage(
      width,
      height,
      await BufferedImage.TYPE_INT_ARGB,
    );
    const graphics = await image.createGraphics();
    try {
      if (!transparent) {
        await graphics.setColor(await Color.WHITE);
        await graphics.fillRect(0, 0, width, height);
      }
      await doc.paintPage(
        page - 1,
        graphics,
        await GraphicsRenderingHints.SCREEN,
        await Page.BOUNDARY_CROPBOX,
        0,
        scale,
      );
    } finally {
      await graphics.dispose();
    }
    const argb = await image.getRGB(0, 0, width, height, null, 0, width);
    return {
      width,
      height,
      page_width_pt: (width / dpi) * 72,
      page_height_pt: (height / dpi) * 72,
      data: argbIntsToRgbaBytes(argb, width, height),
    };
  } finally {
    await disposeQuietly(doc, "icepdf document");
  }
};

const doNumPages = async (pdfBytes) => {
  const doc = await openIcePdfDocument(pdfBytes);
  try {
    return await doc.getNumberOfPages();
  } finally {
    await disposeQuietly(doc, "icepdf document");
  }
};

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
      const image = await self.RenderResultTransport.withBitmap(
        await renderIcePdf(payload),
      );
      self.RenderResultTransport.post(id, image);
    } else if (type === "num_pages") {
      self.postMessage({ id, payload: await doNumPages(payload.pdfBytes) });
    } else {
      self.postMessage({ id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    const detail = await javaErrorMessage(err);
    console.error(`${RENDERER} handle failed:`, detail);
    self.postMessage({ id, error: detail });
  }
};
