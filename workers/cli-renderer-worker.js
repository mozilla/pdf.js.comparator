// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Generic worker for renderer modules that are easiest to drive as
// Emscripten CLI programs. Ghostscript writes one raw PPM; Xpdf's pdftoppm
// does the same. We parse PPM here and expose the same render/num_pages
// protocol as workers/renderer-worker.js.

const params = new URL(self.location.href).searchParams;
const RENDERER = params.get("renderer");
const BASE = params.get("base") || "../out";
const CACHE_BUST = params.get("v") || "";

const INPUT_PATH = "/input.pdf";
const OUTPUT_ROOT = "/page";
const OUTPUT_PPM = "/page.ppm";

const CONFIG = {
  gs: {
    renderModule: "gs.mjs",
    infoModule: "gs.mjs",
  },
  xpdf: {
    renderModule: "pdftoppm.js",
    infoModule: "pdfinfo.js",
  },
};

if (!CONFIG[RENDERER]) {
  throw new Error(`unknown cli renderer: ${RENDERER}`);
}

let stdoutLines = [];
let stderrLines = [];
let renderModule = null;
let infoModule = null;
let initError = null;

const transportUrl = new URL(
  "./render-result-transport.js",
  self.location.href,
);
if (CACHE_BUST) {
  transportUrl.searchParams.set("v", CACHE_BUST);
}

const moduleUrl = (file) => {
  const url = new URL(`${BASE}/${RENDERER}/${file}`, self.location.href);
  if (CACHE_BUST) {
    url.searchParams.set("v", CACHE_BUST);
  }
  return url.href;
};

const loadModule = async (file) => {
  const factory = (await import(moduleUrl(file))).default;
  return factory({
    locateFile: (path) => moduleUrl(path),
    print: (text) => stdoutLines.push(String(text)),
    printErr: (text) => stderrLines.push(String(text)),
  });
};

const ready = (async () => {
  try {
    await import(transportUrl.href);
    const cfg = CONFIG[RENDERER];
    renderModule = await loadModule(cfg.renderModule);
    infoModule =
      cfg.infoModule === cfg.renderModule
        ? renderModule
        : await loadModule(cfg.infoModule);
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

const unlinkQuietly = (mod, path) => {
  try {
    mod.FS.unlink(path);
  } catch (err) {
    // ENOENT (errno 44 in Emscripten's wasi mapping; "No such file or
    // directory" in the message) is expected — anything else is real.
    const msg = err?.message || String(err);
    if (err?.errno && err.errno !== 44 && !/no such file/i.test(msg)) {
      console.warn(`unlink(${path}) failed:`, msg);
    }
  }
};

const writePdf = (mod, pdfBytes) => {
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength <= 0) {
    throw new Error("invalid PDF bytes");
  }
  unlinkQuietly(mod, INPUT_PATH);
  mod.FS.writeFile(INPUT_PATH, pdfBytes);
};

const runMain = (mod, args) => {
  stdoutLines = [];
  stderrLines = [];
  try {
    mod.callMain(args);
  } catch (err) {
    const status =
      typeof err === "number"
        ? err
        : typeof err?.status === "number"
          ? err.status
          : null;
    if (status !== 0) {
      const detail = [...stderrLines, err?.message || String(err)]
        .filter(Boolean)
        .join("\n");
      throw new Error(detail || `process exited with ${status}`, {
        cause: err,
      });
    }
  }
  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
  };
};

const isWhitespace = (c) =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

const parsePpm = (bytes) => {
  let i = 0;
  const nextToken = () => {
    for (;;) {
      while (i < bytes.length && isWhitespace(bytes[i])) i++;
      if (i >= bytes.length) {
        throw new Error("unexpected EOF in PPM header");
      }
      if (bytes[i] !== 0x23) break; // '#'
      while (i < bytes.length && bytes[i] !== 0x0a) i++;
    }
    const start = i;
    while (i < bytes.length && !isWhitespace(bytes[i])) i++;
    if (start === i) throw new Error("malformed PPM header");
    return new TextDecoder("ascii").decode(bytes.subarray(start, i));
  };

  const magic = nextToken();
  if (magic !== "P6") {
    throw new Error(`unsupported PPM magic: ${magic}`);
  }
  const width = parseInt(nextToken(), 10);
  const height = parseInt(nextToken(), 10);
  const max = parseInt(nextToken(), 10);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    max !== 255
  ) {
    throw new Error(`invalid PPM header: ${width}x${height} max=${max}`);
  }
  if (i < bytes.length && isWhitespace(bytes[i])) i++;

  const rgbBytes = width * height * 3;
  if (bytes.length - i < rgbBytes) {
    throw new Error("truncated PPM data");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let src = i, dst = 0; dst < data.length; src += 3, dst += 4) {
    data[dst + 0] = bytes[src + 0];
    data[dst + 1] = bytes[src + 1];
    data[dst + 2] = bytes[src + 2];
    data[dst + 3] = 255;
  }
  return { width, height, data };
};

