// The drawing of the page ground, as one fragment shader. Three ribbons of
// fine parallel lines, the line language of the logo. Every pixel works out
// how far it is from the nearest line of each ribbon, so the lines stay one
// pixel wide and sharp at any size and nothing is stored or sampled.
//
// A ribbon is a centre line that waves, with a bundle of lines across it. The
// ribbon twists as it goes: where it turns edge-on it narrows and its lines
// close up, where it lies flat they open, and the turn travels along it. It is
// brightest at one angle of the turn, so a band of light moves with the fold.
// On top of that a small ripple runs through the lines themselves.
//
// White and grey on near black only. The ground colour and its grain are
// drawn here too, so the canvas is opaque and nothing is blended behind it.

export const RIBBONS = 3;

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

uniform vec2 u_res;   // canvas pixels
uniform float u_px;   // CSS pixels in one canvas pixel
uniform vec4 u_a[${RIBBONS}]; // where the ribbon passes (x, y), its direction (x, y)
uniform vec4 u_b[${RIBBONS}]; // half width, lines - 1, strength, turn of the wave per pixel
uniform vec4 u_c[${RIBBONS}]; // phases: wave, second wave, twist, ripple
uniform vec2 u_d[${RIBBONS}]; // height of the wave, phase of the slow swell

float grain(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float ribbon(vec2 p, vec4 a, vec4 b, vec4 c, vec2 e) {
  vec2 d = p - a.xy;
  float y = dot(d, vec2(-a.w, a.z));
  if (abs(y) > e.x + b.x + 6.0) return 0.0;
  float x = dot(d, a.zw) * b.w;

  // the centre line, and its slope, so distances are measured square to it
  float centre = e.x * (0.62 * sin(x + c.x) + 0.38 * sin(2.3 * x + c.y));
  float slope = e.x * b.w * (0.62 * cos(x + c.x) + 0.874 * cos(2.3 * x + c.y));
  float dist = (y - centre) * inversesqrt(1.0 + slope * slope);

  // the twist: flat at 0, edge-on at a quarter turn
  float turn = 0.9 * x + c.z + 0.5 * sin(1.3 * x + c.x);
  float face = cos(turn);
  float half_width = b.x * (0.24 + 0.76 * abs(face));
  float s = dist / half_width;
  if (abs(s) > 1.12) return 0.0;

  // which line, and how far from it
  float v = (s * 0.5 + 0.5) * b.y;
  v += 0.28 * sin(5.0 * x + c.w + 0.5 * v);
  float n = floor(v + 0.5);
  if (n < 0.0 || n > b.y) return 0.0;
  float gap = 2.0 * half_width / b.y;
  float line = clamp((0.55 + 0.5 * u_px - abs(v - n) * gap) / u_px, 0.0, 1.0);
  // where the lines close up they become one even tone instead of a moire
  line = mix(clamp(1.1 / gap, 0.0, 0.7), line, smoothstep(1.4, 2.8, gap));

  // one edge of the ribbon is brighter, as in the logo, and the two outer lines are the brightest
  float side = 0.74 + 0.26 * clamp(1.3 * s * face, -1.0, 1.0);
  float outer = step(b.y - 0.5, n) + step(n, 0.5);
  float tone = mix(0.68 * side, 1.0, min(outer, 1.0));

  // it catches the light at one angle of the turn
  float light = 0.45 + 0.55 * pow(0.5 + 0.5 * cos(2.0 * (turn - 0.95)), 3.0);
  // and a slow swell lets stretches of it sink back
  float swell = 0.7 + 0.3 * sin(0.37 * x + e.y);

  return line * tone * light * swell * b.z;
}

void main() {
  vec2 cell = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 p = cell * u_px;
  float down = cell.y / u_res.y;

  float ground = mix(0.0314, 0.0196, smoothstep(0.0, 0.55, down));
  ground = mix(ground, 0.0157, smoothstep(0.55, 1.0, down));
  ground += 0.02 * grain(cell);

  float lines = 0.0;
  for (int i = 0; i < ${RIBBONS}; i++) {
    lines = max(lines, ribbon(p, u_a[i], u_b[i], u_c[i], u_d[i]));
  }

  gl_FragColor = vec4(vec3(ground + lines), 1.0);
}
`;

/** One full round of the clock, in seconds. Every speed below is a whole number of turns in it, so the loop has no seam. */
export const ROUND = 600;

type Ribbon = {
  /** where it crosses the middle of the screen, as a share of the height */
  at: number;
  /** its lean in degrees on a wide screen and on a tall one; negative rises to the right */
  lean: [number, number];
  /** width, against the first ribbon */
  width: number;
  lines: number;
  strength: number;
  /** wave height, against the first ribbon */
  wave: number;
  /** turns per round: wave, second wave, twist, ripple, swell; the sign is the direction of travel */
  turns: [number, number, number, number, number];
  /** where each starts */
  start: [number, number, number, number, number];
};

// The first ribbon lies high, where a page opens, and is the clearest. The
// second is lower and quieter. The third is wide, faint and slow, far behind.
const PLAN: Ribbon[] = [
  { at: 0.25, lean: [-8, -24], width: 1, lines: 20, strength: 0.38, wave: 1, turns: [15, -11, -10, 80, 6], start: [0.4, 2.1, 0.3, 0, 1.2] },
  { at: 0.68, lean: [6, 19], width: 0.92, lines: 18, strength: 0.27, wave: 0.9, turns: [-13, 9, 8, -70, -5], start: [3.3, 0.7, 2.2, 1.7, 4.0] },
  { at: 0.46, lean: [-17, -39], width: 1.75, lines: 14, strength: 0.14, wave: 1.25, turns: [8, -6, -5, 50, 4], start: [5.1, 4.4, 4.9, 3.1, 2.6] },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type Uniforms = { a: Float32Array; b: Float32Array; c: Float32Array; d: Float32Array };

export function makeUniforms(): Uniforms {
  return {
    a: new Float32Array(RIBBONS * 4),
    b: new Float32Array(RIBBONS * 4),
    c: new Float32Array(RIBBONS * 4),
    d: new Float32Array(RIBBONS * 2),
  };
}

/** The parts that depend on the size of the screen only (CSS pixels). */
export function layOut(u: Uniforms, width: number, height: number) {
  const tall = clamp((height / Math.max(width, 1) - 0.8) / 0.8, 0, 1);
  const halfWidth = clamp((60 * width) / 1440, 44, 84);
  const waveLength = 1.15 * Math.max(width, 760);
  const waveHeight = clamp(0.07 * height, 36, 80);
  PLAN.forEach((r, i) => {
    const lean = ((r.lean[0] + (r.lean[1] - r.lean[0]) * tall) * Math.PI) / 180;
    u.a.set([width / 2, r.at * height, Math.cos(lean), Math.sin(lean)], i * 4);
    u.b.set([halfWidth * r.width, r.lines - 1, r.strength, (2 * Math.PI) / (waveLength * (0.85 + 0.15 * r.width))], i * 4);
    u.d[i * 2] = waveHeight * r.wave;
  });
}

/** The parts that move. `seconds` is the time the ground has been running. */
export function advance(u: Uniforms, seconds: number) {
  const round = ((seconds % ROUND) / ROUND) * Math.PI * 2;
  const full = Math.PI * 2;
  for (let i = 0; i < RIBBONS; i++) {
    const r = PLAN[i];
    for (let k = 0; k < 4; k++) {
      const phase = (r.start[k] + r.turns[k] * round) % full;
      u.c[i * 4 + k] = phase < 0 ? phase + full : phase;
    }
    const swell = (r.start[4] + r.turns[4] * round) % full;
    u.d[i * 2 + 1] = swell < 0 ? swell + full : swell;
  }
}
