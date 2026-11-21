// The dot screen: what every dotted picture of the site shares.
//
// The pictures are halftones. A screen of round dots lies over the page, the
// same everywhere, and a picture is only how large and how bright each dot is.
// The ground behind every page (components/backdrop) and the art of the home
// page's first screen (components/hero/HeroArt.tsx) draw their dots on the
// graphics card; the still pictures get theirs from a mask (dotted.css, which
// repeats the two numbers below as --dot-pitch).

/** CSS pixels from one dot to the next: on a wide screen, and on a phone. */
export const PITCH = 5;
export const PITCH_SMALL = 4;
/** Screens narrower than this (CSS pixels) get the finer screen. Kept in step with dotted.css. */
export const SMALL_BELOW = 700;

export const pitchFor = (width: number) => (width < SMALL_BELOW ? PITCH_SMALL : PITCH);

/** The one colour of the site: the cold blue silver of the sky. Everything else is black, white and grey. */
export const SKY: [number, number, number] = [0.58, 0.66, 0.84];

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
export const SKY_GLSL = `vec3(${SKY.map(f).join(", ")})`;

export type DotFit = {
  /** Canvas pixels, both ways. */
  width: number;
  height: number;
  /** Canvas pixels from one dot to the next: a whole number, so every dot is drawn alike and no pattern beats across the screen. */
  step: number;
  /** CSS pixels in one canvas pixel. */
  px: number;
};

/**
 * The size to draw a dotted canvas at. As sharp as the screen (twice the CSS
 * size at most), but never more than `maxPixels`, and always a whole number of
 * canvas pixels per dot. `quality` below 1 asks for a coarser canvas.
 */
export function fitDots(cssWidth: number, cssHeight: number, density: number, maxPixels: number, quality = 1): DotFit {
  const pitch = pitchFor(cssWidth);
  let step = Math.max(3, Math.floor(pitch * Math.min(2, Math.max(1, density)) * quality));
  while (step > 3 && cssWidth * cssHeight * (step / pitch) ** 2 > maxPixels) step--;
  return {
    width: Math.max(1, Math.round((cssWidth * step) / pitch)),
    height: Math.max(1, Math.round((cssHeight * step) / pitch)),
    step,
    px: pitch / step,
  };
}

/** Shared by the two shaders: a number from a place, smooth noise, and one round dot. */
export const DOTS_GLSL = `
float hash2(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float cloud(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}

// how much of a pixel d away from its middle a dot of radius r covers (canvas pixels)
float disc(float d, float r) {
  return clamp(r - d + 0.5, 0.0, 1.0) * step(0.2, r);
}
`;
