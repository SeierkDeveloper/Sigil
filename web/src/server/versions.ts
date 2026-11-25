// Pinned versions of an agent's own folder. The database keeps a history of
// every change to a folder that is some agent's own (triggers on memories, so
// no write path can skip it): each remember, change or forget gives the folder
// its next version number and stores the encrypted memory as it then was. The
// folder at any version is the newest row of each memory up to that number,
// without the ones forgotten by then. A pin records that an agent keeps a
// pointer to a version, with the version's fingerprint over the ciphertext.
// Nothing here can read a memory: the history is ciphertext like the rest.

import { randomId, versionHash, vaultFingerprint, type MemoryPointer } from "@sigil/core";
import type { Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";
import { agentOf } from "./agents";

type Row = Record<string, unknown>;

const VERSIONED = "EXISTS (SELECT 1 FROM agents WHERE user_id = X.user_id AND home_folder_id = X.folder_id)";
const bump = (r: string) => `INSERT INTO folder_versions (user_id, folder_id, seq) VALUES (${r}.user_id, ${r}.folder_id, 1) ON CONFLICT (user_id, folder_id) DO UPDATE SET seq = seq + 1;`;
const record = (r: string, deleted: 0 | 1) =>
  `INSERT INTO memory_history (user_id, folder_id, seq, memory_id, head, body, deleted, at) VALUES (${r}.user_id, ${r}.folder_id, (SELECT seq FROM folder_versions WHERE user_id = ${r}.user_id AND folder_id = ${r}.folder_id), ${r}.id, ${deleted ? "NULL, NULL" : `${r}.head, ${r}.body`}, ${deleted}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`;

/** Tables and triggers for folder versions; existing agent folders get their memories as version 1, 2, ... once. */
export function trackVersions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folder_versions (user_id TEXT NOT NULL, folder_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, folder_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS memory_history (
      user_id TEXT NOT NULL, folder_id TEXT NOT NULL, seq INTEGER NOT NULL, memory_id TEXT NOT NULL,
      head TEXT, body TEXT, deleted INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL,
      PRIMARY KEY (user_id, folder_id, seq)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS memory_history_by_memory ON memory_history (user_id, folder_id, memory_id, seq);
    CREATE TABLE IF NOT EXISTS memory_pins (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, app_id TEXT NOT NULL, folder_id TEXT NOT NULL,
      seq INTEGER NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_pins_by_app ON memory_pins (app_id, created_at);
  `);
  const on = (who: string) => VERSIONED.replace(/X\./g, `${who}.`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS versions_insert AFTER INSERT ON memories WHEN ${on("NEW")} BEGIN ${bump("NEW")} ${record("NEW", 0)} END;`);
  // A memory that moved out of an agent's folder is gone from that folder's next version.
  db.exec(`CREATE TRIGGER IF NOT EXISTS versions_move_out AFTER UPDATE OF folder_id ON memories WHEN OLD.folder_id IS NOT NEW.folder_id AND ${on("OLD")} BEGIN ${bump("OLD")} ${record("OLD", 1)} END;`);
  // Only a change of content or folder makes a version; an expiry date alone does not.
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS versions_update AFTER UPDATE ON memories WHEN (NEW.head IS NOT OLD.head OR NEW.body IS NOT OLD.body OR NEW.folder_id IS NOT OLD.folder_id) AND ${on("NEW")} BEGIN ${bump("NEW")} ${record("NEW", 0)} END;`,
  );
  db.exec(`CREATE TRIGGER IF NOT EXISTS versions_delete AFTER DELETE ON memories WHEN ${on("OLD")} BEGIN ${bump("OLD")} ${record("OLD", 1)} END;`);

  // A vault deleted, or an agent removed: its versions and pins go with it, at once.
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS versions_vault_gone AFTER DELETE ON users BEGIN DELETE FROM memory_history WHERE user_id = OLD.id; DELETE FROM folder_versions WHERE user_id = OLD.id; DELETE FROM memory_pins WHERE user_id = OLD.id; END;",
  );
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS versions_agent_gone AFTER DELETE ON agents BEGIN DELETE FROM memory_history WHERE user_id = OLD.user_id AND folder_id = OLD.home_folder_id; DELETE FROM folder_versions WHERE user_id = OLD.user_id AND folder_id = OLD.home_folder_id; DELETE FROM memory_pins WHERE app_id = OLD.app_id; END;",
  );

  // Agent folders from before versions existed: what is in them now becomes their first versions, once.
  const folders = db
    .prepare("SELECT a.user_id, a.home_folder_id FROM agents a WHERE NOT EXISTS (SELECT 1 FROM folder_versions v WHERE v.user_id = a.user_id AND v.folder_id = a.home_folder_id)")
    .all() as Row[];
  for (const f of folders) {
    const rows = db.prepare("SELECT id, head, body, updated_at FROM memories WHERE user_id = ? AND folder_id = ? ORDER BY updated_at, id").all(f.user_id as string, f.home_folder_id as string) as Row[];
    if (!rows.length) continue;
    const ins = db.prepare("INSERT INTO memory_history (user_id, folder_id, seq, memory_id, head, body, deleted, at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
    rows.forEach((r, i) => ins.run(f.user_id as string, f.home_folder_id as string, i + 1, String(r.id), String(r.head), String(r.body), String(r.updated_at)));
    db.prepare("INSERT INTO folder_versions (user_id, folder_id, seq) VALUES (?, ?, ?)").run(f.user_id as string, f.home_folder_id as string, rows.length);
  }
}

/** The newest version number of a folder (0 before its first change). */
export function folderVersion(db: Db, userId: string, folderId: string): number {
  const r = db.prepare("SELECT seq FROM folder_versions WHERE user_id = ? AND folder_id = ?").get(userId, folderId) as Row | undefined;
  return Number(r?.seq ?? 0);
}

/** The folder exactly as it was at a version: each memory's newest row up to it, without those forgotten by then. */
export function memoriesAt(db: Db, userId: string, folderId: string, version: number): { id: string; folderId: string; head: string; body: string; updatedAt: string }[] {
  const rows = db
    .prepare(
      `SELECT h.memory_id, h.head, h.body, h.deleted, h.at FROM memory_history h
       JOIN (SELECT memory_id, MAX(seq) AS s FROM memory_history WHERE user_id = ? AND folder_id = ? AND seq <= ? GROUP BY memory_id) last
         ON h.memory_id = last.memory_id AND h.seq = last.s
       WHERE h.user_id = ? AND h.folder_id = ?
       ORDER BY h.memory_id`,
    )
    .all(userId, folderId, version, userId, folderId) as Row[];
  return rows.filter((r) => Number(r.deleted) === 0).map((r) => ({ id: String(r.memory_id), folderId, head: String(r.head), body: String(r.body), updatedAt: String(r.at) }));
}

function ownFolder(db: Db, auth: AppAuth): string {
  const a = agentOf(db, auth.appId);
  if (!a) throw new HttpError(403, "This app key is not an agent. Agents are made in the vault under Agents.", "not_agent");
  if (!a.rules.recall) throw new HttpError(403, "This agent may not read its memory back. The owner can allow it under Agents.", "recall_off");
  return a.homeFolderId;
}

function vaultId(db: Db, userId: string): string | null {
  const r = db.prepare("SELECT public_key FROM box_keys WHERE user_id = ?").get(userId) as Row | undefined;
  return r?.public_key ? vaultFingerprint(String(r.public_key)).replace(/ /g, "") : null;
}

/** The agent's own folder now: its version and fingerprint. */
export function currentVersion(db: Db, auth: AppAuth): { folder: string; version: number; hash: string } {
  const folder = ownFolder(db, auth);
  const version = folderVersion(db, auth.userId, folder);
  return { folder, version, hash: versionHash(memoriesAt(db, auth.userId, folder, version)) };
}

/** Pins the agent's folder as it is now and returns the pointer to keep. */
export function pinVersion(db: Db, auth: AppAuth, node: string, at = new Date()): MemoryPointer & { pinnedAt: string } {
  const { folder, version, hash } = currentVersion(db, auth);
  const pinnedAt = at.toISOString();
  db.prepare("INSERT INTO memory_pins (id, user_id, app_id, folder_id, seq, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomId(), auth.userId, auth.appId, folder, version, hash, pinnedAt);
  return { node, vault: vaultId(db, auth.userId), folder, version, hash, pinnedAt };
}

/** The agent's folder at a version, encrypted, with its fingerprint; the read is in the owner's log. */
export function versionFor(db: Db, auth: AppAuth, version: number, at = new Date()) {
  const folder = ownFolder(db, auth);
  const newest = folderVersion(db, auth.userId, folder);
  if (!Number.isInteger(version) || version < 0 || version > newest) throw new HttpError(404, `This folder has versions 0 to ${newest}.`, "no_version");
  const memories = memoriesAt(db, auth.userId, folder, version);
  logRead(db, auth, "read", null, memories.length, at);
  return { folder, version, newest, hash: versionHash(memories), memories };
}

/** Pins an owner can see under Agents. */
export function pinsOf(db: Db, userId: string, appId: string): { version: number; hash: string; pinnedAt: string }[] {
  return (db.prepare("SELECT seq, hash, created_at FROM memory_pins WHERE user_id = ? AND app_id = ? ORDER BY created_at DESC LIMIT 50").all(userId, appId) as Row[]).map((r) => ({
    version: Number(r.seq),
    hash: String(r.hash),
    pinnedAt: String(r.created_at),
  }));
}
