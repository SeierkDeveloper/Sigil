import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Installed as normal dependencies; everything else (the Sigil core) is bundled in.
  external: ["@modelcontextprotocol/sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync("dist/index.js", 0o755);
console.log("built dist/index.js");
