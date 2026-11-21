// Draws the share image (1200 by 630) that links to the site show: the mark and
// the tagline on black, with the logo's line language. Everything is drawn here
// from brand/sigil-logo.png, the site's own typefaces and a few lines of SVG.
// Run with: node scripts/share-image.mjs (the two output files are committed).
// The typefaces are kept as .woff2, which the text renderer cannot open, so they
// are unpacked to a temporary folder first: that step needs python3 with
// fonttools and brotli (pip install fonttools brotli).

import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
// The tagline is the site's own (src/lib/site.ts), set on three lines.
const site = { tagline: /tagline:\s*"([^"]+)"/.exec(readFileSync(path.join(web, "src", "lib", "site.ts"), "utf8"))[1] };
const W = 1200;
const H = 630;
const GROUND = "#040404";

const unpacked = mkdtempSync(path.join(tmpdir(), "sigil-fonts-"));
const UNPACK = `
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
f = TTFont(sys.argv[1])
if len(sys.argv) > 3:
    f = instancer.instantiateVariableFont(f, {a.split("=")[0]: float(a.split("=")[1]) for a in sys.argv[3:]})
# The renderer finds a face by its family name, and reads a word such as Light in it as a weight: one plain name.
if "Garamond" in str(f["name"].getDebugName(1)):
    for record in f["name"].names:
        if record.nameID in (1, 4, 16):
            record.string = "Sigil Display"
        elif record.nameID in (2, 17):
            record.string = "Regular"
f.flavor = None
f.save(sys.argv[2])
`;
/** One of the site's typefaces, unpacked from .woff2 to a file the text renderer reads; a variable face is fixed at the given axes. */
function font(file, ...axes) {
  const out = path.join(unpacked, file.replace(/\.woff2$/, ".ttf"));
  execFileSync("python3", ["-c", UNPACK, path.join(web, "src", "fonts", file), out, ...axes]);
  return out;
}
// The renderer reads font files only through fontconfig.
process.env.PANGOCAIRO_BACKEND = "fontconfig";

// One bend of a ribbon, 22 fine lines, as in the corner of every inner page (--ribbon in identity.css).
const ribbon = Array.from({ length: 22 }, (_, i) => {
  const r = 190 - i * 6;
  const o = i === 0 || i === 21 ? 0.9 : 0.73 - (i - 1) * 0.0205;
  return `<path d="M600 ${48 + i * 6}H330A${r} ${r} 0 0 0 ${140 + i * 6} 238V480" opacity="${o.toFixed(2)}"/>`;
}).join("");

/** A bundle of fine lines with angled ends: `n` lines, one every 2 px, leaning by `cut`. */
function bundle(x, y, width, n, cut, opacity) {
  let out = "";
  for (let i = 0; i < n; i++) {
    const lean = cut * (1 - (i * 2) / ((n - 1) * 2 || 1));
    out += `<path d="M${(x + lean).toFixed(1)} ${y + i * 2 + 0.5}h${width}"/>`;
  }
  return `<g stroke="#eeeeee" stroke-width="1" opacity="${opacity}">${out}</g>`;
}

const lines = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="1200" y1="0" x2="700" y2="560">
      <stop offset="0.06" stop-color="#fff"/>
      <stop offset="0.8" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="corner"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
  </defs>
  <g mask="url(#corner)" opacity="0.42">
    <g transform="translate(456 0) scale(1.24)" fill="none" stroke="#fff" stroke-width="0.9">${ribbon}</g>
  </g>
  <path d="M72 ${H - 72.5}H${W - 72}" stroke="#fff" stroke-opacity="0.16"/>
  ${bundle(72, H - 77, 132, 5, 8, 0.75)}
  ${bundle(520, 187, 34, 3, 4, 0.8)}
</svg>`;

/** A line of text as its own picture, set in one of the site's typefaces. */
async function text(markup, fontName, fontfile, size) {
  // Drawn at three times the size and brought down, so hairlines keep their weight.
  const big = await sharp({ text: { text: markup, font: `${fontName} ${size}`, fontfile, rgba: true, dpi: 216 } }).png().toBuffer({ resolveWithObject: true });
  const { data, info } = await sharp(big.data).resize(Math.round(big.info.width / 3)).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

// The mark, cut square around its lines (the same search as scripts/icons.mjs).
const source = path.join(web, "brand", "sigil-logo.png");
const { data, info } = await sharp(source).greyscale().raw().toBuffer({ resolveWithObject: true });
let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[y * info.width + x] > 60) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
}
const side = Math.min(Math.round((Math.max(x1 - x0, y1 - y0) + 1) / 0.92), info.width, info.height);
const MARK = 330;
const mark = await sharp(source)
  .extract({ left: Math.round((x0 + x1) / 2 - side / 2), top: Math.round((y0 + y1) / 2 - side / 2), width: side, height: side })
  .resize(MARK, MARK)
  .png()
  .toBuffer();

const mono = font("mono-400.woff2");
const name = await text(`<span foreground="#c9c9c9" letter_spacing="${Math.round(22 * 0.2 * 1024)}">SIGIL</span>`, "DM Mono", mono, 22);
const display = font("display-roman.woff2", "wght=500");
const tagline = [];
for (const line of site.tagline.replace(/, /g, ",\n").split("\n")) tagline.push(await text(`<span foreground="#f4f4f4">${line}</span>`, "Sigil Display", display, 88));
const foot = await text(`<span foreground="#7b7b7b" letter_spacing="${Math.round(15 * 0.16 * 1024)}">ENCRYPTED ON YOUR DEVICE   OPEN SOURCE   OPEN STANDARD</span>`, "DM Mono", mono, 15);

const TEXT_X = 520;
const image = await sharp({ create: { width: W, height: H, channels: 3, background: GROUND } })
  .composite([
    { input: Buffer.from(lines), left: 0, top: 0 },
    { input: mark, left: 108, top: Math.round((H - 72 - MARK) / 2) + 6, blend: "lighten" },
    { input: name.input, left: TEXT_X + 50, top: 190 - Math.round(name.height / 2) },
    ...tagline.map((t, i) => ({ input: t.input, left: TEXT_X - 3, top: 222 + i * 88 })),
    { input: foot.input, left: W - 72 - foot.width, top: H - 72 + 18 },
  ])
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toBuffer();

for (const file of ["opengraph-image.png", "twitter-image.png"]) {
  await sharp(image).toFile(path.join(web, "src", "app", file));
  console.log(file);
}
rmSync(unpacked, { recursive: true, force: true });
