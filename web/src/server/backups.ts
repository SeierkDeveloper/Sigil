// Backups on the server: a line per bundle the owner's device or connector
// made and stored (its hash, its size and a record of where it went, sealed to
// the vault public key), and the connector the owner lets back up in the
// background, with its storage targets under a key from that app's secret.
// The node never stores a bundle for a backup, and never sees a storage token.

import { tx, type Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const BACKUP_RUNS_KEPT = 200;

export interface RunInput {
  id: string;
  hash: string;
  size: number;
  record: string;
  places: number;
}

function addRun(db: Db, userId: string, byApp: string | null, r: RunInput): void {
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM backup_runs WHERE id = ?").get(r.id)) throw new HttpError(409, "That backup was already recorded.");
    db.prepare("INSERT INTO backup_runs (id, user_id, by_app, hash, size, record, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.id, userId, byApp, r.hash, r.size, r.record, now());
    db.prepare(
      `DELETE FROM backup_runs WHERE user_id = ? AND id NOT IN (SELECT id FROM backup_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ${BACKUP_RUNS_KEPT})`,
    ).run(userId, userId);
    logRead(db, { appId: byApp ?? "vault", userId }, "backup", r.hash, r.places);
  });
}

export function recordRun(db: Db, userId: string, r: RunInput): void {
  addRun(db, userId, null, r);
}

export function recordAppRun(db: Db, auth: AppAuth, r: RunInput): void {
  appBackup(db, auth);
  addRun(db, auth.userId, auth.appId, r);
}

export function listRuns(db: Db, userId: string) {
  return (db.prepare("SELECT id, by_app, hash, size, record, created_at FROM backup_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    byApp: r.by_app == null ? null : String(r.by_app),
    hash: String(r.hash),
    size: Number(r.size),
    record: String(r.record),
    createdAt: String(r.created_at),
  }));
}

/** The owner lets a connector back up while it watches, or stops it. */
export function setBackupApp(db: Db, userId: string, appId: string, box: string | null): void {
  tx(db, () => {
    const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
    if (!app) throw new HttpError(404, "That app was not found.");
    if (box === null) {
      db.prepare("DELETE FROM backup_apps WHERE app_id = ?").run(appId);
      return;
    }
    if (app.revoked_at) throw new HttpError(400, "This app was revoked.");
    db.prepare("INSERT INTO backup_apps (app_id, user_id, box, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (app_id) DO UPDATE SET box = excluded.box, updated_at = excluded.updated_at").run(appId, userId, box, now());
  });
}

export function backupAppIds(db: Db, userId: string): Set<string> {
  return new Set((db.prepare("SELECT app_id FROM backup_apps WHERE user_id = ?").all(userId) as Row[]).map((r) => String(r.app_id)));
}

/** What the connector receives: its targets (under its own key) and when the vault was last backed up by anyone. */
export function appBackup(db: Db, auth: AppAuth): { box: string; lastAt: string | null } {
  const r = db.prepare("SELECT box FROM backup_apps WHERE app_id = ? AND user_id = ?").get(auth.appId, auth.userId) as Row | undefined;
  if (!r) throw new HttpError(403, "This app may not back up the vault. The owner can allow it in their vault, under Storage.", "backup_off");
  const last = db.prepare("SELECT MAX(created_at) AS at FROM backup_runs WHERE user_id = ?").get(auth.userId) as Row;
  return { box: String(r.box), lastAt: last.at == null ? null : String(last.at) };
}
