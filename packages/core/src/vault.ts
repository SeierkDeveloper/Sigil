// High-level vault operations. The browser and the connector both use these, so
// what one side encrypts the other can read, and tests can check the exact
// payloads that leave the device.

import { decryptBytes, decryptJson, encryptBytes, encryptJson, importKey, randomBytes, randomId } from "./crypto";
import { AAD, appKeys, formatAppKey, newAppSecret, tokenHash } from "./keys";

/**
 * Where a memory came from: written in the vault, imported from an export,
 * suggested by a connected app and approved, saved from a web page with the
 * browser extension, or the Self card.
 */
export type SourceKind =
  | "note"
  | "chatgpt"
  | "claude"
  | "app"
  | "web"
  | "profile"
  | "brief"
  | "obsidian"
  | "apple-notes"
  | "gmail"
  | "calendar"
  | "github"
  | "notion"
  | "capture"
  | "agent"
  | "slack"
  | "drive"
  | "meeting"
  | "style"
  | "plan"
  | "pack"
  | "story"
  | "person"
  | "model";

export interface MemorySource {
  kind: SourceKind;
  /** Where it came from: a conversation id for imports, the app's name for suggestions, the address for web pages. */
  ref?: string;
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  note: "Written in Sigil",
  chatgpt: "Imported from ChatGPT",
  claude: "Imported from Claude",
  app: "Suggested by an app",
  web: "Saved from the web",
  profile: "Self card",
  brief: "Weekly brief",
  obsidian: "Imported from Obsidian",
  "apple-notes": "Imported from Apple Notes",
  gmail: "Imported from Gmail",
  calendar: "Imported from a calendar",
  github: "Imported from GitHub",
  notion: "Imported from Notion",
  capture: "Captured on a device",
  agent: "Remembered by an agent",
  slack: "Synced from Slack",
  drive: "Synced from Google Drive",
  meeting: "From a meeting transcript",
  style: "Learned from your edits",
  plan: "Planned by your AI self",
  pack: "From a knowledge pack",
  story: "A story in a shared memory",
  person: "A person in a shared memory",
  model: "A model of you",
};

export function sourceLabel(source: MemorySource): string {
  if (source.kind === "app" && source.ref) return `Suggested by ${source.ref}`;
  if (source.kind === "agent" && source.ref) return `Remembered by ${source.ref}`;
  if (source.kind === "pack" && source.ref) return `From the pack ${source.ref}`;
  return SOURCE_LABELS[source.kind] ?? "Saved";
}

export interface MemoryHead {
  title: string;
  tags: string[];
  source: MemorySource;
  /** First characters of the body, so a connected app can search without reading every body. */
  snippet: string;
  createdAt: string;
  editedAt: string;
  /** When set, the memory moves to Expired after this time and is deleted for real after the grace period. */
  expiresAt?: string;
  /** For a story in a shared memory: when it happened, as YYYY, YYYY-MM or YYYY-MM-DD. */
  when?: string;
  /** For a story in a shared memory: the ids of the people in it. */
  people?: string[];
  /** Set when the owner let a memory through that the immune system held back: the fingerprint of the body they approved (clearedHash). */
  cleared?: string;
}

/** A photo kept with a memory, inside its encrypted body. */
export interface MemoryImage {
  type: "image/jpeg" | "image/png" | "image/webp";
  /** The image bytes, base64. */
  data: string;
}

/** About 1.5 MB of image; the vault shrinks photos on the device before they are sealed. */
export const MAX_IMAGE_CHARS = 2_000_000;

export function cleanImage(value: unknown): MemoryImage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const type = v.type === "image/jpeg" || v.type === "image/png" || v.type === "image/webp" ? v.type : null;
  const data = typeof v.data === "string" && /^[A-Za-z0-9+/]+=*$/.test(v.data) && v.data.length <= MAX_IMAGE_CHARS ? v.data : null;
  return type && data ? { type, data } : undefined;
}

export interface Memory extends MemoryHead {
  id: string;
  folderId: string;
  body: string;
  image?: MemoryImage;
}

export interface MemoryDraft {
  title: string;
  body: string;
  tags?: string[];
  source?: MemorySource;
  createdAt?: string;
  editedAt?: string;
  expiresAt?: string | null;
  image?: MemoryImage | null;
  when?: string | null;
  people?: string[];
}

