#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const target = process.argv[2];

if (!target) {
  throw new Error("usage: node scripts/resolve-upstream.mjs <target>");
}

const TARGETS = {
  butteraugli: resolveButteraugli,
  cairo: resolveCairo,
  dssim: resolveDssim,
  flip: resolveFlip,
  gs: resolveGhostscript,
  mupdf: resolveMupdf,
  pdfbox: resolvePdfbox,
  pdfium: resolvePdfium,
  pdfjs: resolvePdfjs,
  splash: resolveSplash,
  xpdf: resolveXpdf,
};

if (!TARGETS[target]) {
  throw new Error(`unknown sync target: ${target}`);
}

function run(command, args, { silent = false } = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: silent
      ? ["ignore", "pipe", "ignore"]
      : ["ignore", "pipe", "inherit"],
  }).trim();
}

async function fetchText(url) {
  // Use a browser-like user-agent — xpdfreader.com (and other Cloudflare-
  // fronted upstreams) 403 anything that looks bot-y. The fetch in Node 22
  // (undici) handles modern TLS cleanly, so no curl fallback is needed.
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; pdf.js.comparator/1.0; +https://github.com/mozilla/pdf.js.comparator)",
      accept: "*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`fetch ${url} → HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const delta = (partsA[i] || 0) - (partsB[i] || 0);
    if (delta) {
      return delta;
    }
  }
  return 0;
}

function latestVersion(versions) {
  if (!versions.length) {
    throw new Error("no versions matched");
  }
  return versions.sort(compareVersions).at(-1);
}

function latestGitTag(repo, glob, pattern, versionFromTag = (tag) => tag) {
  const lines = run("git", ["ls-remote", "--tags", repo, glob])
    .split("\n")
    .filter(Boolean);
  const tags = new Set();
  for (const line of lines) {
    const ref = line.split(/\s+/)[1];
    if (!ref || ref.endsWith("^{}")) {
      continue;
    }
    const tag = ref.replace(/^refs\/tags\//, "");
    if (pattern.test(tag)) {
      tags.add(tag);
    }
  }
  if (!tags.size) {
    throw new Error(`no tags matched ${glob} in ${repo}`);
  }
  return [...tags]
    .sort((a, b) => compareVersions(versionFromTag(a), versionFromTag(b)))
    .at(-1);
}

async function latestMavenVersion(groupPath, artifact) {
  const metadata = await fetchText(
    `https://repo1.maven.org/maven2/${groupPath}/${artifact}/maven-metadata.xml`,
  );
  const release = metadata.match(/<release>([^<]+)<\/release>/)?.[1];
  const latest = metadata.match(/<latest>([^<]+)<\/latest>/)?.[1];
  const version = release || latest;
  if (!version) {
    throw new Error(`no Maven release found for ${groupPath}/${artifact}`);
  }
  return version;
}

async function publishedFingerprint(name) {
  try {
    run("git", ["ls-remote", "--exit-code", "origin", "refs/heads/gh-pages"], {
      silent: true,
    });
    run("git", ["fetch", "--depth", "1", "origin", "gh-pages"], {
      silent: true,
    });
    const source = run("git", ["show", `FETCH_HEAD:out/${name}/source.json`], {
      silent: true,
    });
    const json = JSON.parse(source);
    return json.fingerprint || "";
  } catch {
    return "";
  }
}

function writeOutputs(target, outputs) {
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${value}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } else {
    console.log(lines.join("\n"));
  }
  // Also export each resolved value as an UPPER_CASE env var so the
  // subsequent build step picks them up without per-renderer plumbing
  // in the reusable workflow. `changed` and `fingerprint` are prefixed
  // with the target name because they would otherwise collide across
  // resolvers when multiple run in the same job (deploy.yml does this).
  if (process.env.GITHUB_ENV) {
    const upper = target.toUpperCase();
    const envLines = Object.entries(outputs).map(([key, value]) => {
      if (key === "changed" || key === "fingerprint") {
        return `${upper}_${key.toUpperCase()}=${value}`;
      }
      return `${key.toUpperCase()}=${value}`;
    });
    appendFileSync(process.env.GITHUB_ENV, `${envLines.join("\n")}\n`);
  }
}

