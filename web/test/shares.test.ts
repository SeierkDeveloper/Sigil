// Sharing a folder with another vault: sealed to the recipient's own key,
// accepted read only, every opening logged for the owner, and revoked by
// giving the folder a new key on the owner's device.

import { beforeEach, describe, expect, it } from "vitest";
import { decryptMemory, DecryptError, formatVaultCode, openShare, type StoredMemory } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";

const CANARY = "CANARY-share-plaintext-a19e";

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function setup() {
  const owner = await signedUp(h);
  const friend = await signedUp(h);
  const third = await signedUp(h);
  const family = await ops.addFolder(owner.b.api, owner.vault, "Family");
  const recipe = await ops.createMemory(owner.b.api, family, { title: "Grandma's bread", body: `Rye and honey. ${CANARY}` });
  const friendCode = ops.vaultCode(friend.data)!.code;
  return { owner, friend, third, family, recipe, friendCode };
}

describe("sharing a folder", () => {
  it("seals the folder key to the recipient's code, and the server sees nothing readable", async () => {
    const s = await setup();
    const share = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "My sister", "Alex");
    expect(share).toMatchObject({ label: "My sister", verified: true, acceptedAt: null });
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
    expect(dumpDb(h.db)).not.toContain("My sister");
    expect(dumpDb(h.db)).not.toContain("Family");

    const owner = await ops.loadVault(s.owner.b.api, s.owner.vault);
    expect(owner.shares.outgoing).toEqual([expect.objectContaining({ id: share.id, label: "My sister", from: "Alex", verified: true })]);
  });

  it("refuses its own code, unknown codes, damaged codes and sharing twice", async () => {
    const s = await setup();
    await expect(ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, ops.vaultCode(s.owner.data)!.code, "me", "me")).rejects.toMatchObject({ code: "own_vault" });
    const nobody = formatVaultCode("A".repeat(42) + "E");
    await expect(ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, nobody, "x", "x")).rejects.toMatchObject({ status: 404 });
    await expect(ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode.slice(0, -2), "x", "x")).rejects.toThrow("damaged");
    await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "x", "x");
    await expect(ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "x", "x")).rejects.toMatchObject({ code: "already_shared" });
  });

  it("is accepted by the recipient, read only, and every opening goes into the owner's log", async () => {
    const s = await setup();
    const share = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "My sister", "Alex");

    let friend = await ops.loadVault(s.friend.b.api, s.friend.vault);
    expect(friend.shares.incoming).toHaveLength(1);
    expect(friend.shares.incoming[0]).toMatchObject({ id: share.id, from: "Alex", acceptedAt: null, memories: [] });
    expect(friend.shares.incoming[0].folder?.name).toBe("Family");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log")).toBe(0);

    await ops.acceptShare(s.friend.b.api, share.id);
    friend = await ops.loadVault(s.friend.b.api, s.friend.vault);
    expect(friend.shares.incoming[0].memories.map((m) => [m.title, m.body])).toEqual([["Grandma's bread", `Rye and honey. ${CANARY}`]]);
    // Read only: the recipient cannot write into the owner's folder.
    await expect(ops.createMemory(s.friend.b.api, friend.shares.incoming[0].folder!, { title: "x", body: "y" })).rejects.toMatchObject({ status: 400 });

    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.map((e) => [e.kind, e.appId, e.count])).toEqual([["shared", share.id, 1]]);
    // The third vault sees nothing.
    expect((await ops.loadVault(s.third.b.api, s.third.vault)).shares.incoming).toEqual([]);
    expect(dumpDb(h.db)).not.toContain(CANARY);
  });

  it("can be declined or left by the recipient", async () => {
    const s = await setup();
    const share = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "x", "Alex");
    await expect(ops.leaveShare(s.third.b.api, share.id)).rejects.toMatchObject({ status: 404 });
    await ops.leaveShare(s.friend.b.api, share.id);
    expect((await ops.loadVault(s.friend.b.api, s.friend.vault)).shares.incoming).toEqual([]);
    expect((await ops.loadVault(s.owner.b.api, s.owner.vault)).shares.outgoing).toEqual([]);
  });

  it("is revoked by a new folder key: the old key opens nothing, apps and other shares keep working", async () => {
    const s = await setup();
    const share = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "Friend", "Alex");
    const thirdShare = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, ops.vaultCode(s.third.data)!.code, "Third", "Alex");
    await ops.acceptShare(s.friend.b.api, share.id);
    await ops.acceptShare(s.third.b.api, thirdShare.id);
    const { appKey } = await ops.connectApp(s.owner.b.api, s.owner.vault, { name: "Cursor", kind: "cursor" }, [s.family]);
    const reader = readerFor(h, appKey);

    // What the friend holds before the revoke: the old folder key.
    const before = await ops.loadVault(s.friend.b.api, s.friend.vault);
    const oldFolder = before.shares.incoming[0].folder!;

    const data = await ops.loadVault(s.owner.b.api, s.owner.vault);
    const family = data.folders.find((f) => f.id === s.family.id)!;
    const rotated = await ops.revokeShare(s.owner.b.api, s.owner.vault, data, family, share.id);
    expect(rotated.raw).not.toEqual(family.raw);

    // The friend is gone at once.
    expect((await ops.loadVault(s.friend.b.api, s.friend.vault)).shares.incoming).toEqual([]);
    // The old key opens none of what is stored now.
    const stored = h.db.prepare("SELECT id, folder_id AS folderId, head, body FROM memories WHERE folder_id = ?").all(s.family.id) as unknown as StoredMemory[];
    await expect(decryptMemory(oldFolder, stored[0])).rejects.toThrow(DecryptError);
    const sealed = String((h.db.prepare("SELECT sealed_key FROM shares WHERE id = ?").get(thirdShare.id) as { sealed_key: string }).sealed_key);
    expect(() => openShare(s.friend.data.box!, { id: thirdShare.id, folderId: s.family.id, sealedKey: sealed })).toThrow(DecryptError);

    // The owner, the app and the other recipient still read the folder.
    const owner = await ops.loadVault(s.owner.b.api, s.owner.vault);
    expect(owner.unreadable).toBe(0);
    expect(owner.memories.find((m) => m.id === s.recipe.id)?.body).toContain(CANARY);
    expect((await reader.read([s.recipe.id])).memories[0].body).toContain(CANARY);
    const third = await ops.loadVault(s.third.b.api, s.third.vault);
    expect(third.shares.incoming[0].memories[0].body).toContain(CANARY);
    expect(third.shares.incoming[0].from).toBe("Alex");
  });

  it("refuses a rotation that leaves part of the folder under the old key", async () => {
    const s = await setup();
    const share = await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "Friend", "Alex");
    const data = await ops.loadVault(s.owner.b.api, s.owner.vault);
    // A memory added on another device after this one loaded.
    await ops.createMemory(s.owner.b.api, s.family, { title: "Late", body: "added elsewhere" });
    const family = data.folders.find((f) => f.id === s.family.id)!;
    await expect(ops.revokeShare(s.owner.b.api, s.owner.vault, data, family, share.id)).rejects.toMatchObject({ status: 409, code: "stale" });
    expect((await ops.loadVault(s.friend.b.api, s.friend.vault)).shares.incoming).toHaveLength(1);
  });

  it("goes with either account when it is deleted", async () => {
    const s = await setup();
    await ops.shareFolder(s.owner.b.api, s.owner.vault, s.family, s.friendCode, "x", "Alex");
    await ops.deleteAccount(s.friend.b.api);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM shares")).toBe(0);
    const again = await setup();
    await ops.shareFolder(again.owner.b.api, again.owner.vault, again.family, again.friendCode, "x", "Alex");
    await ops.deleteAccount(again.owner.b.api);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM shares")).toBe(0);
  });
});

