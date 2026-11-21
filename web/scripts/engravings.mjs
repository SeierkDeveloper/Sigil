// Cuts the engravings of the site: public/art/*.svg.
//
// Every drawing is made here, line by line, the way an etcher works a plate:
// contour lines that follow the form, lines that swell in the light and run
// out in the shade, cross-hatching where a surface is rough, stipple for soil.
// White line on a clear ground; the page behind it is black. The tools are in
// engrave/plate.mjs. Run: node scripts/engravings.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Plate, clamp, inside, mix, noise, noise2, rng, smooth } from "./engrave/plate.mjs";

const TAU = Math.PI * 2;
const out = path.resolve(import.meta.dirname, "../public/art");
mkdirSync(out, { recursive: true });
const save = (name, plate) => {
  const svg = plate.svg();
  writeFileSync(path.join(out, `${name}.svg`), svg);
  console.log(name, `${Math.round(svg.length / 1024)} kB`);
};

// ------------------------------------------------------------------ a leaf

/**
 * One leaf, drawn from its stalk. `lobes` above zero makes it an oak leaf.
 * Returns its outline, so a ground of lines can be left open around it.
 */
function leaf(p, { x, y, angle, length, width, lobes = 0, bend = 0.08, shade = 1, hatch = 3.2, weight = 1, cover = true }) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rib = (u) => {
    const a = u * length;
    const b = bend * length * Math.sin(Math.PI * u);
    return [x + a * ca - b * sa, y + a * sa + b * ca];
  };
  const half = (u) => {
    if (!lobes) return width * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 0.8) * (1 - 0.22 * u);
    const env = Math.pow(Math.sin(Math.PI * Math.pow(clamp(u), 1.25)), 0.55);
    return width * env * (0.46 + 0.54 * Math.pow(Math.abs(Math.sin(Math.PI * lobes * u)), 0.55));
  };
  const edge = (u, side, k = 1) => {
    const [mx, my] = rib(u);
    const [ax, ay] = rib(Math.min(1, u + 0.01));
    const [bx, by] = rib(Math.max(0, u - 0.01));
    const len = Math.hypot(ax - bx, ay - by) || 1;
    const h = half(u) * k * side;
    return [mx - ((ay - by) / len) * h, my + ((ax - bx) / len) * h];
  };
  const steps = lobes ? 96 : 36;
  const a = [];
  const b = [];
  for (let i = 0; i <= steps; i++) {
    a.push(edge(i / steps, 1));
    b.push(edge(i / steps, -1));
  }
  const poly = [...a, ...b.reverse()];
  if (cover) p.cover(poly);
  // the two edges: the shaded one heavier
  for (const side of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const [ex, ey] = edge(u, side);
      pts.push([ex, ey, weight * (side === shade ? 1.25 : 0.8) * (0.55 + 0.45 * Math.sin(Math.PI * u))]);
    }
    p.swell(pts);
  }
  // the midrib
  const mid = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    mid.push([...rib(u * 0.96), weight * (1.5 - 1.2 * u)]);
  }
  p.swell(mid);
  // veins
  const veins = lobes ? Array.from({ length: lobes }, (_, k) => (k + 0.5) / lobes) : [0.2, 0.33, 0.46, 0.59, 0.72];
  const reach = lobes ? 0.09 : 0.13;
  for (const tip of veins) {
    for (const side of [1, -1]) {
      const from = rib(tip - reach);
      const to = edge(tip, side, 0.9);
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const sag = Math.sin(Math.PI * t) * 0.05 * length * side * (shade ? 0.4 : 0);
        pts.push([mix(from[0], to[0], t) + sag * sa * 0.3, mix(from[1], to[1], t) - sag * ca * 0.3, weight * (0.9 - 0.7 * t)]);
      }
      p.swell(pts);
    }
  }
  // tone: fine lines that lie the way the veins do, close on the lit half, few on the other
  const du = hatch / length;
  for (let u = 0.06; u < 0.9; u += du) {
    for (const side of [1, -1]) {
      const lit = side !== shade;
      if (!lit && Math.round(u / du) % 3) continue;
      const from = rib(u);
      const k = lit ? 0.92 : 0.5;
      const to = edge(Math.min(0.98, u + reach), side, k);
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push([mix(from[0], to[0], t), mix(from[1], to[1], t), weight * (lit ? 0.75 - 0.5 * t : 0.5 - 0.3 * t)]);
      }
      p.swell(pts, lit ? 0.85 : 0.6);
    }
  }
  return poly;
}

/** A tuft of grass: a few blades from one foot. */
function tuft(p, r, x, y, size = 10, blades = 5) {
  for (let i = 0; i < blades; i++) {
    const lean = (r() - 0.5) * 1.3;
    const h = size * (0.55 + 0.6 * r());
    const pts = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push([x + (r() - 0.5) * 0.4 + lean * h * t * t * 0.55 + (i - blades / 2) * 0.9, y - h * t, 1.05 - 0.9 * t]);
    }
    p.swell(pts);
  }
}

// ------------------------------------------------------------------ the cut trunk

