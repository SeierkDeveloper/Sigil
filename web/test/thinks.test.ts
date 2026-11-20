// Memory that thinks, and local imports, through the real server: the weekly
// brief saved encrypted, memories that expire and are deleted for real after
// the grace period, duplicate groups merged in one step, contradictions found,
// and an Obsidian import with dedupe. Plus the read log migration.

import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dedupeDrafts, parseObsidianVault, parseTakeout, type ModelCaller } from "@sigil/core";
import { obsidianFiles, takeoutZip } from "../../packages/core/test/fixtures/local";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as think from "../src/vault/thinkOps";
import * as self from "../src/vault/selfOps";
import { openDb } from "../src/server/db";
import { purgeExpired } from "../src/server/store";

const CANARY = "CANARY-thinks-6c2a";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const model = (text: string): ModelCaller => ({ provider: "anthropic", model: "claude-opus-5-5", complete: async () => text });

describe("the weekly brief", () => {
  it("is written on the device and saved encrypted into a Briefs folder", async () => {
    const s = await signedUp(h);
    await ops.createMemory(s.b.api, s.data.folders[0], { title: `Garden ${CANARY}`, body: "Planted tomatoes." });
    let data = await ops.loadVault(s.b.api, s.vault);
    // A vault younger than a week has no week to look back on, so no brief is made on its own yet.
    expect(think.shouldMakeBrief(data)).toBe(false);
    expect(think.shouldMakeBrief(data, new Date(Date.now() + 8 * 86_400_000))).toBe(true);
    const made = await think.makeBrief(s.b.api, s.vault, data, null);
    expect(made.createdFolder).toBe(true);
    expect(made.usedModel).toBe(false);
    expect(made.memory.title).toMatch(/^Weekly brief, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    expect(made.memory.body).toContain(`## What is new\n\n- Garden ${CANARY} (Notes, added`);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(think.briefFolder(data)?.name).toBe("Briefs");
    expect(think.briefs(data)).toHaveLength(1);
    expect(think.shouldMakeBrief(data, new Date(Date.now() + 8 * 86_400_000))).toBe(true);
    expect(think.shouldMakeBrief(data, new Date(Date.now() + 3 * 86_400_000))).toBe(false);
    // A second brief goes into the same folder; one written by the owner's model is kept as written.
    const second = await think.makeBrief(s.b.api, s.vault, data, model("## What is new\nA garden."), new Date(Date.now() + 8 * 86_400_000));
    expect(second.createdFolder).toBe(false);
    expect(second.memory.body).toBe("## What is new\nA garden.");
    expect(dumpDb(h.db)).not.toContain(CANARY);
    expect(dumpDb(h.db)).not.toContain("What is new");
  });
});

describe("expiry", () => {
  it("hides an expired memory from apps, keeps it in Expired, and deletes it for real after the grace period", async () => {
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    const m = await ops.createMemory(s.b.api, notes, { title: "Door code", body: `${CANARY} 4512` });
    let data = await ops.loadVault(s.b.api, s.vault);
    const soon = new Date(Date.now() - 1000).toISOString();
    const updated = await think.setExpiry(s.b.api, data, data.memories.find((x) => x.id === m.id)!, soon);
    expect(updated.expiresAt).toBe(soon);

    data = await ops.loadVault(s.b.api, s.vault);
    expect(think.expired(data).map((x) => x.id)).toEqual([m.id]);
    // The server knows only when to delete it: the expiry plus 30 days by default. The expiry itself is encrypted.
    const row = h.db.prepare("SELECT delete_after FROM memories WHERE id = ?").get(m.id) as { delete_after: string };
    expect(new Date(row.delete_after).getTime() - new Date(soon).getTime()).toBe(30 * 86_400_000);

    // Apps no longer see it.
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Cursor", kind: "cursor" }, [notes]);
    const { readerFor } = await import("./helpers");
    expect(await readerFor(h, appKey).search("door")).toEqual([]);

    // A shorter grace period moves the deletion time for every expiring memory.
    expect(await think.applyGrace(s.b.api, data, 0)).toBe(1);
    expect(purgeExpired(h.db)).toBe(1);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM memories WHERE id = ?", m.id)).toBe(0);
  });

  it("is cleared by restoring, and survives edits and merges with the owner's grace period", async () => {
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    const m = await ops.createMemory(s.b.api, notes, { title: "Trial", body: "Ends soon" });
    let data = await ops.loadVault(s.b.api, s.vault);
    data = { ...data, thinking: { ...data.thinking, graceDays: 2 } };
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const withExpiry = await think.setExpiry(s.b.api, data, data.memories.find((x) => x.id === m.id)!, later);
    await ops.updateMemory(s.b.api, data.folders, withExpiry, { body: "Ends soon, edited" }, 2);
    const row = () => (h.db.prepare("SELECT delete_after FROM memories WHERE id = ?").get(m.id) as { delete_after: string | null }).delete_after;
    expect(new Date(row()!).getTime() - new Date(later).getTime()).toBe(2 * 86_400_000);
    const restored = await think.setExpiry(s.b.api, data, { ...withExpiry, body: "Ends soon, edited" }, null);
    expect(restored.expiresAt).toBeUndefined();
    expect(row()).toBeNull();
  });
});

describe("duplicates and contradictions", () => {
  it("merges every duplicate group after one approval", async () => {
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    for (let i = 0; i < 3; i++) await ops.createMemory(s.b.api, notes, { title: "Allergy", body: "Allergic to penicillin.", tags: [`t${i}`] });
    for (let i = 0; i < 2; i++) await ops.createMemory(s.b.api, notes, { title: "Bike", body: "The bike lock code is in the drawer." });
    await ops.createMemory(s.b.api, notes, { title: "Other", body: "Something else entirely." });
    let data = await ops.loadVault(s.b.api, s.vault);
    const groups = think.duplicateGroups(data);
    expect(groups.map((g) => g.length).sort()).toEqual([2, 3]);
    const r = await think.mergeAllGroups(s.b.api, data, groups);
    expect(r.saved).toHaveLength(2);
    expect(r.deleted).toHaveLength(3);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories).toHaveLength(3);
    expect(data.memories.find((m) => m.title === "Allergy")!.tags.sort()).toEqual(["t0", "t1", "t2"]);
    expect(think.duplicateGroups(data)).toEqual([]);
  });

  it("finds memories that disagree, and resolves one by keeping the other", async () => {
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    await ops.createMemory(s.b.api, notes, { title: "Coffee", body: "I drink coffee every morning before work." });
    await ops.createMemory(s.b.api, notes, { title: "Coffee", body: "I never drink coffee before work in the morning." });
    await ops.createMemory(s.b.api, notes, { title: "Garden", body: "Tomatoes by the south wall." });
    let data = await ops.loadVault(s.b.api, s.vault);
    const found = think.contradictions(data);
    expect(found).toHaveLength(1);
    await think.keepOne(s.b.api, found[0].b);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(think.contradictions(data)).toEqual([]);
  });
});

