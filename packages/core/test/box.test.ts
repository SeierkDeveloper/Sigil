import { describe, expect, it } from "vitest";
import {
  appBoxTag,
  boxKeyPairFromSecret,
  cleanProposal,
  createBoxKey,
  createFolder,
  DecryptError,
  decodeBoxPublicKey,
  decryptMemory,
  encodeBoxPublicKey,
  encryptShareNote,
  formatVaultCode,
  importKey,
  isSealed,
  mergeBodies,
  newBoxKeyPair,
  openBoxKey,
  openGrant,
  openProposal,
  openSealedBytes,
  openSealedJson,
  openShare,
  openShareNote,
  parseVaultCode,
  rotateFolder,
  sealBytes,
  sealJson,
  sealProposal,
  sealShare,
  vaultFingerprint,
  verifyAppBoxTag,
  appKeys,
  buildMemory,
  encryptMemory,
  newAppSecret,
  newVaultKey,
  utf8,
  fromUtf8,
  toBase64Url,
  fromBase64Url,
} from "../src/index";

const SECRET = "CANARY-box-plaintext-55";

describe("sealed boxes", () => {
  it("round trips to the right key and context", () => {
    const pair = newBoxKeyPair();
    const sealed = sealBytes(pair.publicKey, utf8(SECRET), "proposal:abc:app1");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(toBase64Url(utf8(SECRET)));
    expect(fromUtf8(openSealedBytes(pair, sealed, "proposal:abc:app1"))).toBe(SECRET);
  });

  it("uses a fresh ephemeral key every time", () => {
    const pair = newBoxKeyPair();
    const a = sealBytes(pair.publicKey, utf8("same"), "c");
    const b = sealBytes(pair.publicKey, utf8("same"), "c");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("fails with the wrong key", () => {
    const pair = newBoxKeyPair();
    const other = newBoxKeyPair();
    const sealed = sealBytes(pair.publicKey, utf8(SECRET), "c");
    expect(() => openSealedBytes(other, sealed, "c")).toThrow(DecryptError);
  });

  it("fails in another context, so a box cannot be moved to another record", () => {
    const pair = newBoxKeyPair();
    const sealed = sealBytes(pair.publicKey, utf8(SECRET), "proposal:one:app1");
    expect(() => openSealedBytes(pair, sealed, "proposal:two:app1")).toThrow(DecryptError);
    expect(() => openSealedBytes(pair, sealed, "proposal:one:app2")).toThrow(DecryptError);
  });

  it("fails when any part is changed", () => {
    const pair = newBoxKeyPair();
    const sealed = sealBytes(pair.publicKey, utf8(SECRET), "c");
    const [v, e, n, ct] = sealed.split(".");
    const flip = (s: string) => {
      const b = fromBase64Url(s);
      b[b.length - 1] ^= 1;
      return toBase64Url(b);
    };
    for (const bad of [`${v}.${flip(e)}.${n}.${ct}`, `${v}.${e}.${flip(n)}.${ct}`, `${v}.${e}.${n}.${flip(ct)}`]) {
      expect(() => openSealedBytes(pair, bad, "c")).toThrow(DecryptError);
    }
    expect(() => openSealedBytes(pair, "s1.nope", "c")).toThrow(DecryptError);
    expect(() => openSealedBytes(pair, "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb", "c")).toThrow(DecryptError);
  });

  it("refuses a low-order public key", () => {
    expect(() => sealBytes(new Uint8Array(32), utf8("x"), "c")).toThrow();
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(() => sealBytes(one, utf8("x"), "c")).toThrow();
  });

  it("seals JSON", () => {
    const pair = newBoxKeyPair();
    expect(openSealedJson(pair, sealJson(pair.publicKey, { a: SECRET }, "j"), "j")).toEqual({ a: SECRET });
  });
});

describe("the vault box key", () => {
  it("is wrapped by the vault key and opens only with it", async () => {
    const vk = await importKey(newVaultKey());
    const { stored, pair } = await createBoxKey(vk);
    expect(decodeBoxPublicKey(stored.publicKey)).toEqual(pair.publicKey);
    expect(stored.wrappedSecret).not.toContain(toBase64Url(pair.secretKey));
    const opened = await openBoxKey(vk, stored);
    expect(opened.secretKey).toEqual(pair.secretKey);
    await expect(openBoxKey(await importKey(newVaultKey()), stored)).rejects.toThrow(DecryptError);
  });

  it("notices a public key swapped on the server", async () => {
    const vk = await importKey(newVaultKey());
    const { stored } = await createBoxKey(vk);
    const swapped = { ...stored, publicKey: encodeBoxPublicKey(newBoxKeyPair().publicKey) };
    await expect(openBoxKey(vk, swapped)).rejects.toThrow("does not match");
  });

  it("derives the same public key from the secret", () => {
    const pair = newBoxKeyPair();
    expect(boxKeyPairFromSecret(pair.secretKey).publicKey).toEqual(pair.publicKey);
  });
});

describe("app tags for the vault public key", () => {
  it("verify with the app's secret and nothing else", async () => {
    const secret = newAppSecret();
    const pub = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    const tag = await appBoxTag(secret, pub);
    expect(await verifyAppBoxTag(secret, pub, tag)).toBe(true);
    expect(await verifyAppBoxTag(newAppSecret(), pub, tag)).toBe(false);
    const other = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    expect(await verifyAppBoxTag(secret, other, tag)).toBe(false);
    expect(await verifyAppBoxTag(secret, pub, "nope")).toBe(false);
  });
});

describe("vault codes", () => {
  it("round trip and catch typing errors", () => {
    const pub = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    const code = formatVaultCode(pub);
    expect(code.startsWith("sigil_vault.")).toBe(true);
    expect(parseVaultCode(`  ${code}\n`)).toBe(pub);
    const broken = code.slice(0, 20) + (code[20] === "A" ? "B" : "A") + code.slice(21);
    expect(() => parseVaultCode(broken)).toThrow();
    expect(() => parseVaultCode("sigil_app.x.y")).toThrow("not a Sigil vault code");
    expect(vaultFingerprint(pub)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/);
  });
});

describe("proposals", () => {
  it("seal on the app side and open in the vault", () => {
    const pair = newBoxKeyPair();
    const payload = cleanProposal({ title: "  Prefers  short answers ", body: SECRET, tags: ["Style", "style"], folder: "Notes", url: "https://example.org/a" }, "mcp");
    expect(payload).toMatchObject({ title: "Prefers short answers", tags: ["style"], folder: "Notes", url: "https://example.org/a" });
    const sealed = sealProposal(pair.publicKey, "prop12345678", "app12345678", payload);
    expect(sealed).not.toContain(SECRET);
    expect(openProposal(pair, { id: "prop12345678", appId: "app12345678", sealed })).toMatchObject({ body: SECRET, via: "mcp" });
    expect(() => openProposal(pair, { id: "prop12345678", appId: "otherapp1234", sealed })).toThrow(DecryptError);
    expect(() => openProposal(newBoxKeyPair(), { id: "prop12345678", appId: "app12345678", sealed })).toThrow(DecryptError);
  });

  it("cleans what an app sends", () => {
    expect(() => cleanProposal({ title: " ", body: "" }, "mcp")).toThrow();
    expect(cleanProposal({ title: "", body: "Only a body here" }, "sdk").title).toBe("Only a body here");
    expect(cleanProposal({ title: "x", body: "y", url: "javascript:alert(1)" }, "extension").url).toBeNull();
    expect(cleanProposal({ title: "x", body: "y".repeat(200_000) }, "mcp").body).toHaveLength(100_000);
  });

  it("merges text into an existing memory once", () => {
    const merged = mergeBodies("Old text", "New text", "2026-11-20T10:00:00.000Z");
    expect(merged).toBe("Old text\n\n---\nAdded 2026-11-20\n\nNew text");
    expect(mergeBodies(merged, "New text")).toBe(merged);
    expect(mergeBodies("", "New")).toBe("New");
  });
});

describe("sharing", () => {
  it("seals a folder key to another vault, which opens it and reads the folder", async () => {
    const ownerKey = await importKey(newVaultKey());
    const recipient = newBoxKeyPair();
    const recipientPub = encodeBoxPublicKey(recipient.publicKey);
    const { stored, folder } = await createFolder(ownerKey, "Recipes");
    const memory = buildMemory({ title: "Bread", body: SECRET }, folder.id);
    const storedMemory = await encryptMemory(folder, memory);

    const sealedKey = sealShare(recipientPub, "share1234567", folder.id, folder.raw, "Alex");
    expect(sealedKey).not.toContain(toBase64Url(folder.raw));
    const opened = openShare(recipient, { id: "share1234567", folderId: folder.id, sealedKey });
    expect(opened).toEqual({ raw: folder.raw, from: "Alex" });
    const asRecipient = await (await import("../src/vault")).openFolderWithRaw(stored, opened.raw);
    expect(asRecipient.name).toBe("Recipes");
    expect((await decryptMemory(asRecipient, storedMemory)).body).toBe(SECRET);

    expect(() => openShare(newBoxKeyPair(), { id: "share1234567", folderId: folder.id, sealedKey })).toThrow(DecryptError);
    expect(() => openShare(recipient, { id: "share7654321", folderId: folder.id, sealedKey })).toThrow(DecryptError);
  });

  it("keeps the owner's note encrypted under the vault key", async () => {
    const vk = await importKey(newVaultKey());
    const pub = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    const env = await encryptShareNote(vk, "share1234567", { label: "My sister", recipient: pub });
    expect(env).not.toContain("sister");
    expect(await openShareNote(vk, "share1234567", env)).toEqual({ label: "My sister", recipient: pub });
    await expect(openShareNote(vk, "share0000000", env)).rejects.toThrow(DecryptError);
  });

  it("rotation gives a new key: the old key opens nothing new, everyone kept still reads", async () => {
    const vk = await importKey(newVaultKey());
    const { folder } = await createFolder(vk, "Family");
    const memories = [buildMemory({ title: "One", body: SECRET }, folder.id), buildMemory({ title: "Two", body: "b" }, folder.id)];
    const appSecret = newAppSecret();
    const kept = newBoxKeyPair();

    const r = await rotateFolder(vk, folder, memories, [{ id: "app12345678", secret: appSecret }], [
      { id: "kept12345678", recipient: encodeBoxPublicKey(kept.publicKey), from: "Owner" },
    ]);
    expect(r.folder.raw).not.toEqual(folder.raw);
    expect(r.memories).toHaveLength(2);

    // The old key (what a revoked recipient may hold) no longer opens the folder.
    for (const m of r.memories) await expect(decryptMemory(folder, m)).rejects.toThrow(DecryptError);
    // The vault opens it with the newly wrapped key.
    const reopened = await (await import("../src/vault")).openFolder(vk, { id: folder.id, meta: r.meta, wrappedKey: r.wrappedKey });
    expect(reopened.name).toBe("Family");
    expect((await decryptMemory(reopened, r.memories[0])).body).toBe(SECRET);
    // The app opens its new grant.
    const wrap = await importKey((await appKeys(appSecret)).wrapKey);
    expect(await openGrant("app12345678", wrap, r.grants[0])).toEqual(r.folder.raw);
    // The kept recipient opens the new key.
    expect(openShare(kept, { id: "kept12345678", folderId: folder.id, sealedKey: r.shares[0].sealedKey }).raw).toEqual(r.folder.raw);

    await expect(rotateFolder(vk, folder, [buildMemory({ title: "x", body: "y" }, "otherfolder1")], [], [])).rejects.toThrow();
  });
});
