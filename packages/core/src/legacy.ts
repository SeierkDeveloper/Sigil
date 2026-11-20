// Legacy: your AI self outlives you.
//
// The owner names trusted people, the folders each one gets, whether they may
// talk to the AI self, an inactivity period and a threshold (k of n). On the
// owner's device:
//
//   legacy key L    32 random bytes. Every change to the plan makes a new one
//                   (a new epoch), so shares from before stop fitting.
//   shares          L split with Shamir's secret sharing over GF(256), using the
//                   independently audited shamir-secret-sharing library. Each
//                   trusted person's share is sealed to that person's vault
//                   public key (box.ts).
//   bundles         per trusted person: the keys of the folders they get, and
//                   the AI self's rules if allowed. AES-256-GCM under a key
//                   derived from L, and that envelope sealed to the person's
//                   vault public key. Opening one takes k shares AND that
//                   person's own vault, so no trusted person can open another's.
//   owner record    L and the plan under the owner's vault key, so the owner
//                   can change or cancel it from any device.
//
// The server keeps sealed boxes, decides when a plan may be released (once the
// owner has been inactive for the whole period), and relays shares between
// trusted people in a release room. It never sees a share or L in readable form.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { combine, split } from "shamir-secret-sharing";
import { decodeBoxPublicKey, isBoxPublicKey, openSealedBytes, openSealedJson, sealBytes, sealJson, type BoxKeyPair } from "./box";
import { DecryptError, decryptJson, encryptJson, hkdf, importKey, randomBytes, randomId } from "./crypto";
import { equalBytes, fromBase64Url, fromUtf8, toBase64Url, toHex, utf8 } from "./encoding";
import { AAD } from "./keys";
import { cleanModelSettings, type ModelSettings } from "./model";
import { cleanRules, type SelfRules } from "./self";
import type { OpenFolder } from "./vault";

/** Inactivity periods the vault offers, in days: three, six and twelve months. */
export const LEGACY_PERIODS = [90, 180, 365] as const;
export const MIN_LEGACY_DAYS = 30;
export const MAX_LEGACY_DAYS = 730;
export const MAX_TRUSTEES = 12;

export function newLegacyKey(): Uint8Array {
  return randomBytes(32);
}

/** A value that tells whether combined shares gave the right key, without saying anything about the key. */
export function legacyCheck(key: Uint8Array, planId: string, epoch: number): string {
  return toHex(hmac(sha256, key, utf8(`sigil-legacy-check:v1:${planId}:${epoch}`)));
}

// ---------------------------------------------------------------- splitting

/**
 * Splits the legacy key into n shares, any k of which give it back. With k = 1
 * every share is the key itself (one trusted person alone may open it).
 */
export async function splitLegacyKey(key: Uint8Array, n: number, k: number): Promise<Uint8Array[]> {
  if (key.length !== 32) throw new Error("A legacy key is 32 bytes.");
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRUSTEES) throw new Error(`A plan has 1 to ${MAX_TRUSTEES} trusted people.`);
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error("The number of people needed must be between 1 and the number of trusted people.");
  if (k === 1) return Array.from({ length: n }, () => key.slice());
  if (n === 1) throw new Error("The number of people needed must be between 1 and the number of trusted people.");
  return split(key, n, k);
}

/** Combines shares in this browser. The result is checked against the plan's check value. */
export async function combineLegacyShares(shares: Uint8Array[], threshold: number, expect: { planId: string; epoch: number; check: string }): Promise<Uint8Array> {
  const unique: Uint8Array[] = [];
  for (const s of shares) if (!unique.some((u) => equalBytes(u, s))) unique.push(s);
  let key: Uint8Array;
  if (threshold === 1) {
    if (unique.length < 1 || unique[0].length !== 32) throw new LegacyError("There is no share to open.", "no_share");
    key = unique[0];
  } else {
    if (unique.length < threshold) throw new LegacyError(`This plan needs ${threshold} shares; there are ${unique.length}.`, "too_few");
    try {
      key = await combine(unique);
    } catch {
      throw new LegacyError("These shares do not fit together.", "mismatch");
    }
  }
  if (key.length !== 32 || legacyCheck(key, expect.planId, expect.epoch) !== expect.check) {
    throw new LegacyError("These shares do not fit together. One of them may be from before the plan changed.", "mismatch");
  }
  return key;
}

export class LegacyError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "LegacyError";
  }
}

// ---------------------------------------------------------------- the people

export interface LegacyTrustee {
  id: string;
  /** What the owner calls them. */
  label: string;
  /** Their vault public key, as the owner entered it or checked it. */
  publicKey: string;
}

