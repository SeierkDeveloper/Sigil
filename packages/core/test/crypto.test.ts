import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  fromBase64Url,
  hkdf,
  importKey,
  isEnvelope,
  randomBytes,
  toBase64Url,
  utf8,
  fromUtf8,
} from "../src";

describe("envelopes", () => {
  it("round trips bytes and JSON", async () => {
    const key = await importKey(randomBytes(32));
    const env = await encryptBytes(key, utf8("hello vault"), "sigil:test:1");
    expect(isEnvelope(env)).toBe(true);
    expect(fromUtf8(await decryptBytes(key, env, "sigil:test:1"))).toBe("hello vault");

    const value = { title: "Trip", tags: ["a", "b"], n: 3, nested: { ok: true } };
    const envJson = await encryptJson(key, value, "sigil:test:2");
    expect(await decryptJson(key, envJson, "sigil:test:2")).toEqual(value);
  });

  it("round trips empty and large payloads", async () => {
    const key = await importKey(randomBytes(32));
    const empty = await encryptBytes(key, new Uint8Array(0), "a");
    expect((await decryptBytes(key, empty, "a")).length).toBe(0);
    const big = randomBytes(2 * 1024 * 1024);
    const env = await encryptBytes(key, big, "b");
    expect(await decryptBytes(key, env, "b")).toEqual(big);
  });

  it("uses a fresh IV every time", async () => {
    const key = await importKey(randomBytes(32));
    const a = await encryptBytes(key, utf8("same"), "x");
    const b = await encryptBytes(key, utf8("same"), "x");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("fails with the wrong key", async () => {
    const key = await importKey(randomBytes(32));
    const other = await importKey(randomBytes(32));
    const env = await encryptBytes(key, utf8("secret"), "x");
    await expect(decryptBytes(other, env, "x")).rejects.toBeInstanceOf(DecryptError);
  });

  it("fails when moved to another record (AAD binding)", async () => {
    const key = await importKey(randomBytes(32));
    const env = await encryptBytes(key, utf8("secret"), "sigil:memory-body:A");
    await expect(decryptBytes(key, env, "sigil:memory-body:B")).rejects.toBeInstanceOf(DecryptError);
  });

  it("fails when a single bit of ciphertext or IV changes", async () => {
    const key = await importKey(randomBytes(32));
    const env = await encryptBytes(key, utf8("secret"), "x");
    const [v, iv, ct] = env.split(".");
    const ctBytes = fromBase64Url(ct);
    ctBytes[0] ^= 1;
    await expect(decryptBytes(key, `${v}.${iv}.${toBase64Url(ctBytes)}`, "x")).rejects.toBeInstanceOf(DecryptError);
    const ivBytes = fromBase64Url(iv);
    ivBytes[3] ^= 0x80;
    await expect(decryptBytes(key, `${v}.${toBase64Url(ivBytes)}.${ct}`, "x")).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects things that are not envelopes", async () => {
    const key = await importKey(randomBytes(32));
    for (const bad of ["", "v1", "v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA", "plain text", "v1.short.x"]) {
      expect(isEnvelope(bad)).toBe(false);
      await expect(decryptBytes(key, bad, "x")).rejects.toBeInstanceOf(DecryptError);
    }
  });

  it("does not contain the plaintext", async () => {
    const key = await importKey(randomBytes(32));
    const marker = "CANARY-PLAINTEXT-0042";
    const env = await encryptJson(key, { body: marker.repeat(20) }, "x");
    expect(env).not.toContain(marker);
    expect(env).not.toContain(toBase64Url(utf8(marker)));
  });

  it("only accepts 32-byte keys", async () => {
    await expect(importKey(randomBytes(16))).rejects.toThrow();
  });
});

describe("hkdf", () => {
  it("is deterministic and separates purposes", async () => {
    const secret = randomBytes(32);
    expect(await hkdf(secret, "a")).toEqual(await hkdf(secret, "a"));
    expect(await hkdf(secret, "a")).not.toEqual(await hkdf(secret, "b"));
    expect((await hkdf(secret, "a", 16)).length).toBe(16);
  });
});
