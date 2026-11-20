// Data access. Every function takes the database explicitly so tests can run
// against a private in-memory copy. Functions that act for a user always filter
// by that user's id: one account can never reach another account's rows.

import { randomBytes, randomId, readEntryLeaf, hex32, toBase64Url, toHex, tokenHash, type ReadKind } from "@sigil/core";
import type { StoredApp, StoredFolder, StoredGrant, StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { serverConfig } from "./config";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

// ---------------------------------------------------------------- users and key slots

export type KeyslotKind = "passkey" | "wallet" | "phrase" | "device";

export interface KeyslotInput {
  kind: KeyslotKind;
  ref: string;
  authToken?: string;
  wrappedKey: string;
  /** For a device: its name under the vault key. */
  note?: string | null;
}

export interface PasskeyInput {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export interface VaultInit {
  primary: KeyslotInput;
  recovery: KeyslotInput;
  folder: StoredFolder;
  passkey?: PasskeyInput;
}

export function createUser(db: Db, init: VaultInit, userId = randomId()): string {
  if (init.recovery.kind !== "phrase") throw new HttpError(400, "A recovery phrase is required.");
  if (init.primary.kind === "phrase") throw new HttpError(400, "Choose a passkey or a wallet to sign in with.");
  return tx(db, () => {
    for (const slot of [init.primary, init.recovery]) {
      const taken = db.prepare("SELECT 1 FROM keyslots WHERE kind = ? AND ref = ?").get(slot.kind, slot.ref);
      if (taken) {
        throw new HttpError(409, slot.kind === "wallet" ? "This wallet already opens a vault. Sign in instead." : "This sign-in method is already in use.", "taken");
      }
    }
    const at = now();
    db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(userId, at);
    insertKeyslot(db, userId, init.primary);
    insertKeyslot(db, userId, init.recovery);
    if (init.passkey) insertPasskey(db, userId, init.passkey);
    insertFolder(db, userId, init.folder);
    return userId;
  });
}

export function insertKeyslot(db: Db, userId: string, slot: KeyslotInput): string {
  const id = randomId();
  db.prepare(
    "INSERT INTO keyslots (id, user_id, kind, ref, auth_hash, wrapped_key, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, slot.kind, slot.ref, slot.authToken ? tokenHash(slot.authToken) : null, slot.wrappedKey, now(), slot.note ?? null);
  return id;
}

function insertPasskey(db: Db, userId: string, p: PasskeyInput): void {
  db.prepare("INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    p.credentialId,
    userId,
    p.publicKey,
    p.counter,
    JSON.stringify(p.transports ?? []),
    now(),
  );
}

export function userExists(db: Db, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
}

export interface KeyslotRow {
  id: string;
  userId: string;
  kind: KeyslotKind;
  ref: string;
  wrappedKey: string;
}

function toKeyslot(r: Row): KeyslotRow {
  return { id: String(r.id), userId: String(r.user_id), kind: r.kind as KeyslotKind, ref: String(r.ref), wrappedKey: String(r.wrapped_key) };
}

/** Finds a wallet, phrase or device key slot by its token. Compares hashes, so the token itself is never stored. */
export function keyslotByToken(db: Db, kind: "wallet" | "phrase" | "device", ref: string, authToken: string): KeyslotRow | null {
  const r = db.prepare("SELECT * FROM keyslots WHERE kind = ? AND ref = ?").get(kind, ref) as Row | undefined;
  if (!r || !r.auth_hash || r.auth_hash !== tokenHash(authToken)) return null;
  db.prepare("UPDATE keyslots SET last_used_at = ? WHERE id = ?").run(now(), r.id as string);
  return toKeyslot(r);
}

export function keyslotForPasskey(db: Db, credentialId: string): KeyslotRow | null {
  const r = db.prepare("SELECT * FROM keyslots WHERE kind = 'passkey' AND ref = ?").get(credentialId) as Row | undefined;
  if (!r) return null;
  db.prepare("UPDATE keyslots SET last_used_at = ? WHERE id = ?").run(now(), r.id as string);
  return toKeyslot(r);
}

export function getPasskey(db: Db, credentialId: string) {
  const r = db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(credentialId) as Row | undefined;
  if (!r) return null;
  return {
    credentialId: String(r.credential_id),
    userId: String(r.user_id),
    publicKey: String(r.public_key),
    counter: Number(r.counter),
    transports: JSON.parse(String(r.transports ?? "[]")) as string[],
  };
}

export function updatePasskeyCounter(db: Db, credentialId: string, counter: number): void {
  db.prepare("UPDATE passkeys SET counter = ? WHERE credential_id = ?").run(counter, credentialId);
}

export function listKeyslots(db: Db, userId: string) {
  return (db.prepare("SELECT id, kind, ref, created_at, last_used_at, note FROM keyslots WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    kind: r.kind as KeyslotKind,
    // Wallet addresses are shown so the owner can tell wallets apart; a device's id lets this device find itself in the list.
    label: r.kind === "wallet" || r.kind === "device" ? String(r.ref) : null,
    createdAt: String(r.created_at),
    lastUsedAt: str(r.last_used_at),
    ...(r.kind === "device" ? { note: str(r.note) } : {}),
  }));
}

export function addKeyslot(db: Db, userId: string, slot: KeyslotInput, passkey?: PasskeyInput): string {
  return tx(db, () => {
    if (slot.kind === "phrase") {
      // A new recovery phrase replaces the old one.
      db.prepare("DELETE FROM keyslots WHERE user_id = ? AND kind = 'phrase'").run(userId);
    }
    const taken = db.prepare("SELECT 1 FROM keyslots WHERE kind = ? AND ref = ?").get(slot.kind, slot.ref);
    if (taken) throw new HttpError(409, "This sign-in method is already linked to a vault.", "taken");
    const id = insertKeyslot(db, userId, slot);
    if (passkey) insertPasskey(db, userId, passkey);
    return id;
  });
}

export function removeKeyslot(db: Db, userId: string, keyslotId: string): void {
  tx(db, () => {
    const r = db.prepare("SELECT kind, ref FROM keyslots WHERE id = ? AND user_id = ?").get(keyslotId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That sign-in method was not found.");
    if (r.kind === "phrase") throw new HttpError(400, "The recovery phrase can be replaced but not removed.");
    const others = db.prepare("SELECT COUNT(*) AS n FROM keyslots WHERE user_id = ? AND kind != 'phrase' AND id != ?").get(userId, keyslotId) as Row;
    if (Number(others.n) === 0) throw new HttpError(400, "Add another passkey or wallet before removing your last one.");
    db.prepare("DELETE FROM keyslots WHERE id = ?").run(keyslotId);
    db.prepare("DELETE FROM sessions WHERE keyslot_id = ?").run(keyslotId);
    if (r.kind === "passkey") db.prepare("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?").run(String(r.ref), userId);
  });
}

// ---------------------------------------------------------------- sessions and challenges

export function createSession(db: Db, userId: string, keyslotId: string | null = null): string {
  const token = toBase64Url(randomBytes(32));
  const expires = Date.now() + serverConfig.sessionDays * 86400_000;
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, keyslot_id) VALUES (?, ?, ?, ?, ?)").run(tokenHash(token), userId, now(), expires, keyslotId);
  return token;
}

// ---------------------------------------------------------------- the heartbeat

/** Any sign-in or vault action counts as alive. Written at most once a minute. */
export function touchActive(db: Db, userId: string, at = new Date()): boolean {
  const r = db.prepare("SELECT last_active_at FROM users WHERE id = ?").get(userId) as Row | undefined;
  if (!r) return false;
  const last = r.last_active_at ? Date.parse(String(r.last_active_at)) : 0;
  if (at.getTime() - last < 60_000) return false;
  db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(at.toISOString(), userId);
  return true;
}

export function lastActive(db: Db, userId: string): string | null {
  const r = db.prepare("SELECT last_active_at, created_at FROM users WHERE id = ?").get(userId) as Row | undefined;
  if (!r) return null;
  return str(r.last_active_at) ?? String(r.created_at);
}

export function sessionUser(db: Db, token: string | null | undefined): string | null {
  if (!token) return null;
  const r = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash(token)) as Row | undefined;
  if (!r) return null;
  if (Number(r.expires_at) < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return null;
  }
  return String(r.user_id);
}

export function deleteSession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function saveChallenge(db: Db, challenge: string, purpose: string, userId: string | null): string {
  const id = randomId();
  db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, challenge, purpose, userId, Date.now() + 5 * 60_000);
  return id;
}

