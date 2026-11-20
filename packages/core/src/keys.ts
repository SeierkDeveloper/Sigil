// The Sigil key hierarchy.
//
//   vault key (32 random bytes, made on the device at sign-up, never sent in the clear)
//     wrapped once per sign-in method in a "keyslot":
//       passkey  -> key from the WebAuthn PRF extension
//       wallet   -> key from a signature over a fixed message
//       phrase   -> key from the 24-word recovery phrase
//     wraps each folder key (32 random bytes per folder)
//       folder key encrypts that folder's name and every memory in it
//       folder key is also wrapped for each app the folder is shared with
//     wraps the vault's X25519 box key (see box.ts), whose public half lets
//       apps, the browser extension and other vaults seal data to this vault
//   app secret (32 random bytes per connected app, shown to the user once)
//     -> app auth token (the server keeps only its SHA-256)
//     -> app wrap key (unwraps the folder keys granted to that app)
//     -> app tag key (lets the app check the vault public key it is given)

import { sha256 } from "@noble/hashes/sha2.js";
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { decryptBytes, encryptBytes, hkdf, importKey, randomBytes } from "./crypto";
import { fromBase64Url, fromHex, toBase64Url, toHex, utf8 } from "./encoding";

export type KeyslotKind = "passkey" | "wallet" | "phrase" | "device";

export const AAD = {
  keyslot: (kind: KeyslotKind) => `sigil:keyslot:${kind}`,
  folderKey: (folderId: string) => `sigil:folder-key:${folderId}`,
  folderMeta: (folderId: string) => `sigil:folder-meta:${folderId}`,
  memoryHead: (memoryId: string) => `sigil:memory-head:${memoryId}`,
  memoryBody: (memoryId: string) => `sigil:memory-body:${memoryId}`,
  appMeta: (appId: string) => `sigil:app-meta:${appId}`,
  appSecret: (appId: string) => `sigil:app-secret:${appId}`,
  appFolderKey: (appId: string, folderId: string) => `sigil:app-folder-key:${appId}:${folderId}`,
  shareNote: (shareId: string) => `sigil:share-note:${shareId}`,
  embedding: (model: string, key: string) => `sigil:embedding:${model}:${key}`,
  setting: (name: string) => `sigil:setting:${name}`,
  appSelf: (appId: string) => `sigil:app-self:${appId}`,
  askLinkOwner: (linkId: string) => `sigil:ask-link:${linkId}`,
  askLinkApp: (appId: string, linkId: string) => `sigil:ask-link-app:${appId}:${linkId}`,
  askIntro: (linkId: string) => `sigil:ask-intro:${linkId}`,
  legacyOwner: (planId: string) => `sigil:legacy-owner:${planId}`,
  legacyBundle: (planId: string, epoch: number, trusteeId: string) => `sigil:legacy-bundle:${planId}:${epoch}:${trusteeId}`,
  legacyIntro: (trusteeId: string) => `sigil:legacy-intro:${trusteeId}`,
  legacyKept: (planId: string) => `sigil:legacy-kept:${planId}`,
  keyslotNote: (keyslotId: string) => `sigil:keyslot-note:${keyslotId}`,
  agentRules: (appId: string) => `sigil:agent-rules:${appId}`,
  handoff: (handoffId: string) => `sigil:handoff:${handoffId}`,
  spaceMeta: (spaceId: string) => `sigil:space-meta:${spaceId}`,
  spaceNote: (spaceId: string) => `sigil:space-note:${spaceId}`,
  syncOwner: (sourceId: string) => `sigil:sync:${sourceId}`,
  syncApp: (appId: string, sourceId: string) => `sigil:sync-app:${appId}:${sourceId}`,
  publicOwner: (selfId: string) => `sigil:public-self:${selfId}`,
  publicApp: (appId: string, selfId: string) => `sigil:public-self-app:${appId}:${selfId}`,
  meetOwner: (meetId: string) => `sigil:meet:${meetId}`,
  draft: (draftId: string) => `sigil:draft:${draftId}`,
  disclosure: (disclosureId: string) => `sigil:disclosure:${disclosureId}`,
  agreementOwner: (agreementId: string) => `sigil:agreement:${agreementId}`,
  backupApp: (appId: string) => `sigil:backup-app:${appId}`,
  captureNote: (captureId: string) => `sigil:capture-note:${captureId}`,
} as const;

/** SHA-256 hex of a token. The server stores this and never the token itself. */
export function tokenHash(token: string): string {
  return toHex(sha256(utf8(token)));
}

export function sha256Hex(data: string | Uint8Array): string {
  return toHex(sha256(typeof data === "string" ? utf8(data) : data));
}

// ---------------------------------------------------------------- vault key

export function newVaultKey(): Uint8Array {
  return randomBytes(32);
}

