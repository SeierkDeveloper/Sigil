// Everything the vault page does with keys and data, without any UI. All
// encryption and decryption happens here, on the device; the Api only ever
// carries ids, envelopes and hashes.

import {
  appBoxTag,
  buildMemory,
  buildProfileBody,
  createBoxKey,
  encryptShareNote,
  formatVaultCode,
  mergeBodies,
  openBoxKey,
  openProposal,
  openShare,
  openShareNote,
  parseVaultCode,
  PROFILE_FOLDER_NAME,
  PROFILE_TITLE,
  randomId,
  rotateFolder,
  sealShare,
  vaultFingerprint,
  type BoxKeyPair,
  type ProfileSections,
  type ProposalPayload,
  type StoredBoxKey,
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
  openFolderWithRaw,
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
  AAD,
  cleanModelSettings,
  cleanRules,
  cleanThinking,
  decryptJson,
  deleteAfter,
  DEFAULT_THINKING,
  openSetting,
  type AskLinkSecret,
  type ModelSettings,
  type SelfRules,
  type ThinkingSettings,
} from "@sigil/core";
import type { Api } from "./api";
import { openLegacyState, openTrusted, type LegacyState, type ServerLegacy, type ServerTrusted, type TrustedView } from "./legacyOps";
import { openSpaces, type AgentView, type ServerAgent, type ServerSpace, type SpaceView } from "./agentOps";
import { ensureSignKey, type CertificateView, type PresenceCounts } from "./lifeOps";
import { rememberKeyslot } from "./offline";
import type { AccessRequestView } from "./protectOps";
import { openSources, type ServerSource, type SyncSourceView } from "./syncOps";
import { openPublicSelf, type PublicSelfView, type ServerPublicSelf } from "./publicOps";
import { openMeets, type MeetView, type ServerMeet } from "./meetOps";

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
  /** For a device: its name, encrypted under the vault key. */
  note?: string | null;
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
  /** May suggest memories to the inbox. Off unless the owner turns it on. */
  canPropose: boolean;
  /** May answer as the AI self (the ask_self tool, and links it serves). */
  canAskSelf: boolean;
  /** Folders it may write: only agents have any. */
  writeIds: string[];
}

