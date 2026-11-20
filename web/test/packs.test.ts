// Knowledge packs: a folder published as a signed pack, followed by another
// vault into a folder of its own, brought up to date version by version and
// checked against the publisher it pinned. Free, and public by design.

import { beforeEach, describe, expect, it } from "vitest";
import { parsePack, signPack, vaultSigningKey, verifyPack } from "@sigil/core";
import { count, harness, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as packs from "../src/vault/packOps";
import { handleApi } from "../src/server/api";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** The follower's browser fetching a pack from the site, straight into the router. */
const fetcher = (input: string, init?: RequestInit) => {
  const url = new URL(input);
  return handleApi(new Request(url, init), url.pathname.replace(/^\/api\//, "").split("/"), h.db);
};

async function publisher() {
  const o = await signedUp(h);
  const folder = await ops.addFolder(o.b.api, o.vault, "Bread");
  await ops.createMemory(o.b.api, folder, { title: "Starter", body: "Feed it twice a day. Call 070-123 45 67." });
  await ops.createMemory(o.b.api, folder, { title: "Oven", body: "250 degrees." });
  return { ...o, folder, data: await ops.loadVault(o.b.api, o.vault) };
}

describe("a knowledge pack", () => {
  it("is published signed, followed into its own folder, and updated version by version", async () => {
    let pub = await publisher();
    const { row, pack } = await packs.publish(pub.b.api, pub.vault, pub.data, { folderId: pub.folder.id, title: "Bread", description: "How I bake.", publisher: "Sam", origin: ORIGIN });
    expect(row).toMatchObject({ version: 1, title: "Bread" });
    const served = parsePack(await (await h.raw("GET", `packs/at/${row.id}`)).text());
    expect(verifyPack(served).ok).toBe(true);
    expect(served.body.items.map((i) => i.title).sort()).toEqual(["Oven", "Starter"]);

    const fan = await signedUp(h);
    let data = await ops.loadVault(fan.b.api, fan.vault);
    const followed = await packs.follow(fan.b.api, fan.vault, data, packs.packRef(packs.packUrl(ORIGIN, row.id), ORIGIN), fetcher);
    expect(followed.folder.name).toBe("Pack: Bread");
    expect(followed.memories).toHaveLength(2);
    data = await ops.loadVault(fan.b.api, fan.vault);
    expect(data.follows).toEqual([expect.objectContaining({ id: row.id, version: 1, publisherKey: pack.body.publisher.signingKey })]);
    expect(data.memories.filter((m) => m.folderId === followed.folder.id).every((m) => m.source.kind === "pack")).toBe(true);
    await expect(packs.follow(fan.b.api, fan.vault, data, { origin: ORIGIN, id: row.id }, fetcher)).rejects.toThrow(/already follow/);
    expect(() => packs.packRef("https://elsewhere.example/p/pack-0000001", ORIGIN)).toThrow(/published on this site/);
    expect(packs.packRef(row.id, ORIGIN)).toEqual({ origin: ORIGIN, id: row.id });

    // Two new versions: one memory changed, one added, one removed.
    const starter = pub.data.memories.find((m) => m.title === "Starter")!;
    await ops.updateMemory(pub.b.api, pub.data.folders, starter, { body: "Feed it once a day." });
    await ops.createMemory(pub.b.api, pub.folder, { title: "Flour", body: "Strong white." });
    pub = { ...pub, data: await ops.loadVault(pub.b.api, pub.vault) };
    await packs.publish(pub.b.api, pub.vault, pub.data, { folderId: pub.folder.id, title: "Bread", description: "How I bake.", publisher: "Sam", origin: ORIGIN });
    await ops.deleteMemories(pub.b.api, [pub.data.memories.find((m) => m.title === "Oven")!.id]);
    pub = { ...pub, data: await ops.loadVault(pub.b.api, pub.vault) };
    await packs.publish(pub.b.api, pub.vault, pub.data, { folderId: pub.folder.id, title: "Bread, again", description: "", publisher: "Sam", origin: ORIGIN });

    const r = await packs.refresh(fan.b.api, data, fan.vault, fetcher);
    expect(r).toEqual({ updated: [{ id: row.id, title: "Bread, again", from: 1, to: 3 }], failed: [] });
    data = await ops.loadVault(fan.b.api, fan.vault);
    const mine = data.memories.filter((m) => m.folderId === followed.folder.id);
    expect(mine.map((m) => m.title).sort()).toEqual(["Flour", "Starter"]);
    expect(mine.find((m) => m.title === "Starter")?.body).toBe("Feed it once a day.");
    expect(data.follows[0].version).toBe(3);
    expect((await packs.refresh(fan.b.api, data, fan.vault, fetcher)).updated).toEqual([]);

    const steps = (await ops.loadLog(fan.b.api)).entries.filter((e) => e.kind === "pack").map((e) => e.memoryId);
    expect(steps).toEqual(expect.arrayContaining(["followed-1", "updated-3"]));
    expect(count(h.db, "SELECT COUNT(*) AS n FROM pack_versions WHERE pack_id = ?", row.id)).toBe(3);

    await packs.unfollow(fan.b.api, fan.vault, data, row.id);
    expect((await ops.loadVault(fan.b.api, fan.vault)).follows).toEqual([]);
  });

  it("masks what the folder's rules mask, and never publishes a protected folder", async () => {
    const pub = await publisher();
    const folder = { ...pub.data.folders.find((f) => f.id === pub.folder.id)!, redact: ["phone" as const] };
    const data = { ...pub.data, folders: pub.data.folders.map((f) => (f.id === folder.id ? folder : f)) };
    const { pack } = await packs.publish(pub.b.api, pub.vault, data, { folderId: folder.id, title: "Bread", description: "", publisher: "Sam", origin: ORIGIN });
    expect(JSON.stringify(pack)).not.toContain("070-123 45 67");
    const guarded = { ...data, folders: data.folders.map((f) => (f.id === folder.id ? { ...f, protect: "health" as const } : f)) };
    await expect(packs.publish(pub.b.api, pub.vault, guarded, { folderId: folder.id, title: "Bread", description: "", publisher: "Sam", origin: ORIGIN })).rejects.toThrow(/protected folder/);
  });

  it("refuses a version signed by another key, out of order, or under another vault's pack id", async () => {
    const pub = await publisher();
    const { row, pack } = await packs.publish(pub.b.api, pub.vault, pub.data, { folderId: pub.folder.id, title: "Bread", description: "", publisher: "Sam", origin: ORIGIN });
    const other = await signedUp(h);
    const theirs = signPack(await vaultSigningKey(other.vault.raw), { ...pack.body, version: 2, previous: pack.hash });
    await expect(other.b.api.post("packs", { folderId: other.data.folders[0].id, pack: JSON.stringify(theirs) })).rejects.toMatchObject({ status: 409 });
    const skip = signPack(await vaultSigningKey(pub.vault.raw), { ...pack.body, version: 3, previous: pack.hash });
    await expect(pub.b.api.post("packs", { folderId: pub.folder.id, pack: JSON.stringify(skip) })).rejects.toMatchObject({ status: 400 });
    const notMine = signPack(await vaultSigningKey(other.vault.raw), { ...pack.body, id: "pack-of-another", version: 1, previous: null });
    await expect(pub.b.api.post("packs", { folderId: pub.folder.id, pack: JSON.stringify(notMine) })).rejects.toMatchObject({ status: 400 });
    await packs.withdraw(pub.b.api, row.id);
    expect((await h.raw("GET", `packs/at/${row.id}`)).status).toBe(404);
  });

  it("is checked by the follower against the publisher it pinned", async () => {
    const pub = await publisher();
    const { row } = await packs.publish(pub.b.api, pub.vault, pub.data, { folderId: pub.folder.id, title: "Bread", description: "", publisher: "Sam", origin: ORIGIN });
    const fan = await signedUp(h);
    let data = await ops.loadVault(fan.b.api, fan.vault);
    await packs.follow(fan.b.api, fan.vault, data, { origin: ORIGIN, id: row.id }, fetcher);
    data = await ops.loadVault(fan.b.api, fan.vault);
    // A server that swaps in a version signed by another key is caught.
    const impostor = await vaultSigningKey(new Uint8Array(32).fill(4));
    const served = parsePack(await (await h.raw("GET", `packs/at/${row.id}`)).text());
    const fake = signPack(impostor, { ...served.body, version: 2, previous: served.hash });
    const lying = async (input: string) => (input.includes(`/packs/at/${row.id}`) ? new Response(JSON.stringify(fake)) : fetcher(input));
    const r = await packs.refresh(fan.b.api, data, fan.vault, lying);
    expect(r.updated).toEqual([]);
    expect(r.failed[0].reason).toMatch(/another key/);
  });
});
