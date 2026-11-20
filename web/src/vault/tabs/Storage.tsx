"use client";

// Storage: where the vault lives and where copies of it are kept. The vault is
// written out as one encrypted bundle, signed on this device, to a file or to
// the owner's own storage with the owner's own tokens; a connector can do it
// in the background; and the vault can move to another node.

import { useState } from "react";
import { cleanTarget, nodeOrigin, MOVE_DEFAULT_DAYS, type BackupEvery, type BackupTarget } from "@sigil/core";
import { DownloadIcon, NodeIcon, SealIcon } from "@/components/icons";
import { formatBytes, formatDateTime, plural, shortHash } from "@/lib/format";
import * as storage from "../storageOps";
import * as nodes from "../nodeOps";
import { errorText, useVault } from "../context";
import { Band, CopyButton, Notice, PlateHead, Quiet } from "../ui";

const KIND_WORD: Record<string, string> = { s3: "S3-compatible bucket", ipfs: "IPFS", arweave: "Arweave", file: "A file" };
const EVERY_WORD: Record<BackupEvery, string> = { off: "Only when I ask", daily: "Every day", weekly: "Every week" };

function saveBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StorageTab() {
  return (
    <div className="storage">
      <div className="panel-header">
        <h2 className="panel-title">Storage</h2>
        <p className="small muted">
          Your whole vault as one bundle: every memory, key slot, setting and the sealed log, all still encrypted, signed on this device. Keep it where you choose and restore
          it on any Sigil node with your recovery phrase or wallet. How long a copy lasts depends on where you keep it: a file as long as you keep the file, a bucket while
          your account and the object exist, IPFS while the pin is kept, Arweave while its network keeps what was paid for.
        </p>
      </div>
      <WhereSection />
      <BackupSection />
      <TargetsSection />
      <BackgroundSection />
      <MoveSection />
    </div>
  );
}

