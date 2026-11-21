// Proving a fact without showing it, version 1: selective disclosure.
//
// The owner picks one claim. The vault signs a statement of it with the
// vault's Ed25519 signing key, the server writes the statement's hash into the
// read log as a "disclose" entry, and once that hour is sealed the proof is
// complete: anyone can check the signature, the evidence and that the
// statement was sealed then, against the roots the site publishes (and the
// chain, when the seals are anchored). Four kinds of claim:
//
//   field     one field of one memory, revealed with its salt and a Merkle path
//             to the commitment of all the memory's fields; the rest stay hidden
//   before    a date field (a birth date) is before a given date. The date stays
//             hidden. This is the owner's own statement: it is committed, so it
//             can be opened later, but nothing here computes the comparison for
//             the checker. Zero-knowledge proofs for it are on the roadmap.
//   history   the vault has at least N months of sealed history: the first and a
//             latest sealed presence statement, each signed by the same key and
//             each with its proof. Checked in full by anyone.
//   member    the vault joined a team space at a time: the sealed log entry of the
//             join, with its proof. The space's name is the owner's own label.
//
// Leaves of a memory's fields:  leaf = SHA-256(0x00 || "sigil-field-v1" \n name \n value \n salt)
// Statement hash, the "disclose" entry's memory id:
//   hex32(SHA-256("sigil-disclosure-v1" \n canonical JSON of the statement))

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "./crypto";
import { fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";
import { canonicalJson, isSigningKey, presenceLeaf, signingFingerprint, verifyPresence, type CertificateCheck, type CertificateHour, type RootSource, type SigningKey } from "./life";
import { fromHex32, hex32, leafHash, merkleProof, merkleRoot, readEntryLeaf, verifyProof, type ReadKind } from "./merkle";

export const DISCLOSURE_FORMAT = "sigil-disclosure";
export const DISCLOSE_APP = "vault";

// ---------------------------------------------------------------- fields of a memory

export interface Field {
  name: string;
  value: string;
}

export interface FieldOpening extends Field {
  salt: string;
}

const FIELD_LINE = /^\s*([A-Za-z][A-Za-z0-9 ()/'-]{0,39}?)\s*:\s*(.{1,500})$/;

/** The fields a memory offers for a claim: its title, every "Name: value" line of its body, and the day it was written. */
export function memoryFields(memory: { title: string; body: string; createdAt: string }): Field[] {
  const out: Field[] = [{ name: "Title", value: memory.title }];
  const seen = new Set(["title"]);
  for (const line of memory.body.split("\n")) {
    const m = FIELD_LINE.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value: m[2].trim() });
    if (out.length >= 64) break;
  }
  if (!seen.has("written")) out.push({ name: "Written", value: memory.createdAt.slice(0, 10) });
  return out;
}

export function fieldLeaf(f: FieldOpening): Uint8Array {
  return leafHash(["sigil-field-v1", f.name, f.value, f.salt].join("\n"));
}

export interface FieldCommitment {
  root: string;
  openings: FieldOpening[];
}

/** Commits to every field with its own fresh salt. The root says nothing about the fields without their salts. */
export function commitFields(fields: Field[], salts?: string[]): FieldCommitment {
  if (fields.length === 0) throw new Error("There is nothing to commit to.");
  const openings = fields.map((f, i) => ({ name: f.name, value: f.value, salt: salts?.[i] ?? toHex(randomBytes(32)) }));
  return { root: hex32(merkleRoot(openings.map(fieldLeaf))), openings };
}

/** A date written in a field, read as a day. Null when it is not a date. */
export function fieldDate(value: string): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) {
    const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  }
  // Other shapes ("2 April 1990") are read as a day where the device is.
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day N years before a given day: born before it means at least N years old on that day. */
export function yearsBefore(day: string, years: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- claims

export interface SealedEntry {
  id: string;
  appId: string;
  kind: ReadKind;
  memoryId: string | null;
  count: number;
  at: string;
  salt: string;
  hour: number;
  index: number;
  proof: string[];
  root: string;
}

export type Claim =
  | { kind: "field"; opening: FieldOpening & { index: number; proof: string[] }; commitment: string }
  | { kind: "before"; field: string; date: string; years: number | null; commitment: string }
  | { kind: "history"; months: number; first: CertificateHour; latest: CertificateHour }
  | { kind: "member"; space: string; label: string; entry: SealedEntry };

export interface DisclosureStatement {
  origin: string;
  periodSeconds: number;
  signingKey: string;
  issuedAt: string;
  claim: Claim;
}

export interface Disclosure {
  format: typeof DISCLOSURE_FORMAT;
  version: 1;
  statement: DisclosureStatement;
  /** Ed25519 by the signing key over the statement, base64url. */
  signature: string;
  /** The "disclose" entry with the statement's hash, once its hour is sealed. */
  anchor: SealedEntry | null;
}

export function statementMessage(s: DisclosureStatement): Uint8Array {
  return utf8(`${DISCLOSURE_FORMAT}-v1\n${canonicalJson(s)}`);
}

/** The statement's hash, written as the memory id of the "disclose" entry. */
export function statementHash(s: DisclosureStatement): string {
  return hex32(sha256(statementMessage(s)));
}

const DAY = 86_400_000;

function formatDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The claim in one plain sentence. */
export function describeClaim(c: Claim): string {
  if (c.kind === "field") return `${c.opening.name}: ${c.opening.value}`;
  if (c.kind === "before") return c.years ? `${c.field} is before ${formatDay(c.date)}: at least ${c.years} years` : `${c.field} is before ${formatDay(c.date)}`;
  if (c.kind === "history") return `At least ${c.months} ${c.months === 1 ? "month" : "months"} of sealed history`;
  return `Member of the team space ${c.label || c.space} since ${formatDay(c.entry.at)}`;
}

/** Who stands behind the claim, in words, for the checker to read. */
export function claimAttestedBy(c: Claim): string {
  if (c.kind === "history") return "The site's seals: the signed presence and its proofs are checked here.";
  if (c.kind === "member") return "The site's seals for the time of joining; the space's name is the owner's own label.";
  if (c.kind === "field") return "The owner's vault: the value is what the owner's memory says, committed and signed, not checked by anyone else.";
  return "The owner's vault alone: the date stays hidden and the comparison is the owner's own statement, not computed here.";
}

export function historyMonths(first: number, latest: number, periodSeconds: number): number {
  return Math.floor(((latest + 1 - first) * periodSeconds * 1000) / DAY / 30);
}

// ---------------------------------------------------------------- making one

export function signDisclosure(key: SigningKey, statement: DisclosureStatement): Disclosure {
  if (statement.signingKey !== key.publicKey) throw new Error("The statement names another signing key.");
  return { format: DISCLOSURE_FORMAT, version: 1, statement, signature: toBase64Url(ed25519.sign(statementMessage(statement), key.seed)), anchor: null };
}

/** The field claim for one field of a commitment. */
export function fieldClaim(commitment: FieldCommitment, index: number): Claim {
  const o = commitment.openings[index];
  if (!o) throw new Error("That field is not in the commitment.");
  return { kind: "field", commitment: commitment.root, opening: { ...o, index, proof: merkleProof(commitment.openings.map(fieldLeaf), index).map(hex32) } };
}

/** A claim that a date field is before a day. Refuses to sign a claim the field does not support. */
export function beforeClaim(commitment: FieldCommitment, index: number, date: string, years: number | null = null): Claim {
  const o = commitment.openings[index];
  if (!o) throw new Error("That field is not in the commitment.");
  const day = fieldDate(o.value);
  if (!day) throw new Error(`"${o.value}" is not a date.`);
  const before = fieldDate(date);
  if (!before) throw new Error("Choose a date to compare with.");
  if (!(day < before)) throw new Error(`The field says ${day}, which is not before ${before}. That claim would not be true.`);
  return { kind: "before", field: o.name, date: before, years, commitment: commitment.root };
}

/** A history claim from the first sealed presence hour and a later one. */
export function historyClaim(first: CertificateHour, latest: CertificateHour, periodSeconds: number): Claim {
  const months = historyMonths(first.hour, latest.hour, periodSeconds);
  if (months < 1) throw new Error("There is less than a month of sealed history yet.");
  return { kind: "history", months, first, latest };
}

// ---------------------------------------------------------------- checking one

export function parseDisclosure(text: string): Disclosure {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a proof: it is not valid JSON.");
  }
  const d = v as Disclosure;
  if (!d || d.format !== DISCLOSURE_FORMAT || d.version !== 1 || !d.statement || typeof d.signature !== "string" || !d.statement.claim) throw new Error("This is not a Sigil proof of a fact.");
  return d;
}

