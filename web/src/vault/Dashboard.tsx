"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useSemanticIndex } from "./semantic";

const TABS: { id: TabId; label: string }[] = [
  { id: "memories", label: "Memories" },
  { id: "inbox", label: "Inbox" },
  { id: "timeline", label: "Timeline" },
  { id: "profile", label: "Self card" },
  { id: "folders", label: "Folders" },
  { id: "apps", label: "Apps" },
  { id: "log", label: "Read log" },
  { id: "import", label: "Import" },
  { id: "settings", label: "Settings" },
];

const NO_MEMORIES: ops.VaultData["memories"] = [];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "memories";
  const h = window.location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "memories") as TabId;
}

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
      setData(await ops.loadVault(api, vault));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, vault]);

  useEffect(() => {
    let alive = true;
    ops
      .loadVault(api, vault)
      .then((d) => alive && setData(d))
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

  const ctx = useMemo<VaultCtx | null>(
    () =>
      data
        ? {
            api,
            vault,
            data,
            update: (fn) => setData((d) => (d ? fn(d) : d)),
            reload,
            goTo,
            openMemory,
            focus,
            semantic,
            lock: onLock,
            signOut: onSignOut,
          }
        : null,
    [api, vault, data, reload, goTo, openMemory, focus, semantic, onLock, onSignOut],
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
              {t.id === "inbox" && data.proposals.length > 0 ? (
                <span className="tab-count" aria-label={`${data.proposals.length} waiting`}>
                  {data.proposals.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === "memories" ? <MemoriesTab /> : null}
          {tab === "inbox" ? <InboxTab /> : null}
          {tab === "timeline" ? <TimelineTab /> : null}
          {tab === "profile" ? <ProfileTab /> : null}
          {tab === "folders" ? <FoldersTab /> : null}
          {tab === "apps" ? <AppsTab /> : null}
          {tab === "log" ? <LogTab /> : null}
          {tab === "import" ? <ImportTab /> : null}
          {tab === "settings" ? <SettingsTab onDeleted={onDeleted} /> : null}
        </div>
      </div>
    </Ctx.Provider>
  );
}