function WhereSection() {
  const { api, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const places = data.backups.runs.flatMap((r) => (r.record?.places ?? []).map((p) => ({ ...p, hash: r.hash }))).filter((p) => p.kind !== "file");
  const latest = new Map<string, (typeof places)[number]>();
  for (const p of places) if (!latest.has(p.targetId)) latest.set(p.targetId, p);
  return (
    <section className="subpanel plate storage-where" aria-labelledby="storage-where">
      <PlateHead number="01" id="storage-where" title="Where your vault lives" lead="The node it is on, the nodes it came from, and the newest copy in each place you keep one." />
      {note ? <Notice>{note}</Notice> : null}
      <ul className="list node-list" data-testid="node-list">
        <li className="list-row" data-role="here">
          <div className="list-row-main">
            <p className="list-row-title">
              <NodeIcon /> {data.nodes.here} <span className="badge badge-strong">Lives here</span>
            </p>
            <p className="list-row-meta">This node holds the vault, as ciphertext, and answers for it.</p>
          </div>
        </li>
        {data.nodes.nodes.map((n) => (
          <li key={n.id} className="list-row" data-role={n.role} data-state={n.state}>
            <div className="list-row-main">
              <p className="list-row-title">
                <NodeIcon /> {n.origin} <span className="badge">{n.role === "previous" ? "Came from" : "Moved to"}</span>
              </p>
              <p className="list-row-meta">
                {n.role === "previous"
                  ? n.state === "confirmed"
                    ? `Moved here ${formatDateTime(n.since)}. It sends your links on here until ${n.until ? formatDateTime(n.until) : "its period ends"}, then deletes the vault.`
                    : "The old node has not been told yet that the vault arrived. Until it is, it keeps the vault and does not send links on."
                  : `Moved there ${formatDateTime(n.since)}.`}
              </p>
            </div>
            {n.role === "previous" && n.state === "waiting" ? (
              <div className="list-row-actions">
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(n.id);
                    try {
                      const ok = await nodes.notifyOldNode(api, n.id);
                      setNote(ok ? "The old node confirmed the move." : "The old node could not be reached. Try again later.");
                      if (ok) await reload();
                    } catch (err) {
                      setNote(errorText(err));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === n.id ? "Telling it" : "Tell the old node"}
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {[...latest.values()].map((p) => (
          <li key={p.targetId} className="list-row" data-role="copy">
            <div className="list-row-main">
              <p className="list-row-title">
                <SealIcon /> {p.label} <span className="badge">{KIND_WORD[p.kind] ?? p.kind}</span>
              </p>
              <p className="list-row-meta mono">
                {p.ref}
                {p.url ? ` (${p.url})` : ""}
              </p>
              <p className="list-row-meta">Newest copy {formatDateTime(p.at)}, bundle {shortHash(p.hash)}.</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BackupSection() {
  const { api, vault, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (which: "file" | "targets") => {
    setBusy(which);
    setError(null);
    setDone(null);
    try {
      const r = await storage.runBackup(api, vault, data, which === "file" ? { download: saveBytes, targets: [] } : {});
      const stored = r.record.places.filter((p) => p.kind !== "file").length;
      setDone(
        which === "file"
          ? `Saved ${r.name} (${formatBytes(r.bytes.length)}). Keep it somewhere safe: it opens only with your recovery phrase or wallet.`
          : `Stored in ${plural(stored, "place")}${r.record.failed.length ? `; ${r.record.failed.map((f) => `${f.label}: ${f.reason}`).join(" ")}` : "."}`,
      );
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="subpanel plate storage-backup" aria-labelledby="storage-backup">
      <PlateHead number="02" id="storage-backup" title="A copy now" lead="Made from what this node holds, checked with your key here, signed, and written from this device." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {done ? <Notice kind="success">{done}</Notice> : null}
      <div className="row">
        <button type="button" className="button button-primary" disabled={!!busy} onClick={() => void run("file")} data-testid="bundle-download">
          <DownloadIcon /> {busy === "file" ? "Making the bundle" : "Download the bundle"}
        </button>
        <button type="button" className="button" disabled={!!busy || data.backups.settings.targets.length === 0} onClick={() => void run("targets")}>
          {busy === "targets" ? "Storing" : "Store it in my storage"}
        </button>
      </div>
      <h4 className="settings-heading">Copies made</h4>
      {data.backups.runs.length === 0 ? (
        <Quiet>No copy made yet.</Quiet>
      ) : (
        <ul className="list backup-runs">
          {data.backups.runs.slice(0, 10).map((r) => (
            <li key={r.id} className="list-row" data-testid="backup-run">
              <div className="list-row-main">
                <p className="list-row-title">
                  {formatDateTime(r.createdAt)} <span className="faint">{formatBytes(r.size)}</span>
                  {r.byApp ? <span className="badge">By a connector</span> : null}
                </p>
                <p className="list-row-meta">
                  {r.record
                    ? `${r.record.places.map((p) => p.label).join(", ") || "Nowhere"}${r.record.failed.length ? `. Failed: ${r.record.failed.map((f) => f.label).join(", ")}` : ""}`
                    : "Where it went could not be opened with your key."}{" "}
                  <span className="mono">{shortHash(r.hash)}</span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Draft = { kind: "s3" | "ipfs-pinning" | "ipfs-node" | "arweave"; label: string; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; token: string; gateway: string; jwk: string };
const EMPTY: Draft = { kind: "s3", label: "", endpoint: "", region: "", bucket: "", prefix: "sigil/", accessKeyId: "", secretAccessKey: "", token: "", gateway: "", jwk: "" };

function toTarget(d: Draft): BackupTarget {
  if (d.kind === "s3") return cleanTarget({ kind: "s3", label: d.label, endpoint: d.endpoint, region: d.region, bucket: d.bucket, prefix: d.prefix, accessKeyId: d.accessKeyId, secretAccessKey: d.secretAccessKey });
  if (d.kind === "arweave") {
    let jwk: unknown = null;
    try {
      jwk = JSON.parse(d.jwk);
    } catch {
      throw new Error("Choose your Arweave wallet file (a JSON key).");
    }
    return cleanTarget({ kind: "arweave", label: d.label, bundler: d.endpoint, gateway: d.gateway, jwk });
  }
  return cleanTarget({ kind: "ipfs", label: d.label, api: d.kind === "ipfs-node" ? "node" : "pinning", endpoint: d.endpoint, token: d.token, gateway: d.gateway });
}

function TargetsSection() {
  const { api, vault, data, update } = useVault();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = data.backups.settings;
  const save = async (next: typeof settings) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await storage.saveBackupSettings(api, vault, next);
      const nextData = { ...data, backups: { ...data.backups, settings: saved } };
      await storage.refreshConnectorBackups(api, vault, nextData);
      update((d) => ({ ...d, backups: { ...d.backups, settings: saved } }));
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  return (
    <section className="subpanel plate storage-targets" aria-labelledby="storage-targets">
      <PlateHead
        number="03"
        id="storage-targets"
        title="Your storage"
        lead="Your own accounts. Their tokens are kept only in this vault, encrypted with your vault key, and used only from this device or a connector you pick."
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="How often" hint="While your vault is open on a device, and in a connector that backs up.">
        <div className="field">
          <label className="field-label" htmlFor="backup-every">
            Store a copy
          </label>
          <select id="backup-every" className="select" value={settings.every} disabled={busy} onChange={(e) => void save({ ...settings, every: e.target.value as BackupEvery })}>
            {(["off", "daily", "weekly"] as const).map((k) => (
              <option key={k} value={k}>
                {EVERY_WORD[k]}
              </option>
            ))}
          </select>
        </div>
      </Band>
      {settings.targets.length === 0 ? (
        <Quiet>No storage added. A downloaded file is always possible.</Quiet>
      ) : (
        <ul className="list storage-target-list">
          {settings.targets.map((t) => (
            <li key={t.id} className="list-row">
              <div className="list-row-main">
                <p className="list-row-title">
                  {t.label} <span className="badge">{KIND_WORD[t.kind]}</span>
                </p>
                <p className="list-row-meta mono">{t.kind === "s3" ? `${t.endpoint}/${t.bucket}/${t.prefix}` : t.kind === "ipfs" ? t.endpoint : t.bundler}</p>
              </div>
              <div className="list-row-actions">
                <button type="button" className="button button-small button-ghost" disabled={busy} onClick={() => void save({ ...settings, targets: settings.targets.filter((x) => x.id !== t.id) })}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <form
          className="storage-target-form"
          aria-label="Add storage"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            let t: BackupTarget;
            try {
              t = toTarget(draft);
            } catch (err) {
              setError(errorText(err));
              return;
            }
            if (await save({ ...settings, targets: [...settings.targets, t] })) setDraft(null);
          }}
        >
          <Band label="Where">
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label" htmlFor="target-kind">
                  Kind
                </label>
                <select id="target-kind" className="select" value={draft.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"] })}>
                  <option value="s3">An S3-compatible bucket</option>
                  <option value="ipfs-pinning">IPFS, through a pinning service</option>
                  <option value="ipfs-node">IPFS, my own node</option>
                  <option value="arweave">Arweave, through a bundler</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="target-label">
                  Name
                </label>
                <input id="target-label" className="input" value={draft.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="target-endpoint">
                {draft.kind === "s3" ? "Service address" : draft.kind === "arweave" ? "Bundler upload address" : draft.kind === "ipfs-node" ? "Node API address" : "Pinning service address"}
              </label>
              <input id="target-endpoint" className="input" type="url" inputMode="url" value={draft.endpoint} placeholder="https://" onChange={(e) => set({ endpoint: e.target.value })} />
              <span className="field-hint">
                {draft.kind === "s3"
                  ? "The bucket must allow uploads from this site (its CORS settings), and this node must list the address among its storage addresses."
                  : draft.kind === "arweave"
                    ? "A bundler that takes signed data items. Uploading to Arweave costs what the bundler charges, paid from your own account there."
                    : draft.kind === "ipfs-node"
                      ? "Your node's API, for example on your own network. The bundle is added and pinned there."
                      : "A service with a file upload that pins it, with your own token."}
              </span>
            </div>
            {draft.kind === "s3" ? (
              <>
                <div className="grid grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="target-bucket">
                      Bucket
                    </label>
                    <input id="target-bucket" className="input" value={draft.bucket} onChange={(e) => set({ bucket: e.target.value })} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="target-region">
                      Region
                    </label>
                    <input id="target-region" className="input" value={draft.region} placeholder="us-east-1" onChange={(e) => set({ region: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="target-key-id">
                      Access key id
                    </label>
                    <input id="target-key-id" className="input" autoComplete="off" value={draft.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="target-secret">
                      Secret key
                    </label>
                    <input id="target-secret" className="input" type="password" autoComplete="off" value={draft.secretAccessKey} onChange={(e) => set({ secretAccessKey: e.target.value })} />
                  </div>
                </div>
              </>
            ) : null}
            {draft.kind === "ipfs-pinning" || draft.kind === "ipfs-node" ? (
              <div className="grid grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="target-token">
                    Token {draft.kind === "ipfs-node" ? <span className="faint">(optional)</span> : null}
                  </label>
                  <input id="target-token" className="input" type="password" autoComplete="off" value={draft.token} onChange={(e) => set({ token: e.target.value })} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="target-gateway">
                    Gateway to read it back
                  </label>
                  <input id="target-gateway" className="input" type="url" value={draft.gateway} placeholder="https://ipfs.io" onChange={(e) => set({ gateway: e.target.value })} />
                </div>
              </div>
            ) : null}
            {draft.kind === "arweave" ? (
              <div className="grid grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="target-jwk">
                    Your Arweave wallet file
                  </label>
                  <input
                    id="target-jwk"
                    className="input"
                    type="file"
                    accept="application/json,.json"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) set({ jwk: await f.text() });
                    }}
                  />
                  <span className="field-hint">{draft.jwk ? "Read on this device. It is kept only encrypted in your vault." : "It signs each upload on this device."}</span>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="target-gateway">
                    Gateway to read it back
                  </label>
                  <input id="target-gateway" className="input" type="url" value={draft.gateway} placeholder="https://arweave.net" onChange={(e) => set({ gateway: e.target.value })} />
                </div>
              </div>
            ) : null}
          </Band>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "Saving" : "Add this storage"}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions">
          <button type="button" className="button" onClick={() => setDraft({ ...EMPTY })}>
            Add storage
          </button>
        </div>
      )}
    </section>
  );
}

function BackgroundSection() {
  const { api, vault, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apps = data.apps.filter((a) => !a.revokedAt && a.kind !== "extension" && a.kind !== "web");
  return (
    <section className="subpanel plate storage-background" aria-labelledby="storage-background">
      <PlateHead
        number="04"
        id="storage-background"
        title="While your vault is closed"
        lead="A connector you run with --watch can store a copy on the schedule above. Your storage is wrapped for that app's key only; it never holds your vault key, so its copies are not signed, and your device checks every part when it restores one."
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {apps.length === 0 ? (
        <Quiet>Connect an app under Apps first.</Quiet>
      ) : (
        <fieldset className="checkbox-list">
          <legend className="visually-hidden">Connectors that back up</legend>
          {apps.map((a) => {
            const on = data.backups.apps.includes(a.id);
            return (
              <label key={a.id} className="checkbox" htmlFor={`backup-app-${a.id}`}>
                <input
                  id={`backup-app-${a.id}`}
                  type="checkbox"
                  checked={on}
                  disabled={!!busy || (!on && data.backups.settings.targets.length === 0)}
                  onChange={async (e) => {
                    setBusy(a.id);
                    setError(null);
                    try {
                      await storage.setConnectorBackup(api, vault, data, a, e.target.checked);
                      await reload();
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
                <span>
                  {a.name} backs up while it watches
                  {!on && data.backups.settings.targets.length === 0 ? <span className="field-hint">Add storage first.</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}

function MoveSection() {
  const { api, vault, data, reload } = useVault();
  const [to, setTo] = useState("");
  const [days, setDays] = useState(MOVE_DEFAULT_DAYS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<nodes.StartedMove | null>(null);
  const open = data.nodes.moves.find((m) => m.state === "signed" || m.state === "sent");
  return (
    <section className="subpanel plate storage-move" aria-labelledby="storage-move">
      <PlateHead
        number="05"
        id="storage-move"
        title="Move to another node"
        lead="Any Sigil node, yours or someone's you trust. Your device signs the move with your vault key; this node keeps the bundle for the new node, which fetches it with the code you carry there."
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {started ? (
        <div className="subpanel move-started" data-testid="move-started">
          <p className="small">
            Signed. Open this link on the new node and sign in there with your recovery phrase or wallet. The code in it is the only way to fetch your vault; it is shown once.
          </p>
          <p className="mono small move-code" data-testid="move-url">
            {started.url}
          </p>
          <div className="row">
            <CopyButton text={started.url} label="Copy the link" />
            <a className="button button-small button-primary" href={started.url} data-testid="move-open">
              Open the new node
            </a>
          </div>
        </div>
      ) : null}
      {open && !started ? (
        <div className="subpanel move-open" data-testid="move-open-row">
          <p className="small">
            A move to {open.to} is under way ({open.state === "sent" ? "the new node fetched the bundle" : "waiting for the new node"}).
          </p>
          <button
            type="button"
            className="button button-small button-ghost"
            disabled={!!busy}
            onClick={async () => {
              setBusy("cancel");
              try {
                await nodes.cancelMove(api, open.id);
                await reload();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            Cancel the move
          </button>
        </div>
      ) : null}
      {!open && !started ? (
        <form
          className="move-form"
          aria-label="Move to another node"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy("move");
            setError(null);
            try {
              setStarted(await nodes.startMove(api, vault, data.nodes.here || window.location.origin, nodeOrigin(to), days));
              await reload();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <Band label="The new node" hint="This node sends your ask links, public page, packs and emergency card on to the new one for the time you choose, then deletes the vault here.">
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label" htmlFor="move-to">
                  Its address
                </label>
                <input id="move-to" className="input" type="url" inputMode="url" value={to} placeholder="https://" onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="move-days">
                  Send links on for
                </label>
                <select id="move-days" className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[7, 30, 90].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Band>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!!busy || !to.trim()}>
              {busy === "move" ? "Signing the move" : "Sign the move"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
