// Live sync sources on the server: two envelopes the server cannot open (the
// source under the vault key, and under a background connector's key), a
// revision number for each, the folder it writes to, and whether it is paused.
// The tokens, the service, the account and the cursor are all inside the
// envelopes. Disconnecting deletes the row, and with it the stored tokens.
//
// A connector the owner lets sync in the background writes through its own
// routes: only into the source's folder, every write logged as "sync".

import type { StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead, putMemoriesIn, type AppAuth } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const SOURCES_PER_VAULT = 20;
export const SYNC_WRITES_PER_HOUR = 2000;

export interface SyncSourceRow {
  id: string;
  folderId: string;
  ownerBox: string;
  ownerRev: number;
  appId: string | null;
  appBox: string | null;
  appRev: number;
  paused: boolean;
  lastSyncAt: string | null;
  createdAt: string;
}

function toSource(r: Row): SyncSourceRow {
  return {
    id: String(r.id),
    folderId: String(r.folder_id),
    ownerBox: String(r.owner_box),
    ownerRev: Number(r.owner_rev),
    appId: r.app_id == null ? null : String(r.app_id),
    appBox: r.app_box == null ? null : String(r.app_box),
    appRev: Number(r.app_rev),
    paused: Number(r.paused) === 1,
    lastSyncAt: r.last_sync_at == null ? null : String(r.last_sync_at),
    createdAt: String(r.created_at),
  };
}

export function listSources(db: Db, userId: string): SyncSourceRow[] {
  return (db.prepare("SELECT * FROM sync_sources WHERE user_id = ? ORDER BY created_at, id").all(userId) as Row[]).map(toSource);
}

function own(db: Db, userId: string, id: string): SyncSourceRow {
  const r = db.prepare("SELECT * FROM sync_sources WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That source was not found. It may have been disconnected.", "no_source");
  return toSource(r);
}

export function addSource(db: Db, userId: string, s: { id: string; folderId: string; ownerBox: string; rev: number }): void {
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM sync_sources WHERE id = ?").get(s.id)) throw new HttpError(409, "A source with this id already exists.");
    if (!db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?").get(userId, s.folderId)) throw new HttpError(400, "That folder does not exist.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM sync_sources WHERE user_id = ?").get(userId) as Row;
    if (Number(n.n) >= SOURCES_PER_VAULT) throw new HttpError(400, `A vault can keep up to ${SOURCES_PER_VAULT} sources in sync.`);
    db.prepare("INSERT INTO sync_sources (id, user_id, folder_id, owner_box, owner_rev, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.id, userId, s.folderId, s.ownerBox, s.rev, now());
  });
}

/** Saves the vault's copy after a pass or a change. A copy older than the one stored is refused, so two devices cannot step back each other's cursor. */
export function saveSource(db: Db, userId: string, id: string, s: { ownerBox: string; rev: number; appBox?: string | null; appRev?: number; synced?: boolean }): SyncSourceRow {
  return tx(db, () => {
    const cur = own(db, userId, id);
    if (s.rev <= cur.ownerRev) throw new HttpError(409, "A newer copy of this source is already saved.", "stale");
    const appBox = s.appBox !== undefined && cur.appId ? s.appBox : cur.appBox;
    const appRev = s.appBox !== undefined && cur.appId && s.appRev !== undefined ? s.appRev : cur.appRev;
    db.prepare("UPDATE sync_sources SET owner_box = ?, owner_rev = ?, app_box = ?, app_rev = ?, last_sync_at = COALESCE(?, last_sync_at) WHERE id = ?").run(
      s.ownerBox,
      s.rev,
      appBox,
      appRev,
      s.synced ? now() : null,
      id,
    );
    return own(db, userId, id);
  });
}