/** The share a trusted person holds, as they open it. */
export interface LegacySharePayload {
  v: 1;
  planId: string;
  epoch: number;
  trusteeId: string;
  /** The Shamir share, base64url. */
  share: string;
  threshold: number;
  /** Everyone the owner named, with the keys the owner sealed to. Shares are passed on only to these keys. */
  trustees: LegacyTrustee[];
  check: string;
  owner: string;
}

export function legacyShareContext(planId: string, epoch: number, trusteeId: string): string {
  return `legacy-share:${planId}:${epoch}:${trusteeId}`;
}

export function sealLegacyShare(p: LegacySharePayload): string {
  const me = p.trustees.find((t) => t.id === p.trusteeId);
  if (!me) throw new Error("The share's owner is not in the plan.");
  return sealJson(decodeBoxPublicKey(me.publicKey), p, legacyShareContext(p.planId, p.epoch, p.trusteeId));
}

export function openLegacyShare(pair: BoxKeyPair, ref: { planId: string; epoch: number; trusteeId: string; sealed: string }): { payload: LegacySharePayload; share: Uint8Array } {
  const p = openSealedJson<LegacySharePayload>(pair, ref.sealed, legacyShareContext(ref.planId, ref.epoch, ref.trusteeId));
  if (p.planId !== ref.planId || p.epoch !== ref.epoch || p.trusteeId !== ref.trusteeId) throw new DecryptError("This share belongs to another plan.");
  const trustees = Array.isArray(p.trustees) ? p.trustees.filter((t) => t && typeof t.id === "string" && isBoxPublicKey(t.publicKey)).map((t) => ({ id: t.id, label: String(t.label ?? "").slice(0, 80), publicKey: t.publicKey })) : [];
  const share = fromBase64Url(String(p.share ?? ""));
  const threshold = Number(p.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > trustees.length) throw new DecryptError("This share is damaged.");
  return { payload: { ...p, trustees, threshold, owner: String(p.owner ?? "").slice(0, 80), check: String(p.check ?? "") }, share };
}

// ---------------------------------------------------------------- the release room

export interface PassedShare {
  v: 1;
  planId: string;
  epoch: number;
  from: string;
  to: string;
  share: string;
}

export function passContext(planId: string, epoch: number, from: string, to: string): string {
  return `legacy-pass:${planId}:${epoch}:${from}:${to}`;
}

/**
 * Hands one's own share to another trusted person, sealed to the key the owner
 * named for them (from one's own share, never from the server).
 */
export function passShare(mine: LegacySharePayload, share: Uint8Array, toTrusteeId: string): string {
  const to = mine.trustees.find((t) => t.id === toTrusteeId);
  if (!to) throw new Error("That person is not in this plan.");
  if (to.id === mine.trusteeId) throw new Error("A share is not passed to oneself.");
  const p: PassedShare = { v: 1, planId: mine.planId, epoch: mine.epoch, from: mine.trusteeId, to: to.id, share: toBase64Url(share) };
  return sealJson(decodeBoxPublicKey(to.publicKey), p, passContext(mine.planId, mine.epoch, mine.trusteeId, to.id));
}

/** Opens a share another trusted person passed on. It must come from someone the owner named. */
export function openPassedShare(pair: BoxKeyPair, mine: LegacySharePayload, from: string, sealed: string): Uint8Array {
  if (!mine.trustees.some((t) => t.id === from) || from === mine.trusteeId) throw new DecryptError("This share is from someone outside the plan.");
  const p = openSealedJson<PassedShare>(pair, sealed, passContext(mine.planId, mine.epoch, from, mine.trusteeId));
  if (p.planId !== mine.planId || p.epoch !== mine.epoch || p.from !== from || p.to !== mine.trusteeId) throw new DecryptError("This share belongs to another plan.");
  return fromBase64Url(String(p.share ?? ""));
}

// ---------------------------------------------------------------- what each person receives

export interface LegacyBundle {
  v: 1;
  planId: string;
  epoch: number;
  trusteeId: string;
  owner: string;
  /** The owner's vault public key, so questions to the AI self in legacy mode can be logged sealed for the owner. */
  ownerKey: string | null;
  folders: { id: string; key: string }[];
  /** The AI self in legacy mode: the owner's rules, reading only these folders, and the owner's model if they included it. */
  self: { rules: SelfRules; model: ModelSettings | null } | null;
}

function bundleContext(planId: string, epoch: number, trusteeId: string): string {
  return `legacy-bundle:${planId}:${epoch}:${trusteeId}`;
}

