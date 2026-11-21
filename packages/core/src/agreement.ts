// Sealed agreements: one vault drafts a text, the other reviews and signs, and
// both signatures are over the same hash. Once both signed, the hash goes into
// both vaults' read logs as an "agreement" entry and so into both hourly seals.
// Either side can show a verifiable copy: the text, both signatures and the
// sealed entry of its own vault.
//
//   hash       hex32(SHA-256("sigil-agreement-v1" \n canonical JSON of the document))
//   signature  Ed25519 by each party's vault signing key over
//              "sigil-agreement-sign-v1" \n <hash>
//
// The document names both parties by their vault box key and signing key, and
// carries a random nonce so a short text cannot be guessed from its hash. An
// amendment is a new document whose `previous` is the hash of the signed one
// it replaces and whose version is one higher; nothing signed is ever changed.
// The relay carries the document sealed to the other vault's box key; the
// server sees the hash, the two public keys and the signatures, not the text.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "./crypto";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import { isBoxPublicKey } from "./box";
import { entryLeaf, type SealedEntry } from "./disclose";
import { canonicalJson, isSigningKey, signingFingerprint, type CertificateCheck, type RootSource, type SigningKey } from "./life";
import { fromHex32, hex32, verifyProof } from "./merkle";

export const AGREEMENT_FORMAT = "sigil-agreement";
export const AGREEMENT_MAX_TEXT = 40_000;

export interface AgreementParty {
  /** The name the party signs with. */
  name: string;
  /** The vault's box public key (its vault code without the check). */
  boxKey: string;
  /** The vault's Ed25519 signing key. */
  signingKey: string;
}

export interface AgreementDoc {
  title: string;
  text: string;
  /** The vault that drafted it first. */
  parties: [AgreementParty, AgreementParty];
  version: number;
  /** The hash of the signed agreement this one amends, or null. */
  previous: string | null;
  nonce: string;
  createdAt: string;
}

export interface SignedAgreement {
  format: typeof AGREEMENT_FORMAT;
  version: 1;
  doc: AgreementDoc;
  hash: string;
  /** Base64url Ed25519 signatures, in the order of the parties. */
  signatures: [string, string];
  /** The sealed "agreement" entry of the vault that shows this copy, once its hour is sealed. */
  seal: (SealedEntry & { party: 0 | 1 }) | null;
}

function party(v: unknown): AgreementParty {
  const p = (v ?? {}) as Record<string, unknown>;
  const boxKey = String(p.boxKey ?? "");
  const signingKey = String(p.signingKey ?? "");
  if (!isBoxPublicKey(boxKey) || !isSigningKey(signingKey)) throw new Error("A party of the agreement has no valid keys.");
  return { name: String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80), boxKey, signingKey };
}

export function cleanAgreementDoc(value: Partial<AgreementDoc>): AgreementDoc {
  const parties = Array.isArray(value.parties) ? value.parties : [];
  if (parties.length !== 2) throw new Error("An agreement has two parties.");
  const [a, b] = [party(parties[0]), party(parties[1])];
  if (a.signingKey === b.signingKey || a.boxKey === b.boxKey) throw new Error("The two parties are the same vault.");
  const title = String(value.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = String(value.text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!title) throw new Error("Give the agreement a title.");
  if (!text) throw new Error("Write the text of the agreement.");
  if (text.length > AGREEMENT_MAX_TEXT) throw new Error(`The text is longer than ${AGREEMENT_MAX_TEXT} characters.`);
  const version = Number(value.version ?? 1);
  if (!Number.isInteger(version) || version < 1 || version > 1000) throw new Error("The version is a whole number from 1.");
  const previous = value.previous ?? null;
  if (previous !== null && !/^0x[0-9a-f]{64}$/.test(previous)) throw new Error("The earlier version's hash is not valid.");
  if ((previous === null) !== (version === 1)) throw new Error("Only an amendment names an earlier version, and every amendment does.");
  return {
    title,
    text,
    parties: [a, b],
    version,
    previous,
    nonce: typeof value.nonce === "string" && /^[A-Za-z0-9_-]{22}$/.test(value.nonce) ? value.nonce : toBase64Url(randomBytes(16)),
    createdAt: typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : new Date().toISOString(),
  };
}

export function agreementHash(doc: AgreementDoc): string {
  return hex32(sha256(utf8(`${AGREEMENT_FORMAT}-v1\n${canonicalJson(doc)}`)));
}

function signMessage(hash: string): Uint8Array {
  return utf8(`${AGREEMENT_FORMAT}-sign-v1\n${hash}`);
}

export function signAgreement(key: SigningKey, hash: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("That is not an agreement hash.");
  return toBase64Url(ed25519.sign(signMessage(hash), key.seed));
}

export function verifyAgreementSignature(signingKey: string, hash: string, signature: string): boolean {
  try {
    const sig = fromBase64Url(signature);
    return sig.length === 64 && isSigningKey(signingKey) && /^0x[0-9a-f]{64}$/.test(hash) && ed25519.verify(sig, signMessage(hash), fromBase64Url(signingKey));
  } catch {
    return false;
  }
}

/** Which party a signing key is, or -1. */
export function partyIndex(doc: AgreementDoc, signingKey: string): -1 | 0 | 1 {
  return doc.parties[0].signingKey === signingKey ? 0 : doc.parties[1].signingKey === signingKey ? 1 : -1;
}

export function parseAgreement(text: string): SignedAgreement {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not an agreement file: it is not valid JSON.");
  }
  const a = v as SignedAgreement;
  if (!a || a.format !== AGREEMENT_FORMAT || a.version !== 1 || !a.doc || !Array.isArray(a.signatures)) throw new Error("This is not a Sigil agreement.");
  return a;
}

