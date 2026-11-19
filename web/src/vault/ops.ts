// Everything the vault page does with keys and data, without any UI. All
// encryption and decryption happens here, on the device; the Api only ever
// carries ids, envelopes and hashes.

import {
  buildMemory,
  createApp as encryptApp,
  createFolder as encryptFolder,
  decryptMemory,
  encryptMemory,
  fromHex32,
  hex32,
  newRecoveryPhrase,
  newVaultKey,
  openAppMeta,
  openAppSecret,
  openFolder,
  passkeyKek,
  phraseKeys,
  readEntryLeaf,
  renameFolder as encryptFolderName,
  unwrapVaultKey,
  vaultCryptoKey,
  verifyProof,
  walletKeys,
  wrapGrants,
  wrapVaultKey,
  type AppKind,
  type AppMeta,
  type KeyslotKind,
  type Memory,
  type MemoryDraft,
  type OpenFolder,
  type ReadKind,
  type StoredFolder,
  type StoredMemory,
} from "@sigil/core";
import type { Api } from "./api";

// ---------------------------------------------------------------- types

export interface Unlocked {
  raw: Uint8Array;
  key: CryptoKey;
}

export interface KeyslotView {
  id: string;
  kind: KeyslotKind;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AppView {
  id: string;
  name: string;
  kind: AppKind;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  folderIds: string[];
  meta: string;
  secret: string;
}

export interface VaultData {
  folders: OpenFolder[];
  memories: Memory[];
  apps: AppView[];
  keyslots: KeyslotView[];
  usage: { memories: number; bytes: number };
  /** Items that did not decrypt. Should always be zero; shown if not. */
  unreadable: number;
}

export interface LogEntryView {
  id: string;
  appId: string;
  kind: ReadKind;
  memoryId: string | null;
  count: number;
  at: string;
  salt: string;
  leaf: string;
  hour: number;
  sealed: boolean;
}

export interface LogData {
  periodSeconds: number;
  mode: "local" | "anchored";
  entries: LogEntryView[];
}

interface ServerVault {
  folders: (StoredFolder & { createdAt: string })[];
  memories: (StoredMemory & { updatedAt: string })[];
  apps: { id: string; meta: string; secret: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null; grants: { folderId: string }[] }[];
  keyslots: KeyslotView[];
  usage: { memories: number; bytes: number };
}

export const DEFAULT_FOLDER = "Notes";

async function unlockedFrom(raw: Uint8Array): Promise<Unlocked> {
  return { raw, key: await vaultCryptoKey(raw) };
}

// ---------------------------------------------------------------- creating a vault

export interface NewVault {
  vault: Unlocked;
  phrase: string;
}

async function vaultInit(kek: Uint8Array, kind: KeyslotKind) {
  const raw = newVaultKey();
  const vault = await unlockedFrom(raw);
  const phrase = newRecoveryPhrase();
  const pk = await phraseKeys(phrase);
  const { stored: folder } = await encryptFolder(vault.key, DEFAULT_FOLDER);
  return {
    vault,
    phrase,
    body: {
      wrappedKey: await wrapVaultKey(kek, raw, kind),
      recovery: { lookupId: pk.lookupId, authToken: pk.authToken, wrappedKey: await wrapVaultKey(pk.kek, raw, "phrase") },
      folder,
    },
  };
}

export class WalletSignatureUnstable extends Error {
  constructor() {
    super("This wallet gives a different signature each time, so it cannot hold a vault key. Use a passkey or another wallet.");
    this.name = "WalletSignatureUnstable";
  }
}

/** Two signatures of the same message must match, or the wallet could never open the vault again. */
export function assertStableSignature(first: string, second: string): void {
  if (first.toLowerCase() !== second.toLowerCase()) throw new WalletSignatureUnstable();
}

export async function signUpWithWallet(api: Api, address: string, signature: string): Promise<NewVault> {
  const wk = await walletKeys(address, signature);
  const init = await vaultInit(wk.kek, "wallet");
  await api.post("auth/wallet/register", { address, authToken: wk.authToken, ...init.body });
  return { vault: init.vault, phrase: init.phrase };
}

export async function signInWithWallet(api: Api, address: string, signature: string): Promise<Unlocked> {
  const wk = await walletKeys(address, signature);
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/wallet/login", { address, authToken: wk.authToken });
  return unlockedFrom(await unwrapVaultKey(wk.kek, r.keyslot.wrappedKey, "wallet"));
}

export async function signInWithPhrase(api: Api, phrase: string): Promise<Unlocked> {
  const pk = await phraseKeys(phrase);
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/phrase/login", { lookupId: pk.lookupId, authToken: pk.authToken });
  return unlockedFrom(await unwrapVaultKey(pk.kek, r.keyslot.wrappedKey, "phrase"));
}

// ---------------------------------------------------------------- passkeys

/** The browser side of WebAuthn, injected so this module stays testable. */
export interface PasskeyDriver {
  create(options: unknown): Promise<{ response: Record<string, unknown>; credentialId: string; prf: Uint8Array | null }>;
  /** Asks the passkey for its PRF output. With a credential id it targets that passkey only. */
  get(options: unknown): Promise<{ response: Record<string, unknown>; prf: Uint8Array | null }>;
  prf(credentialId: string): Promise<Uint8Array | null>;
}

export class PasskeyPrfUnsupported extends Error {
  constructor() {
    super(
      "This passkey cannot create an encryption key (it does not support the PRF extension). Use a passkey from a recent browser or phone, or sign in with a wallet.",
    );
    this.name = "PasskeyPrfUnsupported";
  }
}

export async function signUpWithPasskey(api: Api, driver: PasskeyDriver): Promise<NewVault> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>("auth/passkey/register/options");
  const created = await driver.create(options);
  const prf = created.prf ?? (await driver.prf(created.credentialId));
  if (!prf) throw new PasskeyPrfUnsupported();
  const init = await vaultInit(await passkeyKek(prf), "passkey");
  await api.post("auth/passkey/register", { challengeId, response: created.response, ...init.body });
  return { vault: init.vault, phrase: init.phrase };
}

