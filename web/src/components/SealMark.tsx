"use client";

// The hero seal: a dark metal disc whose marks are engraved line by line, then
// lit by a slow moving light. The artwork is drawn once on a 2D canvas and used
// as a height map in a small WebGL shader. Without WebGL, or before it starts,
// the still drawing below is shown; with reduced motion one finished frame is drawn.

import { useEffect, useRef, useState } from "react";

const LEGEND = ["SIGIL", "YOUR AI SELF", "OWNED BY YOU", "FOREVER"];
const ETCH_SECONDS = 7;
const FRAME_MS = 1000 / 30;

function heptagram(radius: number) {
  const points = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
    return [radius * Math.cos(a), radius * Math.sin(a)] as const;
  });
  return { points, star: points.map((_, i) => points[(i * 3) % 7]) };
}

/** The still drawing: fallback and first paint. */
function StillSeal() {
  const ticks = Array.from({ length: 120 }, (_, i) => i * 3);
  const { points, star } = heptagram(45);
  return (
    <svg className="seal-still" viewBox="0 0 200 200" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="100" cy="100" r="97" strokeWidth="1.4" />
      <circle cx="100" cy="100" r="93" strokeWidth="0.4" />
      <circle cx="100" cy="100" r="84.5" strokeWidth="0.4" />
      {ticks.map((deg) => (
        <line key={deg} x1="100" y1="17.5" x2="100" y2={deg % 15 === 0 ? 23 : 20.5} strokeWidth="0.4" transform={`rotate(${deg} 100 100)`} />
      ))}
      <circle cx="100" cy="100" r="76" strokeWidth="0.4" />
      <circle cx="100" cy="100" r="54" strokeWidth="0.6" />
      <polygon points={star.map(([x, y]) => `${(100 + x).toFixed(2)},${(100 + y).toFixed(2)}`).join(" ")} strokeWidth="0.8" strokeLinejoin="round" />
      {points.map(([x, y], i) => (
        <circle key={i} cx={100 + x} cy={100 + y} r="2.6" strokeWidth="0.6" fill="var(--color-bg)" />
      ))}
      <circle cx="100" cy="100" r="6.5" strokeWidth="0.6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ artwork */

interface Art {
  size: number;
  data: Uint8Array;
}

/**
 * Draws the seal twice: once as line heights, once as "when is this pixel cut"
 * (0 first, 1 last). Returns one texture: R height, G order, B and A the slope.
 */
function buildArt(size: number, fontFamily: string): Art | null {
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c.getContext("2d", { willReadFrequently: true });
  };
  const mask = mk();
  const order = mk();
  if (!mask || !order) return null;

  const C = size / 2;
  const U = size / 2; // one disc radius
  const px = size / 1024; // line widths are given for a 1024 px drawing
  mask.fillStyle = "#000";
  mask.fillRect(0, 0, size, size);
  order.fillStyle = "#fff";
  order.fillRect(0, 0, size, size);
  for (const ctx of [mask, order]) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }
  const grey = (v: number) => {
    const n = Math.max(0, Math.min(255, Math.round(v * 255)));
    return `rgb(${n},${n},${n})`;
  };

  /** A polyline in disc units, cut from o0 to o1 along its length. */
  const line = (pts: (readonly [number, number])[], width: number, level: number, o0: number, o1: number) => {
    mask.strokeStyle = grey(level);
    mask.lineWidth = width * px;
    mask.beginPath();
    pts.forEach(([x, y], i) => (i ? mask.lineTo(C + x * U, C + y * U) : mask.moveTo(C + x * U, C + y * U)));
    mask.stroke();
    order.lineWidth = (width + 7) * px;
    const n = pts.length - 1;
    for (let i = 0; i < n; i++) {
      order.strokeStyle = grey(o0 + ((o1 - o0) * i) / Math.max(1, n - 1));
      order.beginPath();
      order.moveTo(C + pts[i][0] * U, C + pts[i][1] * U);
      order.lineTo(C + pts[i + 1][0] * U, C + pts[i + 1][1] * U);
      order.stroke();
    }
  };

  const ring = (radius: number, width: number, level: number, o0: number, o1: number, start: number, dir: 1 | -1, wobble?: (a: number) => number) => {
    const steps = 360;
    const pts = Array.from({ length: steps + 1 }, (_, i) => {
      const a = start + dir * (i / steps) * Math.PI * 2;
      const r = radius + (wobble ? wobble(a) : 0);
      return [r * Math.cos(a), r * Math.sin(a)] as const;
    });
    line(pts, width, level, o0, o1);
  };

  const TOP = -Math.PI / 2;

  // Outer rings and the legend between them.
  ring(0.944, 1.9, 0.9, 0.0, 0.2, TOP, 1);
  ring(0.862, 1.5, 0.8, 0.03, 0.24, Math.PI / 2, -1);

  const legendR = 0.902;
  const fontPx = 0.064 * U;
  const tracking = 0.03 * U;
  for (const ctx of [mask, order]) {
    ctx.font = `600 ${fontPx}px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
  }
  LEGEND.forEach((phrase, k) => {
    const chars = [...phrase];
    const widths = chars.map((ch) => mask.measureText(ch).width + tracking);
    const total = widths.reduce((a, b) => a + b, 0);
    const centre = (k / LEGEND.length) * Math.PI * 2;
    let at = centre - total / (legendR * U) / 2;
    chars.forEach((ch, i) => {
      const a = at + widths[i] / (legendR * U) / 2;
      at += widths[i] / (legendR * U);
      const turn = a / (Math.PI * 2);
      const o = 0.08 + 0.42 * (((turn % 1) + 1) % 1);
      for (const ctx of [mask, order]) {
        ctx.save();
        ctx.translate(C + legendR * U * Math.sin(a), C - legendR * U * Math.cos(a));
        ctx.rotate(a);
        if (ctx === mask) {
          ctx.fillStyle = grey(1);
          ctx.fillText(ch, 0, fontPx * 0.04);
        } else {
          ctx.fillStyle = grey(o);
          ctx.fillRect(-widths[i] / 2 - px, -fontPx * 0.62, widths[i] + 2 * px, fontPx * 1.24);
        }
        ctx.restore();
      }
    });
    // A small diamond between phrases.
    const d = centre + Math.PI / LEGEND.length;
    const s = 0.011 * U;
    for (const ctx of [mask, order]) {
      ctx.save();
      ctx.translate(C + legendR * U * Math.sin(d), C - legendR * U * Math.cos(d));
      ctx.rotate(d + Math.PI / 4);
      ctx.fillStyle = ctx === mask ? grey(0.9) : grey(0.08 + 0.42 * ((d / (Math.PI * 2)) % 1));
      const k2 = ctx === mask ? s : s + 5 * px;
      ctx.fillRect(-k2, -k2, 2 * k2, 2 * k2);
      ctx.restore();
    }
  });

  // The hour band: 120 marks, every fifth longer, 24 in all.
  for (let i = 0; i < 120; i++) {
    const a = TOP + (i / 120) * Math.PI * 2;
    const long = i % 5 === 0;
    const r0 = long ? 0.796 : 0.822;
    const o = 0.16 + 0.4 * (i / 120);
    line(
      [
        [r0 * Math.cos(a), r0 * Math.sin(a)],
        [0.846 * Math.cos(a), 0.846 * Math.sin(a)],
      ],
      long ? 2 : 1.3,
      long ? 1 : 0.7,
      o,
      o + 0.02,
    );
  }
  ring(0.778, 1.5, 0.8, 0.14, 0.36, TOP, -1);

  // The woven band, cut like a rose engine would.
  const strands = 8;
  for (let j = 0; j < strands; j++) {
    const phase = (j / strands) * Math.PI * 2;
    ring(0.664, 1.05, 0.5, 0.28 + j * 0.012, 0.6 + j * 0.012, TOP, 1, (a) => 0.082 * Math.sin(12 * a + phase));
  }
  ring(0.552, 1.6, 0.85, 0.44, 0.6, Math.PI / 2, 1);
  ring(0.536, 1, 0.55, 0.46, 0.62, TOP, -1);

  // The mark itself.
  const { points, star } = heptagram(0.452);
  const path: (readonly [number, number])[] = [];
  for (let i = 0; i < 7; i++) {
    const a = star[i];
    const b = star[(i + 1) % 7];
    for (let s = 0; s < 40; s++) path.push([a[0] + ((b[0] - a[0]) * s) / 40, a[1] + ((b[1] - a[1]) * s) / 40]);
  }
  path.push(star[0]);
  line(path, 2.8, 1, 0.56, 0.9);
  ring(0.2, 1, 0.5, 0.7, 0.86, TOP, 1);
  points.forEach(([x, y], i) => {
    const o = 0.88 + i * 0.012;
    mask.fillStyle = "#000";
    mask.beginPath();
    mask.arc(C + x * U, C + y * U, 0.03 * U, 0, Math.PI * 2);
    mask.fill();
    const pts = Array.from({ length: 25 }, (_, s) => {
      const a = (s / 24) * Math.PI * 2;
      return [x + 0.03 * Math.cos(a), y + 0.03 * Math.sin(a)] as const;
    });
    line(pts, 2.2, 1, o, o + 0.04);
  });
  mask.fillStyle = "#000";
  mask.beginPath();
  mask.arc(C, C, 0.072 * U, 0, Math.PI * 2);
  mask.fill();
  ring(0.072, 2.2, 1, 0.93, 0.99, TOP, 1);
  ring(0.016, 2.4, 1, 0.985, 1.0, TOP, 1);

  // Pack: height, order and slope, with the first row at the bottom (GL convention).
  const m = mask.getImageData(0, 0, size, size).data;
  const o = order.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size;
    for (let x = 0; x < size; x++) h[y * size + x] = m[(src + x) * 4];
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - 1) * size;
    const y1 = y * size;
    const y2 = Math.min(size - 1, y + 1) * size;
    const src = (size - 1 - y) * size;
    for (let x = 0; x < size; x++) {
      const xa = Math.max(0, x - 1);
      const xb = Math.min(size - 1, x + 1);
      const gx = h[y0 + xb] + 2 * h[y1 + xb] + h[y2 + xb] - h[y0 + xa] - 2 * h[y1 + xa] - h[y2 + xa];
      const gy = h[y2 + xa] + 2 * h[y2 + x] + h[y2 + xb] - h[y0 + xa] - 2 * h[y0 + x] - h[y0 + xb];
      const i = (y1 + x) * 4;
      data[i] = h[y1 + x];
      data[i + 1] = o[(src + x) * 4];
      data[i + 2] = Math.max(0, Math.min(255, 127.5 + gx * 0.125));
      data[i + 3] = Math.max(0, Math.min(255, 127.5 + gy * 0.125));
    }
  }
  return { size, data };
}

/* ------------------------------------------------------------------ shader */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D uArt;
uniform vec2 uRes;
uniform float uTime;
uniform float uProgress;
uniform float uPulse;
uniform float uFade;
uniform vec2 uPointer;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  float unit = 0.5 * min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / unit * 1.12;

  // The disc leans a little and follows the pointer.
  vec2 lean = 0.16 * vec2(sin(uTime * 0.23), cos(uTime * 0.17)) + 0.14 * uPointer;
  vec3 n = normalize(vec3(lean, 1.0));
  vec3 ex = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 ey = cross(n, ex);
  vec3 eye = vec3(0.0, 0.0, 5.0);
  vec3 dir = normalize(vec3(p, -5.0));
  vec3 hit = eye - dir * (dot(eye, n) / dot(dir, n));
  vec2 q = vec2(dot(hit, ex), dot(hit, ey));
  float r = length(q);
  float px = 1.12 / unit;

  // Light, in the disc's own frame.
  float la = uTime * 0.21 + 0.9 + uPointer.x * 0.8;
  vec3 Lw = normalize(vec3(cos(la) * 0.8, sin(la) * 0.8 + uPointer.y * 0.3, 0.62));
  vec3 L = vec3(dot(Lw, ex), dot(Lw, ey), dot(Lw, n));
  vec3 V = vec3(dot(-dir, ex), dot(-dir, ey), dot(-dir, n));
  vec3 H = normalize(L + V);

  // Each band turns at its own pace, and turns into place while it is cut.
  float settle = 1.0 - smoothstep(0.0, 1.0, uProgress);
  settle = settle * settle;
  float ang;
  float tone;
  if (r > 0.862) { ang = 0.016 * uTime + 0.9 * settle; tone = 1.0; }
  else if (r > 0.778) { ang = -0.024 * uTime - 1.3 * settle; tone = 0.72; }
  else if (r > 0.544) { ang = 0.011 * uTime + 0.7 * settle; tone = 0.5; }
  else { ang = -0.007 * uTime - 0.5 * settle; tone = 0.86; }
  vec2 qs = rot(ang) * q;
  vec4 art = texture2D(uArt, qs * 0.5 + 0.5);
  vec2 slope = rot(-ang) * (art.ba * 2.0 - 1.0);

  float cut = smoothstep(0.0, 0.035, uProgress - art.g);
  float line = art.r * cut;

  // Brushed face: circular grooves give two bright wedges that follow the light.
  vec2 tg = vec2(-q.y, q.x) / max(r, 0.0001);
  float tdh = dot(tg, H.xy);
  float wedge = pow(max(0.0, 1.0 - tdh * tdh), 46.0);
  float wide = pow(max(0.0, 1.0 - tdh * tdh), 9.0);
  float a = atan(q.y, q.x);
  float grain = 0.55 + 0.45 * noise(vec2(r * 330.0, a * 3.0)) + 0.25 * (noise(vec2(r * 90.0, 1.7)) - 0.5);
  float face = 0.034 + tone * (0.07 * wide + 0.4 * wedge * grain);
  face *= 1.0 - 0.35 * smoothstep(0.2, 1.0, r);

  // Engraved lines: bright floor, glinting walls.
  vec3 nn = normalize(vec3(-slope * 2.6 * cut, 1.0));
  float glint = pow(max(dot(nn, H), 0.0), 18.0) * length(slope) * 2.2 * cut;
  float floorLum = 0.6 + 0.42 * wide + 0.3 * wedge;
  vec3 silver = vec3(0.955, 0.965, 0.985);
  vec3 col = mix(vec3(face), silver * floorLum, clamp(line * 1.15, 0.0, 1.0));
  col += silver * glint * 0.55;

  // The cutting point, and now and then a light that runs the lines again.
  float e = uProgress - art.g;
  float head = art.r * exp(-(e * e) / 0.0004) * step(uProgress, 1.08);
  float pe = uPulse - art.g;
  float pulse = line * exp(-(pe * pe) / 0.003);
  col += vec3(1.0) * (head * 1.6 + pulse * 0.55);

  // The polished rim.
  float rimIn = 0.956;
  if (r > rimIn) {
    float x = (r - (rimIn + 1.0) * 0.5) / ((1.0 - rimIn) * 0.5);
    vec3 nr = normalize(vec3(q / r * x * 0.95, 1.0));
    float sp = pow(max(dot(nr, H), 0.0), 34.0);
    float env = 0.5 + 0.5 * dot(nr.xy, normalize(L.xy + vec2(0.0001)));
    col = silver * (0.07 + 0.2 * env * env + 0.95 * sp + 0.22 * wedge);
  }
  col *= 1.0 - 0.75 * smoothstep(px * 2.5, 0.0, abs(r - rimIn));

  float inside = 1.0 - smoothstep(1.0 - px * 1.5, 1.0, r);
  float halo = exp(-max(r - 1.0, 0.0) * 30.0) * 0.08 * (0.6 + 0.4 * wide);
  vec3 outc = col * inside + vec3(halo) * (1.0 - inside);
  float alpha = max(inside, halo * (1.0 - inside));
  gl_FragColor = vec4(outc * uFade, alpha * uFade);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

export function SealMark() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const host = wrap.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
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
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    const uRes = u("uRes");
    const uTime = u("uTime");
    const uProgress = u("uProgress");
    const uPulse = u("uPulse");
    const uFade = u("uFade");
    const uPointer = u("uPointer");
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let alive = true;
    let artSize = 0;
    let raf = 0;
    let visible = true;
    let shown = !document.hidden;
    let last = 0;
    let clock = 0; // seconds of visible time
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const size = () => {
      const box = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(box.width * dpr));
      if (canvas.width !== w || canvas.height !== w) {
        canvas.width = w;
        canvas.height = w;
        gl.viewport(0, 0, w, w);
      }
      return w;
    };

    const loadArt = () => {
      const w = size();
      // The drawing covers the disc, which fills about 90% of the canvas.
      const want = Math.max(640, Math.min(1792, Math.round((w * 0.9) / 64) * 64));
      if (Math.abs(want - artSize) < 128 && artSize) return true;
      const family = getComputedStyle(document.documentElement).getPropertyValue("--face-display").trim() || "serif";
      const art = buildArt(want, family);
      if (!art) return false;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, art.size, art.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, art.data);
      artSize = want;
      return true;
    };

    const draw = (seconds: number, progress: number, pulse: number, fade: number) => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, seconds);
      gl.uniform1f(uProgress, progress);
      gl.uniform1f(uPulse, pulse);
      gl.uniform1f(uFade, fade);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number) => {
      raf = 0;
      if (!alive || !visible || !shown) return;
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME_MS - 2) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      clock += dt;
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      const t = Math.min(1, clock / ETCH_SECONDS);
      // Ease out, so the last strokes land softly.
      const progress = 1.12 * (1 - Math.pow(1 - t, 1.7));
      const since = clock - ETCH_SECONDS - 5;
      const pulse = since > 0 ? ((since % 16) / 4.5) * 1.3 - 0.15 : -1;
      draw(clock, progress, pulse > 1.2 ? -1 : pulse, Math.min(1, clock / 1.1));
    };

    const start = () => {
      if (raf || !alive || still.matches) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const drawStill = () => {
      pointer.x = pointer.y = 0;
      draw(21, 1.12, -1, 1);
    };
    const refresh = () => {
      if (!loadArt()) return;
      if (still.matches) {
        stop();
        drawStill();
      } else {
        start();
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      },
      { threshold: 0.01 },
    );
    io.observe(host);
    const onVisibility = () => {
      shown = !document.hidden;
      if (shown) start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => alive && refresh(), 120);
    });
    ro.observe(host);
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const box = host.getBoundingClientRect();
      pointer.tx = Math.max(-1, Math.min(1, (e.clientX - (box.left + box.width / 2)) / (window.innerWidth / 2)));
      pointer.ty = Math.max(-1, Math.min(1, -(e.clientY - (box.top + box.height / 2)) / (window.innerHeight / 2)));
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    const onMotion = () => refresh();
    still.addEventListener("change", onMotion);
    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      alive = false;
      setLive(false);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    // The legend uses the display face, so wait for it before drawing.
    const fonts = document.fonts;
    const family = getComputedStyle(document.documentElement).getPropertyValue("--face-display").trim() || "serif";
    Promise.race([fonts.load(`600 40px ${family}`, "SIGIL"), new Promise((r) => setTimeout(r, 1500))])
      .catch(() => undefined)
      .then(() => {
        if (!alive) return;
        if (!loadArt()) return;
        setLive(true);
        if (still.matches) drawStill();
        else start();
      });

    return () => {
      alive = false;
      stop();
      io.disconnect();
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      still.removeEventListener("change", onMotion);
      canvas.removeEventListener("webglcontextlost", onLost);
    };
  }, []);

  return (
    <div ref={wrap} className="seal" data-live={live ? "true" : "false"}>
      <StillSeal />
      <canvas ref={canvasRef} className="seal-canvas" aria-hidden="true" />
    </div>
  );
}
