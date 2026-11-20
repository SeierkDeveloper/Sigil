// Builds what the vault page loads at runtime for search by meaning, into
// public/vendor (not committed): the model worker, bundled with the tokenizer
// and the ONNX runtime, and the runtime's WebAssembly file. Everything is
// served from this site, so the content security policy can stay same-origin.

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const out = path.join(web, "public", "vendor");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(web, "src/semantic/embed-worker.ts")],
  outfile: path.join(out, "embed-worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

const require = createRequire(path.join(web, "package.json"));
// The package's "require" entry is dist/ort.min.js; the WebAssembly files sit next to it.
const ortDist = path.dirname(require.resolve("onnxruntime-web"));
for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) copyFileSync(path.join(ortDist, f), path.join(out, f));
console.log("built public/vendor: embed-worker.js and the WebAssembly runtime");
