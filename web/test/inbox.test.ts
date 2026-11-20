// The memory inbox: an app suggests, the owner decides. The server holds only
// sealed boxes, and nothing becomes a memory until the owner approves it.

import { beforeEach, describe, expect, it } from "vitest";
import { appBoxTag, encodeBoxPublicKey, newBoxKeyPair, parseAppKey } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import { createProposal, PROPOSALS_PER_HOUR } from "../src/server/inbox";

const CANARY = "CANARY-inbox-plaintext-3d81";

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function setup(canPropose = true) {
  const s = await signedUp(h);
  const notes = s.data.folders[0];
  const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [notes], {
    canPropose,
    boxPublic: s.data.boxPublic,
  });
  return { ...s, notes, appKey, appId, reader: readerFor(h, appKey) };
}

describe("the vault public key", () => {
  it("is made at sign-up, and only its public half is readable on the server", async () => {
    const s = await signedUp(h);
    expect(s.data.box).not.toBeNull();
    expect(s.data.boxPublic).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encodeBoxPublicKey(s.data.box!.publicKey)).toBe(s.data.boxPublic);
    expect(dumpDb(h.db)).not.toContain(encodeBoxPublicKey(s.data.box!.secretKey));
    const again = await ops.loadVault(s.b.api, s.vault);
    expect(again.box!.secretKey).toEqual(s.data.box!.secretKey);
  });

  it("is made on first open for a vault from before, and never replaced", async () => {
    const s = await signedUp(h);
    h.db.prepare("DELETE FROM box_keys").run();
    const reopened = await ops.loadVault(s.b.api, s.vault);
    expect(reopened.boxPublic).not.toBe(s.data.boxPublic);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM box_keys")).toBe(1);
    const other = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    await expect(s.b.api.post("vault/box-key", { publicKey: other, wrappedSecret: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("suggestions", () => {
  it("are off by default for every app", async () => {
    const s = await setup(false);
    expect((await ops.loadVault(s.b.api, s.vault)).apps[0].canPropose).toBe(false);
    await expect(s.reader.propose({ title: "x", body: "y" })).rejects.toMatchObject({ status: 403, code: "propose_off" });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM proposals")).toBe(0);
  });

  it("arrive sealed: the server never sees the text, the vault opens it", async () => {
    const s = await setup();
    const { id } = await s.reader.propose({ title: `Prefers tea ${CANARY}`, body: `Green tea, no sugar. ${CANARY}`, tags: ["food"], folder: "Notes" });
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
    expect(h.sent.join("\n")).not.toContain("Green tea");

    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.proposals).toHaveLength(1);
    expect(data.proposals[0]).toMatchObject({ id, appId: s.appId, payload: { title: `Prefers tea ${CANARY}`, tags: ["food"], folder: "Notes", via: "mcp" } });
  });

  it("are written to the read log as suggestions", async () => {
    const s = await setup();
    const { id } = await s.reader.propose({ title: "A", body: "B" });
    const log = await ops.loadLog(s.b.api);
    expect(log.entries.map((e) => [e.kind, e.memoryId, e.appId])).toEqual([["propose", id, s.appId]]);
  });

  it("can be approved, edited, into a folder: a real memory, encrypted, and the suggestion is gone", async () => {
    const s = await setup();
    await s.reader.propose({ title: "Prefers tea", body: `Green tea. ${CANARY}` });
    const data = await ops.loadVault(s.b.api, s.vault);
    const app = data.apps[0];
    const memory = await ops.approveProposal(s.b.api, s.notes, data.proposals[0], { title: "Tea", body: `Green tea, no sugar. ${CANARY}`, tags: ["food"] }, app);
    expect(memory.source).toEqual({ kind: "app", ref: "Claude Desktop" });

    const after = await ops.loadVault(s.b.api, s.vault);
    expect(after.proposals).toHaveLength(0);
    expect(after.memories.map((m) => [m.title, m.body, m.tags])).toEqual([["Tea", `Green tea, no sugar. ${CANARY}`, ["food"]]]);
    expect(dumpDb(h.db)).not.toContain(CANARY);
    // A waiting suggestion is part of the export, decrypted on the device.
    await s.reader.propose({ title: "Waiting", body: "still in the inbox" });
    const exported = ops.buildExport(await ops.loadVault(s.b.api, s.vault), []);
    expect(exported.inbox).toEqual([expect.objectContaining({ app: "Claude Desktop", title: "Waiting", body: "still in the inbox" })]);
    // The app can now find it like any memory in a folder it may read.
    expect((await s.reader.search("tea")).map((r) => r.title)).toEqual(["Tea"]);
    // A suggestion is handled once.
    await expect(ops.approveProposal(s.b.api, s.notes, data.proposals[0], { title: "x", body: "y", tags: [] })).rejects.toMatchObject({ status: 404 });
  });

  it("can be merged into an existing memory, or rejected", async () => {
    const s = await setup();
    const existing = await ops.createMemory(s.b.api, s.notes, { title: "Drinks", body: "Coffee in the morning.", tags: ["food"] });
    await s.reader.propose({ title: "Tea", body: "Green tea after lunch.", tags: ["tea"] });
    await s.reader.propose({ title: "Spam", body: "Not wanted" });
    const data = await ops.loadVault(s.b.api, s.vault);
    const tea = data.proposals.find((p) => p.payload?.title === "Tea")!;
    const spam = data.proposals.find((p) => p.payload?.title === "Spam")!;

    await ops.mergeProposal(s.b.api, data.folders, tea, { title: "Tea", body: tea.payload!.body, tags: tea.payload!.tags }, existing);
    await ops.rejectProposal(s.b.api, spam.id);

    const after = await ops.loadVault(s.b.api, s.vault);
    expect(after.proposals).toHaveLength(0);
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0].body).toContain("Coffee in the morning.");
    expect(after.memories[0].body).toContain("Green tea after lunch.");
    expect(after.memories[0].tags).toEqual(["food", "tea"]);
    expect(after.memories[0].createdAt).toBe(existing.createdAt);
  });

  it("stop when the owner turns them off or revokes the app", async () => {
    const s = await setup();
    await s.reader.propose({ title: "one", body: "1" });
    const app = (await ops.loadVault(s.b.api, s.vault)).apps[0];
    await ops.setAppSuggestions(s.b.api, s.vault, app, s.data.boxPublic, false);
    await expect(s.reader.propose({ title: "two", body: "2" })).rejects.toMatchObject({ status: 403 });
    await ops.setAppSuggestions(s.b.api, s.vault, app, s.data.boxPublic, true);
    await s.reader.propose({ title: "three", body: "3" });
    await ops.revokeApp(s.b.api, s.appId);
    await expect(s.reader.propose({ title: "four", body: "4" })).rejects.toMatchObject({ status: 401 });
    await expect(ops.setAppSuggestions(s.b.api, s.vault, app, s.data.boxPublic, true)).rejects.toMatchObject({ status: 400 });
    // What already arrived stays for the owner to decide.
    expect((await ops.loadVault(s.b.api, s.vault)).proposals).toHaveLength(2);
  });

  it("are refused when the server hands out a public key the vault did not vouch for", async () => {
    const s = await setup();
    const fake = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    h.db.prepare("UPDATE box_keys SET public_key = ?").run(fake);
    await expect(s.reader.propose({ title: "secret", body: CANARY })).rejects.toMatchObject({ code: "unverified_key" });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM proposals")).toBe(0);
    // Even a tag for the fake key made with another secret does not pass.
    const { secret } = parseAppKey(s.appKey);
    h.db.prepare("UPDATE app_inbox SET tag = ?").run(await appBoxTag(new Uint8Array(32).fill(7), fake));
    await expect(s.reader.propose({ title: "secret", body: CANARY })).rejects.toMatchObject({ code: "unverified_key" });
    expect(secret).toHaveLength(32);
  });

  it("are rate limited per app, and an inbox holds a limited number", async () => {
    const s = await setup();
    const userId = String((h.db.prepare("SELECT user_id FROM apps WHERE id = ?").get(s.appId) as { user_id: string }).user_id);
    const auth = { appId: s.appId, userId };
    const sealed = `s1.${"A".repeat(43)}.${"B".repeat(32)}.${"C".repeat(40)}`;
    for (let i = 0; i < PROPOSALS_PER_HOUR; i++) createProposal(h.db, auth, `prop${String(i).padStart(8, "0")}`, sealed);
    expect(() => createProposal(h.db, auth, "propover0001", sealed)).toThrow(/last hour/);
    // An hour later the app may send again.
    expect(createProposal(h.db, auth, "proplater001", sealed, new Date(Date.now() + 3601_000)).id).toBe("proplater001");
  });

  it("refuse anything that is not a sealed box", async () => {
    const s = await setup();
    const { authToken } = await (await import("@sigil/core")).appKeys(parseAppKey(s.appKey).secret);
    const res = await h.raw("POST", "connector/v1/proposals", {
      body: { id: "plaintext001", sealed: "Prefers tea" },
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describe("cross-origin calls from web apps", () => {
  it("answer the preflight and carry CORS headers on connector routes only", async () => {
    const pre = await h.raw("OPTIONS", "connector/v1/index", { headers: { origin: "https://notes.example", "access-control-request-method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const denied = await h.raw("GET", "connector/v1/index", { headers: { authorization: "Bearer nope" } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
    const vault = await h.raw("GET", "vault");
    expect(vault.headers.get("access-control-allow-origin")).toBeNull();
  });
});
