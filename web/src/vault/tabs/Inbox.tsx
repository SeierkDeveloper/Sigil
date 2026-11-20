"use client";

import { useEffect, useMemo, useState } from "react";
import { cosine, embeddingText, hybridSearch, type AppKind, type Memory } from "@sigil/core";
import { CheckIcon, CloseIcon, FolderIcon, InboxIcon, LockIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { AppMark, SourceMark } from "../marks";
import { Empty, Notice } from "../ui";
import { approveRequest, denyRequest, loadRequests, type AccessRequestView } from "../protectOps";
import { PROTECT_LABELS, APPROVAL_MINUTES } from "@sigil/core";

const NEW_FOLDER = "__new__";
const VIA: Record<string, string> = { mcp: "through the connector", extension: "from the browser extension", sdk: "from a signed-in web app", capture: "with quick capture" };

type Outcome = "approved" | "merged" | "updated" | "rejected";
const OUTCOME: Record<Outcome, string> = { approved: "Approved", merged: "Merged", updated: "Updated", rejected: "Rejected" };
/** How long the card shows what happened before it folds away. Nothing waits when motion is off. */
const LEAVE_MS = 720;
const motionOn = () => typeof document !== "undefined" && document.documentElement.dataset.motion === "on";

const HOW = [
  { title: "An app suggests", text: "An app you allow, or the browser extension, encrypts a suggestion for your vault and sends it." },
  { title: "It waits here", text: "The suggestion stays sealed in your inbox. The server holds it and cannot read it." },
  { title: "You decide", text: "Keep it as a new memory, merge it into one you have, or reject it. A changed Obsidian note can update the memory it came from." },
];

export function InboxTab() {
  const { data, goTo } = useVault();
  const appName = useMemo(() => new Map(data.apps.map((a) => [a.id, a.name])), [data.apps]);
  const appKind = useMemo(() => new Map(data.apps.map((a) => [a.id, a.kind])), [data.apps]);
  const allowed = data.apps.filter((a) => a.canPropose).length;

  return (
    <div className="inbox">
      <div className="panel-header">
        <h2 className="panel-title">Inbox</h2>
        <p className="small muted">
          Memories your apps suggest, and requests to read your protected folders. Suggestions were encrypted for this vault before they were sent, and none
          becomes a memory until you approve it.
        </p>
      </div>

      <AccessRequests />

      {data.proposals.length === 0 ? (
        <div className="inbox-empty">
          <Empty
            icon={<InboxIcon />}
            title="Nothing waiting"
            action={
              <button type="button" className="button" onClick={() => goTo("apps")}>
                {allowed ? "Manage apps" : "Let an app suggest memories"}
              </button>
            }
          >
            {allowed
              ? `${plural(allowed, "app")} may suggest memories. New suggestions appear here.`
              : "No app may suggest memories yet. Turn it on for an app under Apps, or pair the browser extension."}
          </Empty>
          <ol className="inbox-how" aria-label="How the inbox works">
            {HOW.map((h, i) => (
              <li key={h.title} className="inbox-how-step">
                <span className="inbox-how-number">{String(i + 1).padStart(2, "0")}</span>
                <p className="inbox-how-title">{h.title}</p>
                <p className="inbox-how-text">{h.text}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <>
          <div className="inbox-summary">
            <p className="inbox-summary-count" aria-live="polite">
              {plural(data.proposals.length, "suggestion")} waiting, newest first.
            </p>
            <p className="inbox-summary-note">
              <LockIcon /> Opened with your vault key, on this device
            </p>
          </div>
          <ul className="proposal-list">
            {data.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} appName={appName.get(p.appId)} appKind={appKind.get(p.appId)} captureKey={data.captureKeys.find((k) => k.id === p.appId)?.name} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProposalCard({ proposal, appName, appKind, captureKey }: { proposal: ops.ProposalView; appName?: string; appKind?: AppKind; captureKey?: string }) {
  const { api, vault, data, update, semantic } = useVault();
  const p = proposal.payload;
  const [title, setTitle] = useState(p?.title ?? "");
  const [body, setBody] = useState(p?.body ?? "");
  const [tags, setTags] = useState(p?.tags.join(", ") ?? "");
  const suggested = p?.folder ? data.folders.find((f) => f.name.toLowerCase() === p.folder!.toLowerCase()) : undefined;
  const writable = data.folders.filter((f) => f.kind !== "profile");
  const [folderId, setFolderId] = useState(suggested?.id ?? (p?.folder ? NEW_FOLDER : writable[0]?.id ?? ""));
  const synced = useMemo(() => ops.syncedTarget(data, proposal), [data, proposal]);
  const [mode, setMode] = useState<"new" | "merge" | "update">(synced ? "update" : "new");
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [nearby, setNearby] = useState<Memory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Outcome | null>(null);

  // Is this already in the vault? Same text, or (with search by meaning) the same thing in other words.
  const { embedQuery, vectors } = semantic;
  const same = useMemo(() => {
    if (!p) return null;
    const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    return data.memories.find((m) => flat(m.body) === flat(p.body) || (flat(m.title) === flat(p.title) && flat(m.body).includes(flat(p.body)))) ?? null;
  }, [p, data.memories]);
  useEffect(() => {
    if (!p || same) return;
    let alive = true;
    void embedQuery(embeddingText({ title: p.title, tags: p.tags, text: p.body })).then((q) => {
      if (!alive || !q) return;
      let best: { memory: Memory; sim: number } | null = null;
      for (const m of data.memories) {
        const v = vectors.get(m.id);
        if (!v) continue;
        const sim = cosine(q, v);
        if (!best || sim > best.sim) best = { memory: m, sim };
      }
      setNearby(best && best.sim >= 0.85 ? best.memory : null);
    });
    return () => {
      alive = false;
    };
  }, [p, same, data.memories, embedQuery, vectors]);
  const close: { memory: Memory; how: "same" | "meaning" } | null = same ? { memory: same, how: "same" } : nearby ? { memory: nearby, how: "meaning" } : null;

  const candidates = useMemo(() => {
    const pool = data.memories.filter((m) => m.source.kind !== "profile").map((m) => ({ ...m, text: m.body }));
    return hybridSearch(pool, mergeQuery, { limit: 6 }).map((h) => h.item);
  }, [data.memories, mergeQuery]);
  const target = mergeInto ?? close?.memory.id ?? null;
  const targetMemory = target ? data.memories.find((m) => m.id === target) : undefined;

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const removeProposal = (d: ops.VaultData) => ({ ...d, proposals: d.proposals.filter((x) => x.id !== proposal.id) });

  /** The work is done; the card shows what happened, folds away, and only then leaves the list. */
  const leave = (outcome: Outcome, apply: () => void) => {
    if (!motionOn()) return apply();
    setLeaving(outcome);
    window.setTimeout(apply, LEAVE_MS);
  };

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const approve = () =>
    act("approve", async () => {
      let folder = data.folders.find((f) => f.id === folderId);
      let created = false;
      if (folderId === NEW_FOLDER && p?.folder) {
        folder = await ops.addFolder(api, vault, p.folder);
        created = true;
      }
      if (!folder) throw new Error("Choose a folder.");
      const memory = await ops.approveProposal(api, folder, proposal, { title, body, tags: tagList }, appName ? { name: appName } : undefined);
      const f = folder;
      leave("approved", () => update((d) => ({ ...removeProposal(d), folders: created ? [...d.folders, f] : d.folders, memories: [memory, ...d.memories] })));
    });

  const merge = () =>
    act("merge", async () => {
      if (!targetMemory) throw new Error("Choose the memory to merge into.");
      const merged = await ops.mergeProposal(api, data.folders, proposal, { title, body, tags: tagList }, targetMemory, data.thinking.graceDays);
      leave("merged", () => update((d) => ({ ...removeProposal(d), memories: [merged, ...d.memories.filter((m) => m.id !== merged.id)] })));
    });

  const applyUpdate = () =>
    act("update", async () => {
      if (!synced) throw new Error("The memory this note was imported as is gone. Keep it as a new memory instead.");
      const next = await ops.updateFromProposal(api, data.folders, proposal, { title, body, tags: tagList }, synced, data.thinking.graceDays);
      leave("updated", () => update((d) => ({ ...removeProposal(d), memories: [next, ...d.memories.filter((m) => m.id !== next.id)] })));
    });

  const reject = () =>
    act("reject", async () => {
      await ops.rejectProposal(api, proposal.id);
      leave("rejected", () => update(removeProposal));
    });

  // Quick capture from a signed-in device, or a capture key named by the owner.
  const captured = proposal.appId === "capture" || captureKey !== undefined || proposal.payload?.via === "capture";
  const from = captureKey !== undefined ? `You, with ${captureKey}` : captured ? "You" : (appName ?? "A removed app");
  const folderHint = !p ? null : suggested ? suggested.name : p.folder ? `${p.folder} (new)` : null;
  return (
    <li className="proposal" data-testid="proposal" data-state={leaving ?? (busy ? "busy" : "idle")} data-close={synced ? "synced" : close?.how}>
      <div className="proposal-fold">
        <div className="proposal-card">
          {leaving ? (
            <div className="proposal-stamp" data-outcome={leaving} aria-hidden="true">
              <span className="proposal-stamp-mark">{leaving === "rejected" ? <CloseIcon /> : <CheckIcon />}</span>
              <span className="proposal-stamp-word">{OUTCOME[leaving]}</span>
            </div>
          ) : null}
          <div className="proposal-head">
            {captured ? <SourceMark kind="capture" className="proposal-mark" /> : <AppMark kind={appKind} className="proposal-mark" />}
            <div className="proposal-source">
              <p className="proposal-from">
                <strong>{from}</strong> {p ? VIA[p.via] : ""}, {formatDateTime(proposal.createdAt)}
              </p>
              {p?.url ? (
                <p className="proposal-url small">
                  From <span className="mono">{p.url}</span>
                </p>
              ) : null}
            </div>
            {p ? (
              <span className="badge proposal-sealed">
                <LockIcon /> Sealed for you
              </span>
            ) : null}
          </div>
          {error ? <Notice kind="error">{error}</Notice> : null}

          {!p ? (
            <>
              <Notice kind="error">This suggestion could not be opened with your vault key. It may have been damaged on the way. Reject it to remove it.</Notice>
              <div className="form-actions">
                <button type="button" className="button button-ghost" onClick={reject} disabled={!!busy}>
                  {busy === "reject" ? "Rejecting" : "Reject"}
                </button>
              </div>
            </>
          ) : (
            <div className="proposal-body">
              <div className="proposal-main">
                <div className="field">
                  <label className="field-label" htmlFor={`p-title-${proposal.id}`}>
                    Title
                  </label>
                  <input id={`p-title-${proposal.id}`} className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`p-body-${proposal.id}`}>
                    Memory
                  </label>
                  <textarea id={`p-body-${proposal.id}`} className="textarea" rows={Math.min(14, Math.max(4, body.split("\n").length + 1))} value={body} onChange={(e) => setBody(e.target.value)} />
                </div>
                {p.image ? (
                  <figure className="memory-photo">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a photo decrypted on this device, as a data: address */}
                    <img src={`data:${p.image.type};base64,${p.image.data}`} alt={`Photo with ${title || "this capture"}`} />
                    <figcaption className="small faint">Sealed on your device with the text, and kept with the memory when you approve it.</figcaption>
                  </figure>
                ) : null}
                <div className="field">
                  <label className="field-label" htmlFor={`p-tags-${proposal.id}`}>
                    Tags
                  </label>
                  <input id={`p-tags-${proposal.id}`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Separated by commas" />
                </div>

              </div>
              <div className="proposal-side">
                <ul className="proposal-facts" aria-label="About this suggestion">
                  <li className="proposal-fact">
                    <FolderIcon />
                    <span className="proposal-fact-label">{synced ? "Updates" : "Suggested folder"}</span>
                    <span className="proposal-fact-value">{synced ? synced.title : (folderHint ?? "None")}</span>
                  </li>
                  <li className="proposal-fact" data-kind={synced ? "synced" : close ? close.how : "new"}>
                    <span className="proposal-fact-diamond" aria-hidden="true" />
                    <span className="proposal-fact-label">In your vault</span>
                    <span className="proposal-fact-value">
                      {synced ? "Synced from Obsidian" : close ? (close.how === "same" ? "Already there" : "Something close") : "No copy found"}
                    </span>
                  </li>
                </ul>
                {synced ? (
                  <Notice>
                    A change to <span className="mono">{p.source?.ref}</span> in your Obsidian folder. Updating replaces the title, text and tags of{" "}
                    <strong>&quot;{synced.title}&quot;</strong>.
                  </Notice>
                ) : p.source?.ref ? (
                  <Notice>
                    A note from your Obsidian folder: <span className="mono">{p.source.ref}</span>.
                  </Notice>
                ) : null}
                {close && !synced ? (
                  <Notice>
                    {close.how === "same" ? "This is already in your vault as " : "This looks close to "}
                    <strong>&quot;{close.memory.title}&quot;</strong>. You can merge it in instead of keeping two.
                  </Notice>
                ) : null}
                <div className="segmented proposal-mode" role="group" aria-label="What to do with it" data-options={synced ? 3 : 2}>
                  {synced ? (
                    <button type="button" aria-pressed={mode === "update"} onClick={() => setMode("update")}>
                      Update the memory
                    </button>
                  ) : null}
                  <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>
                    Keep as a new memory
                  </button>
                  <button type="button" aria-pressed={mode === "merge"} onClick={() => setMode("merge")}>
                    Merge into a memory
                  </button>
                </div>

                {mode === "update" ? null : mode === "new" ? (
                  <div className="field">
                    <label className="field-label" htmlFor={`p-folder-${proposal.id}`}>
                      Folder
                    </label>
                    <select id={`p-folder-${proposal.id}`} className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                      {p.folder && !suggested ? <option value={NEW_FOLDER}>New folder: {p.folder}</option> : null}
                      {writable.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                          {suggested?.id === f.id ? " (suggested)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="field">
                    <label className="field-label" htmlFor={`p-merge-${proposal.id}`}>
                      Find the memory
                    </label>
                    <input id={`p-merge-${proposal.id}`} className="input" type="search" value={mergeQuery} onChange={(e) => setMergeQuery(e.target.value)} placeholder="Search your memories" />
                    <fieldset className="checkbox-list merge-targets">
                      <legend className="visually-hidden">Memory to merge into</legend>
                      {[...(targetMemory && !candidates.some((c) => c.id === targetMemory.id) ? [targetMemory] : []), ...candidates].map((m) => (
                        <label key={m.id} className="checkbox">
                          <input type="radio" name={`merge-${proposal.id}`} checked={target === m.id} onChange={() => setMergeInto(m.id)} />
                          <span>{m.title}</span>
                        </label>
                      ))}
                    </fieldset>
                    <span className="field-hint">The text is added to the end of that memory under today&apos;s date, and the tags are joined.</span>
                  </div>
                )}

                <div className="form-actions">
                  {mode === "update" ? (
                    <button type="button" className="button button-primary" onClick={applyUpdate} disabled={!!busy || !title.trim()}>
                      {busy === "update" ? "Updating" : "Update"}
                    </button>
                  ) : mode === "new" ? (
                    <button type="button" className="button button-primary" onClick={approve} disabled={!!busy || !title.trim() || !folderId}>
                      {busy === "approve" ? "Saving" : "Approve"}
                    </button>
                  ) : (
                    <button type="button" className="button button-primary" onClick={merge} disabled={!!busy || !targetMemory}>
                      {busy === "merge" ? "Merging" : "Merge"}
                    </button>
                  )}
                  <button type="button" className="button button-ghost" onClick={reject} disabled={!!busy}>
                    {busy === "reject" ? "Rejecting" : "Reject"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- reads of protected folders

function requesterName(data: ReturnType<typeof useVault>["data"], r: AccessRequestView): string {
  if (r.requesterKind === "app") return data.apps.find((a) => a.id === r.requester)?.name ?? "A removed app";
  if (r.requesterKind === "link") return `Your AI self, for the link "${data.askLinks.find((l) => l.id === r.requester)?.label ?? "a deleted link"}"`;
  if (r.requesterKind === "meet") {
    const m = data.meets.find((x) => x.id === r.requester);
    return `Your AI self, talking with ${m?.record?.label ?? m?.peerName ?? "another self"}`;
  }
  if (r.requesterKind === "public") return "Your public AI self";
  return "Your test chat";
}

/** Requests to read a protected folder: each needs a fresh yes, which lasts a few minutes and covers one read. */
function AccessRequests() {
  const { api, data, update } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = data.access.filter((r) => r.state === "pending");

  // New requests arrive while the vault is open; look again now and then.
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(() => {
      loadRequests(api)
        .then((access) => alive && update((d) => ({ ...d, access })))
        .catch(() => undefined);
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, update]);

  if (pending.length === 0) return null;
  const answer = async (r: AccessRequestView, yes: boolean) => {
    setBusy(r.id);
    setError(null);
    try {
      const next = yes ? await approveRequest(api, r.id) : await denyRequest(api, r.id);
      update((d) => ({ ...d, access: d.access.map((x) => (x.id === r.id ? next : x)) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel access-requests" aria-labelledby="access-title" data-testid="access-requests">
      <h3 id="access-title" className="settings-heading">
        <LockIcon /> {plural(pending.length, "request")} to read a protected folder
      </h3>
      <p className="small muted">A yes covers this one read and lasts {APPROVAL_MINUTES} minutes. Both your answer and the read go into your read log.</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="list">
        {pending.map((r) => {
          const folder = data.folders.find((f) => f.id === r.folderId);
          const titles = r.memoryIds.map((id) => data.memories.find((m) => m.id === id)?.title).filter(Boolean) as string[];
          return (
            <li key={r.id} className="list-row access-row" data-testid="access-row">
              <div className="list-row-main">
                <p className="list-row-title">
                  {requesterName(data, r)} asks to read {folder ? folder.name : "a protected folder"}
                  {folder?.protect ? <span className="badge">{PROTECT_LABELS[folder.protect]}</span> : null}
                </p>
                <p className="list-row-meta">
                  {r.scope === "index"
                    ? "To look through the titles and first lines of what the folder holds."
                    : titles.length
                      ? `To read ${titles.map((t) => `"${t}"`).join(", ")}.`
                      : `To read ${plural(r.memoryIds.length, "memory", "memories")}.`}{" "}
                  Asked {formatDateTime(r.createdAt)}.
                </p>
              </div>
              <div className="list-row-actions">
                <button type="button" className="button button-small button-primary" disabled={busy === r.id} onClick={() => void answer(r, true)}>
                  Allow this read
                </button>
                <button type="button" className="button button-small button-ghost" disabled={busy === r.id} onClick={() => void answer(r, false)}>
                  Say no
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