// The rings of a felled oak, one line for each year: close in the lean years,
// wide in the good ones, pushed out of round where a branch once pulled. Two
// drying cracks run out from the pith, and short strokes stand for the bark.
function rings() {
  const S = 600;
  const p = new Plate(S, S);
  const r = rng(11);
  const years = 34;
  const cx = S / 2 + 10;
  const cy = S / 2 + 6;
  const gap = noise(3);
  const wob = noise2(5);
  const cut = noise2(9);
  const waves = Array.from({ length: 5 }, (_, k) => ({ k: k + 1, amp: (r() * 0.5 + 0.5) / (k + 1.4), at: r() * TAU }));
  const shape = (th) => waves.reduce((s, w) => s + w.amp * Math.sin(w.k * th + w.at), 0);
  const cracks = [
    { at: -0.62, from: 0.1, to: 1.03, open: 0.026 },
    { at: 2.9, from: 0.52, to: 1.03, open: 0.016 },
  ];
  const radius = [];
  let at = 5;
  for (let i = 0; i < years; i++) {
    at += 6.4 * (0.5 + 0.55 * (gap(i * 0.6) + 1)) * (i < 4 ? 1.3 : 1);
    radius.push(at);
  }
  const full = radius[years - 1];
  const edge = (i, th) => {
    const t = radius[i] / full;
    return radius[i] * (1 + 0.085 * Math.pow(t, 1.3) * shape(th) + 0.01 * wob(Math.cos(th) * 3 + i * 0.37, Math.sin(th) * 3));
  };
  const cracked = (th, rr) => {
    for (const c of cracks) {
      let d = Math.abs(((th - c.at + Math.PI * 3) % TAU) - Math.PI);
      const t = (rr / full - c.from) / (c.to - c.from);
      if (t > 0 && d < c.open * Math.pow(t, 0.7) * (full / rr) * 0.9) return true;
    }
    return false;
  };
  for (let i = 0; i < years; i++) {
    const steps = Math.max(40, Math.round((TAU * radius[i]) / 5.5));
    const bold = i % 5 === 4 ? 1.45 : 1;
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const th = (k / steps) * TAU + i * 2.4;
      const rr = edge(i, th);
      // the light falls from the upper left, so each ring is heaviest there
      const light = 0.5 + 0.5 * Math.cos(th + 2.3);
      let w = bold * (0.55 + 0.85 * light) * (0.9 + 0.25 * cut(Math.cos(th) * 5 + i * 2.3, Math.sin(th) * 5 - i * 1.1));
      if (cut(Math.cos(th) * 19 + i * 3.7, Math.sin(th) * 19 - i * 2.9) > 0.7) w = 0;
      if (cracked(th, rr)) w = 0;
      pts.push([cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, w]);
    }
    p.swell(pts, i < 2 ? 0.8 : 1);
  }
  // the cracks: two fine edges that part as they run out
  for (const c of cracks) {
    for (const side of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 30; k++) {
        const t = k / 30;
        const rr = full * mix(c.from, c.to, t);
        const th = c.at + side * c.open * Math.pow(t, 0.7) * (full / rr) * 0.9 + 0.02 * wob(t * 6, side);
        pts.push([cx + Math.cos(th) * rr * (1 + 0.085 * Math.pow(rr / full, 1.3) * shape(th)), cy + Math.sin(th) * rr * (1 + 0.085 * Math.pow(rr / full, 1.3) * shape(th)), 0.4 + 0.9 * t]);
      }
      p.swell(pts);
    }
  }
  // the bark: a rough outer edge, and short strokes between it and the last year
  const bark = [];
  const steps = 420;
  for (let k = 0; k <= steps; k++) {
    const th = (k / steps) * TAU;
    const rr = edge(years - 1, th) * (1.055 + 0.012 * wob(Math.cos(th) * 14, Math.sin(th) * 14) + 0.008 * wob(Math.cos(th) * 40, Math.sin(th) * 40));
    const light = 0.5 + 0.5 * Math.cos(th + 2.3);
    bark.push([cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, 1 + 1.3 * light]);
    if (k % 2 === 0) {
      const r0 = edge(years - 1, th) * 1.012;
      const r1 = rr * (0.985 - 0.012 * r());
      const lean = 0.012 * (r() - 0.5);
      p.swell(
        [
          [cx + Math.cos(th) * r0, cy + Math.sin(th) * r0, 0.3],
          [cx + Math.cos(th + lean) * (r0 + r1) * 0.5, cy + Math.sin(th + lean) * (r0 + r1) * 0.5, 0.5 + 0.7 * light],
          [cx + Math.cos(th + 2 * lean) * r1, cy + Math.sin(th + 2 * lean) * r1, 0.3 + 0.6 * light],
        ],
        0.9,
      );
    }
  }
  p.swell(bark);
  p.dot(cx, cy, 1.6);
  save("rings", p);
}

// ------------------------------------------------------------------ the range and the river

