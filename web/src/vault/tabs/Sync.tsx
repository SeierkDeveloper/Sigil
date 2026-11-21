"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PROVIDER_INFO, SYNC_INFO, SYNC_KINDS, type SyncKind } from "@sigil/core";
import { CodeBlock } from "@/components/CodeBlock";
import { SyncIcon } from "@/components/icons";
import { watchCommand, EXAMPLE_KEY } from "@/lib/connector";
import { formatDateTime, plural } from "@/lib/format";
import { site } from "@/lib/site";
import * as ops from "../ops";
import * as sync from "../syncOps";
import { errorText, useVault } from "../context";
import { SourceMark } from "../marks";
import { Empty, Notice, PlateHead, Quiet } from "../ui";

const NEW = "__new__";

/** Live sync: Gmail, Google Calendar, Google Drive and Slack, fetched and encrypted on this device, into folders you choose. */
export function SyncTab() {
  const { api, liveSync } = useVault();
  const [clients, setClients] = useState<sync.SyncClients | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    sync
      .loadClients(api)
      .then((c) => alive && setClients(c))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <div className="sync">
      <div className="panel-header">
        <h2 className="panel-title">Live sync</h2>
        <p className="small muted">
          Mail, calendar, documents and chat, kept in your vault as they change. This browser signs in to each service, fetches what changed and encrypts it before
          anything reaches Sigil. The sign-in is encrypted with your vault key; Sigil&apos;s server never sees a token, a message or a file in readable form.
        </p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {liveSync.lastError ? <Notice kind="error">The last sync stopped: {liveSync.lastError}</Notice> : null}
      <Sources />
      <Connect clients={clients} />
      <Background />
    </div>
  );
}

function sourceLine(s: sync.SyncSourceView): string {
  const last = s.state?.last;
  if (!last) return "Not synced yet.";
  if (last.error) return `Last try ${formatDateTime(last.at)}: ${last.error}`;
  return `Last synced ${formatDateTime(last.at)}: ${plural(last.added, "new memory", "new memories")}, ${last.updated} changed, ${last.removed} removed.`;
}

