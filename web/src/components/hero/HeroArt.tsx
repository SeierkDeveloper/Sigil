"use client";

// The art of the home page's first screen: the owner's oak as a halftone
// under a sky of cold light (heroArtShader.ts).
//
// A still picture of it is in the page from the first paint: the oak's tone
// and a sky, seen through a mask of dots (dotted.css). Over it lies a canvas
// that prints the same piece on the graphics card, dot by dot, and lets it
// live: the light in the sky wanders, the crown leans a hair in the wind, the
// dots breathe.
//
// The canvas draws only while the piece is on screen and the tab is shown, 30
// frames a second at most, with a whole number of canvas pixels per dot and
// never more than about 3.4 million pixels. Nothing listens to scrolling. With
// reduced motion, without WebGL, after a lost context or on a graphics card
// that cannot keep up, the still picture stays.

import { useEffect, useRef } from "react";
import { fitDots, pitchFor } from "../art/dots";
import { FRAGMENT, TREE_SIZE, VERTEX, layOutHero } from "./heroArtShader";

const LIGHT = "/art/dots/tree-light.webp";
const SHADE = "/art/dots/tree-shade.webp";
const FRAME_GAP = 30;
const MAX_PIXELS = 3_400_000;
/** Frames timed per check; a median above SLOW (ms) twice makes the canvas coarser, then stops it. */
const WINDOW = 30;
const SLOW = 46;
const COARSE = 0.6;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function HeroArt() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const holder = canvas?.parentElement;
    if (!canvas || !holder) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion !== "on") return;

    let raf = 0;
    let stopped = false;
    let shown = false;
    let loaded = 0;
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
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const at = {
      res: gl.getUniformLocation(program, "u_res"),
      dots: gl.getUniformLocation(program, "u_dots"),
      tree: gl.getUniformLocation(program, "u_tree"),
      sky: gl.getUniformLocation(program, "u_sky"),
      clock: gl.getUniformLocation(program, "u_clock"),
    };
    const clock = new Float32Array(4);

    // The two tone pictures: the oak's light, and its shade on the sky.
    const textures = [LIGHT, SHADE].map((src, unit) => {
      const texture = gl.createTexture();
      const picture = new Image();
      picture.decoding = "async";
      picture.onload = () => {
        if (stopped) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        loaded++;
        run();
      };
      picture.src = src;
      cleanups.push(() => {
        picture.onload = null;
        gl.deleteTexture(texture);
      });
      return texture;
    });
    gl.uniform1i(gl.getUniformLocation(program, "u_light"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_shade"), 1);

    // Size: told by the observer. The screen of dots is laid so that it falls on the page ground's.
    let cssWidth = 0;
    let cssHeight = 0;
    let quality = 1;
    let sized = false;
    const fit = () => {
      if (!cssWidth || !cssHeight) return;
      const size = fitDots(cssWidth, cssHeight, window.devicePixelRatio || 1, MAX_PIXELS, quality);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      const top = canvas.getBoundingClientRect().top + window.scrollY;
      const pitch = pitchFor(cssWidth);
      const layout = layOutHero(cssWidth, cssHeight);
      gl.viewport(0, 0, size.width, size.height);
      gl.uniform2f(at.res, size.width, size.height);
      gl.uniform4f(at.dots, size.step, size.px, Math.round((((top % pitch) + pitch) % pitch) / size.px), 0);
      gl.uniform4fv(at.tree, layout.tree);
      gl.uniform4fv(at.sky, layout.sky);
      sized = true;
    };
    const resize = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      cssWidth = box.width;
      cssHeight = box.height;
      fit();
    });
    resize.observe(canvas);
    cleanups.push(() => resize.disconnect());

    let last = 0;
    let seconds = 0;
    let drawn = 0;
    let timed = 0;
    let slowBefore = false;
    const times = new Float32Array(WINDOW);
    const judge = () => {
      const median = Array.from(times).sort((x, y) => x - y)[WINDOW >> 1];
      if (median <= SLOW) {
        slowBefore = false;
        return;
      }
      if (slowBefore) {
        if (quality < 1) return stand();
        quality = COARSE;
        fit();
      }
      slowBefore = !slowBefore;
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!sized || loaded < textures.length) return;
      const gap = now - last;
      if (last && gap < FRAME_GAP) return;
      const resumed = !last || gap > 250;
      last = now;
      if (!resumed) {
        seconds += gap / 1000;
        if (drawn > 30) {
          times[timed++] = gap;
          if (timed === WINDOW) {
            timed = 0;
            judge();
            if (stopped) return;
          }
        }
      }
      // one sway every nine seconds, a tremble every two, the sky once in two minutes, a breath every five seconds
      clock[0] = ((seconds / 9) % 1) * Math.PI * 2;
      clock[1] = ((seconds / 2.3) % 1) * Math.PI * 2;
      clock[2] = ((seconds / 120) % 1) * Math.PI * 2;
      clock[3] = ((seconds / 5) % 1) * Math.PI * 2;
      gl.uniform4fv(at.clock, clock);
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
      for (const cleanup of cleanups) cleanup();
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(corners);
    };
  }, []);

  return (
    <div className="hero-art" aria-hidden="true">
      <div className="hero-art-still">
        <span className="hero-art-sky" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-art-shade" src={SHADE} alt="" width={TREE_SIZE[0] / 4} height={TREE_SIZE[1] / 4} decoding="async" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-art-light" src={LIGHT} alt="" width={TREE_SIZE[0] / 2} height={TREE_SIZE[1] / 2} decoding="async" fetchPriority="high" />
      </div>
      <canvas ref={ref} className="hero-art-live" />
    </div>
  );
}
