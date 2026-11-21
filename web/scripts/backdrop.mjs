// Draws the still ribbon of the page ground: public/backdrop-ribbon.svg.
// One ribbon of 24 fine parallel lines that leans, bends once and narrows where
// it turns, as in the logo. One edge is brighter than the other, and the lines
// fade out toward both ends, so the file needs no mask and no light on top.
// It is the still frame of the ground: what shows before the ground in motion
// runs, and instead of it with reduced motion or without a graphics card
// (components/backdrop/Backdrop.tsx). Run: node scripts/backdrop.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";

const W = 2000;
const H = 520;
const LINES = 24;
const GAP = 5; // between lines where the ribbon lies flat
const STEP = 20;

const paths = [];
for (let k = 0; k < LINES; k++) {
  const side = k / (LINES - 1) - 0.5;
  const alpha = k === 0 || k === LINES - 1 ? 0.9 : 0.3 + 0.42 * (k / LINES);
  let d = "";
  for (let x = 0; x <= W; x += STEP) {
    const u = (x / W) * Math.PI * 2;
    const centre = H / 2 + 150 * (x / W - 0.5) + 80 * Math.sin(u + 0.6);
    const open = 0.62 + 0.38 * Math.sin(u * 0.8 + 1.9);
    const y = centre + side * (LINES - 1) * GAP * open;
    d += `${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`;
  }
  paths.push(`<path d="${d}" opacity="${alpha.toFixed(2)}"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" fill="none">
<defs><linearGradient id="l" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.2" stop-color="#fff" stop-opacity="0.45"/><stop offset="0.44" stop-color="#fff" stop-opacity="1"/><stop offset="0.72" stop-color="#fff" stop-opacity="0.4"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<g stroke="url(#l)" stroke-width="1" vector-effect="non-scaling-stroke">
${paths.join("\n")}
</g>
</svg>
`;
const out = path.resolve(import.meta.dirname, "../public/backdrop-ribbon.svg");
writeFileSync(out, svg);
console.log(`wrote ${out} (${(svg.length / 1024).toFixed(1)} kB)`);
