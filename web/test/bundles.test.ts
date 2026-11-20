// A vault as one bundle: made on the owner's device from what the node holds,
// stored with the owner's own storage (answered by the test, never a real
// service), and restored into an empty node with the owner's sign-in, with its
// log, its apps, its shared spaces and its proofs intact.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeBundle,
  encodeBundle,
  fromHex32,
  newRecoveryPhrase,
  openSetting,
  phraseKeys,
  readEntryLeaf,
  signRestore,
  vaultSigningKey,
  verifyProof,
  type S3Target,
} from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as storage from "../src/vault/storageOps";
import * as agents from "../src/vault/agentOps";
import { sealPending } from "../src/server/seal";
import { BackupWorker } from "../../connector/src/backup";

const CANARY = "CANARY-bundle-plaintext-7c";
const OLD = "https://old.example";
const NEW = "https://new.example";

const S3: S3Target = { kind: "s3", id: "target-s3-0001", label: "My bucket", endpoint: "https://s3.example.test", region: "eu-west-1", bucket: "vault-backups", prefix: "", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "CANARY-storage-secret" };

/** A storage service played by the test: it keeps what it is given and hands it back. */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const calls: { method: string; url: string; headers: Headers }[] = [];
  const fetcher = async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", url, headers: new Headers(init.headers) });
    if (init.method === "PUT") {
      objects.set(url, init.body as Uint8Array);
      return new Response(null, { status: 200 });
    }
    const found = objects.get(url.split("?")[0]);
    return found ? new Response(found as BodyInit) : new Response("NoSuchKey", { status: 404 });
  };
  return { objects, calls, fetcher };
}

let oldNode: Harness;
let newNode: Harness;
beforeEach(() => {
  oldNode = harness(OLD);
  newNode = harness(NEW);
});

async function filledVault() {
  const o = await signedUp(oldNode);
  const work = await ops.addFolder(o.b.api, o.vault, "Work");
  await ops.createMemory(o.b.api, work, { title: "Parking", body: `Level 3. ${CANARY}` });
  const app = await ops.connectApp(o.b.api, o.vault, { name: "Claude", kind: "claude-desktop" }, [work]);
  // The app reads, so the log has entries; the hour is sealed.
  const reader = readerFor(oldNode, app.appKey, {}, OLD);
  await reader.search("parking");
  const spaceId = await agents.createSpace(o.b.api, o.data, "Team notes", "Sam");
  const data = await ops.loadVault(o.b.api, o.vault);
  await agents.saveSpaceMemory(o.b.api, data.spaces.find((s) => s.id === spaceId)!, { title: "Shared", body: `Space text ${CANARY}` });
  sealPending(oldNode.db, Date.now() + 2 * 3600_000);
  return { ...o, work, app, spaceId, data: await ops.loadVault(o.b.api, o.vault) };
}

