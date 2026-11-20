"use client";

import { useEffect, useMemo, useState } from "react";
import { findDuplicates, hkdf, toHex, type DuplicateKind, type Memory } from "@sigil/core";
import { formatDate, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { Notice } from "../ui";

const KIND_TEXT: Record<DuplicateKind, string> = {
  same: "The same text",
  near: "Nearly the same words",
  meaning: "The same thing in other words",
};

const DISMISSED = "sigil-duplicates-dismissed";

/** Pairs the owner said are not duplicates, kept in this browser under names derived from the vault key. */
function useDismissed(raw: Uint8Array) {
  const [scope, setScope] = useState<string | null>(null);
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void hkdf(raw, "sigil:duplicates-dismissed", 8).then((b) => {
      if (!alive) return;
      const s = toHex(b);
      setScope(s);
      try {
        const all = JSON.parse(localStorage.getItem(DISMISSED) ?? "{}") as Record<string, string[]>;
        setList(Array.isArray(all[s]) ? all[s] : []);
      } catch {
        setList([]);
      }
    });
    return () => {
      alive = false;
    };
  }, [raw]);
  const add = (key: string) => {
    const next = [...list, key];
    setList(next);
    if (!scope) return;
    try {
      const all = JSON.parse(localStorage.getItem(DISMISSED) ?? "{}") as Record<string, string[]>;
      all[scope] = next.slice(-2000);
      localStorage.setItem(DISMISSED, JSON.stringify(all));
    } catch {
      // Storage is not available; the choice holds for this visit.
    }
  };
  return { dismissed: new Set(list), dismiss: add };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function Duplicates({ onOpen }: { onOpen(id: string): void }) {
  const { api, vault, data, update, semantic } = useVault();
  const { dismissed, dismiss } = useDismissed(vault.raw);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pairs = useMemo(() => {
    const items = data.memories.filter((m) => m.source.kind !== "profile").map((m) => ({ ...m, text: m.body }));
    return findDuplicates(items, { vectors: semantic.vectors }).filter((p) => !dismissed.has(pairKey(p.a.id, p.b.id)));
  }, [data.memories, semantic.vectors, dismissed]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  /** Keeps the newer memory, adds the other's text if it says more, joins the tags, and deletes the other. */
  const merge = (keep: Memory, drop: Memory) =>
    act(pairKey(keep.id, drop.id), async () => {
      const body = keep.body.includes(drop.body.trim()) ? keep.body : `${keep.body.trimEnd()}\n\n---\n${drop.title}\n\n${drop.body.trim()}`;
      const saved = await ops.updateMemory(api, data.folders, keep, { body, tags: [...keep.tags, ...drop.tags] });
      await ops.deleteMemories(api, [drop.id]);
      update((d) => ({ ...d, memories: [saved, ...d.memories.filter((m) => m.id !== saved.id && m.id !== drop.id)] }));
    });

  const remove = (drop: Memory) =>
    act(drop.id, async () => {
      await ops.deleteMemories(api, [drop.id]);
      update((d) => ({ ...d, memories: d.memories.filter((m) => m.id !== drop.id) }));
    });

  return (
    <section className="subpanel duplicates" aria-labelledby="duplicates-title">
      <h3 id="duplicates-title" className="settings-heading">
        Duplicates
      </h3>
      <p className="small muted">
        Memories that say the same thing twice, found on this device.{" "}
        {semantic.status.state === "ready" ? "Includes the same thing said in other words." : "Same meaning in other words is found once search by meaning is ready."}
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {pairs.length === 0 ? (
        <p className="small">No duplicates found.</p>
      ) : (
        <>
          <p className="small faint">{plural(pairs.length, "pair")} to look at.</p>
          <ul className="list duplicate-list">
            {pairs.slice(0, 50).map((p) => {
              const [newer, older] = p.a.editedAt >= p.b.editedAt ? [p.a, p.b] : [p.b, p.a];
              const key = pairKey(p.a.id, p.b.id);
              return (
                <li key={key} className="list-row duplicate" data-kind={p.kind}>
                  <div className="list-row-main">
                    <p className="list-row-title">{KIND_TEXT[p.kind]}</p>
                    <p className="list-row-meta">
                      <button type="button" className="text-button" onClick={() => onOpen(newer.id)}>
                        {newer.title}
                      </button>{" "}
                      ({formatDate(newer.editedAt)}) and{" "}
                      <button type="button" className="text-button" onClick={() => onOpen(older.id)}>
                        {older.title}
                      </button>{" "}
                      ({formatDate(older.editedAt)})
                    </p>
                  </div>
                  <div className="list-row-actions">
                    <button type="button" className="button button-small" disabled={busy === key} onClick={() => void merge(newer, older)}>
                      {busy === key ? "Merging" : "Merge into the newer"}
                    </button>
                    {p.kind === "same" ? (
                      <button type="button" className="button button-small button-ghost" disabled={busy === older.id} onClick={() => void remove(older)}>
                        Delete the older
                      </button>
                    ) : null}
                    <button type="button" className="button button-small button-ghost" onClick={() => dismiss(key)}>
                      Not the same
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