export async function signInWithPasskey(api: Api, driver: PasskeyDriver): Promise<Unlocked> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>("auth/passkey/login/options");
  const got = await driver.get(options);
  if (!got.prf) throw new PasskeyPrfUnsupported();
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/passkey/login", { challengeId, response: got.response });
  return unlockedFrom(await unwrapVaultKey(await passkeyKek(got.prf), r.keyslot.wrappedKey, "passkey"));
}

// ---------------------------------------------------------------- more ways in

export async function addPasskey(api: Api, vault: Unlocked, driver: PasskeyDriver): Promise<KeyslotView[]> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>("keyslots/passkey/options");
  const created = await driver.create(options);
  const prf = created.prf ?? (await driver.prf(created.credentialId));
  if (!prf) throw new PasskeyPrfUnsupported();
  const wrappedKey = await wrapVaultKey(await passkeyKek(prf), vault.raw, "passkey");
  const r = await api.post<{ keyslots: KeyslotView[] }>("keyslots/passkey", { challengeId, response: created.response, wrappedKey });
  return r.keyslots;
}

export async function addWallet(api: Api, vault: Unlocked, address: string, signature: string): Promise<KeyslotView[]> {
  const wk = await walletKeys(address, signature);
  const wrappedKey = await wrapVaultKey(wk.kek, vault.raw, "wallet");
  const r = await api.post<{ keyslots: KeyslotView[] }>("keyslots/wallet", { address, authToken: wk.authToken, wrappedKey });
  return r.keyslots;
}

/** Makes a new recovery phrase. The old phrase stops working. */
export async function replaceRecoveryPhrase(api: Api, vault: Unlocked): Promise<string> {
  const phrase = newRecoveryPhrase();
  const pk = await phraseKeys(phrase);
  await api.post("keyslots/phrase", { lookupId: pk.lookupId, authToken: pk.authToken, wrappedKey: await wrapVaultKey(pk.kek, vault.raw, "phrase") });
  return phrase;
}

export async function removeKeyslot(api: Api, id: string): Promise<KeyslotView[]> {
  return (await api.del<{ keyslots: KeyslotView[] }>(`keyslots/${id}`)).keyslots;
}

// ---------------------------------------------------------------- loading

