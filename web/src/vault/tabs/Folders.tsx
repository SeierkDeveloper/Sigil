"use client";

import { useState } from "react";
import { FolderIcon, PlusIcon } from "@/components/icons";
import { plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Notice } from "../ui";

export function FoldersTab() {
  const { api, vault, data, update, reload } = useVault();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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
                      {plural(n, "memory", "memories")}. {apps.length ? `Readable by ${apps.join(", ")}.` : "No app can read it."}
                    </p>
                  </>
                )}
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
              {renaming?.id !== f.id && deleting !== f.id ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small" onClick={() => setRenaming({ id: f.id, name: f.name })}>
                    Rename
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
    </div>
  );
}