// A far range of mountains over a plain, and a river that comes down through
// it toward the viewer. Slopes are cut with lines that run down the fall of the
// rock, close where the light strikes; the foothills carry lines that follow
// their backs; the plain is ruled level, and left bare where the water lies.
function range() {
  const W = 1600;
  const H = 480;
  const p = new Plate(W, H);
  const r = rng(21);
  const plain = 322;

  const ridge = (seed, base, amp, scale, sharp) => {
    const a = noise(seed);
    const b = noise(seed + 1);
    const c = noise(seed + 2);
    return (x) => {
      const u = x / scale;
      const peaks = 1 - Math.abs(a(u));
      const body = Math.pow(peaks, sharp) * 0.66 + (0.5 + 0.5 * b(u * 2.3)) * 0.2 + (1 - Math.abs(c(u * 6.1))) * 0.08 + 0.03 * c(u * 19);
      const lift = 0.55 + 0.45 * Math.sin((x / W) * Math.PI);
      return base - amp * body * lift;
    };
  };

  const layers = [
    { f: ridge(31, 300, 250, 260, 1.9), gap: 2.9, reach: 150, weight: 0.7, tone: 0.6 },
    { f: ridge(47, 316, 190, 210, 2.1), gap: 2.7, reach: 130, weight: 0.85, tone: 0.82 },
    { f: ridge(63, 326, 110, 150, 1.6), gap: 2.6, reach: 80, weight: 0.95, tone: 1 },
  ];
  const fall = noise2(8);
  for (const L of layers) {
    const poly = [];
    for (let x = -10; x <= W + 10; x += 4) poly.push([x, L.f(x)]);
    p.cover([...poly, [W + 10, H], [-10, H]]);
    // the skyline, heavier on the lit flanks
    const sky = [];
    for (let x = 0; x <= W; x += 4) {
      const slope = (L.f(x + 3) - L.f(x - 3)) / 6;
      sky.push([x, L.f(x), L.weight * (slope < 0 ? 1.35 : 0.8)]);
    }
    p.swell(sky, L.tone);
    // the faces: strokes that fall from the ridge, long and close in the light, short and few in the shade
    for (let x = 4; x < W; x += L.gap * (0.8 + 0.4 * r())) {
      const y0 = L.f(x);
      const slope = (L.f(x + 5) - L.f(x - 5)) / 10;
      const lit = slope < -0.05;
      const flat = Math.abs(slope) < 0.12;
      if (!lit && r() < 0.62) continue;
      const dir = lit ? -0.42 - 0.3 * Math.min(1, -slope) : 0.5 + 0.3 * Math.min(1, slope);
      let len = L.reach * (0.35 + 0.65 * (0.5 + 0.5 * fall(x / 37, L.reach))) * (lit ? 1 : 0.42) * (flat ? 0.45 : 1);
      len = Math.min(len, (plain + 14 - y0) * 0.9);
      if (len < 6) continue;
      const pts = [];
      const n = Math.max(3, Math.round(len / 16));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const drift = 5 * fall(x / 21 + t * 1.4, 4.2 + L.reach);
        pts.push([x + dir * len * t + drift * t, y0 + 1.5 + len * t, L.weight * (lit ? 1.7 : 0.7) * (1 - 0.8 * t * t) * (0.75 + 0.5 * r())]);
      }
      p.swell(pts, L.tone);
    }
    // spurs: a rib that comes down from every summit, shaded on its far side
    for (let x = 30; x < W - 30; x += 6) {
      const y0 = L.f(x);
      if (!(y0 < L.f(x - 12) && y0 < L.f(x + 12) && y0 <= L.f(x - 6) && y0 <= L.f(x + 6))) continue;
      if (plain - y0 < 50) continue;
      const len = (plain - y0) * (0.4 + 0.3 * r());
      const pts = [];
      const n = Math.round(len / 7);
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const sx = x + 0.3 * len * t + 16 * fall(x / 9 + t * 2.2, 1.7) * t;
        const sy = y0 + len * t;
        pts.push([sx, sy, L.weight * 1.25 * (1 - 0.85 * t)]);
        if (k % 1 === 0 && k > 0 && k < n) {
          const h = len * 0.2 * (1 - t) + 5;
          p.swell(
            [
              [sx + 1, sy + 1, L.weight * 0.7],
              [sx + h * 0.3, sy + h * 0.55, L.weight * 0.45],
              [sx + h * 0.5, sy + h, 0.2],
            ],
            L.tone * 0.8,
          );
        }
      }
      p.swell(pts, L.tone);
    }
  }

  // the foothills: lines that lie along their backs
  const hills = [
    { f: (x) => 318 - 30 * Math.pow(Math.sin(x / 260 + 0.6) * 0.5 + 0.5, 1.4) - 9 * Math.sin(x / 83 + 2), tone: 0.8 },
    { f: (x) => 330 - 24 * Math.pow(Math.sin(x / 340 + 3.4) * 0.5 + 0.5, 1.2) - 6 * Math.sin(x / 120 + 1), tone: 1 },
  ];
  const brk = noise2(14);
  for (const hill of hills) {
    const poly = [];
    for (let x = -10; x <= W + 10; x += 6) poly.push([x, hill.f(x)]);
    p.cover([...poly, [W + 10, H], [-10, H]]);
    for (let k = 0; k < 9; k++) {
      const depth = k * 3 + k * k * 0.22;
      const pts = [];
      for (let x = 0; x <= W; x += 7) {
        const y = hill.f(x) + depth;
        let w = k === 0 ? 1.1 : 0.95 - 0.08 * k;
        if (k && brk(x / 60 + k * 3.1, k * 0.9) > 0.5 - 0.06 * k) w = 0;
        pts.push([x, y, w]);
      }
      p.swell(pts, hill.tone * (1 - 0.07 * k));
    }
  }

  // the plain, ruled level and closer toward the horizon; the river is left bare
  const bend = noise(77);
  const river = (y) => {
    const t = clamp((y - plain) / (H - plain));
    return { x: 800 + 210 * Math.sin(t * 5.2 + 0.4) * (0.3 + t) + 40 * bend(t * 3), half: 4 + 170 * Math.pow(t, 1.6) };
  };
  p.cover([
    [-10, 334],
    [W + 10, 334],
    [W + 10, H],
    [-10, H],
  ]);
  for (let k = 0, y = plain + 12; y < H - 2; k++, y += 2.3 + k * 0.3) {
    const rv = river(y);
    const pts = [];
    for (let x = 0; x <= W; x += 8) {
      const yy = y + 1.6 * brk(x / 140, k * 0.7) * (1 + k * 0.12);
      const d = Math.abs(x - rv.x) - rv.half;
      let w = 0.55 + 0.05 * k;
      if (brk(x / 46 + k * 5.3, k * 1.3) > 0.42) w = 0;
      if (d < 0) w = 0;
      else if (d < 10 + k) w = Math.max(w, 0.9); // the bank is a firmer stroke
      pts.push([x, yy, w]);
    }
    p.swell(pts, 0.62);
    // the water: a few short level strokes
    if (k > 2) {
      for (let n = 0; n < 1 + k / 3; n++) {
        const x0 = rv.x + (r() * 2 - 1) * rv.half * 0.75;
        const len = 8 + r() * rv.half * 0.55;
        p.swell(
          [
            [x0 - len / 2, y, 0.2],
            [x0, y + 0.4, 0.7],
            [x0 + len / 2, y, 0.2],
          ],
          0.7,
        );
      }
    }
  }
  // the banks
  for (const side of [-1, 1]) {
    const pts = [];
    for (let y = plain + 12; y <= H; y += 5) {
      const rv = river(y);
      pts.push([rv.x + side * rv.half, y, 0.5 + 1.1 * clamp((y - plain) / 150)]);
    }
    p.swell(pts);
  }
  // grass on the near ground
  for (let i = 0; i < 70; i++) {
    const y = mix(plain + 40, H - 6, Math.pow(r(), 0.7));
    const x = r() * W;
    const rv = river(y);
    if (Math.abs(x - rv.x) < rv.half + 8) continue;
    tuft(p, r, x, y, 4 + 16 * ((y - plain) / (H - plain)), 4 + Math.floor(r() * 3));
  }
  p.fade({ left: 0.16, right: 0.16, bottom: 0.3 });
  save("range", p);
}

// ------------------------------------------------------------------ roots

