"use client";

import { useEffect, useState } from "react";

export type Live<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T; at: number; ms: number };

/** Fetches a public endpoint, and again every `everyMs` while the tab is visible. */
export function useLive<T>(path: string, everyMs = 0): Live<T> {
  const [state, setState] = useState<Live<T>>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      const started = performance.now();
      fetch(path, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: T) => alive && setState({ status: "ready", data, at: Date.now(), ms: Math.round(performance.now() - started) }))
        .catch(() => alive && setState((s) => (s.status === "ready" ? s : { status: "error" })));
    };
    load();
    const id = everyMs ? window.setInterval(load, everyMs) : 0;
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [path, everyMs]);

  return state;
}

/** The current time, ticking once a second. Null until the page is live in the browser. */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);
  return now;
}

/** "12:04" until the running seal period ends. */
export function untilNextSeal(now: number, periodSeconds: number): string {
  const left = periodSeconds - (Math.floor(now / 1000) % periodSeconds);
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface Stats {
  vaults: number;
  memories: number;
  apps: number;
  reads: number;
  seals: number;
}

export interface SealInfo {
  hour: number;
  root: string;
  leaves: number;
  sealedAt: string;
  anchorTx: string | null;
}

export interface SealsResponse {
  mode: "local" | "anchored";
  periodSeconds: number;
  seals: SealInfo[];
}

export interface StatusResponse {
  ok: boolean;
  time: string;
  upSeconds: number;
  database: string;
  seals: {
    enabled: boolean;
    periodSeconds: number;
    mode: "local" | "anchored";
    job: "ok" | "off" | "failed";
    currentHour: number;
    open: number;
    overdue: number;
    lastSealedAt: string | null;
    seals: number;
    leaves: number;
    latestHour: number | null;
  };
}
