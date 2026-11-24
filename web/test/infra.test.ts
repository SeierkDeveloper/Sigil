// The node's upkeep: nightly checked backups, and an open vault that learns of
// changes with one small question that writes nothing.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, vaultStamp } from "../src/server/db";
import { checkSnapshot, listSnapshots, resetSnapshotStatus, snapshotStatus, snapshotTick, takeSnapshot, SNAPSHOTS_KEPT } from "../src/server/snapshots";
import { nextStep, LIVE_RELOAD_MAX_MEMORIES } from "../src/vault/useLiveVault";
import { harness, readerFor, signedUp } from "./helpers";
import * as ops from "../src/vault/ops";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sigil-infra-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSnapshotStatus();
});

describe("nightly backups", () => {
  const filled = () => {
    const dir = tempDir();
    const file = path.join(dir, "sigil.db");
    const db = openDb(file);
    db.prepare("INSERT INTO users (id, created_at) VALUES ('u1', '')").run();
    db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES ('u1', 'f1', 'x', 'k', '', '')").run();
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO memories (user_id, id, folder_id, head, body, size, created_at, updated_at) VALUES ('u1', ?, 'f1', 'h', 'b', 1, '', '')").run(`m${i}`);
    }
    return { db, file, dir };
  };

  it("copies the whole database once a day, checks the copy and reports it", () => {
    const { db, file } = filled();
    const at = new Date("2026-11-25T02:10:00Z");
    const snap = snapshotTick(db, file, at)!;
    expect(snap).toMatchObject({ day: "2026-11-25", ok: true, memories: 50, vaults: 1 });
    expect(snap.bytes).toBeGreaterThan(0);
    expect(checkSnapshot(snap.file)).toEqual({ ok: true, memories: 50, vaults: 1 });
    // The same night again does nothing.
    expect(snapshotTick(db, file, new Date("2026-11-25T03:10:00Z"))).toBeNull();
    expect(snapshotStatus(file)).toEqual({ day: "2026-11-25", bytes: snap.bytes, ok: true });
    db.close();
  });

  it("waits for the night hour and never copies a database kept in memory", () => {
    const { db, file } = filled();
    expect(snapshotTick(db, file, new Date("2026-11-25T01:59:00Z"))).toBeNull();
    expect(snapshotTick(openDb(":memory:"), ":memory:", new Date("2026-11-25T04:00:00Z"))).toBeNull();
    db.close();
  });

  it("keeps the last seven nights and removes older copies", () => {
    const { db, dir } = filled();
    const snaps = path.join(dir, "snapshots");
    for (let d = 1; d <= 10; d++) takeSnapshot(db, snaps, new Date(Date.UTC(2026, 10, d, 3)));
    const kept = listSnapshots(snaps).map((s) => s.day);
    expect(kept).toHaveLength(SNAPSHOTS_KEPT);
    expect(kept[0]).toBe("2026-11-10");
    expect(kept.at(-1)).toBe("2026-11-04");
    db.close();
  });

  it("never keeps a copy that fails its check", () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad.db");
    writeFileSync(bad, "SQLite format 3\0" + "x".repeat(4096));
    expect(() => checkSnapshot(bad)).toThrow();
    expect(readdirSync(dir).filter((f) => f.startsWith("sigil-"))).toEqual([]);
  });

  it("leaves no half-written file behind", () => {
    const { db, dir } = filled();
    const snaps = path.join(dir, "snapshots");
    takeSnapshot(db, snaps, new Date("2026-11-25T02:00:00Z"));
    expect(readdirSync(snaps).some((f) => f.endsWith(".part"))).toBe(false);
    expect(existsSync(path.join(snaps, "sigil-2026-11-25.db"))).toBe(true);
    db.close();
  });
});

describe("a vault that keeps itself up to date", () => {
  it("moves the counter when an app or agent writes, not when an app is only used", async () => {
    const h = harness();
    const s = await signedUp(h);
    const userId = String((h.db.prepare("SELECT id FROM users").get() as { id: string }).id);
    const start = vaultStamp(h.db, userId);
    const notes = s.data.folders[0];
    const m = await ops.createMemory(s.b.api, notes, { title: "Seeded data", body: "Run the seed script first." });
    const afterWrite = vaultStamp(h.db, userId);
    expect(afterWrite.vault).toBeGreaterThan(start.vault);
    await ops.deleteMemories(s.b.api, [m.id]);
    expect(vaultStamp(h.db, userId).vault).toBeGreaterThan(afterWrite.vault);
    // An app's last use is written on every call; that alone is not a change of the vault.
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [notes]);
    const beforeUse = vaultStamp(h.db, userId);
    await readerFor(h, appKey).listFolders();
    const afterUse = vaultStamp(h.db, userId);
    expect(afterUse.vault).toBe(beforeUse.vault);
    // ...but the read it made is a new line in the log.
    expect(afterUse.log).not.toBe(beforeUse.log);
  });

  it("answers the owner only, writes nothing and does not count as the owner being active", async () => {
    const h = harness();
    const s = await signedUp(h);
    h.db.prepare("UPDATE users SET last_active_at = '2026-01-01T00:00:00.000Z'").run();
    const res = await s.b.fetcher("/api/vault/changes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vault: number; log: string };
    expect(typeof body.vault).toBe("number");
    expect(typeof body.log).toBe("string");
    expect(String((h.db.prepare("SELECT last_active_at FROM users").get() as { last_active_at: string }).last_active_at)).toBe("2026-01-01T00:00:00.000Z");
    const stranger = await h.browser().fetcher("/api/vault/changes");
    expect(stranger.status).toBe(401);
  });

  it("reloads when the vault moved, refreshes the log when the log moved, and waits while the owner types", () => {
    const a = { vault: 3, log: "x" };
    expect(nextStep(null, a, { memories: 10, typing: false })).toEqual({ reload: false, log: false, keep: a });
    expect(nextStep(a, a, { memories: 10, typing: false })).toEqual({ reload: false, log: false, keep: a });
    expect(nextStep(a, { vault: 4, log: "x" }, { memories: 10, typing: false })).toMatchObject({ reload: true, log: false });
    expect(nextStep(a, { vault: 3, log: "y" }, { memories: 10, typing: false })).toMatchObject({ reload: false, log: true });
    // Typing: the reload waits, and the old counter is kept so the next check tries again.
    expect(nextStep(a, { vault: 4, log: "y" }, { memories: 10, typing: true })).toEqual({ reload: false, log: true, keep: { vault: 3, log: "y" } });
    // A very large vault is not decrypted again on its own.
    expect(nextStep(a, { vault: 4, log: "x" }, { memories: LIVE_RELOAD_MAX_MEMORIES + 1, typing: false }).reload).toBe(false);
  });
});
