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
//
// An app the owner lets act within the thresholds (acting.ts) signs its
// receipts with a key of its own, derived from the app's secret on the app's
// machine, so the self key never leaves the owner's device. The body then
// carries `via`: the self key's signed word, made in the vault, that this
// key signs receipts for it on behalf of that app.
//
//   delegation  EIP-191 by the self key over
//               "sigil-receipt-delegate-v1" \n canonical JSON of the delegation without its signature

import { randomBytes } from "./crypto";
import { checksumAddress, deriveSecpKey, isEvmAddress, personalMessageHash, recoverDigest, sameAddress, signDigest, type SelfKey } from "./identity";
import { canonicalJson } from "./life";
import { hex32, leafHash, fromHex32, verifyProof } from "./merkle";
import { toHex } from "./encoding";

export const RECEIPT_FORMAT = "sigil-self-receipt";

export type ReceiptKind = "payment" | "approval" | "agreement" | "mail" | "calendar" | "negotiation";

export const RECEIPT_KINDS: readonly ReceiptKind[] = ["payment", "approval", "agreement", "mail", "calendar", "negotiation"];

/** The self key's word that an app's own key signs receipts for it. Made and signed in the vault. */
export interface ReceiptDelegation {
  /** The self key, EIP-55. */
  selfKey: string;
  /** The app's receipt key, EIP-55. */
  delegate: string;
  /** The app's id in the vault. */
  app: string;
  origin: string;
  /** From when, ISO time. */
  since: string;
  /** EIP-191 by the self key. */
  signature: string;
}

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
  /** Set when an app's receipt key signed it for the self key. */
  via?: ReceiptDelegation;
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
  const body: ReceiptBody = {
    selfKey: checksumAddress(value.selfKey as string),
    kind: value.kind as ReceiptKind,
    what,
    at: at.toISOString(),
    limit: clip(value.limit, 200),
    ref,
    origin: String(value.origin ?? "").replace(/\/$/, "").slice(0, 200),
    salt,
  };
  if (value.via != null) body.via = cleanDelegation(value.via);
  return body;
}

export function cleanDelegation(value: Partial<ReceiptDelegation>): ReceiptDelegation {
  if (!isEvmAddress(value.selfKey) || !isEvmAddress(value.delegate)) throw new Error("A delegation names the self key and the app's receipt key.");
  const since = new Date(String(value.since ?? ""));
  if (!Number.isFinite(since.getTime())) throw new Error("A delegation has a time.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(value.app ?? ""))) throw new Error("A delegation names the app.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(value.signature ?? ""))) throw new Error("A delegation is signed by the self key.");
  return {
    selfKey: checksumAddress(value.selfKey as string),
    delegate: checksumAddress(value.delegate as string),
    app: String(value.app),
    origin: String(value.origin ?? "").replace(/\/$/, "").slice(0, 200),
    since: since.toISOString(),
    signature: String(value.signature).toLowerCase(),
  };
}

export function delegationMessage(d: Omit<ReceiptDelegation, "signature">): string {
  const { selfKey, delegate, app, origin, since } = d;
  return `${RECEIPT_FORMAT}-delegate-v1\n${canonicalJson({ selfKey, delegate, app, origin, since })}`;
}

/** The key an app signs receipts with: derived from the app's secret, so the app and the vault both make the same one. */
export async function appReceiptKey(appSecret: Uint8Array): Promise<SelfKey> {
  return deriveSecpKey(appSecret, "sigil:self:receipts:v1");
}

/** The self key's word that an app's receipt key signs for it. Signed in the vault. */
export function signDelegation(self: SelfKey, input: { delegate: string; app: string; origin: string; since?: string }): ReceiptDelegation {
  const base = { selfKey: self.address, delegate: checksumAddress(input.delegate), app: input.app, origin: input.origin.replace(/\/$/, ""), since: input.since ?? new Date().toISOString() };
  return cleanDelegation({ ...base, signature: signDigest(self.secret, personalMessageHash(delegationMessage(base))) });
}

/** Whether a delegation is signed by the self key it names. */
export function checkDelegation(d: ReceiptDelegation): boolean {
  try {
    const c = cleanDelegation(d);
    const signer = recoverDigest(personalMessageHash(delegationMessage(c)), c.signature);
    return !!signer && sameAddress(signer, c.selfKey);
  } catch {
    return false;
  }
}

export function receiptMessage(body: ReceiptBody): string {
  return `${RECEIPT_FORMAT}-v1\n${canonicalJson(body)}`;
}

/** Signs a receipt with the self key, on the owner's device. */
export function signReceipt(self: SelfKey, input: Omit<ReceiptBody, "selfKey" | "salt" | "at"> & { at?: string; salt?: string }): Receipt {
  const body = cleanReceiptBody({ ...input, selfKey: self.address, at: input.at ?? new Date().toISOString(), salt: input.salt ?? toHex(randomBytes(32)) });
  return { format: RECEIPT_FORMAT, version: 1, body, signature: signDigest(self.secret, personalMessageHash(receiptMessage(body))) };
}

/** Signs a receipt with an app's receipt key, for the self key that gave it the delegation. On the app's machine. */
export function signDelegatedReceipt(key: SelfKey, via: ReceiptDelegation, input: Omit<ReceiptBody, "selfKey" | "salt" | "at" | "via"> & { at?: string; salt?: string }): Receipt {
  if (!sameAddress(key.address, via.delegate)) throw new Error("This key is not the one the delegation names.");
  const body = cleanReceiptBody({ ...input, selfKey: via.selfKey, via, at: input.at ?? new Date().toISOString(), salt: input.salt ?? toHex(randomBytes(32)) });
  return { format: RECEIPT_FORMAT, version: 1, body, signature: signDigest(key.secret, personalMessageHash(receiptMessage(body))) };
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
  if (body.via) {
    const vouched = checkDelegation(body.via) && sameAddress(body.via.selfKey, body.selfKey) && Date.parse(body.via.since) <= Date.parse(body.at);
    const signed = vouched && !!signer && sameAddress(signer, body.via.delegate);
    checks.push({
      name: "signature",
      ok: signed,
      detail: signed
        ? `Signed for the self key ${body.selfKey} by the receipt key it gave a connected app (${body.via.delegate}) on ${body.via.since.slice(0, 10)}.`
        : !vouched
          ? "The self key's word for the app key that signed this receipt does not check."
          : "The app key's signature does not match this receipt, or it was changed after signing.",
    });
  } else {
    const signed = !!signer && sameAddress(signer, body.selfKey);
    checks.push({ name: "signature", ok: signed, detail: signed ? `Signed by the self key ${body.selfKey}.` : "The self key's signature does not match this receipt, or it was changed after signing." });
  }
  const leaf = receiptLeaf({ ...r, body });
  if (shared.seal) {
    let proven = false;
    try {
      proven = verifyProof(fromHex32(shared.seal.root), fromHex32(leaf), shared.seal.proof.map(fromHex32));
    } catch {
      proven = false;
    }
    checks.push({ name: "seal", ok: proven, detail: proven ? `Its fingerprint is in the sealed root ${shared.seal.root.slice(0, 18)}...` : "The proof does not lead from this receipt to the root it names." });
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