export interface AskLinkView {
  id: string;
  publicKey: string;
  /** The link's private key, rules and label, opened on this device. Null if it would not open. */
  secret: AskLinkSecret | null;
  label: string;
  /** The app that answers it, or null when this vault answers it while open. */
  appId: string | null;
  expiresAt: string;
  maxUses: number;
  perHour: number;
  uses: number;
  answered: number;
  lastAskedAt: string | null;
  online: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface ProposalView {
  id: string;
  appId: string;
  createdAt: string;
  /** Null when the sealed box did not open with this vault's key. */
  payload: ProposalPayload | null;
}

export interface OutgoingShareView {
  id: string;
  folderId: string;
  label: string;
  /** The recipient's public key, from the owner's own encrypted note. */
  recipient: string;
  /** False if the server holds another key for this share than the owner entered. */
  verified: boolean;
  /** The name the owner signed the share with. */
  from: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface IncomingShareView {
  id: string;
  folderId: string;
  /** The shared folder, opened with the key sealed to this vault. Null if it would not open. */
  folder: OpenFolder | null;
  from: string;
  createdAt: string;
  acceptedAt: string | null;
  memories: Memory[];
}

export interface VaultData {
  folders: OpenFolder[];
  memories: Memory[];
  apps: AppView[];
  keyslots: KeyslotView[];
  usage: { memories: number; bytes: number };
  /** Items that did not decrypt. Should always be zero; shown if not. */
  unreadable: number;
  /** The vault's own X25519 key pair, unwrapped on this device. */
  box: BoxKeyPair | null;
  boxPublic: string | null;
  proposals: ProposalView[];
  shares: { outgoing: OutgoingShareView[]; incoming: IncomingShareView[] };
  /** The owner's own model and key, opened on this device. Never readable on the server. */
  model: ModelSettings | null;
  /** The AI self's rules. Null until the owner saves them. */
  self: SelfRules | null;
  thinking: ThinkingSettings;
  askLinks: AskLinkView[];
  /** When the vault's first folder was made: the vault's age, for the first weekly brief. */
  createdAt: string | null;
  /** The owner's legacy plan, opened on this device. */
  legacy: LegacyState;
  /** Plans of other vaults that name this one as a trusted person. */
  trusted: TrustedView[];
  agents: AgentView[];
  spaces: SpaceView[];
  /** The vault's signing key for presence statements. */
  signKey: string | null;
  presence: PresenceCounts;
  certificates: CertificateView[];
  /** Requests to read a protected folder, waiting for the owner or answered. */
  access: AccessRequestView[];
  /** Live sync sources, opened on this device. */
  sync: SyncSourceView[];
  /** The public AI self, with its key and rules opened on this device. */
  publicSelf: PublicSelfView | null;
  /** Conversations between this vault's AI self and others. */
  meets: MeetView[];
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
  /** For an answer of the AI self: the question and answer, sealed to this vault's key. */
  note?: string;
}

export interface LogData {
  periodSeconds: number;
  mode: "local" | "anchored";
  entries: LogEntryView[];
}

export interface ServerVault {
  folders: (StoredFolder & { createdAt: string; protected?: boolean })[];
  memories: (StoredMemory & { updatedAt: string })[];
  apps: {
    id: string;
    meta: string;
    secret: string;
    createdAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
    grants: { folderId: string; mode?: "read" | "write" }[];
    canPropose?: boolean;
    canAskSelf?: boolean;
  }[];
  settings?: Record<string, string>;
  askLinks?: {
    id: string;
    publicKey: string;
    ownerBox: string;
    appId: string | null;
    expiresAt: string;
    maxUses: number;
    perHour: number;
    uses: number;
    answered: number;
    lastAskedAt: string | null;
    online: boolean;
    createdAt: string;
    revokedAt: string | null;
  }[];
  keyslots: KeyslotView[];
  usage: { memories: number; bytes: number };
  legacy?: ServerLegacy;
  trusted?: ServerTrusted[];
  agents?: ServerAgent[];
  spaces?: ServerSpace[];
  signKey?: string | null;
  presence?: PresenceCounts;
  certificates?: CertificateView[];
  access?: AccessRequestView[];
  sync?: ServerSource[];
  publicSelf?: ServerPublicSelf | null;
  meets?: ServerMeet[];
  box?: StoredBoxKey | null;
  proposals?: { id: string; appId: string; sealed: string; createdAt: string }[];
  shares?: {
    outgoing: { id: string; folderId: string; recipientKey: string; note: string; createdAt: string; acceptedAt: string | null }[];
    incoming: { id: string; folderId: string; sealedKey: string; folderMeta: string; createdAt: string; acceptedAt: string | null; memories: StoredMemory[] }[];
  };
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
  const { stored: box } = await createBoxKey(vault.key);
  return {
    vault,
    phrase,
    body: {
      wrappedKey: await wrapVaultKey(kek, raw, kind),
      recovery: { lookupId: pk.lookupId, authToken: pk.authToken, wrappedKey: await wrapVaultKey(pk.kek, raw, "phrase") },
      folder,
      box,
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
  rememberKeyslot({ kind: "wallet", wrappedKey: init.body.wrappedKey, address });
  return { vault: init.vault, phrase: init.phrase };
}

export async function signInWithWallet(api: Api, address: string, signature: string): Promise<Unlocked> {
  const wk = await walletKeys(address, signature);
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/wallet/login", { address, authToken: wk.authToken });
  rememberKeyslot({ kind: "wallet", wrappedKey: r.keyslot.wrappedKey, address });
  return unlockedFrom(await unwrapVaultKey(wk.kek, r.keyslot.wrappedKey, "wallet"));
}

export async function signInWithPhrase(api: Api, phrase: string): Promise<Unlocked> {
  const pk = await phraseKeys(phrase);
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/phrase/login", { lookupId: pk.lookupId, authToken: pk.authToken });
  rememberKeyslot({ kind: "phrase", wrappedKey: r.keyslot.wrappedKey });
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
  rememberKeyslot({ kind: "passkey", wrappedKey: init.body.wrappedKey });
  return { vault: init.vault, phrase: init.phrase };
}

export async function signInWithPasskey(api: Api, driver: PasskeyDriver): Promise<Unlocked> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>("auth/passkey/login/options");
  const got = await driver.get(options);
  if (!got.prf) throw new PasskeyPrfUnsupported();
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/passkey/login", { challengeId, response: got.response });
  rememberKeyslot({ kind: "passkey", wrappedKey: r.keyslot.wrappedKey });
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

export async function loadVault(api: Api, vault: Unlocked, opts: { onRaw?: (raw: ServerVault) => void } = {}): Promise<VaultData> {
  const data = await api.get<ServerVault>("vault");
  opts.onRaw?.(data);
  return decodeVault(data, vault, api);
}

/**
 * Opens what the server sent, on this device. Without an api (the copy kept on
 * this device for offline reading) nothing is sent back: a vault from before
 * box keys or signing keys existed simply stays without them until it is next opened online.
 */
export async function decodeVault(data: ServerVault, vault: Unlocked, api: Api | null): Promise<VaultData> {
  let unreadable = 0;
  const folders: OpenFolder[] = [];
  for (const f of data.folders) {
    try {
      const open = await openFolder(vault.key, f);
      // The server's flag and the encrypted meta should agree; if either says protected, it is treated as protected.
      folders.push(f.protected && !open.protect ? { ...open, protect: "other" } : open);
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
      writeIds: a.grants.filter((g) => g.mode === "write").map((g) => g.folderId),
      meta: a.meta,
      secret: a.secret,
      canPropose: a.canPropose === true,
      canAskSelf: a.canAskSelf === true,
    });
  }

  // Settings: each one opened with the vault key on this device.
  const settings = data.settings ?? {};
  const open = async <T,>(name: "model" | "self" | "thinking"): Promise<T | null> => {
    if (!settings[name]) return null;
    try {
      return await openSetting<T>(vault.key, name, settings[name]);
    } catch {
      unreadable++;
      return null;
    }
  };
  const model = cleanModelSettings(await open("model"));
  const selfRaw = await open<unknown>("self");
  const self = selfRaw ? cleanRules(selfRaw) : null;
  const thinking = cleanThinking(await open("thinking"));

  const askLinks: AskLinkView[] = [];
  for (const l of data.askLinks ?? []) {
    let secret: AskLinkSecret | null = null;
    try {
      secret = await decryptJson<AskLinkSecret>(vault.key, l.ownerBox, AAD.askLinkOwner(l.id));
    } catch {
      unreadable++;
    }
    const { ownerBox: _box, ...rest } = l;
    askLinks.push({ ...rest, secret, label: secret?.label ?? "Unreadable link" });
  }

  // The vault's box key: made now for a vault from before box keys existed.
  let box: BoxKeyPair | null = null;
  let boxPublic: string | null = data.box?.publicKey ?? null;
  if (data.box) {
    try {
      box = await openBoxKey(vault.key, data.box);
    } catch {
      unreadable++;
    }
  } else if (api) {
    const made = await createBoxKey(vault.key);
    try {
      await api.post("vault/box-key", made.stored);
      box = made.pair;
      boxPublic = made.stored.publicKey;
    } catch {
      // Another device may have made it at the same moment; it is picked up on the next load.
    }
  }

  const proposals: ProposalView[] = (data.proposals ?? []).map((p) => {
    let payload: ProposalPayload | null = null;
    try {
      if (box) payload = openProposal(box, p);
    } catch {
      payload = null;
    }
    return { id: p.id, appId: p.appId, createdAt: p.createdAt, payload };
  });

  const outgoing: OutgoingShareView[] = [];
  for (const s of data.shares?.outgoing ?? []) {
    try {
      const note = await openShareNote(vault.key, s.id, s.note);
      outgoing.push({
        id: s.id,
        folderId: s.folderId,
        label: note.label,
        recipient: note.recipient,
        from: note.from ?? "",
        verified: note.recipient === s.recipientKey,
        createdAt: s.createdAt,
        acceptedAt: s.acceptedAt,
      });
    } catch {
      unreadable++;
    }
  }

  const incoming: IncomingShareView[] = [];
  for (const s of data.shares?.incoming ?? []) {
    let folder: OpenFolder | null = null;
    let from = "";
    const shared: Memory[] = [];
    try {
      if (!box) throw new Error("no box key");
      const opened = openShare(box, s);
      from = opened.from;
      folder = await openFolderWithRaw({ id: s.folderId, meta: s.folderMeta }, opened.raw);
      for (const m of s.memories) shared.push(await decryptMemory(folder, m));
    } catch {
      folder = null;
    }
    shared.sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : 0));
    incoming.push({ id: s.id, folderId: s.folderId, folder, from, createdAt: s.createdAt, acceptedAt: s.acceptedAt, memories: shared });
  }

