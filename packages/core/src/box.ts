// Sealed boxes: encryption to a vault's public key.
//
// Every vault has an X25519 key pair. The public key sits on the server in the
// clear; the private key is wrapped by the vault key, so only the owner's
// device can use it. Anyone holding the public key (a connector, the browser
// extension, another vault) can seal data that only that vault can open.
//
// The construction is ECIES in the shape of HPKE base mode, built only from
// audited primitives (@noble/curves, @noble/hashes, @noble/ciphers):
//
//   ephemeral key pair (e, E) per message
//   shared  = X25519(e, recipient public key R)
//   key     = HKDF-SHA256(ikm = shared, salt = E || R, info = "sigil:box:v1:" + context)
//   sealed  = XChaCha20-Poly1305(key, random 24-byte nonce, plaintext, aad = context)
//
// The context names the exact record (a proposal id and the app that made it,
// a share id and its folder), so a sealed box moved anywhere else fails to open.
// Wire format: "s1.<E>.<nonce>.<ciphertext>", each part base64url.

import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf as hkdfSync } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { DecryptError, decryptBytes, encryptBytes, hkdf, randomBytes } from "./crypto";
import { concatBytes, equalBytes, fromBase64Url, fromUtf8, toBase64Url, toHex, utf8 } from "./encoding";

export const BOX_VERSION = "s1";
const NONCE_BYTES = 24;
const SEALED_PATTERN = /^s1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{22,}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function newBoxKeyPair(): BoxKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function boxKeyPairFromSecret(secretKey: Uint8Array): BoxKeyPair {
  if (secretKey.length !== 32) throw new Error("A box secret key is 32 bytes.");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && SEALED_PATTERN.test(value);
}

export function isBoxPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
}

export function encodeBoxPublicKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error("A box public key is 32 bytes.");
  return toBase64Url(key);
}

export function decodeBoxPublicKey(text: string): Uint8Array {
  if (!isBoxPublicKey(text)) throw new Error("That is not a vault public key.");
  return fromBase64Url(text);
}

function boxKey(shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array, context: string): Uint8Array {
  return hkdfSync(sha256, shared, concatBytes(ephemeral, recipient), utf8(`sigil:box:v1:${context}`), 32);
}

function sharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // noble rejects low-order points (an all-zero shared secret) by throwing.
  return x25519.getSharedSecret(secretKey, publicKey);
}

/** Seals bytes so only the holder of the recipient's secret key can open them. */
export function sealBytes(recipientPublicKey: Uint8Array, plaintext: Uint8Array, context: string): string {
  if (recipientPublicKey.length !== 32) throw new Error("A box public key is 32 bytes.");
  const eph = newBoxKeyPair();
  let shared: Uint8Array;
  try {
    shared = sharedSecret(eph.secretKey, recipientPublicKey);
  } catch {
    throw new Error("That vault public key is not usable.");
  }
  const key = boxKey(shared, eph.publicKey, recipientPublicKey, context);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, utf8(context)).encrypt(plaintext);
  return `${BOX_VERSION}.${toBase64Url(eph.publicKey)}.${toBase64Url(nonce)}.${toBase64Url(ciphertext)}`;
}

/** Opens a sealed box with the recipient's key pair. Throws DecryptError for a wrong key, a wrong context or any change. */
export function openSealedBytes(recipient: BoxKeyPair, sealed: string, context: string): Uint8Array {
  if (!isSealed(sealed)) throw new DecryptError("This is not a Sigil sealed box.");
  const [, ephText, nonceText, ctText] = sealed.split(".");
  try {
    const ephemeral = fromBase64Url(ephText);
    const shared = sharedSecret(recipient.secretKey, ephemeral);
    const key = boxKey(shared, ephemeral, recipient.publicKey, context);
    return xchacha20poly1305(key, fromBase64Url(nonceText), utf8(context)).decrypt(fromBase64Url(ctText));
  } catch {
    throw new DecryptError();
  }
}