const gsRender = ({ pdfBytes, page, dpi, antialias }) => {
  writePdf(renderModule, pdfBytes);
  unlinkQuietly(renderModule, OUTPUT_PPM);
  const aa = antialias ? "4" : "1";
  runMain(renderModule, [
    "-q",
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    `-dFirstPage=${page}`,
    `-dLastPage=${page}`,
    `-r${dpi}`,
    `-dTextAlphaBits=${aa}`,
    `-dGraphicsAlphaBits=${aa}`,
    "-sDEVICE=ppmraw",
    `-sOutputFile=${OUTPUT_PPM}`,
    INPUT_PATH,
  ]);
  return parsePpm(renderModule.FS.readFile(OUTPUT_PPM));
};

const gsNumPages = (pdfBytes) => {
  writePdf(infoModule, pdfBytes);
  const { stdout } = runMain(infoModule, [
    "-q",
    "-dSAFER",
    "-dNODISPLAY",
    "-c",
    `(${INPUT_PATH}) (r) file runpdfbegin pdfpagecount = quit`,
  ]);
  const matches = stdout.match(/\d+/g);
  return matches?.length ? parseInt(matches[matches.length - 1], 10) : 0;
};

const xpdfOutputPath = (page) =>
  `${OUTPUT_ROOT}-${String(page).padStart(6, "0")}.ppm`;

const xpdfRender = ({ pdfBytes, page, dpi, antialias }) => {
  writePdf(renderModule, pdfBytes);
  const outputPath = xpdfOutputPath(page);
  unlinkQuietly(renderModule, outputPath);
  runMain(renderModule, [
    "-q",
    "-f",
    String(page),
    "-l",
    String(page),
    "-r",
    String(dpi),
    "-aa",
    antialias ? "yes" : "no",
    "-aaVector",
    antialias ? "yes" : "no",
    INPUT_PATH,
    OUTPUT_ROOT,
  ]);
  return parsePpm(renderModule.FS.readFile(outputPath));
};

const xpdfNumPages = (pdfBytes) => {
  writePdf(infoModule, pdfBytes);
  const { stdout } = runMain(infoModule, [INPUT_PATH]);
  const match = stdout.match(/^Pages:\s*(\d+)/m);
  return match ? parseInt(match[1], 10) : 0;
};

const doRender = (payload) => {
  const image = RENDERER === "gs" ? gsRender(payload) : xpdfRender(payload);
  const page_width_pt = (image.width / payload.dpi) * 72;
  const page_height_pt = (image.height / payload.dpi) * 72;
  return { ...image, page_width_pt, page_height_pt };
};

const doNumPages = (pdfBytes) =>
  RENDERER === "gs" ? gsNumPages(pdfBytes) : xpdfNumPages(pdfBytes);

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
      const image = await self.RenderResultTransport.withBitmap(
        doRender(payload),
      );
      self.RenderResultTransport.post(id, image);
    } else if (type === "num_pages") {
      self.postMessage({ id, payload: doNumPages(payload.pdfBytes) });
    } else {
      self.postMessage({ id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
