"use client";

import { useState } from "react";
import Link from "next/link";
import { canWrite, DEFAULT_AGENT_RULES, parseVaultCode, vaultFingerprint, type AgentRules, type AppKind, type SpaceRole } from "@sigil/core";
import { AgentIcon, CheckIcon, FolderIcon, PlusIcon, TeamIcon } from "@/components/icons";
import { CodeBlock } from "@/components/CodeBlock";
import { claudeCodeCommand, configLocations, mcpConfig, shellCommand } from "@/lib/connector";
import { formatDateTime, plural } from "@/lib/format";
import { site } from "@/lib/site";
import * as ops from "../ops";
import * as agents from "../agentOps";
import { errorText, useVault } from "../context";
import { AppMark } from "../marks";
import { CopyButton, Empty, Fingerprint, Notice, Spinner } from "../ui";
import { PrivacyScoreCard } from "../Score";

const CLIENTS: { kind: AppKind; label: string }[] = [
  { kind: "cursor", label: "Cursor" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "claude-desktop", label: "Claude Desktop" },
  { kind: "other", label: "Other MCP client" },
];

const TOOL_TEXT: Record<keyof AgentRules, { label: string; hint: string }> = {
  remember: { label: "Remember", hint: "Write memories to its own folder and to folders you let it write." },
  recall: { label: "Recall", hint: "Search and read its folder, the folders below and its team spaces." },
  forget: { label: "Forget", hint: "Delete memories for good, only where it may write." },
  handoff: { label: "Handoff notes", hint: "Leave notes for its next session and pick up notes from other agents in its spaces." },
};

export function AgentsTab() {
  const { data } = useVault();
  const [making, setMaking] = useState(false);
  const [created, setCreated] = useState<{ appKey: string; kind: AppKind; name: string } | null>(null);
  const rows = data.agents.map((a) => ({ agent: a, app: data.apps.find((x) => x.id === a.appId) })).filter((r) => r.app);

  if (created) return <AgentKeyPanel {...created} onDone={() => setCreated(null)} />;

  return (
    <div className="agents">
      <div className="panel-header">
        <h2 className="panel-title">Agents</h2>
        {!making ? (
          <button type="button" className="button button-primary" onClick={() => setMaking(true)}>
            <PlusIcon /> Make an agent vault
          </button>
        ) : null}
      </div>
      <p className="small muted agents-lead">
        An agent vault gives Cursor, Claude Code or any MCP client a memory of its own: a folder only it writes, the folders you let it read or write, and rules for each of its
        tools. It works through the same connector, and every call is in your read log.
      </p>

      {making ? (
        <AgentForm
          onCancel={() => setMaking(false)}
          onCreated={(c) => {
            setMaking(false);
            setCreated(c);
          }}
        />
      ) : null}

      {rows.length === 0 && !making ? (
        <Empty
          icon={<AgentIcon />}
          title="No agent has a memory here yet"
          action={
            <button type="button" className="button button-primary" onClick={() => setMaking(true)}>
              Make the first agent vault
            </button>
          }
        >
          Give a coding agent a place to keep what it learns about a project, and notes for its next session.
        </Empty>
      ) : (
        <ul className="list agent-list">
          {rows.map((r) => (
            <AgentRow key={r.agent.appId} agent={r.agent} app={r.app!} />
          ))}
        </ul>
      )}

      <Spaces />
    </div>
  );
}

