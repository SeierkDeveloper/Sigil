// Nodes: every Sigil server is a node, and a vault lives on one at a time.
// Anyone can run one (the same site and API), and a vault can move between
// them without the old node's say:
//
//   1. On the old node the owner's device signs a move statement with the
//      vault's signing key: from, to, the hash of the bundle it moves with, and
//      how many days the old node keeps sending links on.
//   2. The old node checks the statement against the vault's signing key and
//      keeps the bundle for the new node, which asks for it with a secret that
//      only the owner's device and the move code hold.
//   3. On the new node the owner signs in with the bundle's own key slot, the
//      device opens the bundle, signs a restore statement for the new node and
//      an arrival statement for the old one; the new node takes the bundle in.
//   4. The old node checks the arrival against the same signing key, sends
//      ask links, the public page, packs and the emergency card on to the new
//      address for the period, and then deletes the vault.
//
// Every step is a "node" entry in the read log of the node where it happened,
// sealed with the hour there. The log from before the move travels in the
// bundle with its proofs; the old node's seals stay published after it deletes
// the vault, since they hold only salted leaves.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, randomId } from "./crypto";
import { fromBase64Url, fromUtf8, toBase64Url, toHex, utf8 } from "./encoding";
import { canonicalJson, isSigningKey, type SigningKey } from "./life";

export const MOVE_FORMAT = "sigil-move";
export const MOVE_MIN_DAYS = 1;
export const MOVE_MAX_DAYS = 90;
export const MOVE_DEFAULT_DAYS = 30;

/** A node's address: its origin, https, or http for a node on this machine. */
export function nodeOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error("That is not a node address. It looks like https://sigil.example.org");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("A node address starts with https://");
  return u.origin;
}

export function isNodeOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return nodeOrigin(value) === value;
  } catch {
    return false;
  }
}

export interface MoveStatement {
  format: typeof MOVE_FORMAT;
  v: 1;
  /** The move's id on the old node. */
  id: string;
  /** The vault's signing key. */
  vault: string;
  from: string;
  to: string;
  /** The hash of the bundle the vault moves with. */
  bundle: string;
  /** Days the old node sends links on to the new address before it deletes the vault. */
  redirectDays: number;
  issuedAt: string;
}

export interface SignedMove {
  statement: MoveStatement;
  signature: string;
}

function moveMessage(s: MoveStatement): Uint8Array {
  return utf8(`${MOVE_FORMAT}-v1\n${canonicalJson(s)}`);
}

export function cleanMove(value: unknown): MoveStatement {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (v.format !== MOVE_FORMAT || v.v !== 1) throw new Error("This is not a Sigil move statement.");
  if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v.id)) throw new Error("The move has no valid id.");
  if (!isSigningKey(v.vault)) throw new Error("The move names no vault key.");
  if (!isNodeOrigin(v.from) || !isNodeOrigin(v.to)) throw new Error("The move names no valid nodes.");
  if (v.from === v.to) throw new Error("A vault moves to another node, not the one it is on.");
  if (typeof v.bundle !== "string" || !/^0x[0-9a-f]{64}$/.test(v.bundle)) throw new Error("The move names no bundle.");
  const days = Number(v.redirectDays);
  if (!Number.isInteger(days) || days < MOVE_MIN_DAYS || days > MOVE_MAX_DAYS) throw new Error(`Links are sent on for ${MOVE_MIN_DAYS} to ${MOVE_MAX_DAYS} days.`);
  if (typeof v.issuedAt !== "string" || !Number.isFinite(Date.parse(v.issuedAt))) throw new Error("The move has no time.");
  return { format: MOVE_FORMAT, v: 1, id: v.id, vault: v.vault, from: v.from, to: v.to, bundle: v.bundle, redirectDays: days, issuedAt: v.issuedAt };
}

export function signMove(key: SigningKey, input: Omit<MoveStatement, "format" | "v" | "vault">): SignedMove {
  const statement = cleanMove({ ...input, format: MOVE_FORMAT, v: 1, vault: key.publicKey });
  return { statement, signature: toBase64Url(ed25519.sign(moveMessage(statement), key.seed)) };
}

export function verifyMove(m: SignedMove, signKey?: string): boolean {
  let s: MoveStatement;
  try {
    s = cleanMove(m.statement);
  } catch {
    return false;
  }
  if (signKey && s.vault !== signKey) return false;
  try {
    const sig = fromBase64Url(m.signature);
    return sig.length === 64 && ed25519.verify(sig, moveMessage(s), fromBase64Url(s.vault));
  } catch {
    return false;
  }
}

/** The move statement's own fingerprint, which the log entries name. */
export function moveHash(s: MoveStatement): string {
  return "0x" + toHex(sha256(moveMessage(s)));
}

// ---------------------------------------------------------------- the arrival

export function arrivalMessage(moveId: string, to: string, bundle: string, at: string): string {
  return ["sigil-arrived-v1", moveId, to, bundle, at].join("\n");
}

/** Signed on the owner's device on the new node, for the old node: the vault arrived where the statement said. */
export function signArrival(key: SigningKey, moveId: string, to: string, bundle: string, at: string): string {
  return toBase64Url(ed25519.sign(utf8(arrivalMessage(moveId, to, bundle, at)), key.seed));
}

export function verifyArrival(signKey: string, moveId: string, to: string, bundle: string, at: string, signature: string): boolean {
  try {
    const sig = fromBase64Url(signature);
    return sig.length === 64 && isSigningKey(signKey) && ed25519.verify(sig, utf8(arrivalMessage(moveId, to, bundle, at)), fromBase64Url(signKey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the move code

export const MOVE_CODE_PREFIX = "sigil_move";

export interface MoveCode {
  from: string;
  id: string;
  /** Lets the new node fetch the bundle from the old one. The old node keeps only its hash. */
  secret: string;
}

export function newMoveSecret(): string {
  return toBase64Url(randomBytes(32));
}

export function newMoveId(): string {
  return randomId();
}

/** The code the owner carries from the old node to the new one: sigil_move.<old node>.<move id>.<secret>. */
export function formatMoveCode(c: MoveCode): string {
  return `${MOVE_CODE_PREFIX}.${toBase64Url(utf8(c.from))}.${c.id}.${c.secret}`;
}

export function parseMoveCode(text: string): MoveCode {
  const parts = text.trim().split(".");
  const bad = () => new Error("That move code is not complete. Copy it again from your old node.");
  if (parts.length !== 4 || parts[0] !== MOVE_CODE_PREFIX) throw bad();
  let from: string;
  try {
    from = nodeOrigin(fromUtf8(fromBase64Url(parts[1])));
  } catch {
    throw bad();
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) throw bad();
  return { from, id: parts[2], secret: parts[3] };
}

/** Where the owner opens the code on the new node. The code rides after # so it is never sent in a request line. */
export function moveUrl(to: string, code: string): string {
  return `${to.replace(/\/$/, "")}/vault/restore#move=${code}`;
}

/** What a node says about itself at /api/health. */
export interface NodeHealth {
  ok: boolean;
  node: { origin: string; version: string; spec: string };
  time: string;
}
