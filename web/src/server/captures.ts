// Capture keys on the server: the hash of each key's token, the tag the
// owner's vault made over its public key, the owner's name for the key (under
// the vault key), and whether the key may send plain text. A key writes into
// the inbox and nothing else; every capture is a line in the owner's log.

import { sealArrivedText, CAPTURE_KEYS_PER_VAULT, CAPTURE_PER_DAY } from "@sigil/core";
import { tokenHash } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";
import { getBoxKey, INBOX_LIMIT } from "./inbox";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface CaptureKeyInput {
  id: string;
  tokenHash: string;
  tag: string;
  note: string;
  plain: boolean;
}

export function createCaptureKey(db: Db, userId: string, k: CaptureKeyInput): void {
  tx(db, () => {
    if (!getBoxKey(db, userId)) throw new HttpError(409, "This vault has no public key yet. Reload the vault and try again.", "no_box");
    const n = db.prepare("SELECT COUNT(*) AS n FROM capture_keys WHERE user_id = ? AND revoked_at IS NULL").get(userId) as Row;
    if (Number(n.n) >= CAPTURE_KEYS_PER_VAULT) throw new HttpError(400, `A vault has up to ${CAPTURE_KEYS_PER_VAULT} capture keys at once. Revoke one first.`);
    if (db.prepare("SELECT 1 FROM capture_keys WHERE id = ? OR token_hash = ?").get(k.id, k.tokenHash)) throw new HttpError(409, "That capture key already exists.");
    db.prepare("INSERT INTO capture_keys (id, user_id, token_hash, tag, note, plain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(k.id, userId, k.tokenHash, k.tag, k.note, k.plain ? 1 : 0, now());
    logRead(db, { appId: k.id, userId }, "capture", "key-made", 1);
  });
}

export function revokeCaptureKey(db: Db, userId: string, id: string): void {
  tx(db, () => {
    const r = db.prepare("UPDATE capture_keys SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL WHERE id = ? AND user_id = ?").run(now(), id, userId);
    if (r.changes === 0) throw new HttpError(404, "That capture key was not found.");
    logRead(db, { appId: id, userId }, "capture", "key-revoked", 1);
  });
}

export function listCaptureKeys(db: Db, userId: string) {
  return (db.prepare("SELECT id, note, plain, sent, created_at, last_used_at, revoked_at FROM capture_keys WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    note: String(r.note),
    plain: Number(r.plain) === 1,
    sent: Number(r.sent),
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at),
    revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
  }));
}

export interface CaptureAuth {
  id: string;
  userId: string;
  tag: string;
  plain: boolean;
}

export function captureByToken(db: Db, token: string): CaptureAuth | null {
  const r = db.prepare("SELECT id, user_id, tag, plain FROM capture_keys WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash(token)) as Row | undefined;
  return r ? { id: String(r.id), userId: String(r.user_id), tag: String(r.tag), plain: Number(r.plain) === 1 } : null;
}

/** What the sending device needs to seal: the vault public key and the tag that vouches for it. Not a read of anything, so not logged. */
export function captureVaultKey(db: Db, auth: CaptureAuth): { captureId: string; publicKey: string; tag: string } {
  const key = getBoxKey(db, auth.userId);
  if (!key) throw new HttpError(409, "This vault cannot receive captures yet.", "no_box");
  return { captureId: auth.id, publicKey: key.publicKey, tag: auth.tag };
}

/** One capture into the inbox, sealed on the device (or, for a key allowed to send plain text, on arrival). */
export function captureInto(db: Db, auth: CaptureAuth, id: string, sealed: string, at = new Date()): { id: string; createdAt: string } {
  return tx(db, () => {
    const since = new Date(at.getTime() - 86_400_000).toISOString();
    const day = db.prepare("SELECT COUNT(*) AS n FROM read_log WHERE app_id = ? AND kind = 'capture' AND at > ? AND memory_id NOT IN ('key-made', 'key-revoked')").get(auth.id, since) as Row;
    if (Number(day.n) >= CAPTURE_PER_DAY) throw new HttpError(429, `This capture key has sent ${CAPTURE_PER_DAY} captures today. Try again tomorrow.`, "capture_limit");
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE user_id = ?").get(auth.userId) as Row;
    if (Number(waiting.n) >= INBOX_LIMIT) throw new HttpError(429, "The inbox is full. Review it, then capture again.", "inbox_full");
    if (db.prepare("SELECT 1 FROM proposals WHERE id = ?").get(id)) throw new HttpError(409, "This was already captured.", "duplicate");
    const createdAt = at.toISOString();
    db.prepare("INSERT INTO proposals (id, user_id, app_id, sealed, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, auth.userId, auth.id, sealed, sealed.length, createdAt);
    db.prepare("UPDATE capture_keys SET sent = sent + 1, last_used_at = ? WHERE id = ?").run(createdAt, auth.id);
    logRead(db, { appId: auth.id, userId: auth.userId }, "capture", id, 1, at);
    return { id, createdAt };
  });
}

/** Plain text from a shortcut that cannot run code, for a key the owner allowed: sealed here at once, kept only sealed. */
export function captureText(db: Db, auth: CaptureAuth, text: string, title: string): { id: string; createdAt: string } {
  if (!auth.plain) throw new HttpError(403, "This capture key seals on the device. The owner can allow plain text for it in their vault, under Devices.", "plain_off");
  if (!text.trim() && !title.trim()) throw new HttpError(400, "Send some text.", "invalid");
  const { publicKey } = captureVaultKey(db, auth);
  const { id, sealed } = sealArrivedText(publicKey, auth.id, text, title);
  return captureInto(db, auth, id, sealed);
}

/** The owner's names for capture keys, to show in the inbox which device sent what. */
export function captureIds(db: Db, userId: string): Set<string> {
  return new Set((db.prepare("SELECT id FROM capture_keys WHERE user_id = ?").all(userId) as Row[]).map((r) => String(r.id)));
}