// What holds the tree up: the foot of the trunk at the ground line, and the
// roots going down and far out to both sides. Every root is a round form, so
// it carries short strokes across it that bow the way it grows and thin out
// toward its shaded side. The soil is stipple, closest near the surface.
function roots() {
  const W = 1400;
  const H = 600;
  const p = new Plate(W, H);
  const r = rng(52);
  const turn = noise(90);
  const ground = 46;
  const cx = W / 2;
  const all = [];

  const grow = (x, y, angle, radius, depth, seed) => {
    const pts = [];
    let a = angle;
    const home = angle;
    let rad = radius;
    const life = radius * (depth ? 15 : 21) + 60;
    let travelled = 0;
    while (rad > 0.55 && x > 20 && x < W - 20 && y < H - 12) {
      pts.push([x, y, rad]);
      const t = travelled / life;
      // a root wanders, and levels out as it goes
      a += 0.085 * turn(seed + travelled / 52) + 0.02 * (home * 1.1 - a);
      a = clamp(a, -1.52, 1.52);
      if (y < ground + rad + 14) a *= 0.8;
      x += Math.sin(a) * 7;
      y += Math.cos(a) * 7 * (y > H - 90 ? 0.4 : 1);
      travelled += 7;
      rad = radius * Math.pow(Math.max(0, 1 - t), 0.85);
      if (depth < 2 && rad > 1.6 && travelled > 50 && r() < 0.06 + 0.02 * depth) {
        const side = r() < 0.5 ? -1 : 1;
        grow(x, y, clamp(a + side * (0.4 + 0.4 * r()), -1.5, 1.5), rad * (0.45 + 0.2 * r()), depth + 1, seed + 17.3 * (all.length + 1));
      }
    }
    if (pts.length > 2) all.push({ pts, radius, depth });
  };

  const mains = [-1.47, -1.3, -1.02, -0.66, -0.2, 0.28, 0.7, 1.05, 1.28, 1.46];
  mains.forEach((a, i) => {
    const wide = Math.abs(a) / 1.45;
    grow(cx + a * 46, ground + 30 - wide * 6, a, 13 + 11 * wide + 3 * r(), 0, i * 31.7);
  });

  // soil first: stipple, strata and a few stones, everything the roots pass in front of
  const occupied = (x, y, pad) => {
    for (const root of all) for (const q of root.pts) if ((q[0] - x) ** 2 + (q[1] - y) ** 2 < (q[2] + pad) ** 2) return true;
    return false;
  };
  const strata = noise2(40);
  for (let k = 0; k < 9; k++) {
    const y0 = ground + 60 + k * 52 + 20 * r();
    const pts = [];
    for (let x = 0; x <= W; x += 9) {
      const y = y0 + 12 * strata(x / 180, k * 2.2);
      let w = 0.6;
      if (strata(x / 55 + k * 7, k * 1.7) > -0.05 || occupied(x, y, 5)) w = 0;
      pts.push([x, y, w]);
    }
    p.swell(pts, 0.55);
  }
  for (let i = 0; i < 1500; i++) {
    const y = ground + 4 + Math.pow(r(), 1.9) * (H - ground - 30);
    const x = r() * W;
    if (occupied(x, y, 2.5)) continue;
    p.dot(x, y, 0.45 + 0.5 * r(), 0.75);
  }
  // the roots, the finest first so the stout ones lie in front
  all.sort((u, v) => u.radius - v.radius);
  for (const root of all) {
    const q = root.pts;
    const n = q.length;
    const tangent = (i) => {
      const a = q[Math.max(0, i - 1)];
      const b = q[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    };
    const side = (i, s) => {
      const [tx, ty] = tangent(i);
      return [q[i][0] - ty * q[i][2] * s, q[i][1] + tx * q[i][2] * s];
    };
    if (root.radius < 1.6) {
      p.swell(q.map((v) => [v[0], v[1], v[2] * 1.5]), 0.9);
      continue;
    }
    const left = q.map((_, i) => side(i, 1));
    const right = q.map((_, i) => side(i, -1));
    p.cover([...left, ...right.slice().reverse()]);
    // which edge is in the light: the upper one
    const [tx] = tangent(Math.min(4, n - 1));
    const upper = tx > 0 ? -1 : 1;
    p.swell(q.map((v, i) => [...side(i, upper), 0.8]));
    p.swell(q.map((v, i) => [...side(i, -upper), 1.25]));
    // strokes across the form, bowed forward, heavy at the lit edge and gone before the shade
    for (let i = 1; i < n - 1; i++) {
      const rad = q[i][2];
      if (rad < 2.2) break;
      const reps = rad > 9 ? 2 : 1;
      for (let rep = 0; rep < reps; rep++) {
        const [tx2, ty2] = tangent(i);
        const along = rep * 3.5;
        const reach = 0.5 + 0.38 * r();
        const pts = [];
        for (let k = 0; k <= 4; k++) {
          const s = mix(upper, upper * (1 - 2 * reach), k / 4); // from the lit edge inward
          const bow = (1 - s * s) * rad * 0.42;
          pts.push([q[i][0] - ty2 * rad * s + tx2 * (bow + along), q[i][1] + tx2 * rad * s + ty2 * (bow + along), (0.95 - 0.8 * (k / 4)) * (0.8 + 0.4 * r())]);
        }
        p.swell(pts, 0.92);
      }
    }
    // the grain of the bark along a stout root
    if (root.radius > 10) {
      for (const lane of [-0.35, 0.3]) {
        const pts = [];
        for (let i = 0; i < n; i++) {
          if (q[i][2] < 6) break;
          const [bx, by] = side(i, lane * -upper);
          pts.push([bx, by, turn(i * 0.31 + lane * 9 + root.radius) > 0.1 ? 0 : 0.7]);
        }
        p.swell(pts, 0.8);
      }
    }
  }

  // the foot of the trunk, and the ground line with its grass
  const foot = [];
  for (const s of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      pts.push([cx + s * (58 + 34 * Math.pow(t, 2.4)), t * (ground + 22), 1.5 - 0.5 * t]);
    }
    p.swell(pts);
    foot.push(pts);
  }
  for (let k = -9; k <= 9; k++) {
    const pts = [];
    const x0 = cx + k * 6.1;
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      pts.push([x0 + k * 3.2 * Math.pow(t, 2.2) + 2 * turn(k * 3 + t * 2), t * (ground + 16), turn(k * 5.1 + t * 4) > 0.45 ? 0 : 0.5 + 0.5 * (k < 0 ? 1 : 0.55)]);
    }
    p.swell(pts, 0.85);
  }
  const line = [];
  for (let x = 0; x <= W; x += 8) {
    const near = Math.abs(x - cx) < 96;
    line.push([x, ground + 3 * strata(x / 90, 1.2), near ? 0 : 1.1]);
  }
  p.swell(line);
  for (let i = 0; i < 120; i++) {
    const x = r() * W;
    if (Math.abs(x - cx) < 100) continue;
    tuft(p, r, x, ground + 3 * strata(x / 90, 1.2), 7 + 12 * r(), 4 + Math.floor(r() * 3));
  }
  p.fade({ left: 0.14, right: 0.14, bottom: 0.2 });
  save("roots", p);
}