describe("a vault bundle from a node", () => {
  it("holds every part as ciphertext, signed by the device and opened in full with the vault key", async () => {
    const o = await filledVault();
    const bundle = await storage.makeBundle(o.b.api, o.vault);
    expect(bundle.signature).not.toBeNull();
    expect(bundle.body.origin).toBe(OLD);
    expect(bundle.body.memories.length).toBe(o.data.memories.length);
    expect(bundle.body.keyslots.map((k) => k.kind).sort()).toEqual(["phrase", "wallet"]);
    expect(bundle.body.log.length).toBeGreaterThan(0);
    expect(bundle.body.log.every((e) => e.seal)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain(CANARY);
    // Ids that only mean something on the old node are not in it.
    const userId = (oldNode.db.prepare("SELECT id FROM users").get() as { id: string }).id;
    expect(JSON.stringify(bundle)).not.toContain(userId);
  });

  it("is stored by the device in the owner's own bucket, with the token kept only in the vault", async () => {
    const o = await filledVault();
    const settings = await storage.saveBackupSettings(o.b.api, o.vault, { v: 1, targets: [S3], every: "daily" });
    let data = await ops.loadVault(o.b.api, o.vault);
    expect(data.backups.settings).toEqual(settings);
    const store = bucket();
    const files: string[] = [];
    const r = await storage.runBackup(o.b.api, o.vault, data, { fetcher: store.fetcher, download: (_b, name) => files.push(name) });
    expect(files).toEqual([r.name]);
    expect(r.record.places.map((p) => p.kind)).toEqual(["file", "s3"]);
    expect([...store.objects.keys()]).toEqual([`https://s3.example.test/vault-backups/${r.name}`]);
    expect(store.calls[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    data = await ops.loadVault(o.b.api, o.vault);
    expect(data.backups.runs[0]).toMatchObject({ hash: r.bundle.hash, record: { places: r.record.places } });
    expect(storage.lastBackupAt(data.backups)).toBe(data.backups.runs[0].createdAt);
    const log = await ops.loadLog(o.b.api);
    expect(log.entries.find((e) => e.kind === "backup")).toMatchObject({ memoryId: r.bundle.hash, count: 2 });
    // The node never saw the token, the bundle's contents, or where it went.
    const wire = dumpDb(oldNode.db) + oldNode.sent.join("\n");
    expect(wire).not.toContain("CANARY-storage-secret");
    expect(wire).not.toContain("vault-backups");
    expect(wire).not.toContain(CANARY);
    // A failing target is recorded as failed, and the others still get the bundle.
    const down = await storage.runBackup(o.b.api, o.vault, data, { fetcher: async () => new Response("SlowDown", { status: 503 }) });
    expect(down.record.failed).toEqual([{ targetId: S3.id, label: "My bucket", reason: "The bucket answered 503: SlowDown." }]);
  });

  it("is made by a connector in the background, unsigned, with targets wrapped for its key only", async () => {
    const o = await filledVault();
    await storage.saveBackupSettings(o.b.api, o.vault, { v: 1, targets: [S3], every: "daily" });
    let data = await ops.loadVault(o.b.api, o.vault);
    const app = data.apps.find((a) => a.id === o.app.appId)!;
    await storage.setConnectorBackup(o.b.api, o.vault, data, app, true);
    data = await ops.loadVault(o.b.api, o.vault);
    expect(data.backups.apps).toEqual([app.id]);
    expect(dumpDb(oldNode.db)).not.toContain("CANARY-storage-secret");
    const store = bucket();
    const worker = new BackupWorker(readerFor(oldNode, o.app.appKey, {}, OLD), store.fetcher);
    expect(await worker.allowed()).toBe(true);
    const r = await worker.once();
    expect(r?.places).toHaveLength(1);
    // Not due again until tomorrow.
    expect(await worker.once()).toBeNull();
    const stored = decodeBundle([...store.objects.values()][0]);
    expect(stored).toMatchObject({ signature: null, body: { madeBy: "connector" } });
    data = await ops.loadVault(o.b.api, o.vault);
    expect(data.backups.runs[0]).toMatchObject({ byApp: app.id, record: { by: "connector", places: [{ kind: "s3" }] } });
    // It restores like any bundle: the owner's device checks every part with the vault key.
    const opened = await storage.openForRestore(stored, { kind: "phrase", phrase: o.phrase });
    expect(opened.opened.unreadable).toBe(0);
    // Another app may not.
    await storage.setConnectorBackup(o.b.api, o.vault, data, app, false);
    expect(await worker.allowed()).toBe(false);
  });
});

describe("restoring a bundle", () => {
  it("makes the vault again on an empty node, with the owner's sign-in, its log, apps and spaces", async () => {
    const o = await filledVault();
    const bundle = await storage.makeBundle(o.b.api, o.vault);
    const file = encodeBundle(bundle);

    const b = newNode.browser();
    const loaded = await storage.loadBundle({ kind: "file", bytes: file });
    const opened = await storage.openForRestore(loaded, { kind: "phrase", phrase: o.phrase });
    expect(opened.vault.raw).toEqual(o.vault.raw);
    const r = await storage.restoreHere(b.api, opened, loaded, NEW);
    expect(r.report).toMatchObject({ folders: o.data.folders.length, memories: o.data.memories.length });
    expect(r.report.left).toEqual({});

    // Signed in on the new node; everything opens as it did.
    const data = await ops.loadVault(b.api, opened.vault);
    expect(data.unreadable).toBe(0);
    expect(data.memories.map((m) => m.title).sort()).toEqual(o.data.memories.map((m) => m.title).sort());
    expect(data.memories.find((m) => m.title === "Parking")?.body).toContain(CANARY);
    expect(data.boxPublic).toBe(o.data.boxPublic);
    expect(data.signKey).toBe(o.data.signKey);
    expect(data.spaces.map((s) => s.name)).toEqual(["Team notes"]);
    expect(data.spaces[0].memories[0].body).toContain(CANARY);
    // The app key works on the new node as it is: only the address changes.
    const reader = readerFor(newNode, o.app.appKey, {}, NEW);
    expect((await reader.search("parking")).map((x) => x.title)).toEqual(["Parking"]);
    // The old log came along, each sealed entry with the proof it was sealed with on the old node.
    const log = await ops.loadLog(b.api, 1000);
    const carried = log.entries.find((e) => e.kind === "index" && e.carried)!;
    const proof = await b.api.get<{ root: string; proof: string[]; leaf: string; origin: string }>(`log/${carried.id}/proof`);
    expect(proof.origin).toBe(OLD);
    expect(verifyProof(fromHex32(proof.root), readEntryLeaf(carried), proof.proof.map(fromHex32))).toBe(true);
    expect(log.entries.find((e) => e.kind === "node")?.memoryId).toBe(`restored-${bundle.hash}`);
    // Signing in again with the phrase works on the new node.
    const again = await ops.signInWithPhrase(newNode.browser().api, o.phrase);
    expect(again.raw).toEqual(o.vault.raw);
    expect(dumpDb(newNode.db) + newNode.sent.join("\n")).not.toContain(CANARY);
  });

  it("is refused without the owner's keys, for another node, too late, or twice", async () => {
    const o = await filledVault();
    const bundle = await storage.makeBundle(o.b.api, o.vault);
    const opened = await storage.openForRestore(bundle, { kind: "phrase", phrase: o.phrase });
    const key = await vaultSigningKey(o.vault.raw);
    const b = newNode.browser();
    const issuedAt = new Date().toISOString();
    const send = (over: Record<string, unknown>) =>
      b.api.post("restore", { bundle, signIn: opened.signIn, statement: { issuedAt, signature: signRestore(key, { origin: NEW, bundle: bundle.hash, issuedAt }) }, ...over });

    await expect(storage.openForRestore(bundle, { kind: "phrase", phrase: newRecoveryPhrase() })).rejects.toThrow(/does not open/);
    await expect(send({ statement: { issuedAt, signature: signRestore(key, { origin: OLD, bundle: bundle.hash, issuedAt }) } })).rejects.toMatchObject({ code: "bad_restore" });
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await expect(send({ statement: { issuedAt: old, signature: signRestore(key, { origin: NEW, bundle: bundle.hash, issuedAt: old }) } })).rejects.toMatchObject({ code: "bad_restore" });
    const wrong = await phraseKeys(newRecoveryPhrase());
    await expect(send({ signIn: { ...opened.signIn, authToken: wrong.authToken } })).rejects.toMatchObject({ code: "bad_sign_in" });
    const changed = structuredClone(bundle);
    changed.body.memories[0].head = changed.body.memories[0].body.slice(0, 40);
    await expect(send({ bundle: changed })).rejects.toMatchObject({ code: "bad_bundle" });
    expect(count(newNode.db, "SELECT COUNT(*) AS n FROM users")).toBe(0);

    await send({});
    await expect(send({})).rejects.toMatchObject({ code: "vault_exists" });
    // And never into the node it already lives on.
    const sameNode = await signRestore(key, { origin: OLD, bundle: bundle.hash, issuedAt });
    await expect(o.b.api.post("restore", { bundle, signIn: opened.signIn, statement: { issuedAt, signature: sameNode } })).rejects.toMatchObject({ code: "vault_exists" });
  });

  it("keeps the backup settings, encrypted, and reads a bundle back from the owner's bucket through the node", async () => {
    const o = await filledVault();
    await storage.saveBackupSettings(o.b.api, o.vault, { v: 1, targets: [S3], every: "weekly" });
    const data = await ops.loadVault(o.b.api, o.vault);
    const store = bucket();
    const made = await storage.runBackup(o.b.api, o.vault, data, { fetcher: store.fetcher });
    const ref = made.record.places[0].ref;
    // The device presigns a read for the node: the node fetches ciphertext with an address that expires, never the keys.
    const url = storage.sourceUrl({ kind: "s3", target: S3, key: ref });
    expect(url).toContain("X-Amz-Signature=");
    expect(url).not.toContain(S3.secretAccessKey);
    const { setNodeFetch } = await import("../src/server/nodes");
    setNodeFetch(store.fetcher);
    try {
      const b = newNode.browser();
      const loaded = await storage.loadBundle({ kind: "s3", target: S3, key: ref }, b.fetcher);
      expect(loaded.hash).toBe(made.bundle.hash);
      const opened = await storage.openForRestore(loaded, { kind: "wallet", address: o.w.address, signature: o.w.signature });
      await storage.restoreHere(b.api, opened, loaded, NEW);
      const restored = await ops.loadVault(b.api, opened.vault);
      expect(restored.backups.settings.every).toBe("weekly");
      expect(await openSetting(opened.vault.key, "backup", (newNode.db.prepare("SELECT value FROM vault_settings WHERE name = 'backup'").get() as { value: string }).value)).toMatchObject({ targets: [S3] });
      // A private address is never fetched for a restore, unless this node allows it.
      await expect(storage.loadBundle({ kind: "url", url: "http://10.0.0.5/bundle" }, b.fetcher)).rejects.toThrow();
    } finally {
      setNodeFetch(null);
    }
  });
});

afterEach(async () => {
  const { setNodeFetch } = await import("../src/server/nodes");
  setNodeFetch(null);
});