/** A folder or memory exactly as the server stores it: ids, envelopes and nothing readable. */
export interface StoredFolder {
  id: string;
  meta: string;
  wrappedKey: string;
}

export interface StoredMemory {
  id: string;
  folderId: string;
  head: string;
  body?: string;
}

export interface StoredGrant {
  folderId: string;
  wrappedKey: string;
  /** "write" lets an agent add, change and delete memories in the folder. Apps only read. */
  mode?: "read" | "write";
}

export interface StoredApp {
  id: string;
  meta: string;
  secret: string;
  tokenHash: string;
  grants: StoredGrant[];
}

export type FolderKind = "profile" | "agent";

/** What a protected folder holds. Encrypted with the name: the server only knows that a folder is protected. */
export type ProtectKind = "health" | "money" | "legal" | "other";

export const PROTECT_KINDS: readonly ProtectKind[] = ["health", "money", "legal", "other"];

/** Patterns masked on the device before a memory from this folder leaves the vault (to an app, a model or a public page). */
export type RedactRule = "card" | "iban" | "account" | "national_id" | "passport" | "phone" | "email";

export const REDACT_RULES: readonly RedactRule[] = ["card", "iban", "account", "national_id", "passport", "phone", "email"];

export interface FolderMeta {
  name: string;
  /** "profile" marks the folder that holds the Self card, "agent" an agent's own folder. Encrypted like the name, so the server cannot tell. */
  kind?: FolderKind;
  /** Set when the folder is protected: no app, agent, AI self or link reads it without a fresh yes from the owner. */
  protect?: ProtectKind;
  /** What is masked on the device before anything from this folder leaves the vault. */
  redact?: RedactRule[];
}

/** The settings a folder carries next to its name. */
export interface FolderGuard {
  protect?: ProtectKind;
  redact?: RedactRule[];
}

export function cleanGuard(value: unknown): FolderGuard {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const protect = PROTECT_KINDS.includes(v.protect as ProtectKind) ? (v.protect as ProtectKind) : undefined;
  const redact = Array.isArray(v.redact) ? REDACT_RULES.filter((r) => (v.redact as unknown[]).includes(r)) : [];
  return { ...(protect ? { protect } : {}), ...(redact.length ? { redact } : {}) };
}

export type AppKind = "claude-desktop" | "claude-code" | "cursor" | "chatgpt" | "other" | "extension" | "web";

export interface AppMeta {
  name: string;
  kind: AppKind;
}

export interface OpenFolder extends FolderGuard {
  id: string;
  name: string;
  key: CryptoKey;
  raw: Uint8Array;
  kind?: FolderKind;
}

export const SNIPPET_LENGTH = 240;
export const MAX_TITLE = 300;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 48;