/** Returns the challenge once and deletes it, so it can never be replayed. */
export function takeChallenge(db: Db, id: string, purpose: string): { challenge: string; userId: string | null } {
  const r = db.prepare("SELECT * FROM challenges WHERE id = ?").get(id) as Row | undefined;
  db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
  if (!r || r.purpose !== purpose || Number(r.expires_at) < Date.now()) {
    throw new HttpError(400, "The sign-in request expired. Please try again.", "challenge");
  }
  return { challenge: String(r.challenge), userId: str(r.user_id) };
}

// ---------------------------------------------------------------- folders

function insertFolder(db: Db, userId: string, f: StoredFolder): void {
  const at = now();
  db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, f.id, f.meta, f.wrappedKey, at, at);
}

export function createFolder(db: Db, userId: string, f: StoredFolder): void {
  const exists = db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?").get(userId, f.id);
  if (exists) throw new HttpError(409, "A folder with this id already exists.");
  const count = db.prepare("SELECT COUNT(*) AS n FROM folders WHERE user_id = ?").get(userId) as Row;
  if (Number(count.n) >= 200) throw new HttpError(400, "A vault can hold up to 200 folders.");
  insertFolder(db, userId, f);
}

export function renameFolder(db: Db, userId: string, folderId: string, meta: string): void {
  const r = db.prepare("UPDATE folders SET meta = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(meta, now(), userId, folderId);
  if (r.changes === 0) throw new HttpError(404, "That folder was not found.");
}

export function deleteFolder(db: Db, userId: string, folderId: string): void {
  tx(db, () => {
    const count = db.prepare("SELECT COUNT(*) AS n FROM folders WHERE user_id = ?").get(userId) as Row;
    if (Number(count.n) <= 1) throw new HttpError(400, "A vault keeps at least one folder.");
    // Memories and app grants in the folder go with it (ON DELETE CASCADE).
    const r = db.prepare("DELETE FROM folders WHERE user_id = ? AND id = ?").run(userId, folderId);
    if (r.changes === 0) throw new HttpError(404, "That folder was not found.");
  });
}

export function listFolders(db: Db, userId: string): (StoredFolder & { createdAt: string })[] {
  return (db.prepare("SELECT id, meta, wrapped_key, created_at FROM folders WHERE user_id = ? ORDER BY created_at, id").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    meta: String(r.meta),
    wrappedKey: String(r.wrapped_key),
    createdAt: String(r.created_at),
  }));
}

