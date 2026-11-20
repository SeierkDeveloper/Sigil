"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { hybridSearch, sourceLabel, tokenize, type MatchKind, type Memory } from "@sigil/core";
import { DeviceIcon, PlusIcon, SearchIcon, ImportIcon } from "@/components/icons";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import type { SemanticStatus } from "../semantic";
import { Empty, Notice } from "../ui";
import { Duplicates } from "./Duplicates";

const PAGE = 50;

/** A memory as the list shows it: one of yours, or one from a folder shared with you (read only). */
export interface ListedMemory extends Memory {
  sharedFrom?: string;
}

function semanticLine(s: SemanticStatus): string {
  switch (s.state) {
    case "off":
      return "Search by words.";
    case "loading":
      return "Starting search by meaning on this device.";
    case "indexing":
      return `Search by meaning is reading your memories on this device: ${s.done} of ${s.total}.`;
    case "ready":
      return "Search by words and by meaning, on this device.";
    case "failed":
      return "Search by words. Search by meaning is not available here.";
  }
}

const startsWithTerm = (word: string, terms: string[]) => {
  const t = tokenize(word)[0];
  return !!t && terms.some((term) => t.startsWith(term));
};

/** The same text with the words the search matched set apart. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {text.split(/([\p{L}\p{N}]+)/u).map((part, i) => (i % 2 && startsWithTerm(part, terms) ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/** Where the words of the search were found in a memory, in plain words. */
function wordPlaces(m: Memory, terms: string[]): string {
  const has = (text: string) => tokenize(text).some((t) => terms.some((term) => t.startsWith(term)));
  const places = [has(m.title) ? "title" : "", m.tags.some(has) ? "tags" : "", has(m.body) ? "text" : ""].filter(Boolean);
  if (places.length === 0) return "";
  return `Words in the ${places.length <= 1 ? places.join("") : `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`}`;
}

/** How full the closeness meter is: empty at the lowest match there is, full at the same meaning. */
const meterWidth = (similarity: number) => `${Math.round(Math.min(1, Math.max(0.08, (similarity - 0.3) / 0.7)) * 100)}%`;

