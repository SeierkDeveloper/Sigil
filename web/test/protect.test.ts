// Protected folders: the server holds back a protected folder from apps,
// agents and links until the owner says yes for that read; a yes is good for
// one read and a few minutes; every such read is logged with its own kind and
// sealed with the hour. Redaction masks patterns on the device before
// anything leaves the vault.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanRules, type ModelCaller, type ModelRequest } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import * as guard from "../src/vault/protectOps";
import { answerRequest, requestAccess, takeApproval } from "../src/server/protect";
import { sealPending } from "../src/server/seal";
import { hourOf } from "../src/server/store";
import { createServer } from "../../connector/src/server";

const HEALTH = "CANARY-blood-results-91c2";
const EMAIL = "sam@example.org";

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function setup() {
  const s = await signedUp(h);
  const notes = s.data.folders[0];
  let health = await ops.addFolder(s.b.api, s.vault, "Health");
  await ops.createMemory(s.b.api, notes, { title: "Contact", body: `Write to me at ${EMAIL} or call +46 70 123 45 67.` });
  const blood = await ops.createMemory(s.b.api, health, { title: "Blood test", body: `${HEALTH}, all fine.` });
  health = await guard.setFolderGuard(s.b.api, health, { protect: "health", redact: ["card"] });
  let notesGuarded = await guard.setFolderGuard(s.b.api, notes, { redact: ["email", "phone"] });
  const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Claude", kind: "claude-desktop" }, [notesGuarded, health]);
  const data = await ops.loadVault(s.b.api, s.vault);
  notesGuarded = data.folders.find((f) => f.id === notes.id)!;
  const userId = String((h.db.prepare("SELECT user_id FROM apps WHERE id = ?").get(appId) as { user_id: string }).user_id);
  return { ...s, data, notes: notesGuarded, health, blood, appKey, appId, userId };
}

