// Sharing a folder with another vault.
//
// The owner's device seals the folder key to the recipient's public key (taken
// from the vault code the recipient handed over, never from the server). The
// recipient's device opens it with its own box key and can then read the
// folder, read only. Revoking rotates the folder key on the owner's device: a
// new key, every memory in the folder encrypted again, and the new key wrapped
// for the vault, for every app that may read the folder and for every other
// share. The old key, which the recipient may still hold, opens nothing new.

import { openSealedJson, sealJson, decodeBoxPublicKey, type BoxKeyPair } from "./box";
import { decryptJson, encryptBytes, encryptJson, importKey, randomBytes } from "./crypto";
import { fromBase64Url, toBase64Url } from "./encoding";
import { AAD, appKeys } from "./keys";
import { encryptMemory, renameFolder, type Memory, type OpenFolder, type StoredGrant, type StoredMemory } from "./vault";

export interface SharePayload {
  v: 1;
  /** The folder key, base64url. */
  folderKey: string;
  /** The name the owner signs the share with. */
  from: string;
}

export interface ShareNote {
  /** What the owner calls the recipient. */
  label: string;
  /** The recipient's public key as the owner entered it, kept encrypted so the server cannot swap it. */
  recipient: string;
  /** The name the owner signed the share with, so a new key can be sealed with the same name. */
  from?: string;
}

export function shareContext(shareId: string, folderId: string): string {
  return `share:${shareId}:${folderId}`;
}

export function sealShare(recipientPublicKey: string, shareId: string, folderId: string, folderRaw: Uint8Array, from: string): string {
  const payload: SharePayload = { v: 1, folderKey: toBase64Url(folderRaw), from: from.trim().slice(0, 80) };
  return sealJson(decodeBoxPublicKey(recipientPublicKey), payload, shareContext(shareId, folderId));
}

export function openShare(pair: BoxKeyPair, share: { id: string; folderId: string; sealedKey: string }): { raw: Uint8Array; from: string } {
  const p = openSealedJson<SharePayload>(pair, share.sealedKey, shareContext(share.id, share.folderId));
  const raw = fromBase64Url(String(p.folderKey ?? ""));
  if (raw.length !== 32) throw new Error("A shared folder key has the wrong length.");
  return { raw, from: String(p.from ?? "").slice(0, 80) };
}

export async function encryptShareNote(vaultKey: CryptoKey, shareId: string, note: ShareNote): Promise<string> {
  const clean: ShareNote = { label: note.label.trim().slice(0, 80) || "Another vault", recipient: note.recipient, from: (note.from ?? "").trim().slice(0, 80) };
  return encryptJson(vaultKey, clean, AAD.shareNote(shareId));
}

export async function openShareNote(vaultKey: CryptoKey, shareId: string, envelope: string): Promise<ShareNote> {
  return decryptJson<ShareNote>(vaultKey, envelope, AAD.shareNote(shareId));
}

// ---------------------------------------------------------------- rotation

export interface RotationApp {
  id: string;
  /** The app secret, unwrapped on the owner's device. */
  secret: Uint8Array;
}

export interface RotationShare {
  id: string;
  /** The recipient's public key from the owner's encrypted note. */
  recipient: string;
  from: string;
}

export interface FolderRotation {
  folder: OpenFolder;
  wrappedKey: string;
  meta: string;
  memories: StoredMemory[];
  grants: (StoredGrant & { appId: string })[];
  shares: { id: string; sealedKey: string }[];
}

/**
 * Gives a folder a new key and re-encrypts everything that depends on it, on the
 * owner's device. The result is sent to the server in one request and applied
 * in one transaction.
 */
export async function rotateFolder(
  vaultKey: CryptoKey,
  folder: OpenFolder,
  memories: Memory[],
  apps: RotationApp[],
  shares: RotationShare[],
): Promise<FolderRotation> {
  const raw = randomBytes(32);
  const next: OpenFolder = { ...folder, raw, key: await importKey(raw) };
  const stored: StoredMemory[] = [];
  for (const m of memories) {
    if (m.folderId !== folder.id) throw new Error("A memory from another folder was passed to the rotation.");
    stored.push(await encryptMemory(next, m));
  }
  const grants: FolderRotation["grants"] = [];
  for (const app of apps) {
    const wrap = await importKey((await appKeys(app.secret)).wrapKey);
    grants.push({ appId: app.id, folderId: folder.id, wrappedKey: await encryptBytes(wrap, raw, AAD.appFolderKey(app.id, folder.id)) });
  }
  return {
    folder: next,
    wrappedKey: await encryptBytes(vaultKey, raw, AAD.folderKey(folder.id)),
    meta: await renameFolder(next, folder.name),
    memories: stored,
    grants,
    shares: shares.map((s) => ({ id: s.id, sealedKey: sealShare(s.recipient, s.id, folder.id, raw, s.from) })),
  };
}
