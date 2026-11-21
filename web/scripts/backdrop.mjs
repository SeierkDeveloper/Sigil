// Draws the still frame of the page ground: public/backdrop-land.svg.
// The same land as the ground in motion (src/components/backdrop/groundShader.ts):
// two far hills cut with lines that follow their backs, a field ruled toward
// the viewer, and tufts of grass, standing still. It is what shows before the
// ground in motion runs, and instead of it with reduced motion or without a
// graphics card (components/backdrop/Backdrop.tsx). Run: node scripts/backdrop.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { rng } from "./engrave/plate.mjs";

// The shapes, as in groundShader.ts (LAND, GRASS, STRENGTH). Keep the two in step.
const far = (x) => -52 - 30 * Math.sin(x * 0.0021 + 1.3) - 12 * Math.sin(x * 0.0057 + 4.0);
const near = (x) => -20 - 22 * Math.sin(x * 0.003 + 3.6) - 7 * Math.sin(x * 0.0083 + 0.7);
const field = (x) => 6 * Math.sin(x * 0.0024 + 2.2) + 3 * Math.sin(x * 0.0071);
const GRASS = [
  [8, 4.5, 8],
  [24, 6.5, 11],
  [52, 9, 15],
  [98, 12.5, 21],
];

const W = 2400;
const TOP = -110;
const BOTTOM = 230;
const r = rng(4);
const n1 = (v) => v.toFixed(1);
const out = [];
const cut = (d, opacity, width = 1) => out.push(`<path d="${d}" stroke-opacity="${opacity.toFixed(2)}"${width === 1 ? "" : ` stroke-width="${width}"`}/>`);

/** A line along `y(x)`, broken where `on(x)` says so. */
function run(y, on) {
  let d = "";
  let pen = false;
  for (let x = 0; x <= W; x += 12) {
    const yy = y(x);
    const draw = on(x) && yy < BOTTOM;
    if (draw) d += `${pen ? "L" : "M"}${x} ${n1(yy - TOP)}`;
    pen = draw;
  }
  return d;
}

// the hills: the crest whole, the lines under it broken, fading as they go down
for (const [crest, below, tone, seed] of [
  [far, near, 0.15, 11],
  [near, field, 0.2, 29],
]) {
  for (let n = 0; n < 16; n++) {
    const depth = 2.7 * (n + 0.05 * n * n);
    const a = 0.013 + 0.009 * r();
    const b = r() * 6.28 + seed;
    const d = run(
      (x) => crest(x) + depth,
      (x) => crest(x) + depth < below(x) && (n === 0 || Math.sin(x * a + b) > -0.1),
    );
    if (d) cut(d, tone * (n === 0 ? 1 : Math.exp(-depth / 46)));
  }
}
// the field, ruled level, wider apart toward the viewer
for (let n = 0; n < 26; n++) {
  const depth = 24 * (Math.exp(n / 10) - 1);
  if (depth > BOTTOM) break;
  const a = 0.017 + 0.012 * r();
  const b = r() * 6.28;
  cut(
    run(
      (x) => field(x) + depth + 0.6 * Math.sin(x * 0.013 + depth * 0.05) * ((24 + depth) / 10) * 0.3,
      (x) => n === 0 || Math.sin(x * a + b) > -0.15,
    ),
    0.09,
  );
}
// grass, row behind row
GRASS.forEach(([at, tall, apart], row) => {
  let d = "";
  for (let c = 0; c < W / apart; c++) {
    if (r() < 0.5) continue;
    const foot = (c + 0.3 + 0.4 * r()) * apart;
    const y0 = field(foot) + at - 1.6 * tall * r();
    for (let b = 0; b < 3; b++) {
      const height = tall * (0.55 + 0.45 * r());
      const lean = (r() - 0.5) * 0.9;
      const bx = foot + (b - 1) * 0.2 * tall;
      d += `M${n1(bx)} ${n1(y0 - TOP)}Q${n1(bx + height * lean * 0.25)} ${n1(y0 - TOP - height * 0.5)} ${n1(bx + height * lean)} ${n1(y0 - TOP - height)}`;
    }
  }
  cut(d, 0.2 * (0.62 + 0.38 * (row / (GRASS.length - 1))), 1);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${BOTTOM - TOP}" fill="none" preserveAspectRatio="xMidYMin slice">
<g stroke="#fff" stroke-width="1" stroke-linecap="round">
${out.join("\n")}
</g>
</svg>
`;
writeFileSync(path.resolve(import.meta.dirname, "../public/backdrop-land.svg"), svg);
console.log("backdrop-land.svg", `${Math.round(svg.length / 1024)} kB`);
