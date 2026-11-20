// Builds dist/sigil.js: one ES module with the Sigil core bundled in, for web apps.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/sigil.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
});
console.log("built dist/sigil.js");
