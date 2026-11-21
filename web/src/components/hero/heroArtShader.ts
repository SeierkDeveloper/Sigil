// The art of the home page's first screen, as one fragment shader: the
// owner's oak printed as a halftone in white and silver, and behind it a sky
// of cold light that falls in from the upper right and runs out to black at
// the left and toward the ground.
//
// A screen of dots lies over the whole piece (components/art/dots.ts, the
// same screen as the page ground, laid so the two fall on each other). A dot
// of the sky is as large as the sky is bright there. A dot of the oak is as
// large and as white as the oak's tone at that spot, which is read from a
// small tone picture (public/art/dots/tree-light.webp, made by
// scripts/halftone.mjs); a second picture (tree-shade.webp) holds the sky
// back where the oak stands in front of it.
//
// What moves: the light in the sky wanders a little and its clouds drift, the
// crown of the oak leans a hair in the wind, and each dot breathes by a few
// percent. The dots themselves never leave their places.

import { DOTS_GLSL, SKY_GLSL } from "../art/dots";

/** The oak's picture (public/art/tree.webp), in its own pixels. */
export const TREE_SIZE = [1652, 724] as const;

/** Above this width (CSS pixels) the oak stands beside the words; under it, below them. Kept in step with dotted.css. */
export const WIDE_ABOVE = 860;

export const VERTEX = `
attribute vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

export const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;        // canvas pixels
uniform vec4 u_dots;       // canvas pixels from dot to dot, CSS pixels in one canvas pixel, how far down the screen of dots begins (canvas pixels)
uniform vec4 u_tree;       // where the oak's picture lies, in CSS pixels: left, top, width, height
uniform vec4 u_sky;        // the sky, in CSS pixels: where it starts to show, where its light is whole, how far down it reaches, how far across
uniform vec4 u_clock;      // phases: the sway of the crown, its tremble, the light in the sky, the breath of the dots
uniform sampler2D u_light; // the oak's tone
uniform sampler2D u_shade; // where the oak holds the sky back
${DOTS_GLSL}
void main() {
  vec2 at = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 shift = vec2(0.0, u_dots.z);
  vec2 dot_at = floor((at + shift) / u_dots.x);
  vec2 mid = (dot_at + 0.5) * u_dots.x - shift;
  vec2 c = mid * u_dots.y;
  vec2 size = u_res * u_dots.y;

  // the sky: brightest in the upper right, falling off in soft steps, with a little cloud in it
  float fall = (size.x - c.x) / u_sky.w + (c.y - u_sky.y) / u_sky.z + 0.035 * sin(u_clock.z);
  float glow = 1.0 - smoothstep(0.0, 1.0, fall);
  float steps = glow * 5.0;
  glow = mix(glow, (floor(steps) + smoothstep(0.25, 0.75, fract(steps))) / 5.0, 0.55);
  float drift = cloud(c * 0.0045 + 2.0 * vec2(cos(u_clock.z), sin(u_clock.z)));
  float sky = glow * (0.8 + 0.45 * drift) * smoothstep(u_sky.x, u_sky.y, c.y);

  // the oak: everything above the foot of its trunk sways about that point, more the higher it stands
  vec2 uv = (c - u_tree.xy) / u_tree.zw;
  float above = clamp((0.74 - uv.y) / 0.7, 0.0, 1.0);
  float crown = above * above * smoothstep(0.34, 0.5, uv.x);
  float sway = sin(u_clock.x + uv.y * 2.0) + 0.5 * sin(2.0 * u_clock.x + uv.x * 7.0 + 1.3);
  float tremble = sin(u_clock.y + uv.x * 61.0 + uv.y * 47.0) * sin(u_clock.y * 2.0 + uv.x * 23.0 - uv.y * 31.0);
  vec2 moved = uv + crown * vec2(3.0 * sway + 1.4 * tremble, 0.8 * tremble) / vec2(${TREE_SIZE[0]}.0, ${TREE_SIZE[1]}.0);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float tree = texture2D(u_light, moved).a * inside;
  float shade = texture2D(u_shade, moved).a * inside;
  sky *= 1.0 - 0.72 * shade;

  // no two dots quite alike, and each breathes a little
  float breath = 0.92 + 0.1 * hash2(dot_at + 11.0) + 0.06 * sin(u_clock.w + 6.2832 * hash2(dot_at + 23.0));
  sky = clamp(sky * breath, 0.0, 1.0);
  tree = clamp(tree * breath, 0.0, 1.0);

  float d = length(at - mid);
  float sky_dot = disc(d, u_dots.x * 0.46 * sqrt(sky));
  float tree_dot = disc(d, u_dots.x * (0.12 + 0.34 * sqrt(tree)) * smoothstep(0.0, 0.05, tree));
  vec3 ink = ${SKY_GLSL} * (0.55 + 0.45 * sky) * sky_dot;
  ink = mix(ink, vec3(0.4 + 0.6 * tree), tree_dot);
  gl_FragColor = vec4(ink, sky_dot + tree_dot * (1.0 - sky_dot));
}
`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type HeroLayout = {
  /** Where the oak's picture lies in the piece, CSS pixels: left, top, width, height. */
  tree: [number, number, number, number];
  /** The sky, CSS pixels: where it starts to show, where its light is whole, how far down it reaches, how far across. */
  sky: [number, number, number, number];
};

/**
 * Where things stand in a piece of the given size (CSS pixels). On a wide
 * screen the piece fills the first screen: the oak stands at its right foot
 * and the sky comes down from the very top. On a phone the piece lies under
 * the words: the oak fills it and runs off both sides, and the sky rises out
 * of black below the words. dotted.css places the still picture the same way.
 */
export function layOutHero(width: number, height: number): HeroLayout {
  const ratio = TREE_SIZE[1] / TREE_SIZE[0];
  if (width > WIDE_ABOVE) {
    const w = clamp(0.84 * width, 940, 1560);
    const h = w * ratio;
    return { tree: [width - w, height - h, w, h], sky: [-2, -1, 0.92 * height, 0.8 * width] };
  }
  const w = 1.6 * width;
  const h = w * ratio;
  return { tree: [-0.543 * width, height - h, w, h], sky: [0, 0.3 * height, 0.66 * height, 1.6 * width] };
}
