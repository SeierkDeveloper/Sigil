// Makes every logo file the site needs from the one logo in brand/sigil-logo.png
// (a white mark on black): the header mark with a clear background, the favicon,
// the Apple touch icon and the app icons for the phone and the home screen.
// Run with: node scripts/icons.mjs (the output files are committed).

import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const source = path.join(web, "brand", "sigil-logo.png");
const icons = path.join(web, "public", "icons");
mkdirSync(icons, { recursive: true });

// Where the mark sits in the source: everything brighter than the black ground.
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
const side = Math.max(x1 - x0, y1 - y0) + 1;
const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);

/** A square crop around the mark, where the mark fills `fill` of the side. */
function square(fill) {
  const s = Math.min(Math.round(side / fill), info.width, info.height);
  const left = Math.max(0, Math.min(info.width - s, cx - Math.round(s / 2)));
  const top = Math.max(0, Math.min(info.height - s, cy - Math.round(s / 2)));
  return sharp(source).extract({ left, top, width: s, height: s });
}

// The header mark: white, with the brightness of each pixel as its opacity, so it sits on any dark ground.
{
  const s = square(0.98);
  const grey = await s.clone().greyscale().resize(256, 256).raw().toBuffer();
  const rgba = Buffer.alloc(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = Math.min(255, Math.round(grey[i] * 1.08));
  }
  await sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }).png().toFile(path.join(web, "public", "logo.png"));
  console.log("logo.png");
}

const jobs = [
  // Favicon and the Apple touch icon, picked up by Next from the app folder.
  [path.join(web, "src", "app", "icon.png"), 0.74, 512],
  [path.join(web, "src", "app", "apple-icon.png"), 0.66, 180],
  // App icons for the install manifest; the maskable one keeps the mark inside the middle part Android keeps.
  [path.join(icons, "icon-192.png"), 0.74, 192],
  [path.join(icons, "icon-512.png"), 0.74, 512],
  [path.join(icons, "apple-touch-icon.png"), 0.66, 180],
  [path.join(icons, "icon-maskable-512.png"), 0.52, 512],
];
for (const [file, fill, size] of jobs) {
  await square(fill).resize(size, size).png().toFile(file);
  console.log(path.relative(web, file));
}

// favicon.ico for browsers that ask for it directly: 16, 32 and 48 pixel PNGs inside one ICO file.
{
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map((n) => square(0.8).resize(n, n).ensureAlpha().png().toBuffer()));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(n, e); head.writeUInt8(n, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  writeFileSync(path.join(web, "src", "app", "favicon.ico"), Buffer.concat([head, ...pngs]));
  console.log("src/app/favicon.ico");
}
