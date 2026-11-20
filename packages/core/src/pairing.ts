// Adding a device by QR code or a short code.
//
// The new device makes a one-time X25519 key pair and shows its public key as
// a QR code (a link to /vault/pair#<pairing id>.<public key>) and as a short
// code. The short code is a hash of the public key, so the server, which looks
// the pairing up by code, cannot hand over a key of its own: the signed-in
// device checks the key against the code before it seals anything.
//
// The signed-in device then makes a key slot for the new device: a random
// device secret, from which the device's sign-in token and the key that wraps
// the vault key are derived (like the recovery phrase, but per device). It
// seals the vault key and the device secret to the one-time public key and
// sends them through a relay that keeps them for a few minutes. The new device
// opens them with its one-time private key, which never left it. The server
// relays a sealed box and never sees a key in plain.

import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBoxPublicKey, isBoxPublicKey, newBoxKeyPair, openSealedJson, sealJson, encodeBoxPublicKey, type BoxKeyPair } from "./box";
import { DecryptError, hkdf, randomBytes, randomId } from "./crypto";
import { fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";

/** Crockford base32: no I, L, O or U, so the code is easy to read out and type. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_MINUTES = 10;

export interface NewPairing {
  pair: BoxKeyPair;
  publicKey: string;
  code: string;
  /** Only the new device holds it; it lets that device, and only it, pick up the sealed box. */
  pollSecret: string;
}

export function newPairing(): NewPairing {
  const pair = newBoxKeyPair();
  const publicKey = encodeBoxPublicKey(pair.publicKey);
  return { pair, publicKey, code: pairingCode(publicKey), pollSecret: toBase64Url(randomBytes(32)) };
}

/** Ten characters (50 bits) of a hash of the public key, shown as XXXXX-XXXXX. */
export function pairingCode(publicKey: string): string {
  const h = sha256(utf8(`sigil-pair-code:v1:${publicKey}`));
  let bits = 0n;
  for (let i = 0; i < 7; i++) bits = (bits << 8n) | BigInt(h[i]);
  bits >>= 6n; // 56 bits, keep the top 50
  let out = "";
  for (let i = 9; i >= 0; i--) out += B32[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Accepts what a person types: any case, spaces or dashes, and the letters people confuse with digits. */
export function normalizePairingCode(input: string): string | null {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(clean)) return null;
  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
}

/** True when the public key the server returned is the one the code was made from. */
export function codeMatchesKey(code: string, publicKey: string): boolean {
  const n = normalizePairingCode(code);
  return !!n && isBoxPublicKey(publicKey) && pairingCode(publicKey) === n;
}

export function pairingUrl(origin: string, pairingId: string, publicKey: string): string {
  return `${origin.replace(/\/$/, "")}/vault/pair#${pairingId}.${publicKey}`;
}

export function parsePairingFragment(fragment: string): { pairingId: string; publicKey: string } {
  const [pairingId, publicKey, ...rest] = fragment.replace(/^#/, "").trim().split(".");
  if (rest.length || !/^[A-Za-z0-9_-]{8,64}$/.test(pairingId ?? "") || !isBoxPublicKey(publicKey)) {
    throw new Error("This pairing code is incomplete. Show the code on the new device again.");
  }
  return { pairingId, publicKey };
}

/** Four groups of four, to compare on both screens. */
export function deviceFingerprint(publicKey: string): string {
  const hex = toHex(sha256(utf8(`sigil-device-fingerprint:${publicKey}`))).slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

// ---------------------------------------------------------------- the device key slot

export interface DeviceKeys {
  kek: Uint8Array;
  authToken: string;
}

export async function deviceKeys(secret: Uint8Array): Promise<DeviceKeys> {
  if (secret.length !== 32) throw new Error("A device secret is 32 bytes.");
  return { kek: await hkdf(secret, "sigil:kek:device"), authToken: toBase64Url(await hkdf(secret, "sigil:auth:device")) };
}

export function newDeviceSecret(): Uint8Array {
  return randomBytes(32);
}

export function newDeviceId(): string {
  return randomId();
}

/** What travels, sealed, from the signed-in device to the new one. */
export interface DeviceGift {
  v: 1;
  /** The vault key, base64url. */
  vaultKey: string;
  deviceId: string;
  /** The new device's own secret, base64url: its sign-in token and the key that wraps the vault key come from it. */
  deviceSecret: string;
  /** The name the vault gave the device. */
  name: string;
}

export function pairingContext(pairingId: string): string {
  return `device-pair:${pairingId}`;
}

export function sealDeviceGift(newDevicePublicKey: string, pairingId: string, gift: DeviceGift): string {
  return sealJson(decodeBoxPublicKey(newDevicePublicKey), gift, pairingContext(pairingId));
}

export function openDeviceGift(pair: BoxKeyPair, pairingId: string, sealed: string): { vaultKey: Uint8Array; deviceId: string; deviceSecret: Uint8Array; name: string } {
  const g = openSealedJson<DeviceGift>(pair, sealed, pairingContext(pairingId));
  const vaultKey = fromBase64Url(String(g.vaultKey ?? ""));
  const deviceSecret = fromBase64Url(String(g.deviceSecret ?? ""));
  if (vaultKey.length !== 32 || deviceSecret.length !== 32 || !/^[A-Za-z0-9_-]{8,64}$/.test(String(g.deviceId))) throw new DecryptError("The keys from the other device are damaged.");
  return { vaultKey, deviceId: String(g.deviceId), deviceSecret, name: String(g.name ?? "").slice(0, 80) };
}

/** A short name for a device from its user agent, offered as the default name. */
export function deviceNameFrom(userAgent: string): string {
  const ua = userAgent || "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os}, ${browser}` : os;
}