export function pauseSource(db: Db, userId: string, id: string, paused: boolean): void {
  own(db, userId, id);
  db.prepare("UPDATE sync_sources SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
}

/** Disconnect: the row goes, and with it both encrypted copies of the tokens. */
export function removeSource(db: Db, userId: string, id: string): void {
  const r = db.prepare("DELETE FROM sync_sources WHERE id = ? AND user_id = ?").run(id, userId);
  if (r.changes === 0) throw new HttpError(404, "That source was not found.");
}

/**
 * Lets a connector sync this source in the background: its copy of the source
 * and a grant to read and write the source's folder, in one step. Null stops it.
 */
export function setSourceApp(db: Db, userId: string, id: string, input: { appId: string; appBox: string; appRev: number; wrappedKey: string } | null): void {
  tx(db, () => {
    const cur = own(db, userId, id);
    if (!input) {
      db.prepare("UPDATE sync_sources SET app_id = NULL, app_box = NULL, app_rev = 0 WHERE id = ?").run(id);
      // The app no longer writes into the folder for this source: the write right it got for syncing goes back to read,
      // unless another source still syncs into the same folder through it.
      if (cur.appId) {
        const still = db.prepare("SELECT 1 FROM sync_sources WHERE user_id = ? AND app_id = ? AND folder_id = ? AND id != ?").get(userId, cur.appId, cur.folderId, id);
        if (!still) db.prepare("UPDATE grants SET mode = 'read' WHERE app_id = ? AND user_id = ? AND folder_id = ?").run(cur.appId, userId, cur.folderId);
      }
      return;
    }
    const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(input.appId, userId) as Row | undefined;
    if (!app) throw new HttpError(404, "That app was not found.");
    if (app.revoked_at) throw new HttpError(400, "This app was revoked.");
    db.prepare(
      `INSERT INTO grants (app_id, user_id, folder_id, wrapped_key, created_at, mode) VALUES (?, ?, ?, ?, ?, 'write')
       ON CONFLICT (app_id, folder_id) DO UPDATE SET wrapped_key = excluded.wrapped_key, mode = 'write'`,
    ).run(input.appId, userId, cur.folderId, input.wrappedKey, now());
    db.prepare("UPDATE sync_sources SET app_id = ?, app_box = ?, app_rev = ? WHERE id = ?").run(input.appId, input.appBox, input.appRev, id);
  });
}

// ---------------------------------------------------------------- the connector's side

export function appSources(db: Db, auth: AppAuth) {
  return (db.prepare("SELECT * FROM sync_sources WHERE app_id = ? AND user_id = ? ORDER BY created_at").all(auth.appId, auth.userId) as Row[]).map((r) => {
    const s = toSource(r);
    return { id: s.id, folderId: s.folderId, box: s.appBox, rev: s.appRev, ownerRev: s.ownerRev, paused: s.paused };
  });
}

function appSource(db: Db, auth: AppAuth, id: string): SyncSourceRow {
  const r = db.prepare("SELECT * FROM sync_sources WHERE id = ? AND user_id = ? AND app_id = ?").get(id, auth.userId, auth.appId) as Row | undefined;
  if (!r) throw new HttpError(403, "This app does not sync that source. The owner can allow it in their vault, under Sync.", "sync_off");
  return toSource(r);
}

export function saveAppSource(db: Db, auth: AppAuth, id: string, box: string, rev: number): void {
  tx(db, () => {
    const cur = appSource(db, auth, id);
    if (rev <= cur.appRev) throw new HttpError(409, "A newer copy of this source is already saved.", "stale");
    db.prepare("UPDATE sync_sources SET app_box = ?, app_rev = ?, last_sync_at = ? WHERE id = ?").run(box, rev, now(), id);
  });
}

/** Writes what a background pass fetched: only into the source's folder, never over a memory in another folder. */
export function syncWrite(db: Db, auth: AppAuth, id: string, memories: StoredMemory[], at = new Date()): number {
  return tx(db, () => {
    const src = appSource(db, auth, id);
    if (src.paused) throw new HttpError(409, "This source is paused.", "paused");
    const recent = db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM read_log WHERE app_id = ? AND kind = 'sync' AND at > ?").get(auth.appId, new Date(at.getTime() - 3600_000).toISOString()) as Row;
    if (Number(recent.n) + memories.length > SYNC_WRITES_PER_HOUR) throw new HttpError(429, `A source may write ${SYNC_WRITES_PER_HOUR} memories an hour.`, "sync_limit");
    const where = db.prepare("SELECT folder_id FROM memories WHERE user_id = ? AND id = ?");
    for (const m of memories) {
      if (m.folderId !== src.folderId) throw new HttpError(403, "A source writes only to its own folder.", "wrong_folder");
      const e = where.get(auth.userId, m.id) as Row | undefined;
      if (e && String(e.folder_id) !== src.folderId) throw new HttpError(403, "That memory is in another folder.", "wrong_folder");
    }
    putMemoriesIn(db, auth.userId, memories);
    logRead(db, auth, "sync", `wrote-${id}`, memories.length, at);
    return memories.length;
  });
}

export function syncDelete(db: Db, auth: AppAuth, id: string, ids: string[], at = new Date()): number {
  return tx(db, () => {
    const src = appSource(db, auth, id);
    const del = db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ? AND folder_id = ?");
    let n = 0;
    for (const m of ids) n += Number(del.run(auth.userId, m, src.folderId).changes);
    if (n) logRead(db, auth, "sync", `removed-${id}`, n, at);
    return n;
  });
}