export function sealJson(recipientPublicKey: Uint8Array, value: unknown, context: string): string {
  return sealBytes(recipientPublicKey, utf8(JSON.stringify(value)), context);
}

export function openSealedJson<T>(recipient: BoxKeyPair, sealed: string, context: string): T {
  const bytes = openSealedBytes(recipient, sealed, context);
  try {
    return JSON.parse(fromUtf8(bytes)) as T;
  } catch {
    throw new DecryptError("Decrypted data is not valid.");
  }
}

// ---------------------------------------------------------------- the vault's own box key

export const BOX_SECRET_AAD = "sigil:box-secret";

export interface StoredBoxKey {
  /** base64url X25519 public key, kept in the clear so apps and other vaults can seal to it. */
  publicKey: string;
  /** The private key, AES-256-GCM under the vault key. */
  wrappedSecret: string;
}

export async function createBoxKey(vaultKey: CryptoKey): Promise<{ stored: StoredBoxKey; pair: BoxKeyPair }> {
  const pair = newBoxKeyPair();
  return {
    pair,
    stored: { publicKey: encodeBoxPublicKey(pair.publicKey), wrappedSecret: await encryptBytes(vaultKey, pair.secretKey, BOX_SECRET_AAD) },
  };
}

/** Unwraps the vault's box key and checks it matches the public key the server holds. */
export async function openBoxKey(vaultKey: CryptoKey, stored: StoredBoxKey): Promise<BoxKeyPair> {
  const secret = await decryptBytes(vaultKey, stored.wrappedSecret, BOX_SECRET_AAD);
  const pair = boxKeyPairFromSecret(secret);
  if (!equalBytes(pair.publicKey, decodeBoxPublicKey(stored.publicKey))) {
    throw new DecryptError("The vault public key on the server does not match this vault.");
  }
  return pair;
}

// ---------------------------------------------------------------- vouching for the public key to an app

/**
 * A connected app learns the vault public key from the server. So that a server
 * cannot hand it a key of its own, the vault tags the public key with a MAC under
 * a key only the app and the vault know (derived from the app secret). The app
 * checks the tag before it seals anything.
 */
export async function appBoxTag(appSecret: Uint8Array, boxPublicKey: string): Promise<string> {
  const key = await hkdf(appSecret, "sigil:tag:app-box");
  return toHex(hmac(sha256, key, utf8(`sigil-box-v1:${boxPublicKey}`)));
}

export async function verifyAppBoxTag(appSecret: Uint8Array, boxPublicKey: string, tag: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tag) || !isBoxPublicKey(boxPublicKey)) return false;
  const expected = await appBoxTag(appSecret, boxPublicKey);
  return equalBytes(utf8(expected), utf8(tag));
}

// ---------------------------------------------------------------- vault codes, for sharing

export const VAULT_CODE_PREFIX = "sigil_vault";

function codeCheck(publicKey: string): string {
  return toBase64Url(sha256(utf8(`sigil-vault-code:${publicKey}`)).slice(0, 4));
}

/**
 * A vault code is how one vault tells another where to share to: the public key
 * plus a short check against typing errors. It is handed over by the people
 * themselves, so the server cannot swap in a key of its own.
 */
export function formatVaultCode(publicKey: string): string {
  return `${VAULT_CODE_PREFIX}.${publicKey}.${codeCheck(publicKey)}`;
}

export function parseVaultCode(code: string): string {
  const parts = code.trim().split(".");
  if (parts.length !== 3 || parts[0] !== VAULT_CODE_PREFIX) throw new Error("That is not a Sigil vault code. It starts with sigil_vault.");
  if (!isBoxPublicKey(parts[1]) || parts[2] !== codeCheck(parts[1])) throw new Error("That vault code is damaged. Copy it again.");
  return parts[1];
}

/** A short fingerprint two people can read to each other to confirm a vault code. */
export function vaultFingerprint(publicKey: string): string {
  const hex = toHex(sha256(utf8(`sigil-vault-fingerprint:${publicKey}`))).slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}