async function resolveCairo() {
  // Track the newest `X.Y.Z` cairo tag and newest `poppler-X.Y.Z` tag.
  // The poppler 26.x `unique_ptr<Array>` static_assert that previously
  // forced a pin here is now patched at build time — see
  // _patch_poppler_object_h in build-deps.sh — so the cairo backend's
  // CairoOutputDev.cc, CairoFontEngine.cc, CairoRescaleBox.cc all
  // compile against fresh poppler again. CAIRO_TAG / POPPLER_TAG env
  // vars still override for manual pinning; the hardcoded fallbacks
  // fire only if gitlab.freedesktop.org is briefly unreachable.
  let cairoTag = process.env.CAIRO_TAG;
  if (!cairoTag) {
    try {
      cairoTag = latestGitTag(
        "https://gitlab.freedesktop.org/cairo/cairo.git",
        "refs/tags/*",
        /^\d+\.\d+\.\d+$/,
      );
    } catch (err) {
      cairoTag = "1.18.2";
      console.warn(
        `cairo: tag resolve failed (${err.message}); using ${cairoTag}`,
      );
    }
  }
  let popplerTag = process.env.POPPLER_TAG;
  if (!popplerTag) {
    try {
      popplerTag = latestGitTag(
        "https://gitlab.freedesktop.org/poppler/poppler.git",
        "refs/tags/poppler-*",
        /^poppler-\d+\.\d+\.\d+$/,
        (tag) => tag.replace(/^poppler-/, ""),
      );
    } catch (err) {
      popplerTag = "poppler-24.10.0";
      console.warn(
        `cairo: poppler tag resolve failed (${err.message}); using ${popplerTag}`,
      );
    }
  }
  return {
    fingerprint: `cairo=${cairoTag};poppler=${popplerTag}`,
    values: {
      cairo_tag: cairoTag,
      poppler_tag: popplerTag,
    },
  };
}

async function resolveMupdf() {
  // Pinned. mupdf >=1.26.2 added `-fwasm-exceptions -sSUPPORT_LONGJMP=
  // wasm` to its OS=wasm Makerules. That's a correct upstream choice but
  // the wasm it produces doesn't load cleanly in our browser stack
  // against the current emsdk's legacy-EH C++ runtime (LinkError on the
  // generated JS imports). 1.26.1 is the last release before that
  // switch — keep the pin until either emsdk's runtime catches up or
  // we have a working wasm-EH path. Bump in lockstep with the
  // MUPDF_REF fallback in scripts/build-mupdf.sh.
  let ref = process.env.MUPDF_REF || "1.26.1";
  // Match the build's fingerprint shape (`mupdf=<commit-SHA>`) so the
  // cron-skip comparison in publishedFingerprint() actually succeeds.
  const commit = resolveGitHead(
    "https://github.com/ArtifexSoftware/mupdf.git",
    ref,
  );
  return {
    fingerprint: `mupdf=${commit}`,
    values: {
      mupdf_ref: ref,
      mupdf_commit: commit,
    },
  };
}

async function resolveXpdf() {
  // xpdfreader.com serves an incomplete TLS chain (missing the AlphaSSL
  // intermediate), so both Node's fetch and the runner's curl reject it.
  // Browsers AIA-walk to fetch the missing cert; we don't have a clean way
  // to do that, and xpdf bumps roughly once a year. Pin the version, allow
  // an XPDF_VERSION env override for manual bumps, and only auto-resolve
  // when explicitly opted in.
  const fallback = "4.06";
  let version = process.env.XPDF_VERSION || fallback;
  if (process.env.XPDF_RESOLVE_FROM_WEB === "1") {
    try {
      const html = await fetchText("https://www.xpdfreader.com/download.html");
      const versions = [
        ...html.matchAll(/xpdf-(\d+\.\d+(?:\.\d+)?)\.tar\.gz/g),
      ].map((match) => match[1]);
      if (versions.length) {
        version = latestVersion([...new Set(versions)]);
      }
    } catch (err) {
      console.warn(
        `xpdf: web resolve failed (${err.message}); using ${version}`,
      );
    }
  }
  return {
    fingerprint: `xpdf=${version}`,
    values: {
      xpdf_version: version,
    },
  };
}

async function resolveGhostscript() {
  const json = await fetchJson(
    "https://registry.npmjs.org/ghostscript-wasm-esm/latest",
  );
  return {
    fingerprint: `ghostscript-wasm-esm=${json.version}`,
    values: {
      gs_wasm_esm_version: json.version,
    },
  };
}

async function resolvePdfbox() {
  const version = await latestMavenVersion("org/apache/pdfbox", "pdfbox-app");
  return {
    fingerprint: `pdfbox=${version}`,
    values: {
      pdfbox_version: version,
    },
  };
}

// Resolve the latest commit on a remote ref (branch, tag, or HEAD).
function resolveGitHead(repo, ref) {
  const lines = run("git", ["ls-remote", repo, ref])
    .split("\n")
    .filter(Boolean);
  if (!lines.length) {
    throw new Error(`could not resolve ${ref} in ${repo}`);
  }
  return lines[0].split(/\s+/)[0];
}

