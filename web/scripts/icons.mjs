// Draws the app icons for the phone and the home screen from the mark in
// src/app/icon.svg: the same rings and cross, at every size an install needs.
// Run with: node scripts/icons.mjs (the PNG files are committed).

import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const out = path.join(web, "public", "icons");
mkdirSync(out, { recursive: true });
const mark = readFileSync(path.join(web, "src/app/icon.svg"), "utf8").trim();
writeFileSync(path.join(out, "icon.svg"), mark);

// A full-bleed square for the maskable icon and for iOS, which rounds corners itself.
const square = mark.replace('rx="14"', 'rx="0"');
// The maskable icon keeps the mark inside the middle 80 percent, as Android crops to a circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#050506"/><g transform="translate(6.4 6.4) scale(0.8)">${square
  .replace(/^<svg[^>]*>/, "")
  .replace(/<\/svg>$/, "")}</g></svg>`;

const jobs = [
  ["icon-192.png", mark, 192],
  ["icon-512.png", mark, 512],
  ["apple-touch-icon.png", square, 180],
  ["icon-maskable-512.png", maskable, 512],
];
for (const [name, svg, size] of jobs) {
  await sharp(Buffer.from(svg), { density: Math.ceil((72 * size) / 64) })
    .resize(size, size)
    .png()
    .toFile(path.join(out, name));
  console.log(`icons/${name}`);
}
