"use client";

// Keeps an open vault up to date. Every half minute while the page is in view,
// and whenever the owner comes back to it, the vault asks the server one small
// question: did anything change? The answer is two numbers (the vault's change
// counter and the newest read-log line). Only when the counter moved is the
// vault fetched and decrypted again, so memories an agent or an app wrote, and
// suggestions in the inbox, appear by themselves; when only the log moved, the
// read log refreshes. Nothing is reloaded while the owner is typing.

import { useEffect, useRef, useState } from "react";
import type { Api } from "./api";

/** How often an open vault in view asks whether anything changed. */
export const LIVE_EVERY_MS = 30_000;
/** Above this many memories the vault is not decrypted again on its own (it takes seconds); the read log stays live. */
export const LIVE_RELOAD_MAX_MEMORIES = 20_000;

export interface VaultStamp {
  vault: number;
  log: string;
}

/** True while the owner is typing somewhere on the page: a reload then waits for the next check. */
function typing(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** What to do with a new stamp, given the last one: decided apart from the browser so it can be tested. */
export function nextStep(prev: VaultStamp | null, now: VaultStamp, opts: { memories: number; typing: boolean }): { reload: boolean; log: boolean; keep: VaultStamp } {
  if (!prev) return { reload: false, log: false, keep: now };
  const vaultMoved = now.vault !== prev.vault;
  const logMoved = now.log !== prev.log;
  const reload = vaultMoved && !opts.typing && opts.memories <= LIVE_RELOAD_MAX_MEMORIES;
  // When the reload has to wait, the old counter is kept so the next check tries again.
  const keep = vaultMoved && !reload ? { vault: prev.vault, log: now.log } : now;
  return { reload, log: logMoved, keep };
}

/**
 * Returns a number that grows each time the read log has new lines, for the
 * read log to refresh on. reload() is called when the vault itself changed.
 */
export function useLiveVault(api: Api, ready: boolean, memories: number, reload: () => Promise<void>): number {
  const [logTick, setLogTick] = useState(0);
  const last = useRef<VaultStamp | null>(null);
  const busy = useRef(false);
  const count = useRef(memories);
  count.current = memories;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const check = async () => {
      if (busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const now = await api.get<VaultStamp>("vault/changes");
        if (!alive) return;
        const step = nextStep(last.current, now, { memories: count.current, typing: typing() });
        last.current = step.keep;
        if (step.log) setLogTick((n) => n + 1);
        if (step.reload) await reloadRef.current();
      } catch {
        /* offline or signed out: the next check tries again */
      } finally {
        busy.current = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), LIVE_EVERY_MS);
    const back = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [api, ready]);

  return logTick;
}
