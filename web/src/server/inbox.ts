// The vault public key, which apps may suggest memories, and the inbox of
// suggestions. Everything stored here is either a public key, a tag the owner's
// device made, or a sealed box the server cannot open.

import type { StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead, putMemoriesIn, type AppAuth } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

/** Suggestions one app may send in an hour, and how many may wait in one inbox. */
export const PROPOSALS_PER_HOUR = 30;
export const INBOX_LIMIT = 500;

// ---------------------------------------------------------------- the vault box key

export interface BoxKeyRow {
  publicKey: string;
  wrappedSecret: string;
}

export function getBoxKey(db: Db, userId: string): BoxKeyRow | null {
  const r = db.prepare("SELECT public_key, wrapped_secret FROM box_keys WHERE user_id = ?").get(userId) as Row | undefined;
  return r ? { publicKey: String(r.public_key), wrappedSecret: String(r.wrapped_secret) } : null;
}

/** A vault gets its box key once. It is never replaced, so apps and other vaults can rely on it. */
export function setBoxKey(db: Db, userId: string, key: BoxKeyRow): void {
  if (getBoxKey(db, userId)) throw new HttpError(409, "This vault already has a public key.", "box_exists");
  if (db.prepare("SELECT 1 FROM box_keys WHERE public_key = ?").get(key.publicKey)) throw new HttpError(409, "That public key is already in use.", "box_taken");
  db.prepare("INSERT INTO box_keys (user_id, public_key, wrapped_secret, created_at) VALUES (?, ?, ?, ?)").run(userId, key.publicKey, key.wrappedSecret, now());
}

export function userByBoxKey(db: Db, publicKey: string): string | null {
  const r = db.prepare("SELECT user_id FROM box_keys WHERE public_key = ?").get(publicKey) as Row | undefined;
  return r ? String(r.user_id) : null;
}

// ---------------------------------------------------------------- which apps may suggest

export function setAppInbox(db: Db, userId: string, appId: string, enabled: boolean, tag: string | null): void {
  tx(db, () => {
    const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
    if (!app) throw new HttpError(404, "That app was not found.");
    if (app.revoked_at) throw new HttpError(400, "This app was revoked. Connect it again to give it access.");
    if (enabled && !getBoxKey(db, userId)) throw new HttpError(400, "This vault has no public key yet. Reload the vault and try again.", "no_box");
    if (enabled && !tag) throw new HttpError(400, "Turning suggestions on needs the tag made by your vault.", "invalid");
    db.prepare(
      `INSERT INTO app_inbox (app_id, user_id, enabled, tag, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET enabled = excluded.enabled, tag = COALESCE(excluded.tag, app_inbox.tag), updated_at = excluded.updated_at`,
    ).run(appId, userId, enabled ? 1 : 0, tag, now());
  });
}

export function appInboxStates(db: Db, userId: string): Map<string, boolean> {
  const rows = db.prepare("SELECT app_id, enabled FROM app_inbox WHERE user_id = ?").all(userId) as Row[];
  return new Map(rows.map((r) => [String(r.app_id), Number(r.enabled) === 1]));
}

/** What an app needs to seal a suggestion: the vault public key and the tag that vouches for it. */
export function appInbox(db: Db, auth: AppAuth): { publicKey: string; tag: string } {
  const r = db.prepare("SELECT enabled, tag FROM app_inbox WHERE app_id = ? AND user_id = ?").get(auth.appId, auth.userId) as Row | undefined;
  if (!r || Number(r.enabled) !== 1 || !r.tag) {
    throw new HttpError(403, "This app may not suggest memories. The owner can turn suggestions on for it in their Sigil vault, under Apps.", "propose_off");
  }
  const key = getBoxKey(db, auth.userId);
  if (!key) throw new HttpError(403, "This vault cannot receive suggestions yet.", "propose_off");
  return { publicKey: key.publicKey, tag: String(r.tag) };
}

// ---------------------------------------------------------------- the inbox

export interface ProposalRow {
  id: string;
  appId: string;
  sealed: string;
  createdAt: string;
}

export function createProposal(db: Db, auth: AppAuth, id: string, sealed: string, at = new Date()): ProposalRow {
  return tx(db, () => {
    appInbox(db, auth);
    const since = new Date(at.getTime() - 3600_000).toISOString();
    const recent = db.prepare("SELECT COUNT(*) AS n FROM read_log WHERE app_id = ? AND kind = 'propose' AND at > ?").get(auth.appId, since) as Row;
    if (Number(recent.n) >= PROPOSALS_PER_HOUR) {
      throw new HttpError(429, `This app has sent ${PROPOSALS_PER_HOUR} suggestions in the last hour. Try again later.`, "propose_limit");
    }
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE user_id = ?").get(auth.userId) as Row;
    if (Number(waiting.n) >= INBOX_LIMIT) throw new HttpError(429, "The owner's inbox is full. Suggestions can be sent again once they review it.", "inbox_full");
    if (db.prepare("SELECT 1 FROM proposals WHERE id = ?").get(id)) throw new HttpError(409, "A suggestion with this id already exists.");
    const createdAt = at.toISOString();
    db.prepare("INSERT INTO proposals (id, user_id, app_id, sealed, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, auth.userId, auth.appId, sealed, sealed.length, createdAt);
    logRead(db, auth, "propose", id, 1, at);
    return { id, appId: auth.appId, sealed, createdAt };
  });
}

export function listProposals(db: Db, userId: string): ProposalRow[] {
  return (db.prepare("SELECT id, app_id, sealed, created_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC, id").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    appId: String(r.app_id),
    sealed: String(r.sealed),
    createdAt: String(r.created_at),
  }));
}

/** Approve or merge: the memory (new, or the one merged into) is saved and the proposal removed, together. */
export function approveProposal(db: Db, userId: string, proposalId: string, memory: StoredMemory): void {
  tx(db, () => {
    const r = db.prepare("DELETE FROM proposals WHERE id = ? AND user_id = ?").run(proposalId, userId);
    if (r.changes === 0) throw new HttpError(404, "That suggestion was not found. It may have been handled on another device.");
    putMemoriesIn(db, userId, [memory]);
  });
}

export function rejectProposal(db: Db, userId: string, proposalId: string): void {
  const r = db.prepare("DELETE FROM proposals WHERE id = ? AND user_id = ?").run(proposalId, userId);
  if (r.changes === 0) throw new HttpError(404, "That suggestion was not found. It may have been handled on another device.");
}

// ---------------------------------------------------------------- quick capture

/** The owner's own captures, from a phone or the share sheet, wait in the inbox like suggestions. */
export const CAPTURE_APP = "capture";

export function createCapture(db: Db, userId: string, id: string, sealed: string, at = new Date()): ProposalRow {
  return tx(db, () => {
    if (!getBoxKey(db, userId)) throw new HttpError(409, "Open your vault once on this device first.", "no_box");
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE user_id = ?").get(userId) as Row;
    if (Number(waiting.n) >= INBOX_LIMIT) throw new HttpError(429, "Your inbox is full. Review it, then capture again.", "inbox_full");
    if (db.prepare("SELECT 1 FROM proposals WHERE id = ?").get(id)) throw new HttpError(409, "This was already captured.", "duplicate");
    const createdAt = at.toISOString();
    db.prepare("INSERT INTO proposals (id, user_id, app_id, sealed, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, CAPTURE_APP, sealed, sealed.length, createdAt);
    return { id, appId: CAPTURE_APP, sealed, createdAt };
  });
}