export async function wrapVaultKey(kek: Uint8Array, vaultKey: Uint8Array, kind: KeyslotKind): Promise<string> {
  return encryptBytes(await importKey(kek), vaultKey, AAD.keyslot(kind));
}

export async function unwrapVaultKey(kek: Uint8Array, wrapped: string, kind: KeyslotKind): Promise<Uint8Array> {
  const raw = await decryptBytes(await importKey(kek), wrapped, AAD.keyslot(kind));
  if (raw.length !== 32) throw new Error("Unexpected vault key length.");
  return raw;
}

// ---------------------------------------------------------------- passkey (WebAuthn PRF)

/** The PRF input Sigil asks every passkey to evaluate. Fixed, so the same passkey always gives the same key. */
export const PASSKEY_PRF_SALT: Uint8Array = sha256(utf8("sigil/passkey-prf/v1"));

export async function passkeyKek(prfOutput: Uint8Array): Promise<Uint8Array> {
  if (prfOutput.length < 32) throw new Error("The passkey returned too little key material.");
  return hkdf(prfOutput, "sigil:kek:passkey");
}

// ---------------------------------------------------------------- wallet

export function normalizeAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Not a wallet address.");
  return address.toLowerCase();
}

/**
 * The message a wallet signs to unlock the vault. The signature never leaves the browser:
 * only a hash-derived token does. It must not change, or existing vaults could not be opened.
 */
export function walletKeyMessage(address: string): string {
  return [
    "Sigil vault key",
    "",
    "Signing this message unlocks your Sigil vault on this device.",
    "The signature stays in your browser and is never sent anywhere.",
    "It does not cost anything and does not allow any transaction.",
    "",
    `Wallet: ${normalizeAddress(address)}`,
    "Version: 1",
  ].join("\n");
}

export interface WalletKeys {
  kek: Uint8Array;
  authToken: string;
}

export async function walletKeys(address: string, signatureHex: string): Promise<WalletKeys> {
  const sig = fromHex(signatureHex);
  if (sig.length < 64) throw new Error("That does not look like a wallet signature.");
  const who = normalizeAddress(address);
  return {
    kek: await hkdf(sig, `sigil:kek:wallet:${who}`),
    authToken: toBase64Url(await hkdf(sig, `sigil:auth:wallet:${who}`)),
  };
}

// ---------------------------------------------------------------- recovery phrase

export function newRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

export interface PhraseKeys {
  kek: Uint8Array;
  authToken: string;
  /** Lets the server find the account for a phrase without learning anything that unlocks it. */
  lookupId: string;
}

export async function phraseKeys(phrase: string): Promise<PhraseKeys> {
  const normalized = normalizePhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) throw new Error("That recovery phrase is not valid.");
  const entropy = mnemonicToEntropy(normalized, wordlist);
  return {
    kek: await hkdf(entropy, "sigil:kek:phrase"),
    authToken: toBase64Url(await hkdf(entropy, "sigil:auth:phrase")),
    lookupId: toHex(await hkdf(entropy, "sigil:lookup:phrase", 16)),
  };
}

// ---------------------------------------------------------------- app keys

export const APP_KEY_PREFIX = "sigil_app";

export interface AppKeyParts {
  appId: string;
  secret: Uint8Array;
}

export function newAppSecret(): Uint8Array {
  return randomBytes(32);
}

/** The single string a user pastes into a connector: `sigil_app.<appId>.<secret>`. */
export function formatAppKey(appId: string, secret: Uint8Array): string {
  return `${APP_KEY_PREFIX}.${appId}.${toBase64Url(secret)}`;
}

export function parseAppKey(key: string): AppKeyParts {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== APP_KEY_PREFIX) {
    throw new Error("That is not a Sigil app key. It starts with sigil_app.");
  }
  const secret = fromBase64Url(parts[2]);
  if (secret.length !== 32 || !/^[A-Za-z0-9_-]{8,64}$/.test(parts[1])) {
    throw new Error("That Sigil app key is damaged. Copy it again from your vault.");
  }
  return { appId: parts[1], secret };
}

export interface AppKeys {
  authToken: string;
  wrapKey: Uint8Array;
}

/** The key that wraps what an app needs to answer as the owner's AI self (rules, model key, ask links). */
export async function appSelfKey(secret: Uint8Array): Promise<Uint8Array> {
  return hkdf(secret, "sigil:wrap:self");
}

/** The key that wraps live sync sources (their tokens, folder and cursor) for a connector the owner lets sync in the background. */
export async function appSyncKey(secret: Uint8Array): Promise<Uint8Array> {
  return hkdf(secret, "sigil:wrap:sync");
}

export async function appKeys(secret: Uint8Array): Promise<AppKeys> {
  return {
    authToken: toBase64Url(await hkdf(secret, "sigil:auth:app")),
    wrapKey: await hkdf(secret, "sigil:wrap:app"),
  };
}
