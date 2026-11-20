"use client";

// The page ground, behind every page: dark stone engraved with rows of
// ciphertext. A soft light drifts slowly across it and a second one follows
// the pointer; the engraving shows only where the light falls. Now and then a
// few characters resolve into a plain word and lock again.
//
// One 2D canvas, 30 frames a second at most, stopped in a hidden tab. With
// reduced motion it draws one finished frame and stays still.

import { useEffect, useRef } from "react";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const WORDS = ["work", "writing", "health", "money", "notes", "yours", "sealed", "private"];

const CELL = 8; // px between characters
const ROW = 30; // px between lines
const FRAME_MS = 1000 / 30;
const TICK_MS = 110;

type Word = { row: number; col: number; text: string; born: number };

function randomChar() {
  return ALPHABET[(Math.random() * ALPHABET.length) | 0];
}

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
    const monoFace = getComputedStyle(document.documentElement).getPropertyValue("--face-mono").trim();
    const font = `400 11px ${monoFace || "ui-monospace"}, ui-monospace, Menlo, monospace`;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let layerH = 0;
    let grid: string[] = []; // "" is a gap
    let words: Word[] = [];
    let pattern: CanvasPattern | null = null;
    let raf = 0;
    let lastFrame = 0;
    let lastTick = 0;
    let nextWord = 0;
    let disposed = false;
    const started = performance.now();
    // The pointer light eases toward the pointer and fades when it leaves.
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, on: 0, target: 0 };

    const cellX = (c: number) => c * CELL + CELL / 2;
    const cellY = (r: number) => r * ROW + ROW / 2;

    function drawCell(r: number, c: number, ch: string, strong = false) {
      lctx.clearRect(c * CELL * dpr, r * ROW * dpr, CELL * dpr, ROW * dpr);
      if (!ch) return;
      lctx.fillStyle = strong ? "#fff" : "rgba(255,255,255,0.5)";
      lctx.fillText(ch, cellX(c) * dpr, cellY(r) * dpr);
    }

    function build() {
      W = window.innerWidth;
      H = Math.max(window.innerHeight, H);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      while (dpr > 1 && W * H * dpr * dpr > 3_300_000) dpr -= 0.5;
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      canvas!.style.width = `${W}px`;
      canvas!.style.height = `${H}px`;

      cols = Math.ceil(W / CELL);
      rows = Math.ceil(H / ROW) + 1;
      layerH = rows * ROW;
      layer.width = Math.round(W * dpr);
      layer.height = Math.round(layerH * dpr);
      lctx.font = font.replace("11px", `${11 * dpr}px`);
      lctx.textAlign = "center";
      lctx.textBaseline = "middle";

      grid = new Array(cols * rows);
      words = [];
      for (let r = 0; r < rows; r++) {
        // Groups of four with a space, some groups left out, like lines of a sealed text.
        let skip = false;
        for (let c = 0; c < cols; c++) {
          const inGroup = c % 5;
          if (inGroup === 0) skip = Math.random() < 0.24;
          const ch = inGroup === 4 || skip ? "" : randomChar();
          grid[r * cols + c] = ch;
          if (ch) drawCell(r, c, ch);
        }
      }
      pattern = ctx!.createPattern(layer, "repeat");
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

    // `reach` scales the radius: the glow of a light spreads wide, the engraving shows only near its centre.
    function fillLights(list: ReturnType<typeof lights>, peak: number, reach: number) {
      for (const l of list) {
        const r = l.r * reach;
        // Wider than tall, as a highlight sits on a brushed surface.
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
      if (!pattern) return;
      const list = lights(now);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalCompositeOperation = "source-over";
      ctx!.clearRect(0, 0, W, H);
      // 1. Where the light falls, and how strongly.
      fillLights(list, 0.13, 0.5);
      // 2. The engraving, kept only where there is light. It moves a little slower than the page.
      ctx!.globalCompositeOperation = "source-in";
      const shift = reduced.matches ? 0 : (window.scrollY * 0.12) % layerH;
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      pattern.setTransform(new DOMMatrix().translate(0, -shift * dpr));
      ctx!.fillStyle = pattern;
      ctx!.fillRect(0, 0, canvas!.width, canvas!.height);
      // 3. The glow of the light itself, behind the engraving.
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalCompositeOperation = "destination-over";
      fillLights(list, 0.11, 1);
    }

    function placeWord(now: number, settled = false) {
      const text = WORDS[(Math.random() * WORDS.length) | 0];
      const [a] = lights(now);
      const shift = reduced.matches ? 0 : (window.scrollY * 0.12) % layerH;
      // Near the drifting light, on a group boundary, away from other words.
      const cx = a.x + (Math.random() - 0.5) * a.r * 0.6;
      const cy = a.y + (Math.random() - 0.5) * a.r * 0.35;
      let col = Math.round(cx / CELL / 5) * 5;
      col = Math.max(0, Math.min(cols - text.length - 1, col));
      let row = Math.round((cy + shift) / ROW);
      row = ((row % rows) + rows) % rows;
      if (words.some((w) => w.row === row)) return;
      words.push({ row, col, text, born: settled ? now - 3000 : now });
      if (settled) for (let i = 0; i < text.length; i++) drawCell(row, col + i, text[i], true);
    }

    function tick(now: number) {
      // A few characters change, as if the text were still being written.
      for (let i = 0; i < 5; i++) {
        const idx = (Math.random() * grid.length) | 0;
        if (!grid[idx]) continue;
        const r = (idx / cols) | 0;
        const c = idx % cols;
        if (words.some((w) => w.row === r && c >= w.col && c < w.col + w.text.length)) continue;
        grid[idx] = randomChar();
        drawCell(r, c, grid[idx]);
      }
      // Words resolve letter by letter, hold, then lock again.
      const RESOLVE = 150;
      const HOLD = 6500;
      words = words.filter((w) => {
        const age = now - w.born;
        const n = w.text.length;
        const closing = age - (n * RESOLVE + 600 + HOLD);
        for (let i = 0; i < n; i++) {
          const c = w.col + i;
          const base = grid[w.row * cols + c];
          if (closing > i * RESOLVE) drawCell(w.row, c, base);
          else if (closing > i * RESOLVE - 500) drawCell(w.row, c, randomChar());
          else if (age > i * RESOLVE + 600) drawCell(w.row, c, w.text[i], true);
          else drawCell(w.row, c, randomChar());
        }
        return closing <= n * RESOLVE;
      });
      if (now > nextWord && words.length < 3) {
        placeWord(now);
        nextWord = now + 2600 + Math.random() * 2600;
      }
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
      if (now - lastTick > TICK_MS) {
        lastTick = now;
        tick(now);
      }
      render(now);
    }

    function start() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (disposed) return;
      if (reduced.matches) {
        // One finished frame: two words already readable.
        build();
        placeWord(started, true);
        placeWord(started, true);
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
    // The engraving is set in the site's own mono face.
    document.fonts.load(font).then(begin, begin);

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
