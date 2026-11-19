// High-level vault operations. The browser and the connector both use these, so
// what one side encrypts the other can read, and tests can check the exact
// payloads that leave the device.

import { decryptBytes, decryptJson, encryptBytes, encryptJson, importKey, randomBytes, randomId } from "./crypto";
import { AAD, appKeys, formatAppKey, newAppSecret, tokenHash } from "./keys";

export type SourceKind = "note" | "chatgpt" | "claude";

export interface MemorySource {
  kind: SourceKind;
  /** Where it came from in the original export, for example a conversation id. */
  ref?: string;
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

export interface FolderMeta {
  name: string;
}

export type AppKind = "claude-desktop" | "cursor" | "chatgpt" | "other";

export interface AppMeta {
  name: string;
  kind: AppKind;
}

export interface OpenFolder {
  id: string;
  name: string;
  key: CryptoKey;
  raw: Uint8Array;
}

export const SNIPPET_LENGTH = 240;
export const MAX_TITLE = 300;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 48;

export function makeSnippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
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

export async function createFolder(vaultKey: CryptoKey, name: string, id = randomId()): Promise<{ stored: StoredFolder; folder: OpenFolder }> {
  const raw = randomBytes(32);
  const key = await importKey(raw);
  const clean = name.trim().slice(0, 120) || "Untitled";
  const stored: StoredFolder = {
    id,
    meta: await encryptJson(key, { name: clean } satisfies FolderMeta, AAD.folderMeta(id)),
    wrappedKey: await encryptBytes(vaultKey, raw, AAD.folderKey(id)),
  };
  return { stored, folder: { id, name: clean, key, raw } };
}

export async function openFolder(vaultKey: CryptoKey, stored: StoredFolder): Promise<OpenFolder> {
  const raw = await decryptBytes(vaultKey, stored.wrappedKey, AAD.folderKey(stored.id));
  return openFolderWithRaw(stored, raw);
}

export async function openFolderWithRaw(stored: Pick<StoredFolder, "id" | "meta">, raw: Uint8Array): Promise<OpenFolder> {
  const key = await importKey(raw);
  const meta = await decryptJson<FolderMeta>(key, stored.meta, AAD.folderMeta(stored.id));
  return { id: stored.id, name: meta.name, key, raw };
}

export async function renameFolder(folder: OpenFolder, name: string): Promise<string> {
  return encryptJson(folder.key, { name: name.trim().slice(0, 120) || "Untitled" } satisfies FolderMeta, AAD.folderMeta(folder.id));
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
