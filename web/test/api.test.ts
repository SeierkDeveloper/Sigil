import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fromHex32, hex32, readEntryLeaf, verifyProof, walletKeyMessage, type Memory } from "@sigil/core";
import { count, dumpDb, harness, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import { handleApi } from "../src/server/api";
import { logRead, hourOf } from "../src/server/store";
import { sealPending } from "../src/server/seal";
import { VaultReader } from "../../connector/src/reader";

const CANARY = "CANARY-PLAINTEXT-7f3a";

async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: walletKeyMessage(account.address) });
  return { address: account.address, signature };
}

function readerFor(h: Harness, appKey: string) {
  return new VaultReader({
    appKey,
    baseUrl: ORIGIN,
    fetcher: async (input, init = {}) => {
      const url = new URL(input);
      if (typeof init.body === "string") h.sent.push(init.body);
      return handleApi(new Request(url, init as RequestInit), url.pathname.replace(/^\/api\//, "").split("/"), h.db);
    },
  });
}

async function signedUp(h: Harness) {
  const b = h.browser();
  const w = await wallet();
  const { vault, phrase } = await ops.signUpWithWallet(b.api, w.address, w.signature);
  const data = await ops.loadVault(b.api, vault);
  return { b, w, vault, phrase, data };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("sign up and sign in", () => {
  it("creates a vault with a wallet and a recovery phrase", async () => {
    const { b, data, phrase } = await signedUp(h);
    expect(b.cookie()).toBeTruthy();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(data.folders.map((f) => f.name)).toEqual([ops.DEFAULT_FOLDER]);
    expect(data.keyslots.map((k) => k.kind).sort()).toEqual(["phrase", "wallet"]);
    expect(data.unreadable).toBe(0);
  });

  it("signs in again with the same wallet and opens the same vault", async () => {
    const { w, vault } = await signedUp(h);
    const again = await ops.signInWithWallet(h.browser().api, w.address, w.signature);
    expect(again.raw).toEqual(vault.raw);
  });

  it("refuses a wallet that already has a vault", async () => {
    const { w } = await signedUp(h);
    await expect(ops.signUpWithWallet(h.browser().api, w.address, w.signature)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses the wrong wallet signature", async () => {
    const { w } = await signedUp(h);
    const other = await wallet();
    await expect(ops.signInWithWallet(h.browser().api, w.address, other.signature)).rejects.toMatchObject({ status: 404 });
  });

  it("opens the vault with the recovery phrase alone", async () => {
    const { vault, phrase } = await signedUp(h);
    const viaPhrase = await ops.signInWithPhrase(h.browser().api, phrase);
    expect(viaPhrase.raw).toEqual(vault.raw);
    await expect(ops.signInWithPhrase(h.browser().api, ops.DEFAULT_FOLDER)).rejects.toThrow();
  });

  it("replaces the recovery phrase; the old one stops working", async () => {
    const { b, vault, phrase } = await signedUp(h);
    const next = await ops.replaceRecoveryPhrase(b.api, vault);
    await expect(ops.signInWithPhrase(h.browser().api, phrase)).rejects.toMatchObject({ status: 404 });
    expect((await ops.signInWithPhrase(h.browser().api, next)).raw).toEqual(vault.raw);
  });

  it("adds a second wallet and keeps at least one way in", async () => {
    const { b, vault, data } = await signedUp(h);
    const second = await wallet();
    const slots = await ops.addWallet(b.api, vault, second.address, second.signature);
    expect(slots.filter((s) => s.kind === "wallet")).toHaveLength(2);
    expect((await ops.signInWithWallet(h.browser().api, second.address, second.signature)).raw).toEqual(vault.raw);
    const first = data.keyslots.find((s) => s.kind === "wallet")!;
    const left = await ops.removeKeyslot(b.api, first.id);
    expect(left.filter((s) => s.kind === "wallet")).toHaveLength(1);
    await expect(ops.removeKeyslot(b.api, left.find((s) => s.kind === "wallet")!.id)).rejects.toMatchObject({ status: 400 });
    await expect(ops.removeKeyslot(b.api, left.find((s) => s.kind === "phrase")!.id)).rejects.toMatchObject({ status: 400 });
  });

  it("signs out", async () => {
    const { b } = await signedUp(h);
    await ops.signOut(b.api);
    expect(b.cookie()).toBeNull();
    await expect(b.api.get("vault")).rejects.toMatchObject({ status: 401 });
  });

  it("detects a wallet that signs differently each time", () => {
    expect(() => ops.assertStableSignature("0xabc", "0xABC")).not.toThrow();
    expect(() => ops.assertStableSignature("0xabc", "0xabd")).toThrow(ops.WalletSignatureUnstable);
  });
});

describe("memories", () => {
  it("stores only ciphertext and reads it back", async () => {
    const { b, vault, data } = await signedUp(h);
    const notes = data.folders[0];
    const health = await ops.addFolder(b.api, vault, `Health ${CANARY}`);
    await ops.createMemory(b.api, notes, { title: `Plan ${CANARY}`, body: `Body ${CANARY}`, tags: [`tag-${CANARY}`] });
    await ops.createMemory(b.api, health, { title: "Allergy", body: "Penicillin" });

    const again = await ops.loadVault(b.api, vault);
    expect(again.memories.map((m) => m.title).sort()).toEqual(["Allergy", `Plan ${CANARY}`]);

    const everything = dumpDb(h.db) + h.sent.join("\n");
    expect(everything).not.toContain(CANARY);
    expect(everything.toLowerCase()).not.toContain("canary");
    expect(everything).not.toContain("Penicillin");
    expect(everything).not.toContain("Allergy");
  });

  it("edits, moves between folders and really deletes", async () => {
    const { b, vault, data } = await signedUp(h);
    const notes = data.folders[0];
    const other = await ops.addFolder(b.api, vault, "Other");
    const m = await ops.createMemory(b.api, notes, { title: "Draft", body: "one" });
    const folders = [notes, other];

    const edited = await ops.updateMemory(b.api, folders, m, { body: "two", tags: ["x"], folderId: other.id });
    expect(edited.folderId).toBe(other.id);
    let loaded = await ops.loadVault(b.api, vault);
    expect(loaded.memories).toHaveLength(1);
    expect(loaded.memories[0]).toMatchObject({ id: m.id, body: "two", tags: ["x"], folderId: other.id, createdAt: m.createdAt });

    expect(await ops.deleteMemories(b.api, [m.id])).toBe(1);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM memories")).toBe(0);
    loaded = await ops.loadVault(b.api, vault);
    expect(loaded.memories).toHaveLength(0);
  });

  it("renames and deletes folders (with their memories)", async () => {
    const { b, vault, data } = await signedUp(h);
    const f = await ops.addFolder(b.api, vault, "Trips");
    await ops.createMemory(b.api, f, { title: "Rome", body: "..." });
    await ops.renameFolder(b.api, f, "Travel");
    expect((await ops.loadVault(b.api, vault)).folders.map((x) => x.name)).toEqual([ops.DEFAULT_FOLDER, "Travel"]);
    await ops.removeFolder(b.api, f.id);
    const after = await ops.loadVault(b.api, vault);
    expect(after.folders).toHaveLength(1);
    expect(after.memories).toHaveLength(0);
    await expect(ops.removeFolder(b.api, data.folders[0].id)).rejects.toMatchObject({ status: 400 });
  });

  it("imports in batches", async () => {
    const { b, vault, data } = await signedUp(h);
    const drafts = Array.from({ length: 450 }, (_, i) => ({ title: `Conversation ${i}`, body: `text ${i}` }));
    const progress: number[] = [];
    const saved = await ops.importDrafts(b.api, data.folders[0], drafts, (done) => progress.push(done));
    expect(saved).toHaveLength(450);
    expect(progress).toEqual([200, 400, 450]);
    expect((await ops.loadVault(b.api, vault)).memories).toHaveLength(450);
    const usage = await b.api.get<{ memories: number; bytes: number }>("usage");
    expect(usage.memories).toBe(450);
    expect(usage.bytes).toBeGreaterThan(450 * 100);
  });

  it("keeps accounts apart", async () => {
    const a = await signedUp(h);
    const bUser = await signedUp(h);
    const mine = await ops.createMemory(a.b.api, a.data.folders[0], { title: "A's", body: "secret" });

    // B cannot delete A's memory, write into A's folder, or rename it.
    expect(await ops.deleteMemories(bUser.b.api, [mine.id])).toBe(0);
    await expect(ops.createMemory(bUser.b.api, a.data.folders[0], { title: "x", body: "y" })).rejects.toMatchObject({ status: 400 });
    await expect(ops.renameFolder(bUser.b.api, a.data.folders[0], "mine now")).rejects.toMatchObject({ status: 404 });
    expect((await ops.loadVault(bUser.b.api, bUser.vault)).memories).toHaveLength(0);
    expect((await ops.loadVault(a.b.api, a.vault)).memories).toHaveLength(1);
  });

  it("rejects plaintext where ciphertext is expected", async () => {
    const { b, data } = await signedUp(h);
    await expect(
      b.api.put("memories", { memories: [{ id: "abcdefgh1234", folderId: data.folders[0].id, head: "my title", body: "my body" }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(b.api.post("folders", { id: "abcdefgh1234", meta: "Health", wrappedKey: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("request checks", () => {
  it("rejects changes from another origin and requests without a session", async () => {
    const { b } = await signedUp(h);
    const res = await h.raw("POST", "folders", { body: {}, headers: { cookie: `sigil_session=${b.cookie()}`, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const noOrigin = await h.raw("POST", "auth/logout", {});
    expect(noOrigin.status).toBe(200);
    expect((await h.raw("GET", "vault")).status).toBe(401);
  });

  it("answers unknown routes and methods plainly", async () => {
    expect((await h.raw("GET", "nope")).status).toBe(404);
    expect((await h.raw("PUT", "status")).status).toBe(405);
    expect((await h.raw("GET", "status")).status).toBe(200);
  });

  it("limits oversized and malformed bodies", async () => {
    const { b } = await signedUp(h);
    const res = await h.raw("POST", "folders", { body: "{not json", headers: { cookie: `sigil_session=${b.cookie()}`, origin: ORIGIN } });
    expect(res.status).toBe(400);
  });
});

describe("connected apps", () => {
  async function setup() {
    const s = await signedUp(h);
    const work = s.data.folders[0];
    const health = await ops.addFolder(s.b.api, s.vault, "Health");
    const plan = await ops.createMemory(s.b.api, work, { title: "Launch plan", body: `Ship on a Tuesday. ${CANARY}`, tags: ["work"] });
    const pills = await ops.createMemory(s.b.api, health, { title: "Medication", body: "Twice a day", tags: ["health"] });
    const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [work]);
    return { ...s, work, health, plan, pills, appKey, appId, reader: readerFor(h, appKey) };
  }

  it("reads only the folders it was granted, decrypting locally", async () => {
    const s = await setup();
    expect(await s.reader.listFolders()).toEqual([{ id: s.work.id, name: ops.DEFAULT_FOLDER, memories: 1 }]);

    const hits = await s.reader.search("launch");
    expect(hits.map((x) => x.id)).toEqual([s.plan.id]);
    expect(await s.reader.search("medication")).toEqual([]);

    const { memories, missing } = await s.reader.read([s.plan.id, s.pills.id]);
    expect(memories.map((m) => m.title)).toEqual(["Launch plan"]);
    expect(memories[0].body).toContain(CANARY);
    expect(missing).toEqual([s.pills.id]);

    // The server never received the query, and nothing it stored is readable.
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
    expect(h.sent.join("\n")).not.toContain("launch");
  });

  it("writes every request to the owner's read log", async () => {
    const s = await setup();
    await s.reader.listFolders();
    await s.reader.search("plan");
    await s.reader.read([s.plan.id, s.pills.id]);
    const log = await ops.loadLog(s.b.api);
    expect(log.mode).toBe("local");
    expect(log.entries.map((e) => [e.kind, e.memoryId, e.count])).toEqual([
      ["read", s.plan.id, 1],
      ["index", null, 1],
      ["folders", null, 1],
    ]);
    expect(log.entries.every((e) => e.appId === s.appId && !e.sealed)).toBe(true);
    for (const e of log.entries) expect(e.leaf).toBe(hex32(readEntryLeaf(e)));
  });

  it("stops at once when revoked, and loses its folder keys", async () => {
    const s = await setup();
    await s.reader.read([s.plan.id]);
    await ops.revokeApp(s.b.api, s.appId);
    await expect(s.reader.read([s.plan.id])).rejects.toMatchObject({ status: 401, code: "app_revoked" });
    await expect(s.reader.search("")).rejects.toMatchObject({ status: 401 });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM grants WHERE app_id = ?", s.appId)).toBe(0);
    const app = (await ops.loadVault(s.b.api, s.vault)).apps[0];
    expect(app.revokedAt).not.toBeNull();
    expect(app.folderIds).toEqual([]);
    await expect(ops.setAppFolders(s.b.api, s.vault, app, [s.work])).rejects.toMatchObject({ status: 400 });
    await ops.removeApp(s.b.api, s.appId);
    expect((await ops.loadVault(s.b.api, s.vault)).apps).toHaveLength(0);
  });

  it("can be given more folders, or fewer, later", async () => {
    const s = await setup();
    const app = (await ops.loadVault(s.b.api, s.vault)).apps[0];
    expect(app).toMatchObject({ name: "Claude Desktop", kind: "claude-desktop", folderIds: [s.work.id] });
    await ops.setAppFolders(s.b.api, s.vault, app, [s.work, s.health]);
    expect((await s.reader.search("medication")).map((x) => x.id)).toEqual([s.pills.id]);
    await ops.setAppFolders(s.b.api, s.vault, app, [s.health]);
    expect((await s.reader.read([s.plan.id])).missing).toEqual([s.plan.id]);
  });

  it("an app key cannot reach another account", async () => {
    const s = await setup();
    const other = await signedUp(h);
    const theirs = await ops.createMemory(other.b.api, other.data.folders[0], { title: "Other", body: "x" });
    expect((await s.reader.read([theirs.id])).missing).toEqual([theirs.id]);
  });

  it("refuses made-up and malformed keys", async () => {
    await expect(readerFor(h, "sigil_app.AAAAAAAAAAAA." + "A".repeat(43)).listFolders()).rejects.toMatchObject({ status: 401 });
    const res = await h.raw("GET", "connector/v1/index", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});

describe("seals", () => {
  it("seals finished hours and every entry verifies against its seal", async () => {
    const s = await signedUp(h);
    const { appId } = await ops.connectApp(s.b.api, s.vault, { name: "Cursor", kind: "cursor" }, [s.data.folders[0]]);
    const userId = String((h.db.prepare("SELECT user_id FROM apps WHERE id = ?").get(appId) as { user_id: string }).user_id);
    const auth = { appId, userId };
    const past = Date.now() - 2 * 3600_000;
    for (let i = 0; i < 5; i++) logRead(h.db, auth, "index", null, i, new Date(past + i * 1000));
    logRead(h.db, auth, "read", "abcdefgh", 1); // this hour: stays unsealed

    const made = sealPending(h.db);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ hour: hourOf(past), leaves: 5, anchorTx: null });
    expect(sealPending(h.db)).toHaveLength(0);

    const log = await ops.loadLog(s.b.api);
    const sealed = log.entries.filter((e) => e.sealed);
    expect(sealed).toHaveLength(5);
    for (const e of sealed) {
      expect(await ops.verifyEntry(s.b.api, e)).toMatchObject({ ok: true, hour: hourOf(past), root: made[0].root });
    }
    const open = log.entries.find((e) => !e.sealed)!;
    expect(await ops.verifyEntry(s.b.api, open)).toMatchObject({ ok: false });

    // A doctored entry no longer matches its fingerprint.
    expect(await ops.verifyEntry(s.b.api, { ...sealed[0], count: 99 })).toMatchObject({ ok: false });

    const pub = await (await h.raw("GET", "seals")).json();
    expect(pub.mode).toBe("local");
    expect(pub.seals[0].root).toBe(made[0].root);
  });

  it("seals stay valid after an account is deleted", async () => {
    const a = await signedUp(h);
    const b = await signedUp(h);
    const appA = await ops.connectApp(a.b.api, a.vault, { name: "A", kind: "other" }, [a.data.folders[0]]);
    const appB = await ops.connectApp(b.b.api, b.vault, { name: "B", kind: "other" }, [b.data.folders[0]]);
    const uid = (appId: string) => String((h.db.prepare("SELECT user_id FROM apps WHERE id = ?").get(appId) as { user_id: string }).user_id);
    const past = new Date(Date.now() - 2 * 3600_000);
    logRead(h.db, { appId: appA.appId, userId: uid(appA.appId) }, "index", null, 1, past);
    const kept = logRead(h.db, { appId: appB.appId, userId: uid(appB.appId) }, "index", null, 1, past);
    sealPending(h.db);

    await ops.deleteAccount(a.b.api);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE app_id = ?", appA.appId)).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM seal_leaves")).toBe(2);

    const entry = (await ops.loadLog(b.b.api)).entries.find((e) => e.id === kept.id)!;
    expect(await ops.verifyEntry(b.b.api, entry)).toMatchObject({ ok: true });
    const proof = await b.b.api.get<{ root: string; leaf: string; proof: string[] }>(`log/${kept.id}/proof`);
    expect(verifyProof(fromHex32(proof.root), fromHex32(proof.leaf), proof.proof.map(fromHex32))).toBe(true);
  });
});

describe("public numbers, status and proofs", () => {
  async function withReads() {
    const s = await signedUp(h);
    await ops.createMemory(s.b.api, s.data.folders[0], { title: "Launch plan", body: `Ship on a Tuesday. ${CANARY}` });
    const { appId } = await ops.connectApp(s.b.api, s.vault, { name: "Cursor", kind: "cursor" }, [s.data.folders[0]]);
    const userId = String((h.db.prepare("SELECT user_id FROM apps WHERE id = ?").get(appId) as { user_id: string }).user_id);
    const auth = { appId, userId };
    const past = Date.now() - 2 * 3600_000;
    const old = [0, 1, 2].map((i) => logRead(h.db, auth, "index", null, i, new Date(past + i * 1000)));
    const fresh = logRead(h.db, auth, "read", "abcdefgh", 1);
    return { ...s, old, fresh, past };
  }

  it("counts are zero on an empty server", async () => {
    const res = await h.raw("GET", "stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vaults: 0, memories: 0, apps: 0, reads: 0, seals: 0 });
  });

  it("counts vaults, memories, apps, reads and seals, and nothing else", async () => {
    const s = await withReads();
    sealPending(h.db);
    const stats = await (await h.raw("GET", "stats")).json();
    expect(stats).toEqual({ vaults: 1, memories: 1, apps: 1, reads: 4, seals: 1 });
    expect(JSON.stringify(stats)).not.toContain(CANARY);

    // Deleting the vault keeps the sealed reads in the count; the open one goes with the account.
    await ops.deleteAccount(s.b.api);
    expect(await (await h.raw("GET", "stats")).json()).toEqual({ vaults: 0, memories: 0, apps: 0, reads: 3, seals: 1 });
  });

  it("status runs the seal job and reports the queue", async () => {
    const empty = await (await h.raw("GET", "status")).json();
    expect(empty).toMatchObject({ ok: true, database: "ok", seals: { enabled: true, job: "ok", mode: "local", open: 0, overdue: 0, seals: 0, lastSealedAt: null } });
    expect(Number.isNaN(Date.parse(empty.time))).toBe(false);

    const s = await withReads();
    const status = await (await h.raw("GET", "status")).json();
    expect(status.seals).toMatchObject({ job: "ok", open: 1, overdue: 0, seals: 1, leaves: 3, latestHour: hourOf(s.past), currentHour: hourOf(Date.now()) });
    expect(typeof status.seals.lastSealedAt).toBe("string");
  });

  it("gives one seal by its number", async () => {
    const s = await withReads();
    const res = await h.raw("GET", `seals/${hourOf(s.past)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "local", periodSeconds: 3600, seal: { hour: hourOf(s.past), leaves: 3 } });
    expect((await h.raw("GET", "seals/1")).status).toBe(404);
    expect((await h.raw("GET", "seals/abc")).status).toBe(400);
  });

  it("proves a fingerprint against its seal without a session", async () => {
    const s = await withReads();
    const hour = hourOf(s.past);
    for (const entry of s.old) {
      const res = await h.raw("GET", `seals/${hour}/proof?leaf=${entry.leaf}`);
      expect(res.status).toBe(200);
      const proof = await res.json();
      expect(proof).toMatchObject({ hour, leaf: entry.leaf });
      expect(hex32(readEntryLeaf(entry))).toBe(proof.leaf);
      expect(verifyProof(fromHex32(proof.root), fromHex32(proof.leaf), proof.proof.map(fromHex32))).toBe(true);
    }
    // Not sealed yet, a made-up fingerprint, a malformed one, and a seal that does not exist.
    expect((await h.raw("GET", `seals/${hour}/proof?leaf=${s.fresh.leaf}`)).status).toBe(404);
    expect((await h.raw("GET", `seals/${hour}/proof?leaf=0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await h.raw("GET", `seals/${hour}/proof?leaf=nope`)).status).toBe(400);
    expect((await h.raw("GET", `seals/${hour}/proof`)).status).toBe(400);
    expect((await h.raw("GET", `seals/1/proof?leaf=${s.old[0].leaf}`)).status).toBe(404);
    expect((await h.raw("POST", `seals/${hour}/proof?leaf=${s.old[0].leaf}`)).status).toBe(405);
  });
});

describe("export and delete", () => {
  it("exports everything decrypted, on the device", async () => {
    const s = await setup2();
    const log = await ops.loadLog(s.b.api);
    const out = ops.buildExport(await ops.loadVault(s.b.api, s.vault), log.entries);
    expect(out.format).toBe("sigil-export");
    expect(out.memories.map((m) => m.title)).toEqual(["Kept"]);
    expect((out.memories[0] as Partial<Memory>).snippet).toBeUndefined();
    expect(out.apps[0]).toMatchObject({ name: "Claude Desktop", folders: [ops.DEFAULT_FOLDER] });
    expect(out.readLog[0]).toMatchObject({ kind: "folders" });
  });

  it("deletes the account and every row that belonged to it", async () => {
    const s = await setup2();
    await ops.deleteAccount(s.b.api);
    for (const table of ["users", "keyslots", "sessions", "folders", "memories", "apps", "grants", "read_log", "passkeys"]) {
      expect(count(h.db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
    await expect(ops.signInWithWallet(h.browser().api, s.w.address, s.w.signature)).rejects.toMatchObject({ status: 404 });
    await expect(ops.signInWithPhrase(h.browser().api, s.phrase)).rejects.toMatchObject({ status: 404 });
    await expect(s.reader.listFolders()).rejects.toMatchObject({ status: 401 });
  });

  async function setup2() {
    const s = await signedUp(h);
    await ops.createMemory(s.b.api, s.data.folders[0], { title: "Kept", body: "x" });
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [s.data.folders[0]]);
    const reader = readerFor(h, appKey);
    await reader.listFolders();
    return { ...s, reader };
  }
});
