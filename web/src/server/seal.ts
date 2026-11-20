// The hourly seal. Once an hour is over, every read-log leaf from that hour goes
// into one Merkle tree and its root is stored as that hour's seal. A seal never
// changes after it is written. Publishing roots on chain is a separate step
// (anchor.ts) that stays off unless SIGIL_ANCHOR is turned on.

import { fromHex32, hex32, merkleProof, merkleRoot } from "@sigil/core";
import { tx, type Db } from "./db";
import { hourOf, type LogEntry } from "./store";
import { serverConfig } from "./config";

export interface SealRow {
  hour: number;
  root: string;
  leaves: number;
  sealedAt: string;
  anchorTx: string | null;
  anchoredAt: string | null;
}

type Row = Record<string, unknown>;

function toSeal(r: Row): SealRow {
  return {
    hour: Number(r.hour),
    root: String(r.root),
    leaves: Number(r.leaves),
    sealedAt: String(r.sealed_at),
    anchorTx: r.anchor_tx == null ? null : String(r.anchor_tx),
    anchoredAt: r.anchored_at == null ? null : String(r.anchored_at),
  };
}

/** Seals every finished hour that has unsealed entries. Safe to call often; returns the new seals. */
export function sealPending(db: Db, nowMs = Date.now()): SealRow[] {
  if (!serverConfig.sealsEnabled) return [];
  const current = hourOf(nowMs);
  const hours = (db.prepare("SELECT DISTINCT hour FROM read_log WHERE sealed = 0 AND hour < ? ORDER BY hour").all(current) as Row[]).map((r) => Number(r.hour));
  const made: SealRow[] = [];
  for (const hour of hours) {
    const seal = tx(db, () => {
      if (db.prepare("SELECT 1 FROM seals WHERE hour = ?").get(hour)) {
        // Cannot happen in normal operation (entries are only written for the current hour).
        // Leave such entries unsealed rather than change a published seal.
        return null;
      }
      const rows = db.prepare("SELECT leaf FROM read_log WHERE hour = ? AND sealed = 0 ORDER BY at, id").all(hour) as Row[];
      if (rows.length === 0) return null;
      const leaves = rows.map((r) => String(r.leaf));
      const root = hex32(merkleRoot(leaves.map(fromHex32)));
      const sealedAt = new Date(nowMs).toISOString();
      db.prepare("INSERT INTO seals (hour, root, leaves, sealed_at) VALUES (?, ?, ?, ?)").run(hour, root, leaves.length, sealedAt);
      const ins = db.prepare("INSERT INTO seal_leaves (hour, idx, leaf) VALUES (?, ?, ?)");
      leaves.forEach((leaf, idx) => ins.run(hour, idx, leaf));
      db.prepare("UPDATE read_log SET sealed = 1 WHERE hour = ? AND sealed = 0").run(hour);
      return { hour, root, leaves: leaves.length, sealedAt, anchorTx: null, anchoredAt: null } satisfies SealRow;
    });
    if (seal) made.push(seal);
  }
  return made;
}

export function listSeals(db: Db, limit = 48): SealRow[] {
  return (db.prepare("SELECT * FROM seals ORDER BY hour DESC LIMIT ?").all(limit) as Row[]).map(toSeal);
}

export function getSeal(db: Db, hour: number): SealRow | null {
  const r = db.prepare("SELECT * FROM seals WHERE hour = ?").get(hour) as Row | undefined;
  return r ? toSeal(r) : null;
}

export function sealStats(db: Db) {
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(leaves), 0) AS leaves, MAX(hour) AS latest FROM seals").get() as Row;
  return { seals: Number(r.n), leaves: Number(r.leaves), latestHour: r.latest == null ? null : Number(r.latest) };
}

export interface ProofResult {
  hour: number;
  root: string;
  leaf: string;
  index: number;
  proof: string[];
}

/** Proof that a sealed log entry is part of its hour's seal. */
export function proofFor(db: Db, entry: LogEntry): (ProofResult & { origin?: string; periodSeconds?: number }) | null {
  if (!entry.sealed) return null;
  if (entry.carried) {
    // Sealed on the node the vault came from: its proof travelled with it, against that node's root.
    if (!("root" in entry.carried)) return null;
    const c = entry.carried;
    return { hour: entry.hour, root: c.root, leaf: entry.leaf, index: c.index, proof: c.proof, origin: c.origin, periodSeconds: c.periodSeconds };
  }
  return proofForLeaf(db, entry.hour, entry.leaf);
}

/** Proof for a leaf by its fingerprint alone. Public: a leaf is a salted hash and says nothing about the read behind it. */
export function proofForLeaf(db: Db, hour: number, leaf: string): ProofResult | null {
  const seal = getSeal(db, hour);
  if (!seal) return null;
  const leaves = (db.prepare("SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx").all(hour) as Row[]).map((r) => String(r.leaf));
  const index = leaves.indexOf(leaf);
  if (index < 0) return null;
  return {
    hour,
    root: seal.root,
    leaf,
    index,
    proof: merkleProof(leaves.map(fromHex32), index).map(hex32),
  };
}

/** How the seal job stands: reads waiting for the current period to end, and reads from finished periods not sealed yet. */
export function sealQueue(db: Db, nowMs = Date.now()) {
  const current = hourOf(nowMs);
  const r = db
    .prepare("SELECT COALESCE(SUM(hour >= ?), 0) AS open, COALESCE(SUM(hour < ?), 0) AS overdue FROM read_log WHERE sealed = 0")
    .get(current, current) as Row;
  const last = db.prepare("SELECT hour, sealed_at FROM seals ORDER BY hour DESC LIMIT 1").get() as Row | undefined;
  return {
    currentHour: current,
    open: Number(r.open),
    overdue: Number(r.overdue),
    lastSealedAt: last ? String(last.sealed_at) : null,
  };
}

/**
 * The public counters. Counts only: nothing here names a person, a vault or a memory.
 * Reads are counted from the seals plus the entries not sealed yet, so the number
 * does not drop when someone deletes their vault.
 */
export function publicStats(db: Db) {
  const one = (sql: string) => Number((db.prepare(sql).get() as Row).n);
  const sealed = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(leaves), 0) AS leaves FROM seals").get() as Row;
  return {
    vaults: one("SELECT COUNT(*) AS n FROM users"),
    memories: one("SELECT COUNT(*) AS n FROM memories"),
    apps: one("SELECT COUNT(*) AS n FROM apps WHERE revoked_at IS NULL"),
    reads: Number(sealed.leaves) + one("SELECT COUNT(*) AS n FROM read_log WHERE sealed = 0"),
    seals: Number(sealed.n),
  };
}

export function markAnchored(db: Db, hours: number[], txHash: string): void {
  const at = new Date().toISOString();
  const upd = db.prepare("UPDATE seals SET anchor_tx = ?, anchored_at = ? WHERE hour = ? AND anchor_tx IS NULL");
  for (const h of hours) upd.run(txHash, at, h);
}

export function unanchoredSeals(db: Db, limit = 24): SealRow[] {
  return (db.prepare("SELECT * FROM seals WHERE anchor_tx IS NULL ORDER BY hour LIMIT ?").all(limit) as Row[]).map(toSeal);
}