  const legacy = await openLegacyState(vault, data.legacy ?? { lastActiveAt: null, plan: null });
  if (legacy.unreadable) unreadable++;
  const trusted = await openTrusted(vault, box, data.trusted ?? []);
  const { spaces, unreadable: badSpaces } = await openSpaces(box, data.spaces ?? []);
  unreadable += badSpaces;
  const signKey = api ? await ensureSignKey(api, vault, data.signKey ?? null) : (data.signKey ?? null);
  const synced = await openSources(vault, apps, data.sync ?? []);
  unreadable += synced.unreadable;
  const pub = await openPublicSelf(vault, data.publicSelf);
  unreadable += pub.unreadable;
  const met = await openMeets(vault, box, data.meets ?? []);
  unreadable += met.unreadable;

  return {
    access: data.access ?? [],
    sync: synced.sources,
    publicSelf: pub.self,
    meets: met.meets,
    legacy,
    trusted,
    agents: (data.agents ?? []).map((a) => ({ appId: a.appId, homeFolderId: a.homeFolderId, rules: a.rules, publicKey: a.publicKey, createdAt: a.createdAt })),
    spaces,
    signKey,
    presence: data.presence ?? { total: 0, sealed: 0, firstHour: null, lastHour: null },
    certificates: data.certificates ?? [],
    folders,
    memories,
    apps,
    keyslots: data.keyslots,
    usage: data.usage,
    unreadable,
    box,
    boxPublic,
    proposals,
    shares: { outgoing, incoming },
    model,
    self,
    thinking,
    askLinks,
    createdAt: data.folders.reduce<string | null>((min, f) => (!min || f.createdAt < min ? f.createdAt : min), null),
  };
}

// ---------------------------------------------------------------- folders

export async function addFolder(api: Api, vault: Unlocked, name: string, kind?: "profile"): Promise<OpenFolder> {
  const { stored, folder } = await encryptFolder(vault.key, name, undefined, kind);
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

/**
 * Encrypts a memory for saving. A memory with an expiry also carries, in the
 * clear, the time the server deletes it for real: the expiry plus the grace
 * period. That time is all the server learns; the expiry itself stays encrypted.
 */
export async function storedForSave(folder: OpenFolder, memory: Memory, graceDays = DEFAULT_THINKING.graceDays): Promise<StoredMemory & { deleteAfter: string | null }> {
  return { ...(await encryptMemory(folder, memory)), deleteAfter: deleteAfter(memory.expiresAt, graceDays) };
}

export async function saveMemory(api: Api, folder: OpenFolder, memory: Memory, graceDays?: number): Promise<Memory> {
  await api.put("memories", { memories: [await storedForSave(folder, memory, graceDays)] });
  return memory;
}

export async function createMemory(api: Api, folder: OpenFolder, draft: MemoryDraft, graceDays?: number): Promise<Memory> {
  return saveMemory(api, folder, buildMemory(draft, folder.id), graceDays);
}

export async function updateMemory(
  api: Api,
  folders: OpenFolder[],
  memory: Memory,
  changes: Partial<Pick<Memory, "title" | "body" | "tags" | "folderId">> & { expiresAt?: string | null },
  graceDays?: number,
): Promise<Memory> {
  const next = buildMemory(
    {
      title: changes.title ?? memory.title,
      body: changes.body ?? memory.body,
      tags: changes.tags ?? memory.tags,
      source: memory.source,
      createdAt: memory.createdAt,
      editedAt: new Date().toISOString(),
      expiresAt: changes.expiresAt === undefined ? memory.expiresAt : changes.expiresAt,
      image: memory.image ?? null,
    },
    changes.folderId ?? memory.folderId,
    memory.id,
  );
  const folder = folders.find((f) => f.id === next.folderId);
  if (!folder) throw new Error("That folder no longer exists.");
  // Moving to another folder re-encrypts the memory under that folder's key.
  return saveMemory(api, folder, next, graceDays);
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

export async function connectApp(
  api: Api,
  vault: Unlocked,
  meta: AppMeta,
  folders: OpenFolder[],
  opts: { canPropose?: boolean; boxPublic?: string | null } = {},
): Promise<{ appKey: string; appId: string }> {
  const app = await encryptApp(vault.key, meta, folders);
  await api.post("apps", app.stored);
  if (opts.canPropose) {
    if (!opts.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
    const secret = await openAppSecret(vault.key, app.stored);
    await api.put(`apps/${app.stored.id}/inbox`, { enabled: true, tag: await appBoxTag(secret, opts.boxPublic) });
  }
  return { appKey: app.appKey, appId: app.stored.id };
}

/**
 * Lets an app suggest memories, or stops it. Turning it on tags the vault public
 * key with the app's own secret, so the app can tell the key really is this vault's.
 */
export async function setAppSuggestions(api: Api, vault: Unlocked, app: Pick<AppView, "id" | "secret">, boxPublic: string | null, enabled: boolean): Promise<void> {
  if (!enabled) {
    await api.put(`apps/${app.id}/inbox`, { enabled: false });
    return;
  }
  if (!boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  const secret = await openAppSecret(vault.key, app);
  await api.put(`apps/${app.id}/inbox`, { enabled: true, tag: await appBoxTag(secret, boxPublic) });
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

// ---------------------------------------------------------------- the inbox

export interface ProposalEdits {
  title: string;
  body: string;
  tags: string[];
}

function proposalSource(app: Pick<AppView, "name"> | undefined, payload: ProposalPayload): Memory["source"] {
  if (payload.source?.ref) return payload.source;
  if (payload.via === "capture") return payload.url ? { kind: "capture", ref: payload.url } : { kind: "capture" };
  if (payload.via === "extension" && payload.url) return { kind: "web", ref: payload.url };
  return { kind: "app", ref: app?.name ?? "an app" };
}

/** Approves a suggestion as a new memory, encrypted on this device into the chosen folder. */
export async function approveProposal(api: Api, folder: OpenFolder, proposal: ProposalView, edits: ProposalEdits, app?: Pick<AppView, "name">): Promise<Memory> {
  if (!proposal.payload) throw new Error("This suggestion could not be opened with your vault key.");
  const memory = buildMemory({ title: edits.title, body: edits.body, tags: edits.tags, source: proposalSource(app, proposal.payload), image: proposal.payload.image ?? null }, folder.id);
  await api.post(`proposals/${proposal.id}/approve`, { memory: await encryptMemory(folder, memory) });
  return memory;
}

/** Merges a suggestion into an existing memory: its text is added under a dated line, its tags joined. */
export async function mergeProposal(api: Api, folders: OpenFolder[], proposal: ProposalView, edits: ProposalEdits, into: Memory, graceDays?: number): Promise<Memory> {
  const folder = folders.find((f) => f.id === into.folderId);
  if (!folder) throw new Error("That memory's folder no longer exists.");
  const merged = buildMemory(
    {
      title: into.title,
      body: mergeBodies(into.body, edits.body),
      tags: [...into.tags, ...edits.tags],
      source: into.source,
      createdAt: into.createdAt,
      editedAt: new Date().toISOString(),
      expiresAt: into.expiresAt,
      image: into.image ?? proposal.payload?.image ?? null,
    },
    into.folderId,
    into.id,
  );
  await api.post(`proposals/${proposal.id}/approve`, { memory: await storedForSave(folder, merged, graceDays) });
  return merged;
}

/** The memory a synced suggestion changes: the one imported from the same note. */
export function syncedTarget(data: Pick<VaultData, "memories">, proposal: ProposalView): Memory | null {
  const src = proposal.payload?.source;
  if (!src?.ref) return null;
  return data.memories.find((m) => m.source.kind === src.kind && m.source.ref === src.ref) ?? null;
}

/** Applies a change from a synced note: the memory's title, text and tags become the suggested ones; its source and dates stay. */
export async function updateFromProposal(api: Api, folders: OpenFolder[], proposal: ProposalView, edits: ProposalEdits, into: Memory, graceDays?: number): Promise<Memory> {
  const folder = folders.find((f) => f.id === into.folderId);
  if (!folder) throw new Error("That memory's folder no longer exists.");
  const next = buildMemory(
    { title: edits.title, body: edits.body, tags: edits.tags, source: into.source, createdAt: into.createdAt, editedAt: new Date().toISOString(), expiresAt: into.expiresAt },
    into.folderId,
    into.id,
  );
  await api.post(`proposals/${proposal.id}/approve`, { memory: await storedForSave(folder, next, graceDays) });
  return next;
}

export async function rejectProposal(api: Api, proposalId: string): Promise<void> {
  await api.del(`proposals/${proposalId}`);
}

// ---------------------------------------------------------------- the Self card

export function profileFolder(data: Pick<VaultData, "folders">): OpenFolder | null {
  return data.folders.find((f) => f.kind === "profile") ?? null;
}

export function profileMemory(data: Pick<VaultData, "folders" | "memories">): Memory | null {
  const folder = profileFolder(data);
  if (!folder) return null;
  return data.memories.filter((m) => m.folderId === folder.id && m.source.kind === "profile").sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1))[0] ?? null;
}

/** Saves the Self card, making its own folder the first time. */
export async function saveProfile(
  api: Api,
  vault: Unlocked,
  data: Pick<VaultData, "folders" | "memories">,
  sections: ProfileSections,
): Promise<{ folder: OpenFolder; memory: Memory; createdFolder: boolean }> {
  let folder = profileFolder(data);
  let createdFolder = false;
  if (!folder) {
    folder = await addFolder(api, vault, PROFILE_FOLDER_NAME, "profile");
    createdFolder = true;
  }
  const existing = profileMemory(data);
  const memory = buildMemory(
    {
      title: PROFILE_TITLE,
      body: buildProfileBody(sections),
      tags: ["self-card"],
      source: { kind: "profile" },
      createdAt: existing?.createdAt,
      editedAt: new Date().toISOString(),
    },
    folder.id,
    existing?.id,
  );
  await saveMemory(api, folder, memory);
  return { folder, memory, createdFolder };
}

// ---------------------------------------------------------------- sharing

/** The code another person enters to share a folder with this vault. */
export function vaultCode(data: Pick<VaultData, "boxPublic">): { code: string; fingerprint: string } | null {
  return data.boxPublic ? { code: formatVaultCode(data.boxPublic), fingerprint: vaultFingerprint(data.boxPublic) } : null;
}

export async function shareFolder(api: Api, vault: Unlocked, folder: OpenFolder, code: string, label: string, from: string): Promise<OutgoingShareView> {
  const recipient = parseVaultCode(code);
  const id = randomId();
  const note = await encryptShareNote(vault.key, id, { label, recipient, from });
  await api.post("shares", { id, folderId: folder.id, recipientKey: recipient, sealedKey: sealShare(recipient, id, folder.id, folder.raw, from), note });
  return {
    id,
    folderId: folder.id,
    label: label.trim().slice(0, 80) || "Another vault",
    recipient,
    from: from.trim().slice(0, 80),
    verified: true,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
  };
}

export async function acceptShare(api: Api, shareId: string): Promise<void> {
  await api.post(`shares/${shareId}/accept`);
}

export async function leaveShare(api: Api, shareId: string): Promise<void> {
  await api.del(`shares/${shareId}`);
}

/**
 * Stops sharing a folder with one vault. The folder gets a new key on this
 * device: every memory in it is encrypted again, and the new key is wrapped for
 * this vault, for each app that may read the folder and for every other share.
 * The vault that was removed keeps only the old key, which opens nothing new.
 */
export async function revokeShare(api: Api, vault: Unlocked, data: VaultData, folder: OpenFolder, shareId: string): Promise<OpenFolder> {
  const shares = data.shares.outgoing.filter((s) => s.folderId === folder.id);
  if (!shares.some((s) => s.id === shareId)) throw new Error("That share was not found.");
  const apps = [];
  for (const a of data.apps.filter((x) => !x.revokedAt && x.folderIds.includes(folder.id))) {
    apps.push({ id: a.id, secret: await openAppSecret(vault.key, a) });
  }
  const kept = shares.filter((s) => s.id !== shareId);
  const r = await rotateFolder(
    vault.key,
    folder,
    data.memories.filter((m) => m.folderId === folder.id),
    apps,
    kept.map((s) => ({ id: s.id, recipient: s.recipient, from: s.from })),
  );
  await api.post(`folders/${folder.id}/rotate`, {
    wrappedKey: r.wrappedKey,
    meta: r.meta,
    memories: r.memories,
    grants: r.grants.map((g) => ({ appId: g.appId, wrappedKey: g.wrappedKey })),
    shares: r.shares,
    revoke: [shareId],
  });
  return r.folder;
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
  folders: { id: string; name: string; protect?: string; redact?: string[] }[];
  memories: Omit<Memory, "snippet">[];
  apps: { id: string; name: string; kind: AppKind; createdAt: string; revokedAt: string | null; folders: string[] }[];
  readLog: Omit<LogEntryView, "salt" | "leaf" | "hour" | "sealed">[];
  /** Suggestions still waiting in the inbox, opened on the device. */
  inbox: { app: string; createdAt: string; title: string; body: string; tags: string[]; folder: string | null; url: string | null }[];
  /** Folders shared with other vaults, by what you call them. */
  shares: { folder: string; with: string; createdAt: string; acceptedAt: string | null }[];
  /** The AI self's rules, which model it uses (the key itself is left out of the file), and the ask links. */
  aiSelf: {
    rules: SelfRules | null;
    model: { provider: ModelSettings["provider"]; model: string } | null;
    links: { label: string; createdAt: string; expiresAt: string; uses: number; answered: number; revokedAt: string | null }[];
  };
  thinking: ThinkingSettings;
  /** The legacy plan as the owner sees it, without the legacy key. */
  legacy: { owner: string; periodDays: number; threshold: number; people: { label: string; folders: string[]; aiSelf: boolean; added: "vault code" | "invite" }[] } | null;
  /** Plans of other vaults that name this one. */
  namedIn: { owner: string; as: string; folders: string[] }[];
  agents: { name: string; ownFolder: string | null; rules: AgentView["rules"]; revokedAt: string | null }[];
  spaces: { name: string; role: string; members: { name: string; kind: string; role: string }[]; memories: { title: string; body: string; editedAt: string }[] }[];
  devices: { addedAt: string; lastUsedAt: string | null }[];
  certificates: { link: string; from: string; to: string; createdAt: string }[];
  /** Live sync sources, without their sign-in tokens. */
  sync: { service: string; account: string; folder: string; paused: boolean; lastSyncAt: string | null; inBackground: boolean }[];
  /** The public AI self: its settings, which folders are public, and the answers it showed. */
  publicSelf: { handle: string; name: string; greeting: string; enabled: boolean; folders: string[]; perVisitorHour: number; answers: { question: string; answer: string; hidden: boolean; createdAt: string }[] } | null;
  /** Conversations of your AI self with others, with their transcripts. */
  meets: { with: string; purpose: string; state: string; createdAt: string; transcript: { turn: number; by: string; text: string }[] }[];
}

/** Everything in the vault, decrypted, as one JSON document. Built on the device. */
export function buildExport(data: VaultData, log: LogEntryView[]): VaultExport {
  const folderName = new Map(data.folders.map((f) => [f.id, f.name]));
  return {
    format: "sigil-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: data.folders.map((f) => ({ id: f.id, name: f.name, ...(f.protect ? { protect: f.protect } : {}), ...(f.redact?.length ? { redact: f.redact } : {}) })),
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
    inbox: data.proposals.flatMap((p) =>
      p.payload
        ? [
            {
              app: data.apps.find((a) => a.id === p.appId)?.name ?? "Removed app",
              createdAt: p.createdAt,
              title: p.payload.title,
              body: p.payload.body,
              tags: p.payload.tags,
              folder: p.payload.folder,
              url: p.payload.url,
            },
          ]
        : [],
    ),
    shares: data.shares.outgoing.map((s) => ({ folder: folderName.get(s.folderId) ?? s.folderId, with: s.label, createdAt: s.createdAt, acceptedAt: s.acceptedAt })),
    aiSelf: {
      rules: data.self,
      model: data.model ? { provider: data.model.provider, model: data.model.model } : null,
      links: data.askLinks.map((l) => ({ label: l.label, createdAt: l.createdAt, expiresAt: l.expiresAt, uses: l.uses, answered: l.answered, revokedAt: l.revokedAt })),
    },
    thinking: data.thinking,
    legacy: data.legacy.record
      ? {
          owner: data.legacy.record.owner,
          periodDays: data.legacy.record.periodDays,
          threshold: data.legacy.record.threshold,
          people: data.legacy.record.people.map((p) => ({ label: p.label, folders: p.folderIds.map((id) => folderName.get(id) ?? id), aiSelf: p.self, added: p.publicKey ? ("vault code" as const) : ("invite" as const) })),
        }
      : null,
    namedIn: data.trusted.flatMap((t) => (t.note ? [{ owner: t.note.owner, as: t.note.label, folders: t.note.folders }] : [])),
    agents: data.agents.map((a) => {
      const app = data.apps.find((x) => x.id === a.appId);
      return { name: app?.name ?? "Removed agent", ownFolder: folderName.get(a.homeFolderId) ?? null, rules: a.rules, revokedAt: app?.revokedAt ?? null };
    }),
    spaces: data.spaces.map((sp) => ({
      name: sp.name,
      role: sp.me.role,
      members: sp.members.map((m) => ({ name: m.label, kind: m.kind, role: m.role })),
      memories: sp.memories.map((m) => ({ title: m.title, body: m.body, editedAt: m.editedAt })),
    })),
    devices: data.keyslots.filter((k) => k.kind === "device").map((k) => ({ addedAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
    certificates: data.certificates.map((c) => ({ link: `/verify?certificate=${c.id}`, from: c.summary.from, to: c.summary.to, createdAt: c.createdAt })),
    sync: data.sync.map((x) => ({
      service: x.state?.kind ?? "unreadable",
      account: x.state?.account ?? "",
      folder: folderName.get(x.folderId) ?? x.folderId,
      paused: x.paused,
      lastSyncAt: x.lastSyncAt,
      inBackground: !!x.appId,
    })),
    publicSelf: data.publicSelf
      ? {
          handle: data.publicSelf.handle,
          name: data.publicSelf.name,
          greeting: data.publicSelf.greeting,
          enabled: data.publicSelf.enabled,
          folders: (data.publicSelf.secret?.folderIds ?? []).map((id) => folderName.get(id) ?? id),
          perVisitorHour: data.publicSelf.perVisitorHour,
          answers: data.publicSelf.wall.map((w) => ({ question: w.question, answer: w.answer, hidden: w.hidden, createdAt: w.createdAt })),
        }
      : null,
    meets: data.meets.map((m) => ({
      with: m.record?.label ?? m.peerName,
      purpose: m.purpose,
      state: m.state,
      createdAt: m.createdAt,
      transcript: m.lines.filter((l) => l.ok).map((l) => ({ turn: l.turn, by: l.mine ? "my AI self" : `${m.peerName}'s AI self`, text: l.text })),
    })),
  };
}

export async function deleteAccount(api: Api): Promise<void> {
  await api.del("account");
}

export async function signOut(api: Api): Promise<void> {
  await api.post("auth/logout");
}

