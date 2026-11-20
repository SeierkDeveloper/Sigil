"use client";

import { useEffect, useMemo, useState } from "react";
import { cosine, embeddingText, hybridSearch, type Memory } from "@sigil/core";
import { InboxIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Empty, Notice } from "../ui";

const NEW_FOLDER = "__new__";
const VIA: Record<string, string> = { mcp: "through the connector", extension: "from the browser extension", sdk: "from a signed-in web app" };

export function InboxTab() {
  const { data, goTo } = useVault();
  const appName = useMemo(() => new Map(data.apps.map((a) => [a.id, a.name])), [data.apps]);
  const allowed = data.apps.filter((a) => a.canPropose).length;

  return (
    <div className="inbox">
      <div className="panel-header">
        <h2 className="panel-title">Inbox</h2>
        <p className="small muted">
          Memories your apps suggest. Each was encrypted for this vault before it was sent, and none becomes a memory until you approve it.
        </p>
      </div>

      {data.proposals.length === 0 ? (
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
      ) : (
        <>
          <p className="small faint" aria-live="polite">
            {plural(data.proposals.length, "suggestion")} waiting, newest first.
          </p>
          <ul className="proposal-list">
            {data.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} appName={appName.get(p.appId)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProposalCard({ proposal, appName }: { proposal: ops.ProposalView; appName?: string }) {
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
      update((d) => ({ ...removeProposal(d), folders: created ? [...d.folders, f] : d.folders, memories: [memory, ...d.memories] }));
    });

  const merge = () =>
    act("merge", async () => {
      if (!targetMemory) throw new Error("Choose the memory to merge into.");
      const merged = await ops.mergeProposal(api, data.folders, proposal, { title, body, tags: tagList }, targetMemory, data.thinking.graceDays);
      update((d) => ({ ...removeProposal(d), memories: [merged, ...d.memories.filter((m) => m.id !== merged.id)] }));
    });

  const applyUpdate = () =>
    act("update", async () => {
      if (!synced) throw new Error("The memory this note was imported as is gone. Keep it as a new memory instead.");
      const next = await ops.updateFromProposal(api, data.folders, proposal, { title, body, tags: tagList }, synced, data.thinking.graceDays);
      update((d) => ({ ...removeProposal(d), memories: [next, ...d.memories.filter((m) => m.id !== next.id)] }));
    });

  const reject = () =>
    act("reject", async () => {
      await ops.rejectProposal(api, proposal.id);
      update(removeProposal);
    });

  const from = appName ?? "A removed app";
  return (
    <li className="proposal" data-testid="proposal">
      <div className="proposal-head">
        <p className="proposal-from">
          <strong>{from}</strong> {p ? VIA[p.via] : ""}, {formatDateTime(proposal.createdAt)}
        </p>
        {p?.url ? (
          <p className="proposal-url small">
            From <span className="mono">{p.url}</span>
          </p>
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
        <>
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
          <div className="field">
            <label className="field-label" htmlFor={`p-tags-${proposal.id}`}>
              Tags
            </label>
            <input id={`p-tags-${proposal.id}`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Separated by commas" />
          </div>

          <div className="segmented proposal-mode" role="group" aria-label="What to do with it">
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
        </>
      )}
    </li>
  );
}
