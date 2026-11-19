"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { search, type Memory } from "@sigil/core";
import { PlusIcon, SearchIcon, ImportIcon } from "@/components/icons";
import { formatDate, formatDateTime } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Empty, Notice } from "../ui";

const PAGE = 50;

const SOURCE_LABEL: Record<string, string> = { note: "Written in Sigil", chatgpt: "Imported from ChatGPT", claude: "Imported from Claude" };

export function MemoriesTab() {
  const { data, goTo } = useVault();
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("all");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [shown, setShown] = useState(PAGE);

  const folderName = useMemo(() => new Map(data.folders.map((f) => [f.id, f.name])), [data.folders]);
  const results = useMemo(() => {
    const pool = folder === "all" ? data.memories : data.memories.filter((m) => m.folderId === folder);
    return search(
      pool.map((m) => ({ ...m, text: m.body })),
      query,
    ).map((h) => h.item);
  }, [data.memories, folder, query]);

  const current = selected && selected !== "new" ? data.memories.find((m) => m.id === selected) ?? null : null;

  if (data.memories.length === 0 && selected !== "new") {
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
            placeholder="Search titles, tags and text"
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
        </select>
        <button type="button" className="button button-primary" onClick={() => setSelected("new")}>
          <PlusIcon /> New memory
        </button>
      </div>

      <div className="memory-layout">
        <div>
          {results.length === 0 ? (
            <Empty title="Nothing matches">Try other words, or search all folders.</Empty>
          ) : (
            <>
              <p className="small faint" aria-live="polite">
                {query.trim() ? `${results.length} found` : `${results.length} ${results.length === 1 ? "memory" : "memories"}, newest first`}
              </p>
              <ul className="memory-list">
                {results.slice(0, shown).map((m) => (
                  <li key={m.id}>
                    <button type="button" className="memory-item" aria-current={selected === m.id ? "true" : undefined} onClick={() => setSelected(m.id)}>
                      <span className="memory-item-title">{m.title}</span>
                      <span className="memory-item-meta">
                        <span>{folderName.get(m.folderId)}</span>
                        <span>{formatDate(m.editedAt)}</span>
                        {m.tags.slice(0, 3).map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </span>
                      <span className="memory-item-snippet">{m.snippet}</span>
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
            <Editor key="new" memory={null} defaultFolder={folder !== "all" ? folder : data.folders[0]?.id} onClose={(id) => setSelected(id ?? null)} />
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

function Editor({ memory, defaultFolder, onClose }: { memory: Memory | null; defaultFolder?: string; onClose(id?: string): void }) {
  const { api, data, update } = useVault();
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
          {SOURCE_LABEL[memory.source.kind] ?? "Saved"}. Created {formatDateTime(memory.createdAt)}, edited {formatDateTime(memory.editedAt)}.
        </p>
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
