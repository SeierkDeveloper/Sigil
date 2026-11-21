// The engraver's tools, shared by every drawing in scripts/engravings.mjs.
//
// A drawing is white line on a clear ground, as a plate printed in silver on
// black. Tone comes from the lines alone: a line swells where the form is lit
// and thins to nothing where it turns into shade, lines follow the form they
// describe, and stipple fills what lines would make too heavy. Nothing is
// filled with grey and nothing is blurred.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth noise along a line, -1 to 1. */
export function noise(seed) {
  const r = rng(seed);
  const v = Array.from({ length: 512 }, () => r() * 2 - 1);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return v[i & 511] * (1 - u) + v[(i + 1) & 511] * u;
  };
}

/** The same in the plane. */
export function noise2(seed) {
  const r = rng(seed);
  const v = Array.from({ length: 4096 }, () => r() * 2 - 1);
  const at = (i, j) => v[((i & 63) + (j & 63) * 64) & 4095];
  return (x, y) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - ux) + at(i + 1, j) * ux) * (1 - uy) + (at(i, j + 1) * (1 - ux) + at(i + 1, j + 1) * ux) * uy;
  };
}

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const n1 = (v) => {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

export function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export class Plate {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layers = [];
    this.defs = "";
    this.mask = "";
  }

  push(key, attrs, d) {
    const last = this.layers[this.layers.length - 1];
    if (last && last.key === key) last.d.push(d);
    else this.layers.push({ key, attrs, d: [d] });
  }

  /**
   * A swelling line: points of [x, y, width]. It is cut wherever the width
   * falls under a hair, and every piece runs out to a point at both ends.
   */
  swell(points, opacity = 1) {
    let run = [];
    const flush = () => {
      if (run.length > 1) this.push(`f${opacity}`, `fill="#fff"${opacity < 1 ? ` opacity="${opacity}"` : ""}`, outline(run));
      run = [];
    };
    for (const p of points) {
      if (p[2] >= 0.16) run.push(p);
      else flush();
    }
    flush();
  }

  /** An even line. */
  line(points, width = 0.8, opacity = 1) {
    if (points.length < 2) return;
    const d = points.map((p, i) => `${i ? "L" : "M"}${n1(p[0])} ${n1(p[1])}`).join("");
    this.push(`s${width}/${opacity}`, `fill="none" stroke="#fff" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${opacity < 1 ? ` opacity="${opacity}"` : ""}`, d);
  }

  /** Stipple: one dot. */
  dot(x, y, r = 0.7, opacity = 1) {
    this.push(`f${opacity}`, `fill="#fff"${opacity < 1 ? ` opacity="${opacity}"` : ""}`, `M${n1(x - r)} ${n1(y)}a${n1(r)} ${n1(r)} 0 1 0 ${n1(2 * r)} 0a${n1(r)} ${n1(r)} 0 1 0 ${n1(-2 * r)} 0`);
  }

  /** Bare plate: hides what was cut before, where one form passes in front of another. */
  cover(poly) {
    this.push("k", `fill="#050505"`, poly.map((p, i) => `${i ? "L" : "M"}${n1(p[0])} ${n1(p[1])}`).join("") + "Z");
  }

  /** The drawing runs out toward its edges: shares of the width and height over which it fades. */
  fade({ left = 0, right = 0, top = 0, bottom = 0 }) {
    const stops = (a, b) =>
      `<stop offset="0" stop-color="#fff" stop-opacity="${a ? 0 : 1}"/>` +
      (a ? `<stop offset="${a}" stop-color="#fff"/>` : "") +
      (b ? `<stop offset="${1 - b}" stop-color="#fff"/>` : "") +
      `<stop offset="1" stop-color="#fff" stop-opacity="${b ? 0 : 1}"/>`;
    this.defs =
      `<linearGradient id="fx" x1="0" x2="1" y1="0" y2="0">${stops(left, right)}</linearGradient>` +
      `<linearGradient id="fy" x1="0" x2="0" y1="0" y2="1">${stops(top, bottom)}</linearGradient>` +
      `<mask id="mx"><rect width="${this.width}" height="${this.height}" fill="url(#fx)"/></mask>` +
      `<mask id="my"><rect width="${this.width}" height="${this.height}" fill="url(#fy)"/></mask>`;
    this.mask = true;
  }

  svg() {
    const body = this.layers.map((l) => `<path ${l.attrs} d="${l.d.join("")}"/>`).join("\n");
    const inner = this.mask ? `<g mask="url(#mx)"><g mask="url(#my)">\n${body}\n</g></g>` : body;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}">\n${this.defs ? `<defs>${this.defs}</defs>\n` : ""}${inner}\n</svg>\n`;
  }
}

function outline(run) {
  const n = run.length;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = run[Math.max(0, i - 1)];
    const b = run[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // the ends run out to a point
    const end = i === 0 || i === n - 1 ? 0.12 : i === 1 || i === n - 2 ? 0.6 : 1;
    const h = (run[i][2] * end) / 2;
    left.push([run[i][0] - dy * h, run[i][1] + dx * h]);
    right.push([run[i][0] + dy * h, run[i][1] - dx * h]);
  }
  let d = "";
  for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${n1(left[i][0])} ${n1(left[i][1])}`;
  for (let i = n - 1; i >= 0; i--) d += `L${n1(right[i][0])} ${n1(right[i][1])}`;
  return d + "Z";
}
