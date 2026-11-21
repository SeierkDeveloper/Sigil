"use client";

// The page ground in motion: one canvas, drawn by one fragment shader on the
// graphics card (groundShader.ts). It is built so that scrolling never waits
// for it:
//
// - the canvas is fixed behind the page and opaque, so it is its own layer and
//   the browser only slides the page over it;
// - it is drawn as sharp as the screen, twice the CSS size at most, with a
//   whole number of canvas pixels per dot, and never more than about 3.4
//   million pixels;
// - a frame is one draw call with a dozen numbers; nothing is allocated,
//   the layout is never read (the size arrives from a ResizeObserver) and
//   nothing listens to scrolling or to the pointer;
// - what moves is slow, so it draws 30 frames a second at most, none while
//   the tab is hidden or the canvas is not shown.
//
// The sky's cold light is for the public pages. In the vault it is put out, so
// the working screens stay plain.
//
// It steps aside for the still drawing under it (the same land, in
// Backdrop.tsx) when the visitor asked for less motion, when WebGL is missing
// or only runs in software, when the context is lost, and when the first
// frames show the graphics card cannot keep up.

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { fitDots } from "../art/dots";
import { FRAGMENT, VERTEX, advance, layOut, makeUniforms } from "./groundShader";

/** Shortest time between two frames, in ms: 30 a second, whatever the screen. */
const FRAME_GAP = 30;
const MAX_PIXELS = 3_400_000;
/** Frames timed per check. */
const WINDOW = 36;
/** A median above this (ms) is slow: first the canvas gets coarser, then it stops. */
const SLOW = 46;
const TOO_SLOW = 80;
const COARSE = 0.6;

/** The sky's light is put out on the working screens of the vault. */
const skyFor = (pathname: string | null) => (pathname && /^\/vault(\/|$)/.test(pathname) ? 0 : 1);

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function Ground() {
  const ref = useRef<HTMLCanvasElement>(null);
  const pathname = usePathname();
  const sky = useRef(skyFor(pathname));
  useEffect(() => {
    sky.current = skyFor(pathname);
  }, [pathname]);

  useEffect(() => {
    const canvas = ref.current;
    const holder = canvas?.parentElement;
    if (!canvas || !holder) return;

    const less = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let stopped = false;
    const cleanups: (() => void)[] = [];

    /** Hand the ground back to the still drawing, for good. */
    const stand = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      holder.dataset.ground = "still";
    };

    if (less.matches || document.documentElement.dataset.motion !== "on") {
      stand();
      return;
    }

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    });
    const vertex = gl && compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = gl && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl && gl.createProgram();
    if (!gl || !vertex || !fragment || !program) {
      stand();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      stand();
      return;
    }
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
      scene: gl.getUniformLocation(program, "u_scene"),
      clock: gl.getUniformLocation(program, "u_clock"),
    };
    const uniforms = makeUniforms();

    // Size: told by the observer, never asked for.
    let cssWidth = 0;
    let cssHeight = 0;
    let quality = 1;
    let sized = false;
    const dots = new Float32Array([5, 1, sky.current, 0]);
    const fit = () => {
      if (!cssWidth || !cssHeight) return;
      const size = fitDots(cssWidth, cssHeight, window.devicePixelRatio || 1, MAX_PIXELS, quality);
      const w = size.width;
      const h = size.height;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(at.res, w, h);
      dots[0] = size.step;
      dots[1] = size.px;
      layOut(uniforms, cssWidth, cssHeight);
      gl.uniform4fv(at.scene, uniforms.scene);
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

    // The loop.
    let shown = true;
    let last = 0;
    let seconds = 0;
    let drawn = 0;
    let timed = 0;
    let slowBefore = false;
    const times = new Float32Array(WINDOW);

    const judge = () => {
      const median = Array.from(times).sort((x, y) => x - y)[WINDOW >> 1];
      if (median > TOO_SLOW && quality < 1) return stand();
      if (median > SLOW) {
        // Twice in a row: coarser first, and if that was already tried, stop.
        if (slowBefore) {
          if (quality < 1) return stand();
          quality = COARSE;
          fit();
        }
        slowBefore = !slowBefore;
      } else {
        slowBefore = false;
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!sized) return;
      const gap = now - last;
      if (last && gap < FRAME_GAP) return;
      // After a pause the clock goes on from where it was, and the pause is not timed.
      const resumed = !last || gap > 250;
      last = now;
      if (!resumed) {
        seconds += gap / 1000;
        // The first second belongs to the page loading, not to the ground.
        if (drawn > 30) {
          times[timed++] = gap;
          if (timed === WINDOW) {
            timed = 0;
            judge();
            if (stopped) return;
          }
        }
      }
      advance(uniforms, seconds);
      gl.uniform4fv(at.clock, uniforms.clock);
      // the sky's light comes and goes over a second or so when the page changes
      dots[2] += (sky.current - dots[2]) * 0.08;
      gl.uniform4fv(at.dots, dots);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (++drawn === 2) holder.dataset.ground = "live";
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

    const calmer = () => {
      if (less.matches) stand();
    };
    less.addEventListener("change", calmer);
    cleanups.push(() => less.removeEventListener("change", calmer));

    run();

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

  return <canvas ref={ref} className="backdrop-live" />;
}
