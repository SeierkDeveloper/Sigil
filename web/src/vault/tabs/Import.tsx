"use client";

import { useEffect, useRef, useState } from "react";
import {
  dedupeDrafts,
  importGithub,
  parseAppleNotes,
  parseExport,
  parseNotionExport,
  parseObsidianVault,
  parseTakeout,
  type ImportFile,
  type MemoryDraft,
} from "@sigil/core";
import { ImportIcon } from "@/components/icons";
import { formatBytes, plural } from "@/lib/format";
import { takePendingImport } from "@/lib/pendingImport";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Notice } from "../ui";

type SourceId = "chat" | "obsidian" | "apple-notes" | "takeout" | "notion" | "github";

interface Source {
  id: SourceId;
  title: string;
  text: string;
  /** What the picker takes. */
  accept: string;
  folder: boolean;
  multiple: boolean;
  how: string;
}

const SOURCES: Source[] = [
  {
    id: "chat",
    title: "ChatGPT or Claude",
    text: "Your conversations, projects and what the app remembered.",
    accept: ".zip,.json,application/zip,application/json",
    folder: false,
    multiple: false,
    how: "ChatGPT: Settings, Data controls, Export data. Claude: Settings, Privacy, Export data. Choose the zip from the email, or the conversations.json inside it.",
  },
  {
    id: "obsidian",
    title: "Obsidian",
    text: "Every note in a vault, with its tags. The connector can keep it in sync.",
    accept: ".md,.zip",
    folder: true,
    multiple: true,
    how: "Choose the folder of your Obsidian vault. Its settings folder and attachments are left out.",
  },
  {
    id: "apple-notes",
    title: "Apple Notes",
    text: "Notes from your iCloud data copy, or notes exported as files.",
    accept: ".zip,.txt,.md,.html,.htm",
    folder: true,
    multiple: true,
    how: "Ask for a copy of your iCloud data, choose iCloud Notes, and pick the zip or the unpacked Notes folder. Notes exported as text, Markdown or HTML files work too.",
  },
  {
    id: "takeout",
    title: "Gmail and Google Calendar",
    text: "One memory per mail thread and per calendar event, from Google Takeout.",
    accept: ".zip,.mbox,.ics",
    folder: false,
    multiple: true,
    how: "In Google Takeout choose Mail and Calendar, then pick the zip, or the .mbox and .ics files inside it. Spam and trash are left out; long threads are shortened.",
  },
  {
    id: "notion",
    title: "Notion",
    text: "Every page of a workspace, from its Markdown export.",
    accept: ".zip,.md",
    folder: false,
    multiple: true,
    how: "In Notion: Settings, Export all workspace content, Markdown and CSV. Choose the zip. Databases are left out.",
  },
  {
    id: "github",
    title: "GitHub",
    text: "A repository's commit history, or your recent activity, one memory per day.",
    accept: "",
    folder: false,
    multiple: false,
    how: "Asked from this browser straight from GitHub. A token is needed only for private repositories or more requests; it is used for this import and never saved.",
  },
];

const MAX_BYTES = 1024 * 1024 * 1024;

interface Ready {
  label: string;
  sourceTitle: string;
  found: number;
  fresh: MemoryDraft[];
  duplicates: number;
  skipped: number;
  notes: string[];
  from: SourceId;
}

type Step = { kind: "idle" } | { kind: "reading"; name: string } | ({ kind: "ready" } & Ready) | { kind: "saving"; done: number; total: number } | { kind: "done"; count: number; folder: string; source: SourceId };

const NEW = "__new__";

async function toImportFiles(files: File[], stripRoot: boolean): Promise<ImportFile[]> {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) throw new Error(`These files are ${formatBytes(total)}. A browser can read up to ${formatBytes(MAX_BYTES)} at once; import a smaller part.`);
  return Promise.all(
    files.map(async (f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      // A picked folder's own name is not part of the note's path.
      const path = stripRoot && rel.includes("/") ? rel.split("/").slice(1).join("/") : rel;
      return { path, bytes: new Uint8Array(await f.arrayBuffer()), modified: new Date(f.lastModified).toISOString() };
    }),
  );
}

