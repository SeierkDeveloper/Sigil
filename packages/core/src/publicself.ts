// A public AI self: a page at /@<handle> where anyone can ask the owner's AI
// self, answered only from folders the owner made public.
//
// Two copies of a public folder exist. The vault keeps its own, encrypted like
// every folder. The owner's device also publishes a plain public copy of what
// is in those folders (masked with each folder's redaction rules), which is
// all the public AI self ever answers from and what its sources point to. No
// other folder is ever part of it, and the server never needs the vault key.
//
// The questions travel like those of an ask link (relay.ts): the visitor's
// browser makes a key pair, derives a conversation key with the public self's
// published key, and seals the question; the owner's open vault (or connector)
// opens it, answers with the owner's own model key, and seals the answer back.
// Because the page is public, its key comes from the server, not from a link
// fragment: a server that swapped the key could read a visitor's question.
// Nothing private is at stake there, since everything it can answer from is
// published.

import { decryptJson, encryptJson, importKey } from "./crypto";
import { AAD, appSelfKey, sha256Hex } from "./keys";
import type { ModelSettings } from "./model";
import { redactMemory } from "./protect";
import type { Memory, OpenFolder } from "./vault";
import { cleanRules, isLive, type SelfMemory, type SelfRules } from "./self";

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])?$/;
export const RESERVED_HANDLES = new Set(["admin", "api", "sigil", "vault", "ask", "docs", "spec", "help", "support", "root", "public", "status", "about"]);

export function cleanHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function isHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value) && value.length >= 3 && !RESERVED_HANDLES.has(value);
}

export interface PublicItem {
  id: string;
  title: string;
  body: string;
  tags: string[];
  editedAt: string;
}

export const PUBLIC_ITEM_CHARS = 20_000;
export const PUBLIC_MAX_ITEMS = 2000;

/**
 * The public copy of the folders made public: live memories only, the Self card
 * and briefs left out, each masked with its folder's redaction rules, shortened
 * to a public size.
 */
export function publicCopy(memories: Memory[], folders: Pick<OpenFolder, "id" | "redact" | "protect">[], publicIds: string[], now = Date.now()): PublicItem[] {
  const allowed = new Map(folders.filter((f) => publicIds.includes(f.id) && !f.protect).map((f) => [f.id, f]));
  return memories
    .filter((m) => allowed.has(m.folderId) && isLive(m, now) && m.source.kind !== "profile" && m.source.kind !== "model" && m.source.kind !== "brief")
    .slice(0, PUBLIC_MAX_ITEMS)
    .map((m) => {
      const r = redactMemory({ title: m.title, body: m.body, tags: m.tags }, allowed.get(m.folderId)!.redact);
      return { id: m.id, title: r.title.slice(0, 300), body: r.body.slice(0, PUBLIC_ITEM_CHARS), tags: r.tags ?? [], editedAt: m.editedAt };
    })
    .sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : a.id < b.id ? -1 : 1));
}

/** A fingerprint of the public copy, so the vault can tell when it needs publishing again. */
export function publicCopyHash(items: PublicItem[]): string {
  return sha256Hex(JSON.stringify(items.map((i) => [i.id, i.title, i.body, i.tags, i.editedAt])));
}

/** The public copy as the AI self reads it. */
export function publicMemories(items: PublicItem[]): SelfMemory[] {
  return items.map((i) => ({ id: i.id, folderId: "public", folder: "Public", title: i.title, tags: i.tags, body: i.body, editedAt: i.editedAt }));
}

/** What the public self's answer carries back to the visitor: the text, and which public items it came from. */
export interface PublicReply {
  v: 1;
  text: string;
  refused: string | null;
  sources: { id: string; title: string }[];
}

export interface PublicSettings {
  handle: string;
  name: string;
  greeting: string;
  /** Questions one visitor may ask in an hour. */
  perVisitorHour: number;
  /** Show answered questions on the page, unless hidden by the owner. */
  showAnswers: boolean;
  enabled: boolean;
}

export const PUBLIC_MAX_PER_VISITOR = 60;

/** What only the owner's device (and a connector the owner picks) holds: the public self's private key, its rules and which folders are public. */
export interface PublicSecret {
  v: 1;
  /** The X25519 private key, base64url. */
  secret: string;
  rules: SelfRules;
  /** The folders whose public copy it answers from. */
  folderIds: string[];
  /** For a connector only: the owner's model key and the vault public key, so it can answer and seal the log note. */
  model?: ModelSettings;
  boxPublic?: string;
}

export function cleanPublicSecret(v: unknown): PublicSecret | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.secret !== "string") return null;
  return {
    v: 1,
    secret: o.secret,
    // It answers from the public copy only, which the model sees as one folder.
    rules: { ...cleanRules(o.rules), folderIds: ["public"] },
    folderIds: Array.isArray(o.folderIds) ? o.folderIds.map(String).slice(0, 200) : [],
    ...(o.model && typeof o.model === "object" ? { model: o.model as ModelSettings } : {}),
    ...(typeof o.boxPublic === "string" ? { boxPublic: o.boxPublic } : {}),
  };
}

export async function sealPublicSecret(vaultKey: CryptoKey, selfId: string, s: PublicSecret): Promise<string> {
  return encryptJson(vaultKey, s, AAD.publicOwner(selfId));
}

export async function openPublicSecret(vaultKey: CryptoKey, selfId: string, envelope: string): Promise<PublicSecret | null> {
  return cleanPublicSecret(await decryptJson(vaultKey, envelope, AAD.publicOwner(selfId)));
}

export async function sealPublicForApp(appSecret: Uint8Array, appId: string, selfId: string, s: PublicSecret): Promise<string> {
  return encryptJson(await importKey(await appSelfKey(appSecret)), s, AAD.publicApp(appId, selfId));
}

export async function openPublicForApp(appSecret: Uint8Array, appId: string, selfId: string, envelope: string): Promise<PublicSecret | null> {
  return cleanPublicSecret(await decryptJson(await importKey(await appSelfKey(appSecret)), envelope, AAD.publicApp(appId, selfId)));
}