// ------------------------------------------------------------------ the seed

// An acorn lying on the ground. The nut is turned with strokes across it that
// swell toward the light; the cup is cross-hatched into scales.
function acorn() {
  const S = 260;
  const p = new Plate(S, S);
  const r = rng(7);
  const tilt = -0.62;
  const L = 124;
  const ox = 84;
  const oy = 70;
  const ca = Math.cos(tilt + Math.PI / 2);
  const sa = Math.sin(tilt + Math.PI / 2);
  const at = (t, s, bow = 0) => {
    const a = t * L + bow;
    return [ox + a * ca - s * sa, oy + a * sa + s * ca];
  };
  const nut = (t) => 41 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(t), 0.72)), 0.62) * (t > 0.94 ? mix(1, 0.2, (t - 0.94) / 0.06) : 1);
  const cup = (t) => nut(Math.max(t, 0.16)) * 1.1 + 3;
  const edgeOf = 0.4;

  // the ground: level strokes with a bare patch where the acorn's shadow falls
  for (let k = 0; k < 9; k++) {
    const y = 186 + k * 5.2;
    const pts = [];
    for (let x = 24; x <= 240; x += 6) {
      const shadow = Math.hypot((x - 150) / 62, (y - 196) / 16) < 1;
      const reach = Math.abs(x - 132) / (108 - k * 7);
      pts.push([x, y + 0.6 * Math.sin(x / 9 + k), shadow || reach > 1 || r() < 0.08 ? 0 : 0.75 * (1 - reach * reach)]);
    }
    p.swell(pts, 0.8);
  }
  for (let i = 0; i < 70; i++) p.dot(30 + r() * 200, 180 + r() * 56, 0.5 + 0.4 * r(), 0.7);

  // the nut
  const outline = [];
  for (let i = 0; i <= 60; i++) outline.push(at(edgeOf - 0.02 + (i / 60) * (1.02 - edgeOf), nut(edgeOf - 0.02 + (i / 60) * (1.02 - edgeOf))));
  for (let i = 60; i >= 0; i--) outline.push(at(edgeOf - 0.02 + (i / 60) * (1.02 - edgeOf), -nut(edgeOf - 0.02 + (i / 60) * (1.02 - edgeOf))));
  p.cover(outline);
  for (let t = edgeOf + 0.012; t < 0.985; t += 0.0185) {
    const h = nut(t);
    const pts = [];
    for (let k = 0; k <= 22; k++) {
      const s = -1 + (2 * k) / 22;
      // lit from the upper left: brightest a third of the way in, gone at the far edge
      const light = Math.pow(clamp(Math.cos((s + 0.42) * 1.25)), 1.6) * (0.75 + 0.25 * Math.sin(t * 3));
      const glint = Math.hypot((s + 0.46) / 0.13, (t - 0.62) / 0.16) < 1 ? 0 : 1; // the one spot of gloss stays bare
      pts.push([...at(t, s * h, h * 0.3 * (1 - s * s)), 1.5 * light * (light > 0.13 ? 1 : 0) * (0.5 + 0.5 * glint)]);
    }
    p.swell(pts);
  }
  for (const s of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = edgeOf + (i / 40) * (1.015 - edgeOf);
      pts.push([...at(t, s * nut(t)), s > 0 ? 1.5 : 0.9]);
    }
    p.swell(pts);
  }
  p.swell([[...at(1.0, 0), 1.6], [...at(1.03, 0.6), 1.2], [...at(1.055, 1.2), 0.3]]);

  // the cup: two sets of strokes that cross, one round it and one down it
  const cupLine = [];
  for (let i = 0; i <= 40; i++) cupLine.push(at(0.04 + (i / 40) * (edgeOf - 0.04), cup(0.04 + (i / 40) * (edgeOf - 0.04))));
  for (let i = 40; i >= 0; i--) cupLine.push(at(0.04 + (i / 40) * (edgeOf - 0.04), -cup(0.04 + (i / 40) * (edgeOf - 0.04))));
  p.cover(cupLine);
  for (let t = 0.06; t <= edgeOf + 0.001; t += 0.031) {
    const h = cup(t) * (t < 0.1 ? 0.8 : 1);
    const pts = [];
    for (let k = 0; k <= 22; k++) {
      const s = -1 + (2 * k) / 22;
      const light = 0.3 + 0.7 * Math.pow(clamp(Math.cos((s + 0.42) * 1.2)), 1.3);
      pts.push([...at(t, s * h, h * 0.34 * (1 - s * s)), (t > edgeOf - 0.02 ? 1.7 : 1.15) * light]);
    }
    p.swell(pts);
  }
  for (let k = 0; k <= 15; k++) {
    const s = -0.94 + (1.88 * k) / 15;
    const light = 0.3 + 0.7 * Math.pow(clamp(Math.cos((s + 0.42) * 1.2)), 1.3);
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = 0.06 + (i / 10) * (edgeOf - 0.06);
      const h = cup(t);
      const skew = s + 0.1 * (i / 10 - 0.5);
      pts.push([...at(t, skew * h, h * 0.34 * (1 - skew * skew)), 0.95 * light]);
    }
    p.swell(pts, 0.9);
  }
  for (const s of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= 20; i++) {
      const t = 0.05 + (i / 20) * (edgeOf - 0.05);
      pts.push([...at(t, s * cup(t)), s > 0 ? 1.6 : 1]);
    }
    p.swell(pts);
  }
  // the stalk
  for (const s of [-1, 1]) {
    p.swell([[...at(0.06, s * 5), 1.1], [...at(-0.02, s * 4 - 3), 1], [...at(-0.09, s * 3.4 - 9), 0.9], [...at(-0.13, s * 3 - 15), 0.6]]);
  }
  p.swell([[...at(-0.13, -18), 0.8], [...at(-0.135, -15), 1], [...at(-0.13, -12), 0.8]]);
  save("acorn", p);
}