export function ImportTab() {
  const { api, vault, data, update, goTo } = useVault();
  const [source, setSource] = useState<SourceId>("chat");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState(NEW);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const current = SOURCES.find((s) => s.id === source)!;

  const prepare = (kind: SourceId, label: string, title: string, drafts: MemoryDraft[], skipped: number, notes: string[]) => {
    const { fresh, duplicates } = dedupeDrafts(drafts, data.memories);
    const existing = data.folders.find((f) => f.name.toLowerCase() === label.toLowerCase());
    setTarget(existing ? existing.id : NEW);
    setStep({ kind: "ready", label, sourceTitle: title, found: drafts.length, fresh, duplicates, skipped, notes, from: kind });
  };

  const read = async (files: File[], fromFolder: boolean) => {
    if (!files.length) return;
    setError(null);
    setStep({ kind: "reading", name: files.length === 1 ? files[0].name : plural(files.length, "file") });
    try {
      if (source === "chat") {
        const f = files[0];
        const r = parseExport(f.name, new Uint8Array(await f.arrayBuffer()));
        const label = r.source === "chatgpt" ? "ChatGPT" : "Claude";
        prepare("chat", label, `${label} export`, r.drafts, r.skipped, []);
        return;
      }
      const picked = await toImportFiles(files, fromFolder);
      const r =
        source === "obsidian"
          ? parseObsidianVault(picked)
          : source === "apple-notes"
            ? parseAppleNotes(picked)
            : source === "takeout"
              ? parseTakeout(picked)
              : parseNotionExport(picked);
      prepare(source, r.label, current.title, r.drafts, r.skipped, r.notes);
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: "idle" });
    } finally {
      if (input.current) input.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  // A file dropped on the Import page comes in here once the vault is open.
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    const waiting = takePendingImport();
    if (waiting) void readRef.current([waiting], false);
  }, []);

  const save = async () => {
    if (step.kind !== "ready") return;
    const drafts = step.fresh;
    const label = step.label;
    const from = step.from;
    setError(null);
    setStep({ kind: "saving", done: 0, total: drafts.length });
    try {
      let folder = data.folders.find((f) => f.id === target);
      if (!folder) {
        folder = (await ops.findOrCreateFolder(api, vault, data.folders, label)).folder;
        const made = folder;
        update((d) => (d.folders.some((f) => f.id === made.id) ? d : { ...d, folders: [...d.folders, made] }));
      }
      const saved = await ops.importDrafts(api, folder, drafts, (done, total) => setStep({ kind: "saving", done, total }));
      update((d) => ({ ...d, memories: [...saved, ...d.memories].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1)) }));
      setStep({ kind: "done", count: saved.length, folder: folder.name, source: from });
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: "idle" });
    }
  };

  return (
    <div className="import">
      <div className="panel-header">
        <h2 className="panel-title">Import your history</h2>
        <p className="small muted">Files are opened, read and encrypted in this browser. Only the encrypted memories reach the server. Nothing needs an app&apos;s approval.</p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {step.kind === "idle" || step.kind === "reading" ? (
        <>
          <div className="import-sources" role="radiogroup" aria-label="Where from">
            {SOURCES.map((s) => (
              <label key={s.id} className="import-source" data-selected={s.id === source ? "true" : "false"}>
                <input type="radio" name="import-source" value={s.id} checked={s.id === source} onChange={() => setSource(s.id)} disabled={step.kind === "reading"} />
                <span className="import-source-title">{s.title}</span>
                <span className="import-source-text">{s.text}</span>
              </label>
            ))}
          </div>

          {source === "github" ? (
            <GithubForm
              busy={step.kind === "reading"}
              onRead={async (req) => {
                setError(null);
                setStep({ kind: "reading", name: req.target });
                try {
                  const r = await importGithub(req);
                  prepare("github", r.label, req.mode === "repo" ? `GitHub, ${req.target}` : `GitHub activity of ${req.target}`, r.drafts, r.skipped, r.notes);
                } catch (err) {
                  setError(errorText(err));
                  setStep({ kind: "idle" });
                }
              }}
            />
          ) : (
            <label
              className="dropzone"
              data-dragging={dragging ? "true" : "false"}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void read(Array.from(e.dataTransfer.files ?? []), false);
              }}
            >
              <ImportIcon className="empty-state-icon" />
              <span className="empty-state-title">{step.kind === "reading" ? `Reading ${step.name}` : `Drop your ${current.title} files here`}</span>
              <span className="empty-state-text">{current.how}</span>
              <span className="row">
                <span className="button button-small">{current.multiple ? "Choose files" : "Choose a file"}</span>
                {current.folder ? (
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    onClick={(e) => {
                      e.preventDefault();
                      folderInput.current?.click();
                    }}
                  >
                    Choose a folder
                  </button>
                ) : null}
              </span>
              <input
                ref={input}
                type="file"
                accept={current.accept}
                multiple={current.multiple}
                data-testid="import-file"
                onChange={(e) => void read(Array.from(e.target.files ?? []), false)}
                disabled={step.kind === "reading"}
              />
            </label>
          )}
          {current.folder ? (
            <input
              ref={folderInput}
              className="visually-hidden"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              data-testid="import-folder"
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(e) => void read(Array.from(e.target.files ?? []), true)}
            />
          ) : null}
        </>
      ) : null}

      {step.kind === "ready" ? (
        <div className="subpanel" data-testid="import-preview">
          <h3 className="card-title">
            {step.sourceTitle}: {plural(step.found, "item")} found
          </h3>
          <p className="small muted">
            {step.fresh.length > 0 ? `${plural(step.fresh.length, "new memory", "new memories")} to import.` : "Everything in this file is already in your vault."}
            {step.duplicates > 0 ? ` ${plural(step.duplicates, "item")} already in your vault will be skipped.` : ""}
            {step.skipped > 0 ? ` ${plural(step.skipped, "empty or left-out item")} not counted.` : ""}
          </p>
          {step.notes.map((n) => (
            <p key={n} className="small faint">
              {n}
            </p>
          ))}
          {step.fresh.length > 0 ? (
            <>
              <ul className="import-sample" aria-label="First items">
                {step.fresh.slice(0, 5).map((d, i) => (
                  <li key={i}>
                    <span className="import-sample-title">{d.title}</span>
                    <span className="faint small"> {d.body.replace(/\s+/g, " ").slice(0, 90)}</span>
                  </li>
                ))}
              </ul>
              {step.fresh.length > 5 ? <p className="small faint">And {plural(step.fresh.length - 5, "more")}.</p> : null}
              <div className="field">
                <label className="field-label" htmlFor="import-folder-choice">
                  Save into
                </label>
                <select id="import-folder-choice" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {!data.folders.some((f) => f.name.toLowerCase() === step.label.toLowerCase()) ? <option value={NEW}>A new folder called {step.label}</option> : null}
                  {data.folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
          <div className="form-actions">
            {step.fresh.length > 0 ? (
              <button type="button" className="button button-primary" onClick={() => void save()}>
                Import {plural(step.fresh.length, "memory", "memories")}
              </button>
            ) : null}
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: "idle" })}>
              Choose something else
            </button>
          </div>
        </div>
      ) : null}

      {step.kind === "saving" ? (
        <div className="subpanel" role="status">
          <p className="small">
            Encrypting and saving {step.done.toLocaleString("en-US")} of {step.total.toLocaleString("en-US")}
          </p>
          <div className="progress" aria-hidden="true">
            <div className="progress-bar" style={{ width: `${step.total ? Math.round((step.done / step.total) * 100) : 0}%` }} />
          </div>
        </div>
      ) : null}

      {step.kind === "done" ? (
        <div className="subpanel" data-testid="import-done">
          <p>
            Imported {plural(step.count, "memory", "memories")} into {step.folder}.
          </p>
          {step.source === "obsidian" ? (
            <p className="small muted">
              To keep it in sync, run the connector with <span className="mono">--watch</span> and the path of your Obsidian folder, using an app key that may read{" "}
              {step.folder} and suggest memories. New and changed notes then wait in your inbox for your approval.
            </p>
          ) : null}
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => goTo("memories")}>
              See memories
            </button>
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: "idle" })}>
              Import something else
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GithubForm({ busy, onRead }: { busy: boolean; onRead(req: { mode: "repo" | "user"; target: string; token?: string }): Promise<void> }) {
  const [mode, setMode] = useState<"repo" | "user">("repo");
  const [target, setTarget] = useState("");
  const [token, setToken] = useState("");
  return (
    <form
      className="subpanel github-form"
      aria-label="GitHub"
      onSubmit={(e) => {
        e.preventDefault();
        void onRead({ mode, target: target.trim(), token: token.trim() || undefined }).then(() => setToken(""));
      }}
    >
      <div className="segmented" role="group" aria-label="What to import">
        <button type="button" aria-pressed={mode === "repo"} onClick={() => setMode("repo")}>
          A repository&apos;s history
        </button>
        <button type="button" aria-pressed={mode === "user"} onClick={() => setMode("user")}>
          My recent activity
        </button>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor="github-target">
            {mode === "repo" ? "Repository" : "GitHub user name"}
          </label>
          <input
            id="github-target"
            className="input mono"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={mode === "repo" ? "owner/name" : "user name"}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="github-token">
            Token, if needed
          </label>
          <input id="github-token" className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
          <span className="field-hint">Used for this import only, from this browser. Never saved and never sent to Sigil.</span>
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !target.trim()}>
          {busy ? "Asking GitHub" : "Read from GitHub"}
        </button>
      </div>
    </form>
  );
}