describe("the Self card", () => {
  it("lives in its own folder, is granted like any folder and is read first by apps", async () => {
    const s = await signedUp(h);
    const notes = s.data.folders[0];
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [notes]);
    const reader = readerFor(h, appKey);
    expect(await reader.profile()).toBeNull();

    const saved = await ops.saveProfile(s.b.api, s.vault, s.data, { who: `A sailor. ${CANARY}`, answers: "Short and plain.", projects: "A boat" });
    expect(saved.createdFolder).toBe(true);
    expect(saved.folder).toMatchObject({ name: "Self card", kind: "profile" });
    expect(dumpDb(h.db)).not.toContain(CANARY);
    expect(dumpDb(h.db)).not.toContain("profile");

    let data = await ops.loadVault(s.b.api, s.vault);
    expect(ops.profileFolder(data)?.id).toBe(saved.folder.id);
    // Saving again edits the same card in the same folder.
    const again = await ops.saveProfile(s.b.api, s.vault, data, { who: `A sailor. ${CANARY}`, answers: "Short.", projects: "A boat" });
    expect(again).toMatchObject({ createdFolder: false, memory: { id: saved.memory.id } });

    // Not granted yet: the app cannot read it.
    expect(await reader.profile()).toBeNull();
    data = await ops.loadVault(s.b.api, s.vault);
    await ops.setAppFolders(s.b.api, s.vault, data.apps[0], [notes, ops.profileFolder(data)!]);
    const card = await reader.profile();
    expect(card?.body).toContain(`A sailor. ${CANARY}`);
    expect(card?.body).toContain("## How I like answers\n\nShort.");
    expect(card?.source).toBe("Self card");
    const log = await ops.loadLog(s.b.api);
    expect(log.entries.slice(0, 2).map((e) => e.kind)).toEqual(["read", "index"]);

    // Renaming the folder keeps it the Self card folder.
    await ops.renameFolder(s.b.api, ops.profileFolder(data)!, "About me");
    expect(ops.profileFolder(await ops.loadVault(s.b.api, s.vault))?.name).toBe("About me");
  });
});
