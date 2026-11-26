// The AI self's approval queue on the server: drafts it cannot read, each one
// an envelope under the vault key, with its kind and state in the clear. Every
// step is in the owner's read log, and so in the hourly seal. Nothing is sent
// from here: an approved answer goes out through its own channel's route.

import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const MAX_WAITING = 300;
export type DraftKind = "reply" | "plan" | "answer" | "payment";
export type DraftState = "waiting" | "approved" | "discarded";

export interface DraftRow {
  id: string;
  kind: DraftKind;
  ref: string | null;
  box: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
}

const toDraft = (r: Row): DraftRow => ({
  id: String(r.id),
  kind: r.kind as DraftKind,
  ref: r.ref == null ? null : String(r.ref),
  box: String(r.box),
  state: r.state as DraftState,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const SELF = (userId: string) => ({ appId: "self", userId });

export function listDrafts(db: Db, userId: string): DraftRow[] {
  return (db.prepare("SELECT * FROM drafts WHERE user_id = ? ORDER BY created_at DESC LIMIT 400").all(userId) as Row[]).map(toDraft);
}

export function createDraft(db: Db, userId: string, d: { id: string; kind: DraftKind; ref: string | null; box: string }): DraftRow {
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM drafts WHERE id = ?").get(d.id)) throw new HttpError(409, "A draft with this id already exists.");
    if (d.ref && db.prepare("SELECT 1 FROM drafts WHERE user_id = ? AND ref = ?").get(userId, d.ref)) throw new HttpError(409, "There is already a draft for this.", "drafted");
    const n = db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND state = 'waiting'").get(userId) as Row;
    if (Number(n.n) >= MAX_WAITING) throw new HttpError(400, `Up to ${MAX_WAITING} drafts can wait. Approve or discard some first.`, "queue_full");
    const at = now();
    db.prepare("INSERT INTO drafts (id, user_id, kind, ref, box, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)").run(d.id, userId, d.kind, d.ref, d.box, at, at);
    logRead(db, SELF(userId), "work", `drafted-${d.kind}`, 1);
    return toDraft(db.prepare("SELECT * FROM drafts WHERE id = ?").get(d.id) as Row);
  });
}

function mine(db: Db, userId: string, id: string): DraftRow {
  const r = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That draft was not found.", "no_draft");
  return toDraft(r);
}

/**
 * Saves an edit while a draft waits, or decides it: approved or discarded,
 * once. `learned` logs that the owner's edit became a note in "How I write".
 */
export function updateDraft(db: Db, userId: string, id: string, input: { box: string; state?: DraftState; learned?: boolean }): DraftRow {
  return tx(db, () => {
    const d = mine(db, userId, id);
    const next = input.state ?? d.state;
    if (d.state !== "waiting" && next !== d.state) throw new HttpError(409, "This draft was already decided.", "decided");
    db.prepare("UPDATE drafts SET box = ?, state = ?, updated_at = ? WHERE id = ?").run(input.box, next, now(), id);
    if (d.state === "waiting" && next !== "waiting") logRead(db, SELF(userId), "work", `${next}-${d.kind}`, 1);
    if (input.learned) logRead(db, SELF(userId), "work", "learned", 1);
    return mine(db, userId, id);
  });
}

export function deleteDraft(db: Db, userId: string, id: string): void {
  const d = mine(db, userId, id);
  if (d.state === "waiting") throw new HttpError(409, "Approve or discard the draft first.", "waiting");
  db.prepare("DELETE FROM drafts WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Logs a change the owner made to what the self learned (a note edited or deleted). */
export function logLesson(db: Db, userId: string, step: "lesson-edited" | "lesson-deleted"): void {
  logRead(db, SELF(userId), "work", step, 1);
}
