// Agents get their own memory: an agent key, its own folder, rules per tool,
// write access only where granted, handoff notes, and team spaces shared by
// vaults and agents with roles and a new key on removal. All through the real
// router and the connector's own code.

import { beforeEach, describe, expect, it } from "vitest";
import { encodeBoxPublicKey, newBoxKeyPair, type AgentRules } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as agents from "../src/vault/agentOps";
import { AgentMemory } from "../../connector/src/agent";

const CANARY = "CANARY-agent-plaintext-5d";
const ALL: AgentRules = { remember: true, recall: true, forget: false, handoff: true };

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function withAgent(rules: AgentRules = ALL) {
  const owner = await signedUp(h);
  const work = await ops.addFolder(owner.b.api, owner.vault, "Work");
  const health = await ops.addFolder(owner.b.api, owner.vault, "Health");
  await ops.createMemory(owner.b.api, work, { title: "Style guide", body: "Tabs, not spaces." });
  await ops.createMemory(owner.b.api, health, { title: "Allergy", body: "Penicillin." });
  const made = await agents.createAgent(owner.b.api, owner.vault, { name: "Cursor", kind: "cursor", read: [work], write: [], rules });
  const reader = readerFor(h, made.appKey);
  const agent = new AgentMemory(reader);
  agent.name = () => "cursor";
  return { owner, work, health, made, reader, agent };
}

const load = (o: Awaited<ReturnType<typeof signedUp>>) => ops.loadVault(o.b.api, o.vault);

describe("an agent vault", () => {
  it("is an app key with its own folder, and remembers into it, encrypted on the machine", async () => {
    const s = await withAgent();
    expect(await AgentMemory.detect(s.reader)).toMatchObject({ homeFolderId: s.made.folder.id, rules: ALL, writable: [s.made.folder.id] });
    const r = await s.agent.remember({ title: "Parser state", body: `Half done. ${CANARY}`, tags: ["parser"] });
    expect(r.where).toBe("Cursor memory");
    const data = await load(s.owner);
    const m = data.memories.find((x) => x.id === r.id)!;
    expect(m).toMatchObject({ folderId: s.made.folder.id, title: "Parser state", source: { kind: "agent", ref: "cursor" } });
    expect(data.folders.find((f) => f.id === s.made.folder.id)?.kind).toBe("agent");
    expect(data.agents.map((a) => a.appId)).toEqual([s.made.appId]);
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.map((e) => e.kind)).toContain("remember");
  });

  it("reads what it was given, and may not write it", async () => {
    const s = await withAgent();
    const hits = await s.agent.recall("style");
    expect(hits.map((x) => x.title)).toEqual(["Style guide"]);
    expect(hits.some((x) => x.title === "Allergy")).toBe(false);
    await expect(s.agent.remember({ title: "x", body: "y", folder: "Work" })).rejects.toMatchObject({ code: "read_only" });
    await expect(s.agent.remember({ title: "x", body: "y", folder: "Health" })).rejects.toMatchObject({ code: "read_only" });
    // Write access is given by the owner, folder by folder.
    const data = await load(s.owner);
    const app = data.apps.find((a) => a.id === s.made.appId)!;
    await agents.updateAgent(s.owner.b.api, s.owner.vault, app, data.agents[0], [s.made.folder, s.work], new Set([s.work.id]), ALL);
    expect((await s.agent.remember({ title: "Lint rule", body: "No semicolons.", folder: "Work" })).where).toBe("Work");
    expect((await load(s.owner)).apps.find((a) => a.id === s.made.appId)?.writeIds.sort()).toEqual([s.made.folder.id, s.work.id].sort());
  });

  it("follows the rules for each tool, enforced by the server", async () => {
    const s = await withAgent({ remember: false, recall: false, forget: false, handoff: false });
    await expect(s.agent.remember({ title: "x", body: "y" })).rejects.toMatchObject({ code: "remember_off" });
    await expect(s.agent.recall("style")).rejects.toMatchObject({ code: "recall_off" });
    await expect(s.agent.forget(["abcdefgh1234"])).rejects.toMatchObject({ code: "forget_off" });
    await expect(s.agent.leaveHandoff({ text: "x" })).rejects.toMatchObject({ code: "handoff_off" });
    await expect(s.agent.pickUpHandoffs()).rejects.toMatchObject({ code: "handoff_off" });
  });

  it("forgets for real, only where it may write", async () => {
    const s = await withAgent({ ...ALL, forget: true });
    const mine = await s.agent.remember({ title: "Temp", body: "Scratch." });
    const theirs = (await load(s.owner)).memories.find((m) => m.title === "Style guide")!;
    expect(await s.agent.forget([mine.id, theirs.id])).toEqual({ deleted: [mine.id], refused: [theirs.id] });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM memories WHERE id = ?", mine.id)).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM memories WHERE id = ?", theirs.id)).toBe(1);
  });

  it("leaves a sealed note for its next session, picked up once, and readable by the owner", async () => {
    const s = await withAgent();
    await s.agent.leaveHandoff({ text: `Next: wire the parser into the CLI. ${CANARY}` });
    const next = new AgentMemory(readerFor(h, s.made.appKey));
    const notes = await next.pickUpHandoffs();
    expect(notes.map((n) => [n.from, n.text, n.space])).toEqual([["cursor", `Next: wire the parser into the CLI. ${CANARY}`, null]]);
    expect(await next.pickUpHandoffs()).toEqual([]);
    const data = await load(s.owner);
    const owned = await agents.agentHandoffs(s.owner.b.api, s.owner.vault, data.apps.find((a) => a.id === s.made.appId)!, data.spaces);
    expect(owned[0].note?.text).toContain("wire the parser");
    expect(owned[0].pickedAt).toBeTruthy();
    expect(dumpDb(h.db)).not.toContain(CANARY);
  });

  it("is not available to an ordinary app key", async () => {
    const owner = await signedUp(h);
    const { appKey } = await ops.connectApp(owner.b.api, owner.vault, { name: "Claude", kind: "claude-desktop" }, owner.data.folders);
    const reader = readerFor(h, appKey);
    expect(await AgentMemory.detect(reader)).toBeNull();
    await expect(new AgentMemory(reader).remember({ title: "x", body: "y" })).rejects.toMatchObject({ code: "not_agent" });
    // Ordinary apps still read as before.
    expect((await reader.listFolders()).length).toBe(1);
  });
});

