// Pinned versions of an agent's own folder: a pin returns a pointer, and the
// folder at that version comes back exactly, checked against its fingerprint,
// after the agent remembers more, changes and forgets. Through the real router
// and the connector's own code; the server only ever holds ciphertext.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePointer, pointerString, versionHash, type AgentRules } from "@sigil/core";
import { dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as agents from "../src/vault/agentOps";
import { AgentMemory } from "../../connector/src/agent";
import { openDb } from "../src/server/db";
import { memoriesAt, trackVersions } from "../src/server/versions";

const CANARY = "CANARY-pinned-plaintext-7q";
const RULES: AgentRules = { remember: true, recall: true, forget: true, handoff: true };

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function withAgent() {
  const owner = await signedUp(h);
  const made = await agents.createAgent(owner.b.api, owner.vault, { name: "Guard", kind: "other", read: [], write: [], rules: RULES });
  const reader = readerFor(h, made.appKey);
  return { owner, made, reader, agent: new AgentMemory(reader) };
}

describe("pinned versions of an agent's memory", () => {
  it("restores the folder exactly as pinned, after more is remembered, changed and forgotten", async () => {
    const s = await withAgent();
    const a = await s.agent.remember({ title: "Risk limit", body: `Max 2% per trade. ${CANARY}` });
    await s.agent.remember({ title: "Watchlist", body: "TSLA, NVDA" });
    const pin = await s.agent.pin();
    expect(pin).toMatchObject({ folder: s.made.folder.id, version: 2 });
    expect(pin.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pin.vault).toMatch(/^[0-9A-F]{20}$/);
    expect(pin.pointer).toBe(pointerString(pin));
    expect(parsePointer(pin.pointer)).toMatchObject({ folder: s.made.folder.id, version: 2, hash: pin.hash });

    // Later: one more memory, one forgotten.
    await s.agent.remember({ title: "New rule", body: "No trades on Fridays." });
    await s.agent.forget([a.id]);
    const now = await s.agent.restore((await s.agent.pin()).version);
    expect(now.memories.map((m) => m.title).sort()).toEqual(["New rule", "Watchlist"]);

    // The pinned version is still exactly what it was, and it checks out against the pointer's fingerprint.
    const back = await s.agent.restore(pin.version, pin.hash);
    expect(back).toMatchObject({ version: 2, verified: true, hash: pin.hash });
    expect(back.newest).toBeGreaterThan(2);
    expect(back.memories.map((m) => m.title).sort()).toEqual(["Risk limit", "Watchlist"]);
    expect(back.memories.find((m) => m.title === "Risk limit")!.body).toContain(CANARY);
    // Nothing the server keeps is readable.
    expect(dumpDb(h.db)).not.toContain(CANARY);
  });

  it("refuses a restore whose fingerprint does not match the pointer", async () => {
    const s = await withAgent();
    await s.agent.remember({ title: "One", body: "first" });
    const pin = await s.agent.pin();
    await expect(s.agent.restore(pin.version, `sha256:${"0".repeat(64)}`)).rejects.toMatchObject({ code: "version_mismatch" });
    await expect(s.agent.restore(99)).rejects.toMatchObject({ code: "no_version" });
  });

  it("puts every restore in the owner's read log and shows pins to the owner", async () => {
    const s = await withAgent();
    await s.agent.remember({ title: "One", body: "first" });
    const pin = await s.agent.pin();
    const before = (await ops.loadLog(s.owner.b.api)).entries.length;
    await s.agent.restore(pin.version);
    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.length).toBeGreaterThan(before);
    expect(log.entries.slice(0, log.entries.length - before).some((e) => e.kind === "read" && e.appId === s.made.appId && e.count === 1)).toBe(true);
    const pins = (await s.owner.b.api.get<{ pins: { version: number; hash: string }[] }>(`agents/${s.made.appId}/pins`)).pins;
    expect(pins).toEqual([expect.objectContaining({ version: pin.version, hash: pin.hash })]);
  });

  it("does not version ordinary folders, and an expiry date alone makes no new version", async () => {
    const s = await withAgent();
    const notes = s.owner.data.folders[0];
    await ops.createMemory(s.owner.b.api, notes, { title: "Owner note", body: "not an agent's" });
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM memory_history WHERE folder_id = ?").get(notes.id) as { n: number }).n)).toBe(0);
    await s.agent.remember({ title: "One", body: "first" });
    const v = (await s.agent.pin()).version;
    h.db.prepare("UPDATE memories SET delete_after = '2030-01-01T00:00:00.000Z' WHERE folder_id = ?").run(s.made.folder.id);
    expect((await s.agent.pin()).version).toBe(v);
  });

  it("deletes every version with the agent or with the vault", async () => {
    const s = await withAgent();
    await s.agent.remember({ title: "One", body: "first" });
    await s.agent.pin();
    const rows = () => Number((h.db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }).n);
    expect(rows()).toBeGreaterThan(0);
    h.db.prepare("DELETE FROM agents WHERE app_id = ?").run(s.made.appId);
    expect(rows()).toBe(0);
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM memory_pins").get() as { n: number }).n)).toBe(0);
  });

  it("gives agent folders from before versions existed their memories as first versions", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, created_at) VALUES ('u1', '')").run();
    db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES ('u1', 'home1', 'x', 'k', '', '')").run();
    db.exec("DROP TRIGGER versions_insert");
    db.prepare("INSERT INTO memories (user_id, id, folder_id, head, body, size, created_at, updated_at) VALUES ('u1', 'm1', 'home1', 'h', 'b', 2, '', '2026-01-01')").run();
    db.prepare("INSERT INTO apps (id, user_id, meta, secret, created_at) VALUES ('a1', 'u1', 'x', 's', '')").run();
    db.prepare("INSERT INTO agents (app_id, user_id, home_folder_id, public_key, created_at) VALUES ('a1', 'u1', 'home1', 'pk', '')").run();
    db.prepare("DELETE FROM folder_versions").run();
    db.prepare("DELETE FROM memory_history").run();
    // Opening the database again runs the one-time fill.
    trackVersions(db);
    const at1 = memoriesAt(db, "u1", "home1", 1);
    expect(at1.map((m) => m.id)).toEqual(["m1"]);
    expect(versionHash(at1)).toMatch(/^sha256:/);
  });
});
