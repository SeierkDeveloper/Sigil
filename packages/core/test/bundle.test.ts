// The vault bundle: made from what a node stores, sealed with the vault's
// signing key, written as a gzip file, checked by anyone, opened only with the
// vault key, and restored with a statement the device signs for one node.

import { describe, expect, it } from "vitest";
import {
  bundleHash,
  bundleShapeError,
  buildMemory,
  createApp,
  createBoxKey,
  createFolder,
  decodeBundle,
  encodeBundle,
  encryptMemory,
  importKey,
  newVaultKey,
  openBundle,
  phraseKeys,
  sealBundle,
  sealSetting,
  signRestore,
  unwrapFromBundle,
  vaultSigningKey,
  verifyBundle,
  verifyRestore,
  walletKeys,
  wrapVaultKey,
  newRecoveryPhrase,
  BUNDLE_PARTS,
  macBundle,
  gunzipLimited,
  parseAppKey,
  type BundleBody,
} from "../src/index";
import { gzipSync } from "fflate";

const ADDRESS = "0x000000000000000000000000000000000000dEaD";
const SIGNATURE = `0x${"ab".repeat(65)}`;

async function vault() {
  const raw = newVaultKey();
  const key = await importKey(raw);
  const phrase = newRecoveryPhrase();
  const pk = await phraseKeys(phrase);
  const wk = await walletKeys(ADDRESS, SIGNATURE);
  const signing = await vaultSigningKey(raw);
  const box = await createBoxKey(key);
  const { stored: folder, folder: open } = await createFolder(key, "Notes");
  const memories = [];
  for (const [title, body] of [
    ["Parking", "Level 3, by the lift."],
    ["Bread", "Feed the starter twice a day."],
  ]) {
    const stored = await encryptMemory(open, buildMemory({ title, body }, folder.id));
    memories.push({ ...stored, body: stored.body!, updatedAt: "2026-11-20T10:00:00.000Z" });
  }
  const parts = Object.fromEntries(BUNDLE_PARTS.map((p) => [p, []])) as unknown as BundleBody["parts"];
  const body: BundleBody = {
    origin: "https://old.example",
    periodSeconds: 3600,
    createdAt: "2026-11-20T12:00:00.000Z",
    madeBy: "vault",
    vault: { boxPublicKey: box.stored.publicKey, boxWrappedSecret: box.stored.wrappedSecret, signKey: signing.publicKey, createdAt: "2026-01-01T00:00:00.000Z" },
    keyslots: [
      { kind: "phrase", ref: pk.lookupId, authHash: "aa".repeat(32), wrappedKey: await wrapVaultKey(pk.kek, raw, "phrase") },
      { kind: "wallet", ref: ADDRESS.toLowerCase(), authHash: "bb".repeat(32), wrappedKey: await wrapVaultKey(wk.kek, raw, "wallet") },
    ],
    folders: [{ ...folder, protected: false, createdAt: "2026-01-01T00:00:00.000Z" }],
    memories: memories.map((m) => ({ id: m.id, folderId: m.folderId, head: m.head, body: m.body, deleteAfter: null, updatedAt: m.updatedAt })),
    settings: { thinking: await sealSetting(key, "thinking", { weeklyBrief: false }) },
    log: [
      {
        id: "entry-000001",
        appId: "app-0000001",
        kind: "read",
        memoryId: memories[0].id,
        count: 1,
        at: "2026-11-20T10:15:00.000Z",
        salt: "ab".repeat(32),
        leaf: `0x${"cd".repeat(32)}`,
        hour: 491_000,
        note: null,
        seal: { origin: "https://old.example", periodSeconds: 3600, root: `0x${"ef".repeat(32)}`, index: 0, proof: [] },
      },
    ],
    parts,
  };
  return { raw, key, phrase, pk, wk, signing, body };
}

