// The drawing of the page ground, as one fragment shader: an engraved
// landscape that stands low on the screen behind every page. Two far hills cut
// with lines that follow their backs, a field ruled toward the viewer, tufts
// of grass that lean in the wind, and a few long level strokes of sky. Every
// pixel works out how far it is from the nearest line, so the lines stay one
// pixel wide and sharp at any size and nothing is stored or sampled.
//
// What moves: the grass sways, gusts cross the field and brighten its lines as
// they pass, a slow light drifts over the hills, and the strokes of sky travel.
// The land itself stands still.
//
// White and grey on near black only. The ground colour and its grain are
// drawn here too, so the canvas is opaque and nothing is blended behind it.

export const VERTEX = `
attribute vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

/** The far hill, the near hill and the edge of the field: height above the horizon line at x, in scene units. Shared with the still drawing. */
export const LAND: Record<"near" | "far" | "field", (x: number) => number> = {
  near: (x: number) => -36 - 18 * Math.sin(x * 0.003 + 3.6) - 6 * Math.sin(x * 0.0083 + 0.7),
  // the far hill is measured from the near one, so it always stands behind it
  far: (x: number) => LAND.near(x) - 26 - 14 * Math.sin(x * 0.0021 + 1.3) - 6 * Math.sin(x * 0.0057 + 4.0),
  field: (x: number) => 6 * Math.sin(x * 0.0024 + 2.2) + 3 * Math.sin(x * 0.0071),
};

/** Rows of grass: how far below the edge of the field, how tall, how far apart. */
export const GRASS: [number, number, number][] = [
  [8, 4.5, 8],
  [24, 6.5, 11],
  [52, 9, 15],
  [98, 12.5, 21],
];

/** The brightest any line may be, as a share of white. */
export const STRENGTH = { sky: 0.05, far: 0.15, near: 0.2, field: 0.13, grass: 0.2 };

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

export const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;    // canvas pixels
uniform float u_px;    // CSS pixels in one canvas pixel
uniform vec4 u_scene;  // the horizon (CSS pixels from the top), CSS pixels in one scene unit
uniform vec4 u_clock;  // phases: the sway of the grass, the gusts, the light, the sky

float grain(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float hash(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

// a line of the given half width, d away, both in CSS pixels
float stroke(float d, float half_width) {
  return clamp((half_width + 0.5 * u_px - d) / u_px, 0.0, 1.0);
}

// Lines that follow the back of a hill: the crest whole, the ones under it
// broken and further apart, fading as they go down.
float hill(float d, float x, float s, float seed) {
  float q = sqrt(1.0 + 0.2 * d / 2.7);
  float k = (q - 1.0) / 0.1;
  float n = floor(k + 0.5);
  float line = stroke(abs(k - n) * 2.7 * q * s, 0.5);
  float whole = step(n, 0.5);
  float on = smoothstep(-0.25, 0.05, sin(x * (0.013 + 0.009 * hash(n + seed)) + hash(n * 1.7 + seed) * 6.2832));
  return line * mix(on * exp(-d / 40.0), 1.0, whole);
}

// One row of grass: tufts of three blades that lean and sway.
float grass(float x, float up, float tall, float apart, float row, float s, float gust) {
  if (up < 0.0 || up > 2.6 * tall) return 0.0;
  float cellf = x / apart;
  float cell = floor(cellf);
  float side = fract(cellf) < 0.5 ? -1.0 : 1.0;
  float ink = 0.0;
  for (int j = 0; j < 2; j++) {
    float c = cell + float(j) * side;
    float seed = c * 1.31 + row * 57.0;
    if (hash(seed) < 0.5) continue;
    float foot = (c + 0.3 + 0.4 * hash(seed + 1.0)) * apart;
    // tufts do not stand in a row
    float lift = up - 1.6 * tall * hash(seed + 4.0);
    if (lift < 0.0) continue;
    float sway = (0.1 + 0.3 * gust) * sin(u_clock.x + foot * 0.011 + 6.2832 * hash(seed + 2.0));
    for (int b = 0; b < 3; b++) {
      float fb = float(b);
      float height = tall * (0.55 + 0.45 * hash(seed + 5.0 + fb));
      float u = lift / height;
      if (u > 1.0) continue;
      float lean = (hash(seed + 3.0 + fb) - 0.5) * 0.9 + sway;
      float bx = foot + (fb - 1.0) * 0.2 * tall + height * lean * u * u;
      ink = max(ink, stroke(abs(x - bx) * s, 0.05 + 0.5 * (1.0 - u)));
    }
  }
  return ink;
}

void main() {
  vec2 cell = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 p = cell * u_px;
  float down = cell.y / u_res.y;
  float s = u_scene.y;
  float x = p.x / s;
  float y = (p.y - u_scene.x) / s;

  float ground = mix(0.0314, 0.0196, smoothstep(0.0, 0.55, down));
  ground = mix(ground, 0.0157, smoothstep(0.55, 1.0, down));
  ground += 0.02 * grain(cell);

  float near = -36.0 - 18.0 * sin(x * 0.003 + 3.6) - 6.0 * sin(x * 0.0083 + 0.7);
  float far = near - 26.0 - 14.0 * sin(x * 0.0021 + 1.3) - 6.0 * sin(x * 0.0057 + 4.0);
  float field = 6.0 * sin(x * 0.0024 + 2.2) + 3.0 * sin(x * 0.0071);
  // a slow light that crosses the land
  float light = 0.6 + 0.4 * sin(x * 0.0031 + y * 0.004 - u_clock.z);

  float ink = 0.0;
  if (y < far - 1.0) {
    // sky: long level strokes, shown only where a slow band passes
    float band = (0.5 + 0.5 * sin(x * 0.0017 + 1.6 * sin(y * 0.012) - u_clock.w)) * (0.5 + 0.5 * sin(y * 0.021 + x * 0.0006 + 2.0));
    float show = smoothstep(0.5, 0.86, band) * smoothstep(far - 240.0, far - 30.0, y) * (1.0 - smoothstep(far - 26.0, far - 6.0, y));
    if (show > 0.0) {
      float n = floor(y / 6.0 + 0.5);
      float on = smoothstep(-0.1, 0.2, sin(x * (0.006 + 0.004 * hash(n)) + hash(n + 3.0) * 6.2832 - u_clock.w));
      ink = stroke(abs(y - n * 6.0) * s, 0.45) * on * show * ${f(STRENGTH.sky)};
    }
  } else if (y < near) {
    ink = hill(y - far, x, s, 11.0) * ${f(STRENGTH.far)} * (0.7 + 0.3 * light);
  } else if (y < field) {
    ink = hill(y - near, x, s, 29.0) * ${f(STRENGTH.near)} * light;
  } else {
    float d = y - field;
    // gusts that travel over the field
    float gust = 0.5 + 0.5 * sin(x * 0.0075 - d * 0.012 + u_clock.y);
    // the field, ruled level, wider apart toward the viewer
    float k = 10.0 * log(1.0 + d / 24.0);
    k += 0.2 * sin(x * 0.013 + d * 0.05) + 0.05 * gust;
    float n = floor(k + 0.5);
    float gap = (24.0 + d) / 10.0;
    float on = smoothstep(-0.1, 0.2, sin(x * (0.012 + 0.012 * hash(n)) + hash(n + 7.0) * 6.2832) + 0.5 * sin(x * 0.041 + n * 2.1));
    float rule = stroke(abs(k - n) * gap * s, 0.45 + 0.003 * d) * mix(on, 1.0, step(n, 0.5));
    ink = rule * ${f(STRENGTH.field)} * (0.5 + 0.5 * gust) * (0.75 + 0.25 * light);
    // grass, row behind row
    float blades = 0.0;
${GRASS.map(([at, tall, apart], i) => `    blades = max(blades, grass(x, ${f(at)} - d, ${f(tall)}, ${f(apart)}, ${f(i + 1)}, s, gust) * ${f(0.62 + 0.38 * (i / (GRASS.length - 1)))});`).join("\n")}
    ink = max(ink, blades * ${f(STRENGTH.grass)});
  }
  // grass of the first row stands up over the edge of the field
  if (y < field && y > field - 11.0) {
    float gust = 0.5 + 0.5 * sin(x * 0.0075 + u_clock.y);
    ink = max(ink, grass(x, field - y, 4.0, 7.0, 9.0, s, gust) * ${f(STRENGTH.grass * 0.55)});
  }

  gl_FragColor = vec4(vec3(ground + ink), 1.0);
}
`;

/** One full round of the clock, in seconds. Every speed below is a whole number of turns in it, so the loop has no seam. */
export const ROUND = 600;

/** Turns per round: the sway of the grass (one every four seconds), the gusts, the light, the sky. */
export const TURNS: [number, number, number, number] = [150, 40, 9, 4];
const START: [number, number, number, number] = [0.4, 2.1, 0.3, 1.2];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
