// Knowledge packs: a public folder turned into a pack with a title, a
// description and a version, signed by the publisher's vault signing key.
// Other vaults follow a pack; each new version reaches them the next time they
// open, is checked against the publisher key they pinned when they first
// followed, and replaces the copy in their pack folder. A follower's AI self or
// agents read it like any other folder, if the follower allows it.
//
//   hash       hex32(SHA-256("sigil-knowledge-pack-v1" \n canonical JSON of the body))
//   signature  Ed25519 by the publisher's signing key over the same bytes
//
// A pack is public: its text is stored and served in the clear, like the public
// AI self's copy. The list of packs a vault follows is kept in its encrypted
// settings; the server sees a pack being fetched and the follower's own log
// line when it takes a version in. Packs are free.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "./crypto";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import { canonicalJson, isSigningKey, signingFingerprint, type CertificateCheck, type SigningKey } from "./life";
import { hex32 } from "./merkle";

export const PACK_FORMAT = "sigil-knowledge-pack";
export const PACK_MAX_ITEMS = 500;
export const PACK_MAX_BYTES = 2_000_000;

export interface PackItem {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export interface PackBody {
  id: string;
  title: string;
  description: string;
  version: number;
  publisher: { name: string; signingKey: string };
  /** The hash of the version before this one, or null for the first. */
  previous: string | null;
  items: PackItem[];
  origin: string;
  publishedAt: string;
}

export interface KnowledgePack {
  format: typeof PACK_FORMAT;
  version: 1;
  body: PackBody;
  hash: string;
  signature: string;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const one = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanPackBody(value: Partial<PackBody>): PackBody {
  if (!ID.test(String(value.id ?? ""))) throw new Error("A pack needs an id.");
  const title = one(value.title, 120);
  if (!title) throw new Error("Give the pack a title.");
  const version = Number(value.version ?? 1);
  if (!Number.isInteger(version) || version < 1 || version > 100_000) throw new Error("The version is a whole number from 1.");
  const items = (Array.isArray(value.items) ? value.items : []).map((i) => ({
    id: String(i?.id ?? ""),
    title: one(i?.title, 300) || "Untitled",
    body: String(i?.body ?? "").slice(0, 20_000),
    tags: (Array.isArray(i?.tags) ? i.tags : []).map((t) => one(t, 48)).filter(Boolean).slice(0, 32),
  }));
  if (items.length === 0) throw new Error("The folder has nothing to publish.");
  if (items.length > PACK_MAX_ITEMS) throw new Error(`A pack holds up to ${PACK_MAX_ITEMS} memories.`);
  if (items.some((i) => !ID.test(i.id))) throw new Error("A memory in the pack has no valid id.");
  const previous = value.previous ?? null;
  if (previous !== null && !/^0x[0-9a-f]{64}$/.test(previous)) throw new Error("The earlier version's hash is not valid.");
  if ((previous === null) !== (version === 1)) throw new Error("Every version after the first names the one before it.");
  const signingKey = String(value.publisher?.signingKey ?? "");
  if (!isSigningKey(signingKey)) throw new Error("The pack has no valid publisher key.");
  return {
    id: String(value.id),
    title,
    description: String(value.description ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 2000),
    version,
    publisher: { name: one(value.publisher?.name, 80), signingKey },
    previous,
    items,
    origin: String(value.origin ?? "").replace(/\/$/, ""),
    publishedAt: typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt)) ? value.publishedAt : new Date().toISOString(),
  };
}

function packMessage(body: PackBody): Uint8Array {
  return utf8(`${PACK_FORMAT}-v1\n${canonicalJson(body)}`);
}

export function packHash(body: PackBody): string {
  return hex32(sha256(packMessage(body)));
}

export function signPack(key: SigningKey, input: Omit<PackBody, "publisher"> & { publisher: { name: string } }): KnowledgePack {
  const body = cleanPackBody({ ...input, publisher: { name: input.publisher.name, signingKey: key.publicKey } });
  const text = canonicalJson(body);
  if (text.length > PACK_MAX_BYTES) throw new Error("The pack is too large. Publish a smaller folder.");
  return { format: PACK_FORMAT, version: 1, body, hash: packHash(body), signature: toBase64Url(ed25519.sign(packMessage(body), key.seed)) };
}

