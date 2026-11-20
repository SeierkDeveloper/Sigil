// Capture keys: made in the vault, carried by a phone or a shortcut, able
// only to seal something to the vault public key after checking it.

import { describe, expect, it } from "vitest";
import {
  captureBoxTag,
  captureLink,
  captureToken,
  createBoxKey,
  encodeBoxPublicKey,
  formatCaptureKey,
  importKey,
  newBoxKeyPair,
  newCaptureKey,
  newVaultKey,
  openProposal,
  parseCaptureFragment,
  parseCaptureKey,
  sealArrivedText,
  sealWithCaptureKey,
  verifyCaptureBoxTag,
} from "../src/index";

async function vaultBox() {
  return (await createBoxKey(await importKey(newVaultKey()))).pair;
}

describe("a capture key", () => {
  it("is one string, parsed back, with a token the node only ever sees hashed", async () => {
    const k = newCaptureKey();
    const text = formatCaptureKey(k.id, k.secret);
    expect(text).toMatch(/^sigil_cap\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const back = parseCaptureKey(` ${text} `);
    expect(back.id).toBe(k.id);
    expect(back.secret).toEqual(k.secret);
    expect(() => parseCaptureKey("sigil_app.x.y")).toThrow(/not a Sigil capture key/);
    expect(() => parseCaptureKey(`sigil_cap.${k.id}.short`)).toThrow(/damaged/);
    const token = await captureToken(k.secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await captureToken(newCaptureKey().secret)).not.toBe(token);
  });

  it("seals on the sending device only after the vault's tag checks out", async () => {
    const box = await vaultBox();
    const publicKey = encodeBoxPublicKey(box.publicKey);
    const k = newCaptureKey();
    const tag = await captureBoxTag(k.secret, publicKey);
    expect(await verifyCaptureBoxTag(k.secret, publicKey, tag)).toBe(true);
    const sent = await sealWithCaptureKey(k, { publicKey, tag }, { title: "", body: "Remember that I parked on level 3" });
    const opened = openProposal(box, { id: sent.id, appId: k.id, sealed: sent.sealed });
    expect(opened).toMatchObject({ via: "capture", body: "Remember that I parked on level 3", title: "Remember that I parked on level 3" });
    // Bound to its key: it does not open as another device's capture.
    expect(() => openProposal(box, { id: sent.id, appId: "another-key-01", sealed: sent.sealed })).toThrow();

    // A node that hands out a key of its own is caught before anything is sealed.
    const swapped = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    await expect(sealWithCaptureKey(k, { publicKey: swapped, tag }, { title: "", body: "x" })).rejects.toThrow(/does not match/);
    await expect(sealWithCaptureKey(newCaptureKey(), { publicKey, tag }, { title: "", body: "x" })).rejects.toThrow(/does not match/);
  });

  it("seals plain text from a shortcut on arrival, when the owner allowed that key to send it", async () => {
    const box = await vaultBox();
    const k = newCaptureKey();
    const sent = sealArrivedText(encodeBoxPublicKey(box.publicKey), k.id, "  Remember that I parked on level 3\r\n", "Parking");
    expect(sent.sealed).not.toContain("level 3");
    expect(openProposal(box, { id: sent.id, appId: k.id, sealed: sent.sealed })).toMatchObject({ title: "Parking", body: "Remember that I parked on level 3", via: "capture" });
  });

  it("travels in a link whose key and text stay after the #", () => {
    const key = formatCaptureKey("cap-00000001", new Uint8Array(32));
    const link = captureLink("https://sigil.example/", key, "Parked on level 3 & row B");
    expect(link.split("#")[0]).toBe("https://sigil.example/c");
    expect(parseCaptureFragment(new URL(link).hash)).toEqual({ key, text: "Parked on level 3 & row B", title: "" });
    expect(captureLink("https://sigil.example", key)).toBe(`https://sigil.example/c#k=${encodeURIComponent(key)}`);
  });
});