describe("marking a folder protected", () => {
  it("keeps the kind and rules in the encrypted meta; the server learns only that it is protected", async () => {
    const s = await setup();
    const h2 = s.data.folders.find((f) => f.id === s.health.id)!;
    expect(h2).toMatchObject({ protect: "health", redact: ["card"] });
    expect(s.data.folders.find((f) => f.id === s.notes.id)).toMatchObject({ redact: ["phone", "email"] });
    expect(s.data.folders.find((f) => f.id === s.notes.id)?.protect).toBeUndefined();
    expect(count(h.db, "SELECT COUNT(*) AS n FROM protected_folders")).toBe(1);
    const db = dumpDb(h.db);
    for (const plain of ["health", HEALTH, EMAIL]) expect(db).not.toContain(plain);
  });

  it("is refused for another vault's folder", async () => {
    const s = await setup();
    const other = await signedUp(h);
    await expect(other.b.api.put(`folders/${s.health.id}/protect`, { protected: false, meta: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({ status: 404 });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM protected_folders")).toBe(1);
  });
});

describe("an app and a protected folder", () => {
  it("is held back until the owner says yes, for one read, and the read is marked protected", async () => {
    const s = await setup();
    const reader = readerFor(h, s.appKey);
    const folders = await reader.listFolders();
    expect(folders.find((f) => f.name === "Health")).toMatchObject({ protected: true, memories: 1 });

    // Search leaves the protected folder out and says so.
    const hits = await reader.search("blood");
    expect(hits).toHaveLength(0);
    expect(reader.lastSkipped).toEqual(["Health"]);

    // Reading it asks the owner.
    const first = await reader.read([s.blood.id]);
    expect(first.memories).toHaveLength(0);
    expect(first.held).toEqual([expect.objectContaining({ folderId: s.health.id, memoryIds: [s.blood.id], state: "pending" })]);
    expect(h.sent.join("\n")).not.toContain(HEALTH);
    // Asking again does not pile up requests.
    await reader.read([s.blood.id]);
    let data = await ops.loadVault(s.b.api, s.vault);
    expect(data.access.filter((r) => r.state === "pending")).toHaveLength(1);
    expect(data.access[0]).toMatchObject({ requester: s.appId, requesterKind: "app", folderId: s.health.id, scope: "read" });

    await guard.approveRequest(s.b.api, data.access[0].id);
    const second = await reader.read([s.blood.id]);
    expect(second.memories[0].body).toContain(HEALTH);
    expect(second.held).toEqual([]);

    // The yes was for that one read.
    const third = await reader.read([s.blood.id]);
    expect(third.memories).toHaveLength(0);
    expect(third.held[0].state).toBe("pending");

    // The read log: the owner's yes and the protected read, each with its own kind.
    const log = await ops.loadLog(s.b.api);
    const kinds = log.entries.filter((e) => e.appId === s.appId).map((e) => e.kind);
    expect(kinds).toContain("approval");
    expect(kinds.filter((k) => k === "protected")).toHaveLength(1);
    expect(log.entries.some((e) => e.kind === "read" && e.memoryId === s.blood.id)).toBe(false);

    // A no is a no, and is logged too.
    data = await ops.loadVault(s.b.api, s.vault);
    const waiting = data.access.find((r) => r.state === "pending")!;
    await guard.denyRequest(s.b.api, waiting.id);
    const fourth = await reader.read([s.blood.id]);
    expect(fourth.memories).toHaveLength(0);
    expect((await ops.loadLog(s.b.api)).entries.some((e) => e.kind === "approval" && e.memoryId === `denied-${waiting.id}`)).toBe(true);
  });

  it("lets the app look inside a protected folder once the owner says yes", async () => {
    const s = await setup();
    const reader = readerFor(h, s.appKey);
    expect(await reader.search("blood", { folder: "Health" })).toHaveLength(0);
    expect(reader.lastHeld[0]).toMatchObject({ folder: "Health", state: "pending" });
    const req = (await ops.loadVault(s.b.api, s.vault)).access.find((r) => r.scope === "index")!;
    await guard.approveRequest(s.b.api, req.id);
    const hits = await reader.search("blood", { folder: "Health" });
    expect(hits.map((x) => x.title)).toEqual(["Blood test"]);
    const entry = (await ops.loadLog(s.b.api)).entries.find((e) => e.kind === "protected" && e.memoryId === null)!;
    expect(entry.count).toBe(1);
  });

  it("tells the app in plain words through the connector", async () => {
    const s = await setup();
    const server = createServer(readerFor(h, s.appKey));
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
    const read = await tools.read_memory.handler({ id: s.blood.id });
    expect(read.content[0].text).toContain("protected folder");
    expect(read.content[0].text).toContain("asked in their Sigil inbox");
    const search = await tools.search_memories.handler({ query: "contact" });
    expect(search.content[0].text).toContain("Protected folders not searched: Health");
  });

  it("masks what the folder's rules say before it reaches the app", async () => {
    const s = await setup();
    const reader = readerFor(h, s.appKey);
    const [hit] = await reader.search("contact");
    expect(hit.snippet).toContain("[email hidden]");
    const { memories } = await reader.read([hit.id]);
    expect(memories[0].body).toBe("Write to me at [email hidden] or call [phone number hidden].");
    // The vault itself keeps the text as written.
    expect(s.data.memories.find((m) => m.id === hit.id)?.body).toContain(EMAIL);
  });

  it("lets go of an approval after its minutes, and of a protection when it is turned off", async () => {
    const s = await setup();
    const t0 = Date.now();
    const req = requestAccess(h.db, s.userId, { requester: s.appId, requesterKind: "app", folderId: s.health.id, memoryIds: [s.blood.id], scope: "read" }, t0);
    answerRequest(h.db, s.userId, req.id, true, t0);
    expect(takeApproval(h.db, s.userId, s.appId, s.health.id, "read", [s.blood.id], t0 + 11 * 60_000)).toBeNull();
    expect(takeApproval(h.db, s.userId, s.appId, s.health.id, "read", ["someone-else"], t0 + 60_000)).toBeNull();
    expect(takeApproval(h.db, s.userId, s.appId, s.health.id, "read", [s.blood.id], t0 + 60_000)).toMatchObject({ state: "used" });

    await guard.setFolderGuard(s.b.api, s.health, {});
    const { memories } = await readerFor(h, s.appKey).read([s.blood.id]);
    expect(memories[0].body).toContain(HEALTH);
  });

  it("seals the owner's answer and the protected read with the hour, and both verify", async () => {
    const s = await setup();
    const past = Date.now() - 2 * 3600_000;
    const req = requestAccess(h.db, s.userId, { requester: s.appId, requesterKind: "app", folderId: s.health.id, memoryIds: [s.blood.id], scope: "read" }, past);
    answerRequest(h.db, s.userId, req.id, true, past);
    sealPending(h.db);
    const log = await ops.loadLog(s.b.api);
    const entry = log.entries.find((e) => e.kind === "approval")!;
    expect(entry.sealed).toBe(true);
    expect(entry.hour).toBe(hourOf(past));
    expect(await ops.verifyEntry(s.b.api, entry)).toMatchObject({ ok: true });
    // The kind is part of the sealed leaf: calling it a plain read breaks the proof.
    expect(await ops.verifyEntry(s.b.api, { ...entry, kind: "read" })).toMatchObject({ ok: false });
  });
});

function stubModel(answer: (req: ModelRequest) => string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), answer(r)) };
  return { model, calls };
}

