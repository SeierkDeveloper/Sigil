"use client";

// The page ground, behind every page: black, engraved with two ribbons of fine
// parallel lines, the line language of the logo. A soft light drifts slowly
// across the page and a second one follows the pointer; the engraving shows
// only where the light falls. The ribbons bend and breathe very slowly and
// move a little slower than the page when scrolling.
//
// One 2D canvas, 30 frames a second at most (the lines are redrawn at half
// that unless the page scrolls), stopped in a hidden tab. With reduced motion
// it draws one finished frame and stays still.

import { useEffect, useRef } from "react";

const LINES = 24; // lines in one ribbon
const GAP = 5; // px between them where the ribbon lies flat
const STEP = 12; // px between points along a line
const FRAME_MS = 1000 / 30;
const LAYER_MS = 1000 / 15;

// Where each ribbon sits in the repeating height, how it leans and how it bends.
const RIBBONS = [
  { at: 0.27, lean: 0.11, sway: 0.06, turns: 1.0, phase: 0.6, fold: 0.8, foldPhase: 1.9 },
  { at: 0.77, lean: -0.08, sway: 0.05, turns: 1.3, phase: 3.4, fold: 1.1, foldPhase: 0.4 },
];

export function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const layer = document.createElement("canvas");
    const lctx = layer.getContext("2d")!;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let layerH = 0; // the height after which the engraving repeats
    let raf = 0;
    let lastFrame = 0;
    let lastLayer = 0;
    let lastShift = -1;
    let disposed = false;
    const started = performance.now();
    // The pointer light eases toward the pointer and fades when it leaves.
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, on: 0, target: 0 };

    function build() {
      W = window.innerWidth;
      H = Math.max(window.innerHeight, H);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      while (dpr > 1 && W * H * dpr * dpr > 3_300_000) dpr -= 0.5;
      for (const c of [canvas!, layer]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      canvas!.style.width = `${W}px`;
      canvas!.style.height = `${H}px`;
      layerH = Math.max(1100, H * 1.5);
      lastShift = -1;
    }

    const scrollShift = () => (reduced.matches ? 0 : (window.scrollY * 0.12) % layerH);

    // The ribbons, drawn fresh: every line follows the same bend, and the
    // bundle narrows and opens again the way a ribbon does when it turns.
    function drawLayer(now: number, shift: number) {
      const t = reduced.matches ? 0 : (now - started) / 1000;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.clearRect(0, 0, W, H);
      lctx.lineWidth = 1;
      lctx.strokeStyle = "#fff";
      const reach = (LINES * GAP) / 2 + layerH * 0.2;
      for (const r of RIBBONS) {
        for (const wrap of [-layerH, 0, layerH]) {
          const base = r.at * layerH - shift + wrap;
          if (base < -reach || base > H + reach) continue;
          for (let k = 0; k < LINES; k++) {
            const side = k / (LINES - 1) - 0.5; // -0.5 to 0.5 across the ribbon
            // Brighter toward one edge, with a firm outline, as in the logo.
            lctx.globalAlpha = k === 0 || k === LINES - 1 ? 0.8 : 0.24 + 0.4 * (k / LINES);
            lctx.beginPath();
            for (let x = -STEP; x <= W + STEP; x += STEP) {
              const u = (x / W) * Math.PI * 2;
              const centre = base + r.lean * layerH * (x / W - 0.5) + r.sway * layerH * Math.sin(u * r.turns + r.phase + t * 0.021);
              const open = 0.62 + 0.38 * Math.sin(u * r.fold + r.foldPhase + t * 0.016);
              const y = centre + side * (LINES - 1) * GAP * open;
              if (x === -STEP) lctx.moveTo(x, y);
              else lctx.lineTo(x, y);
            }
            lctx.stroke();
          }
        }
      }
      lctx.globalAlpha = 1;
    }

    function lights(now: number) {
      const t = reduced.matches ? 0 : (now - started) / 1000;
      const big = Math.max(W, H);
      const a = {
        x: W * (0.5 + 0.34 * Math.sin(t * 0.07 + 0.75)),
        y: H * (0.44 + 0.26 * Math.sin(t * 0.052 + 0.2)),
        r: Math.max(420, big * 0.5),
        k: 1,
      };
      const b = {
        x: W * (0.5 + 0.4 * Math.sin(t * 0.043 + 3.6)),
        y: H * (0.62 + 0.3 * Math.cos(t * 0.06 + 2.2)),
        r: Math.max(300, big * 0.32),
        k: 0.55,
      };
      const out = [a, b];
      if (pointer.on > 0.01) out.push({ x: pointer.x, y: pointer.y, r: 420, k: 0.7 * pointer.on });
      return out;
    }

    // `reach` scales the radius: the wash of a light spreads wide, the engraving shows nearer its centre.
    function fillLights(list: ReturnType<typeof lights>, peak: number, reach: number) {
      for (const l of list) {
        const r = l.r * reach;
        // Wider than tall, as a highlight sits on a polished surface.
        ctx!.save();
        ctx!.translate(l.x, l.y);
        ctx!.scale(1.5, 1);
        const g = ctx!.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, `rgba(255,255,255,${peak * l.k})`);
        g.addColorStop(0.4, `rgba(255,255,255,${peak * l.k * 0.4})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx!.fillStyle = g;
        ctx!.fillRect(-r, -r, r * 2, r * 2);
        ctx!.restore();
      }
    }

    function render(now: number) {
      const shift = scrollShift();
      if (shift !== lastShift || now - lastLayer >= LAYER_MS - 2 || reduced.matches) {
        drawLayer(now, shift);
        lastLayer = now;
        lastShift = shift;
      }
      const list = lights(now);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalCompositeOperation = "source-over";
      ctx!.clearRect(0, 0, W, H);
      // 1. Where the light falls, and how strongly.
      fillLights(list, 0.24, 0.62);
      // 2. The engraving, kept only where there is light.
      ctx!.globalCompositeOperation = "source-in";
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.drawImage(layer, 0, 0);
      // 3. A faint wash of the light itself, behind the engraving.
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalCompositeOperation = "destination-over";
      fillLights(list, 0.05, 1);
    }

    function frame(now: number) {
      raf = 0;
      if (disposed || document.hidden) return;
      raf = requestAnimationFrame(frame);
      if (now - lastFrame < FRAME_MS - 2) return;
      lastFrame = now;
      pointer.on += (pointer.target - pointer.on) * 0.06;
      pointer.x += (pointer.tx - pointer.x) * 0.09;
      pointer.y += (pointer.ty - pointer.y) * 0.09;
      render(now);
    }

    function start() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (disposed) return;
      if (reduced.matches) {
        // One finished frame.
        build();
        render(started);
        return;
      }
      if (!document.hidden) raf = requestAnimationFrame(frame);
    }

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        // Phone address bars change the height all the time; only a new width or more height matters.
        if (window.innerWidth === W && window.innerHeight <= H) return;
        if (window.innerWidth !== W) H = 0;
        build();
        start();
      }, 180);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !fine.matches) return;
      if (pointer.target === 0 && pointer.on < 0.02) {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
      }
      pointer.tx = e.clientX;
      pointer.ty = e.clientY;
      pointer.target = 1;
    };
    const onLeave = () => {
      pointer.target = 0;
    };
    const onVisible = () => start();

    let cleanup = () => {};
    const begin = () => {
      if (disposed) return;
      build();
      start();
      canvas.dataset.ready = "true";
      window.addEventListener("resize", onResize);
      window.addEventListener("pointermove", onMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisible);
      reduced.addEventListener("change", onVisible);
      cleanup = () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pointermove", onMove);
        document.documentElement.removeEventListener("pointerleave", onLeave);
        document.removeEventListener("visibilitychange", onVisible);
        reduced.removeEventListener("change", onVisible);
      };
    };
    begin();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      cleanup();
    };
  }, []);

  return (
    <div className="backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="backdrop-canvas" />
      <div className="backdrop-rules" />
      <div className="backdrop-grain" />
    </div>
  );
}