async function bundleKey(legacyKey: Uint8Array, planId: string, epoch: number, trusteeId: string): Promise<CryptoKey> {
  return importKey(await hkdf(legacyKey, `sigil:legacy-bundle:${planId}:${epoch}:${trusteeId}`));
}

export async function sealLegacyBundle(legacyKey: Uint8Array, trusteePublicKey: string, b: LegacyBundle): Promise<string> {
  const inner = await encryptJson(await bundleKey(legacyKey, b.planId, b.epoch, b.trusteeId), b, AAD.legacyBundle(b.planId, b.epoch, b.trusteeId));
  return sealBytes(decodeBoxPublicKey(trusteePublicKey), utf8(inner), bundleContext(b.planId, b.epoch, b.trusteeId));
}

export async function openLegacyBundle(legacyKey: Uint8Array, pair: BoxKeyPair, ref: { planId: string; epoch: number; trusteeId: string; sealed: string }): Promise<LegacyBundle> {
  const inner = fromUtf8(openSealedBytes(pair, ref.sealed, bundleContext(ref.planId, ref.epoch, ref.trusteeId)));
  const b = await decryptJson<LegacyBundle>(await bundleKey(legacyKey, ref.planId, ref.epoch, ref.trusteeId), inner, AAD.legacyBundle(ref.planId, ref.epoch, ref.trusteeId));
  if (b.planId !== ref.planId || b.epoch !== ref.epoch || b.trusteeId !== ref.trusteeId) throw new DecryptError("This bundle belongs to another plan.");
  return cleanBundle(b);
}

function cleanBundle(b: LegacyBundle): LegacyBundle {
  const folders = (Array.isArray(b.folders) ? b.folders : []).filter((f) => f && typeof f.id === "string" && typeof f.key === "string" && fromBase64Url(f.key).length === 32);
  const self = b.self && typeof b.self === "object" ? { rules: cleanRules(b.self.rules), model: cleanModelSettings(b.self.model) } : null;
  if (self) self.rules.folderIds = self.rules.folderIds.filter((id) => folders.some((f) => f.id === id));
  return { v: 1, planId: b.planId, epoch: b.epoch, trusteeId: b.trusteeId, owner: String(b.owner ?? "").slice(0, 80), ownerKey: isBoxPublicKey(b.ownerKey) ? b.ownerKey : null, folders, self };
}

/** Readable at any time by the trusted person: who named them and what they would receive. Nothing that opens anything. */
export interface LegacyNote {
  v: 1;
  planId: string;
  epoch: number;
  owner: string;
  /** What the owner calls them. */
  label: string;
  folders: string[];
  self: boolean;
  periodDays: number;
  threshold: number;
  total: number;
}

export function legacyNoteContext(planId: string, epoch: number, trusteeId: string): string {
  return `legacy-note:${planId}:${epoch}:${trusteeId}`;
}

export function sealLegacyNote(publicKey: string, trusteeId: string, note: LegacyNote): string {
  return sealJson(decodeBoxPublicKey(publicKey), note, legacyNoteContext(note.planId, note.epoch, trusteeId));
}

export function openLegacyNote(pair: BoxKeyPair, ref: { planId: string; epoch: number; trusteeId: string; sealed: string }): LegacyNote {
  const n = openSealedJson<LegacyNote>(pair, ref.sealed, legacyNoteContext(ref.planId, ref.epoch, ref.trusteeId));
  return {
    v: 1,
    planId: ref.planId,
    epoch: ref.epoch,
    owner: String(n.owner ?? "").slice(0, 80),
    label: String(n.label ?? "").slice(0, 80),
    folders: Array.isArray(n.folders) ? n.folders.map((x) => String(x).slice(0, 120)).slice(0, 200) : [],
    self: n.self === true,
    periodDays: Number(n.periodDays) || 0,
    threshold: Number(n.threshold) || 0,
    total: Number(n.total) || 0,
  };
}

// ---------------------------------------------------------------- invites

/**
 * An invite link carries a one-time secret after the #, so the server never
 * sees it. The invited person's vault answers with its public key and a tag
 * made with that secret; the owner's vault checks the tag, so a key the server
 * made up is refused.
 */
export function newInviteSecret(): Uint8Array {
  return randomBytes(32);
}

export function formatLegacyInvite(origin: string, trusteeId: string, secret: Uint8Array): string {
  return `${origin.replace(/\/$/, "")}/vault/legacy#invite=${trusteeId}.${toBase64Url(secret)}`;
}

export function parseLegacyInvite(fragment: string): { trusteeId: string; secret: Uint8Array } {
  const m = /invite=([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})/.exec(fragment);
  if (!m) throw new Error("This invite link is incomplete. Ask for it again and copy all of it.");
  return { trusteeId: m[1], secret: fromBase64Url(m[2]) };
}

