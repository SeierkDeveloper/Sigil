// Makes the tone pictures the dotted art is printed from: public/art/dots.
//
// The dotted pictures of the site are halftones. A halftone needs a tone for
// every dot: how much light falls on that spot. The engravings are line, so
// their tone is how much line lies around each spot. This script works that
// out once and saves it small: white, with the tone as its opacity. The page
// then lays a screen of dots over it (the hero does it on the graphics card,
// components/hero/HeroArt.tsx; everything else with a mask, dotted.css), so
// the dots are sharp on any screen and at any size.
//
// tree-light  the oak of the hero (art/tree.webp), its tone
// tree-shade  where the oak stands in front of the sky: black, to hold the sky back
// land        the still page ground, the same land as groundShader.ts
// roots, range  the two wide engravings of the home page
//
// Run: node scripts/halftone.mjs (the output files are committed).
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LAND_STILL, landTone } from "../src/components/backdrop/land.ts";

const web = path.resolve(import.meta.dirname, "..");
const art = path.join(web, "public", "art");
const out = path.join(art, "dots");
mkdirSync(out, { recursive: true });

const clamp = (v) => Math.min(1, Math.max(0, v));

/** How much white line lies at each pixel of a picture, 0 to 1. */
async function lineOf(file, width) {
  const input = sharp(file, { density: 144 });
  const sized = width ? input.resize({ width }) : input;
  const { data, info } = await sized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const tone = new Uint8Array(info.width * info.height);
  for (let i = 0; i < tone.length; i++) {
    const luma = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
    tone[i] = Math.round(luma * data[i * 4 + 3]);
  }
  return { tone, width: info.width, height: info.height };
}

/** The line spread into tone: blurred, made smaller, then lifted by `gain` and bent by `gamma`. */
async function toneOf(line, { blur, width, gain, gamma }) {
  const { data, info } = await sharp(Buffer.from(line.tone), { raw: { width: line.width, height: line.height, channels: 1 } })
    .blur(blur)
    .resize({ width, kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tone = new Float32Array(info.width * info.height);
  for (let i = 0; i < tone.length; i++) tone[i] = clamp(clamp((data[i * info.channels] / 255) * gain) ** gamma);
  return { tone, width: info.width, height: info.height };
}

/** Saved as one flat colour with the tone as its opacity. */
async function save(name, picture, ink = 255) {
  const { tone, width, height } = picture;
  const rgba = Buffer.alloc(width * height * 4, ink);
  for (let i = 0; i < tone.length; i++) rgba[i * 4 + 3] = Math.round(tone[i] * 255);
  const file = path.join(out, `${name}.webp`);
  const info = await sharp(rgba, { raw: { width, height, channels: 4 } }).webp({ quality: 82, alphaQuality: 88, effort: 6 }).toFile(file);
  console.log(`${name}.webp`, `${width} by ${height}`, `${Math.round(info.size / 1024)} kB`);
}

// The oak. Its tone, and a wider, softer shade that holds the sky back behind it.
const tree = await lineOf(path.join(art, "tree.webp"));
await save("tree-light", await toneOf(tree, { blur: 1.6, width: 826, gain: 2.3, gamma: 1.25 }));
await save("tree-shade", await toneOf(tree, { blur: 8, width: 413, gain: 2.2, gamma: 0.9 }), 0);

// The wide engravings.
for (const [name, width, gain] of [
  ["roots", 700, 4.4],
  ["range", 800, 3.8],
]) {
  const line = await lineOf(path.join(art, `${name}.svg`));
  await save(name, await toneOf(line, { blur: 2.4, width, gain, gamma: 1 }));
}

// The still page ground: the land of the ground in motion, standing still.
{
  const { width, top, bottom, step } = LAND_STILL;
  const w = Math.round(width / step);
  const h = Math.round((bottom - top) / step);
  const tone = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) tone[j * w + i] = clamp(landTone((i + 0.5) * step, top + (j + 0.5) * step, step) / 0.3);
  await save("land", { tone, width: w, height: h });
}
