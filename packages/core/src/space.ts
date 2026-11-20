// Team spaces: one shared memory that several vaults and agents read and write.
//
// A space has its own key, like a folder. Every member, the vault that made it
// included, receives that key sealed to its own public key: a vault's box key
// for a person, the agent's derived key for an agent (agent.ts). This is the
// sharing handshake (share.ts) extended with roles:
//
//   read    open the space and read its memories
//   write   also add, change and delete memories
//   admin   also add and remove members
//
// Each member entry carries a tag, a MAC under a key derived from the space key
// over the member's id, kind, public key and role. Only holders of the space
// key can make one, so a server that slipped in a member of its own would be
// caught by the next admin before any key is sealed to it.
//
// Removing a member rotates the space key on an admin's device: a new key,
// every memory encrypted again, the key sealed again to each member who stays,
// and every tag made again. The removed member keeps only the old key.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBoxPublicKey, isBoxPublicKey, openSealedJson, sealJson, type BoxKeyPair } from "./box";
import { DecryptError, decryptJson, encryptJson, hkdf, importKey, randomBytes } from "./crypto";
import { equalBytes, fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";
import { AAD } from "./keys";
import { encryptMemory, type Memory, type OpenFolder, type StoredMemory } from "./vault";

export type SpaceRole = "read" | "write" | "admin";
export type SpaceMemberKind = "vault" | "agent";

export const SPACE_ROLES: readonly SpaceRole[] = ["read", "write", "admin"];
export const MAX_SPACE_MEMBERS = 50;

export function isSpaceRole(v: unknown): v is SpaceRole {
  return v === "read" || v === "write" || v === "admin";
}

export function canWrite(role: SpaceRole): boolean {
  return role === "write" || role === "admin";
}

export interface SpaceMember {
  id: string;
  kind: SpaceMemberKind;
  publicKey: string;
  role: SpaceRole;
}

/** A team space, or a shared memory: a family's or a team's history. The node keeps the kind in the clear too, to keep what others wrote. */
export type SpaceKind = "team" | "family" | "history";
export const SPACE_KINDS: readonly SpaceKind[] = ["team", "family", "history"];

export function isSpaceKind(v: unknown): v is SpaceKind {
  return v === "team" || v === "family" || v === "history";
}

export interface SpaceMeta {
  name: string;
  kind?: SpaceKind;
  /** A line about the space, for a shared memory. */
  about?: string;
}

export function newSpaceKey(): Uint8Array {
  return randomBytes(32);
}

/** A space opened with its key: shaped like a folder, so memories in it use the same encryption. */
export type OpenSpace = OpenFolder;

export async function encryptSpaceMeta(raw: Uint8Array, spaceId: string, meta: SpaceMeta): Promise<string> {
  const kind = isSpaceKind(meta.kind) && meta.kind !== "team" ? meta.kind : undefined;
  const about = meta.about?.trim().slice(0, 400);
  return encryptJson(await importKey(raw), { name: meta.name.trim().slice(0, 120) || "Team space", ...(kind ? { kind } : {}), ...(about ? { about } : {}) }, AAD.spaceMeta(spaceId));
}

/** The whole meta of a space: its name, kind and the line about it. */
export async function openSpaceMeta(spaceId: string, metaEnvelope: string, raw: Uint8Array): Promise<Required<SpaceMeta>> {
  const meta = await decryptJson<SpaceMeta>(await importKey(raw), metaEnvelope, AAD.spaceMeta(spaceId));
  return { name: String(meta.name ?? "Team space").slice(0, 120), kind: isSpaceKind(meta.kind) ? meta.kind : "team", about: String(meta.about ?? "").slice(0, 400) };
}

export async function openSpaceWithRaw(spaceId: string, metaEnvelope: string, raw: Uint8Array): Promise<OpenSpace> {
  const key = await importKey(raw);
  const meta = await decryptJson<SpaceMeta>(key, metaEnvelope, AAD.spaceMeta(spaceId));
  return { id: spaceId, name: String(meta.name ?? "Team space").slice(0, 120), key, raw };
}

// ---------------------------------------------------------------- the key, sealed to each member

export interface SpaceKeyPayload {
  v: 1;
  spaceId: string;
  epoch: number;
  key: string;
}

export function spaceKeyContext(spaceId: string, memberId: string): string {
  return `space-key:${spaceId}:${memberId}`;
}

export function sealSpaceKey(member: Pick<SpaceMember, "id" | "publicKey">, spaceId: string, epoch: number, raw: Uint8Array): string {
  const p: SpaceKeyPayload = { v: 1, spaceId, epoch, key: toBase64Url(raw) };
  return sealJson(decodeBoxPublicKey(member.publicKey), p, spaceKeyContext(spaceId, member.id));
}

export function openSpaceKey(pair: BoxKeyPair, spaceId: string, memberId: string, sealed: string): { raw: Uint8Array; epoch: number } {
  const p = openSealedJson<SpaceKeyPayload>(pair, sealed, spaceKeyContext(spaceId, memberId));
  const raw = fromBase64Url(String(p.key ?? ""));
  if (p.spaceId !== spaceId || raw.length !== 32) throw new DecryptError("This space key is damaged.");
  return { raw, epoch: Number(p.epoch) || 0 };
}

// ---------------------------------------------------------------- member tags

async function tagKey(raw: Uint8Array): Promise<Uint8Array> {
  return hkdf(raw, "sigil:space:member-tag");
}

export async function memberTag(raw: Uint8Array, spaceId: string, m: SpaceMember): Promise<string> {
  return toHex(hmac(sha256, await tagKey(raw), utf8(`sigil-space-member:v1:${spaceId}:${m.id}:${m.kind}:${m.publicKey}:${m.role}`)));
}

export async function verifyMemberTag(raw: Uint8Array, spaceId: string, m: SpaceMember, tag: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tag) || !isBoxPublicKey(m.publicKey) || !isSpaceRole(m.role)) return false;
  return equalBytes(utf8(await memberTag(raw, spaceId, m)), utf8(tag));
}

