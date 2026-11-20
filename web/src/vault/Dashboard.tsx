"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import * as ops from "./ops";
import { Ctx, errorText, type TabId, type VaultCtx } from "./context";
import { Notice, Spinner } from "./ui";
import { formatBytes, plural } from "@/lib/format";
import { MemoriesTab } from "./tabs/Memories";
import { FoldersTab } from "./tabs/Folders";
import { AppsTab } from "./tabs/Apps";
import { LogTab } from "./tabs/Log";
import { ImportTab } from "./tabs/Import";
import { SettingsTab } from "./tabs/Settings";
import { InboxTab } from "./tabs/Inbox";
import { TimelineTab } from "./tabs/Timeline";
import { ProfileTab } from "./tabs/Profile";
import { SelfTab } from "./tabs/Self";
import { ReviewTab } from "./tabs/Review";
import { LegacyTab } from "./tabs/Legacy";
import { DevicesTab } from "./tabs/Devices";
import { AgentsTab } from "./tabs/Agents";
import { ProofTab } from "./tabs/Proof";
import { SyncTab } from "./tabs/Sync";
import { MeetTab } from "./tabs/Meet";
import { useLiveSync } from "./useLiveSync";
import { sendPresence } from "./lifeOps";
import { saveOfflineCopy } from "./offline";
import { flushCaptures, pinVaultKey } from "./deviceOps";
import { useSemanticIndex } from "./semantic";
import { useSelfAgent } from "./useSelfAgent";
import { modelCaller } from "./selfOps";
import { makeBrief, shouldMakeBrief } from "./thinkOps";

const TABS: { id: TabId; label: string }[] = [
  { id: "memories", label: "Memories" },
  { id: "inbox", label: "Inbox" },
  { id: "self", label: "AI self" },
  { id: "meet", label: "Meet" },
  { id: "review", label: "Review" },
  { id: "timeline", label: "Timeline" },
  { id: "profile", label: "Self card" },
  { id: "folders", label: "Folders" },
  { id: "apps", label: "Apps" },
  { id: "agents", label: "Agents" },
  { id: "devices", label: "Devices" },
  { id: "legacy", label: "Legacy" },
  { id: "proof", label: "Proof" },
  { id: "log", label: "Read log" },
  { id: "import", label: "Import" },
  { id: "sync", label: "Sync" },
  { id: "settings", label: "Settings" },
];

const NO_MEMORIES: ops.VaultData["memories"] = [];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "memories";
  // A pairing code opened with the camera, and a legacy invite, land on their own tab.
  if (window.location.pathname.endsWith("/vault/pair")) return "devices";
  if (window.location.pathname.endsWith("/vault/legacy")) return "legacy";
  const h = window.location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "memories") as TabId;
}

/** Every load keeps the ciphertext for offline reading, when the owner turned that on for this device. */
const keepCopy = { onRaw: (raw: ops.ServerVault) => void saveOfflineCopy(raw) };

interface Props {
  api: Api;
  vault: ops.Unlocked;
  onLock(): void;
  onSignOut(): Promise<void>;
  onDeleted(): void;
}

