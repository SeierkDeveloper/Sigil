"use client";

import { useRef, useState } from "react";
import { parseExport, type ImportResult } from "@sigil/core";
import { ImportIcon } from "@/components/icons";
import { plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Notice } from "../ui";

type Step =
  | { kind: "idle" }
  | { kind: "reading"; name: string }
  | { kind: "ready"; name: string; result: ImportResult; fresh: ImportResult["drafts"]; duplicates: number }
  | { kind: "saving"; done: number; total: number }
  | { kind: "done"; count: number; folder: string };

const SOURCE_NAME = { chatgpt: "ChatGPT", claude: "Claude" } as const;
const NEW = "__new__";

export function ImportTab() {
  const { api, vault, data, update, goTo } = useVault();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState(NEW);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const read = async (file: File) => {
    setError(null);
    setStep({ kind: "reading", name: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = parseExport(file.name, bytes);
      // Importing the same export twice should not double everything.
      const seen = new Set(data.memories.filter((m) => m.source.ref).map((m) => `${m.source.kind}:${m.source.ref}`));
      const fresh = result.drafts.filter((d) => !d.source?.ref || !seen.has(`${d.source.kind}:${d.source.ref}`));
      const existing = data.folders.find((f) => f.name.toLowerCase() === SOURCE_NAME[result.source].toLowerCase());
      setTarget(existing ? existing.id : NEW);
      setStep({ kind: "ready", name: file.name, result, fresh, duplicates: result.drafts.length - fresh.length });
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: "idle" });
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  const save = async () => {
    if (step.kind !== "ready") return;
    const drafts = step.fresh;
    const sourceName = SOURCE_NAME[step.result.source];
    setError(null);
    setStep({ kind: "saving", done: 0, total: drafts.length });
    try {
      let folder = data.folders.find((f) => f.id === target);
      if (!folder) {
        folder = (await ops.findOrCreateFolder(api, vault, data.folders, sourceName)).folder;
        const made = folder;
        update((d) => (d.folders.some((f) => f.id === made.id) ? d : { ...d, folders: [...d.folders, made] }));
      }
      const saved = await ops.importDrafts(api, folder, drafts, (done, total) => setStep({ kind: "saving", done, total }));
      update((d) => ({ ...d, memories: [...saved, ...d.memories].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1)) }));
      setStep({ kind: "done", count: saved.length, folder: folder.name });
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: "idle" });
    }
  };

  return (
    <div className="import">
      <div className="panel-header">
        <h2 className="panel-title">Import your history</h2>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {step.kind === "idle" || step.kind === "reading" ? (
        <>
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
              const f = e.dataTransfer.files?.[0];
              if (f) void read(f);
            }}
          >
            <ImportIcon className="empty-state-icon" />
            <span className="empty-state-title">{step.kind === "reading" ? `Reading ${step.name}` : "Drop your ChatGPT or Claude export here"}</span>
            <span className="empty-state-text">
              The zip file from the app&apos;s data export, or the conversations.json inside it. It is opened and encrypted in this browser.
            </span>
            <span className="button button-small">Choose a file</span>
            <input
              ref={input}
              type="file"
              accept=".zip,.json,application/zip,application/json"
              data-testid="import-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void read(f);
              }}
              disabled={step.kind === "reading"}
            />
          </label>
          <div className="grid grid-2 import-help">
            <div className="card">
              <h3 className="card-title">From ChatGPT</h3>
              <p className="card-text">Settings, Data controls, Export data. Download the zip from the email you receive.</p>
            </div>
            <div className="card">
              <h3 className="card-title">From Claude</h3>
              <p className="card-text">Settings, Privacy, Export data. Download the zip from the email you receive.</p>
            </div>
          </div>
        </>
      ) : null}

      {step.kind === "ready" ? (
        <div className="subpanel" data-testid="import-preview">
          <h3 className="card-title">
            {SOURCE_NAME[step.result.source]} export: {plural(step.result.drafts.length, "item")} found
          </h3>
          <p className="small muted">
            {step.fresh.length > 0 ? `${plural(step.fresh.length, "new memory", "new memories")} to import.` : "Everything in this file is already in your vault."}
            {step.duplicates > 0 ? ` ${plural(step.duplicates, "item")} already in your vault will be skipped.` : ""}
            {step.result.skipped > 0 ? ` ${plural(step.result.skipped, "empty conversation")} left out.` : ""}
          </p>
          {step.fresh.length > 0 ? (
            <div className="field">
              <label className="field-label" htmlFor="import-folder">
                Save into
              </label>
              <select id="import-folder" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                {!data.folders.some((f) => f.name.toLowerCase() === SOURCE_NAME[step.result.source].toLowerCase()) ? (
                  <option value={NEW}>A new folder called {SOURCE_NAME[step.result.source]}</option>
                ) : null}
                {data.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="form-actions">
            {step.fresh.length > 0 ? (
              <button type="button" className="button button-primary" onClick={() => void save()}>
                Import {plural(step.fresh.length, "memory", "memories")}
              </button>
            ) : null}
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: "idle" })}>
              Choose another file
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
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => goTo("memories")}>
              See memories
            </button>
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: "idle" })}>
              Import another file
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
