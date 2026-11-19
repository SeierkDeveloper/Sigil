"use client";

import { useState } from "react";
import Link from "next/link";
import type { AppKind, OpenFolder } from "@sigil/core";
import { ChatGptIcon, ClaudeIcon, CursorIcon, McpIcon, PlusIcon } from "@/components/icons";
import { CodeBlock } from "@/components/CodeBlock";
import { configLocations, mcpConfig, shellCommand } from "@/lib/connector";
import { formatDateTime } from "@/lib/format";
import { site } from "@/lib/site";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { CopyButton, Empty, Notice } from "../ui";

const KINDS: { kind: AppKind; label: string; Icon: typeof ClaudeIcon }[] = [
  { kind: "claude-desktop", label: "Claude Desktop", Icon: ClaudeIcon },
  { kind: "cursor", label: "Cursor", Icon: CursorIcon },
  { kind: "chatgpt", label: "ChatGPT", Icon: ChatGptIcon },
  { kind: "other", label: "Other MCP app", Icon: McpIcon },
];

const kindInfo = (k: AppKind) => KINDS.find((x) => x.kind === k) ?? KINDS[3];

function names(folders: OpenFolder[], ids: Set<string>) {
  return folders.filter((f) => ids.has(f.id)).map((f) => f.name);
}

/** "This app will be able to read Work and Writing. It will not see Health." */
function plainWords(folders: OpenFolder[], ids: Set<string>): string {
  const yes = names(folders, ids);
  const no = folders.filter((f) => !ids.has(f.id)).map((f) => f.name);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  if (yes.length === 0) return "Pick at least one folder.";
  return `This app will be able to read ${list(yes)}.${no.length ? ` It will not see ${list(no)}.` : ""}`;
}

