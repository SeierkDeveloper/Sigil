// The database engine: compiled statements are reused, and the hourly upkeep
// removes only what has run out.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { housekeeping, openDb } from "../src/server/db";
import { count } from "./helpers";

describe("the engine", () => {
  it("compiles a query once and reuses it", () => {
    const db = openDb(":memory:");
    const a = db.prepare("SELECT COUNT(*) AS n FROM users");
    const b = db.prepare("SELECT COUNT(*) AS n FROM users");
    expect(a).toBe(b);
    expect(db.prepare("SELECT 1 AS n")).not.toBe(a);
  });

  it("keeps a bounded number of statements for SQL built at run time", () => {
    const db = openDb(":memory:");
    const first = db.prepare("SELECT 0 AS n");
    for (let i = 1; i <= 600; i++) db.prepare(`SELECT ${i} AS n`);
    expect(db.prepare("SELECT 0 AS n")).not.toBe(first);
    expect((db.prepare("SELECT 0 AS n").get() as { n: number }).n).toBe(0);
  });

  it("removes expired sessions and challenges, and keeps the live ones", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.prepare("INSERT INTO users (id, created_at) VALUES ('u1', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('old', 'u1', '', ?)").run(now - 1000);
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('live', 'u1', '', ?)").run(now + 60_000);
    db.prepare("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES ('c-old', 'x', 'login', ?)").run(now - 1000);
    db.prepare("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES ('c-live', 'x', 'login', ?)").run(now + 60_000);
    expect(housekeeping(db, now)).toEqual({ sessions: 1, challenges: 1 });
    expect(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'live'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM challenges WHERE id = 'c-live'")).toBe(1);
  });

  it("folds the write-ahead log back into the database file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sigil-engine-"));
    try {
      const file = path.join(dir, "sigil.db");
      const db = openDb(file);
      db.prepare("INSERT INTO users (id, created_at) VALUES ('u1', '')").run();
      expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
      housekeeping(db);
      expect(statSync(`${file}-wal`).size).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