describe("team spaces", () => {
  async function team() {
    const s = await withAgent({ ...ALL, forget: true });
    const second = await agents.createAgent(s.owner.b.api, s.owner.vault, { name: "Claude Code", kind: "claude-code", read: [], write: [], rules: ALL });
    const friend = await signedUp(h);
    let data = await load(s.owner);
    const spaceId = await agents.createSpace(s.owner.b.api, data, "Launch", "Sam");
    data = await load(s.owner);
    let space = data.spaces.find((x) => x.id === spaceId)!;
    expect(space).toMatchObject({ name: "Launch", untrusted: [] });
    await agents.addVaultMember(s.owner.b.api, space, ops.vaultCode(friend.data)!.code, "Robin", "write");
    await agents.addAgentMember(s.owner.b.api, s.owner.vault, space, data.apps.find((a) => a.id === s.made.appId)!, "write");
    await agents.addAgentMember(s.owner.b.api, s.owner.vault, space, data.apps.find((a) => a.id === second.appId)!, "read");
    data = await load(s.owner);
    space = data.spaces.find((x) => x.id === spaceId)!;
    return { ...s, second, friend, spaceId, space };
  }

  it("lets members with a write role add memories that every member can read", async () => {
    const t = await team();
    expect(t.space.members.map((m) => [m.label, m.kind, m.role, m.trusted])).toEqual([
      ["Sam", "vault", "admin", true],
      ["Robin", "vault", "write", true],
      ["Cursor", "agent", "write", true],
      ["Claude Code", "agent", "read", true],
    ]);
    // The friend sees the space, accepts it and writes into it.
    let friend = await load(t.friend);
    expect(friend.spaces[0]).toMatchObject({ name: "Launch", memories: [] });
    await expect(agents.saveSpaceMemory(t.friend.b.api, friend.spaces[0], { title: "x", body: "y" })).rejects.toMatchObject({ code: "not_accepted" });
    await agents.acceptSpace(t.friend.b.api, t.spaceId);
    friend = await load(t.friend);
    await agents.saveSpaceMemory(t.friend.b.api, friend.spaces[0], { title: "Launch date", body: `Friday the 4th. ${CANARY}` });
    // The agent reads it through its own key and writes back into the space.
    expect((await t.agent.recall("launch")).map((x) => [x.title, x.where])).toContainEqual(["Launch date", "the space Launch"]);
    expect((await t.agent.remember({ title: "Checklist", body: "Ship notes.", folder: "Launch" })).where).toBe("the space Launch");
    const owner = await load(t.owner);
    expect(owner.spaces[0].memories.map((m) => m.title).sort()).toEqual(["Checklist", "Launch date"]);
    // A read-only agent may not write.
    const reader2 = new AgentMemory(readerFor(h, t.second.appKey));
    await expect(reader2.remember({ title: "x", body: "y", folder: "Launch" })).rejects.toMatchObject({ code: "role" });
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
  });

  it("passes a handoff note from one agent to another through the space", async () => {
    const t = await team();
    await t.agent.leaveHandoff({ text: "Release notes are drafted; review them.", space: "Launch", to: "Claude Code" });
    const other = new AgentMemory(readerFor(h, t.second.appKey));
    other.name = () => "claude-code";
    expect((await other.pickUpHandoffs()).map((n) => [n.from, n.to, n.space, n.text])).toEqual([["cursor", "Claude Code", "Launch", "Release notes are drafted; review them."]]);
    // The agent that left it does not get its own note back.
    expect(await t.agent.pickUpHandoffs()).toEqual([]);
  });

  it("gives the space a new key when a member is removed, so the old key opens nothing new", async () => {
    const t = await team();
    await agents.acceptSpace(t.friend.b.api, t.spaceId);
    const oldFriend = (await load(t.friend)).spaces[0];
    let owner = await load(t.owner);
    await agents.saveSpaceMemory(t.owner.b.api, owner.spaces[0], { title: "Budget", body: "Small." });
    owner = await load(t.owner);
    const robin = owner.spaces[0].members.find((m) => m.label === "Robin")!;
    await agents.removeMembers(t.owner.b.api, owner.spaces[0], [robin.id]);
    owner = await load(t.owner);
    expect(owner.spaces[0].epoch).toBe(2);
    expect(owner.spaces[0].members.map((m) => m.label)).toEqual(["Sam", "Cursor", "Claude Code"]);
    expect(owner.spaces[0].memories.map((m) => m.title)).toEqual(["Budget"]);
    // Robin is out, and what Robin kept no longer opens the space.
    expect((await load(t.friend)).spaces).toEqual([]);
    await expect(agents.saveSpaceMemory(t.friend.b.api, oldFriend, { title: "x", body: "y" })).rejects.toMatchObject({ status: 403 });
    const stored = h.db.prepare("SELECT id, head FROM space_memories").get() as { id: string; head: string };
    const { decryptHead } = await import("@sigil/core");
    await expect(decryptHead(oldFriend.folder!, { id: stored.id, head: stored.head })).rejects.toThrow();
    // The agents still read it with the new key.
    expect((await t.agent.recall("budget")).map((x) => x.title)).toContain("Budget");
  });

  it("catches a member the server slipped in, and seals nothing until an admin removes it", async () => {
    const t = await team();
    h.db
      .prepare("INSERT INTO space_members (id, space_id, kind, user_id, public_key, role, sealed_key, tag, label, created_at, accepted_at) SELECT 'planted-member', space_id, 'vault', user_id, ?, 'admin', sealed_key, ?, label, created_at, accepted_at FROM space_members WHERE id = ?")
      .run(encodeBoxPublicKey(newBoxKeyPair().publicKey), "0".repeat(64), t.space.me.id);
    const space = (await load(t.owner)).spaces[0];
    expect(space.untrusted).toEqual(["planted-member"]);
    const other = await signedUp(h);
    await expect(agents.addVaultMember(t.owner.b.api, space, ops.vaultCode(other.data)!.code, "X", "read")).rejects.toThrow("Nothing is sealed");
    await agents.removeMembers(t.owner.b.api, space, []);
    expect((await load(t.owner)).spaces[0].untrusted).toEqual([]);
  });

  it("drops a revoked agent from its spaces, and the export lists agents and spaces in plain words", async () => {
    const t = await team();
    await ops.revokeApp(t.owner.b.api, t.second.appId);
    const data = await load(t.owner);
    expect(data.spaces[0].members.map((m) => m.label)).toEqual(["Sam", "Robin", "Cursor"]);
    await expect(new AgentMemory(readerFor(h, t.second.appKey)).recall("x")).rejects.toMatchObject({ code: "app_revoked" });
    const exported = ops.buildExport(data, []);
    expect(exported.agents.map((a) => [a.name, a.ownFolder, !!a.revokedAt])).toEqual([
      ["Cursor", "Cursor memory", false],
      ["Claude Code", "Claude Code memory", true],
    ]);
    expect(exported.spaces).toEqual([{ name: "Launch", role: "admin", members: expect.arrayContaining([{ name: "Robin", kind: "vault", role: "write" }]), memories: [] }]);
  });

  it("keeps roles: only admins add people, and a space keeps one admin", async () => {
    const t = await team();
    await agents.acceptSpace(t.friend.b.api, t.spaceId);
    const friendSpace = (await load(t.friend)).spaces[0];
    const third = await signedUp(h);
    await expect(agents.addVaultMember(t.friend.b.api, friendSpace, ops.vaultCode(third.data)!.code, "X", "read")).rejects.toMatchObject({ code: "role" });
    const owner = (await load(t.owner)).spaces[0];
    const me = owner.members.find((m) => m.label === "Sam")!;
    await expect(agents.setMemberRole(t.owner.b.api, owner, me, "read")).rejects.toMatchObject({ code: "last_admin" });
    const robin = owner.members.find((m) => m.label === "Robin")!;
    await agents.setMemberRole(t.owner.b.api, owner, robin, "admin");
    expect((await load(t.owner)).spaces[0].members.find((m) => m.label === "Robin")).toMatchObject({ role: "admin", trusted: true });
  });
});
