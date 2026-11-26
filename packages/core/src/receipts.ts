// Receipts for what the AI self does on its own: a payment the self key signs,
// an approval granted within the owner's limits, a meeting agreed in a free
// hour. Each receipt says what happened, when, and under which limit, and is
// signed by the self key the way wallets sign text (EIP-191), like the
// identity statement. Its fingerprint (a salted hash, so it says nothing by
// itself) goes into the hourly seal next to the read log, so a receipt the
// owner shares can be checked against a root nobody can change later.
//
//   message  "sigil-self-receipt-v1" \n canonical JSON of the body
//   leaf     SHA-256(0x00 || "sigil-receipt-v1" \n message \n signature)
//
// The body carries 32 random bytes of salt: without the receipt itself, the
// leaf in a seal cannot be linked to anything.

import { randomBytes } from "./crypto";
import { checksumAddress, isEvmAddress, personalMessageHash, recoverDigest, sameAddress, signDigest, type SelfKey } from "./identity";
import { canonicalJson } from "./life";
import { hex32, leafHash, fromHex32, verifyProof } from "./merkle";
import { toHex } from "./encoding";

export const RECEIPT_FORMAT = "sigil-self-receipt";

export type ReceiptKind = "payment" | "approval" | "agreement";

export const RECEIPT_KINDS: readonly ReceiptKind[] = ["payment", "approval", "agreement"];

export interface ReceiptBody {
  /** The self key that acted, EIP-55. */
  selfKey: string;
  kind: ReceiptKind;
  /** What the self did, in plain words. */
  what: string;
  /** When, as ISO time. */
  at: string;
  /** The owner's limit it acted under, in plain words. */
  limit: string;
  /** Where to find it: a chain and transaction, a draft, a meeting. Short strings only. */
  ref: Record<string, string>;
  /** The site the vault lives on. */
  origin: string;
  /** 32 random bytes, hex: makes the leaf unlinkable without the receipt. */
  salt: string;
}

export interface Receipt {
  format: typeof RECEIPT_FORMAT;
  version: 1;
  body: ReceiptBody;
  /** EIP-191 by the self key, 0x hex. */
  signature: string;
}

/** Where a shared receipt was sealed: the hour, the proof from its leaf, and the root it leads to. */
export interface ReceiptSeal {
  hour: number;
  proof: string[];
  root: string;
  /** Seconds per seal period on that site (3600 in production). */
  periodSeconds?: number;
}

/** What an owner shares: the receipt, and where it was sealed once it was. */
export interface SharedReceipt {
  receipt: Receipt;
  seal: ReceiptSeal | null;
}

const clip = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

export function cleanReceiptBody(value: Partial<ReceiptBody>): ReceiptBody {
  if (!isEvmAddress(value.selfKey)) throw new Error("A receipt names the self key that acted.");
  if (!RECEIPT_KINDS.includes(value.kind as ReceiptKind)) throw new Error("That is not a kind of receipt.");
  const at = new Date(String(value.at ?? ""));
  if (!Number.isFinite(at.getTime())) throw new Error("A receipt has a time.");
  const what = clip(value.what, 400);
  if (!what) throw new Error("A receipt says what the self did.");
  const ref: Record<string, string> = {};
  for (const [k, v] of Object.entries(value.ref ?? {}).slice(0, 10)) {
    if (/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(k) && v != null && String(v).trim()) ref[k] = clip(v, 200);
  }
  const salt = String(value.salt ?? "");
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("A receipt carries 32 bytes of salt.");
  return {
    selfKey: checksumAddress(value.selfKey as string),
    kind: value.kind as ReceiptKind,
    what,
    at: at.toISOString(),
    limit: clip(value.limit, 200),
    ref,
    origin: String(value.origin ?? "").replace(/\/$/, "").slice(0, 200),
    salt,
  };
}

export function receiptMessage(body: ReceiptBody): string {
  return `${RECEIPT_FORMAT}-v1\n${canonicalJson(body)}`;
}

