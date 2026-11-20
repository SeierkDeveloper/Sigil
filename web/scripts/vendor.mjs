// Builds what the pages load at runtime for search by meaning and for voice,
// into public/vendor (not committed): the two model workers, each bundled with
// the tokenizer and the ONNX runtime, and the runtime's WebAssembly file. Everything is
// served from this site, so the content security policy can stay same-origin.

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const out = path.join(web, "public", "vendor");
mkdirSync(out, { recursive: true });

for (const [entry, file] of [
  ["src/semantic/embed-worker.ts", "embed-worker.js"],
  // The speech model's worker: loaded only when someone turns voice on.
  ["src/voice/speech-worker.ts", "speech-worker.js"],
]) {
  await build({
    entryPoints: [path.join(web, entry)],
    outfile: path.join(out, file),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
}

const require = createRequire(path.join(web, "package.json"));
// The package's "require" entry is dist/ort.min.js; the WebAssembly files sit next to it.
const ortDist = path.dirname(require.resolve("onnxruntime-web"));
for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) copyFileSync(path.join(ortDist, f), path.join(out, f));
console.log("built public/vendor: embed-worker.js, speech-worker.js and the WebAssembly runtime");
