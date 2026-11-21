// The land of the page ground, in numbers: the shapes of its hills and its
// field, how bright it may be, and its tone at any place. The shader that
// draws the ground in motion (groundShader.ts) and the script that prints the
// still drawing (scripts/halftone.mjs) both read it, so the two stay in step.
// This file imports nothing, so the script can load it as it is.

/** The far hill, the near hill and the edge of the field: height above the horizon line at x, in scene units. Shared with the still drawing. */
export const LAND: Record<"near" | "far" | "field", (x: number) => number> = {
  near: (x: number) => -36 - 18 * Math.sin(x * 0.003 + 3.6) - 6 * Math.sin(x * 0.0083 + 0.7),
  // the far hill is measured from the near one, so it always stands behind it
  far: (x: number) => LAND.near(x) - 26 - 14 * Math.sin(x * 0.0021 + 1.3) - 6 * Math.sin(x * 0.0057 + 4.0),
  field: (x: number) => 6 * Math.sin(x * 0.0024 + 2.2) + 3 * Math.sin(x * 0.0071),
};

/** The brightest any dot may be, as a share of white. */
export const STRENGTH = { sky: 0.2, far: 0.17, near: 0.24, field: 0.15, grass: 0.22 };

/** How fast the light on a hill runs out below its crest, and the field toward the viewer (scene units). */
export const SHADE = { far: 12, near: 15, field: 150, grass: 55 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The tone of the land at a place, as the shader works it out, with its light
 * standing still: for the still drawing (scripts/halftone.mjs). `x` and `y` in
 * scene units, `y` measured down from the horizon; `soft` is the size of a dot.
 */
export function landTone(x: number, y: number, soft: number): number {
  const near = LAND.near(x);
  const far = LAND.far(x);
  const field = LAND.field(x);
  const inFar = clamp((y - far) / soft + 0.5, 0, 1);
  const inNear = clamp((y - near) / soft + 0.5, 0, 1);
  const inField = clamp((y - field) / soft + 0.5, 0, 1);
  const light = 0.8;
  let tone = STRENGTH.far * inFar * (1 - inNear) * Math.exp(-Math.max(y - far, 0) / SHADE.far) * (0.7 + 0.3 * light);
  tone += STRENGTH.near * inNear * (1 - inField) * Math.exp(-Math.max(y - near, 0) / SHADE.near) * light;
  const d = Math.max(y - field, 0);
  const row = 0.5 + 0.5 * Math.cos(Math.PI * 2 * 10 * Math.log(1 + d / 24));
  tone += inField * STRENGTH.field * (0.2 + 0.8 * row * row) * 0.72 * (0.75 + 0.25 * light) * Math.exp(-d / SHADE.field);
  return Math.min(tone, 0.3);
}

/** The still drawing (public/art/dots/land.webp): how wide a stretch of land, from where to where around the horizon, and the scene units in one of its pixels. */
export const LAND_STILL = { width: 2400, top: -110, bottom: 230, step: 4 };