export function entryLeaf(e: SealedEntry): string {
  return hex32(readEntryLeaf({ id: e.id, appId: e.appId, kind: e.kind, memoryId: e.memoryId, count: e.count, at: e.at, salt: e.salt }));
}

function proofOk(leaf: string, proof: string[], root: string): boolean {
  try {
    return verifyProof(fromHex32(root), fromHex32(leaf), proof.map(fromHex32));
  } catch {
    return false;
  }
}

function hourOk(at: string, hour: number, period: number): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && Math.floor(t / 1000 / period) === hour;
}

export interface DisclosureResult {
  ok: boolean;
  /** The claim in a sentence, when the signature holds. */
  claim: string | null;
  attestedBy: string;
  checks: CertificateCheck[];
}

export interface DisclosureVerifyOptions {
  published?: RootSource;
  onChain?: RootSource;
}

/** Checks a proof on this device. Lookups of published and on-chain roots are passed in. */
export async function verifyDisclosure(d: Disclosure, opts: DisclosureVerifyOptions = {}): Promise<DisclosureResult> {
  const checks: CertificateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const s = d.statement;
  const period = Number(s.periodSeconds);
  const roots: { hour: number; root: string }[] = [];

  let sigOk = false;
  try {
    sigOk = isSigningKey(s.signingKey) && ed25519.verify(fromBase64Url(d.signature), statementMessage(s), fromBase64Url(s.signingKey));
  } catch {
    sigOk = false;
  }
  add("signature", sigOk, sigOk ? `Signed by the vault key ${signingFingerprint(s.signingKey)}.` : "The statement is not signed by the key it names, or it was changed after signing.");

  const c = s.claim;
  if (c.kind === "field") {
    const o = c.opening;
    const ok = !!o && typeof o.name === "string" && typeof o.value === "string" && /^[0-9a-f]{64}$/.test(o.salt ?? "") && proofOk(hex32(fieldLeaf(o)), o.proof ?? [], c.commitment);
    add("claim", ok, ok ? "The revealed field, with its salt, leads to the commitment of the whole memory. The other fields stay hidden." : "The revealed field does not lead to the commitment.");
  } else if (c.kind === "before") {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(c.date ?? "") && /^0x[0-9a-f]{64}$/.test(c.commitment ?? "");
    add("claim", ok, ok ? "The date stays hidden, committed under the signed statement. That it is before the day named is the owner's own statement." : "The claim is not well formed.");
  } else if (c.kind === "history") {
    const hours = [c.first, c.latest];
    let bad = 0;
    for (const h of hours) {
      const fine =
        !!h?.entry &&
        hourOk(h.entry.at, h.hour, period) &&
        verifyPresence(s.signingKey, s.origin, h.hour, period, h.entry.sig) &&
        proofOk(presenceLeaf(h.entry), h.proof ?? [], h.root);
      if (fine) roots.push({ hour: h.hour, root: h.root });
      else bad++;
    }
    const months = bad === 0 ? historyMonths(c.first.hour, c.latest.hour, period) : 0;
    const ok = bad === 0 && c.latest.hour >= c.first.hour && months >= c.months && c.months >= 1;
    add(
      "claim",
      ok,
      ok
        ? `Presence signed by the same key on ${formatDay(new Date(c.first.hour * period * 1000).toISOString())} and on ${formatDay(new Date(c.latest.hour * period * 1000).toISOString())}, each sealed: ${months} months apart.`
        : bad
          ? "A presence statement or its proof does not hold."
          : "The two sealed hours are not as far apart as the claim says.",
    );
  } else if (c.kind === "member") {
    const e = c.entry;
    const ok = !!e && e.kind === "space" && e.memoryId === `joined-${c.space}` && hourOk(e.at, e.hour, period) && proofOk(entryLeaf(e), e.proof ?? [], e.root);
    if (ok) roots.push({ hour: e.hour, root: e.root });
    add("claim", ok, ok ? `The join of the space was sealed in the log at ${e.at}.` : "The sealed entry of the join does not hold.");
  } else {
    add("claim", false, "This kind of claim is not known.");
  }

  const a = d.anchor;
  if (!a) {
    add("anchor", false, "The statement is not sealed yet. Its proof is complete once the hour it was made in is over.");
  } else {
    const ok =
      a.kind === "disclose" &&
      a.appId === DISCLOSE_APP &&
      a.memoryId === statementHash(s) &&
      a.count === 1 &&
      hourOk(a.at, a.hour, period) &&
      Date.parse(a.at) >= Date.parse(s.issuedAt) - 60_000 &&
      proofOk(entryLeaf(a), a.proof ?? [], a.root);
    if (ok) roots.push({ hour: a.hour, root: a.root });
    add("anchor", ok, ok ? `The statement was sealed in the hour that began ${new Date(a.hour * period * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC.` : "The sealed entry does not carry this statement's hash, or its proof does not hold.");
  }

  const compare = async (name: string, source: RootSource | undefined, what: string) => {
    if (!source || roots.length === 0) return;
    let found: Map<number, string>;
    try {
      found = await source(roots.map((r) => r.hour));
    } catch (err) {
      add(name, false, `The ${what} could not be read: ${(err as Error).message}`);
      return;
    }
    const missing = roots.filter((r) => !found.has(r.hour)).length;
    const differ = roots.filter((r) => found.has(r.hour) && found.get(r.hour)!.toLowerCase() !== r.root.toLowerCase()).length;
    add(name, missing === 0 && differ === 0, differ ? `${differ} roots differ from the ${what}.` : missing ? `${missing} of ${roots.length} hours are not in the ${what}.` : `All ${roots.length} roots match the ${what}.`);
  };
  await compare("published", opts.published, "seals this site publishes");
  await compare("chain", opts.onChain, "seals on chain");
  // Roots taken from the proof itself prove nothing on their own: a proof may make up its own root.
  if (roots.length && !opts.published && !opts.onChain) add("roots", false, "The roots were not compared with any published or on-chain seals, so the proofs only show the document agrees with itself.");

  return { ok: checks.every((x) => x.ok), claim: sigOk ? describeClaim(c) : null, attestedBy: claimAttestedBy(c), checks };
}
