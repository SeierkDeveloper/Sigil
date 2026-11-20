"use client";

import { useState } from "react";
import { parseVaultCode, vaultFingerprint, type OpenFolder } from "@sigil/core";
import { CheckIcon, FolderIcon, KeyIcon, LockIcon, PlusIcon, ShareIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { CopyButton, Fingerprint, Notice } from "../ui";
import { legacyCovers, resealLegacy } from "../legacyOps";

export function FoldersTab() {
  const { api, vault, data, update, reload } = useVault();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const m of data.memories) counts.set(m.folderId, (counts.get(m.folderId) ?? 0) + 1);
  const readers = (folderId: string) => data.apps.filter((a) => !a.revokedAt && a.folderIds.includes(folderId)).map((a) => a.name);

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

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const folder = await ops.addFolder(api, vault, name);
      update((d) => ({ ...d, folders: [...d.folders, folder] }));
      setName("");
    });
  };

  return (
    <div className="folders">
      <div className="panel-header">
        <h2 className="panel-title">Folders</h2>
        <p className="small muted">Each folder has its own key. Apps can only open the folders you give them.</p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}

      <ul className="list">
        {data.folders.map((f) => {
          const n = counts.get(f.id) ?? 0;
          const apps = readers(f.id);
          return (
            <li key={f.id} className="list-row">
              <div className="list-row-main">
                {renaming?.id === f.id ? (
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        const next = await ops.renameFolder(api, f, renaming.name);
                        update((d) => ({ ...d, folders: d.folders.map((x) => (x.id === f.id ? next : x)) }));
                        setRenaming(null);
                      });
                    }}
                  >
                    <label className="visually-hidden" htmlFor={`rename-${f.id}`}>
                      New name
                    </label>
                    <input id={`rename-${f.id}`} className="input" value={renaming.name} onChange={(e) => setRenaming({ id: f.id, name: e.target.value })} autoFocus />
                    <button type="submit" className="button button-small button-primary" disabled={busy || !renaming.name.trim()}>
                      Save
                    </button>
                    <button type="button" className="button button-small button-ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <p className="list-row-title">
                      <FolderIcon /> {f.name}
                    </p>
                    <p className="list-row-meta">
                      {f.kind === "profile" ? "Your Self card. " : ""}
                      {plural(n, "memory", "memories")}. {apps.length ? `Readable by ${apps.join(", ")}.` : "No app can read it."}
                    </p>
                  </>
                )}
                <FolderShares folder={f} />
                {sharing === f.id ? <ShareForm folder={f} onDone={() => setSharing(null)} /> : null}
                {deleting === f.id ? (
                  <div className="subpanel">
                    <p className="small">
                      Delete &quot;{f.name}&quot; and the {plural(n, "memory", "memories")} in it for good? Apps lose access to it at once.
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="button button-danger button-small"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await ops.removeFolder(api, f.id);
                            setDeleting(null);
                            await reload();
                          })
                        }
                      >
                        Delete folder
                      </button>
                      <button type="button" className="button button-ghost button-small" onClick={() => setDeleting(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              {renaming?.id !== f.id && deleting !== f.id && sharing !== f.id ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small" onClick={() => setRenaming({ id: f.id, name: f.name })}>
                    Rename
                  </button>
                  <button type="button" className="button button-small" onClick={() => setSharing(f.id)}>
                    Share
                  </button>
                  <button type="button" className="button button-small button-ghost" disabled={data.folders.length <= 1} onClick={() => setDeleting(f.id)} title={data.folders.length <= 1 ? "A vault keeps at least one folder" : undefined}>
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <form className="subpanel" onSubmit={add}>
        <div className="field">
          <label className="field-label" htmlFor="new-folder">
            New folder
          </label>
          <input id="new-folder" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="For example Work, Health or Writing" />
        </div>
        <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
          <PlusIcon /> Add folder
        </button>
      </form>

      <SharedWithYou />
      <VaultCode />
    </div>
  );
}

// ---------------------------------------------------------------- sharing a folder

function ShareForm({ folder, onDone }: { folder: OpenFolder; onDone(): void }) {
  const { api, vault, update } = useVault();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let fingerprint: string | null = null;
  let codeError: string | null = null;
  if (code.trim()) {
    try {
      fingerprint = vaultFingerprint(parseVaultCode(code));
    } catch (err) {
      codeError = errorText(err);
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const share = await ops.shareFolder(api, vault, folder, code, label, from);
      update((d) => ({ ...d, shares: { ...d.shares, outgoing: [...d.shares.outgoing, share] } }));
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel share-form" onSubmit={submit} aria-label={`Share ${folder.name}`} data-code={fingerprint ? "ok" : codeError ? "bad" : "empty"}>
      <div className="share-form-head">
        <span className="share-form-mark" aria-hidden="true">
          <ShareIcon />
        </span>
        <div>
          <p className="share-form-title">Share {folder.name} with another vault</p>
          <p className="share-form-lead">The folder key is sealed for their vault alone. The server passes it on and cannot open it.</p>
        </div>
      </div>
      <ol className="handshake-steps" aria-hidden="true">
        <li data-state={fingerprint ? "done" : "now"}>
          <span>01</span> Their code
        </li>
        <li data-state={fingerprint && !busy ? "now" : "next"}>
          <span>02</span> Compare fingerprints
        </li>
        <li data-state={busy ? "now" : "next"}>
          <span>03</span> Key sealed for them
        </li>
      </ol>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="field">
        <label className="field-label" htmlFor={`share-code-${folder.id}`}>
          Their vault code
        </label>
        <input
          id={`share-code-${folder.id}`}
          className="input mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="sigil_vault..."
          autoComplete="off"
          spellCheck={false}
          required
        />
        <span className="field-hint" aria-live="polite">
          {codeError ?? (fingerprint ? `Fingerprint ${fingerprint}. Ask them to read theirs to you; they must match.` : "They find it in their vault, under Folders.")}
        </span>
      </div>
      {fingerprint ? (
        <div className="handshake" aria-hidden="true">
          <div className="handshake-side">
            <p className="handshake-label">This code belongs to</p>
            <Fingerprint value={fingerprint} />
          </div>
          <span className="handshake-link">
            <KeyIcon />
          </span>
          <div className="handshake-side">
            <p className="handshake-label">Their screen must show</p>
            <p className="handshake-text">The same five groups, under Your vault code.</p>
          </div>
        </div>
      ) : null}
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor={`share-label-${folder.id}`}>
            What you call them
          </label>
          <input id={`share-label-${folder.id}`} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Only you see this" required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`share-from-${folder.id}`}>
            Your name, as they see it
          </label>
          <input id={`share-from-${folder.id}`} className="input" value={from} maxLength={80} onChange={(e) => setFrom(e.target.value)} required />
        </div>
      </div>
      <Notice>
        They can read everything in {folder.name}, now and later, and cannot change it. Every time their vault opens it, it shows in your read log.
        Stopping the share gives the folder a new key.
      </Notice>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !fingerprint || !label.trim() || !from.trim()}>
          <ShareIcon /> {busy ? "Sharing" : "Share folder"}
        </button>
        <button type="button" className="button button-ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function FolderShares({ folder }: { folder: OpenFolder }) {
  const { api, vault, data, reload } = useVault();
  const shares = data.shares.outgoing.filter((s) => s.folderId === folder.id);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (shares.length === 0) return null;

  const stop = async (shareId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await ops.revokeShare(api, vault, data, folder, shareId);
      // The folder has a new key: a legacy plan that leaves it to someone is sealed again with it.
      if (legacyCovers(data, folder.id)) await resealLegacy(api, vault, { ...data, folders: data.folders.map((f) => (f.id === folder.id ? next : f)) });
      setConfirm(null);
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folder-shares">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="share-list" aria-label={`${folder.name} is shared with`}>
        {shares.map((s) => (
          <li key={s.id} className="share-row" data-accepted={s.acceptedAt ? "true" : "false"} data-verified={s.verified ? "true" : "false"}>
            <span className="share-row-mark" aria-hidden="true">
              {s.acceptedAt ? <CheckIcon /> : <ShareIcon />}
            </span>
            <span className="share-row-text">
              Shared with <strong>{s.label}</strong>, {s.acceptedAt ? `accepted ${formatDateTime(s.acceptedAt)}` : "waiting for them to accept"}.
              {!s.verified ? " The server holds a different key for this share than you entered; stop sharing to be safe." : ""}
            </span>
            {confirm === s.id ? (
              <span className="row">
                <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => void stop(s.id)}>
                  {busy ? "Making a new key" : "Stop sharing"}
                </button>
                <button type="button" className="button button-ghost button-small" disabled={busy} onClick={() => setConfirm(null)}>
                  Keep sharing
                </button>
              </span>
            ) : (
              <button type="button" className="button button-small button-ghost" onClick={() => setConfirm(s.id)}>
                Stop sharing
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirm ? (
        <p className="small muted">
          Stopping gives {folder.name} a new key on this device and encrypts its {plural(data.memories.filter((m) => m.folderId === folder.id).length, "memory", "memories")} again.
          Apps and anyone else you share it with keep access. What they already read, they keep.
        </p>
      ) : null}
    </div>
  );
}

function SharedWithYou() {
  const { api, data, reload, update } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const incoming = data.shares.incoming;
  if (incoming.length === 0) return null;

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

  return (
    <section className="settings-section" aria-labelledby="shared-with-you">
      <h3 id="shared-with-you" className="settings-heading">
        Shared with you
      </h3>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="list shared-list">
        {incoming.map((s) => (
          <li key={s.id} className="list-row shared-row" data-accepted={s.acceptedAt ? "true" : "false"}>
            <span className="shared-row-mark" aria-hidden="true">
              {s.acceptedAt ? <FolderIcon /> : <LockIcon />}
            </span>
            <div className="list-row-main">
              <p className="list-row-title">
                {s.folder ? s.folder.name : "A folder that could not be opened"}
                <span className="badge">{s.acceptedAt ? "Read only" : "New"}</span>
              </p>
              <p className="list-row-meta">
                From {s.from || "another vault"}, {formatDateTime(s.createdAt)}.{" "}
                {s.acceptedAt ? `${plural(s.memories.length, "memory", "memories")}, in your Memories tab. Each time your vault opens it, the owner sees it in their read log.` : "Accept to read it in your vault."}
              </p>
            </div>
            <div className="list-row-actions">
              {!s.acceptedAt && s.folder ? (
                <button type="button" className="button button-small button-primary" disabled={busy === s.id} onClick={() => void act(s.id, async () => (await ops.acceptShare(api, s.id), await reload()))}>
                  {busy === s.id ? "Accepting" : "Accept"}
                </button>
              ) : null}
              <button
                type="button"
                className="button button-small button-ghost"
                disabled={busy === s.id}
                onClick={() =>
                  void act(s.id, async () => {
                    await ops.leaveShare(api, s.id);
                    update((d) => ({ ...d, shares: { ...d.shares, incoming: d.shares.incoming.filter((x) => x.id !== s.id) } }));
                  })
                }
              >
                {s.acceptedAt ? "Remove" : "Decline"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VaultCode() {
  const { data } = useVault();
  const code = ops.vaultCode(data);
  if (!code) return null;
  return (
    <section className="settings-section vault-code" aria-labelledby="vault-code">
      <h3 id="vault-code" className="settings-heading">
        Your vault code
      </h3>
      <p className="small muted">Give this to someone who wants to share a folder with you. It holds only your vault&apos;s public key: it lets them encrypt for you, and nothing else.</p>
      <div className="vault-code-plate">
        <div className="vault-code-side">
          <p className="vault-code-label">
            <span>01</span> Send them this code
          </p>
          <div className="app-key" data-testid="vault-code">
            {code.code}
          </div>
          <div className="form-actions">
            <CopyButton text={code.code} label="Copy vault code" />
          </div>
        </div>
        <div className="vault-code-side vault-code-print">
          <p className="vault-code-label">
            <span>02</span> Read them this fingerprint
          </p>
          <p className="vault-code-fingerprint">
            <span className="visually-hidden">Fingerprint </span>
            <Fingerprint value={code.fingerprint} />
          </p>
          <p className="small muted">
            If their screen shows the same five groups after they paste your code, it reached them unchanged.
          </p>
        </div>
      </div>
    </section>
  );
}