export function AppsTab() {
  const { data } = useVault();
  const [connecting, setConnecting] = useState(false);
  const [created, setCreated] = useState<{ appKey: string; kind: AppKind; name: string } | null>(null);
  const active = data.apps.filter((a) => !a.revokedAt);
  const revoked = data.apps.filter((a) => a.revokedAt);

  if (created) return <AppKeyPanel {...created} onDone={() => setCreated(null)} />;

  return (
    <div className="apps">
      <div className="panel-header">
        <h2 className="panel-title">Connected apps</h2>
        {!connecting ? (
          <button type="button" className="button button-primary" onClick={() => setConnecting(true)}>
            <PlusIcon /> Connect an app
          </button>
        ) : null}
      </div>

      {connecting ? (
        <ConnectForm
          onCancel={() => setConnecting(false)}
          onCreated={(c) => {
            setConnecting(false);
            setCreated(c);
          }}
        />
      ) : null}

      {data.apps.length === 0 && !connecting ? (
        <Empty
          icon={<McpIcon />}
          title="No apps connected yet"
          action={
            <button type="button" className="button button-primary" onClick={() => setConnecting(true)}>
              Connect your first app
            </button>
          }
        >
          Connect Claude Desktop, Cursor, ChatGPT or another MCP app, and choose which folders it may read. You can change or revoke it at any time.
        </Empty>
      ) : null}

      {active.length > 0 ? (
        <ul className="list">
          {active.map((a) => (
            <AppRow key={a.id} app={a} />
          ))}
        </ul>
      ) : null}

      {revoked.length > 0 ? (
        <>
          <h3 className="settings-heading">Revoked</h3>
          <ul className="list">
            {revoked.map((a) => (
              <AppRow key={a.id} app={a} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function FolderPicker({ folders, selected, onChange, idPrefix }: { folders: OpenFolder[]; selected: Set<string>; onChange(s: Set<string>): void; idPrefix: string }) {
  return (
    <fieldset className="checkbox-list">
      <legend className="visually-hidden">Folders this app may read</legend>
      {folders.map((f) => (
        <label key={f.id} className="checkbox" htmlFor={`${idPrefix}-${f.id}`}>
          <input
            id={`${idPrefix}-${f.id}`}
            type="checkbox"
            checked={selected.has(f.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(f.id);
              else next.delete(f.id);
              onChange(next);
            }}
          />
          <span>{f.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ConnectForm({ onCancel, onCreated }: { onCancel(): void; onCreated(c: { appKey: string; kind: AppKind; name: string }): void }) {
  const { api, vault, data, reload } = useVault();
  const [kind, setKind] = useState<AppKind>("claude-desktop");
  const [name, setName] = useState("Claude Desktop");
  const [nameTouched, setNameTouched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const folders = data.folders.filter((f) => selected.has(f.id));
      const { appKey } = await ops.connectApp(api, vault, { name, kind }, folders);
      onCreated({ appKey, kind, name });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel connect-form" onSubmit={submit} aria-label="Connect an app">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor="app-kind">
            App
          </label>
          <select
            id="app-kind"
            className="select"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as AppKind;
              setKind(k);
              if (!nameTouched) setName(k === "other" ? "" : kindInfo(k).label);
            }}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="app-name">
            Name in your vault
          </label>
          <input
            id="app-name"
            className="input"
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder="For example Work laptop"
            required
          />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Folders it may read</span>
        <FolderPicker folders={data.folders} selected={selected} onChange={setSelected} idPrefix="new-app" />
        <span className="field-hint" aria-live="polite">
          {plainWords(data.folders, selected)} Read only: it can search and read, never change or delete.
        </span>
      </div>
      <Notice>Once an AI app has read a memory, what it does with that text is up to the app. Share folders with apps you trust.</Notice>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || selected.size === 0 || !name.trim()}>
          {busy ? "Creating key" : "Create app key"}
        </button>
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AppKeyPanel({ appKey, kind, name, onDone }: { appKey: string; kind: AppKind; name: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : site.url;
  const info = kindInfo(kind);
  return (
    <section className="app-key-panel" aria-labelledby="key-title">
      <h2 id="key-title" className="panel-title">
        {name} is ready to connect
      </h2>
      <p className="muted">
        This is the app key. It is shown only now: Sigil does not keep it and cannot show it again. If you lose it, revoke the app and connect it
        again.
      </p>
      <div className="app-key" data-testid="app-key">
        {appKey}
      </div>
      <div className="row form-actions">
        <CopyButton text={appKey} label="Copy app key" className="button button-small button-primary" onCopied={() => setCopied(true)} />
      </div>

      <h3 className="settings-heading">Add it to {info.label}</h3>
      {!site.connectorPublished ? (
        <p className="small muted">
          First build the connector once, as described in the <Link href="/docs#connector">docs</Link>, and put its path in place of /path/to/Sigil.
        </p>
      ) : null}
      {kind === "claude-desktop" || kind === "cursor" ? (
        <>
          <ul className="small muted">
            {configLocations[kind].where.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <CodeBlock code={mcpConfig(appKey, origin)} label={kind === "cursor" ? "mcp.json" : "claude_desktop_config.json"} language="json" />
          <p className="small muted">Save the file and restart {info.label}. Sigil then shows up among its tools.</p>
        </>
      ) : kind === "chatgpt" ? (
        <>
          <p className="small muted">Run the connector in HTTP mode, reach it through an HTTPS tunnel, and add the address as a custom connector in ChatGPT.</p>
          <CodeBlock code={shellCommand(appKey, origin, true)} label="Terminal" />
          <p className="small muted">
            The full steps, and why the address must stay private, are in the <Link href="/docs#chatgpt">docs</Link>.
          </p>
        </>
      ) : (
        <>
          <p className="small muted">Start the connector over stdio with these settings, or use the JSON form most MCP apps accept.</p>
          <CodeBlock code={shellCommand(appKey, origin)} label="Terminal" />
          <CodeBlock code={mcpConfig(appKey, origin)} label="MCP config" language="json" />
        </>
      )}

      <label className="checkbox">
        <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.target.checked)} />
        <span>I have copied the app key.</span>
      </label>
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!copied} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

function AppRow({ app }: { app: ops.AppView }) {
  const { api, vault, data, update } = useVault();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "revoke" | "remove">(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(app.folderIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { Icon, label } = kindInfo(app.kind);
  const folderNames = names(data.folders, new Set(app.folderIds));

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="list-row app-row" data-status={app.revokedAt ? "revoked" : "active"}>
      <div className="list-row-main">
        <p className="list-row-title">
          <Icon /> {app.name}
          <span className="badge">{app.revokedAt ? "Revoked" : "Active"}</span>
        </p>
        <p className="list-row-meta">
          {label}. Connected {formatDateTime(app.createdAt)}.{" "}
          {app.revokedAt ? `Revoked ${formatDateTime(app.revokedAt)}.` : app.lastUsedAt ? `Last read ${formatDateTime(app.lastUsedAt)}.` : "Not used yet."}
        </p>
        {!app.revokedAt ? (
          <div className="chips app-folders">
            {folderNames.length ? (
              folderNames.map((n) => (
                <span key={n} className="chip">
                  {n}
                </span>
              ))
            ) : (
              <span className="chip">No folders</span>
            )}
          </div>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}

        {editing ? (
          <div className="subpanel">
            <FolderPicker folders={data.folders} selected={selected} onChange={setSelected} idPrefix={`edit-${app.id}`} />
            <p className="field-hint">{plainWords(data.folders, selected)}</p>
            <div className="row form-actions">
              <button
                type="button"
                className="button button-small button-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await ops.setAppFolders(api, vault, app, data.folders.filter((f) => selected.has(f.id)));
                    update((d) => ({ ...d, apps: d.apps.map((a) => (a.id === app.id ? { ...a, folderIds: [...selected] } : a)) }));
                    setEditing(false);
                  })
                }
              >
                Save permissions
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {confirm ? (
          <div className="subpanel">
            <p className="small">
              {confirm === "revoke"
                ? `Revoke ${app.name}? Its key stops working on the next request and its folder keys are deleted. What it already read stays with the app.`
                : `Remove ${app.name} from this list? Its entries in the read log stay.`}
            </p>
            <div className="row">
              <button
                type="button"
                className="button button-danger button-small"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (confirm === "revoke") {
                      await ops.revokeApp(api, app.id);
                      const at = new Date().toISOString();
                      update((d) => ({ ...d, apps: d.apps.map((a) => (a.id === app.id ? { ...a, revokedAt: at, folderIds: [] } : a)) }));
                    } else {
                      await ops.removeApp(api, app.id);
                      update((d) => ({ ...d, apps: d.apps.filter((a) => a.id !== app.id) }));
                    }
                    setConfirm(null);
                  })
                }
              >
                {confirm === "revoke" ? "Revoke access" : "Remove"}
              </button>
              <button type="button" className="button button-ghost button-small" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {!editing && !confirm ? (
        <div className="list-row-actions">
          {!app.revokedAt ? (
            <>
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  setSelected(new Set(app.folderIds));
                  setEditing(true);
                }}
              >
                Permissions
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setConfirm("revoke")}>
                Revoke
              </button>
            </>
          ) : (
            <button type="button" className="button button-small button-ghost" onClick={() => setConfirm("remove")}>
              Remove
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}