export async function inviteTag(secret: Uint8Array, trusteeId: string, publicKey: string): Promise<string> {
  const key = await hkdf(secret, "sigil:legacy-invite:tag");
  return toHex(hmac(sha256, key, utf8(`sigil-legacy-invite:v1:${trusteeId}:${publicKey}`)));
}

export async function verifyInviteTag(secret: Uint8Array, trusteeId: string, publicKey: string, tag: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tag) || !isBoxPublicKey(publicKey)) return false;
  return equalBytes(utf8(await inviteTag(secret, trusteeId, publicKey)), utf8(tag));
}

export interface LegacyInviteIntro {
  owner: string;
  label: string;
}

export async function sealInviteIntro(secret: Uint8Array, trusteeId: string, intro: LegacyInviteIntro): Promise<string> {
  const key = await importKey(await hkdf(secret, "sigil:legacy-invite:intro"));
  return encryptJson(key, { owner: intro.owner.trim().slice(0, 80), label: intro.label.trim().slice(0, 80) }, AAD.legacyIntro(trusteeId));
}

export async function openInviteIntro(secret: Uint8Array, trusteeId: string, envelope: string): Promise<LegacyInviteIntro> {
  const key = await importKey(await hkdf(secret, "sigil:legacy-invite:intro"));
  const v = await decryptJson<LegacyInviteIntro>(key, envelope, AAD.legacyIntro(trusteeId));
  return { owner: String(v.owner ?? "").slice(0, 80), label: String(v.label ?? "").slice(0, 80) };
}

// ---------------------------------------------------------------- the owner's record

export interface LegacyPersonPlan {
  id: string;
  label: string;
  /** Null while an invite has not been accepted and checked. */
  publicKey: string | null;
  /** The invite secret, base64url, for a person added by invite link. */
  invite: string | null;
  folderIds: string[];
  self: boolean;
}

export interface LegacyOwnerRecord {
  v: 1;
  /** The current legacy key, base64url. */
  key: string;
  epoch: number;
  owner: string;
  periodDays: number;
  threshold: number;
  includeModel: boolean;
  people: LegacyPersonPlan[];
}

export async function sealOwnerRecord(vaultKey: CryptoKey, planId: string, r: LegacyOwnerRecord): Promise<string> {
  return encryptJson(vaultKey, r, AAD.legacyOwner(planId));
}

export async function openOwnerRecord(vaultKey: CryptoKey, planId: string, envelope: string): Promise<LegacyOwnerRecord> {
  const r = await decryptJson<LegacyOwnerRecord>(vaultKey, envelope, AAD.legacyOwner(planId));
  return {
    v: 1,
    key: String(r.key ?? ""),
    epoch: Number(r.epoch) || 0,
    owner: String(r.owner ?? "").slice(0, 80),
    periodDays: Number(r.periodDays) || LEGACY_PERIODS[1],
    threshold: Number(r.threshold) || 1,
    includeModel: r.includeModel === true,
    people: (Array.isArray(r.people) ? r.people : []).map((p) => ({
      id: String(p.id),
      label: String(p.label ?? "").slice(0, 80),
      publicKey: isBoxPublicKey(p.publicKey) ? p.publicKey : null,
      invite: typeof p.invite === "string" ? p.invite : null,
      folderIds: Array.isArray(p.folderIds) ? p.folderIds.map(String) : [],
      self: p.self === true,
    })),
  };
}

// ---------------------------------------------------------------- making a plan

export interface LegacyPlanInput {
  planId: string;
  /** One more than the plan's last epoch. */
  epoch: number;
  owner: string;
  periodDays: number;
  threshold: number;
  includeModel: boolean;
  people: LegacyPersonPlan[];
  folders: Pick<OpenFolder, "id" | "name" | "raw">[];
  rules: SelfRules | null;
  model: ModelSettings | null;
  /** The owner's vault public key. */
  ownerKey: string | null;
}

export interface SealedPerson {
  id: string;
  /** Null for a person still waiting on an invite: they get nothing until the owner seals again. */
  publicKey: string | null;
  folderIds: string[];
  self: boolean;
  share: string | null;
  bundle: string | null;
  note: string | null;
}

export interface SealedPlan {
  epoch: number;
  threshold: number;
  periodDays: number;
  check: string;
  ownerBox: string;
  people: SealedPerson[];
}

export function cleanPeriod(days: number): number {
  if (!Number.isInteger(days) || days < MIN_LEGACY_DAYS || days > MAX_LEGACY_DAYS) throw new Error(`The period is ${MIN_LEGACY_DAYS} to ${MAX_LEGACY_DAYS} days.`);
  return days;
}