export function makeSnippet(body: string): string {
  const flat = body
    // "### You" speaker headings from imports read better as "You:".
    .replace(/^#{1,6}[ \t]+(You|ChatGPT|Claude)[ \t]*$/gm, "$1:")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^```.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : flat;
}

export function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    const t = tag.trim().toLowerCase().replace(/\s+/g, "-").slice(0, MAX_TAG_LENGTH);
    if (t) seen.add(t);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

export async function vaultCryptoKey(vaultKey: Uint8Array): Promise<CryptoKey> {
  return importKey(vaultKey);
}

// ---------------------------------------------------------------- folders

function folderMeta(name: string, kind?: FolderKind, guard: FolderGuard = {}): FolderMeta {
  const clean = name.trim().slice(0, 120) || "Untitled";
  return { name: clean, ...(kind ? { kind } : {}), ...cleanGuard(guard) };
}

export async function createFolder(
  vaultKey: CryptoKey,
  name: string,
  id = randomId(),
  kind?: FolderKind,
): Promise<{ stored: StoredFolder; folder: OpenFolder }> {
  const raw = randomBytes(32);
  const key = await importKey(raw);
  const meta = folderMeta(name, kind);
  const stored: StoredFolder = {
    id,
    meta: await encryptJson(key, meta, AAD.folderMeta(id)),
    wrappedKey: await encryptBytes(vaultKey, raw, AAD.folderKey(id)),
  };
  return { stored, folder: { id, name: meta.name, key, raw, ...(kind ? { kind } : {}) } };
}

export async function openFolder(vaultKey: CryptoKey, stored: StoredFolder): Promise<OpenFolder> {
  const raw = await decryptBytes(vaultKey, stored.wrappedKey, AAD.folderKey(stored.id));
  return openFolderWithRaw(stored, raw);
}

export async function openFolderWithRaw(stored: Pick<StoredFolder, "id" | "meta">, raw: Uint8Array): Promise<OpenFolder> {
  const key = await importKey(raw);
  const meta = await decryptJson<FolderMeta>(key, stored.meta, AAD.folderMeta(stored.id));
  return { id: stored.id, name: meta.name, key, raw, ...(meta.kind === "profile" || meta.kind === "agent" ? { kind: meta.kind } : {}), ...cleanGuard(meta) };
}

/** The folder's name (and kind, protection and redaction) encrypted under its own key. Renaming keeps the rest. */
export async function renameFolder(folder: Pick<OpenFolder, "id" | "key" | "kind" | "protect" | "redact">, name: string): Promise<string> {
  return encryptJson(folder.key, folderMeta(name, folder.kind, folder), AAD.folderMeta(folder.id));
}

/** The folder's meta with new protection and redaction settings, its name and kind kept. */
export async function guardFolder(folder: Pick<OpenFolder, "id" | "key" | "kind" | "name">, guard: FolderGuard): Promise<string> {
  return encryptJson(folder.key, folderMeta(folder.name, folder.kind, guard), AAD.folderMeta(folder.id));
}

// ---------------------------------------------------------------- memories

export function buildMemory(draft: MemoryDraft, folderId: string, id = randomId(), now = new Date().toISOString()): Memory {
  const body = draft.body ?? "";
  const expiresAt = cleanExpiry(draft.expiresAt);
  const image = cleanImage(draft.image);
  const when = cleanWhen(draft.when);
  const people = cleanPeople(draft.people);
  return {
    id,
    folderId,
    title: (draft.title.trim() || "Untitled").slice(0, MAX_TITLE),
    body,
    tags: cleanTags(draft.tags),
    source: draft.source ?? { kind: "note" },
    snippet: makeSnippet(body),
    createdAt: draft.createdAt ?? now,
    editedAt: draft.editedAt ?? now,
    ...(expiresAt ? { expiresAt } : {}),
    ...(image ? { image } : {}),
    ...(when ? { when } : {}),
    ...(people.length ? { people } : {}),
  };
}

/** A year, a month or a day, as YYYY, YYYY-MM or YYYY-MM-DD; anything else is dropped. */
export function cleanWhen(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (!/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(v)) return undefined;
  return v;
}

export function cleanPeople(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x)))].slice(0, 50) : [];
}

