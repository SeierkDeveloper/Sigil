"use client";

// While the vault is open, it answers the ask links it was given: every few
// seconds it tells the server it is here (so the link shows as online) and
// answers whatever is waiting, on this device, with the owner's own model.
// Closing or locking the vault stops it, and the links say so to askers.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import type { VaultData } from "./ops";
import type { SemanticIndex } from "./semantic";
import { modelCaller, serveOnce } from "./selfOps";
import { servePublicOnce } from "./publicOps";
import { meetOnce } from "./meetOps";
import type { Unlocked } from "./ops";

export type AgentState = { state: "off" } | { state: "no-model" } | { state: "serving"; answered: number } | { state: "failed"; reason: string };

const EVERY_MS = 3000;

export function vaultLinks(data: Pick<VaultData, "askLinks">, now = Date.now()) {
  return data.askLinks.filter((l) => !l.revokedAt && !l.appId && l.secret && new Date(l.expiresAt).getTime() > now && l.uses < l.maxUses);
}

/** Something waits for this open vault to answer: a link, the public page, or a conversation with another self. */
function hasWork(data: VaultData): boolean {
  return vaultLinks(data).length > 0 || (!!data.publicSelf?.enabled && !data.publicSelf.appId) || data.meets.some((m) => m.state === "running" || m.state === "invited");
}

export function useSelfAgent(api: Api, vault: Unlocked, data: VaultData | null, semantic: SemanticIndex): AgentState {
  const [progress, setProgress] = useState<{ answered: number; failed: string | null }>({ answered: 0, failed: null });
  const latest = useRef({ data, semantic });
  useEffect(() => {
    latest.current = { data, semantic };
  });

  const active = data ? hasWork(data) : false;
  const hasModel = !!data?.model;
  const hasBox = !!data?.box && !!data?.boxPublic;
  const serving = active && hasBox && hasModel;

  useEffect(() => {
    if (!serving) return;
    let alive = true;
    let answered = 0;
    const tick = async () => {
      const { data: d, semantic: s } = latest.current;
      if (!d?.box || !d.boxPublic) return;
      const model = modelCaller(d);
      if (!model) return;
      try {
        if (vaultLinks(d).length) answered += await serveOnce(api, d, { model, box: d.box, boxPublic: d.boxPublic, embedQuery: s.embedQuery, vectors: s.vectors });
        if (d.publicSelf?.enabled && !d.publicSelf.appId) answered += await servePublicOnce(api, d, { model });
        if (d.meets.some((m) => m.state === "running" || m.state === "invited")) answered += await meetOnce(api, vault, d, { model });
        if (alive) setProgress({ answered, failed: null });
      } catch (err) {
        if (alive) setProgress({ answered, failed: (err as Error).message });
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [api, vault, serving]);

  return useMemo<AgentState>(() => {
    if (!active || !hasBox) return { state: "off" };
    if (!hasModel) return { state: "no-model" };
    if (progress.failed) return { state: "failed", reason: progress.failed };
    return { state: "serving", answered: progress.answered };
  }, [active, hasBox, hasModel, progress]);
}
