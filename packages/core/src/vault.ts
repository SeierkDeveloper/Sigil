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
export type SourceKind = "note" | "chatgpt" | "claude" | "app" | "web" | "profile";

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
};

export function sourceLabel(source: MemorySource): string {
  if (source.kind === "app" && source.ref) return `Suggested by ${source.ref}`;
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
}

export interface Memory extends MemoryHead {
  id: string;
  folderId: string;
  body: string;
}

export interface MemoryDraft {
  title: string;
  body: string;
  tags?: string[];
  source?: MemorySource;
  createdAt?: string;
  editedAt?: string;
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
}

export interface StoredApp {
  id: string;
  meta: string;
  secret: string;
  tokenHash: string;
  grants: StoredGrant[];
}

export type FolderKind = "profile";

export interface FolderMeta {
  name: string;
  /** "profile" marks the folder that holds the Self card. Encrypted like the name, so the server cannot tell. */
  kind?: FolderKind;
}

export type AppKind = "claude-desktop" | "cursor" | "chatgpt" | "other" | "extension" | "web";

export interface AppMeta {
  name: string;
  kind: AppKind;
}

export interface OpenFolder {
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

function folderMeta(name: string, kind?: FolderKind): FolderMeta {
  const clean = name.trim().slice(0, 120) || "Untitled";
  return kind ? { name: clean, kind } : { name: clean };
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
  return { id: stored.id, name: meta.name, key, raw, ...(meta.kind === "profile" ? { kind: meta.kind } : {}) };
}

/** The folder's name (and kind) encrypted under its own key. Renaming keeps the kind. */
export async function renameFolder(folder: Pick<OpenFolder, "id" | "key" | "kind">, name: string): Promise<string> {
  return encryptJson(folder.key, folderMeta(name, folder.kind), AAD.folderMeta(folder.id));
}

// ---------------------------------------------------------------- memories

export function buildMemory(draft: MemoryDraft, folderId: string, id = randomId(), now = new Date().toISOString()): Memory {
  const body = draft.body ?? "";
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
  };
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
  };
  return {
    id: memory.id,
    folderId: memory.folderId,
    head: await encryptJson(folder.key, head, AAD.memoryHead(memory.id)),
    body: await encryptJson(folder.key, { body: memory.body }, AAD.memoryBody(memory.id)),
  };
}

export async function decryptHead(folder: Pick<OpenFolder, "key">, stored: Pick<StoredMemory, "id" | "head">): Promise<MemoryHead> {
  return decryptJson<MemoryHead>(folder.key, stored.head, AAD.memoryHead(stored.id));
}

export async function decryptMemory(folder: Pick<OpenFolder, "key">, stored: StoredMemory): Promise<Memory> {
  const head = await decryptHead(folder, stored);
  if (!stored.body) throw new Error("This memory was sent without its body.");
  const { body } = await decryptJson<{ body: string }>(folder.key, stored.body, AAD.memoryBody(stored.id));
  return { ...head, id: stored.id, folderId: stored.folderId, body };
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