describe("the AI self and a protected folder", () => {
  it("answers a link without the folder, asks the owner, and uses it only after the yes", async () => {
    const s = await setup();
    await self.saveModel(s.b.api, s.vault, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-x" });
    const rules = cleanRules({ name: "Sam's AI self", folderIds: [s.notes.id, s.health.id] });
    await self.saveRules(s.b.api, s.vault, rules);
    const { link } = await self.createLink(s.b.api, s.vault, await ops.loadVault(s.b.api, s.vault), { label: "Doctor", name: "Sam", greeting: "", rules, expiresInDays: 1, maxUses: 5, perHour: 5, appId: null }, ORIGIN);
    let data = await ops.loadVault(s.b.api, s.vault);
    const { model, calls } = stubModel((r) => (r.system.includes(HEALTH) ? "All fine [1]." : "I don't know that."));

    const gate = await guard.protectedGate(s.b.api, data, rules, "How was the blood test?", { id: link.id, kind: "link" });
    expect(gate.extra).toHaveLength(0);
    expect(gate.asked).toEqual(["Health"]);
    await self.askInVault(data, rules, model, "How do I contact you?");
    expect(calls[0].system).toContain("Contact");
    expect(calls[0].system).not.toContain(HEALTH);
    // Emails and phone numbers in Notes are masked before the model sees them.
    expect(calls[0].system).not.toContain(EMAIL);
    expect(calls[0].system).toContain("[email hidden]");

    data = await ops.loadVault(s.b.api, s.vault);
    const req = data.access.find((r) => r.requester === link.id)!;
    expect(req).toMatchObject({ requesterKind: "link", state: "pending", memoryIds: [s.blood.id] });
    await guard.approveRequest(s.b.api, req.id);

    const again = await guard.protectedGate(s.b.api, data, rules, "How was the blood test?", { id: link.id, kind: "link" });
    expect(again.extra.map((m) => m.title)).toEqual(["Blood test"]);
    await again.use([s.blood.id]);
    const log = await ops.loadLog(s.b.api);
    expect(log.entries.find((e) => e.kind === "protected")).toMatchObject({ appId: link.id, memoryId: s.blood.id });
    // The yes is used up.
    await expect(again.use([s.blood.id])).rejects.toMatchObject({ status: 409 });
  });

  it("lets the owner say yes on the vault screen for the test chat", async () => {
    const s = await setup();
    const req = await guard.approveHere(s.b.api, s.health.id, [s.blood.id]);
    expect(req.state).toBe("approved");
    await s.b.api.post(`access/${req.id}/use`, { memoryIds: [s.blood.id] });
    const { model, calls } = stubModel(() => "Fine.");
    await self.askInVault(s.data, cleanRules({ folderIds: [s.health.id] }), model, "blood test", [], {}, new Set([s.health.id]));
    expect(calls[0].system).toContain(HEALTH);
    expect((await ops.loadLog(s.b.api)).entries.find((e) => e.kind === "protected")).toMatchObject({ appId: "self" });
  });
});
