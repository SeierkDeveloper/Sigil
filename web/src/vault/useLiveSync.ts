"use client";

// While the vault is open, it keeps live sync sources up to date: a pass soon
// after opening, then every few minutes, one source after another. A source a
// connector syncs in the background is left to it. Closing the vault stops this.

import { useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "./api";
import type { Unlocked, VaultData } from "./ops";
import { syncNow } from "./syncOps";
import { republish } from "./publicOps";

const EVERY_MS = 5 * 60_000;
const FIRST_MS = 4000;

export type SyncAgentState = { running: string | null; lastError: string | null };

export function useLiveSync(api: Api, vault: Unlocked, data: VaultData | null, setData: (fn: (d: VaultData | null) => VaultData | null) => void): SyncAgentState {
  const [state, setState] = useState<SyncAgentState>({ running: null, lastError: null });
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  });
  const due = !!data?.sync.some((s) => !s.paused && !s.appId && s.state);

  useEffect(() => {
    if (!due) return;
    let alive = true;
    let timer = 0;
    const pass = async () => {
      const d = latest.current;
      if (!d) return;
      for (const src of d.sync.filter((s) => !s.paused && !s.appId && s.state)) {
        if (!alive) return;
        setState({ running: src.id, lastError: null });
        try {
          const cur = latest.current ?? d;
          const r = await syncNow(api, vault, cur, src, {
            onSaved: (saved, removed) =>
              setData((x) => {
                if (!x) return x;
                const ids = new Set([...saved.map((m) => m.id), ...removed]);
                return { ...x, memories: [...saved, ...x.memories.filter((m) => !ids.has(m.id))].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1)) };
              }),
          });
          setData((x) => (x ? { ...x, sync: x.sync.map((s) => (s.id === src.id ? r.source : s)) } : x));
        } catch (err) {
          // Another device or tab saved a newer copy first: nothing went wrong, the next pass starts from it.
          if (err instanceof ApiError && err.code === "stale") continue;
          if (alive) setState({ running: null, lastError: (err as Error).message });
        }
      }
      if (alive) setState((s) => ({ ...s, running: null }));
    };
    timer = window.setTimeout(function tick() {
      void pass().finally(() => {
        if (alive) timer = window.setTimeout(tick, EVERY_MS);
      });
    }, FIRST_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, vault, due, setData]);

  // The public copy follows the public folders: published again whenever what is in them changed.
  const memories = data?.memories;
  const folders = data?.folders;
  const publicSelf = data?.publicSelf;
  useEffect(() => {
    if (!memories || !folders || !publicSelf?.secret) return;
    const t = window.setTimeout(() => {
      republish(api, { memories, folders, publicSelf })
        .then((did) => (did ? api.get<{ self: { copyHash: string | null; items: number; publishedAt: string | null } }>("public/self") : null))
        .then((r) => r && setData((x) => (x?.publicSelf ? { ...x, publicSelf: { ...x.publicSelf, copyHash: r.self.copyHash, items: r.self.items, publishedAt: r.self.publishedAt } } : x)))
        .catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [api, memories, folders, publicSelf, setData]);

  return state;
}