export async function loadVault(api: Api, vault: Unlocked): Promise<VaultData> {
  const data = await api.get<ServerVault>("vault");
  let unreadable = 0;
  const folders: OpenFolder[] = [];
  for (const f of data.folders) {
    try {
      folders.push(await openFolder(vault.key, f));
    } catch {
      unreadable++;
    }
  }
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memories: Memory[] = [];
  for (const m of data.memories) {
    const folder = byId.get(m.folderId);
    try {
      if (!folder) throw new Error("missing folder");
      memories.push(await decryptMemory(folder, m));
    } catch {
      unreadable++;
    }
  }
  memories.sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : 0));
  const apps: AppView[] = [];
  for (const a of data.apps) {
    let meta: AppMeta = { name: "Unreadable app", kind: "other" };
    try {
      meta = await openAppMeta(vault.key, a);
    } catch {
      unreadable++;
    }
    apps.push({
      id: a.id,
      name: meta.name,
      kind: meta.kind,
      createdAt: a.createdAt,
      revokedAt: a.revokedAt,
      lastUsedAt: a.lastUsedAt,
      folderIds: a.grants.map((g) => g.folderId),
      meta: a.meta,
      secret: a.secret,
    });
  }
  return { folders, memories, apps, keyslots: data.keyslots, usage: data.usage, unreadable };
}

// ---------------------------------------------------------------- folders

export async function addFolder(api: Api, vault: Unlocked, name: string): Promise<OpenFolder> {
  const { stored, folder } = await encryptFolder(vault.key, name);
  await api.post("folders", stored);
  return folder;
}

export async function renameFolder(api: Api, folder: OpenFolder, name: string): Promise<OpenFolder> {
  const meta = await encryptFolderName(folder, name);
  await api.patch(`folders/${folder.id}`, { meta });
  return { ...folder, name: name.trim().slice(0, 120) || "Untitled" };
}

export async function removeFolder(api: Api, folderId: string): Promise<void> {
  await api.del(`folders/${folderId}`);
}

export async function findOrCreateFolder(api: Api, vault: Unlocked, folders: OpenFolder[], name: string): Promise<{ folder: OpenFolder; created: boolean }> {
  const existing = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return { folder: existing, created: false };
  return { folder: await addFolder(api, vault, name), created: true };
}

// ---------------------------------------------------------------- memories

export async function saveMemory(api: Api, folder: OpenFolder, memory: Memory): Promise<Memory> {
  const stored = await encryptMemory(folder, memory);
  await api.put("memories", { memories: [stored] });
  return memory;
}

export async function createMemory(api: Api, folder: OpenFolder, draft: MemoryDraft): Promise<Memory> {
  return saveMemory(api, folder, buildMemory(draft, folder.id));
}

export async function updateMemory(api: Api, folders: OpenFolder[], memory: Memory, changes: Partial<Pick<Memory, "title" | "body" | "tags" | "folderId">>): Promise<Memory> {
  const next = buildMemory(
    {
      title: changes.title ?? memory.title,
      body: changes.body ?? memory.body,
      tags: changes.tags ?? memory.tags,
      source: memory.source,
      createdAt: memory.createdAt,
      editedAt: new Date().toISOString(),
    },
    changes.folderId ?? memory.folderId,
    memory.id,
  );
  const folder = folders.find((f) => f.id === next.folderId);
  if (!folder) throw new Error("That folder no longer exists.");
  // Moving to another folder re-encrypts the memory under that folder's key.
  return saveMemory(api, folder, next);
}

export async function deleteMemories(api: Api, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    deleted += (await api.post<{ deleted: number }>("memories/delete", { ids: ids.slice(i, i + 5000) })).deleted;
  }
  return deleted;
}

const BATCH_COUNT = 200;
const BATCH_BYTES = 8 * 1024 * 1024;

/** Encrypts and uploads drafts in batches. Calls onProgress after each batch. */
export async function importDrafts(
  api: Api,
  folder: OpenFolder,
  drafts: MemoryDraft[],
  onProgress?: (done: number, total: number) => void,
): Promise<Memory[]> {
  const saved: Memory[] = [];
  let batch: StoredMemory[] = [];
  let pending: Memory[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await api.put("memories", { memories: batch });
    saved.push(...pending);
    onProgress?.(saved.length, drafts.length);
    batch = [];
    pending = [];
    bytes = 0;
  };
  for (const draft of drafts) {
    const memory = buildMemory(draft, folder.id);
    const stored = await encryptMemory(folder, memory);
    const size = stored.head.length + (stored.body?.length ?? 0);
    if (batch.length >= BATCH_COUNT || (batch.length > 0 && bytes + size > BATCH_BYTES)) await flush();
    batch.push(stored);
    pending.push(memory);
    bytes += size;
  }
  await flush();
  return saved;
}

