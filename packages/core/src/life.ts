// Proof of a real life, version 1: a certificate that a vault has a long,
// continuous sealed history, without showing anything that is in it.
//
// While the vault is open, the owner's browser signs one presence statement
// per seal period with the vault's signing key (Ed25519, derived from the vault
// key, so only someone who can open the vault can make one):
//
//   "sigil-presence-v1" \n origin \n period seconds \n hour
//
// The server checks the signature and writes a read-log entry of kind
// "presence" whose memory id field is that signature. At the end of the hour
// the entry is sealed into the hour's Merkle root like every other entry.
//
// A certificate lists, for each hour with presence, the entry (id, time, salt,
// signature), its place in the seal and the proof up to the root, plus a
// summary: first and last sealed hour, hours and days with activity, the
// longest gap and how long the history has run without a gap of more than 30
// days. The vault signs the whole body. Anyone can check, in a browser:
//
//   1. the body is signed by the signing key it names
//   2. every presence statement is signed by that key, for that hour
//   3. every entry hashes to its leaf and the proof leads to the listed root
//   4. the summary follows from the hours listed
//   5. the roots are the ones the site publishes, and the ones on chain when
//      the seals are anchored
//
// What it proves: one key held by whoever could open the vault signed in each
// of those hours, and the site sealed it then. It does not say who that is.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "./crypto";
import { fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex32, hex32, readEntryLeaf, verifyProof } from "./merkle";

export const CERTIFICATE_FORMAT = "sigil-life-certificate";
/** A gap longer than this ends a run of continuous history. */
export const MAX_GAP_DAYS = 30;
export const PRESENCE_APP = "vault";

// ---------------------------------------------------------------- the signing key

export interface SigningKey {
  seed: Uint8Array;
  publicKey: string;
}

/** The vault's Ed25519 signing key, derived from the vault key on the device. */
export async function vaultSigningKey(vaultKey: Uint8Array): Promise<SigningKey> {
  const seed = await hkdf(vaultKey, "sigil:sign:presence:v1");
  return { seed, publicKey: toBase64Url(ed25519.getPublicKey(seed)) };
}

export function isSigningKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
}

export function signingFingerprint(publicKey: string): string {
  return toHex(sha256(utf8(`sigil-signing-fingerprint:${publicKey}`))).slice(0, 20).toUpperCase().match(/.{4}/g)!.join(" ");
}

// ---------------------------------------------------------------- presence

export function presenceMessage(origin: string, hour: number, periodSeconds: number): string {
  return ["sigil-presence-v1", origin.replace(/\/$/, ""), String(periodSeconds), String(hour)].join("\n");
}

export function signPresence(key: SigningKey, origin: string, hour: number, periodSeconds: number): string {
  return toBase64Url(ed25519.sign(utf8(presenceMessage(origin, hour, periodSeconds)), key.seed));
}

export function verifyPresence(publicKey: string, origin: string, hour: number, periodSeconds: number, signature: string): boolean {
  try {
    const sig = fromBase64Url(signature);
    if (sig.length !== 64 || !isSigningKey(publicKey)) return false;
    return ed25519.verify(sig, utf8(presenceMessage(origin, hour, periodSeconds)), fromBase64Url(publicKey));
  } catch {
    return false;
  }
}

export interface PresenceEntry {
  id: string;
  at: string;
  salt: string;
  /** The vault's signature over the hour, base64url. */
  sig: string;
}

export function presenceLeaf(e: PresenceEntry): string {
  return hex32(readEntryLeaf({ id: e.id, appId: PRESENCE_APP, kind: "presence", memoryId: e.sig, count: 1, at: e.at, salt: e.salt }));
}

// ---------------------------------------------------------------- the summary

export interface LifeSummary {
  firstHour: number;
  lastHour: number;
  /** Start of the first sealed period and end of the last, as ISO times. */
  from: string;
  to: string;
  activeHours: number;
  activeDays: number;
  /** The longest stretch with no presence, in whole hours. */
  longestGapHours: number;
  spanDays: number;
  /** Days since the start of the latest run with no gap longer than MAX_GAP_DAYS. */
  continuousDays: number;
  continuousMonths: number;
}