export function Dashboard({ api, vault, onLock, onSignOut, onDeleted }: Props) {
  const [data, setData] = useState<ops.VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(tabFromHash);

  const reload = useCallback(async () => {
    try {
      setData(await ops.loadVault(api, vault, keepCopy));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, vault]);

  useEffect(() => {
    let alive = true;
    ops
      .loadVault(api, vault, keepCopy)
      .then((d) => {
        if (!alive) return;
        setData(d);
        pinVaultKey(d.boxPublic);
        // Captures sealed on this device while it was offline go to the inbox now.
        void flushCaptures(api)
          .then((n) => (n > 0 ? ops.loadVault(api, vault).then((x) => alive && setData(x)) : undefined))
          .catch(() => undefined);
      })
      .catch((err) => alive && setError(errorText(err)));
    const sync = () => setTab(tabFromHash());
    window.addEventListener("hashchange", sync);
    return () => {
      alive = false;
      window.removeEventListener("hashchange", sync);
    };
  }, [api, vault]);

  // The encrypted size comes from the server; refresh it whenever the contents change.
  const memories = data?.memories;
  useEffect(() => {
    if (!memories) return;
    let alive = true;
    api
      .get<ops.VaultData["usage"]>("usage")
      .then((usage) => alive && setData((d) => (d && (d.usage.bytes !== usage.bytes || d.usage.memories !== usage.memories) ? { ...d, usage } : d)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, memories]);

  // While the vault is open, sign this period's presence once: the proof of a real life is built from these.
  const hasSignKey = !!data?.signKey;
  useEffect(() => {
    if (!hasSignKey) return;
    let timer = 0;
    let alive = true;
    const beat = async () => {
      let wait = 60_000;
      try {
        const r = await sendPresence(api, vault);
        wait = Math.min(Math.max((r.periodSeconds * 1000) / 2, 2000), 60_000);
        if (r.recorded && alive) setData((d) => (d ? { ...d, presence: { ...d.presence, total: d.presence.total + 1 } } : d));
      } catch {
        // Offline or signed out: the next beat tries again.
      }
      if (alive) timer = window.setTimeout(beat, wait);
    };
    void beat();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, vault, hasSignKey]);

  const [focus, setFocus] = useState<string | null>(null);
  const goTo = useCallback((t: TabId) => {
    setFocus(null);
    setTab(t);
    window.history.replaceState(null, "", `#${t}`);
  }, []);
  const openMemory = useCallback((id: string) => {
    setFocus(id);
    setTab("memories");
    window.history.replaceState(null, "", "#memories");
  }, []);

  // Everything readable in the vault, own memories and accepted shared folders, is understood on this device.
  const incoming = data?.shares.incoming;
  const indexed = useMemo(
    () => [...(memories ?? NO_MEMORIES), ...(incoming ?? []).filter((s) => s.acceptedAt).flatMap((s) => s.memories)],
    [memories, incoming],
  );
  const semantic = useSemanticIndex(api, vault, indexed);
  const agent = useSelfAgent(api, vault, data, semantic);
  const liveSync = useLiveSync(api, vault, data, setData);

  // The weekly brief, once per opening, when it is due and the owner wants it.
  const briefTried = useRef(false);
  useEffect(() => {
    if (!data || briefTried.current) return;
    briefTried.current = true;
    if (!shouldMakeBrief(data)) return;
    const model = data.thinking.briefWithModel ? modelCaller(data) : null;
    makeBrief(api, vault, data, model)
      .then((r) => setData((d) => (d ? { ...d, folders: r.createdFolder ? [...d.folders, r.folder] : d.folders, memories: [r.memory, ...d.memories] } : d)))
      .catch(() => undefined);
  }, [api, vault, data]);

  // Stable, so effects that update the data now and then are not restarted by every change.
  const updateData = useCallback((fn: (d: ops.VaultData) => ops.VaultData) => setData((d) => (d ? fn(d) : d)), []);

  const ctx = useMemo<VaultCtx | null>(
    () =>
      data
        ? {
            api,
            vault,
            data,
            update: updateData,
            reload,
            goTo,
            openMemory,
            focus,
            semantic,
            agent,
            liveSync,
            lock: onLock,
            signOut: onSignOut,
          }
        : null,
    [api, vault, data, updateData, reload, goTo, openMemory, focus, semantic, agent, liveSync, onLock, onSignOut],
  );

  if (error && !data) {
    return (
      <div className="vault-gate">
        <Notice kind="error">Your vault could not be loaded: {error}</Notice>
        <div className="row">
          <button type="button" className="button" onClick={() => void reload()}>
            Try again
          </button>
          <button type="button" className="button button-ghost" onClick={onLock}>
            Lock
          </button>
        </div>
      </div>
    );
  }
  if (!ctx || !data) return <Spinner label="Decrypting your vault" />;

  const activeApps = data.apps.filter((a) => !a.revokedAt).length;
  const waitingRequests = data.access.filter((r) => r.state === "pending").length;

  return (
    <Ctx.Provider value={ctx}>
      <div className="dashboard">
        <div className="dashboard-bar">
          <div>
            <h1 className="dashboard-title">Your vault</h1>
            <div className="dashboard-stats">
              <span>{plural(data.memories.length, "memory", "memories")}</span>
              <span>{plural(data.folders.length, "folder")}</span>
              <span>{plural(activeApps, "connected app")}</span>
              <span>{formatBytes(data.usage.bytes)} encrypted</span>
            </div>
          </div>
          <button type="button" className="button button-small" onClick={onLock}>
            Lock vault
          </button>
        </div>

        {data.unreadable > 0 ? (
          <Notice kind="error">
            {plural(data.unreadable, "item")} in your vault could not be decrypted with your key. They are left untouched on the server.
          </Notice>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        {data.legacy.plan?.missed && tab !== "legacy" ? (
          <Notice>
            While you were away your legacy plan reached {data.legacy.plan.missed.stage >= 3 ? "the end of its period" : "a warning stage"}. Coming back counted as a check-in.{" "}
            <button type="button" className="text-button" onClick={() => goTo("legacy")}>
              See Legacy
            </button>
          </Notice>
        ) : null}

        <div className="tabs" role="tablist" aria-label="Vault sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              className="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => goTo(t.id)}
            >
              {t.label}
              {t.id === "legacy" && data.trusted.some((x) => x.state === "open" && !x.kept) ? (
                <span className="tab-count" aria-label="A plan that names you is open for release">
                  {data.trusted.filter((x) => x.state === "open" && !x.kept).length}
                </span>
              ) : null}
              {t.id === "inbox" && data.proposals.length + waitingRequests > 0 ? (
                <span className="tab-count" aria-label={`${data.proposals.length + waitingRequests} waiting`}>
                  {data.proposals.length + waitingRequests}
                </span>
              ) : null}
              {t.id === "meet" && data.meets.some((m) => m.role === "invitee" && m.state === "invited") ? (
                <span className="tab-count" aria-label="An invite is waiting">
                  {data.meets.filter((m) => m.role === "invitee" && m.state === "invited").length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === "memories" ? <MemoriesTab /> : null}
          {tab === "inbox" ? <InboxTab /> : null}
          {tab === "self" ? <SelfTab /> : null}
          {tab === "meet" ? <MeetTab /> : null}
          {tab === "review" ? <ReviewTab /> : null}
          {tab === "timeline" ? <TimelineTab /> : null}
          {tab === "profile" ? <ProfileTab /> : null}
          {tab === "folders" ? <FoldersTab /> : null}
          {tab === "apps" ? <AppsTab /> : null}
          {tab === "agents" ? <AgentsTab /> : null}
          {tab === "devices" ? <DevicesTab /> : null}
          {tab === "legacy" ? <LegacyTab /> : null}
          {tab === "proof" ? <ProofTab /> : null}
          {tab === "log" ? <LogTab /> : null}
          {tab === "import" ? <ImportTab /> : null}
          {tab === "sync" ? <SyncTab /> : null}
          {tab === "settings" ? <SettingsTab onDeleted={onDeleted} /> : null}
        </div>
      </div>
    </Ctx.Provider>
  );
}
