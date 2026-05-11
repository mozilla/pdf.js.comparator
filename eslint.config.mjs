import js from "@eslint/js";

const emscriptenLibraryGlobals = {
  console: "readonly",
  HEAPU8: "readonly",
  LibraryManager: "readonly",
  mergeInto: "readonly",
  Module: "readonly",
};

const workerGlobals = {
  cheerpOSAddStringFile: "readonly",
  cheerpjAddStringFile: "readonly",
  cheerpjInit: "readonly",
  cheerpjRunLibrary: "readonly",
  console: "readonly",
  fetch: "readonly",
  importScripts: "readonly",
  performance: "readonly",
  self: "readonly",
  TextDecoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "out/**"],
  },
  js.configs.recommended,
  {
    files: ["build.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
  },
  {
    files: ["src/common/myjs.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: emscriptenLibraryGlobals,
    },
  },
  {
    files: ["workers/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: workerGlobals,
    },
  },
];
