"use client";

// Direction C: one block of polished black stone with a single silver inlay,
// standing on a dark mirror. Lit like a studio photograph by three soft lights
// that drift slowly and follow the pointer. One small fragment shader; the ray
// meets the block analytically, so a frame is cheap. 30 frames a second at
// most, stopped off screen and in hidden tabs, one finished frame with reduced
// motion, and a still drawing when WebGL is missing.

import { useEffect, useRef, useState } from "react";
import { useOnScreen, useReducedMotion } from "./clock";

const FRAME_MS = 1000 / 30;
const INTRO_SECONDS = 3.2;

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uIn;
uniform vec2 uPtr;
uniform float uSamples;

const vec3 HALF = vec3(0.43, 0.95, 0.2);
const float EDGE = 0.012;
const float FOCAL = 3.5;
const float INLAY_Y = 0.42;
const float INLAY_W = 0.0052;

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

/* Thin pale veins, as in black marble: each one a bent plane through the block, broken along its length. */
float vein(vec3 p, vec3 dir, float at, float bend, float seed){
  float wob = (vnoise(p * 1.7 + seed) - 0.5) * bend + (vnoise(p * 6.0 + seed * 2.0) - 0.5) * bend * 0.22 + (vnoise(p * 19.0 + seed) - 0.5) * bend * 0.05;
  float d = abs(dot(p, dir) - at + wob);
  float there = smoothstep(0.3, 0.62, vnoise(p * 2.3 + seed * 5.0));
  float thick = 0.0015 + 0.004 * vnoise(p * 4.0 + seed * 3.0);
  float body = 1.0 - smoothstep(thick * 0.3, thick, d);
  float halo = 1.0 - smoothstep(0.0, 0.022, d);
  float along = vnoise(p * 7.0 + seed);
  return (body + 0.07 * halo * halo) * there * (0.2 + 0.8 * along * along);
}
float veins(vec3 p){
  float v = vein(p, normalize(vec3(0.74, 0.62, 0.3)), 0.21, 0.5, 3.0);
  v += 0.7 * vein(p, normalize(vec3(0.5, -0.82, 0.25)), -0.33, 0.42, 11.0);
  v += 0.45 * vein(p, normalize(vec3(0.9, 0.3, -0.3)), -0.2, 0.6, 23.0);
  return min(v, 1.0);
}