// ---------------------------------------------------------------- memories

/** A memory as it is saved. deleteAfter is set only for a memory with an expiry: the time the server deletes it for real. */
export type MemoryInput = StoredMemory & { deleteAfter?: string | null };

export function putMemories(db: Db, userId: string, items: MemoryInput[]): number {
  return tx(db, () => putMemoriesIn(db, userId, items));
}

/** The body of putMemories, for callers that are already inside a transaction. */
export function putMemoriesIn(db: Db, userId: string, items: MemoryInput[]): number {
  const folderOk = db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?");
  const upsert = db.prepare(`
    INSERT INTO memories (user_id, id, folder_id, head, body, size, created_at, updated_at, delete_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, id) DO UPDATE SET folder_id = excluded.folder_id, head = excluded.head,
      body = excluded.body, size = excluded.size, updated_at = excluded.updated_at, delete_after = excluded.delete_after`);
  const at = now();
  for (const m of items) {
    if (!folderOk.get(userId, m.folderId)) throw new HttpError(400, "A memory points at a folder that does not exist.");
    if (!m.body) throw new HttpError(400, "A memory was sent without its body.");
    upsert.run(userId, m.id, m.folderId, m.head, m.body, m.head.length + m.body.length, at, at, m.deleteAfter ?? null);
  }
  return items.length;
}

/** Sets or clears when expiring memories are deleted for real, after the owner changes the grace period. */
export function setDeleteAfter(db: Db, userId: string, items: { id: string; deleteAfter: string | null }[]): number {
  return tx(db, () => {
    const q = db.prepare("UPDATE memories SET delete_after = ? WHERE user_id = ? AND id = ?");
    let n = 0;
    for (const i of items) n += Number(q.run(i.deleteAfter, userId, i.id).changes);
    return n;
  });
}

/** Deletes, for real, every memory whose grace period after expiry is over. Runs on a timer and when a vault loads. */
export function purgeExpired(db: Db, at = new Date()): number {
  return Number(db.prepare("DELETE FROM memories WHERE delete_after IS NOT NULL AND delete_after <= ?").run(at.toISOString()).changes);
}

/** Real delete: the rows are removed and, with secure_delete on, overwritten on disk. */
export function deleteMemories(db: Db, userId: string, ids: string[]): number {
  return tx(db, () => {
    const del = db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?");
    let n = 0;
    for (const id of ids) n += Number(del.run(userId, id).changes);
    return n;
  });
}

