// "Ask my AI self" links: questions and answers relayed end to end encrypted.
//
// The owner's device makes an X25519 key pair for each link. The private half
// stays with whoever answers (the owner's open vault, or the connector on the
// owner's machine), wrapped by the vault key or by that app's key. The public
// half goes into the link itself, after the # so browsers never send it to the
// server, together with a small key that opens the link's greeting.
//
//   /ask/<link id>#<link public key>.<greeting key>
//
// The asker's browser makes its own key pair for the conversation. Both sides
// derive the same conversation key:
//
//   shared = X25519(asker secret, link public) = X25519(link secret, asker public)
//   key    = HKDF-SHA256(shared, salt = asker public || link public,
//                        info = "sigil:ask:v1:" + link id + ":" + session id)
//
// Every message is XChaCha20-Poly1305 under that key with a fresh nonce, bound
// to its link, session, message id and direction, so the server (which only
// relays the boxes) can neither read nor move one.

import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf as hkdfSync } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBoxPublicKey, encodeBoxPublicKey, isBoxPublicKey, newBoxKeyPair, type BoxKeyPair } from "./box";
import { DecryptError, decryptJson, encryptJson, importKey, randomBytes, randomId } from "./crypto";
import { concatBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding";
import { AAD } from "./keys";

export const RELAY_VERSION = "r1";
const RELAY_PATTERN = /^r1\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{22,}$/;

export function isRelayBox(value: unknown): value is string {
  return typeof value === "string" && RELAY_PATTERN.test(value);
}

// ---------------------------------------------------------------- the link

export interface NewAskLink {
  id: string;
  pair: BoxKeyPair;
  /** Opens the greeting. Travels only in the link's fragment. */
  introKey: Uint8Array;
  publicKey: string;
}

export function newAskLink(): NewAskLink {
  const pair = newBoxKeyPair();
  return { id: randomId(), pair, introKey: randomBytes(32), publicKey: encodeBoxPublicKey(pair.publicKey) };
}

export function formatAskFragment(publicKey: string, introKey: Uint8Array): string {
  return `${publicKey}.${toBase64Url(introKey)}`;
}

export function parseAskFragment(fragment: string): { publicKey: string; introKey: Uint8Array } {
  const [publicKey, intro, ...rest] = fragment.replace(/^#/, "").trim().split(".");
  if (rest.length || !isBoxPublicKey(publicKey) || !intro) throw new Error("This link is incomplete. Ask for it again and copy all of it.");
  let introKey: Uint8Array;
  try {
    introKey = fromBase64Url(intro);
  } catch {
    throw new Error("This link is incomplete. Ask for it again and copy all of it.");
  }
  if (introKey.length !== 32) throw new Error("This link is incomplete. Ask for it again and copy all of it.");
  return { publicKey, introKey };
}

export function askUrl(origin: string, linkId: string, publicKey: string, introKey: Uint8Array): string {
  return `${origin.replace(/\/$/, "")}/ask/${linkId}#${formatAskFragment(publicKey, introKey)}`;
}

/** What the asker sees before asking: a name and a greeting, readable only with the link. */
export interface AskIntro {
  name: string;
  greeting: string;
}

export async function sealIntro(introKey: Uint8Array, linkId: string, intro: AskIntro): Promise<string> {
  const clean = { name: intro.name.trim().slice(0, 80) || "An AI self", greeting: intro.greeting.trim().slice(0, 400) };
  return encryptJson(await importKey(introKey), clean, AAD.askIntro(linkId));
}

export async function openIntro(introKey: Uint8Array, linkId: string, envelope: string): Promise<AskIntro> {
  const v = await decryptJson<AskIntro>(await importKey(introKey), envelope, AAD.askIntro(linkId));
  return { name: String(v.name ?? "").slice(0, 80), greeting: String(v.greeting ?? "").slice(0, 400) };
}

// ---------------------------------------------------------------- the conversation

function conversationKey(shared: Uint8Array, askerPublic: Uint8Array, linkPublic: Uint8Array, linkId: string, sessionId: string): Uint8Array {
  return hkdfSync(sha256, shared, concatBytes(askerPublic, linkPublic), utf8(`sigil:ask:v1:${linkId}:${sessionId}`), 32);
}

export interface AskSession {
  id: string;
  /** The asker's public key, sent with every question so the owner's side can derive the same key. */
  publicKey: string;
  key: Uint8Array;
}

/** The asker's side: a fresh key pair and the conversation key, made in the asker's browser. */
export function newAskSession(linkId: string, linkPublicKey: string): AskSession {
  const pair = newBoxKeyPair();
  const linkPublic = decodeBoxPublicKey(linkPublicKey);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(pair.secretKey, linkPublic);
  } catch {
    throw new Error("This link's key is not usable.");
  }
  const id = randomId();
  return { id, publicKey: encodeBoxPublicKey(pair.publicKey), key: conversationKey(shared, pair.publicKey, linkPublic, linkId, id) };
}

/** The owner's side: the same conversation key from the link's private key and the asker's public key. */
export function agentSessionKey(link: BoxKeyPair, linkId: string, sessionId: string, askerPublicKey: string): Uint8Array {
  const askerPublic = decodeBoxPublicKey(askerPublicKey);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(link.secretKey, askerPublic);
  } catch {
    throw new DecryptError("The asker's key is not usable.");
  }
  return conversationKey(shared, askerPublic, link.publicKey, linkId, sessionId);
}

