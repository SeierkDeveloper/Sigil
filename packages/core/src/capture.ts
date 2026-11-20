// Capture keys: one per device or shortcut, so "remember that I parked on
// level 3" said to a phone, a watch or headphones lands in the inbox.
//
//   sigil_cap.<id>.<secret>
//     token    HKDF(secret, "sigil:auth:capture")    the node keeps only its SHA-256
//     tag key  HKDF(secret, "sigil:tag:capture-box") checks the vault public key
//
// A capture key can only write into the inbox: it reads nothing, not even the
// list of what it sent. It is revoked on its own. Whatever it sends is sealed
// to the vault public key on the device that sends it, after the device checked
// that key against the tag the owner's vault made for this capture key, so a
// node that swapped in a key of its own is caught before anything is sealed.
//
// A shortcut that cannot run code (a watch, for example) can be allowed, per
// key, to send plain text over HTTPS instead: the node then seals it to the
// vault public key the moment it arrives and keeps only the sealed box. That
// path is off unless the owner turns it on for that key, and is labelled so.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBoxPublicKey, isBoxPublicKey } from "./box";
import { hkdf, randomBytes, randomId } from "./crypto";
import { equalBytes, fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";
import { cleanProposal, sealProposal, type ProposalDraft } from "./inbox";

export const CAPTURE_KEY_PREFIX = "sigil_cap";
/** Captures one key may send in a minute and in a day. */
export const CAPTURE_PER_MINUTE = 20;
export const CAPTURE_PER_DAY = 300;
export const CAPTURE_KEYS_PER_VAULT = 20;
export const CAPTURE_TEXT_LIMIT = 4000;

export interface CaptureKeyParts {
  id: string;
  secret: Uint8Array;
}

export function newCaptureKey(): CaptureKeyParts {
  return { id: randomId(), secret: randomBytes(32) };
}

export function formatCaptureKey(id: string, secret: Uint8Array): string {
  return `${CAPTURE_KEY_PREFIX}.${id}.${toBase64Url(secret)}`;
}

export function parseCaptureKey(key: string): CaptureKeyParts {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== CAPTURE_KEY_PREFIX) throw new Error("That is not a Sigil capture key. It starts with sigil_cap.");
  let secret: Uint8Array;
  try {
    secret = fromBase64Url(parts[2]);
  } catch {
    throw new Error("That capture key is damaged. Copy it again from your vault.");
  }
  if (secret.length !== 32 || !/^[A-Za-z0-9_-]{8,64}$/.test(parts[1])) throw new Error("That capture key is damaged. Copy it again from your vault.");
  return { id: parts[1], secret };
}

/** The bearer token a capture key sends. The node stores its SHA-256 only. */
export async function captureToken(secret: Uint8Array): Promise<string> {
  return toBase64Url(await hkdf(secret, "sigil:auth:capture"));
}

/** The vault's tag over its public key for one capture key, made in the vault when the key is made. */
export async function captureBoxTag(secret: Uint8Array, boxPublicKey: string): Promise<string> {
  const key = await hkdf(secret, "sigil:tag:capture-box");
  return toHex(hmac(sha256, key, utf8(`sigil-capture-box-v1:${boxPublicKey}`)));
}

export async function verifyCaptureBoxTag(secret: Uint8Array, boxPublicKey: string, tag: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tag) || !isBoxPublicKey(boxPublicKey)) return false;
  return equalBytes(utf8(await captureBoxTag(secret, boxPublicKey)), utf8(tag));
}

/**
 * Seals a capture on the sending device, after checking the vault public key
 * against the tag. The proposal is bound to the capture key's id, so the inbox
 * knows which device sent it and a box cannot be passed off as another's.
 */
export async function sealWithCaptureKey(key: CaptureKeyParts, vault: { publicKey: string; tag: string }, draft: ProposalDraft, now = new Date().toISOString()): Promise<{ id: string; sealed: string }> {
  if (!(await verifyCaptureBoxTag(key.secret, vault.publicKey, vault.tag))) {
    throw new Error("The vault key this node gave does not match the one your vault vouched for. Nothing was sent.");
  }
  const id = randomId();
  return { id, sealed: sealProposal(decodeBoxPublicKey(vault.publicKey), id, key.id, cleanProposal(draft, "capture", now)) };
}

/** Seals plain text that reached the node from a shortcut allowed to send it so. Runs on the node, at once. */
export function sealArrivedText(publicKey: string, captureId: string, text: string, title = "", now = new Date().toISOString()): { id: string; sealed: string } {
  const body = text.replace(/\r\n/g, "\n").trim().slice(0, CAPTURE_TEXT_LIMIT);
  const id = randomId();
  return { id, sealed: sealProposal(decodeBoxPublicKey(publicKey), id, captureId, cleanProposal({ title: title.trim().slice(0, 300), body }, "capture", now)) };
}

/**
 * The link a shortcut opens: the capture page seals the text in the browser.
 * Key and text ride after #, which browsers never send to a server.
 */
export function captureLink(origin: string, key: string, text?: string): string {
  const base = `${origin.replace(/\/$/, "")}/c#k=${encodeURIComponent(key)}`;
  return text === undefined ? base : `${base}&t=${encodeURIComponent(text)}`;
}

export function parseCaptureFragment(hash: string): { key: string | null; text: string; title: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return { key: params.get("k"), text: params.get("t") ?? "", title: params.get("title") ?? "" };
}