export function parsePack(text: string): KnowledgePack {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a pack: it is not valid JSON.");
  }
  const p = v as KnowledgePack;
  if (!p || p.format !== PACK_FORMAT || p.version !== 1 || !p.body || typeof p.signature !== "string") throw new Error("This is not a Sigil knowledge pack.");
  return p;
}

export interface PackResult {
  ok: boolean;
  checks: CertificateCheck[];
}

/**
 * Checks a pack: its body and hash, the publisher's signature and, for a
 * follower, that the publisher is the one it pinned and that the version
 * follows the one it holds.
 */
export function verifyPack(p: KnowledgePack, opts: { pinnedKey?: string; after?: { version: number; hash: string }; packId?: string } = {}): PackResult {
  const checks: CertificateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let clean: PackBody | null = null;
  try {
    clean = cleanPackBody(p.body);
  } catch (err) {
    add("body", false, (err as Error).message);
  }
  const same = !!clean && p.format === PACK_FORMAT && p.version === 1 && canonicalJson(clean) === canonicalJson(p.body) && packHash(clean) === p.hash;
  if (clean) add("body", same, same ? `Version ${clean.version}, ${clean.items.length} ${clean.items.length === 1 ? "memory" : "memories"}.` : "The pack was changed after it was signed.");
  let sigOk = false;
  try {
    sigOk = !!clean && ed25519.verify(fromBase64Url(p.signature), packMessage(p.body), fromBase64Url(p.body.publisher.signingKey));
  } catch {
    sigOk = false;
  }
  add("signature", sigOk, sigOk ? `Signed by the publisher's vault key ${signingFingerprint(p.body.publisher.signingKey)}.` : "The signature does not hold.");
  if (opts.pinnedKey) {
    const ok = p.body?.publisher?.signingKey === opts.pinnedKey;
    add("publisher", ok, ok ? "From the same publisher you followed." : "This version was signed by another key than the publisher you followed.");
  }
  if (opts.packId !== undefined) {
    const ok = p.body?.id === opts.packId;
    add("id", ok, ok ? "The pack you followed." : "This is another pack than the one you followed.");
  }
  if (opts.after) {
    const ok = !!clean && clean.version === opts.after.version + 1 && clean.previous === opts.after.hash;
    const newer = !!clean && clean.version > opts.after.version;
    add("order", ok || (newer && clean!.previous !== null), ok ? `Follows version ${opts.after.version}.` : newer ? `Version ${clean!.version}; some versions in between were skipped.` : "This is not a newer version.");
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** The id a followed pack's memory gets in the follower's folder: the same on every device, unreadable to the server. */
export async function packMemoryId(folderRaw: Uint8Array, packId: string, itemId: string): Promise<string> {
  const key = await hkdf(folderRaw, "sigil:pack-id");
  return toBase64Url(hmac(sha256, key, utf8(`${packId}\n${itemId}`))).slice(0, 22);
}

/** What a vault keeps about a pack it follows, in its encrypted settings. */
export interface FollowedPack {
  id: string;
  origin: string;
  folderId: string;
  publisherKey: string;
  title: string;
  version: number;
  hash: string;
  followedAt: string;
  updatedAt: string;
}

export function cleanFollows(value: unknown): FollowedPack[] {
  return (Array.isArray(value) ? value : [])
    .map((v) => (v ?? {}) as Record<string, unknown>)
    .filter((v) => ID.test(String(v.id)) && ID.test(String(v.folderId)) && isSigningKey(v.publisherKey))
    .map((v) => ({
      id: String(v.id),
      origin: String(v.origin ?? ""),
      folderId: String(v.folderId),
      publisherKey: String(v.publisherKey),
      title: one(v.title, 120),
      version: Number(v.version) || 0,
      hash: String(v.hash ?? ""),
      followedAt: String(v.followedAt ?? ""),
      updatedAt: String(v.updatedAt ?? ""),
    }))
    .slice(0, 200);
}

export function packUrl(origin: string, packId: string): string {
  return `${origin.replace(/\/$/, "")}/p/${packId}`;
}
