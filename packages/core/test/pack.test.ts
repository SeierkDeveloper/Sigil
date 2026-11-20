import { describe, expect, it } from "vitest";
import { cleanFollows, packHash, packMemoryId, packUrl, parsePack, signPack, vaultSigningKey, verifyPack } from "../src";

const PUBLISHER = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
const items = [
  { id: "memory-00001", title: "Sourdough basics", body: "Feed the starter twice a day.", tags: ["bread"] },
  { id: "memory-00002", title: "Oven", body: "250 degrees, steam for the first 20 minutes.", tags: [] },
];

async function v1() {
  const key = await vaultSigningKey(PUBLISHER);
  return { key, pack: signPack(key, { id: "pack-0000001", title: "Bread", description: "How I bake.", version: 1, publisher: { name: "Sam" }, previous: null, items, origin: "https://sigil.example", publishedAt: "2026-11-20T10:00:00.000Z" }) };
}

describe("a knowledge pack", () => {
  it("is signed by the publisher's vault key and checks", async () => {
    const { key, pack } = await v1();
    expect(pack.body.publisher.signingKey).toBe(key.publicKey);
    expect(pack.hash).toBe(packHash(pack.body));
    expect(verifyPack(parsePack(JSON.stringify(pack)))).toMatchObject({ ok: true });
  });

  it("fails when any item is changed after signing", async () => {
    const { pack } = await v1();
    const changed = { ...pack, body: { ...pack.body, items: [{ ...items[0], body: "Feed it once." }, items[1]] } };
    expect(verifyPack(changed).ok).toBe(false);
  });

  it("is pinned to the publisher a follower first saw, and versions follow each other", async () => {
    const { key, pack } = await v1();
    const v2 = signPack(key, { ...pack.body, version: 2, previous: pack.hash, items: [...items, { id: "memory-00003", title: "Flour", body: "Strong white.", tags: [] }] });
    expect(verifyPack(v2, { pinnedKey: key.publicKey, after: { version: 1, hash: pack.hash } }).ok).toBe(true);
    const impostor = await vaultSigningKey(Uint8Array.from({ length: 32 }, () => 3));
    const fake = signPack(impostor, { ...pack.body, version: 2, previous: pack.hash });
    const r = verifyPack(fake, { pinnedKey: key.publicKey, after: { version: 1, hash: pack.hash } });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "publisher")?.ok).toBe(false);
    expect(verifyPack(pack, { after: { version: 1, hash: pack.hash } }).checks.find((c) => c.name === "order")?.ok).toBe(false);
  });

  it("refuses an empty folder, a second version without the first, and bad ids", async () => {
    const { key } = await v1();
    const base = { id: "pack-0000001", title: "Bread", description: "", version: 1, publisher: { name: "" }, previous: null, items, origin: "", publishedAt: "2026-11-20T10:00:00.000Z" };
    expect(() => signPack(key, { ...base, items: [] })).toThrow(/nothing to publish/);
    expect(() => signPack(key, { ...base, version: 2 })).toThrow(/names the one before/);
    expect(() => signPack(key, { ...base, id: "x" })).toThrow(/id/);
  });

  it("gives followed memories ids only the follower's folder key can make", async () => {
    const f1 = Uint8Array.from({ length: 32 }, () => 1);
    const f2 = Uint8Array.from({ length: 32 }, () => 2);
    expect(await packMemoryId(f1, "pack-0000001", "memory-00001")).toBe(await packMemoryId(f1, "pack-0000001", "memory-00001"));
    expect(await packMemoryId(f1, "pack-0000001", "memory-00001")).not.toBe(await packMemoryId(f2, "pack-0000001", "memory-00001"));
    expect(await packMemoryId(f1, "pack-0000001", "memory-00001")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("keeps the list of follows clean", async () => {
    const { key } = await v1();
    const good = { id: "pack-0000001", origin: "https://sigil.example", folderId: "folder-00001", publisherKey: key.publicKey, title: "Bread", version: 1, hash: "0x", followedAt: "", updatedAt: "" };
    expect(cleanFollows([good, { ...good, publisherKey: "nope" }, null])).toHaveLength(1);
    expect(packUrl("https://sigil.example/", "pack-0000001")).toBe("https://sigil.example/p/pack-0000001");
  });
});
