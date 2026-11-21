// The immune system's public test on this node: once an hour (a seal period),
// every strain runs against the AI self's pipeline and the round's record is
// kept. Its leaf goes into that hour's seal with the read log's leaves, so the
// record cannot be changed afterwards without the seal showing it.

import { createModelCaller, DEFAULT_MODELS, fromHex32, hex32, immuneLeaf, merkleTree, obedientStub, runImmuneRound, STRAINS_VERSION, type ImmuneRecord } from "@sigil/core";
import type { Db } from "./db";
import { serverConfig } from "./config";
import { hourOf } from "./store";

type Row = Record<string, unknown>;
let running = false;

export function immuneStatus(): { enabled: boolean; model: string | null } {
  const m = serverConfig.immuneModel;
  if (!m) return { enabled: false, model: null };
  return { enabled: true, model: m.kind === "stub" ? "stub" : `${m.provider}:${m.model || DEFAULT_MODELS[m.provider]}` };
}

/** Runs this hour's round when the test is on and it has not run yet. Returns the record it made, or null. */
export async function immuneTick(db: Db, nowMs = Date.now()): Promise<ImmuneRecord | null> {
  const m = serverConfig.immuneModel;
  if (!m || running) return null;
  const hour = hourOf(nowMs);
  if (db.prepare("SELECT 1 FROM immune_records WHERE hour = ?").get(hour)) return null;
  running = true;
  try {
    const model = m.kind === "stub" ? obedientStub() : createModelCaller({ provider: m.provider, apiKey: m.apiKey, model: m.model || DEFAULT_MODELS[m.provider] });
    const record = await runImmuneRound({ hour, periodSeconds: serverConfig.sealSeconds, model, modelLabel: immuneStatus().model! });
    // The hour may have been sealed while the round ran (a slow model at the end of an hour): then it is not kept, and the next hour runs again.
    if (db.prepare("SELECT 1 FROM seals WHERE hour = ?").get(hour)) return null;
    db.prepare("INSERT OR IGNORE INTO immune_records (hour, record, leaf, sealed, created_at) VALUES (?, ?, ?, 0, ?)").run(hour, JSON.stringify(record), immuneLeaf(record), new Date(nowMs).toISOString());
    return record;
  } finally {
    running = false;
  }
}

export interface PublishedRound {
  hour: number;
  record: ImmuneRecord;
  leaf: string;
  /** Once its hour is sealed: the root and the path from the leaf to it. */
  seal: { root: string; index: number; proof: string[] } | null;
}

/** The latest rounds, newest first, each with its proof once sealed. */
export function immuneRounds(db: Db, limit = 24): { enabled: boolean; model: string | null; strains: number; periodSeconds: number; rounds: PublishedRound[] } {
  const rows = db.prepare("SELECT hour, record, leaf, sealed FROM immune_records ORDER BY hour DESC LIMIT ?").all(limit) as Row[];
  const rounds = rows.map((r) => {
    const hour = Number(r.hour);
    let seal: PublishedRound["seal"] = null;
    if (Number(r.sealed) === 1) {
      const s = db.prepare("SELECT root FROM seals WHERE hour = ?").get(hour) as Row | undefined;
      const leaves = (db.prepare("SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx").all(hour) as Row[]).map((x) => String(x.leaf));
      const index = leaves.indexOf(String(r.leaf));
      if (s && index >= 0) seal = { root: String(s.root), index, proof: merkleTree(leaves.map(fromHex32)).proof(index).map(hex32) };
    }
    return { hour, record: JSON.parse(String(r.record)) as ImmuneRecord, leaf: String(r.leaf), seal };
  });
  return { ...immuneStatus(), strains: STRAINS_VERSION, periodSeconds: serverConfig.sealSeconds, rounds };
}
