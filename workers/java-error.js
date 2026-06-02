// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

// Shared helpers for CheerpJ-backed workers (pdfbox). CheerpJ
// throws Promise-wrapped proxies of Java Throwables; turning them into a
// human-readable string takes a multi-step unwrap. Loaded via importScripts;
// exposes self.JavaError = { unwrap, stackTrace, message }.
//
// Everything is wrapped in an IIFE so top-level `const`s don't enter the
// worker's shared lexical scope — otherwise a `const javaErrorMessage =
// self.JavaError.message` in the consumer would collide with a same-named
// const declared here.

(() => {
  const unwrap = async (err) => {
    let real = err;
    for (let depth = 0; depth < 16; ++depth) {
      if (!real || typeof real.then !== "function") break;
      try {
        real = await real;
      } catch (e) {
        real = e;
      }
    }
    return real;
  };

  const stackTrace = async (err) => {
    if (!err || typeof err.getStackTrace !== "function") {
      return "";
    }
    try {
      const stack = await err.getStackTrace();
      const frameCount = Math.min(stack?.length || 0, 12);
      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        frames.push(`    at ${await stack[i].toString()}`);
      }
      return frames.length ? `\n${frames.join("\n")}` : "";
    } catch {
      return "";
    }
  };

  const message = async (err) => {
    let real = await unwrap(err);
    try {
      if (real && typeof real.getMessage === "function") {
        const parts = [];
        for (let depth = 0; real && depth < 4; depth++) {
          const cls =
            typeof real.getClass === "function"
              ? await (await real.getClass()).getName()
              : "?";
          const m = await real.getMessage();
          parts.push(
            `${depth ? "Caused by: " : ""}Java ${cls}: ${m}${await stackTrace(real)}`,
          );

          if (typeof real.getCause !== "function") break;
          const cause = await real.getCause();
          if (!cause || cause === real) break;
          real = cause;
        }
        return parts.join("\n");
      }
      if (real?.message) return String(real.message);
      if (real?.stack) return String(real.stack);
      return String(real);
    } catch (e) {
      return `(error extracting Java details: ${e?.message || e})`;
    }
  };

  self.JavaError = { unwrap, stackTrace, message };
})();
