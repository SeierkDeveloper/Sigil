"use client";

// Shared timing for the hero pieces: nothing runs while the piece is off screen
// or the tab is hidden, and nothing moves for visitors who ask for less motion.

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(notify: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** True while the element is on screen and the tab is visible. */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inView = false;
    const update = () => setOn(inView && document.visibilityState === "visible");
    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        update();
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);
  return on;
}

/**
 * Walks through steps, staying `durations[i]` milliseconds on step i, and loops.
 * One timer per step, no frame loop. Paused when `running` is false.
 */
export function useSteps(durations: readonly number[], running: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setStep((s) => (s + 1) % durations.length), durations[step]);
    return () => window.clearTimeout(id);
  }, [durations, running, step]);
  return step;
}

export { cipherText } from "@/lib/cipher";