/** Members whose tag does not check out. An admin refuses to seal anything while this list is not empty. */
export async function untrustedMembers(raw: Uint8Array, spaceId: string, members: (SpaceMember & { tag: string })[]): Promise<string[]> {
  const bad: string[] = [];
  for (const m of members) if (!(await verifyMemberTag(raw, spaceId, m, m.tag))) bad.push(m.id);
  return bad;
}

// ---------------------------------------------------------------- adding and rotating

export interface SealedMember {
  id: string;
  sealedKey: string;
  tag: string;
}

export async function sealForMember(raw: Uint8Array, spaceId: string, epoch: number, m: SpaceMember): Promise<SealedMember> {
  return { id: m.id, sealedKey: sealSpaceKey(m, spaceId, epoch, raw), tag: await memberTag(raw, spaceId, m) };
}

export interface NewSpace {
  raw: Uint8Array;
  meta: string;
  creator: SealedMember;
}

export async function createSpace(spaceId: string, name: string, creator: SpaceMember, more: Omit<SpaceMeta, "name"> = {}): Promise<NewSpace> {
  if (creator.role !== "admin" || creator.kind !== "vault") throw new Error("A space is made by a vault, as its first admin.");
  const raw = newSpaceKey();
  return { raw, meta: await encryptSpaceMeta(raw, spaceId, { name, ...more }), creator: await sealForMember(raw, spaceId, 1, creator) };
}

export interface SpaceRotation {
  raw: Uint8Array;
  epoch: number;
  meta: string;
  memories: StoredMemory[];
  members: SealedMember[];
}

/**
 * Gives a space a new key on an admin's device: every memory encrypted again,
 * and the key sealed and tagged again for each member who stays.
 */
export async function rotateSpace(space: OpenSpace, epoch: number, memories: Memory[], stay: SpaceMember[], meta: SpaceMeta = { name: space.name }): Promise<SpaceRotation> {
  const raw = newSpaceKey();
  const next: OpenSpace = { ...space, raw, key: await importKey(raw) };
  const stored: StoredMemory[] = [];
  for (const m of memories) {
    if (m.folderId !== space.id) throw new Error("A memory from elsewhere was passed to the rotation.");
    stored.push(await encryptMemory(next, m));
  }
  const members: SealedMember[] = [];
  for (const m of stay) members.push(await sealForMember(raw, space.id, epoch, m));
  return { raw, epoch, meta: await encryptSpaceMeta(raw, space.id, meta), memories: stored, members };
}