export function listMemories(db: Db, userId: string): (StoredMemory & { updatedAt: string; deleteAfter: string | null })[] {
  return (db.prepare("SELECT id, folder_id, head, body, updated_at, delete_after FROM memories WHERE user_id = ? ORDER BY updated_at DESC, id").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    folderId: String(r.folder_id),
    head: String(r.head),
    body: String(r.body),
    updatedAt: String(r.updated_at),
    deleteAfter: str(r.delete_after),
  }));
}

export function vaultUsage(db: Db, userId: string) {
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM memories WHERE user_id = ?").get(userId) as Row;
  return { memories: Number(r.n), bytes: Number(r.bytes) };
}

// ---------------------------------------------------------------- apps

export function createApp(db: Db, userId: string, app: StoredApp): void {
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM apps WHERE id = ?").get(app.id)) throw new HttpError(409, "An app with this id already exists.");
    const active = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE user_id = ? AND revoked_at IS NULL").get(userId) as Row;
    if (Number(active.n) >= 50) throw new HttpError(400, "A vault can connect up to 50 apps at once.");
    db.prepare("INSERT INTO apps (id, user_id, meta, secret, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(app.id, userId, app.meta, app.secret, app.tokenHash, now());
    writeGrants(db, userId, app.id, app.grants);
  });
}

function writeGrants(db: Db, userId: string, appId: string, grants: StoredGrant[]): void {
  db.prepare("DELETE FROM grants WHERE app_id = ?").run(appId);
  const folderOk = db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?");
  const ins = db.prepare("INSERT INTO grants (app_id, user_id, folder_id, wrapped_key, created_at, mode) VALUES (?, ?, ?, ?, ?, ?)");
  const at = now();
  for (const g of grants) {
    if (!folderOk.get(userId, g.folderId)) throw new HttpError(400, "A permission points at a folder that does not exist.");
    ins.run(appId, userId, g.folderId, g.wrappedKey, at, g.mode === "write" ? "write" : "read");
  }
}

export function setGrants(db: Db, userId: string, appId: string, grants: StoredGrant[]): void {
  tx(db, () => {
    const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
    if (!app) throw new HttpError(404, "That app was not found.");
    if (app.revoked_at) throw new HttpError(400, "This app was revoked. Connect it again to give it access.");
    writeGrants(db, userId, appId, grants);
  });
}

/** Revoke: the app's token stops working at once and its wrapped folder keys are deleted. */
export function revokeApp(db: Db, userId: string, appId: string): void {
  tx(db, () => {
    const r = db.prepare("UPDATE apps SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL WHERE id = ? AND user_id = ?").run(now(), appId, userId);
    if (r.changes === 0) throw new HttpError(404, "That app was not found.");
    db.prepare("DELETE FROM grants WHERE app_id = ?").run(appId);
    db.prepare("DELETE FROM app_inbox WHERE app_id = ?").run(appId);
    db.prepare("DELETE FROM self_apps WHERE app_id = ?").run(appId);
    db.prepare("UPDATE ask_links SET revoked_at = COALESCE(revoked_at, ?) WHERE app_id = ?").run(now(), appId);
  });
}

export function deleteApp(db: Db, userId: string, appId: string): void {
  const r = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That app was not found.");
  if (!r.revoked_at) throw new HttpError(400, "Revoke the app before removing it.");
  db.prepare("DELETE FROM apps WHERE id = ? AND user_id = ?").run(appId, userId);
}

export function listApps(db: Db, userId: string) {
  const apps = db.prepare("SELECT * FROM apps WHERE user_id = ? ORDER BY created_at").all(userId) as Row[];
  const grants = db.prepare("SELECT folder_id, wrapped_key, mode FROM grants WHERE app_id = ? ORDER BY folder_id");
  return apps.map((a) => ({
    id: String(a.id),
    meta: String(a.meta),
    secret: String(a.secret),
    createdAt: String(a.created_at),
    revokedAt: str(a.revoked_at),
    lastUsedAt: str(a.last_used_at),
    grants: (grants.all(String(a.id)) as Row[]).map((g) => ({ folderId: String(g.folder_id), wrappedKey: String(g.wrapped_key), mode: g.mode === "write" ? ("write" as const) : ("read" as const) })),
  }));
}

export interface AppAuth {
  appId: string;
  userId: string;
}

