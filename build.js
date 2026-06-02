// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

"use strict";

const { ArgumentParser } = require("argparse");
const fs = require("fs/promises");
const net = require("net");
const { spawn } = require("child_process");
const { resolve } = require("path");

const IMAGE_NAME = "pdf-js-comparator";
const SERVE_CONTAINER_NAME = `${IMAGE_NAME}-serve`;
const RENDERERS = [
  "cairo",
  "splash",
  "pdfium",
  "mupdf",
  "butteraugli",
  "dssim",
  "flip",
  "pdfjs",
  "pdfbox",
  "gs",
  "xpdf",
];

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const reason = signal
        ? `signal ${signal}`
        : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${cmd} ${args.join(" ")} failed with ${reason}`));
    });
  });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function checkPort(port) {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the existing server/container or pass --port ${port + 1}.`,
          ),
        );
        return;
      }
      // Some sandboxed environments disallow listening sockets even for
      // preflight checks. In that case, let Docker report the real bind result.
      resolvePromise();
    });
    server.once("listening", () => {
      server.close(() => resolvePromise());
    });
    server.listen(port, "0.0.0.0");
  });
}

async function ensureOutputDir(path) {
  let stat = null;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
    await fs.mkdir(path, { recursive: true });
    stat = await fs.stat(path);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Output path is not a directory: ${path}`);
  }
}

// `docker build` — by default builds the `final` stage which depends on
// all the per-renderer sibling stages. With --target the corresponding
// sibling stage's image is produced instead (artifacts at /js/<name>/).
async function create({ target, noCache, buildArgs }) {
  const tag = target ? `${IMAGE_NAME}-${target}` : IMAGE_NAME;
  const args = ["build"];
  if (noCache) args.push("--no-cache");
  for (const buildArg of buildArgs) {
    args.push("--build-arg", buildArg);
  }
  if (target) args.push("--target", target);
  args.push("-t", tag, ".");
  return run("docker", args);
}

// Extract artifacts via `docker create` + `docker cp`. We don't bind-mount
// /js anymore because the final image just serves static files and doesn't
// run build scripts — extraction reads the baked-in wasm bundles directly.
async function extract({ target, outputDir }) {
  outputDir = resolve(outputDir);
  await ensureOutputDir(outputDir);
  const tag = target ? `${IMAGE_NAME}-${target}` : IMAGE_NAME;
  const containerName = `${tag}-extract-${Date.now()}`;

  await run("docker", ["create", "--name", containerName, tag]);
  try {
    if (target) {
      // Sibling stage's filesystem: /js/<name>/
      // docker cp's '.' suffix copies the contents of the source, so we
      // wipe the destination first to keep things idempotent.
      const dest = `${outputDir}/${target}`;
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dest, { recursive: true });
      await run("docker", ["cp", `${containerName}:/js/${target}/.`, dest]);
    } else {
      // Final image lays each renderer's bundle out at /www/out/<name>/.
      for (const r of RENDERERS) {
        const dest = `${outputDir}/${r}`;
        await fs.rm(dest, { recursive: true, force: true });
        await fs.mkdir(dest, { recursive: true });
        await run("docker", ["cp", `${containerName}:/www/out/${r}/.`, dest]);
      }
    }
  } finally {
    try {
      await run("docker", ["rm", containerName]);
    } catch (err) {
      console.error(`failed to remove ${containerName}: ${err.message}`);
    }
  }
}

async function serve({ port }) {
  await checkPort(port);
  console.log(`Serving http://localhost:${port}/harness.html`);
  return run("docker", [
    "run",
    "--rm",
    "--name",
    SERVE_CONTAINER_NAME,
    "-p",
    `${port}:8000`,
    IMAGE_NAME,
  ]);
}

const parser = new ArgumentParser({
  description: "Build pdf.js.comparator wasm bundles via docker",
});
parser.add_argument("-C", "--create", {
  help: "(re)build the docker image",
  action: "store_true",
});
parser.add_argument("-c", "--compile", {
  help: "Extract built wasm bundles from the image into --output",
  action: "store_true",
});
parser.add_argument("-o", "--output", {
  help: "Output directory (subdirs per renderer)",
  default: "out",
});
parser.add_argument("-t", "--target", {
  help: `Build only one renderer stage (one of: ${RENDERERS.join(", ")})`,
  choices: RENDERERS,
});
parser.add_argument("--no-cache", {
  help: "Pass --no-cache to docker build",
  action: "store_true",
});
parser.add_argument("--build-arg", {
  help: "Pass KEY=VALUE through to docker build --build-arg",
  action: "append",
  default: [],
});
parser.add_argument("--serve", {
  help: "Serve the built static site from the final docker image",
  action: "store_true",
});
parser.add_argument("--port", {
  help: "Host port to use with --serve",
  default: 8000,
  type: parsePort,
});

(async () => {
  const args = parser.parse_args();
  if (args.serve && args.target) {
    throw new Error("--serve requires the final image; do not pass --target");
  }
  if (args.create) {
    await create({
      target: args.target,
      noCache: args.no_cache,
      buildArgs: args.build_arg,
    });
  }
  if (args.compile) {
    await extract({ target: args.target, outputDir: args.output });
  }
  if (args.serve) {
    await serve({ port: args.port });
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