export interface AgreementResult {
  ok: boolean;
  checks: CertificateCheck[];
}

/** Checks a signed agreement on this device: the hash, both signatures, and the sealed entry with its root. */
export async function verifyAgreement(a: SignedAgreement, opts: { published?: RootSource; onChain?: RootSource; periodSeconds?: number } = {}): Promise<AgreementResult> {
  const checks: CertificateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let hash = "";
  try {
    hash = agreementHash(cleanAgreementDoc(a.doc));
  } catch {
    hash = "";
  }
  const sameDoc = !!hash && canonicalJson(cleanAgreementDoc(a.doc)) === canonicalJson(a.doc);
  add("hash", sameDoc && hash === a.hash, sameDoc && hash === a.hash ? `The text and both parties hash to ${hash.slice(0, 18)}...` : "The text or the parties do not match the hash that was signed.");
  for (const i of [0, 1] as const) {
    const p = a.doc?.parties?.[i];
    const ok = !!p && verifyAgreementSignature(p.signingKey, a.hash, a.signatures?.[i] ?? "");
    add(`party-${i + 1}`, ok, ok ? `Signed by ${p.name || `party ${i + 1}`}, vault key ${signingFingerprint(p.signingKey)}.` : `The signature of ${p?.name || `party ${i + 1}`} does not hold.`);
  }
  const s = a.seal;
  if (!s) {
    add("seal", false, "This copy carries no sealed entry yet. It is complete once the hour it was signed in is over.");
  } else {
    let ok = s.kind === "agreement" && s.memoryId === a.hash;
    if (ok && opts.periodSeconds) ok = Math.floor(Date.parse(s.at) / 1000 / opts.periodSeconds) === s.hour;
    try {
      ok = ok && verifyProof(fromHex32(s.root), fromHex32(entryLeaf(s)), s.proof.map(fromHex32));
    } catch {
      ok = false;
    }
    add("seal", ok, ok ? `Sealed in ${s.party === 0 ? "the first" : "the second"} party's log at ${s.at}.` : "The sealed entry does not carry this agreement's hash, or its proof does not hold.");
    const compare = async (name: string, source: RootSource | undefined, what: string) => {
      if (!source || !ok) return;
      try {
        const roots = await source([s.hour]);
        const same = roots.get(s.hour)?.toLowerCase() === s.root.toLowerCase();
        add(name, same, same ? `The root matches the ${what}.` : roots.has(s.hour) ? `The root differs from the ${what}.` : `That hour is not in the ${what}.`);
      } catch (err) {
        add(name, false, `The ${what} could not be read: ${(err as Error).message}`);
      }
    };
    await compare("published", opts.published, "seals this site publishes");
    await compare("chain", opts.onChain, "seals on chain");
    if (ok && !opts.published && !opts.onChain) add("roots", false, "The roots were not compared with any published or on-chain seals, so the proofs only show the document agrees with itself.");
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------- what travels between the two vaults

/** The draft as sent to the other vault, sealed to its box key with the context of the agreement id. */
export interface AgreementOffer {
  v: 1;
  doc: AgreementDoc;
  /** The first party's signature, made when it sends the draft. */
  signature: string;
}

export function agreementContext(agreementId: string): string {
  return `agreement:${agreementId}`;
}