export function appByToken(db: Db, token: string): AppAuth | null {
  const r = db.prepare("SELECT id, user_id FROM apps WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash(token)) as Row | undefined;
  if (!r) return null;
  db.prepare("UPDATE apps SET last_used_at = ? WHERE id = ?").run(now(), String(r.id));
  return { appId: String(r.id), userId: String(r.user_id) };
}

// ---------------------------------------------------------------- what a connected app may see

export function appFolders(db: Db, auth: AppAuth) {
  return (
    db
      .prepare(
        `SELECT f.id, f.meta, g.wrapped_key, g.mode, (SELECT COUNT(*) FROM memories m WHERE m.user_id = f.user_id AND m.folder_id = f.id) AS n
         FROM grants g JOIN folders f ON f.user_id = g.user_id AND f.id = g.folder_id
         WHERE g.app_id = ? AND g.user_id = ? ORDER BY f.created_at, f.id`,
      )
      .all(auth.appId, auth.userId) as Row[]
  ).map((r) => ({ id: String(r.id), meta: String(r.meta), wrappedKey: String(r.wrapped_key), count: Number(r.n), mode: r.mode === "write" ? ("write" as const) : ("read" as const) }));
}

export function appIndex(db: Db, auth: AppAuth) {
  return (
    db
      .prepare(
        `SELECT m.id, m.folder_id, m.head FROM memories m
         JOIN grants g ON g.user_id = m.user_id AND g.folder_id = m.folder_id
         WHERE g.app_id = ? AND m.user_id = ? ORDER BY m.updated_at DESC, m.id`,
      )
      .all(auth.appId, auth.userId) as Row[]
  ).map((r) => ({ id: String(r.id), folderId: String(r.folder_id), head: String(r.head) }));
}

export function appRead(db: Db, auth: AppAuth, ids: string[]) {
  const q = db.prepare(
    `SELECT m.id, m.folder_id, m.head, m.body FROM memories m
     JOIN grants g ON g.user_id = m.user_id AND g.folder_id = m.folder_id
     WHERE g.app_id = ? AND m.user_id = ? AND m.id = ?`,
  );
  const found: StoredMemory[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const r = q.get(auth.appId, auth.userId, id) as Row | undefined;
    if (r) found.push({ id: String(r.id), folderId: String(r.folder_id), head: String(r.head), body: String(r.body) });
    else missing.push(id);
  }
  return { found, missing };
}

// ---------------------------------------------------------------- read log

export function hourOf(ms: number, seconds = serverConfig.sealSeconds): number {
  return Math.floor(ms / 1000 / seconds);
}

export interface LogEntry {
  id: string;
  appId: string;
  kind: ReadKind;
  memoryId: string | null;
  count: number;
  at: string;
  salt: string;
  leaf: string;
  hour: number;
  sealed: boolean;
  /** For an answer of the AI self: the question and answer, sealed to the vault's public key. */
  note?: string | null;
}

export function logRead(db: Db, auth: AppAuth, kind: ReadKind, memoryId: string | null, count: number, at = new Date(), note: string | null = null): LogEntry {
  const entry = {
    id: randomId(),
    appId: auth.appId,
    kind,
    memoryId,
    count,
    at: at.toISOString(),
    salt: toHex(randomBytes(32)),
  };
  const leaf = hex32(readEntryLeaf(entry));
  const hour = hourOf(at.getTime());
  db.prepare("INSERT INTO read_log (id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    entry.id,
    auth.userId,
    entry.appId,
    kind,
    memoryId,
    count,
    entry.at,
    entry.salt,
    leaf,
    hour,
    note,
  );
  return { ...entry, leaf, hour, sealed: false, ...(note ? { note } : {}) };
}

function toEntry(r: Row): LogEntry {
  return {
    id: String(r.id),
    appId: String(r.app_id),
    kind: r.kind as ReadKind,
    memoryId: str(r.memory_id),
    count: Number(r.count),
    at: String(r.at),
    salt: String(r.salt),
    leaf: String(r.leaf),
    hour: Number(r.hour),
    sealed: Number(r.sealed) === 1,
    ...(r.note ? { note: String(r.note) } : {}),
  };
}

export function listLog(db: Db, userId: string, limit = 200, before?: string): LogEntry[] {
  const rows = before
    ? db.prepare("SELECT * FROM read_log WHERE user_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?").all(userId, before, limit)
    : db.prepare("SELECT * FROM read_log WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(userId, limit);
  return (rows as Row[]).map(toEntry);
}

export function logEntry(db: Db, userId: string, entryId: string): LogEntry | null {
  const r = db.prepare("SELECT * FROM read_log WHERE user_id = ? AND id = ?").get(userId, entryId) as Row | undefined;
  return r ? toEntry(r) : null;
}

// ---------------------------------------------------------------- account

/** Deletes the account and everything in it. Only the salted leaves of past seals remain, and without the salts they point to nothing. */
export function deleteAccount(db: Db, userId: string): void {
  tx(db, () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
}
