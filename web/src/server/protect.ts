// Protected folders on the server. The server cannot read a folder, but it
// holds every folder's ciphertext, so it is the one place that can refuse to
// hand a protected folder to an app, an agent or a link without the owner's
// fresh yes. Every such read is logged with its own kind, so it is marked in
// the read log and in the hourly seal.
//
//   an app asks         the request waits in the owner's inbox (pending)
//   the owner says yes  it is approved for a few minutes (APPROVAL_MINUTES)
//   the app asks again  the approval is used up by that one read
//
// In the owner's own browser (the AI self answering links, the public page,
// another self) the keys are there already; the vault asks the same way and
// marks the approval used when it reads, so the record is the same.

import { APPROVAL_MINUTES, randomId, REQUEST_MINUTES } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";

type Row = Record<string, unknown>;

export type RequesterKind = "app" | "link" | "public" | "meet" | "self";
export type AccessScope = "read" | "index";
export type AccessState = "pending" | "approved" | "denied" | "used";

export interface AccessRequest {
  id: string;
  requester: string;
  requesterKind: RequesterKind;
  folderId: string;
  memoryIds: string[];
  scope: AccessScope;
  state: AccessState;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  usedAt: string | null;
}

const MIN = 60_000;
/** Requests waiting for an answer at once, per vault. Older ones are let go first. */
export const PENDING_LIMIT = 100;

function toRequest(r: Row): AccessRequest {
  return {
    id: String(r.id),
    requester: String(r.requester),
    requesterKind: r.requester_kind as RequesterKind,
    folderId: String(r.folder_id),
    memoryIds: JSON.parse(String(r.memory_ids)) as string[],
    scope: r.scope as AccessScope,
    state: r.state as AccessState,
    createdAt: new Date(Number(r.created_at)).toISOString(),
    expiresAt: new Date(Number(r.expires_at)).toISOString(),
    answeredAt: r.answered_at == null ? null : new Date(Number(r.answered_at)).toISOString(),
    usedAt: r.used_at == null ? null : new Date(Number(r.used_at)).toISOString(),
  };
}

// ---------------------------------------------------------------- the flag

export function protectedIds(db: Db, userId: string): Set<string> {
  return new Set((db.prepare("SELECT folder_id FROM protected_folders WHERE user_id = ?").all(userId) as Row[]).map((r) => String(r.folder_id)));
}

