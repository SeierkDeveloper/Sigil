// Builds a loadable unpacked Chrome extension into dist/:
//   npm run build -w sigil-extension
// then chrome://extensions, Developer mode, Load unpacked, choose extension/dist.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const out = path.join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: "browser", target: "chrome120", legalComments: "none", logLevel: "warning", minify: false };
await build({ ...common, entryPoints: [path.join(here, "src/background.ts")], outfile: path.join(out, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [path.join(here, "src/content.ts")], outfile: path.join(out, "content.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(here, "src/popup.ts")], outfile: path.join(out, "popup.js"), format: "esm" });
await build({ ...common, entryPoints: [path.join(here, "src/options.ts")], outfile: path.join(out, "options.js"), format: "esm" });
cpSync(path.join(here, "static"), out, { recursive: true });
// The site's own typefaces (SIL Open Font License), so the popup reads like the vault. Nothing is fetched at run time.
const fonts = path.join(here, "../web/src/fonts");
mkdirSync(path.join(out, "fonts"), { recursive: true });
for (const f of ["display-roman.woff2", "sans-roman.woff2", "mono-400.woff2", "OFL-display.txt", "OFL-sans.txt", "OFL-mono.txt"]) cpSync(path.join(fonts, f), path.join(out, "fonts", f));
console.log("built extension/dist (load it unpacked in chrome://extensions)");
