"use client";

// The tree of the home page: the owner's engraving of an old oak on its field
// (public/art/tree.webp, white line on a clear ground). The picture itself is
// in the page from the first paint. Over it lies a canvas that draws the same
// picture on the graphics card and lets it breathe: the crown leans a hair in
// the wind, the leaves tremble, the grass moves. Nothing is moved by more than
// a pixel or two, so it reads as a living engraving, not as an animation.
//
// The canvas draws only while the tree is on screen and the tab is shown, at
// 30 frames a second at most, and never larger than the picture itself. With
// reduced motion, without WebGL or after a lost context the picture stands
// still.

import { useEffect, useRef } from "react";

const SRC = "/art/tree.webp";
export const TREE_SIZE = [1652, 724] as const;
const FRAME_GAP = 30;

const VERTEX = `
attribute vec2 a_corner;
varying vec2 v_at;
void main() {
  v_at = vec2(a_corner.x * 0.5 + 0.5, 0.5 - a_corner.y * 0.5);
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

// The foot of the trunk is at (0.727, 0.78) of the picture. Everything above
// it sways about that point, more the higher it stands; the leaves get a finer
// tremble of their own; the grass under the horizon moves with the gusts.
const FRAGMENT = `
precision highp float;
uniform sampler2D u_tree;
uniform vec3 u_clock; // sway, tremble, gusts
uniform vec2 u_texel;
varying vec2 v_at;
void main() {
  vec2 at = v_at;
  float above = clamp((0.74 - at.y) / 0.7, 0.0, 1.0);
  float crown = above * above * smoothstep(0.34, 0.5, at.x);
  float sway = sin(u_clock.x + at.y * 2.0) + 0.5 * sin(2.0 * u_clock.x + at.x * 7.0 + 1.3);
  float tremble = sin(u_clock.y + at.x * 61.0 + at.y * 47.0) * sin(u_clock.y * 2.0 + at.x * 23.0 - at.y * 31.0);
  float grass = smoothstep(0.7, 0.8, at.y) * sin(u_clock.z + at.x * 46.0 + at.y * 20.0);
  vec2 move = vec2(crown * (2.6 * sway + 1.3 * tremble) + 1.2 * grass, crown * 0.7 * tremble);
  gl_FragColor = texture2D(u_tree, at + move * u_texel);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function HeroTree() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const holder = canvas?.parentElement;
    if (!canvas || !holder) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion !== "on") return;

    let raf = 0;
    let stopped = false;
    let shown = false;
    let ready = false;
    const cleanups: (() => void)[] = [];
    const stand = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      delete holder.dataset.live;
    };

    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
    const vertex = gl && compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = gl && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl && gl.createProgram();
    if (!gl || !vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "a_corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    const clockAt = gl.getUniformLocation(program, "u_clock");
    gl.uniform2f(gl.getUniformLocation(program, "u_texel"), 1 / TREE_SIZE[0], 1 / TREE_SIZE[1]);
    const clock = new Float32Array(3);

    const texture = gl.createTexture();
    const picture = new Image();
    picture.decoding = "async";
    picture.onload = () => {
      if (stopped) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      ready = true;
      run();
    };
    picture.src = SRC;

    // Size: told by the observer, never asked for; never larger than the picture.
    let sized = false;
    const resize = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      if (!box.width || !box.height) return;
      const scale = Math.min(window.devicePixelRatio || 1, TREE_SIZE[0] / box.width);
      const w = Math.max(1, Math.round(box.width * scale));
      const h = Math.max(1, Math.round(box.height * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      sized = true;
    });
    resize.observe(canvas);
    cleanups.push(() => resize.disconnect());

    let last = 0;
    let seconds = 0;
    let drawn = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!sized || !ready) return;
      const gap = now - last;
      if (last && gap < FRAME_GAP) return;
      if (last && gap < 250) seconds += gap / 1000;
      last = now;
      // one sway every nine seconds, a tremble every two, a gust every five
      clock[0] = ((seconds / 9) % 1) * Math.PI * 2;
      clock[1] = ((seconds / 2.3) % 1) * Math.PI * 2;
      clock[2] = ((seconds / 5) % 1) * Math.PI * 2;
      gl.uniform3fv(clockAt, clock);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (++drawn === 2) holder.dataset.live = "true";
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (stopped || !shown || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", run);
    cleanups.push(() => document.removeEventListener("visibilitychange", run));
    const watch = new IntersectionObserver((entries) => {
      shown = entries[entries.length - 1].isIntersecting;
      run();
    });
    watch.observe(canvas);
    cleanups.push(() => watch.disconnect());
    const lost = (event: Event) => {
      event.preventDefault();
      stand();
    };
    canvas.addEventListener("webglcontextlost", lost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", lost));

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      picture.onload = null;
      for (const cleanup of cleanups) cleanup();
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(corners);
    };
  }, []);

  return (
    <div className="hero-tree" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="hero-tree-still" src={SRC} alt="" width={TREE_SIZE[0]} height={TREE_SIZE[1]} decoding="async" fetchPriority="high" />
      <canvas ref={ref} className="hero-tree-live" />
    </div>
  );
}
