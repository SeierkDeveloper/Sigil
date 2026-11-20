"use client";

// Page-wide motion, in one place:
// - things rise in as they scroll into view (data-in on the element),
// - small mono labels decode from ciphertext into their words,
// - panels carry a soft light under the pointer (--mx / --my).
//
// The <html data-motion="on"> switch is set before first paint by the inline
// script in the layout, and only when the visitor has not asked for less
// motion. Without it nothing is hidden and nothing moves.

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Runs before first paint. If this file never loads, everything is shown again. */
export const MOTION_BOOT = `(function(){try{var d=document.documentElement;if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;d.dataset.motion="on";setTimeout(function(){if(!window.__sigilMotion)delete d.dataset.motion},4000)}catch(e){}})()`;

const REVEAL = [
  ".section",
  ".section-header",
  ".section .card",
  ".step",
  ".permission-card",
  ".split > *",
  ".cta-band > .container",
  ".works-with",
  ".pillar",
  ".stage",
  ".toc",
  ".prose h2",
  ".site-footer",
  ".page-section",
  ".guide",
  ".chapter",
  ".release",
  ".tool",
  ".stat",
  ".compare",
  ".faq-item",
  ".import-flow",
  ".seal-card",
  ".doc-block",
  ".page-links",
  ".app-index",
  ".flow",
].join(",");
const LABELS = ".eyebrow, .works-with-label";
const LIT = ".card, .permission-card, .pillar, .vault-gate, .self-card";
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function decode(el: HTMLElement) {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || el.childNodes.length !== 1) return;
  const text = node.nodeValue ?? "";
  if (!text.trim()) return;
  el.setAttribute("aria-label", text);
  const start = performance.now();
  const duration = Math.min(1100, 380 + text.length * 22);
  let last = 0;
  const step = (now: number) => {
    if (!node.isConnected) return;
    const p = Math.min(1, (now - start) / duration);
    if (p >= 1) {
      node.nodeValue = text;
      el.removeAttribute("aria-label");
      return;
    }
    if (now - last > 45) {
      last = now;
      const done = Math.floor(p * text.length);
      let out = text.slice(0, done);
      for (let i = done; i < text.length; i++) out += text[i] === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      node.nodeValue = out;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function Motion() {
  const pathname = usePathname();

  useEffect(() => {
    (window as unknown as { __sigilMotion?: boolean }).__sigilMotion = true;
    const root = document.documentElement;
    if (root.dataset.motion !== "on") return;

    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        // Neighbours that arrive together come in one after another.
        const order = new Map<Element | null, number>();
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          // Also anything already scrolled past, so a jump down the page leaves no holes above.
          if (!entry.isIntersecting && entry.boundingClientRect.bottom > 0) continue;
          io.unobserve(el);
          if (el.matches(LABELS)) {
            if (entry.isIntersecting) decode(el);
            continue;
          }
          const i = order.get(el.parentElement) ?? 0;
          order.set(el.parentElement, i + 1);
          if (i && entry.isIntersecting) el.style.setProperty("--i", String(Math.min(i, 6)));
          el.dataset.in = "true";
        }
      },
      { rootMargin: "0px 0px -7% 0px", threshold: 0 },
    );

    const scan = () => {
      for (const el of document.querySelectorAll<HTMLElement>(`${REVEAL},${LABELS}`)) {
        if (seen.has(el) || el.closest(".vault")) continue;
        seen.add(el);
        io.observe(el);
      }
    };

    let queued = 0;
    const queue = () => {
      if (!queued) queued = requestAnimationFrame(() => ((queued = 0), scan()));
    };
    scan();
    const mo = new MutationObserver(queue);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      cancelAnimationFrame(queued);
    };
  }, [pathname]);

  // The light under the pointer, for devices that have one.
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0;
    let ev: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      const target = ev?.target;
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>(LIT);
      if (!el || !ev) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${Math.round(ev.clientX - r.left)}px`);
      el.style.setProperty("--my", `${Math.round(ev.clientY - r.top)}px`);
    };
    const onMove = (e: PointerEvent) => {
      ev = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