/**
 * Makes a fresh legacy key and everything sealed with it. Called for a new plan
 * and for every change, so a share from an earlier epoch no longer fits.
 */
export async function sealLegacyPlan(vaultKey: CryptoKey, input: LegacyPlanInput): Promise<SealedPlan> {
  const periodDays = cleanPeriod(input.periodDays);
  const ready = input.people.filter((p) => p.publicKey);
  if (ready.length === 0) throw new Error("Add at least one trusted person whose vault key is known.");
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > ready.length) {
    throw new Error(`The number of people needed must be between 1 and ${ready.length}, the trusted people who can receive a share now.`);
  }
  const ids = new Set(input.people.map((p) => p.id));
  if (ids.size !== input.people.length) throw new Error("A trusted person is listed twice.");
  const keys = new Set(ready.map((p) => p.publicKey));
  if (keys.size !== ready.length) throw new Error("Two trusted people have the same vault key.");
  const byFolder = new Map(input.folders.map((f) => [f.id, f]));
  for (const p of input.people) {
    if (p.folderIds.length === 0 && !p.self) throw new Error(`Choose at least one folder for ${p.label || "each trusted person"}.`);
    for (const id of p.folderIds) if (!byFolder.has(id)) throw new Error("A chosen folder no longer exists.");
  }

  const key = newLegacyKey();
  const check = legacyCheck(key, input.planId, input.epoch);
  const shares = await splitLegacyKey(key, ready.length, input.threshold);
  const trustees: LegacyTrustee[] = ready.map((p) => ({ id: p.id, label: p.label, publicKey: p.publicKey! }));
  const owner = input.owner.trim().slice(0, 80) || "The owner";

  const people: SealedPerson[] = [];
  for (const p of input.people) {
    if (!p.publicKey) {
      people.push({ id: p.id, publicKey: null, folderIds: p.folderIds, self: p.self, share: null, bundle: null, note: null });
      continue;
    }
    const i = ready.indexOf(p);
    const share = sealLegacyShare({ v: 1, planId: input.planId, epoch: input.epoch, trusteeId: p.id, share: toBase64Url(shares[i]), threshold: input.threshold, trustees, check, owner });
    const folders = p.folderIds.map((id) => ({ id, key: toBase64Url(byFolder.get(id)!.raw) }));
    const self = p.self ? { rules: { ...cleanRules(input.rules ?? {}), folderIds: [...p.folderIds] }, model: input.includeModel ? input.model : null } : null;
    const bundle = await sealLegacyBundle(key, p.publicKey, { v: 1, planId: input.planId, epoch: input.epoch, trusteeId: p.id, owner, ownerKey: input.ownerKey, folders, self });
    const note = sealLegacyNote(p.publicKey, p.id, {
      v: 1,
      planId: input.planId,
      epoch: input.epoch,
      owner,
      label: p.label,
      folders: p.folderIds.map((id) => byFolder.get(id)!.name),
      self: p.self,
      periodDays,
      threshold: input.threshold,
      total: ready.length,
    });
    people.push({ id: p.id, publicKey: p.publicKey, folderIds: p.folderIds, self: p.self, share, bundle, note });
  }

  const ownerBox = await sealOwnerRecord(vaultKey, input.planId, {
    v: 1,
    key: toBase64Url(key),
    epoch: input.epoch,
    owner,
    periodDays,
    threshold: input.threshold,
    includeModel: input.includeModel,
    people: input.people,
  });
  key.fill(0);
  return { epoch: input.epoch, threshold: input.threshold, periodDays, check, ownerBox, people };
}

// ---------------------------------------------------------------- after release

/** What a trusted person keeps in their own vault once a plan is released to them: the bundle, under their vault key. */
export interface LegacyKept {
  v: 1;
  planId: string;
  epoch: number;
  bundle: LegacyBundle;
}

export async function sealKept(vaultKey: CryptoKey, kept: LegacyKept): Promise<string> {
  return encryptJson(vaultKey, kept, AAD.legacyKept(kept.planId));
}

export async function openKept(vaultKey: CryptoKey, planId: string, envelope: string): Promise<LegacyKept> {
  const k = await decryptJson<LegacyKept>(vaultKey, envelope, AAD.legacyKept(planId));
  if (k.planId !== planId) throw new DecryptError("This record belongs to another plan.");
  return { v: 1, planId, epoch: Number(k.epoch), bundle: cleanBundle(k.bundle) };
}

export function newTrusteeId(): string {
  return randomId();
}