export type AskDirection = "q" | "a";

function relayAad(linkId: string, sessionId: string, messageId: string, dir: AskDirection): Uint8Array {
  return utf8(`sigil:ask-msg:v1:${linkId}:${sessionId}:${messageId}:${dir}`);
}

export function sealAskMessage(key: Uint8Array, ids: { linkId: string; sessionId: string; messageId: string }, dir: AskDirection, value: unknown): string {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, relayAad(ids.linkId, ids.sessionId, ids.messageId, dir)).encrypt(utf8(JSON.stringify(value)));
  return `${RELAY_VERSION}.${toBase64Url(nonce)}.${toBase64Url(ct)}`;
}

export function openAskMessage<T>(key: Uint8Array, ids: { linkId: string; sessionId: string; messageId: string }, dir: AskDirection, box: string): T {
  if (!isRelayBox(box)) throw new DecryptError("This is not a Sigil relay box.");
  const [, nonce, ct] = box.split(".");
  try {
    const plain = xchacha20poly1305(key, fromBase64Url(nonce), relayAad(ids.linkId, ids.sessionId, ids.messageId, dir)).decrypt(fromBase64Url(ct));
    return JSON.parse(fromUtf8(plain)) as T;
  } catch {
    throw new DecryptError();
  }
}

/** What the asker sends. The last few turns go along so the answer can follow the conversation. */
export interface AskQuestion {
  v: 1;
  text: string;
  history: { question: string; answer: string }[];
}

/** What comes back. No memory titles or ids: those stay with the owner. */
export interface AskReply {
  v: 1;
  text: string;
  /** Set when the AI self declined (rules, or nothing to go on). */
  refused: string | null;
}

export function cleanQuestion(value: unknown): AskQuestion {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = String(v.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const history = Array.isArray(v.history)
    ? v.history
        .slice(-4)
        .map((t) => ({ question: String((t as Record<string, unknown>)?.question ?? "").slice(0, 2000), answer: String((t as Record<string, unknown>)?.answer ?? "").slice(0, 4000) }))
        .filter((t) => t.question && t.answer)
    : [];
  return { v: 1, text, history };
}

// ---------------------------------------------------------------- what the owner keeps

/** The link's private key and rules, as the owner's device keeps them (under the vault key or an app's key). */
export interface AskLinkSecret {
  /** The link's X25519 private key, base64url. */
  secret: string;
  /** The owner's name for the link, for the log. */
  label: string;
  /** The rules this link answers within. */
  rules: unknown;
  /** The greeting key, so the owner can copy the full link again. */
  introKey: string;
}

export function linkPair(secret: AskLinkSecret): BoxKeyPair {
  const raw = fromBase64Url(secret.secret);
  if (raw.length !== 32) throw new DecryptError("A link key has the wrong length.");
  return { secretKey: raw, publicKey: x25519.getPublicKey(raw) };
}

/** One question and its answer, sealed to the vault's own public key for the read log. */
export interface AskNote {
  v: 1;
  via: "link" | "app";
  /** The link's label or the app's name. */
  label: string;
  question: string;
  answer: string;
  citations: { id: string; title: string }[];
  refused: string | null;
}

export function askNoteContext(entryRef: string, by: string): string {
  return `ask-note:${entryRef}:${by}`;
}