// ------------------------------------------------------------------ the sapling

// The first year: a stem, a few leaves, the first roots, and the soil it broke.
function sapling() {
  const W = 300;
  const H = 400;
  const p = new Plate(W, H);
  const r = rng(33);
  const ground = 268;
  const stem = (t) => [150 + 16 * Math.sin(t * 2.6) - 6 * t, ground - t * 196];
  const turn = noise(12);

  // soil: a low mound, level strokes below it, stipple, and the first roots
  for (let k = 0; k < 13; k++) {
    const y0 = ground + 7 + k * 6.5;
    const span = 128 - k * 8.2;
    const pts = [];
    for (let x = 150 - span; x <= 150 + span; x += 6) {
      const u = (x - 150) / span;
      const nearRoot = Math.abs(x - 150) < 13 - k * 0.5;
      pts.push([x, y0 + 1.2 * turn(x / 30 + k), nearRoot || turn(x / 13 + k * 4) > 0.5 ? 0 : 0.85 * (1 - u * u)]);
    }
    p.swell(pts, 0.8);
  }
  const mound = [];
  for (let x = 20; x <= 280; x += 5) {
    const u = (x - 150) / 130;
    mound.push([x, ground - 7 * Math.exp(-u * u * 7) + 1.5 * turn(x / 22), Math.abs(x - 150) < 6 ? 0 : 1.3 * (1 - u * u)]);
  }
  p.swell(mound);
  for (let i = 0; i < 240; i++) {
    const a = r() * Math.PI;
    const d = Math.pow(r(), 0.7);
    p.dot(150 + Math.cos(a) * d * 120, ground + 6 + Math.sin(a) * d * 80, 0.45 + 0.45 * r(), 0.7);
  }
  for (const [angle, len, wide] of [[0.1, 92, 2.6], [-0.75, 62, 1.9], [0.8, 68, 1.9], [-1.25, 40, 1.3], [1.3, 44, 1.3]]) {
    let x = 150;
    let y = ground + 2;
    let a = angle;
    const pts = [];
    for (let s = 0; s < len; s += 5) {
      pts.push([x, y, wide * (1 - s / len) + 0.25]);
      a += 0.22 * turn(s / 14 + angle * 9);
      x += Math.sin(a) * 5;
      y += Math.cos(a) * 5;
      if (s > 14 && s % 15 === 0) {
        const side = (s / 15) % 2 ? 1 : -1;
        p.swell([[x, y, 0.8], [x + side * 7, y + 5, 0.55], [x + side * 13, y + 12, 0.2]], 0.9);
      }
    }
    p.swell(pts);
  }

  // leaves behind the stem first
  const leaves = [
    { t: 0.36, angle: -2.72, length: 80, width: 21, shade: 1, bend: 0.1 },
    { t: 0.5, angle: -0.5, length: 88, width: 23, shade: -1, bend: -0.1 },
    { t: 0.68, angle: -2.5, length: 74, width: 19, shade: 1, bend: 0.12 },
    { t: 0.82, angle: -0.72, length: 66, width: 17, shade: -1, bend: -0.1 },
    { t: 1, angle: -1.92, length: 50, width: 12, shade: 1, bend: 0.06 },
    { t: 1, angle: -1.18, length: 44, width: 11, shade: -1, bend: -0.08 },
  ];
  for (const l of leaves) {
    const [x, y] = stem(l.t);
    const stalk = 9;
    const bx = x + Math.cos(l.angle) * stalk;
    const by = y + Math.sin(l.angle) * stalk;
    p.swell([[x, y, 1.3], [bx, by, 1]]);
    leaf(p, { ...l, x: bx, y: by, hatch: 2.7 });
  }
  // the stem: two edges, the shaded one heavier, and a few strokes across it low down
  const edges = [[], []];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const [x, y] = stem(t);
    const half = 3.4 - 2.4 * t;
    edges[0].push([x - half, y, 0.85]);
    edges[1].push([x + half, y, 1.3]);
  }
  p.cover([...edges[0], ...edges[1].slice().reverse()]);
  p.swell(edges[0]);
  p.swell(edges[1]);
  for (let i = 1; i < 26; i++) {
    const t = i / 40;
    const [x, y] = stem(t);
    const half = 3.4 - 2.4 * t;
    p.swell([[x + half, y, 0.8], [x + half * 0.2, y + 1.4, 0.5], [x - half * 0.3, y + 1.2, 0.2]], 0.9);
  }
  save("sapling", p);
}

// ------------------------------------------------------------------ the seal