function Sources() {
  const { api, vault, data, update, liveSync } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const folderName = (id: string) => data.folders.find((f) => f.id === id)?.name ?? "a deleted folder";

  return (
    <section className="subpanel plate" aria-labelledby="sync-sources">
      <PlateHead number="01" id="sync-sources" title="Sources" lead="What stays in sync, and where it goes. Pause one at any time; disconnecting deletes its sign-in.">
        <span className="plate-state" data-on={data.sync.length ? "true" : "false"}>
          {data.sync.length ? plural(data.sync.length, "source") : "None yet"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data.sync.length === 0 ? (
        <Quiet>Nothing is in sync yet. Connect a source below.</Quiet>
      ) : (
        <ul className="list sync-list">
          {data.sync.map((s) => {
            const kind = s.state?.kind;
            const app = s.appId ? data.apps.find((a) => a.id === s.appId) : undefined;
            const state = s.paused ? "paused" : liveSync.running === s.id ? "syncing" : app ? "background" : "synced";
            return (
              <li key={s.id} className="list-row sync-row" data-paused={s.paused ? "true" : "false"} data-state={state} data-testid="sync-row">
                <span className="sync-row-mark" aria-hidden="true">
                  {kind ? <SourceMark kind={SYNC_INFO[kind].source} /> : null}
                </span>
                <div className="list-row-main">
                  <p className="list-row-title">
                    {kind ? SYNC_INFO[kind].label : "A source that could not be opened"}
                    {s.state?.account ? <span className="faint"> {s.state.account}</span> : null}
                    <span className="badge sync-state" data-state={state}>{s.paused ? "Paused" : liveSync.running === s.id ? "Syncing" : app ? "In the background" : "In sync"}</span>
                  </p>
                  <p className="list-row-meta">
                    Into {folderName(s.folderId)}. {sourceLine(s)}
                    {app ? ` Kept in sync by ${app.name} while the vault is closed.` : " Kept in sync while this vault is open."}
                  </p>
                  {confirm === s.id ? (
                    <div className="subpanel">
                      <p className="small">Disconnect it? The sign-in is deleted from Sigil at once. The memories it made stay in {folderName(s.folderId)}.</p>
                      <div className="row">
                        <button
                          type="button"
                          className="button button-danger button-small"
                          disabled={busy === s.id}
                          onClick={() =>
                            void act(s.id, async () => {
                              await sync.disconnectSource(api, s.id);
                              update((d) => ({ ...d, sync: d.sync.filter((x) => x.id !== s.id) }));
                              setConfirm(null);
                            })
                          }
                        >
                          Disconnect
                        </button>
                        <button type="button" className="button button-ghost button-small" onClick={() => setConfirm(null)}>
                          Keep it
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                {confirm !== s.id ? (
                  <div className="list-row-actions">
                    {!s.paused && !app ? (
                      <button
                        type="button"
                        className="button button-small"
                        disabled={!!busy || liveSync.running === s.id}
                        onClick={() =>
                          void act(s.id, async () => {
                            const r = await sync.syncNow(api, vault, data, s);
                            const fresh = await ops.loadVault(api, vault);
                            update(() => ({ ...fresh, sync: fresh.sync.map((x) => (x.id === s.id ? r.source : x)) }));
                          })
                        }
                      >
                        {busy === s.id ? "Syncing" : "Sync now"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button button-small button-ghost"
                      disabled={!!busy}
                      onClick={() =>
                        void act(s.id, async () => {
                          await sync.pauseSource(api, s.id, !s.paused);
                          update((d) => ({ ...d, sync: d.sync.map((x) => (x.id === s.id ? { ...x, paused: !s.paused } : x)) }));
                        })
                      }
                    >
                      {s.paused ? "Resume" : "Pause"}
                    </button>
                    <button type="button" className="button button-small button-ghost" onClick={() => setConfirm(s.id)}>
                      Disconnect
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Connect({ clients }: { clients: sync.SyncClients | null }) {
  const { api, vault, data, update } = useVault();
  const [kind, setKind] = useState<SyncKind>("gmail");
  const [target, setTarget] = useState(NEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [onComputer, setOnComputer] = useState(false);
  const [appId, setAppId] = useState("");
  const [command, setCommand] = useState<string | null>(null);
  const connectorApps = data.apps.filter((a) => !a.revokedAt && !data.agents.some((x) => x.appId === a.id) && a.kind !== "extension" && a.kind !== "web");
  const info = SYNC_INFO[kind];
  const provider = PROVIDER_INFO[info.provider];
  const clientId = clients ? clients[info.provider] : null;
  const existing = data.folders.find((f) => f.name.toLowerCase() === info.folder.toLowerCase());

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId && !onComputer) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setCommand(null);
    try {
      let folder = target === NEW ? existing : data.folders.find((f) => f.id === target);
      if (!folder) {
        folder = await ops.addFolder(api, vault, info.folder);
        const made = folder;
        update((d) => ({ ...d, folders: [...d.folders, made] }));
      }
      if (onComputer) {
        const app = connectorApps.find((a) => a.id === appId) ?? connectorApps[0];
        if (!app) throw new Error("Connect an app under Apps first (an MCP app is fine). Its connector signs in on your computer.");
        const fresh = await ops.loadVault(api, vault);
        const id = await sync.prepareOnComputer(api, vault, fresh, { kind, clientId: clientId ?? "", folder, app });
        setCommand(sync.connectCommand(window.location.origin, id));
        setDone(`${info.label} waits for your computer. Run the command below where ${app.name} is set up, sign in in the browser it opens, then keep it in sync with --watch.`);
        const after = await ops.loadVault(api, vault);
        update(() => after);
        return;
      }
      if (!clientId) return;
      const source = await sync.connectSource(api, vault, { kind, clientId, folder, origin: window.location.origin });
      update((d) => ({ ...d, sync: [...d.sync, source] }));
      setDone(`${info.label} is connected. The first sync starts in a moment.`);
      const fresh = await ops.loadVault(api, vault);
      const r = await sync.syncNow(api, vault, fresh, fresh.sync.find((x) => x.id === source.id) ?? source);
      const after = await ops.loadVault(api, vault);
      update(() => after);
      setDone(`${info.label} is connected: ${plural(r.report.added, "memory", "memories")} so far${r.report.more ? ", more on the next pass" : ""}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel plate sync-connect" onSubmit={connect} aria-label="Connect a source" data-ready={clients && !clientId ? "false" : "true"}>
      <PlateHead number="02" title="Connect a source" lead="You sign in with the service in a small window. The sign-in comes back to this page only." />
      <div className="import-sources" role="radiogroup" aria-label="Service">
        {SYNC_KINDS.map((k) => (
          <label key={k} className="import-source" data-selected={k === kind ? "true" : "false"}>
            <input type="radio" name="sync-kind" value={k} checked={k === kind} onChange={() => setKind(k)} disabled={busy} />
            <span className="import-source-marks">
              <SourceMark kind={SYNC_INFO[k].source} />
            </span>
            <span className="import-source-title">{SYNC_INFO[k].label}</span>
            <span className="import-source-text">{SYNC_INFO[k].reads}</span>
          </label>
        ))}
      </div>
      {clients && !clientId ? (
        <Notice>
          This site has no {provider.label} sign-in set up yet, so {info.label} cannot be connected here. Whoever runs the site adds a public OAuth client id as{" "}
          <span className="mono">{provider.env}</span>: no client secret is needed or kept on the server. The steps are in the{" "}
          <Link href="/docs#sync">docs</Link>.
        </Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {done ? <Notice kind="success">{done}</Notice> : null}
      {command ? <CodeBlock code={command} label="On your computer, with SIGIL_APP_KEY set as for your AI app" /> : null}
      <label className="checkbox" htmlFor="sync-on-computer">
        <input id="sync-on-computer" type="checkbox" checked={onComputer} onChange={(e) => setOnComputer(e.target.checked)} disabled={busy} />
        <span>
          Sign in on my computer instead. For a service that wants a client secret (Slack does): your connector signs in there with the secret from that computer, and keeps
          the source in sync. Sigil never sees the secret or a token.
        </span>
      </label>
      {onComputer ? (
        <div className="field">
          <label className="field-label" htmlFor="sync-app">
            With the connector of
          </label>
          <select id="sync-app" className="select" value={appId} onChange={(e) => setAppId(e.target.value)} disabled={busy || connectorApps.length === 0}>
            {connectorApps.length === 0 ? <option value="">Connect an app under Apps first</option> : null}
            {connectorApps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="sync-folder">
          Into the folder
        </label>
        <select id="sync-folder" className="select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          <option value={NEW}>{existing ? existing.name : `A new folder called ${info.folder}`}</option>
          {data.folders
            .filter((f) => f.id !== existing?.id)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
        <span className="field-hint">Read only: Sigil never sends, changes or deletes anything at {provider.label}. What it reads is: {info.reads}</span>
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || (!clientId && !onComputer) || (onComputer && connectorApps.length === 0)}>
          <SyncIcon /> {busy ? "Connecting" : onComputer ? `Prepare ${info.label} for my computer` : `Connect ${info.label}`}
        </button>
      </div>
    </form>
  );
}

function Background() {
  const { api, vault, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apps = data.apps.filter((a) => !a.revokedAt && !data.agents.some((x) => x.appId === a.id) && a.kind !== "extension" && a.kind !== "web");
  const origin = typeof window !== "undefined" ? window.location.origin : site.url;

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate sync-background" aria-labelledby="sync-background">
      <PlateHead
        number="03"
        id="sync-background"
        title="While the vault is closed"
        lead="Pick a connector app for a source, and the connector on your machine keeps it in sync with --watch: it gets the source's sign-in and folder key, wrapped for its own key."
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data.sync.length === 0 ? (
        <Quiet>Connect a source first.</Quiet>
      ) : apps.length === 0 ? (
        <Empty title="No connector app yet">Connect an app under Apps (an MCP app is fine; it needs no folders), then pick it here.</Empty>
      ) : (
        <ul className="list">
          {data.sync.map((s) => (
            <li key={s.id} className="list-row">
              <div className="list-row-main">
                <p className="list-row-title">{s.state ? SYNC_INFO[s.state.kind].label : "Source"}</p>
                <p className="list-row-meta">{s.appId ? `Synced by ${data.apps.find((a) => a.id === s.appId)?.name ?? "a removed app"} while the vault is closed.` : "Synced only while this vault is open."}</p>
              </div>
              <div className="list-row-actions">
                <label className="visually-hidden" htmlFor={`bg-${s.id}`}>
                  Connector for this source
                </label>
                <select
                  id={`bg-${s.id}`}
                  className="select"
                  value={s.appId ?? ""}
                  disabled={busy === s.id || !s.state}
                  onChange={(e) => {
                    const appId = e.target.value;
                    void act(s.id, async () => {
                      if (!appId) await sync.stopBackground(api, s.id);
                      else await sync.allowBackground(api, vault, data, s, data.apps.find((a) => a.id === appId)!);
                    });
                  }}
                >
                  <option value="">Only while the vault is open</option>
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
      <CodeBlock code={watchCommand(EXAMPLE_KEY, origin)} label="On your machine" />
      <p className="small muted">
        The connector refreshes the sign-in itself and seals the new copy for its own key. Every write it makes is in your read log as a sync.
      </p>
    </section>
  );
}