export function summarizeHours(hoursIn: number[], periodSeconds: number): LifeSummary {
  const hours = [...new Set(hoursIn)].sort((a, b) => a - b);
  if (hours.length === 0) throw new Error("There is no sealed presence yet.");
  const first = hours[0];
  const last = hours[hours.length - 1];
  let longestGap = 0;
  let runStart = first;
  for (let i = 1; i < hours.length; i++) {
    const gap = (hours[i] - hours[i - 1] - 1) * periodSeconds;
    if (gap > longestGap) longestGap = gap;
    if (gap > MAX_GAP_DAYS * 86400) runStart = hours[i];
  }
  const days = new Set(hours.map((h) => Math.floor((h * periodSeconds) / 86400)));
  const continuousDays = Math.floor(((last + 1 - runStart) * periodSeconds) / 86400);
  return {
    firstHour: first,
    lastHour: last,
    from: new Date(first * periodSeconds * 1000).toISOString(),
    to: new Date((last + 1) * periodSeconds * 1000).toISOString(),
    activeHours: hours.length,
    activeDays: days.size,
    longestGapHours: Math.floor(longestGap / 3600),
    spanDays: Math.floor(((last + 1 - first) * periodSeconds) / 86400),
    continuousDays,
    continuousMonths: Math.floor(continuousDays / 30),
  };
}

// ---------------------------------------------------------------- the certificate

export interface CertificateHour {
  hour: number;
  entry: PresenceEntry;
  /** The leaf's place in the hour's seal and the sibling hashes up to the root. */
  index: number;
  proof: string[];
  root: string;
}

export interface CertificateBody {
  origin: string;
  periodSeconds: number;
  signingKey: string;
  issuedAt: string;
  summary: LifeSummary;
  hours: CertificateHour[];
}

export interface LifeCertificate {
  format: typeof CERTIFICATE_FORMAT;
  version: 1;
  body: CertificateBody;
  signature: string;
}

/** JSON with every object's keys in order, so the same body always gives the same bytes. */
/** The deepest nesting a signed document may have. Every Sigil document is far shallower. */
export const MAX_JSON_DEPTH = 64;

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_JSON_DEPTH) throw new Error("This document is nested too deeply to be a Sigil document.");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`)
    .join(",")}}`;
}

function certificateMessage(body: CertificateBody): Uint8Array {
  return utf8(`sigil-life-certificate-v1\n${canonicalJson(body)}`);
}

export function buildCertificate(key: SigningKey, input: { origin: string; periodSeconds: number; hours: CertificateHour[]; issuedAt?: string }): LifeCertificate {
  const hours = [...input.hours].sort((a, b) => a.hour - b.hour);
  const body: CertificateBody = {
    origin: input.origin.replace(/\/$/, ""),
    periodSeconds: input.periodSeconds,
    signingKey: key.publicKey,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    summary: summarizeHours(
      hours.map((h) => h.hour),
      input.periodSeconds,
    ),
    hours,
  };
  return { format: CERTIFICATE_FORMAT, version: 1, body, signature: toBase64Url(ed25519.sign(certificateMessage(body), key.seed)) };
}

export interface CertificateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CertificateResult {
  ok: boolean;
  summary: LifeSummary | null;
  checks: CertificateCheck[];
}

/** Roots for a list of hours from some source: the site's published seals, or the contract on chain. Missing hours are left out. */
export type RootSource = (hours: number[]) => Promise<Map<number, string>>;

export interface VerifyOptions {
  /** The roots the site publishes. */
  published?: RootSource;
  /** The roots on chain, when the site anchors its seals. */
  onChain?: RootSource;
}

