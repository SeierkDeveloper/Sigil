// The upkeep check: on a node database the size of a 100,000-memory vault (in a
// real file, as on the node), how long the nightly backup and its check take,
// and what an open vault's "anything changed?" costs next to loading the whole
// vault again. Run with `npm run perf:infra`; timings go to perf/last-infra.json.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDb, vaultStamp } from "../src/server/db";
import { listMemories } from "../src/server/store";
import { takeSnapshot } from "../src/server/snapshots";

const N = Number(process.env.SIGIL_PERF_MEMORIES ?? 100_000);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe(`upkeep on a ${N.toLocaleString("en-US")} memory vault in a file`, () => {
  it("times the nightly backup and the change check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sigil-infra-"));
    const file = path.join(dir, "sigil.db");
    const db = openDb(file);
    db.prepare("INSERT INTO users (id, created_at) VALUES ('u1', '')").run();
    db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES ('u1', 'f1', 'x', 'k', '', '')").run();
    // Ciphertext of the size the vault check measures (about 1.7 KB a memory), and two log lines per memory.
    const ins = db.prepare("INSERT INTO memories (user_id, id, folder_id, head, body, size, created_at, updated_at) VALUES ('u1', ?, 'f1', ?, ?, ?, ?, ?)");
    const log = db.prepare("INSERT INTO read_log (id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed) VALUES (?, 'u1', 'a1', 'read', ?, 1, ?, 's', 'l', 0, 1)");
    db.exec("BEGIN");
    for (let i = 0; i < N; i++) {
      const at = new Date(Date.UTC(2021, 0, 1) + i * 1_500_000).toISOString();
      ins.run(`m${i}`, randomBytes(150).toString("base64"), randomBytes(1100).toString("base64"), 1700, at, at);
      log.run(`l${i}a`, `m${i}`, at);
      log.run(`l${i}b`, `m${i}`, at);
    }
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const dbBytes = statSync(file).size;

    const snap = takeSnapshot(db, path.join(dir, "snapshots"), new Date("2026-11-25T02:00:00Z"))!;

    const checks: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      vaultStamp(db, "u1");
      checks.push(performance.now() - t);
    }
    const stampBytes = JSON.stringify(vaultStamp(db, "u1")).length;

    const loads: number[] = [];
    let vaultBytes = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      vaultBytes = JSON.stringify({ memories: listMemories(db, "u1") }).length;
      loads.push(performance.now() - t);
    }

    const out = {
      memories: N,
      dbBytes,
      backup: { ms: snap.ms, bytes: snap.bytes, ok: snap.ok, memoriesInCopy: snap.memories },
      changeCheck: { median_ms: +median(checks).toFixed(3), bytes: stampBytes },
      fullLoad: { median_ms: Math.round(median(loads)), bytes: vaultBytes },
      at: new Date().toISOString(),
    };
    writeFileSync(path.join(import.meta.dirname, "last-infra.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
    db.close();
    rmSync(dir, { recursive: true, force: true });
    expect(snap.ok).toBe(true);
    expect(snap.memories).toBe(N);
  });
});