/** A valid ISO time, or nothing. */
export function cleanExpiry(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export async function encryptMemory(folder: Pick<OpenFolder, "id" | "key">, memory: Memory): Promise<StoredMemory> {
  if (memory.folderId !== folder.id) throw new Error("Memory and folder do not match.");
  const head: MemoryHead = {
    title: memory.title,
    tags: memory.tags,
    source: memory.source,
    snippet: makeSnippet(memory.body),
    createdAt: memory.createdAt,
    editedAt: memory.editedAt,
    ...(memory.expiresAt ? { expiresAt: memory.expiresAt } : {}),
    ...(memory.when ? { when: memory.when } : {}),
    ...(memory.people?.length ? { people: memory.people } : {}),
    ...(memory.cleared ? { cleared: memory.cleared } : {}),
  };
  return {
    id: memory.id,
    folderId: memory.folderId,
    head: await encryptJson(folder.key, head, AAD.memoryHead(memory.id)),
    body: await encryptJson(folder.key, memory.image ? { body: memory.body, image: memory.image } : { body: memory.body }, AAD.memoryBody(memory.id)),
  };
}

export async function decryptHead(folder: Pick<OpenFolder, "key">, stored: Pick<StoredMemory, "id" | "head">): Promise<MemoryHead> {
  return decryptJson<MemoryHead>(folder.key, stored.head, AAD.memoryHead(stored.id));
}

export async function decryptMemory(folder: Pick<OpenFolder, "key">, stored: StoredMemory): Promise<Memory> {
  const head = await decryptHead(folder, stored);
  if (!stored.body) throw new Error("This memory was sent without its body.");
  const { body, image } = await decryptJson<{ body: string; image?: unknown }>(folder.key, stored.body, AAD.memoryBody(stored.id));
  const img = cleanImage(image);
  return { ...head, id: stored.id, folderId: stored.folderId, body, ...(img ? { image: img } : {}) };
}

// ---------------------------------------------------------------- apps

export interface NewApp {
  stored: StoredApp;
  /** Shown to the user once. The server never receives it. */
  appKey: string;
}

export async function wrapGrants(appId: string, secret: Uint8Array, folders: Pick<OpenFolder, "id" | "raw">[]): Promise<StoredGrant[]> {
  const { wrapKey } = await appKeys(secret);
  const key = await importKey(wrapKey);
  return Promise.all(
    folders.map(async (f) => ({ folderId: f.id, wrappedKey: await encryptBytes(key, f.raw, AAD.appFolderKey(appId, f.id)) })),
  );
}

export async function createApp(
  vaultKey: CryptoKey,
  meta: AppMeta,
  folders: Pick<OpenFolder, "id" | "raw">[],
  id = randomId(),
): Promise<NewApp> {
  const secret = newAppSecret();
  const { authToken } = await appKeys(secret);
  const clean: AppMeta = { name: meta.name.trim().slice(0, 80) || "AI app", kind: meta.kind };
  return {
    stored: {
      id,
      meta: await encryptJson(vaultKey, clean, AAD.appMeta(id)),
      secret: await encryptBytes(vaultKey, secret, AAD.appSecret(id)),
      tokenHash: tokenHash(authToken),
      grants: await wrapGrants(id, secret, folders),
    },
    appKey: formatAppKey(id, secret),
  };
}

export async function openAppMeta(vaultKey: CryptoKey, app: Pick<StoredApp, "id" | "meta">): Promise<AppMeta> {
  return decryptJson<AppMeta>(vaultKey, app.meta, AAD.appMeta(app.id));
}

export async function openAppSecret(vaultKey: CryptoKey, app: Pick<StoredApp, "id" | "secret">): Promise<Uint8Array> {
  return decryptBytes(vaultKey, app.secret, AAD.appSecret(app.id));
}

/** Used by the connector: turns a grant back into the folder key with the app's own secret. */
export async function openGrant(appId: string, wrapKey: CryptoKey, grant: StoredGrant): Promise<Uint8Array> {
  return decryptBytes(wrapKey, grant.wrappedKey, AAD.appFolderKey(appId, grant.folderId));
}

// ---------------------------------------------------------------- the Self card

/** The Self card lives alone in its own folder, so it can be granted to apps like any folder. */
export const PROFILE_FOLDER_NAME = "Self card";
export const PROFILE_TITLE = "Self card";

export interface ProfileSections {
  who: string;
  answers: string;
  projects: string;
}

export const PROFILE_HEADINGS: Record<keyof ProfileSections, string> = {
  who: "Who I am",
  answers: "How I like answers",
  projects: "Current projects",
};

export const PROFILE_LIMIT = 4000;

export function buildProfileBody(sections: ProfileSections): string {
  return (Object.keys(PROFILE_HEADINGS) as (keyof ProfileSections)[])
    .map((k) => `## ${PROFILE_HEADINGS[k]}\n\n${sections[k].trim().slice(0, PROFILE_LIMIT)}`)
    .join("\n\n");
}

/** Reads the three sections back out of a Self card body. Text outside them goes to "Who I am". */
export function parseProfileBody(body: string): ProfileSections {
  const out: ProfileSections = { who: "", answers: "", projects: "" };
  const byHeading = new Map(Object.entries(PROFILE_HEADINGS).map(([k, v]) => [v.toLowerCase(), k as keyof ProfileSections]));
  let current: keyof ProfileSections = "who";
  const lines: Record<keyof ProfileSections, string[]> = { who: [], answers: [], projects: [] };
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    const key = m ? byHeading.get(m[1].toLowerCase()) : undefined;
    if (key) {
      current = key;
      continue;
    }
    lines[current].push(line);
  }
  for (const k of Object.keys(out) as (keyof ProfileSections)[]) out[k] = lines[k].join("\n").trim();
  return out;
}

export function isProfileMemory(m: Pick<MemoryHead, "source">): boolean {
  return m.source.kind === "profile";
}