function RulesPicker({ rules, onChange, idPrefix }: { rules: AgentRules; onChange(r: AgentRules): void; idPrefix: string }) {
  return (
    <fieldset className="agent-rules">
      <legend className="field-label">What it may do</legend>
      {(Object.keys(TOOL_TEXT) as (keyof AgentRules)[]).map((k) => (
        <label key={k} className="checkbox suggest-toggle" htmlFor={`${idPrefix}-${k}`}>
          <input id={`${idPrefix}-${k}`} type="checkbox" checked={rules[k]} onChange={(e) => onChange({ ...rules, [k]: e.target.checked })} />
          <span>
            {TOOL_TEXT[k].label}
            <span className="field-hint">{TOOL_TEXT[k].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function FolderModes({ read, write, onChange, idPrefix, exclude }: { read: Set<string>; write: Set<string>; onChange(read: Set<string>, write: Set<string>): void; idPrefix: string; exclude?: string }) {
  const { data } = useVault();
  const folders = data.folders.filter((f) => f.id !== exclude);
  return (
    <fieldset className="agent-folders">
      <legend className="field-label">Other folders</legend>
      {folders.length === 0 ? <p className="small faint">No other folders.</p> : null}
      <ul className="agent-folder-list">
        {folders.map((f) => {
          const mode = write.has(f.id) ? "write" : read.has(f.id) ? "read" : "none";
          return (
            <li key={f.id} className="agent-folder" data-mode={mode}>
              <span className="agent-folder-name">
                <FolderIcon /> {f.name}
              </span>
              <label className="visually-hidden" htmlFor={`${idPrefix}-${f.id}`}>
                Access to {f.name}
              </label>
              <select
                id={`${idPrefix}-${f.id}`}
                className="select select-small"
                value={mode}
                onChange={(e) => {
                  const r = new Set(read);
                  const w = new Set(write);
                  r.delete(f.id);
                  w.delete(f.id);
                  if (e.target.value === "read") r.add(f.id);
                  if (e.target.value === "write") w.add(f.id);
                  onChange(r, w);
                }}
              >
                <option value="none">No access</option>
                <option value="read">Read</option>
                <option value="write">Read and write</option>
              </select>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function AgentForm({ onCancel, onCreated }: { onCancel(): void; onCreated(c: { appKey: string; kind: AppKind; name: string }): void }) {
  const { api, vault, data, reload } = useVault();
  const [kind, setKind] = useState<AppKind>("cursor");
  const [name, setName] = useState("Cursor");
  const [touched, setTouched] = useState(false);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [write, setWrite] = useState<Set<string>>(new Set());
  const [rules, setRules] = useState<AgentRules>(DEFAULT_AGENT_RULES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await agents.createAgent(api, vault, {
        name,
        kind,
        read: data.folders.filter((f) => read.has(f.id) || write.has(f.id)),
        write: data.folders.filter((f) => write.has(f.id)),
        rules,
      });
      onCreated({ appKey: made.appKey, kind, name });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel connect-form agent-form" onSubmit={submit} aria-label="Make an agent vault">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor="agent-kind">
            Client
          </label>
          <select
            id="agent-kind"
            className="select"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as AppKind;
              setKind(k);
              if (!touched) setName(k === "other" ? "" : (CLIENTS.find((c) => c.kind === k)?.label ?? ""));
            }}
          >
            {CLIENTS.map((c) => (
              <option key={c.kind} value={c.kind}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="agent-name">
            Name in your vault
          </label>
          <input
            id="agent-name"
            className="input"
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
            placeholder="For example Cursor on the work laptop"
            required
          />
        </div>
      </div>
      <p className="small muted">
        It gets its own folder, &quot;{name.trim() || "Agent"} memory&quot;, which it may always read and write.
      </p>
      <FolderModes read={read} write={write} onChange={(r, w) => (setRead(r), setWrite(w))} idPrefix="new-agent" />
      <RulesPicker rules={rules} onChange={setRules} idPrefix="new-agent-rule" />
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
          {busy ? "Making the key" : "Make the agent key"}
        </button>
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AgentKeyPanel({ appKey, kind, name, onDone }: { appKey: string; kind: AppKind; name: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : site.url;
  return (
    <section className="app-key-panel" aria-labelledby="agent-key-title">
      <h2 id="agent-key-title" className="panel-title">
        {name} has a memory of its own
      </h2>
      <p className="muted">This is the agent&apos;s key. It is shown only now. If you lose it, revoke the agent and make a new one.</p>
      <div className="app-key" data-testid="app-key">
        {appKey}
      </div>
      <div className="row form-actions">
        <CopyButton text={appKey} label="Copy agent key" className="button button-small button-primary" onCopied={() => setCopied(true)} />
      </div>
      <h3 className="settings-heading">Set it up</h3>
      {!site.connectorPublished ? (
        <p className="small muted">
          Build the connector once, as described in the <Link href="/docs#connector">docs</Link>, and put its path in place of /path/to/Sigil.
        </p>
      ) : null}
      {kind === "claude-code" ? (
        <CodeBlock code={claudeCodeCommand(appKey, origin)} label="Terminal" />
      ) : kind === "cursor" || kind === "claude-desktop" ? (
        <>
          <ul className="small muted">
            {configLocations[kind].where.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <CodeBlock code={mcpConfig(appKey, origin)} label={kind === "cursor" ? "mcp.json" : "claude_desktop_config.json"} language="json" />
        </>
      ) : (
        <>
          <CodeBlock code={shellCommand(appKey, origin)} label="Terminal" />
          <CodeBlock code={mcpConfig(appKey, origin)} label="MCP config" language="json" />
        </>
      )}
      <p className="small muted">
        The connector sees that the key belongs to an agent and adds remember, recall, forget, leave_handoff and pick_up_handoffs to its tools. Per client steps are in the{" "}
        <Link href="/docs#agents">docs</Link>.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={copied} onChange={(e) => setCopied(e.target.checked)} />
        <span>I have copied the agent key.</span>
      </label>
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!copied} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

function AgentRow({ agent, app }: { agent: agents.AgentView; app: ops.AppView }) {
  const { api, vault, data, reload } = useVault();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState<agents.OwnerHandoff[] | null>(null);
  const [confirm, setConfirm] = useState<null | "revoke" | "remove">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const home = data.folders.find((f) => f.id === agent.homeFolderId);
  const write = new Set(app.writeIds.filter((id) => id !== agent.homeFolderId));
  const read = new Set(app.folderIds.filter((id) => id !== agent.homeFolderId && !write.has(id)));
  const [draft, setDraft] = useState({ read, write, rules: agent.rules });
  const names = (ids: Set<string>) => data.folders.filter((f) => ids.has(f.id)).map((f) => f.name);
  const own = data.memories.filter((m) => m.folderId === agent.homeFolderId).length;

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
    <li className="list-row app-row agent-row" data-status={app.revokedAt ? "revoked" : "active"}>
      <div className="list-row-main">
        <p className="list-row-title">
          <AppMark kind={app.kind} /> {app.name}
          <span className="badge">{app.revokedAt ? "Revoked" : "Active"}</span>
        </p>
        <p className="list-row-meta">
          Own folder {home?.name ?? "deleted"} with {plural(own, "memory", "memories")}.
          {write.size ? ` Writes ${names(write).join(", ")}.` : ""}
          {read.size ? ` Reads ${names(read).join(", ")}.` : ""}
          {app.lastUsedAt ? ` Last used ${formatDateTime(app.lastUsedAt)}.` : " Not used yet."}
        </p>
        <p className="chips">
          {(Object.keys(TOOL_TEXT) as (keyof AgentRules)[]).map((k) => (
            <span key={k} className={agent.rules[k] ? "chip chip-strong" : "chip"} data-on={agent.rules[k] ? "true" : "false"}>
              {TOOL_TEXT[k].label}
              {agent.rules[k] ? "" : ": off"}
            </span>
          ))}
        </p>
        {!app.revokedAt ? <PrivacyScoreCard app={app} /> : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        {editing ? (
          <div className="subpanel">
            <FolderModes read={draft.read} write={draft.write} exclude={agent.homeFolderId} onChange={(r, w) => setDraft((d) => ({ ...d, read: r, write: w }))} idPrefix={`agent-${app.id}`} />
            <RulesPicker rules={draft.rules} onChange={(r) => setDraft((d) => ({ ...d, rules: r }))} idPrefix={`agent-${app.id}-rule`} />
            <div className="row">
              <button
                type="button"
                className="button button-small button-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const folders = data.folders.filter((f) => f.id === agent.homeFolderId || draft.read.has(f.id) || draft.write.has(f.id));
                    await agents.updateAgent(api, vault, app, agent, folders, draft.write, draft.rules);
                    setEditing(false);
                    await reload();
                  })
                }
              >
                {busy ? "Saving" : "Save"}
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {notes ? (
          <div className="subpanel agent-notes" data-testid="agent-notes">
            {notes.length === 0 ? <p className="small muted">No handoff notes yet.</p> : null}
            {notes.map((n) => (
              <div key={n.id} className="agent-note">
                <p className="small faint">
                  {formatDateTime(n.createdAt)}
                  {n.spaceId ? `, in ${data.spaces.find((s) => s.id === n.spaceId)?.name ?? "a space"}` : ", for its next session"}
                  {n.pickedAt ? `, picked up ${formatDateTime(n.pickedAt)}` : ", waiting"}
                </p>
                <p className="small agent-note-text">{n.note ? n.note.text : "This note could not be opened."}</p>
              </div>
            ))}
          </div>
        ) : null}
        {confirm ? (
          <div className="subpanel">
            <p className="small">
              {confirm === "revoke"
                ? `Revoke ${app.name}? Its key stops working on its next request. Its folder and memories stay in your vault.`
                : `Remove ${app.name} from the list? Its folder stays; delete it under Folders if you want it gone.`}
            </p>
            <div className="row">
              <button
                type="button"
                className="button button-small button-danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (confirm === "revoke") await ops.revokeApp(api, app.id);
                    else await ops.removeApp(api, app.id);
                    setConfirm(null);
                    await reload();
                  })
                }
              >
                {confirm === "revoke" ? "Revoke" : "Remove"}
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => setConfirm(null)}>
                Keep it
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {!editing && !confirm ? (
        <div className="list-row-actions">
          {!app.revokedAt ? (
            <>
              <button type="button" className="button button-small" onClick={() => setEditing(true)}>
                Permissions
              </button>
              <button
                type="button"
                className="button button-small"
                disabled={busy}
                onClick={() =>
                  notes
                    ? setNotes(null)
                    : void act(async () => {
                        setNotes(await agents.agentHandoffs(api, vault, app, data.spaces));
                      })
                }
              >
                {notes ? "Hide notes" : "Handoff notes"}
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

// ---------------------------------------------------------------- team spaces

const ROLE_TEXT: Record<SpaceRole, string> = { read: "Reads", write: "Reads and writes", admin: "Admin" };

function Spaces() {
  const { api, data, reload } = useVault();
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [me, setMe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="spaces" aria-labelledby="spaces-title">
      <div className="panel-header">
        <h3 id="spaces-title" className="settings-heading">
          <TeamIcon /> Team spaces
        </h3>
        {!making ? (
          <button type="button" className="button button-small" onClick={() => setMaking(true)}>
            <PlusIcon /> New space
          </button>
        ) : null}
      </div>
      <p className="small muted">
        A space is one shared memory that several vaults and agents read and write, each with a role. Its key is sealed to every member; removing someone gives it a new key.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {making ? (
        <form
          className="subpanel"
          aria-label="New space"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await agents.createSpace(api, data, name, me);
              setMaking(false);
              setName("");
              await reload();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label" htmlFor="space-name">
                Name of the space
              </label>
              <input id="space-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="For example Launch" required />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="space-me">
                Your name in it
              </label>
              <input id="space-me" className="input" value={me} maxLength={80} onChange={(e) => setMe(e.target.value)} placeholder="For example Sam" required />
            </div>
          </div>
          <div className="row">
            <button type="submit" className="button button-small button-primary" disabled={busy || !name.trim() || !me.trim()}>
              {busy ? "Making its key" : "Make the space"}
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setMaking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {data.spaces.length === 0 && !making ? <p className="small faint">You are not in any space yet.</p> : null}
      <ul className="space-list">
        {data.spaces.map((s) => (
          <SpaceCard key={s.id} space={s} />
        ))}
      </ul>
    </section>
  );
}

function SpaceCard({ space }: { space: agents.SpaceView }) {
  const { api, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | "vault" | "agent">(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const admin = space.me.role === "admin";
  const writer = canWrite(space.me.role);
  const label = (id: string | null) => space.members.find((m) => m.id === id)?.label ?? "A former member";

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
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

  if (!space.me.acceptedAt) {
    return (
      <li className="space-card subpanel" data-state="invited">
        <p className="space-title">
          <TeamIcon /> {space.name}
        </p>
        <p className="small muted">
          You were added as {ROLE_TEXT[space.me.role].toLowerCase()} by a member of this space. {plural(space.members.length, "member")}.
        </p>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <button type="button" className="button button-small button-primary" disabled={!!busy} onClick={() => void act("accept", () => agents.acceptSpace(api, space.id))}>
          {busy === "accept" ? "Accepting" : "Accept"}
        </button>
      </li>
    );
  }

  return (
    <li className="space-card subpanel" data-state="member" data-role={space.me.role}>
      <div className="space-head">
        <p className="space-title">
          <TeamIcon /> {space.name}
        </p>
        <span className="badge badge-strong">{ROLE_TEXT[space.me.role]}</span>
      </div>
      {space.untrusted.length ? (
        <Notice kind="error">
          {plural(space.untrusted.length, "member")} of this space were not added by someone who holds its key. Nothing is sealed to anyone until an admin removes them.
        </Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <ul className="space-members" aria-label={`Members of ${space.name}`}>
        {space.members.map((m) => (
          <li key={m.id} className="space-member" data-kind={m.kind} data-trusted={m.trusted ? "true" : "false"}>
            <span className="space-member-name">
              {m.kind === "agent" ? <AgentIcon /> : <TeamIcon />} {m.label}
              {m.id === space.me.id ? " (you)" : ""}
            </span>
            <span className="space-member-meta">
              {ROLE_TEXT[m.role]}
              {m.kind === "vault" && !m.acceptedAt ? ", not accepted yet" : ""}
              {m.kind === "agent" && m.owner ? `, agent of ${label(m.owner)}` : ""}
            </span>
            {admin && m.id !== space.me.id ? (
              removing === m.id ? (
                <span className="space-member-actions">
                  <button
                    type="button"
                    className="button button-small button-danger"
                    disabled={!!busy}
                    onClick={() => void act("remove", async () => agents.removeMembers(api, space, [m.id]).then(() => setRemoving(null)))}
                  >
                    {busy === "remove" ? "Making a new key" : "Remove"}
                  </button>
                  <button type="button" className="button button-small button-ghost" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <span className="space-member-actions">
                  {m.kind === "vault" ? (
                    <select
                      className="select select-small"
                      aria-label={`Role of ${m.label}`}
                      value={m.role}
                      disabled={!!busy}
                      onChange={(e) => void act("role", () => agents.setMemberRole(api, space, m, e.target.value as SpaceRole))}
                    >
                      <option value="read">Reads</option>
                      <option value="write">Reads and writes</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : null}
                  <button type="button" className="button button-small button-ghost" onClick={() => setRemoving(m.id)}>
                    Remove
                  </button>
                </span>
              )
            ) : null}
          </li>
        ))}
      </ul>

      {space.memories.length ? (
        <ul className="list space-memories">
          {space.memories.map((m) => (
            <li key={m.id} className="list-row">
              <div className="list-row-main">
                <button type="button" className="text-button list-row-title" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                  {m.title}
                </button>
                <p className="list-row-meta">
                  By {label(m.author)}, {formatDateTime(m.editedAt)}
                </p>
                {open === m.id ? <p className="space-memory-body">{m.body}</p> : null}
              </div>
              {writer ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small button-ghost" disabled={!!busy} onClick={() => void act("del-" + m.id, () => agents.deleteSpaceMemory(api, space.id, m.id))}>
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small faint">Nothing in this space yet.</p>
      )}

      {writing ? (
        <form
          className="subpanel"
          aria-label={`Write to ${space.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void act("write", async () => {
              await agents.saveSpaceMemory(api, space, { title, body });
              setTitle("");
              setBody("");
              setWriting(false);
            });
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor={`sm-title-${space.id}`}>
              Title
            </label>
            <input id={`sm-title-${space.id}`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`sm-body-${space.id}`}>
              Memory
            </label>
            <textarea id={`sm-body-${space.id}`} className="textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="row">
            <button type="submit" className="button button-small button-primary" disabled={!!busy || !title.trim()}>
              {busy === "write" ? "Saving" : "Save to the space"}
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setWriting(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {adding === "vault" ? <AddVault space={space} onDone={() => setAdding(null)} /> : null}
      {adding === "agent" ? <AddAgent space={space} onDone={() => setAdding(null)} /> : null}

      <div className="row space-actions">
        {writer && !writing ? (
          <button type="button" className="button button-small" onClick={() => setWriting(true)}>
            <PlusIcon /> Write
          </button>
        ) : null}
        {admin ? (
          <button type="button" className="button button-small" onClick={() => setAdding("vault")}>
            Add a person
          </button>
        ) : null}
        {writer && data.agents.length ? (
          <button type="button" className="button button-small" onClick={() => setAdding("agent")}>
            Add an agent
          </button>
        ) : null}
        {admin ? (
          <button
            type="button"
            className="button button-small button-ghost"
            disabled={!!busy}
            onClick={() => setDeleting(true)}
          >
            Delete the space
          </button>
        ) : null}
      </div>
      {deleting ? (
        <div className="subpanel">
          <p className="small">Delete the space {space.name} and everything in it, for every member? This cannot be undone.</p>
          <div className="row">
            <button type="button" className="button button-small button-danger" disabled={!!busy} onClick={() => void act("delete", () => agents.deleteSpace(api, space.id))}>
              {busy === "delete" ? "Deleting" : "Delete the space"}
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setDeleting(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      {busy && busy !== "write" && busy !== "delete" ? <Spinner label="Working" /> : null}
    </li>
  );
}

function AddVault({ space, onDone }: { space: agents.SpaceView; onDone(): void }) {
  const { api, reload } = useVault();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<SpaceRole>("write");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let fingerprint: string | null = null;
  if (code.trim()) {
    try {
      fingerprint = vaultFingerprint(parseVaultCode(code));
    } catch {
      fingerprint = null;
    }
  }
  return (
    <form
      className="subpanel"
      aria-label={`Add a person to ${space.name}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await agents.addVaultMember(api, space, code, label, role);
          await reload();
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="field">
        <label className="field-label" htmlFor={`sv-code-${space.id}`}>
          Their vault code
        </label>
        <input id={`sv-code-${space.id}`} className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sigil_vault..." spellCheck={false} autoComplete="off" />
        {fingerprint ? (
          <p className="field-hint">
            Fingerprint to compare: <Fingerprint value={fingerprint} />
          </p>
        ) : null}
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor={`sv-label-${space.id}`}>
            Their name in the space
          </label>
          <input id={`sv-label-${space.id}`} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`sv-role-${space.id}`}>
            Role
          </label>
          <select id={`sv-role-${space.id}`} className="select" value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
            <option value="read">Reads</option>
            <option value="write">Reads and writes</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      <div className="row">
        <button type="submit" className="button button-small button-primary" disabled={busy || !fingerprint || !label.trim()}>
          <CheckIcon /> {busy ? "Sealing the key" : "Add"}
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddAgent({ space, onDone }: { space: agents.SpaceView; onDone(): void }) {
  const { api, vault, data, reload } = useVault();
  const inSpace = new Set(space.members.map((m) => m.publicKey));
  const mine = data.agents.filter((a) => !inSpace.has(a.publicKey)).map((a) => data.apps.find((x) => x.id === a.appId && !x.revokedAt)).filter((x): x is ops.AppView => !!x);
  const [appId, setAppId] = useState(mine[0]?.id ?? "");
  const [role, setRole] = useState<"read" | "write">("write");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (mine.length === 0) {
    return (
      <div className="subpanel">
        <p className="small muted">All your agents are in this space already.</p>
        <button type="button" className="button button-small button-ghost" onClick={onDone}>
          Close
        </button>
      </div>
    );
  }
  return (
    <form
      className="subpanel"
      aria-label={`Add an agent to ${space.name}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await agents.addAgentMember(api, vault, space, mine.find((a) => a.id === appId)!, role);
          await reload();
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor={`sa-agent-${space.id}`}>
            Agent
          </label>
          <select id={`sa-agent-${space.id}`} className="select" value={appId} onChange={(e) => setAppId(e.target.value)}>
            {mine.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`sa-role-${space.id}`}>
            Role
          </label>
          <select id={`sa-role-${space.id}`} className="select" value={role} onChange={(e) => setRole(e.target.value as "read" | "write")}>
            <option value="read">Reads</option>
            {canWrite(space.me.role) ? <option value="write">Reads and writes</option> : null}
          </select>
        </div>
      </div>
      <div className="row">
        <button type="submit" className="button button-small button-primary" disabled={busy || !appId}>
          <CheckIcon /> {busy ? "Sealing the key" : "Add"}
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="small faint">The space key is sealed to a key made from the agent&apos;s own secret, on this device.</p>
    </form>
  );
}