/** Turns protection on or off, together with the folder's new encrypted meta (which says what kind it is). */
export function setProtected(db: Db, userId: string, folderId: string, on: boolean, meta: string): void {
  tx(db, () => {
    const r = db.prepare("UPDATE folders SET meta = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(meta, new Date().toISOString(), userId, folderId);
    if (r.changes === 0) throw new HttpError(404, "That folder was not found.");
    if (on) db.prepare("INSERT OR IGNORE INTO protected_folders (user_id, folder_id, created_at) VALUES (?, ?, ?)").run(userId, folderId, new Date().toISOString());
    else {
      db.prepare("DELETE FROM protected_folders WHERE user_id = ? AND folder_id = ?").run(userId, folderId);
      db.prepare("DELETE FROM access_requests WHERE user_id = ? AND folder_id = ? AND state IN ('pending', 'approved')").run(userId, folderId);
    }
  });
}

// ---------------------------------------------------------------- requests

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** Lets go of requests nobody answered in time and approvals nobody used. */
export function expireRequests(db: Db, at = Date.now()): void {
  db.prepare("DELETE FROM access_requests WHERE state IN ('pending', 'approved') AND expires_at <= ?").run(at);
  db.prepare("DELETE FROM access_requests WHERE state IN ('denied', 'used') AND created_at <= ?").run(at - 7 * 86_400_000);
}

export interface RequestInput {
  id?: string;
  requester: string;
  requesterKind: RequesterKind;
  folderId: string;
  memoryIds: string[];
  scope: AccessScope;
}

/** Makes a request, or returns the one already waiting for the same read. */
export function requestAccess(db: Db, userId: string, input: RequestInput, at = Date.now()): AccessRequest {
  return tx(db, () => {
    expireRequests(db, at);
    if (!db.prepare("SELECT 1 FROM protected_folders WHERE user_id = ? AND folder_id = ?").get(userId, input.folderId)) {
      throw new HttpError(400, "That folder is not protected.", "not_protected");
    }
    const ids = [...new Set(input.memoryIds)].slice(0, 50);
    const waiting = (
      db
        .prepare("SELECT * FROM access_requests WHERE user_id = ? AND requester = ? AND folder_id = ? AND scope = ? AND state = 'pending'")
        .all(userId, input.requester, input.folderId, input.scope) as Row[]
    ).map(toRequest);
    const same = waiting.find((w) => sameIds(w.memoryIds, ids));
    if (same) return same;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE user_id = ? AND state = 'pending'").get(userId) as Row;
    if (Number(pending.n) >= PENDING_LIMIT) {
      db.prepare("DELETE FROM access_requests WHERE id IN (SELECT id FROM access_requests WHERE user_id = ? AND state = 'pending' ORDER BY created_at LIMIT 10)").run(userId);
    }
    const id = input.id ?? randomId();
    if (db.prepare("SELECT 1 FROM access_requests WHERE id = ?").get(id)) throw new HttpError(409, "A request with this id already exists.");
    db.prepare(
      "INSERT INTO access_requests (id, user_id, requester, requester_kind, folder_id, memory_ids, scope, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, userId, input.requester, input.requesterKind, input.folderId, JSON.stringify(ids), input.scope, at, at + REQUEST_MINUTES * MIN);
    return toRequest(db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as Row);
  });
}

export function listRequests(db: Db, userId: string, at = Date.now()): AccessRequest[] {
  expireRequests(db, at);
  return (db.prepare("SELECT * FROM access_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").all(userId) as Row[]).map(toRequest);
}

/** The owner's yes or no. A yes lasts APPROVAL_MINUTES and is used up by one read. Both are logged. */
export function answerRequest(db: Db, userId: string, requestId: string, approve: boolean, at = Date.now()): AccessRequest {
  return tx(db, () => {
    expireRequests(db, at);
    const r = db.prepare("SELECT * FROM access_requests WHERE id = ? AND user_id = ?").get(requestId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That request was not found. It may have expired.", "no_request");
    if (r.state !== "pending") throw new HttpError(409, "That request was already answered.", "answered");
    db.prepare("UPDATE access_requests SET state = ?, answered_at = ?, expires_at = ? WHERE id = ?").run(
      approve ? "approved" : "denied",
      at,
      approve ? at + APPROVAL_MINUTES * MIN : Number(r.expires_at),
      requestId,
    );
    logRead(db, { appId: String(r.requester), userId }, "approval", `${approve ? "approved" : "denied"}-${requestId}`, JSON.parse(String(r.memory_ids)).length, new Date(at));
    return toRequest(db.prepare("SELECT * FROM access_requests WHERE id = ?").get(requestId) as Row);
  });
}

/**
 * Finds an approval that covers this read and uses it up. An approval for named
 * memories covers those; one with no names covers the folder's list.
 */
export function takeApproval(db: Db, userId: string, requester: string, folderId: string, scope: AccessScope, memoryIds: string[], at = Date.now()): AccessRequest | null {
  const rows = (
    db
      .prepare("SELECT * FROM access_requests WHERE user_id = ? AND requester = ? AND folder_id = ? AND scope = ? AND state = 'approved' AND expires_at > ? ORDER BY answered_at")
      .all(userId, requester, folderId, scope, at) as Row[]
  ).map(toRequest);
  const fit = rows.find((r) => (scope === "index" ? true : memoryIds.every((id) => r.memoryIds.length === 0 || r.memoryIds.includes(id))));
  if (!fit) return null;
  db.prepare("UPDATE access_requests SET state = 'used', used_at = ? WHERE id = ?").run(at, fit.id);
  return { ...fit, state: "used", usedAt: new Date(at).toISOString() };
}

/**
 * The owner's device read a protected folder with an approval it was given (the
 * AI self answering a link, the public page or another self): the approval is
 * used up and each memory read is logged.
 */
export function useApproval(db: Db, userId: string, requestId: string, memoryIds: string[], at = Date.now()): void {
  tx(db, () => {
    const r = db.prepare("SELECT * FROM access_requests WHERE id = ? AND user_id = ?").get(requestId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That request was not found.", "no_request");
    const req = toRequest(r);
    if (req.state !== "approved" || Date.parse(req.expiresAt) <= at) throw new HttpError(409, "That approval is not open (used, expired or not given).", "not_approved");
    if (req.memoryIds.length && !memoryIds.every((id) => req.memoryIds.includes(id))) throw new HttpError(403, "Those memories were not part of the approval.", "not_approved");
    const inFolder = db.prepare("SELECT 1 FROM memories WHERE user_id = ? AND id = ? AND folder_id = ?");
    for (const id of memoryIds) if (!inFolder.get(userId, id, req.folderId)) throw new HttpError(400, "A memory is not in the approved folder.", "invalid");
    db.prepare("UPDATE access_requests SET state = 'used', used_at = ? WHERE id = ?").run(at, requestId);
    const auth = { appId: req.requester, userId };
    for (const id of memoryIds) logRead(db, auth, "protected", id, 1, new Date(at));
  });
}

// ---------------------------------------------------------------- what an app is handed

export interface Held {
  folderId: string;
  memoryIds: string[];
  requestId: string;
  state: AccessState;
}

/**
 * Splits what an app asked to read: memories in protected folders are handed
 * over only with an approval for that read (used up here, each read logged as
 * protected); for the rest a request waits in the owner's inbox.
 */
export function gateRead<T extends { id: string; folderId: string }>(db: Db, auth: AppAuth, found: T[], at = Date.now()): { open: T[]; protectedRead: T[]; held: Held[] } {
  const guarded = protectedIds(db, auth.userId);
  if (guarded.size === 0) return { open: found, protectedRead: [], held: [] };
  const open: T[] = [];
  const byFolder = new Map<string, T[]>();
  for (const m of found) {
    if (guarded.has(m.folderId)) byFolder.set(m.folderId, [...(byFolder.get(m.folderId) ?? []), m]);
    else open.push(m);
  }
  const protectedRead: T[] = [];
  const held: Held[] = [];
  for (const [folderId, list] of byFolder) {
    const ids = list.map((m) => m.id);
    const ok = takeApproval(db, auth.userId, auth.appId, folderId, "read", ids, at);
    if (ok) {
      protectedRead.push(...list);
      continue;
    }
    const req = requestAccess(db, auth.userId, { requester: auth.appId, requesterKind: "app", folderId, memoryIds: ids, scope: "read" }, at);
    held.push({ folderId, memoryIds: ids, requestId: req.id, state: req.state });
  }
  return { open, protectedRead, held };
}