describe("a vault bundle", () => {
  it("is sealed with the vault's signing key and checked by anyone, through a gzip file", async () => {
    const v = await vault();
    const bundle = sealBundle(v.body, v.signing);
    expect(bundle.hash).toBe(bundleHash(v.body));
    const file = encodeBundle(bundle);
    expect([file[0], file[1]]).toEqual([0x1f, 0x8b]);
    const back = decodeBundle(file);
    const r = verifyBundle(back);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ folders: 1, memories: 2, logEntries: 1, sealedEntries: 1, madeBy: "vault", restoreWith: ["phrase", "wallet"] });
    // Plain JSON reads too.
    expect(decodeBundle(new TextEncoder().encode(JSON.stringify(bundle))).hash).toBe(bundle.hash);
  });

  it("refuses a signing key that is not the vault's, and catches any change", async () => {
    const v = await vault();
    const other = await vaultSigningKey(newVaultKey());
    expect(() => sealBundle(v.body, other)).toThrow(/another vault/);
    const bundle = sealBundle(v.body, v.signing);

    const changed = structuredClone(bundle);
    changed.body.memories[1].head = changed.body.memories[0].head;
    const r = verifyBundle(changed);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "hash")?.ok).toBe(false);

    const resigned = structuredClone(bundle);
    resigned.signature = sealBundle({ ...v.body, createdAt: "2026-11-21T00:00:00.000Z" }, v.signing).signature;
    expect(verifyBundle(resigned).checks.find((c) => c.name === "signature")?.ok).toBe(false);

    const unsigned = { ...bundle, signature: null };
    expect(verifyBundle(unsigned).ok).toBe(false);
    const byConnector = sealBundle({ ...v.body, madeBy: "connector" }, null);
    expect(verifyBundle(byConnector).ok).toBe(true);

    expect(bundleShapeError({ ...v.body, folders: [] })).toMatch(/folder/);
    expect(bundleShapeError({ ...v.body, settings: { nonsense: "x" } })).toMatch(/setting/);
    expect(() => decodeBundle(new Uint8Array([1, 2, 3]))).toThrow(/not a Sigil bundle/);
  });

  it("opens with the vault key from its own key slot, and only that vault's", async () => {
    const v = await vault();
    const bundle = sealBundle(v.body, v.signing);
    const viaPhrase = await unwrapFromBundle(bundle, "phrase", v.pk.lookupId, v.pk.kek);
    expect(viaPhrase).toEqual(v.raw);
    const viaWallet = await unwrapFromBundle(bundle, "wallet", ADDRESS, v.wk.kek);
    expect(viaWallet).toEqual(v.raw);
    const wrong = await phraseKeys(newRecoveryPhrase());
    await expect(unwrapFromBundle(bundle, "phrase", v.pk.lookupId, wrong.kek)).rejects.toThrow(/does not open/);
    await expect(unwrapFromBundle(bundle, "phrase", wrong.lookupId, wrong.kek)).rejects.toThrow(/does not open/);

    expect(await openBundle(bundle, v.raw)).toEqual({ folders: 1, memories: 2, settings: 1, unreadable: 0 });
    await expect(openBundle(bundle, newVaultKey())).rejects.toThrow(/another vault/);

    // A memory moved onto another record's ciphertext does not open there, even in a bundle signed after the move.
    const swappedBody = structuredClone(v.body);
    swappedBody.memories[1] = { ...swappedBody.memories[1], body: swappedBody.memories[0].body };
    expect((await openBundle(sealBundle(swappedBody, v.signing), v.raw)).unreadable).toBe(1);
  });

  it("is refused at restore when anything changed on its way, or when its maker cannot be shown", async () => {
    const v = await vault();
    const bundle = sealBundle(v.body, v.signing);

    // A memory left out, with the hash made again: the vault's signature no longer holds.
    const dropped = structuredClone(bundle);
    dropped.body.memories.pop();
    dropped.hash = bundleHash(dropped.body);
    await expect(openBundle(dropped, v.raw)).rejects.toThrow(/changed after it was made/);

    // The same, relabelled as made by a connector and stripped of its signature: refused, there is no MAC.
    const relabelled = structuredClone(bundle);
    relabelled.body.madeBy = "connector";
    relabelled.signature = null;
    relabelled.hash = bundleHash(relabelled.body);
    expect(verifyBundle(relabelled).ok).toBe(true);
    await expect(openBundle(relabelled, v.raw)).rejects.toThrow(/changed after it was made/);

    // A hash that does not cover the body.
    await expect(openBundle({ ...bundle, hash: `0x${"00".repeat(32)}` }, v.raw)).rejects.toThrow(/changed after it was made/);
  });

  it("from a connector carries an HMAC from the app's secret, which only the vault can check", async () => {
    const v = await vault();
    const app = await createApp(v.key, { name: "Backup", kind: "other" }, []);
    const { secret } = parseAppKey(app.appKey);
    const body: BundleBody = structuredClone({ ...v.body, madeBy: "connector" });
    (body.parts.apps as unknown as { table: string; row: Record<string, unknown> }[]).push({ table: "apps", row: { id: app.stored.id, secret: app.stored.secret, meta: app.stored.meta, user_id: "@vault" } });
    const bundle = await macBundle(body, app.stored.id, secret);
    expect(bundle.signature).toBeNull();
    expect(await openBundle(bundle, v.raw)).toMatchObject({ memories: 2, unreadable: 0 });

    // A capture key slipped in on the way: the HMAC no longer holds.
    const planted = structuredClone(bundle);
    (planted.body.parts.captureKeys as unknown as unknown[]).push({ table: "capture_keys", row: { id: "capture-001", token_hash: "aa".repeat(32), user_id: "@vault" } });
    planted.hash = bundleHash(planted.body);
    await expect(openBundle(planted, v.raw)).rejects.toThrow(/changed after it was made/);

    // An HMAC made with another secret, or naming an app the bundle does not hold.
    const other = await macBundle(body, app.stored.id, new Uint8Array(32).fill(7));
    await expect(openBundle(other, v.raw)).rejects.toThrow(/changed after it was made/);
    await expect(openBundle({ ...bundle, mac: { appId: "app-missing1", tag: bundle.mac!.tag } }, v.raw)).rejects.toThrow(/changed after it was made/);
    await expect(openBundle({ ...bundle, mac: null }, v.raw)).rejects.toThrow(/changed after it was made/);
  });

  it("refuses a file that unpacks to more than a bundle can hold", () => {
    const zeros = gzipSync(new Uint8Array(4 * 1024 * 1024));
    expect(zeros.length).toBeLessThan(64 * 1024);
    expect(() => gunzipLimited(zeros, 1024 * 1024)).toThrow();
    expect(gunzipLimited(zeros, 8 * 1024 * 1024).length).toBe(4 * 1024 * 1024);
  });

  it("is restored with a statement signed for one node, for ten minutes", async () => {
    const v = await vault();
    const bundle = sealBundle(v.body, v.signing);
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const s = { origin: "https://new.example", bundle: bundle.hash, issuedAt: new Date(now).toISOString() };
    const sig = signRestore(v.signing, s);
    expect(verifyRestore(v.signing.publicKey, s, sig, now)).toBe(true);
    expect(verifyRestore(v.signing.publicKey, { ...s, origin: "https://elsewhere.example" }, sig, now)).toBe(false);
    expect(verifyRestore(v.signing.publicKey, { ...s, bundle: `0x${"00".repeat(32)}` }, sig, now)).toBe(false);
    expect(verifyRestore(v.signing.publicKey, s, sig, now + 11 * 60_000)).toBe(false);
    expect(verifyRestore((await vaultSigningKey(newVaultKey())).publicKey, s, sig, now)).toBe(false);
  });
});
