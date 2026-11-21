#!/usr/bin/env node
// Runs one go-live check against real services with the owner's own credentials.
//
//   node scripts/live-checks/run.mjs <check> [options]
//
// Checks: health, oauth-google, oauth-slack, storage, connector, speech-model, capture.
// Each reads what it needs from the environment, or asks for it on the terminal
// without echoing it. No check prints a secret: tokens and keys show as their
// length only. These scripts are never run by npm test or CI. See docs/GO-LIVE-CHECKS.md.

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHECKS = ["health", "oauth-google", "oauth-slack", "storage", "connector", "speech-model", "capture"];
const name = process.argv[2];
if (!CHECKS.includes(name)) {
  process.stderr.write(`Usage: node scripts/live-checks/run.mjs <${CHECKS.join("|")}>\n`);
  process.exit(2);
}
if (process.env.CI) {
  process.stderr.write("Live checks talk to real services and never run in CI.\n");
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const dir = mkdtempSync(path.join(tmpdir(), "sigil-live-check-"));
const out = path.join(dir, `${name}.mjs`);
try {
  await build({
    entryPoints: [path.join(here, `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    logLevel: "error",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    external: ["onnxruntime-web", "@huggingface/tokenizers", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
  });
  await import(pathToFileURL(out).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