// A seal pressed into wax. The wax has run out past the die in an uneven edge;
// its rim is turned with lines that follow it round, bright where each slope
// faces the light. The pressed field is ruled level, as the ground of a
// banknote portrait is, and an oak leaf stands in it.
function seal() {
  const S = 360;
  const p = new Plate(S, S);
  const r = rng(71);
  const c = S / 2;
  const wob = noise(5);
  const rim = (th) => 150 * (1 + 0.035 * Math.sin(3 * th + 1) + 0.03 * Math.sin(5 * th + 4) + 0.03 * wob(th * 3.2 + 9) + 0.07 * Math.pow(clamp(Math.sin(th * 2 + 2.4)), 6));
  const die = (th) => 96 * (1 + 0.008 * Math.sin(4 * th));
  const bands = 13;
  for (let k = 0; k <= bands; k++) {
    const t = k / bands; // 0 at the die, 1 at the outer edge
    const pts = [];
    for (let i = 0; i <= 240; i++) {
      const th = (i / 240) * TAU;
      const rr = mix(die(th) + 3, rim(th), Math.pow(t, 0.9));
      // the rim is a round ridge: its inner slope faces in, its outer slope faces out
      const facing = t < 0.42 ? -1 : 1;
      const light = clamp(0.5 + 0.5 * facing * Math.cos(th + 2.36));
      const crown = 1 - Math.abs(t - 0.42) * 1.2;
      let w = (k === 0 || k === bands ? 1.7 : 0.35 + 1.5 * Math.pow(light, 1.5) * (0.5 + 0.5 * crown));
      if (k && k < bands && wob(th * 9 + k * 13) > 0.72) w = 0;
      pts.push([c + Math.cos(th) * rr, c + Math.sin(th) * rr, w]);
    }
    p.swell(pts);
  }
  // the leaf, then the level ground around it
  const quiet = new Plate(S, S);
  const poly = leaf(quiet, { x: c - 46, y: c + 50, angle: -0.82, length: 136, width: 44, lobes: 4, bend: 0.03, shade: 1, hatch: 3, weight: 1.15, cover: false });
  for (let y = c - 94; y <= c + 94; y += 3.1) {
    const pts = [];
    for (let x = c - 96; x <= c + 96; x += 3) {
      const d = Math.hypot(x - c, y - c);
      const open = d > 91 || inside(poly, x, y) || inside(poly, x + 3.5, y) || inside(poly, x - 3.5, y) || inside(poly, x, y + 3) || inside(poly, x, y - 3);
      pts.push([x, y, open ? 0 : 0.62 + 0.25 * Math.cos((x + y) / 60)]);
    }
    p.swell(pts, 0.7);
  }
  p.layers.push(...quiet.layers);
  // the stalk of the leaf
  p.swell([[c - 46, c + 50, 1.6], [c - 54, c + 59, 1.3], [c - 60, c + 68, 0.6]]);
  void r;
  save("seal", p);
}

// ------------------------------------------------------------------ a sprig

// A sprig of oak: three leaves and an acorn, for the head of a page.
function sprig() {
  const W = 420;
  const H = 240;
  const p = new Plate(W, H);
  const twig = (t) => [28 + t * 250, 150 - 44 * Math.sin(t * 1.9) - 10 * t];
  leaf(p, { x: twig(0.34)[0], y: twig(0.34)[1] - 3, angle: -1.25, length: 104, width: 32, lobes: 4, shade: 1, bend: 0.05 });
  leaf(p, { x: twig(0.62)[0], y: twig(0.62)[1] + 3, angle: 0.72, length: 96, width: 30, lobes: 4, shade: -1, bend: -0.05 });
  leaf(p, { x: twig(1)[0], y: twig(1)[1], angle: -0.2, length: 132, width: 40, lobes: 4, shade: 1, bend: 0.04 });
  const a = [];
  const b = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    const [x, y] = twig(t);
    const half = 3.2 - 1.9 * t;
    a.push([x, y - half, 0.8]);
    b.push([x, y + half, 1.3]);
  }
  p.cover([...a, ...b.slice().reverse()]);
  p.swell(a);
  p.swell(b);
  for (let i = 1; i < 30; i++) {
    const [x, y] = twig(i / 30);
    const half = 3.2 - 1.9 * (i / 30);
    p.swell([[x, y + half, 0.8], [x + 1.6, y, 0.5], [x + 1.4, y - half * 0.6, 0.2]], 0.9);
  }
  // a small acorn hanging under the twig
  const [ax, ay] = twig(0.2);
  const nut = (t) => 11 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(t), 0.7)), 0.6);
  p.swell([[ax, ay + 2, 1], [ax - 1, ay + 9, 0.9]]);
  const top = ay + 9;
  for (let t = 0.05; t < 1; t += 0.055) {
    const h = t < 0.4 ? nut(Math.max(t, 0.16)) * 1.12 + 1 : nut(t);
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const s = -1 + k / 6;
      const light = t < 0.4 ? 0.45 + 0.55 * clamp(Math.cos((s + 0.4) * 1.2)) : Math.pow(clamp(Math.cos((s + 0.42) * 1.25)), 1.5);
      pts.push([ax - 1 + s * h, top + t * 40 + h * 0.3 * (1 - s * s), light > 0.12 ? 1.25 * light : 0]);
    }
    p.swell(pts);
  }
  for (const s of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = 0.03 + (i / 24) * 0.99;
      const h = t < 0.4 ? nut(Math.max(t, 0.16)) * 1.12 + 1 : nut(Math.min(t, 1));
      pts.push([ax - 1 + s * h, top + t * 40, s > 0 ? 1.25 : 0.8]);
    }
    p.swell(pts);
  }
  save("sprig", p);
}

// ------------------------------------------------------------------ the oak

