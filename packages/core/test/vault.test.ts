import { describe, expect, it } from "vitest";
import {
  appKeys,
  buildMemory,
  createApp,
  createFolder,
  decryptHead,
  decryptMemory,
  encryptMemory,
  importKey,
  newVaultKey,
  openAppMeta,
  openAppSecret,
  openFolder,
  openFolderWithRaw,
  openGrant,
  parseAppKey,
  renameFolder,
  vaultCryptoKey,
  wrapGrants,
  DecryptError,
  makeSnippet,
  cleanTags,
} from "../src";

const CANARY = "CANARY-PLAINTEXT-7f3a";

describe("folders and memories", () => {
  it("encrypt and decrypt a memory through its folder", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { stored, folder } = await createFolder(vk, `Travel ${CANARY}`);
    expect(JSON.stringify(stored)).not.toContain(CANARY);

    const reopened = await openFolder(vk, stored);
    expect(reopened.name).toBe(`Travel ${CANARY}`);
    expect(reopened.raw).toEqual(folder.raw);

    const memory = buildMemory({ title: `Title ${CANARY}`, body: `Body ${CANARY}\nline two`, tags: ["Trip Plans", "trip plans", " x "] }, folder.id);
    expect(memory.tags).toEqual(["trip-plans", "x"]);
    const enc = await encryptMemory(folder, memory);
    expect(JSON.stringify(enc)).not.toContain(CANARY);
    expect(JSON.stringify(enc)).not.toContain("Title");

    const dec = await decryptMemory(reopened, enc);
    expect(dec).toEqual({ ...memory, snippet: makeSnippet(memory.body) });
    const head = await decryptHead(reopened, enc);
    expect(head.title).toBe(memory.title);
    expect(head.snippet).toContain(CANARY);
  });

  it("refuses a memory swapped into another record or folder", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { folder: a } = await createFolder(vk, "A");
    const { folder: b } = await createFolder(vk, "B");
    const m1 = await encryptMemory(a, buildMemory({ title: "one", body: "1" }, a.id));
    const m2 = await encryptMemory(a, buildMemory({ title: "two", body: "2" }, a.id));
    await expect(decryptMemory(b, m1)).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptMemory(a, { ...m1, body: m2.body })).rejects.toBeInstanceOf(DecryptError);
    await expect(encryptMemory(b, buildMemory({ title: "x", body: "y" }, a.id))).rejects.toThrow();
  });

  it("a folder key cannot be opened with another vault key", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const other = await vaultCryptoKey(newVaultKey());
    const { stored } = await createFolder(vk, "Private");
    await expect(openFolder(other, stored)).rejects.toBeInstanceOf(DecryptError);
  });

  it("renames a folder", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { stored, folder } = await createFolder(vk, "Old");
    const meta = await renameFolder(folder, "New");
    expect((await openFolder(vk, { ...stored, meta })).name).toBe("New");
  });

  it("snippets and tags are bounded", () => {
    expect(makeSnippet("a ".repeat(500)).length).toBeLessThanOrEqual(240);
    expect(cleanTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(32);
  });
});

describe("apps", () => {
  it("an app reads exactly the folders it was granted", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { stored: sa, folder: a } = await createFolder(vk, "Work");
    const { folder: b } = await createFolder(vk, "Health");
    const app = await createApp(vk, { name: "Claude Desktop", kind: "claude-desktop" }, [a]);

    expect(app.stored.grants.map((g) => g.folderId)).toEqual([a.id]);
    expect(JSON.stringify(app.stored)).not.toContain("Claude Desktop");
    expect(JSON.stringify(app.stored)).not.toContain(app.appKey.split(".")[2]);

    const { appId, secret } = parseAppKey(app.appKey);
    expect(appId).toBe(app.stored.id);
    const { wrapKey, authToken } = await appKeys(secret);
    expect(app.stored.tokenHash).not.toBe(authToken);

    const raw = await openGrant(appId, await importKey(wrapKey), app.stored.grants[0]);
    expect(raw).toEqual(a.raw);
    expect((await openFolderWithRaw(sa, raw)).name).toBe("Work");

    // A grant for folder A cannot be relabelled as folder B.
    await expect(openGrant(appId, await importKey(wrapKey), { folderId: b.id, wrappedKey: app.stored.grants[0].wrappedKey })).rejects.toBeInstanceOf(DecryptError);

    // The owner can reopen the app's secret and grant another folder later.
    const reopened = await openAppSecret(vk, app.stored);
    expect(reopened).toEqual(secret);
    const more = await wrapGrants(appId, reopened, [b]);
    expect(await openGrant(appId, await importKey(wrapKey), more[0])).toEqual(b.raw);
    expect(await openAppMeta(vk, app.stored)).toEqual({ name: "Claude Desktop", kind: "claude-desktop" });
  });

  it("another app's key cannot open a grant", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { folder } = await createFolder(vk, "Work");
    const one = await createApp(vk, { name: "One", kind: "other" }, [folder]);
    const two = await createApp(vk, { name: "Two", kind: "other" }, [folder]);
    const twoKeys = await appKeys(parseAppKey(two.appKey).secret);
    await expect(openGrant(one.stored.id, await importKey(twoKeys.wrapKey), one.stored.grants[0])).rejects.toBeInstanceOf(DecryptError);
  });
});