export function parseCertificate(text: string): LifeCertificate {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a certificate file: it is not valid JSON.");
  }
  const c = v as LifeCertificate;
  if (!c || c.format !== CERTIFICATE_FORMAT || c.version !== 1 || !c.body || typeof c.signature !== "string" || !Array.isArray(c.body.hours)) {
    throw new Error("This is not a Sigil life certificate.");
  }
  return c;
}

/** Checks a certificate on this device. Lookups of published and on-chain roots are optional and passed in. */
export async function verifyCertificate(cert: LifeCertificate, opts: VerifyOptions = {}): Promise<CertificateResult> {
  const checks: CertificateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const b = cert.body;

  let sigOk = false;
  try {
    sigOk = isSigningKey(b.signingKey) && ed25519.verify(fromBase64Url(cert.signature), certificateMessage(b), fromBase64Url(b.signingKey));
  } catch {
    sigOk = false;
  }
  add("signature", sigOk, sigOk ? `Signed by the key ${signingFingerprint(b.signingKey)}.` : "The certificate is not signed by the key it names, or it was changed after signing.");

  const period = Number(b.periodSeconds);
  const hours = Array.isArray(b.hours) ? b.hours : [];
  const seen = new Set<number>();
  let presenceBad = 0;
  let proofBad = 0;
  for (const h of hours) {
    const okHour = Number.isInteger(h.hour) && h.hour >= 0 && !seen.has(h.hour);
    seen.add(h.hour);
    const at = Date.parse(h.entry?.at ?? "");
    const inHour = Number.isFinite(at) && Math.floor(at / 1000 / period) === h.hour;
    if (!okHour || !inHour || !verifyPresence(b.signingKey, b.origin, h.hour, period, h.entry.sig)) {
      presenceBad++;
      continue;
    }
    try {
      const leaf = presenceLeaf(h.entry);
      if (!verifyProof(fromHex32(h.root), fromHex32(leaf), h.proof.map(fromHex32))) proofBad++;
    } catch {
      proofBad++;
    }
  }
  add(
    "presence",
    hours.length > 0 && presenceBad === 0,
    hours.length === 0 ? "The certificate lists no hours." : presenceBad === 0 ? `All ${hours.length} hours carry a presence statement signed by that key, for that hour.` : `${presenceBad} of ${hours.length} hours do not carry a valid presence statement.`,
  );
  add("proofs", hours.length > 0 && proofBad === 0 && presenceBad === 0, proofBad === 0 ? "Every entry leads through its proof to the root listed for its hour." : `${proofBad} entries do not lead to their listed root.`);

  let summary: LifeSummary | null = null;
  try {
    summary = summarizeHours(
      hours.map((h) => h.hour),
      period,
    );
  } catch {
    summary = null;
  }
  const summaryOk = !!summary && canonicalJson(summary) === canonicalJson(b.summary);
  add("summary", summaryOk, summaryOk ? "The summary follows from the hours listed." : "The summary does not match the hours listed.");

  const compare = async (name: string, source: RootSource | undefined, what: string) => {
    if (!source) return;
    let roots: Map<number, string>;
    try {
      roots = await source(hours.map((h) => h.hour));
    } catch (err) {
      add(name, false, `The ${what} could not be read: ${(err as Error).message}`);
      return;
    }
    const missing = hours.filter((h) => !roots.has(h.hour)).length;
    const differ = hours.filter((h) => roots.has(h.hour) && roots.get(h.hour)!.toLowerCase() !== h.root.toLowerCase()).length;
    add(
      name,
      missing === 0 && differ === 0,
      differ > 0 ? `${differ} roots differ from the ${what}.` : missing > 0 ? `${missing} of ${hours.length} hours are not in the ${what}.` : `All ${hours.length} roots match the ${what}.`,
    );
  };
  await compare("published", opts.published, "seals this site publishes");
  await compare("chain", opts.onChain, "seals on chain");
  if (hours.length && !opts.published && !opts.onChain) add("roots", false, "The roots were not compared with any published or on-chain seals, so the proofs only show the document agrees with itself.");

  return { ok: checks.every((c) => c.ok), summary: summaryOk ? summary : null, checks };
}