/** Signs a receipt with the self key, on the owner's device. */
export function signReceipt(self: SelfKey, input: Omit<ReceiptBody, "selfKey" | "salt" | "at"> & { at?: string; salt?: string }): Receipt {
  const body = cleanReceiptBody({ ...input, selfKey: self.address, at: input.at ?? new Date().toISOString(), salt: input.salt ?? toHex(randomBytes(32)) });
  return { format: RECEIPT_FORMAT, version: 1, body, signature: signDigest(self.secret, personalMessageHash(receiptMessage(body))) };
}

/** The bytes whose hash is the receipt's leaf in the seal. */
export function receiptLeafData(r: Receipt): string {
  return `sigil-receipt-v1\n${receiptMessage(r.body)}\n${r.signature.toLowerCase()}`;
}

/** The receipt's fingerprint in the hourly seal, 0x hex. */
export function receiptLeaf(r: Receipt): string {
  return hex32(leafHash(receiptLeafData(r)));
}

export function parseReceipt(text: string): SharedReceipt {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a receipt: it is not valid JSON.");
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const raw = (o.receipt ?? o) as Receipt;
  if (!raw || raw.format !== RECEIPT_FORMAT || raw.version !== 1 || !raw.body || typeof raw.signature !== "string") throw new Error("This is not a Sigil receipt.");
  const s = o.seal as ReceiptSeal | null | undefined;
  const seal =
    s && Number.isInteger(s.hour) && Array.isArray(s.proof) && typeof s.root === "string"
      ? { hour: s.hour, proof: s.proof.map(String).slice(0, 64), root: s.root, ...(Number.isInteger(s.periodSeconds) ? { periodSeconds: s.periodSeconds } : {}) }
      : null;
  return { receipt: raw, seal };
}

export interface ReceiptCheck {
  name: "signature" | "seal" | "time";
  ok: boolean;
  detail: string;
}

/**
 * Checks a receipt on this device: the self key's signature over the body,
 * and, when it carries one, the proof from its leaf to the sealed root and
 * that it was sealed no earlier than the hour it names. Whether that root is
 * the one the site (or the chain) published is checked by the caller, which
 * fetches it.
 */
export function checkReceipt(shared: SharedReceipt): { ok: boolean; leaf: string | null; checks: ReceiptCheck[] } {
  const checks: ReceiptCheck[] = [];
  const r = shared.receipt;
  let body: ReceiptBody | null = null;
  try {
    body = cleanReceiptBody(r.body);
  } catch (err) {
    checks.push({ name: "signature", ok: false, detail: (err as Error).message });
    return { ok: false, leaf: null, checks };
  }
  const same = canonicalJson(body) === canonicalJson(r.body);
  const signer = same ? recoverDigest(personalMessageHash(receiptMessage(body)), r.signature) : null;
  const signed = !!signer && sameAddress(signer, body.selfKey);
  checks.push({ name: "signature", ok: signed, detail: signed ? `Signed by the self key ${body.selfKey}.` : "The self key's signature does not match this receipt, or it was changed after signing." });
  const leaf = receiptLeaf({ ...r, body });
  if (shared.seal) {
    let proven = false;
    try {
      proven = verifyProof(fromHex32(shared.seal.root), fromHex32(leaf), shared.seal.proof.map(fromHex32));
    } catch {
      proven = false;
    }
    checks.push({ name: "seal", ok: proven, detail: proven ? `Its fingerprint is in the seal of hour ${shared.seal.hour}, root ${shared.seal.root.slice(0, 18)}...` : "The proof does not lead from this receipt to the root it names." });
    const period = shared.seal.periodSeconds ?? 3600;
    const atHour = Math.floor(Date.parse(body.at) / 1000 / period);
    const timely = shared.seal.hour >= atHour && shared.seal.hour <= atHour + 1;
    checks.push({
      name: "time",
      ok: timely,
      detail: timely ? "It was sealed in the hour it names, or the next." : "It was sealed in another hour than the one it names.",
    });
  }
  return { ok: checks.every((c) => c.ok), leaf, checks };
}
