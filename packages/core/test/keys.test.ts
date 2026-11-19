import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  APP_KEY_PREFIX,
  appKeys,
  formatAppKey,
  isValidPhrase,
  newRecoveryPhrase,
  newVaultKey,
  parseAppKey,
  passkeyKek,
  phraseKeys,
  randomBytes,
  tokenHash,
  unwrapVaultKey,
  walletKeyMessage,
  walletKeys,
  wrapVaultKey,
  DecryptError,
} from "../src";

describe("vault key slots", () => {
  it("wraps and unwraps the vault key for every kind", async () => {
    const vk = newVaultKey();
    for (const kind of ["passkey", "wallet", "phrase"] as const) {
      const kek = randomBytes(32);
      const wrapped = await wrapVaultKey(kek, vk, kind);
      expect(await unwrapVaultKey(kek, wrapped, kind)).toEqual(vk);
    }
  });

  it("refuses the wrong key and the wrong slot kind", async () => {
    const vk = newVaultKey();
    const kek = randomBytes(32);
    const wrapped = await wrapVaultKey(kek, vk, "passkey");
    await expect(unwrapVaultKey(randomBytes(32), wrapped, "passkey")).rejects.toBeInstanceOf(DecryptError);
    await expect(unwrapVaultKey(kek, wrapped, "wallet")).rejects.toBeInstanceOf(DecryptError);
  });

  it("derives a passkey key from PRF output deterministically", async () => {
    const prf = randomBytes(32);
    expect(await passkeyKek(prf)).toEqual(await passkeyKek(prf));
    await expect(passkeyKek(randomBytes(8))).rejects.toThrow();
  });
});

describe("recovery phrase", () => {
  it("is 24 valid words and gives stable keys", async () => {
    const phrase = newRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidPhrase(phrase)).toBe(true);
    const a = await phraseKeys(phrase);
    const b = await phraseKeys(`  ${phrase.toUpperCase().split(" ").join("   ")}  `);
    expect(a).toEqual(b);
    expect(a.lookupId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.authToken).not.toBe(a.lookupId);
  });

  it("rejects a wrong phrase", async () => {
    const words = newRecoveryPhrase().split(" ");
    words[3] = words[3] === "abandon" ? "zoo" : "abandon";
    expect(isValidPhrase(words.join(" "))).toBe(false);
    await expect(phraseKeys("not a phrase")).rejects.toThrow();
  });

  it("different phrases give different keys", async () => {
    const a = await phraseKeys(newRecoveryPhrase());
    const b = await phraseKeys(newRecoveryPhrase());
    expect(a.kek).not.toEqual(b.kek);
    expect(a.lookupId).not.toBe(b.lookupId);
  });
});

describe("wallet keys", () => {
  it("are stable for a deterministic signer and bound to the address", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = walletKeyMessage(account.address);
    expect(message).toContain(account.address.toLowerCase());
    const sig1 = await account.signMessage({ message });
    const sig2 = await account.signMessage({ message });
    expect(sig1).toBe(sig2);
    const k1 = await walletKeys(account.address, sig1);
    const k2 = await walletKeys(account.address.toLowerCase(), sig2);
    expect(k1).toEqual(k2);
    const other = await walletKeys("0x" + "11".repeat(20), sig1);
    expect(other.kek).not.toEqual(k1.kek);
    expect(k1.authToken).not.toContain(sig1.slice(2, 20));
  });

  it("rejects junk", async () => {
    await expect(walletKeys("0x1234", "0x00")).rejects.toThrow();
    expect(() => walletKeyMessage("not-an-address")).toThrow();
  });
});

describe("app keys", () => {
  it("format and parse round trip", async () => {
    const secret = randomBytes(32);
    const key = formatAppKey("abcDEF123_-xyz", secret);
    expect(key.startsWith(`${APP_KEY_PREFIX}.`)).toBe(true);
    const parsed = parseAppKey(`  ${key}\n`);
    expect(parsed.appId).toBe("abcDEF123_-xyz");
    expect(parsed.secret).toEqual(secret);
  });

  it("rejects damaged keys", () => {
    expect(() => parseAppKey("hello")).toThrow(/not a Sigil app key/);
    expect(() => parseAppKey("sigil_app.abcdefgh.AAAA")).toThrow(/damaged/);
  });

  it("derive an auth token whose hash is all the server keeps", async () => {
    const secret = randomBytes(32);
    const { authToken, wrapKey } = await appKeys(secret);
    expect(tokenHash(authToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(authToken)).not.toContain(authToken);
    expect(wrapKey.length).toBe(32);
    expect((await appKeys(secret)).authToken).toBe(authToken);
  });
});
