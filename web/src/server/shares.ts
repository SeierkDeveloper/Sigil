// Folders shared between vaults, and the folder key rotation that revokes a
// share. The server routes sealed folder keys from one vault to another and
// applies rotations as one transaction; it never holds a key that opens them.

import type { StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";
import { userByBoxKey } from "./inbox";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const SHARES_PER_FOLDER = 50;

export interface ShareInput {
  id: string;
  folderId: string;
  recipientKey: string;
  sealedKey: string;
  note: string;
}

export function createShare(db: Db, ownerId: string, s: ShareInput): void {
  tx(db, () => {
    if (!db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?").get(ownerId, s.folderId)) throw new HttpError(404, "That folder was not found.");
    const recipientId = userByBoxKey(db, s.recipientKey);
    if (!recipientId) throw new HttpError(404, "No vault has this code. Ask for the code again from the person you share with.", "unknown_vault");
    if (recipientId === ownerId) throw new HttpError(400, "That is the code of this vault. Use the other person's vault code.", "own_vault");
    if (db.prepare("SELECT 1 FROM shares WHERE id = ?").get(s.id)) throw new HttpError(409, "A share with this id already exists.");
    if (db.prepare("SELECT 1 FROM shares WHERE owner_id = ? AND folder_id = ? AND recipient_id = ?").get(ownerId, s.folderId, recipientId)) {
      throw new HttpError(409, "This folder is already shared with that vault.", "already_shared");
    }
    const n = db.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id = ? AND folder_id = ?").get(ownerId, s.folderId) as Row;
    if (Number(n.n) >= SHARES_PER_FOLDER) throw new HttpError(400, `A folder can be shared with up to ${SHARES_PER_FOLDER} vaults.`);
    db.prepare(
      "INSERT INTO shares (id, owner_id, folder_id, recipient_id, recipient_key, sealed_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(s.id, ownerId, s.folderId, recipientId, s.recipientKey, s.sealedKey, s.note, now());
  });
}

export interface OutgoingShare {
  id: string;
  folderId: string;
  recipientKey: string;
  note: string;
  createdAt: string;
  acceptedAt: string | null;
}

export function listOutgoing(db: Db, ownerId: string): OutgoingShare[] {
  return (db.prepare("SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at, id").all(ownerId) as Row[]).map((r) => ({
    id: String(r.id),
    folderId: String(r.folder_id),
    recipientKey: String(r.recipient_key),
    note: String(r.note),
    createdAt: String(r.created_at),
    acceptedAt: r.accepted_at == null ? null : String(r.accepted_at),
  }));
}

export interface IncomingShare {
  id: string;
  folderId: string;
  sealedKey: string;
  folderMeta: string;
  createdAt: string;
  acceptedAt: string | null;
  /** Only once accepted. */
  memories: StoredMemory[];
}

/**
 * The folders other vaults shared with this one. Accepted shares come with their
 * memories, and each time they are opened that goes into the owner's read log.
 */
export function listIncoming(db: Db, recipientId: string): IncomingShare[] {
  const rows = db
    .prepare(
      `SELECT s.*, f.meta AS folder_meta FROM shares s JOIN folders f ON f.user_id = s.owner_id AND f.id = s.folder_id
       WHERE s.recipient_id = ? ORDER BY s.created_at, s.id`,
    )
    .all(recipientId) as Row[];
  const mems = db.prepare("SELECT id, folder_id, head, body FROM memories WHERE user_id = ? AND folder_id = ? ORDER BY updated_at DESC, id");
  return rows.map((r) => {
    const accepted = r.accepted_at != null;
    const memories = accepted
      ? (mems.all(String(r.owner_id), String(r.folder_id)) as Row[]).map((m) => ({ id: String(m.id), folderId: String(m.folder_id), head: String(m.head), body: String(m.body) }))
      : [];
    if (accepted) logRead(db, { appId: String(r.id), userId: String(r.owner_id) }, "shared", null, memories.length);
    return {
      id: String(r.id),
      folderId: String(r.folder_id),
      sealedKey: String(r.sealed_key),
      folderMeta: String(r.folder_meta),
      createdAt: String(r.created_at),
      acceptedAt: accepted ? String(r.accepted_at) : null,
      memories,
    };
  });
}

export function acceptShare(db: Db, recipientId: string, shareId: string): void {
  const r = db.prepare("UPDATE shares SET accepted_at = COALESCE(accepted_at, ?) WHERE id = ? AND recipient_id = ?").run(now(), shareId, recipientId);
  if (r.changes === 0) throw new HttpError(404, "That shared folder was not found. The owner may have stopped sharing it.");
}

/** The recipient declines a share or removes it from their vault. */
export function leaveShare(db: Db, recipientId: string, shareId: string): void {
  const r = db.prepare("DELETE FROM shares WHERE id = ? AND recipient_id = ?").run(shareId, recipientId);
  if (r.changes === 0) throw new HttpError(404, "That shared folder was not found.");
}

// ---------------------------------------------------------------- rotation

export interface RotationInput {
  wrappedKey: string;
  meta: string;
  memories: StoredMemory[];
  grants: { appId: string; wrappedKey: string }[];
  shares: { id: string; sealedKey: string }[];
  revoke: string[];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/**
 * Applies a folder key rotation made on the owner's device. It must cover the
 * whole folder: every memory, every app that may read it and every share, or
 * nothing changes, so no part of the folder is left under the old key.
 */
export function rotateFolder(db: Db, ownerId: string, folderId: string, r: RotationInput): void {
  tx(db, () => {
    if (!db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?").get(ownerId, folderId)) throw new HttpError(404, "That folder was not found.");
    const stale = () => new HttpError(409, "The folder changed while its new key was being made. Reload the vault and try again.", "stale");

    const memoryIds = (db.prepare("SELECT id FROM memories WHERE user_id = ? AND folder_id = ?").all(ownerId, folderId) as Row[]).map((x) => String(x.id));
    if (!sameSet(r.memories.map((m) => m.id), memoryIds) || r.memories.some((m) => m.folderId !== folderId)) throw stale();

    const grantApps = (db.prepare("SELECT app_id FROM grants WHERE user_id = ? AND folder_id = ?").all(ownerId, folderId) as Row[]).map((x) => String(x.app_id));
    if (!sameSet(r.grants.map((g) => g.appId), grantApps)) throw stale();

    const shareIds = (db.prepare("SELECT id FROM shares WHERE owner_id = ? AND folder_id = ?").all(ownerId, folderId) as Row[]).map((x) => String(x.id));
    if (!sameSet([...r.shares.map((s) => s.id), ...r.revoke], shareIds)) throw stale();

    const at = now();
    db.prepare("UPDATE folders SET wrapped_key = ?, meta = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(r.wrappedKey, r.meta, at, ownerId, folderId);
    const mem = db.prepare("UPDATE memories SET head = ?, body = ?, size = ? WHERE user_id = ? AND id = ?");
    for (const m of r.memories) mem.run(m.head, m.body!, m.head.length + m.body!.length, ownerId, m.id);
    const grant = db.prepare("UPDATE grants SET wrapped_key = ? WHERE app_id = ? AND user_id = ? AND folder_id = ?");
    for (const g of r.grants) grant.run(g.wrappedKey, g.appId, ownerId, folderId);
    const share = db.prepare("UPDATE shares SET sealed_key = ? WHERE id = ? AND owner_id = ?");
    for (const s of r.shares) share.run(s.sealedKey, s.id, ownerId);
    const del = db.prepare("DELETE FROM shares WHERE id = ? AND owner_id = ?");
    for (const id of r.revoke) del.run(id, ownerId);
  });
}
