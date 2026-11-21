"use client";

// Page-wide motion, in one place: things rise in once as they scroll into
// view (data-in on the element). An IntersectionObserver does the watching, so
// no scroll handler runs and the layout is never read while scrolling.
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
          const i = order.get(el.parentElement) ?? 0;
          order.set(el.parentElement, i + 1);
          if (i && entry.isIntersecting) el.style.setProperty("--i", String(Math.min(i, 6)));
          el.dataset.in = "true";
        }
      },
      { rootMargin: "0px 0px -7% 0px", threshold: 0 },
    );

    const scan = () => {
      for (const el of document.querySelectorAll<HTMLElement>(REVEAL)) {
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

  return null;
}
