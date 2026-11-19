// Authenticated encryption for everything Sigil stores.
//
// Format of an envelope: "v1.<iv>.<ciphertext>" where both parts are base64url,
// the cipher is AES-256-GCM with a fresh 96-bit random IV, and the additional
// authenticated data (AAD) names the exact record the envelope belongs to.
// Binding the AAD means a ciphertext moved to another record, folder or app
// fails to decrypt instead of silently showing the wrong content.

import { fromBase64Url, toBase64Url, utf8, fromUtf8 } from "./encoding";

export const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const HKDF_SALT = utf8("sigil/hkdf/v1");
const ENVELOPE_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

export class DecryptError extends Error {
  constructor(message = "This data could not be decrypted with the given key.") {
    super(message);
    this.name = "DecryptError";
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this environment.");
  return s;
}

/** Copies into a fresh ArrayBuffer so WebCrypto never sees a view onto shared memory. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let i = 0; i < length; i += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(length, i + 65536)));
  }
  return out;
}

export function randomId(): string {
  // 128 random bits, base64url: short, URL safe and unguessable.
  return toBase64Url(randomBytes(16));
}

export function isEnvelope(value: unknown): value is string {
  return typeof value === "string" && ENVELOPE_PATTERN.test(value);
}

/** Imports 32 raw bytes as a non-extractable AES-256-GCM key. */
export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("Keys must be 32 bytes.");
  return subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** HKDF-SHA256 with a fixed Sigil salt. `info` separates every purpose a secret is used for. */
export async function hkdf(secret: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", buf(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(HKDF_SALT), info: buf(utf8(info)) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8(aad)), tagLength: 128 },
    key,
    buf(plaintext),
  );
  return `${ENVELOPE_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptBytes(key: CryptoKey, envelope: string, aad: string): Promise<Uint8Array> {
  if (!isEnvelope(envelope)) throw new DecryptError("This is not a Sigil envelope.");
  const [, ivText, ctText] = envelope.split(".");
  try {
    const plaintext = await subtle().decrypt(
      { name: "AES-GCM", iv: buf(fromBase64Url(ivText)), additionalData: buf(utf8(aad)), tagLength: 128 },
      key,
      buf(fromBase64Url(ctText)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new DecryptError();
  }
}

export async function encryptJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  return encryptBytes(key, utf8(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: CryptoKey, envelope: string, aad: string): Promise<T> {
  const bytes = await decryptBytes(key, envelope, aad);
  try {
    return JSON.parse(fromUtf8(bytes)) as T;
  } catch {
    throw new DecryptError("Decrypted data is not valid.");
  }
}