export function MemoriesTab() {
  const { data, goTo, focus, semantic } = useVault();
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("all");
  const [selected, setSelected] = useState<string | "new" | null>(focus);
  const [shown, setShown] = useState(PAGE);
  const [tidy, setTidy] = useState(false);
  const [queryVector, setQueryVector] = useState<{ query: string; vector: Float32Array | null } | null>(null);

  // Embed the query on this device once typing pauses.
  const { embedQuery } = semantic;
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let alive = true;
    const t = window.setTimeout(() => {
      void embedQuery(q).then((vector) => alive && setQueryVector({ query: q, vector }));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query, embedQuery]);

  const shared = useMemo<ListedMemory[]>(
    () => data.shares.incoming.filter((s) => s.acceptedAt && s.folder).flatMap((s) => s.memories.map((m) => ({ ...m, sharedFrom: s.from || "another vault" }))),
    [data.shares.incoming],
  );
  const folderName = useMemo(
    () => new Map([...data.folders.map((f) => [f.id, f.name] as const), ...data.shares.incoming.filter((s) => s.folder).map((s) => [s.folderId, s.folder!.name] as const)]),
    [data.folders, data.shares.incoming],
  );
  const all = useMemo<ListedMemory[]>(() => [...data.memories, ...shared], [data.memories, shared]);
  const results = useMemo(() => {
    const pool = folder === "all" ? all : all.filter((m) => m.folderId === folder);
    const vector = queryVector && queryVector.query === query.trim() ? queryVector.vector : null;
    return hybridSearch(
      pool.map((m) => ({ ...m, text: m.body })),
      query,
      { queryVector: vector, vectors: semantic.vectors },
    );
  }, [all, folder, query, queryVector, semantic.vectors]);

  const current = selected && selected !== "new" ? all.find((m) => m.id === selected) ?? null : null;
  const terms = useMemo(() => [...new Set(tokenize(query))], [query]);

  if (all.length === 0 && selected !== "new") {
    return (
      <Empty
        icon={<ImportIcon />}
        title="Your vault is empty"
        action={
          <div className="row">
            <button type="button" className="button button-primary" onClick={() => setSelected("new")}>
              <PlusIcon /> Write a memory
            </button>
            <button type="button" className="button" onClick={() => goTo("import")}>
              Import ChatGPT or Claude
            </button>
          </div>
        }
      >
        Write your first memory, or bring in your ChatGPT or Claude history. Everything is encrypted on this device before it is saved.
      </Empty>
    );
  }

  return (
    <div className="memories">
      <div className="toolbar">
        <div className="search">
          <SearchIcon />
          <label className="visually-hidden" htmlFor="memory-search">
            Search memories
          </label>
          <input
            id="memory-search"
            className="input"
            type="search"
            placeholder="Search by words or by meaning"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        </div>
        <label className="visually-hidden" htmlFor="memory-folder">
          Folder
        </label>
        <select
          id="memory-folder"
          className="select"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setShown(PAGE);
          }}
        >
          <option value="all">All folders</option>
          {data.folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          {data.shares.incoming
            .filter((s) => s.acceptedAt && s.folder)
            .map((s) => (
              <option key={s.id} value={s.folderId}>
                Shared: {s.folder!.name}
              </option>
            ))}
        </select>
        <button type="button" className="button" onClick={() => setTidy((t) => !t)} aria-expanded={tidy}>
          {tidy ? "Hide duplicates" : "Find duplicates"}
        </button>
        <button type="button" className="button button-primary" onClick={() => setSelected("new")}>
          <PlusIcon /> New memory
        </button>
      </div>
      <p className="small faint search-mode" data-state={semantic.status.state}>
        <DeviceIcon />
        <span>{semanticLine(semantic.status)}</span>
        {semantic.status.state === "indexing" && semantic.status.total > 0 ? (
          <span className="search-mode-bar" aria-hidden="true">
            <span style={{ width: `${Math.round((semantic.status.done / semantic.status.total) * 100)}%` }} />
          </span>
        ) : null}
      </p>

      {tidy ? <Duplicates onOpen={(id) => setSelected(id)} /> : null}

      <div className="memory-layout">
        <div>
          {results.length === 0 ? (
            <Empty title="Nothing matches">Try other words, or search all folders.</Empty>
          ) : (
            <>
              <p className="small faint" aria-live="polite">
                {query.trim() ? `${results.length} found` : `${plural(results.length, "memory", "memories")}, newest first`}
              </p>
              <ul className="memory-list">
                {results.slice(0, shown).map(({ item: m, match, similarity }) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="memory-item"
                      data-match={query.trim() ? match : undefined}
                      aria-current={selected === m.id ? "true" : undefined}
                      onClick={() => setSelected(m.id)}
                    >
                      <span className="memory-item-title">
                        <Marked text={m.title} terms={match === "meaning" ? [] : terms} />
                      </span>
                      <span className="memory-item-meta">
                        <span>{folderName.get(m.folderId)}</span>
                        <span>{formatDate(m.editedAt)}</span>
                        {m.sharedFrom ? <span className="chip">Shared by {m.sharedFrom}</span> : null}
                        {m.tags.slice(0, 3).map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </span>
                      <span className="memory-item-snippet">
                        <Marked text={m.snippet} terms={match === "meaning" ? [] : terms} />
                      </span>
                      {terms.length ? (
                        <span className="memory-item-why">
                          {match !== "words" ? <span className="chip chip-strong">{matchLabel(match)}</span> : null}
                          {match !== "meaning" && wordPlaces(m, terms) ? <span className="why-words">{wordPlaces(m, terms)}</span> : null}
                          {match !== "words" && similarity !== null ? (
                            <span className="why-meaning">
                              <span className="why-meter" aria-hidden="true">
                                <span style={{ width: meterWidth(similarity) }} />
                              </span>
                              Closeness {similarity.toFixed(2)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              {results.length > shown ? (
                <div className="form-actions">
                  <button type="button" className="button button-small" onClick={() => setShown((n) => n + PAGE)}>
                    Show more ({results.length - shown} left)
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div>
          {selected === "new" ? (
            <Editor
              key="new"
              memory={null}
              defaultFolder={folder !== "all" && data.folders.some((f) => f.id === folder) ? folder : data.folders[0]?.id}
              onClose={(id) => setSelected(id ?? null)}
            />
          ) : current?.sharedFrom ? (
            <SharedView key={current.id} memory={current} folder={folderName.get(current.folderId) ?? ""} onClose={() => setSelected(null)} />
          ) : current ? (
            <Editor key={current.id} memory={current} defaultFolder={current.folderId} onClose={(id) => setSelected(id ?? null)} />
          ) : (
            <div className="editor editor-idle">
              <p className="muted small">Choose a memory to read or edit it, or write a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function matchLabel(match: MatchKind): string {
  return match === "meaning" ? "By meaning" : "Words and meaning";
}

function SharedView({ memory, folder, onClose }: { memory: ListedMemory; folder: string; onClose(): void }) {
  return (
    <article className="editor editor-readonly" aria-label="Shared memory">
      <h3 className="editor-title">{memory.title}</h3>
      <p className="editor-meta">
        In {folder}, shared with you by {memory.sharedFrom}. Read only. Edited {formatDateTime(memory.editedAt)}.
      </p>
      {memory.tags.length ? (
        <div className="chips">
          {memory.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="editor-body">{memory.body}</div>
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </article>
  );
}

function Editor({ memory, defaultFolder, onClose }: { memory: Memory | null; defaultFolder?: string; onClose(id?: string): void }) {
  const { api, data, update, goTo } = useVault();
  const [title, setTitle] = useState(memory?.title ?? "");
  const [body, setBody] = useState(memory?.body ?? "");
  const [tags, setTags] = useState(memory?.tags.join(", ") ?? "");
  const [folderId, setFolderId] = useState(memory?.folderId ?? defaultFolder ?? data.folders[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  // On narrow screens the editor sits below the list; bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) form.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const dirty = !memory || title !== memory.title || body !== memory.body || tags !== memory.tags.join(", ") || folderId !== memory.folderId;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const folder = data.folders.find((f) => f.id === folderId);
      if (!folder) throw new Error("Choose a folder.");
      const saved = memory
        ? await ops.updateMemory(api, data.folders, memory, { title, body, tags: tagList, folderId })
        : await ops.createMemory(api, folder, { title, body, tags: tagList });
      update((d) => ({ ...d, memories: [saved, ...d.memories.filter((m) => m.id !== saved.id)] }));
      onClose(saved.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!memory) return;
    setBusy(true);
    setError(null);
    try {
      await ops.deleteMemories(api, [memory.id]);
      update((d) => ({ ...d, memories: d.memories.filter((m) => m.id !== memory.id) }));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form ref={form} className="editor" onSubmit={save} aria-label={memory ? "Edit memory" : "New memory"}>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="field">
        <label className="field-label" htmlFor="m-title">
          Title
        </label>
        <input id="m-title" className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="m-body">
          Memory
        </label>
        <textarea id="m-body" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={12} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor="m-folder">
            Folder
          </label>
          <select id="m-folder" className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            {data.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="m-tags">
            Tags
          </label>
          <input id="m-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Separated by commas" />
        </div>
      </div>
      {memory ? (
        <p className="editor-meta">
          {sourceLabel(memory.source)}
          {memory.source.kind === "web" && memory.source.ref ? `: ${memory.source.ref}` : ""}. Created {formatDateTime(memory.createdAt)}, edited{" "}
          {formatDateTime(memory.editedAt)}.
        </p>
      ) : null}
      {memory?.source.kind === "profile" ? (
        <Notice>
          This is your Self card.{" "}
          <button type="button" className="text-button" onClick={() => goTo("profile")}>
            Edit it in the Self card tab
          </button>{" "}
          to keep its three parts in order.
        </Notice>
      ) : null}

      {confirmDelete ? (
        <div className="subpanel">
          <p className="small">Delete this memory for good? It is removed from the server, and connected apps can no longer read it.</p>
          <div className="row">
            <button type="button" className="button button-danger button-small" onClick={remove} disabled={busy}>
              Delete memory
            </button>
            <button type="button" className="button button-ghost button-small" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy || !dirty || !title.trim()}>
            {busy ? "Saving" : memory ? "Save changes" : "Save memory"}
          </button>
          <button type="button" className="button button-ghost" onClick={() => onClose()} disabled={busy}>
            {memory ? "Close" : "Cancel"}
          </button>
          {memory ? (
            <button type="button" className="button button-ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </button>
          ) : null}
        </div>
      )}
    </form>
  );
}