// A grown oak on its own ground. The limbs are round forms, cut like the roots
// with strokes across them; the leaves are massed in small scalloped strokes,
// many and heavy where the crown faces the light, few on its far side.
function oak() {
  const W = 640;
  const H = 560;
  const p = new Plate(W, H);
  const r = rng(23);
  const turn = noise(61);
  const ground = 492;
  const cx = 320;
  const all = [];
  const tips = [];

  const grow = (x, y, angle, radius, depth, seed) => {
    const pts = [];
    let a = angle;
    const life = radius * (depth ? 13 : 4.6) + 44;
    let travelled = 0;
    let rad = radius;
    let next = 16 + 20 * r();
    while (rad > 0.5 && travelled < life) {
      pts.push([x, y, rad]);
      a += depth ? 0.12 * turn(seed + travelled / 30) + 0.01 * Math.sign(a) - (Math.abs(a) > 1.35 ? 0.05 * Math.sign(a) : 0) : 0.03 * turn(seed + travelled / 30) - 0.05 * a;
      a = clamp(a, -1.6, 1.6);
      x += Math.sin(a) * 6;
      y -= Math.cos(a) * 6;
      travelled += 6;
      rad = radius * (depth ? Math.pow(Math.max(0, 1 - travelled / life), 0.7) : 1 - 0.3 * (travelled / life));
      if (rad < 2.6 && depth > 1) tips.push([x, y]);
      next -= 6;
      if (depth && depth < 5 && rad > 0.9 && next <= 0) {
        next = 16 + 24 * r();
        const side = r() < 0.5 ? -1 : 1;
        grow(x, y, a + side * (0.45 + 0.45 * r()), rad * (0.55 + 0.2 * r()), depth + 1, seed + 13.1 * (all.length + 1));
      }
    }
    if (!depth) {
      // the trunk parts into the great limbs
      for (const [turnTo, share] of [[-1.25, 0.66], [-0.62, 0.7], [-0.05, 0.6], [0.55, 0.72], [1.2, 0.66]]) {
        grow(x + turnTo * 6, y + 6, turnTo + 0.16 * (r() - 0.5), radius * share * 0.7, 1, seed + turnTo * 40);
      }
    }
    if (pts.length > 2) all.push({ pts, radius, depth });
  };
  grow(cx, ground + 4, 0.04, 25, 0, 3);

  // the ground: a low rise, level strokes, grass
  for (let k = 0; k < 8; k++) {
    const y0 = ground + 8 + k * 6.5;
    const span = 250 - k * 22;
    const pts = [];
    for (let x = cx - span; x <= cx + span; x += 7) {
      const u = (x - cx) / span;
      pts.push([x, y0 + 1.4 * turn(x / 30 + k * 3), turn(x / 17 + k * 5) > 0.4 ? 0 : 0.9 * (1 - u * u)]);
    }
    p.swell(pts, 0.8);
  }
  const rise = [];
  for (let x = 20; x <= W - 20; x += 6) {
    const u = (x - cx) / 270;
    rise.push([x, ground - 5 * Math.exp(-u * u * 5) + 1.5 * turn(x / 25), Math.abs(x - cx) < 34 ? 0 : 1.2 * (1 - u * u)]);
  }
  p.swell(rise);
  for (let i = 0; i < 46; i++) {
    const x = 30 + r() * (W - 60);
    if (Math.abs(x - cx) < 40) continue;
    tuft(p, r, x, ground + 1 + r() * 26, 5 + 8 * r(), 4);
  }

  // limbs, the finest first
  all.sort((u, v) => u.radius - v.radius);
  for (const limb of all) {
    const q = limb.pts;
    const n = q.length;
    const tangent = (i) => {
      const a = q[Math.max(0, i - 1)];
      const b = q[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    };
    const side = (i, s) => {
      const [tx, ty] = tangent(i);
      const flare = limb.depth ? 1 : 1 + 1.1 * Math.pow(Math.max(0, 1 - i / 7), 2.2); // the trunk spreads into its roots
      return [q[i][0] - ty * q[i][2] * s * flare, q[i][1] + tx * q[i][2] * s * flare];
    };
    if (limb.radius < 1.7) {
      p.swell(q.map((v) => [v[0], v[1], v[2] * 1.5 + 0.2]), 0.9);
      continue;
    }
    const left = q.map((_, i) => side(i, 1));
    const right = q.map((_, i) => side(i, -1));
    p.cover([...left, ...right.slice().reverse()]);
    // light from the upper left
    const [tx, ty] = tangent(Math.min(3, n - 1));
    const lit = -ty * -0.7 + tx * -0.7 > 0 ? 1 : -1;
    p.swell(q.map((v, i) => [...side(i, lit), 0.8]));
    p.swell(q.map((v, i) => [...side(i, -lit), 1.3]));
    for (let i = 1; i < n - 1; i++) {
      const rad = q[i][2];
      if (rad < 2) break;
      const reps = rad > 8 ? 2 : 1;
      for (let rep = 0; rep < reps; rep++) {
        const [tx2, ty2] = tangent(i);
        const reach = 0.5 + 0.4 * r();
        const pts = [];
        for (let k = 0; k <= 4; k++) {
          const s = mix(lit, lit * (1 - 2 * reach), k / 4);
          const bow = (1 - s * s) * rad * 0.4 + rep * 3;
          const [ex, ey] = side(i, s);
          pts.push([ex + tx2 * bow, ey + ty2 * bow, (1 - 0.82 * (k / 4)) * (0.8 + 0.4 * r())]);
        }
        p.swell(pts, 0.92);
      }
    }
  }

  // leaves: scalloped strokes massed round the twigs
  const mid = tips.reduce((m, t) => [m[0] + t[0] / tips.length, m[1] + t[1] / tips.length], [0, 0]);
  for (const [x, y] of tips) {
    if (r() < 0.6) continue;
    const light = clamp(0.55 - (x - mid[0]) / 420 - (y - mid[1]) / 300);
    const count = 2 + Math.round(3 * light);
    for (let i = 0; i < count; i++) {
      const lx = x + (r() - 0.5) * 34;
      const ly = y + (r() - 0.5) * 28 - 4;
      const size = 3.6 + 3.6 * r();
      const face = -2.2 + (r() - 0.5) * 1.6;
      const pts = [];
      for (let k = 0; k <= 4; k++) {
        const th = face - 1.25 + (2.5 * k) / 4;
        pts.push([lx + Math.cos(th) * size, ly + Math.sin(th) * size * 0.85, (0.5 + 0.9 * light) * Math.sin((Math.PI * (k + 0.6)) / 5.2)]);
      }
      p.swell(pts, 0.55 + 0.45 * light);
    }
  }
  save("oak", p);
}

// A single oak leaf.
function oakLeaf() {
  const p = new Plate(300, 300);
  leaf(p, { x: 62, y: 250, angle: -0.86, length: 250, width: 74, lobes: 4, bend: 0.04, shade: 1, hatch: 3.4, weight: 1.3, cover: false });
  p.swell([[62, 250, 1.9], [50, 265, 1.5], [41, 280, 0.7]]);
  save("leaf", p);
}

rings();
range();
roots();
acorn();
sapling();
seal();
sprig();
oak();
oakLeaf();
