"use client";

import { useEffect, useRef } from "react";
import { useLive, type Stats } from "./useLive";

const ITEMS: { key: keyof Stats; label: string; text: string }[] = [
  { key: "vaults", label: "Vaults", text: "Each one opened only by its owner's passkey, wallet or recovery phrase." },
  { key: "memories", label: "Memories stored encrypted", text: "Held as ciphertext. The server cannot read a word of them." },
  { key: "reads", label: "Reads logged", text: "Every request a connected app has made, on its owner's record." },
  { key: "seals", label: "Hours sealed", text: "Each hour of reads folded into one fingerprint anyone can check." },
];

/** A number that counts up to its value when it first arrives, and steps to new values after that. */
function Count({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    shown.current = value;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || from === value) {
      el.textContent = value.toLocaleString("en-US");
      return;
    }
    const start = performance.now();
    const duration = 1400;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = Math.round(from + (value - from) * eased).toLocaleString("en-US");
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span ref={ref} className="stat-number">
      0
    </span>
  );
}

/** The public counters, read from this server. Counts only; nothing in them names a person or a memory. */
export function LiveStats() {
  const live = useLive<Stats>("/api/stats", 60_000);

  if (live.status === "error") {
    return (
      <p className="notice" role="status">
        <span>The live numbers could not be loaded right now. Nothing is wrong with your vault; this page only shows counts.</span>
      </p>
    );
  }
  return (
    <dl className="stats" data-state={live.status} aria-busy={live.status === "loading"}>
      {ITEMS.map((it) => (
        <div key={it.key} className="stat">
          <dt className="stat-label">{it.label}</dt>
          <dd className="stat-value">{live.status === "ready" ? <Count value={live.data[it.key]} /> : <span className="stat-number stat-wait" />}</dd>
          <dd className="stat-text">{it.text}</dd>
        </div>
      ))}
    </dl>
  );
}
