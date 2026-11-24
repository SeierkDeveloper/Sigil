// Nightly backups of the node. Once a day the server copies its whole database
// into a new file beside it (SQLite's VACUUM INTO: one consistent copy, made
// while the node keeps answering), opens the copy, checks that it is whole and
// readable, and keeps the last seven nights. The copies hold exactly what the
// database holds: vaults are encrypted on their owners' devices, so a copy is
// ciphertext too. They sit on the same disk as the database, so they guard
// against a damaged file or a bad update, not against losing the disk.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";

/** How many nightly copies are kept. */
export const SNAPSHOTS_KEPT = 7;
/** The hour (UTC) from which the night's copy is made. */
export const SNAPSHOT_HOUR_UTC = 2;

const NAME = /^sigil-(\d{4}-\d{2}-\d{2})\.db$/;

export interface Snapshot {
  file: string;
  day: string;
  bytes: number;
  /** How long the copy and its check took, in milliseconds. */
  ms: number;
  /** The copy opened and SQLite found it whole. */
  ok: boolean;
  memories: number;
  vaults: number;
}

let last: Pick<Snapshot, "day" | "bytes" | "ok"> & { at: string } | null = null;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The folder the copies are kept in: beside the database. */
export function snapshotDir(dataFile: string): string {
  return path.join(path.dirname(dataFile), "snapshots");
}

/** The copies on disk, newest first. */
export function listSnapshots(dir: string): { file: string; day: string; bytes: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .map(({ name, m }) => ({ file: path.join(dir, name), day: m[1], bytes: statSync(path.join(dir, name)).size }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** Opens a copy on its own and checks it: SQLite's quick check, and the rows it holds. */
export function checkSnapshot(file: string): { ok: boolean; memories: number; vaults: number } {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    const ok = check.length === 1 && check[0].quick_check === "ok";
    const memories = Number((copy.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n);
    const vaults = Number((copy.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
    return { ok, memories, vaults };
  } finally {
    copy.close();
  }
}

/**
 * Makes the copy for this day, unless it exists, checks it and removes the
 * oldest beyond the seven kept. A copy that fails its check is deleted and
 * reported, never kept as if it were good.
 */
export function takeSnapshot(db: Db, dir: string, at = new Date(), keep = SNAPSHOTS_KEPT): Snapshot | null {
  const day = dayOf(at);
  const file = path.join(dir, `sigil-${day}.db`);
  if (existsSync(file)) return null;
  mkdirSync(dir, { recursive: true });
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const t = performance.now();
  db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
  const checked = checkSnapshot(part);
  const ms = Math.round(performance.now() - t);
  if (!checked.ok) {
    rmSync(part, { force: true });
    last = { day, bytes: 0, ok: false, at: at.toISOString() };
    return { file, day, bytes: 0, ms, ...checked };
  }
  renameSync(part, file);
  const bytes = statSync(file).size;
  for (const old of listSnapshots(dir).slice(keep)) rmSync(old.file, { force: true });
  last = { day, bytes, ok: true, at: at.toISOString() };
  return { file, day, bytes, ms, ...checked };
}

/** Called on the server's timer: makes the night's copy once the hour has come. */
export function snapshotTick(db: Db, dataFile: string, at = new Date()): Snapshot | null {
  if (dataFile === ":memory:" || at.getUTCHours() < SNAPSHOT_HOUR_UTC) return null;
  return takeSnapshot(db, snapshotDir(dataFile), at);
}

/** What the health check says about the last copy: its day, size and whether it passed. */
export function snapshotStatus(dataFile: string): { day: string; bytes: number; ok: boolean } | null {
  if (last) return { day: last.day, bytes: last.bytes, ok: last.ok };
  if (dataFile === ":memory:") return null;
  const newest = listSnapshots(snapshotDir(dataFile))[0];
  return newest ? { day: newest.day, bytes: newest.bytes, ok: true } : null;
}

/** Tests start from a clean state. */
export function resetSnapshotStatus(): void {
  last = null;
}