float gAngle;
vec3 toObj(vec3 p){ float c = cos(gAngle), s = sin(gAngle); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
vec3 toWorld(vec3 p){ float c = cos(gAngle), s = sin(gAngle); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }

float sdSlab(vec3 p){ vec3 q = abs(p) - HALF + EDGE; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - EDGE; }
vec3 nSlab(vec3 p){ vec3 q = abs(p) - HALF + EDGE; return normalize(sign(p) * max(q, 0.0) + 1e-7); }

/* Distance along the ray to the block, or -1. Both in world space. */
float hitSlab(vec3 ro, vec3 rd){
  vec3 o = toObj(ro - vec3(0.0, HALF.y, 0.0));
  vec3 d = toObj(rd);
  vec3 inv = 1.0 / d;
  vec3 t0 = (-HALF - o) * inv, t1 = (HALF - o) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float near = max(max(tn.x, tn.y), tn.z), far = min(min(tf.x, tf.y), tf.z);
  if (near > far || far < 0.0) return -1.0;
  float t = max(near, 0.0);
  for (int i = 0; i < 14; i++) {
    float h = sdSlab(o + d * t);
    if (h < 0.0004) return t;
    t += h;
    if (t > far) return -1.0;
  }
  return -1.0;
}

/* A soft rectangular light, brighter in the middle, seen from ro along rd. */
float panel(vec3 ro, vec3 rd, vec3 c, vec3 n, vec2 size, float soft){
  float dn = dot(rd, n);
  if (dn > -0.001) return 0.0;
  float t = dot(c - ro, n) / dn;
  if (t < 0.0) return 0.0;
  vec3 h = ro + rd * t - c;
  vec3 axis = abs(n.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 u = normalize(cross(axis, n));
  vec3 v = cross(n, u);
  vec2 q = vec2(dot(h, u), dot(h, v));
  vec2 e = abs(q) - size;
  float edge = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  float body = 1.0 - smoothstep(-soft, soft, edge);
  vec2 w = q / size;
  return body * (0.3 + 0.7 * exp(-dot(w, w) * 1.1));
}

vec3 gKey;
float studio(vec3 ro, vec3 rd, float blur){
  vec3 mid = vec3(0.0, 0.9, 0.0);
  float key = panel(ro, rd, gKey, normalize(mid - gKey), vec2(0.62, 3.2), 0.42 * blur);
  vec3 rimAt = vec3(-3.3, 1.2, -2.35);
  float rim = panel(ro, rd, rimAt, normalize(mid - rimAt), vec2(0.4, 2.4), 0.6 * blur);
  float top = panel(ro, rd, vec3(0.4, 5.2, 0.8), vec3(0.0, -1.0, 0.0), vec2(2.2, 1.3), 0.8 * blur);
  vec3 edgeAt = vec3(-2.3, 1.3, 4.2);
  float edge = panel(ro, rd, edgeAt, normalize(mid - edgeAt), vec2(0.22, 2.0), 0.25 * blur);
  return (key * 5.0 + rim * 7.0 + top * 4.0 + edge * 5.0) * uIn + 0.006;
}

float shadeSlab(vec3 p, vec3 rd, float px){
  vec3 po = toObj(p - vec3(0.0, HALF.y, 0.0));
  vec3 no = nSlab(po);
  vec3 n = toWorld(no);
  float ndv = max(dot(n, -rd), 0.0);
  vec3 r = reflect(rd, n);
  float grain = hash(floor(po * 380.0));
  float f0 = mix(0.043, 0.053, grain);
  float fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
  float stone = studio(p, r, 1.0) * fres;
  stone += 0.003 * (0.4 + grain) * uIn;
  float lit = max(dot(n, normalize(gKey - p)), 0.0);
  stone += veins(po) * (0.012 + 0.15 * lit) * uIn;
  float band = 1.0 - smoothstep(INLAY_W - px, INLAY_W + px, abs(po.y - INLAY_Y));
  band *= step(abs(no.y), 0.6);
  float brushed = 0.9 + 0.1 * hash(vec3(floor(po.y * 2400.0), 3.0, 7.0));
  float silver = (studio(p, r, 1.7) * 0.62 + 0.035 * uIn) * brushed;
  return mix(stone, silver, band);
}

vec4 sampleAt(vec2 frag){
  vec2 uv = (frag - 0.5 * uRes) / uRes.y * 2.0;
  vec3 ro = vec3(0.0, 0.95, 4.6);
  vec3 fwd = normalize(vec3(0.0, 0.74, 0.0) - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd * FOCAL + right * uv.x + up * uv.y);
  float pix = 2.0 / (uRes.y * FOCAL);

  float t = hitSlab(ro, rd);
  if (t > 0.0) {
    return vec4(vec3(shadeSlab(ro + rd * t, rd, t * pix * 0.75)), 1.0);
  }
  if (rd.y < -0.0001) {
    float tf = -ro.y / rd.y;
    vec3 pf = ro + rd * tf;
    vec3 r = vec3(rd.x, -rd.y, rd.z);
    float fres = 0.04 + 0.96 * pow(1.0 - max(-rd.y, 0.0), 5.0);
    float t2 = hitSlab(pf + vec3(0.0, 0.0005, 0.0), r);
    float refl;
    float cover;
    if (t2 > 0.0) {
      vec3 p2 = pf + r * t2;
      float soften = exp(-p2.y * 1.15);
      refl = shadeSlab(p2, r, (tf + t2) * pix) * (0.25 + 0.75 * soften);
      cover = 0.5 + 0.45 * soften;
    } else {
      refl = studio(pf, r, 3.0) * 0.25;
      cover = 0.0;
    }
    float reach = exp(-dot(pf.xz, pf.xz) / 2.2) * (1.0 - smoothstep(0.35, 0.95, abs(uv.x))) * (1.0 - smoothstep(0.6, 0.98, abs(uv.y)));
    float foot = 1.0 - smoothstep(0.0, 0.5, sdSlab(toObj(pf - vec3(0.0, HALF.y, 0.0))));
    float a = max(cover, foot * 0.55) * reach;
    return vec4(vec3(refl * fres * reach), a);
  }
  return vec4(0.0);
}

void main(){
  vec2 ptr = uPtr;
  gAngle = 0.6 + 0.045 * sin(uTime * 0.19) + ptr.x * 0.07;
  float sweep = (1.0 - uIn) * 2.6;
  gKey = vec3(4.3 + 0.4 * sin(uTime * 0.23) + ptr.x * 1.4 + sweep, 1.5 - ptr.y * 0.9, 1.2);

  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uSamples) break;
    vec2 off = vec2(0.0);
    if (uSamples > 1.5) {
      float fi = float(i);
      off = vec2(fract(fi * 0.5 + 0.25), fract(fi * 0.25 + 0.125)) - 0.5;
    }
    vec4 s = sampleAt(gl_FragCoord.xy + off);
    s.rgb = 1.0 - exp(-s.rgb * 1.5);
    acc += vec4(s.rgb, s.a);
  }
  acc /= uSamples;
  vec3 col = pow(acc.rgb, vec3(1.0 / 2.2));
  float n = hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5;
  col += n * 0.012 * acc.a;
  /* additive light over the page where nothing solid is in the way */
  gl_FragColor = vec4(col + vec3(0.012, 0.012, 0.014) * acc.a, acc.a);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

export function HeroSlab() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const onScreen = useOnScreen(wrap);
  const [live, setLive] = useState(false);
  const draw = useRef<((now: number | null) => void) | null>(null);
  const stillRef = useRef(false);

  // Set up once: program, uniforms and a draw function.
  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const gl = el.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {
      res: gl.getUniformLocation(prog, "uRes"),
      time: gl.getUniformLocation(prog, "uTime"),
      intro: gl.getUniformLocation(prog, "uIn"),
      ptr: gl.getUniformLocation(prog, "uPtr"),
      samples: gl.getUniformLocation(prog, "uSamples"),
    };

    let samples = 2;
    const size = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(box.clientWidth * scale));
      const h = Math.max(2, Math.round(box.clientHeight * scale));
      samples = scale >= 2 ? 2 : 4;
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    size();

    const target = { x: 0, y: 0 };
    const ptr = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      if (window.matchMedia("(hover: hover)").matches) return;
      target.x = Math.max(-1, Math.min(1, (window.scrollY / Math.max(1, window.innerHeight)) * 2.4 - 0.4));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    let clock = 0;
    let last = 0;
    // now: a frame time, or null to redraw the current moment (resize, still frame).
    draw.current = (now: number | null) => {
      const dt = now === null || last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now ?? 0;
      clock += dt;
      ptr.x += (target.x - ptr.x) * Math.min(1, dt * 2.2);
      ptr.y += (target.y - ptr.y) * Math.min(1, dt * 2.2);
      const still = stillRef.current;
      const k = still ? 1 : Math.min(1, clock / INTRO_SECONDS);
      gl.uniform2f(u.res, el.width, el.height);
      gl.uniform1f(u.time, still ? 0 : clock);
      gl.uniform1f(u.intro, 1 - Math.pow(1 - k, 3));
      gl.uniform2f(u.ptr, still ? 0 : ptr.x, still ? 0 : ptr.y);
      gl.uniform1f(u.samples, samples);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const ro = new ResizeObserver(() => {
      size();
      draw.current?.(null);
    });
    ro.observe(box);
    setLive(true);

    return () => {
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
      draw.current = null;
    };
  }, []);

  // The frame loop, only while visible and only when motion is welcome.
  useEffect(() => {
    stillRef.current = reduced;
    if (!live) return;
    draw.current?.(null);
    if (reduced || !onScreen) return;
    let raf = 0;
    let prev = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - prev < FRAME_MS - 1) return;
      prev = now;
      draw.current?.(now);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      draw.current?.(null);
    };
  }, [live, reduced, onScreen]);

  return (
    <div ref={wrap} className="slab" data-live={live} role="img" aria-label="A block of polished black stone with one fine silver line set into it, standing on a dark mirror.">
      <div className="slab-still" aria-hidden="true" />
      <canvas ref={canvas} className="slab-canvas" aria-hidden="true" />
    </div>
  );
}