describe("thinking settings", () => {
  it("are saved encrypted and read back", async () => {
    const s = await signedUp(h);
    await self.saveThinking(s.b.api, s.vault, { weeklyBrief: false, briefWithModel: true, contradictionsWithModel: false, graceDays: 7 });
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.thinking).toEqual({ weeklyBrief: false, briefWithModel: true, contradictionsWithModel: false, graceDays: 7 });
    expect(think.shouldMakeBrief(data)).toBe(false);
  });
});

describe("local imports", () => {
  it("imports an Obsidian vault encrypted, and a second import of the same vault adds nothing", async () => {
    const s = await signedUp(h);
    const parsed = parseObsidianVault(obsidianFiles(CANARY));
    const folder = await ops.addFolder(s.b.api, s.vault, parsed.label);
    const first = dedupeDrafts(parsed.drafts, s.data.memories);
    expect(first.fresh).toHaveLength(2);
    await ops.importDrafts(s.b.api, folder, first.fresh);
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.map((m) => m.source.kind)).toEqual(["obsidian", "obsidian"]);
    expect(dedupeDrafts(parseObsidianVault(obsidianFiles(CANARY)).drafts, data.memories)).toEqual({ fresh: [], duplicates: 2 });
    expect(dumpDb(h.db)).not.toContain(CANARY);
    expect(h.sent.join("\n")).not.toContain(CANARY);
  });

  it("imports mail threads and calendar events from a Takeout zip, encrypted", async () => {
    const s = await signedUp(h);
    const parsed = parseTakeout([{ path: "takeout.zip", bytes: takeoutZip(CANARY) }]);
    const folder = await ops.addFolder(s.b.api, s.vault, parsed.label);
    await ops.importDrafts(s.b.api, folder, parsed.drafts);
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.filter((m) => m.source.kind === "gmail")).toHaveLength(2);
    expect(data.memories.filter((m) => m.source.kind === "calendar")).toHaveLength(2);
    expect(data.memories.find((m) => m.title === "Trip to the coast")!.body).toContain(CANARY);
    expect(dumpDb(h.db)).not.toContain(CANARY);
    expect(dumpDb(h.db)).not.toContain("Dentist");
  });
});

describe("the read log migration", () => {
  it("keeps every entry of an older database and allows answers of the AI self", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "sigil-migrate-")), "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE read_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, app_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read', 'propose', 'shared')), memory_id TEXT, count INTEGER NOT NULL, at TEXT NOT NULL,
        salt TEXT NOT NULL, leaf TEXT NOT NULL, hour INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE memories (user_id TEXT NOT NULL, id TEXT NOT NULL, folder_id TEXT NOT NULL, head TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id));
      INSERT INTO users VALUES ('u1', 'x');
      INSERT INTO read_log VALUES ('e1', 'u1', 'a1', 'read', 'm1', 1, '2026-01-01T00:00:00.000Z', 's', 'l', 1, 1);`);
    old.close();
    const db = openDb(file);
    expect(db.prepare("SELECT id, kind, sealed, note FROM read_log").all()).toEqual([{ id: "e1", kind: "read", sealed: 1, note: null }]);
    db.prepare("INSERT INTO read_log (id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, note) VALUES ('e2', 'u1', 'l1', 'ask', 'q1', 0, 'x', 's', 'l', 2, 's1.x')").run();
    expect((db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name)).toContain("delete_after");
    db.close();
  });
});
