import { describe, expect, it } from "vitest";
import {
  codeMatchesKey,
  DecryptError,
  deviceFingerprint,
  deviceKeys,
  deviceNameFrom,
  encodeBoxPublicKey,
  newBoxKeyPair,
  newDeviceSecret,
  newPairing,
  normalizePairingCode,
  openDeviceGift,
  pairingCode,
  pairingUrl,
  parsePairingFragment,
  sealDeviceGift,
  toBase64Url,
  unwrapVaultKey,
  wrapVaultKey,
} from "../src/index";

describe("pairing a device", () => {
  it("makes a short code from the one-time public key that a different key cannot match", () => {
    const p = newPairing();
    expect(p.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(p.code).toBe(pairingCode(p.publicKey));
    expect(codeMatchesKey(p.code, p.publicKey)).toBe(true);
    expect(codeMatchesKey(p.code.toLowerCase().replace("-", " "), p.publicKey)).toBe(true);
    const other = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    expect(codeMatchesKey(p.code, other)).toBe(false);
    expect(newPairing().pollSecret).not.toBe(p.pollSecret);
  });

  it("reads typed codes forgivingly and refuses what is not a code", () => {
    expect(normalizePairingCode("abcde fghjk")).toBe("ABCDE-FGHJK");
    expect(normalizePairingCode("0O1IL-23456")).toBe("00111-23456");
    expect(normalizePairingCode("ABCDE-FGHJ")).toBeNull();
    expect(normalizePairingCode("ABCDE-FGHJU")).toBeNull();
  });

  it("round trips the QR link", () => {
    const p = newPairing();
    const url = pairingUrl("https://example.org", "pairing123", p.publicKey);
    expect(parsePairingFragment(new URL(url).hash)).toEqual({ pairingId: "pairing123", publicKey: p.publicKey });
    expect(() => parsePairingFragment("#pairing123")).toThrow("incomplete");
    expect(deviceFingerprint(p.publicKey)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  });

  it("seals the vault key and the device secret so only the new device opens them, for this pairing only", async () => {
    const p = newPairing();
    const vaultKey = new Uint8Array(32).fill(9);
    const secret = newDeviceSecret();
    const sealed = sealDeviceGift(p.publicKey, "pairing123", { v: 1, vaultKey: toBase64Url(vaultKey), deviceId: "device12345", deviceSecret: toBase64Url(secret), name: "iPhone, Safari" });
    expect(sealed).not.toContain(toBase64Url(vaultKey));
    const opened = openDeviceGift(p.pair, "pairing123", sealed);
    expect(opened).toEqual({ vaultKey, deviceId: "device12345", deviceSecret: secret, name: "iPhone, Safari" });
    expect(() => openDeviceGift(newBoxKeyPair(), "pairing123", sealed)).toThrow(DecryptError);
    expect(() => openDeviceGift(p.pair, "pairing999", sealed)).toThrow(DecryptError);
  });

  it("derives a device sign-in token and the key that wraps the vault key from the device secret", async () => {
    const secret = newDeviceSecret();
    const a = await deviceKeys(secret);
    const b = await deviceKeys(secret);
    expect(a.authToken).toBe(b.authToken);
    expect(a.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const vaultKey = new Uint8Array(32).fill(4);
    const wrapped = await wrapVaultKey(a.kek, vaultKey, "device");
    expect(await unwrapVaultKey(b.kek, wrapped, "device")).toEqual(vaultKey);
    await expect(unwrapVaultKey((await deviceKeys(newDeviceSecret())).kek, wrapped, "device")).rejects.toBeInstanceOf(DecryptError);
    await expect(unwrapVaultKey(a.kek, wrapped, "phrase")).rejects.toBeInstanceOf(DecryptError);
    await expect(deviceKeys(new Uint8Array(16))).rejects.toThrow();
  });

  it("names devices from their user agent", () => {
    expect(deviceNameFrom("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone, Safari");
    expect(deviceNameFrom("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36")).toBe("Android, Chrome");
    expect(deviceNameFrom("")).toBe("Device");
  });
});
