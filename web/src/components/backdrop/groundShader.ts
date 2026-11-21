// The drawing of the page ground, as one fragment shader: a landscape low on
// the screen behind every page, printed as a halftone. A screen of dots lies
// over the whole page (components/art/dots.ts); a dot is larger and brighter
// where the land is lit: along the backs of two far hills, in the rows of a
// field, in a few tufts of grass. From the upper right a faint cold light
// falls across the sky.
//
// Every pixel only asks which dot it belongs to and how lit that dot is, so
// the dots are round and sharp at any size and nothing is stored or sampled.
//
// What moves: a slow light drifts over the hills, gusts cross the field and
// brighten its rows as they pass, the light in the sky wanders a little, and
// each dot breathes by a few percent. The land itself stands still.
//
// White and grey on near black, and the cold blue silver of the sky's light
// (SKY in dots.ts), which is the only colour. The ground colour and its grain
// are drawn here too, so the canvas is opaque and nothing is blended behind it.

import { DOTS_GLSL, SKY_GLSL } from "../art/dots";
import { SHADE, STRENGTH } from "./land";

export { LAND, LAND_STILL, SHADE, STRENGTH, landTone } from "./land";

export const VERTEX = `
attribute vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

export const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;    // canvas pixels
uniform vec4 u_dots;   // canvas pixels from dot to dot, CSS pixels in one canvas pixel, how strong the sky's light is
uniform vec4 u_scene;  // the horizon (CSS pixels from the top), CSS pixels in one scene unit
uniform vec4 u_clock;  // phases: the light on the land, the gusts, the light in the sky, the breath of the dots
${DOTS_GLSL}
void main() {
  vec2 at = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  float down = at.y / u_res.y;

  float ground = mix(0.0314, 0.0196, smoothstep(0.0, 0.55, down));
  ground = mix(ground, 0.0157, smoothstep(0.55, 1.0, down));
  ground += 0.02 * hash2(at);

  // the dot this pixel belongs to, and where its middle lies
  vec2 dot_at = floor(at / u_dots.x);
  vec2 mid = (dot_at + 0.5) * u_dots.x;
  vec2 c = mid * u_dots.y;
  vec2 size = u_res * u_dots.y;

  float s = u_scene.y;
  float x = c.x / s;
  float y = (c.y - u_scene.x) / s;
  // half a dot, in scene units: an edge that crosses a dot lights it by the share it covers
  float soft = u_dots.x * u_dots.y / s;

  float near = -36.0 - 18.0 * sin(x * 0.003 + 3.6) - 6.0 * sin(x * 0.0083 + 0.7);
  float far = near - 26.0 - 14.0 * sin(x * 0.0021 + 1.3) - 6.0 * sin(x * 0.0057 + 4.0);
  float field = 6.0 * sin(x * 0.0024 + 2.2) + 3.0 * sin(x * 0.0071);
  float in_far = clamp((y - far) / soft + 0.5, 0.0, 1.0);
  float in_near = clamp((y - near) / soft + 0.5, 0.0, 1.0);
  float in_field = clamp((y - field) / soft + 0.5, 0.0, 1.0);
  // a slow light that crosses the land
  float light = 0.6 + 0.4 * sin(x * 0.0031 + y * 0.004 - u_clock.x);

  // the hills: lit along their backs, running out into shade below
  float tone = ${f(STRENGTH.far)} * in_far * (1.0 - in_near) * exp(-max(y - far, 0.0) / ${f(SHADE.far)}) * (0.7 + 0.3 * light);
  tone += ${f(STRENGTH.near)} * in_near * (1.0 - in_field) * exp(-max(y - near, 0.0) / ${f(SHADE.near)}) * light;

  // the field: rows, wider apart toward the viewer, brighter where a gust passes
  float d = max(y - field, 0.0);
  float gust = 0.5 + 0.5 * sin(x * 0.0075 - d * 0.012 + u_clock.y);
  float row = 0.5 + 0.5 * cos(6.2832 * 10.0 * log(1.0 + d / 24.0));
  float lit = ${f(STRENGTH.field)} * (0.2 + 0.8 * row * row) * (0.45 + 0.55 * gust) * (0.75 + 0.25 * light) * exp(-d / ${f(SHADE.field)});
  // grass: a few dots that stand out near the edge of the field
  lit = max(lit, ${f(STRENGTH.grass)} * step(0.88, hash2(dot_at + 3.0)) * exp(-d / ${f(SHADE.grass)}) * (0.45 + 0.55 * gust));
  tone += in_field * lit;

  // the sky: a cold light from the upper right, in soft steps, with a little cloud in it
  vec2 q = vec2(1.0 - c.x / size.x, c.y / size.y);
  float fall = q.x / 0.8 + q.y / 0.75 + 0.03 * sin(u_clock.z);
  float glow = 1.0 - smoothstep(0.0, 1.0, fall);
  float steps = glow * 4.0;
  glow = mix(glow, (floor(steps) + smoothstep(0.3, 0.7, fract(steps))) / 4.0, 0.5);
  float drift = cloud(c * 0.006 + 2.0 * vec2(cos(u_clock.z), sin(u_clock.z)));
  float sky = ${f(STRENGTH.sky)} * u_dots.z * glow * (0.6 + 0.6 * drift) * (1.0 - in_far);
  float cold = sky / max(sky + tone, 0.0001);
  tone += sky;

  // no two dots quite alike, and each breathes a little
  tone *= 0.86 + 0.2 * hash2(dot_at + 11.0) + 0.06 * sin(u_clock.w + 6.2832 * hash2(dot_at + 23.0));

  float radius = u_dots.x * (0.11 + 0.21 * sqrt(clamp(tone / 0.3, 0.0, 1.0)));
  float ink = disc(length(at - mid), radius) * min(tone, 0.3);

  gl_FragColor = vec4(vec3(ground) + ink * mix(vec3(1.0), ${SKY_GLSL} / ${f(0.84)}, cold), 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One full round of the clock, in seconds. Every speed below is a whole number of turns in it, so the loop has no seam. */
export const ROUND = 600;

/** Turns per round: the light on the land, the gusts, the light in the sky, the breath of the dots (one every five seconds). */
export const TURNS: [number, number, number, number] = [9, 40, 5, 120];
const START: [number, number, number, number] = [0.3, 2.1, 1.2, 0.4];

export type Uniforms = { scene: Float32Array; clock: Float32Array };

export function makeUniforms(): Uniforms {
  return { scene: new Float32Array(4), clock: new Float32Array(4) };
}

/** The parts that depend on the size of the screen only (CSS pixels): where the horizon lies and how large the land is drawn. */
export function layOut(u: Uniforms, width: number, height: number) {
  const tall = clamp((height / Math.max(width, 1) - 0.8) / 0.8, 0, 1);
  const scale = clamp(Math.min(width / 1100, height / 800), 0.72, 1.35);
  // the land keeps to the lowest part of the screen: a fifth of it on a laptop, less on a phone
  const horizon = height * (0.8 + 0.06 * tall);
  u.scene.set([horizon, scale, width, height]);
}

/** The parts that move. `seconds` is the time the ground has been running. */
export function advance(u: Uniforms, seconds: number) {
  const round = ((seconds % ROUND) / ROUND) * Math.PI * 2;
  const full = Math.PI * 2;
  for (let k = 0; k < 4; k++) {
    const phase = (START[k] + TURNS[k] * round) % full;
    u.clock[k] = phase < 0 ? phase + full : phase;
  }
}