async function resolvePdfium() {
  const pdfiumRef = process.env.PDFIUM_REF || "main";
  const fastFloatRef = process.env.FAST_FLOAT_REF || "HEAD";
  const abseilRef = process.env.ABSEIL_REF || "HEAD";
  const dragonboxRef = process.env.DRAGONBOX_REF || "HEAD";
  const pdfium = resolveGitHead(
    "https://pdfium.googlesource.com/pdfium.git",
    pdfiumRef,
  );
  const fastFloat = resolveGitHead(
    "https://github.com/fastfloat/fast_float.git",
    fastFloatRef,
  );
  const abseil = resolveGitHead(
    "https://github.com/abseil/abseil-cpp.git",
    abseilRef,
  );
  const dragonbox = resolveGitHead(
    "https://github.com/jk-jeon/dragonbox.git",
    dragonboxRef,
  );
  return {
    fingerprint: `pdfium=${pdfium};fast_float=${fastFloat};abseil=${abseil};dragonbox=${dragonbox}`,
    values: {
      pdfium_ref: pdfiumRef,
      pdfium_commit: pdfium,
      fast_float_ref: fastFloatRef,
      fast_float_commit: fastFloat,
      abseil_ref: abseilRef,
      abseil_commit: abseil,
      dragonbox_ref: dragonboxRef,
      dragonbox_commit: dragonbox,
    },
  };
}

async function resolveButteraugli() {
  const ref = process.env.BUTTERAUGLI_REF || "HEAD";
  const commit = resolveGitHead(
    "https://github.com/google/butteraugli.git",
    ref,
  );
  return {
    fingerprint: `butteraugli=${commit}`,
    values: { butteraugli_ref: ref, butteraugli_commit: commit },
  };
}

async function resolveFlip() {
  const ref = process.env.FLIP_REF || "HEAD";
  const commit = resolveGitHead("https://github.com/NVlabs/flip.git", ref);
  return {
    fingerprint: `flip=${commit}`,
    values: { flip_ref: ref, flip_commit: commit },
  };
}

async function resolvePdfjs() {
  const ref = process.env.PDFJS_REF || "master";
  const commit = resolveGitHead(
    "https://github.com/mozilla/pdf.js.git",
    `refs/heads/${ref}`,
  );
  return {
    fingerprint: `pdfjs=${commit}`,
    values: { pdfjs_ref: ref, pdfjs_commit: commit },
  };
}

async function resolveSplash() {
  // Track the newest `poppler-X.Y.Z` tag. The splash renderer uses
  // poppler's in-tree Splash backend and ensure_poppler_nocairo() never
  // compiles the cairo backend, so this can move ahead of resolveCairo's
  // poppler-24.10.0 pin (cairo's pin is held back by a libc++/
  // unique_ptr<Array> regression in CairoOutputDev compilation against
  // newer poppler). `POPPLER_TAG` still overrides for manual pinning;
  // the hardcoded fallback only fires if gitlab.freedesktop.org is
  // briefly unreachable from the runner.
  let popplerTag = process.env.POPPLER_TAG;
  if (!popplerTag) {
    try {
      popplerTag = latestGitTag(
        "https://gitlab.freedesktop.org/poppler/poppler.git",
        "refs/tags/poppler-*",
        /^poppler-\d+\.\d+\.\d+$/,
        (tag) => tag.replace(/^poppler-/, ""),
      );
    } catch (err) {
      popplerTag = "poppler-24.10.0";
      console.warn(
        `splash: poppler tag resolve failed (${err.message}); using ${popplerTag}`,
      );
    }
  }
  return {
    fingerprint: `splash=${popplerTag}`,
    values: { poppler_tag: popplerTag },
  };
}

async function resolveDssim() {
  const json = await fetchJson("https://crates.io/api/v1/crates/dssim-core");
  const version = json.crate?.max_stable_version || json.crate?.newest_version;
  if (!version) {
    throw new Error("no crates.io version found for dssim-core");
  }
  return {
    fingerprint: `dssim-core=${version}`,
    values: {
      dssim_core_version: version,
    },
  };
}

const resolved = await TARGETS[target]();
const published = await publishedFingerprint(target);
const changed =
  process.env.GITHUB_EVENT_NAME !== "schedule" ||
  resolved.fingerprint !== published;

console.log(`${target} upstream: ${resolved.fingerprint}`);
console.log(`published: ${published || "none"}`);
console.log(`changed: ${changed}`);

writeOutputs(target, {
  changed,
  fingerprint: resolved.fingerprint,
  ...resolved.values,
});