// ---------------------------------------------------------------- connected apps

export async function connectApp(api: Api, vault: Unlocked, meta: AppMeta, folders: OpenFolder[]): Promise<{ appKey: string; appId: string }> {
  const app = await encryptApp(vault.key, meta, folders);
  await api.post("apps", app.stored);
  return { appKey: app.appKey, appId: app.stored.id };
}

export async function setAppFolders(api: Api, vault: Unlocked, app: Pick<AppView, "id" | "secret">, folders: OpenFolder[]): Promise<void> {
  const secret = await openAppSecret(vault.key, app);
  await api.put(`apps/${app.id}/grants`, { grants: await wrapGrants(app.id, secret, folders) });
}

export async function revokeApp(api: Api, appId: string): Promise<void> {
  await api.post(`apps/${appId}/revoke`);
}

export async function removeApp(api: Api, appId: string): Promise<void> {
  await api.del(`apps/${appId}`);
}

// ---------------------------------------------------------------- read log and seals

export async function loadLog(api: Api, limit = 300): Promise<LogData> {
  return api.get<LogData>(`log?limit=${limit}`);
}

export type VerifyResult = { ok: true; hour: number; root: string; index: number } | { ok: false; reason: string };

/**
 * Checks one log entry against its hour's seal, on the device: recompute the
 * leaf from the entry's own fields, walk the proof up to the root, and compare
 * with the root the server publishes for that hour.
 */
export async function verifyEntry(api: Api, entry: LogEntryView): Promise<VerifyResult> {
  const leaf = hex32(readEntryLeaf(entry));
  if (leaf !== entry.leaf) return { ok: false, reason: "The entry does not match its own fingerprint." };
  let proof: { hour: number; root: string; leaf: string; index: number; proof: string[] };
  try {
    proof = await api.get(`log/${entry.id}/proof`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (proof.leaf !== leaf) return { ok: false, reason: "The server returned a different fingerprint." };
  const seals = await api.get<{ seals: { hour: number; root: string }[] }>("seals?limit=200");
  const published = seals.seals.find((s) => s.hour === proof.hour);
  if (published && published.root !== proof.root) return { ok: false, reason: "The proof does not match the published seal." };
  const ok = verifyProof(fromHex32(proof.root), fromHex32(leaf), proof.proof.map(fromHex32));
  return ok ? { ok: true, hour: proof.hour, root: proof.root, index: proof.index } : { ok: false, reason: "The proof does not lead to the seal." };
}

// ---------------------------------------------------------------- export and account

export interface VaultExport {
  format: "sigil-export";
  version: 1;
  exportedAt: string;
  folders: { id: string; name: string }[];
  memories: Omit<Memory, "snippet">[];
  apps: { id: string; name: string; kind: AppKind; createdAt: string; revokedAt: string | null; folders: string[] }[];
  readLog: Omit<LogEntryView, "salt" | "leaf" | "hour" | "sealed">[];
}

/** Everything in the vault, decrypted, as one JSON document. Built on the device. */
export function buildExport(data: VaultData, log: LogEntryView[]): VaultExport {
  const folderName = new Map(data.folders.map((f) => [f.id, f.name]));
  return {
    format: "sigil-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: data.folders.map((f) => ({ id: f.id, name: f.name })),
    memories: data.memories.map(({ snippet: _snippet, ...m }) => m),
    apps: data.apps.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      createdAt: a.createdAt,
      revokedAt: a.revokedAt,
      folders: a.folderIds.map((id) => folderName.get(id) ?? id),
    })),
    readLog: log.map(({ salt: _s, leaf: _l, hour: _h, sealed: _x, ...e }) => e),
  };
}

export async function deleteAccount(api: Api): Promise<void> {
  await api.del("account");
}

export async function signOut(api: Api): Promise<void> {
  await api.post("auth/logout");
}

