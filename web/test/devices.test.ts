// Adding a device by QR code or short code, signing in with it, revoking it,
// and quick capture into the inbox. The vault key reaches the new device only
// sealed to its one-time key.

import { beforeEach, describe, expect, it } from "vitest";
import { deviceKeys, encodeBoxPublicKey, newBoxKeyPair, newPairing, toBase64Url, type BoxKeyPair } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as devices from "../src/vault/deviceOps";

const CANARY = "CANARY-capture-plaintext-91";

let h: Harness;
beforeEach(() => {
  h = harness();
});

async function paired() {
  const owner = await signedUp(h);
  const phone = h.browser();
  const session = await devices.startPairing(phone.api, "http://localhost:3000");
  expect(await devices.pollPairing(phone.api, session)).toBeNull();
  const target = await devices.findByCode(owner.b.api, session.code.toLowerCase());
  expect(target).toEqual({ id: session.id, publicKey: session.publicKey, code: session.code });
  const slots = await devices.sendToDevice(owner.b.api, owner.vault, target, "Phone, Safari");
  const gift = await devices.pollPairing(phone.api, session);
  expect(gift).not.toBeNull();
  const vault = await devices.finishPairing(phone.api, gift!);
  return { owner, phone, session, slots, vault };
}

describe("adding a device", () => {
  it("sends the vault key sealed to the new device's one-time key, and the device opens the same vault", async () => {
    const { owner, phone, vault, slots } = await paired();
    expect(vault.raw).toEqual(owner.vault.raw);
    expect(slots.filter((s) => s.kind === "device")).toHaveLength(1);
    const data = await ops.loadVault(phone.api, vault);
    expect(data.folders.map((f) => f.name)).toEqual(owner.data.folders.map((f) => f.name));
    // The server never held the vault key in a readable form, and the relay is empty once picked up.
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(toBase64Url(owner.vault.raw));
    expect(count(h.db, "SELECT COUNT(*) AS n FROM device_pairings")).toBe(0);
    const name = await devices.deviceName(owner.vault, slots.find((s) => s.kind === "device")!);
    expect(name).toBe("Phone, Safari");
    expect(dumpDb(h.db)).not.toContain("Phone, Safari");
    const log = await ops.loadLog(owner.b.api);
    expect(log.entries.map((e) => [e.kind, e.memoryId?.split("-")[0]])).toEqual([
      ["device", "signed"],
      ["device", "added"],
    ]);
  });

  it("hands the sealed box out once, only to the device with the poll secret", async () => {
    const owner = await signedUp(h);
    const phone = h.browser();
    const session = await devices.startPairing(phone.api, "http://localhost:3000");
    await devices.sendToDevice(owner.b.api, owner.vault, await devices.findByCode(owner.b.api, session.code), "x");
    await expect(devices.pollPairing(phone.api, { ...session, pollSecret: toBase64Url(new Uint8Array(32)) })).rejects.toThrow("expired");
    expect(await devices.pollPairing(phone.api, session)).not.toBeNull();
    await expect(devices.pollPairing(phone.api, session)).rejects.toThrow("expired");
    // The code cannot be used a second time.
    await expect(devices.findByCode(owner.b.api, session.code)).rejects.toMatchObject({ code: "no_pairing" });
  });

  it("follows the QR link, and refuses a key that does not belong to the code", async () => {
    const owner = await signedUp(h);
    const phone = h.browser();
    const session = await devices.startPairing(phone.api, "http://localhost:3000");
    const fragment = new URL(session.url).hash;
    expect(await devices.findByLink(owner.b.api, fragment)).toMatchObject({ id: session.id, publicKey: session.publicKey });
    // A server that swaps its own key in is caught by the code check, so nothing is sealed to it.
    const evil = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    h.db.prepare("UPDATE device_pairings SET public_key = ? WHERE id = ?").run(evil, session.id);
    await expect(devices.findByCode(owner.b.api, session.code)).rejects.toThrow("does not belong");
    await expect(devices.findByLink(owner.b.api, fragment)).rejects.toThrow("does not match");
    // And a pairing whose code was not made from its key is refused when it is opened.
    const p = newPairing();
    await expect(phone.api.post("devices/pairings", { id: "pairing-bad-1", publicKey: evil, code: p.code, pollSecret: p.pollSecret })).rejects.toMatchObject({ status: 400 });
  });

  it("revokes a device: its key slot goes, its session ends at once, and it cannot sign in again", async () => {
    const { owner, phone, slots, vault } = await paired();
    expect((await ops.loadVault(phone.api, vault)).folders.length).toBeGreaterThan(0);
    const slot = slots.find((s) => s.kind === "device")!;
    await devices.revokeDevice(owner.b.api, slot.id);
    await expect(phone.api.get("vault")).rejects.toMatchObject({ status: 401 });
    const secret = new Uint8Array(32);
    await expect(phone.api.post("auth/device/login", { deviceId: slot.label, authToken: (await deviceKeys(secret)).authToken })).rejects.toMatchObject({ code: "unknown_device" });
    const log = await ops.loadLog(owner.b.api);
    expect(log.entries[0].memoryId).toBe(`revoked-${slot.label}`);
    // Revoking someone else's device is not possible.
    const other = await signedUp(h);
    await expect(devices.revokeDevice(other.b.api, slot.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("quick capture", () => {
  it("seals text, a link and a photo on the phone into the inbox, without opening the vault", async () => {
    const owner = await signedUp(h);
    const pinned = owner.data.boxPublic;
    const photo = { type: "image/jpeg" as const, data: Buffer.from(`fake jpeg ${CANARY}`).toString("base64") };
    await devices.capture(owner.b.api, { title: "Parking", body: `Level 3, row F. ${CANARY}`, url: "https://example.org/map", image: photo }, pinned);
    const data = await ops.loadVault(owner.b.api, owner.vault);
    expect(data.proposals).toHaveLength(1);
    const p = data.proposals[0];
    expect(p.appId).toBe("capture");
    expect(p.payload).toMatchObject({ title: "Parking", via: "capture", url: "https://example.org/map", image: photo });
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);

    const memory = await ops.approveProposal(owner.b.api, data.folders[0], p, { title: "Parking", body: p.payload!.body, tags: [] });
    expect(memory.image).toEqual(photo);
    expect(memory.source).toEqual({ kind: "capture", ref: "https://example.org/map" });
    const again = await ops.loadVault(owner.b.api, owner.vault);
    expect(again.memories.find((m) => m.id === memory.id)?.image).toEqual(photo);
  });

  it("refuses when the server sends another vault key than the one this device pinned", async () => {
    const owner = await signedUp(h);
    const other: BoxKeyPair = newBoxKeyPair();
    await expect(devices.capture(owner.b.api, { title: "x", body: "y" }, encodeBoxPublicKey(other.publicKey))).rejects.toThrow("different vault key");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM proposals")).toBe(0);
    // Apps cannot send photos: only the owner's own captures carry one.
    const signedOut = h.browser();
    await expect(signedOut.api.get("capture/key")).rejects.toMatchObject({ status: 401 });
  });
});
