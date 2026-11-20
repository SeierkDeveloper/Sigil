// A vault bundle: the whole vault as ciphertext, in one file that any Sigil
// node can take in. It holds only what the server already holds (envelopes,
// sealed boxes, wrapped keys, hashes, public keys) plus the proofs of the
// sealed log, so nothing in it opens without the owner's keys.
//
//   body       every part of the vault, as listed in BundleBody
//   hash       hex32(SHA-256("sigil-vault-bundle-v1" \n canonical JSON of the body))
//   signature  Ed25519 by the vault's signing key over the same bytes, when the
//              owner's device made the bundle; null when a connector made it
//   mac        when a connector made it: HMAC-SHA256 over the same bytes with a
//              key from that app's own secret, which only the app and the vault
//              (where the app's secret is kept under the vault key) can make
//
// A bundle is checked in two steps. Anyone can check its form, its hash and
// its signature (verifyBundle). The owner, holding the vault key, can open it
// (openBundle): every folder key unwraps, every memory and setting decrypts
// under the key and record it claims, and the box key matches its public half.
// A bundle is written to a file as gzip of its JSON.
//
// Restoring it on a node needs the owner's sign-in: the recovery phrase or a
// wallet unwraps the vault key from the bundle's own key slot on the device,
// and the device signs a restore statement for that node with the signing key.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Gunzip, gzipSync } from "fflate";
import { decryptBytes, decryptJson, hkdf, importKey } from "./crypto";
import { equalBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding";
import { AAD, unwrapVaultKey, type KeyslotKind } from "./keys";
import { openBoxKey } from "./box";
import { canonicalJson, isSigningKey, signingFingerprint, vaultSigningKey, type CertificateCheck, type SigningKey } from "./life";
import { hex32, READ_KINDS, type ReadKind } from "./merkle";
import { isSettingName } from "./settings";
import { decryptHead, decryptMemory, openFolder, type StoredMemory } from "./vault";

export const BUNDLE_FORMAT = "sigil-vault-bundle";
export const BUNDLE_VERSION = 1;
/** A bundle file is refused above this size when it is read back. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export type BundleKeyslotKind = Exclude<KeyslotKind, "device">;

export interface BundleKeyslot {
  kind: BundleKeyslotKind;
  /** The wallet address, the phrase's lookup id or the passkey's credential id. */
  ref: string;
  /** SHA-256 of the sign-in token, as the node keeps it; null for a passkey. */
  authHash: string | null;
  wrappedKey: string;
  /** A passkey works again only on a node with the same domain. */
  passkey?: { publicKey: string; counter: number; transports: string[] };
}

export interface BundleFolder {
  id: string;
  meta: string;
  wrappedKey: string;
  protected: boolean;
  createdAt: string;
}

export interface BundleMemory {
  id: string;
  folderId: string;
  head: string;
  body: string;
  deleteAfter: string | null;
  updatedAt: string;
}

export interface BundleLogEntry {
  id: string;
  appId: string;
  kind: ReadKind;
  memoryId: string | null;
  count: number;
  at: string;
  salt: string;
  leaf: string;
  hour: number;
  note: string | null;
  /** Where the entry was sealed: the node, the root of its hour and the path to it. Null when it was not sealed yet. */
  seal: { origin: string; periodSeconds: number; root: string; index: number; proof: string[] } | null;
}

/** The parts of a vault the node keeps in tables of its own, each as the node stores it: ids, envelopes, sealed boxes and public keys. */
export type BundleRows = Record<string, unknown>[];

export interface BundleBody {
  /** Where the bundle was made, and how long that node's seal periods are. */
  origin: string;
  periodSeconds: number;
  createdAt: string;
  madeBy: "vault" | "connector";
  vault: {
    /** The vault's X25519 public key and its private half under the vault key. */
    boxPublicKey: string;
    boxWrappedSecret: string;
    /** The vault's Ed25519 signing key. The bundle's signature, if any, is made with it. */
    signKey: string;
    createdAt: string;
  };
  keyslots: BundleKeyslot[];
  folders: BundleFolder[];
  memories: BundleMemory[];
  /** Each vault setting, an envelope under the vault key, by name. */
  settings: Record<string, string>;
  log: BundleLogEntry[];
  /** The rest, as the node stores it. A node takes in what it knows and reports the rest. */
  parts: {
    apps: BundleRows;
    legacy: BundleRows;
    spaces: BundleRows;
    publicSelf: BundleRows;
    askLinks: BundleRows;
    packs: BundleRows;
    emergency: BundleRows;
    proposals: BundleRows;
    drafts: BundleRows;
    disclosures: BundleRows;
    certificates: BundleRows;
    sync: BundleRows;
    identity: BundleRows;
    nodes: BundleRows;
    captureKeys: BundleRows;
    sessions: BundleRows;
    backups: BundleRows;
  };
}

export const BUNDLE_PARTS = [
  "apps",
  "legacy",
  "spaces",
  "publicSelf",
  "askLinks",
  "packs",
  "emergency",
  "proposals",
  "drafts",
  "disclosures",
  "certificates",
  "sync",
  "identity",
  "nodes",
  "captureKeys",
  "sessions",
  "backups",
] as const satisfies readonly (keyof BundleBody["parts"])[];

export interface VaultBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  body: BundleBody;
  hash: string;
  signature: string | null;
  /** A connector's bundle: the app that made it and its HMAC over the body. */
  mac?: { appId: string; tag: string } | null;
}

function bundleMessage(body: BundleBody): Uint8Array {
  return utf8(`${BUNDLE_FORMAT}-v1\n${canonicalJson(body)}`);
}

export function bundleHash(body: BundleBody): string {
  return hex32(sha256(bundleMessage(body)));
}

/** Seals the body made by the node: its hash, and the vault's signature when the owner's device holds the signing key. */
export function sealBundle(body: BundleBody, key: SigningKey | null): VaultBundle {
  if (key && key.publicKey !== body.vault.signKey) throw new Error("This bundle belongs to another vault.");
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    body,
    hash: bundleHash(body),
    signature: key ? toBase64Url(ed25519.sign(bundleMessage(body), key.seed)) : null,
  };
}

/** The key a connector's bundles are authenticated with: from the app's own secret, for this purpose only. */
export async function bundleMacKey(appSecret: Uint8Array): Promise<Uint8Array> {
  return hkdf(appSecret, "sigil:bundle-mac:v1");
}

/**
 * Seals a body a connector fetched: its hash and an HMAC with a key from the
 * app's own secret. A connector never holds the vault's signing key; the HMAC
 * lets the owner's device tell, at restore, that the bundle is the one this
 * app made and that nobody on the way (the node, the storage) changed it.
 */
export async function macBundle(body: BundleBody, appId: string, appSecret: Uint8Array): Promise<VaultBundle> {
  const sealed = sealBundle(body, null);
  const tag = hmac(sha256, await bundleMacKey(appSecret), bundleMessage(body));
  return { ...sealed, mac: { appId, tag: toBase64Url(tag) } };
}

// ---------------------------------------------------------------- the file

/** A bundle as bytes: gzip of its JSON. */
export function encodeBundle(bundle: VaultBundle): Uint8Array {
  return gzipSync(utf8(JSON.stringify(bundle)), { level: 6, mtime: 0 });
}

/** Reads a bundle file: gzip or plain JSON. Checks its form only; see verifyBundle. */
export function decodeBundle(bytes: Uint8Array): VaultBundle {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("This file is too large to be a Sigil bundle.");
  let text: string;
  try {
    text = fromUtf8(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipLimited(bytes, MAX_BUNDLE_OPEN_BYTES) : bytes);
  } catch (err) {
    if (err instanceof BundleTooLarge) throw new Error("This file opens to more than a Sigil bundle can hold.");
    throw new Error("This file is not a Sigil bundle: it could not be read.");
  }
  return parseBundle(text);
}

/** The most a bundle file may open to. A small file that unpacks to gigabytes is refused before it fills the memory. */
export const MAX_BUNDLE_OPEN_BYTES = 1024 * 1024 * 1024;

class BundleTooLarge extends Error {}

/** Gunzip that stops as soon as the output passes the limit. */
export function gunzipLimited(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const g = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new BundleTooLarge();
    chunks.push(chunk);
  });
  const step = 64 * 1024;
  for (let i = 0; i < bytes.length; i += step) g.push(bytes.subarray(i, Math.min(bytes.length, i + step)), i + step >= bytes.length);
  if (bytes.length === 0) g.push(new Uint8Array(0), true);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function parseBundle(text: string): VaultBundle {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not a Sigil bundle: it is not valid JSON.");
  }
  const b = v as VaultBundle;
  if (!b || b.format !== BUNDLE_FORMAT || b.version !== BUNDLE_VERSION || !b.body || typeof b.hash !== "string") throw new Error("This is not a Sigil vault bundle.");
  return b;
}

// ---------------------------------------------------------------- checking

export interface BundleSummary {
  origin: string;
  createdAt: string;
  madeBy: "vault" | "connector";
  signKey: string;
  fingerprint: string;
  folders: number;
  memories: number;
  logEntries: number;
  sealedEntries: number;
  /** The sign-in methods it can be restored with on any node. */
  restoreWith: ("wallet" | "phrase")[];
  parts: Record<string, number>;
}

export interface BundleResult {
  ok: boolean;
  checks: CertificateCheck[];
  summary: BundleSummary | null;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const isIso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const isStr = (v: unknown, max = 4_000_000) => typeof v === "string" && v.length <= max;

/** Why the body is not in the bundle format, or null when its shape is right. */
export function bundleShapeError(body: unknown): string | null {
  const b = body as Partial<BundleBody>;
  if (!b || typeof b !== "object") return "The bundle has no body.";
  if (!isStr(b.origin, 300) || !Number.isInteger(b.periodSeconds) || !isIso(b.createdAt)) return "The bundle does not say where and when it was made.";
  if (b.madeBy !== "vault" && b.madeBy !== "connector") return "The bundle does not say who made it.";
  const v = b.vault;
  if (!v || !isStr(v.boxPublicKey, 64) || !isStr(v.boxWrappedSecret, 256) || !isSigningKey(v.signKey) || !isIso(v.createdAt)) return "The bundle has no vault keys.";
  if (!Array.isArray(b.keyslots) || b.keyslots.some((k) => !k || !["passkey", "wallet", "phrase"].includes(k.kind) || !isStr(k.ref, 512) || !isStr(k.wrappedKey, 256))) {
    return "A sign-in method in the bundle is damaged.";
  }
  if (!Array.isArray(b.folders) || b.folders.length === 0 || b.folders.some((f) => !f || !ID.test(f.id) || !isStr(f.meta, 8192) || !isStr(f.wrappedKey, 256))) return "A folder in the bundle is damaged.";
  if (!Array.isArray(b.memories) || b.memories.some((m) => !m || !ID.test(m.id) || !ID.test(m.folderId) || !isStr(m.head, 64_000) || !isStr(m.body))) return "A memory in the bundle is damaged.";
  if (!b.settings || typeof b.settings !== "object" || Object.entries(b.settings).some(([k, x]) => !isSettingName(k) || !isStr(x, 128 * 1024))) return "A setting in the bundle is damaged.";
  if (!Array.isArray(b.log) || b.log.some((e) => !e || !ID.test(e.id) || !READ_KINDS.includes(e.kind) || !/^0x[0-9a-f]{64}$/.test(e.leaf))) return "An entry of the log in the bundle is damaged.";
  if (!b.parts || typeof b.parts !== "object" || BUNDLE_PARTS.some((p) => !Array.isArray((b.parts as Record<string, unknown>)[p]))) return "A part of the bundle is missing.";
  return null;
}

/**
 * Checks what anyone can check without the owner's keys: the form, that the
 * hash covers the body, and the signature when there is one.
 */
export function verifyBundle(bundle: VaultBundle): BundleResult {
  const checks: CertificateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const shape = bundleShapeError(bundle.body);
  add("form", !shape, shape ?? "Every part of the bundle is in the Sigil format.");
  if (shape) return { ok: false, checks, summary: null };
  const body = bundle.body;
  const hashOk = bundleHash(body) === bundle.hash;
  add("hash", hashOk, hashOk ? `The hash ${bundle.hash.slice(0, 18)}... covers the whole bundle.` : "The bundle was changed after it was made.");
  if (bundle.signature === null) {
    add("signature", body.madeBy === "connector", body.madeBy === "connector" ? "Made by a connector, so not signed. Opening it with your vault key checks it." : "The bundle should be signed and is not.");
  } else {
    let ok = false;
    try {
      ok = ed25519.verify(fromBase64Url(bundle.signature), bundleMessage(body), fromBase64Url(body.vault.signKey));
    } catch {
      ok = false;
    }
    add("signature", ok, ok ? `Signed by the vault key ${signingFingerprint(body.vault.signKey)}.` : "The signature does not hold.");
  }
  const parts: Record<string, number> = {};
  for (const p of BUNDLE_PARTS) parts[p] = body.parts[p].length;
  return {
    ok: checks.every((c) => c.ok),
    checks,
    summary: {
      origin: body.origin,
      createdAt: body.createdAt,
      madeBy: body.madeBy,
      signKey: body.vault.signKey,
      fingerprint: signingFingerprint(body.vault.signKey),
      folders: body.folders.length,
      memories: body.memories.length,
      logEntries: body.log.length,
      sealedEntries: body.log.filter((e) => e.seal).length,
      restoreWith: [...new Set(body.keyslots.filter((k) => k.kind !== "passkey" && k.authHash).map((k) => k.kind as "wallet" | "phrase"))],
      parts,
    },
  };
}

// ---------------------------------------------------------------- opening with the owner's keys

/** The vault key from the bundle's own key slot, unwrapped on the device with the key a sign-in gives. */
export async function unwrapFromBundle(bundle: VaultBundle, kind: "wallet" | "phrase", ref: string, kek: Uint8Array): Promise<Uint8Array> {
  const slot = bundle.body.keyslots.find((k) => k.kind === kind && k.ref.toLowerCase() === ref.toLowerCase());
  if (!slot) throw new Error(kind === "phrase" ? "This bundle does not open with that recovery phrase." : "This bundle does not open with that wallet.");
  try {
    return await unwrapVaultKey(kek, slot.wrappedKey, kind);
  } catch {
    throw new Error(kind === "phrase" ? "This bundle does not open with that recovery phrase." : "This bundle does not open with that wallet.");
  }
}

export interface OpenedBundle {
  folders: number;
  memories: number;
  settings: number;
  /** Items that did not open under the record they claim. Zero for a sound bundle. */
  unreadable: number;
}

/**
 * Opens every part the vault key opens: the signing key and box key match,
 * every folder key unwraps and its name decrypts, every memory and setting
 * decrypts. Throws if the bundle belongs to another vault.
 */
export async function openBundle(bundle: VaultBundle, vaultRaw: Uint8Array): Promise<OpenedBundle> {
  const body = bundle.body;
  const signing = await vaultSigningKey(vaultRaw);
  if (signing.publicKey !== body.vault.signKey) throw new Error("This bundle belongs to another vault.");
  const key = await importKey(vaultRaw);
  await assertMadeByThisVault(bundle, key, signing.publicKey);
  await openBoxKey(key, { publicKey: body.vault.boxPublicKey, wrappedSecret: body.vault.boxWrappedSecret });
  let unreadable = 0;
  const folders = new Map<string, Awaited<ReturnType<typeof openFolder>>>();
  for (const f of body.folders) {
    try {
      folders.set(f.id, await openFolder(key, f));
    } catch {
      unreadable++;
    }
  }
  let memories = 0;
  for (const m of body.memories) {
    const folder = folders.get(m.folderId);
    try {
      if (!folder) throw new Error("no folder");
      await decryptHead(folder, m);
      await decryptMemory(folder, m as StoredMemory);
      memories++;
    } catch {
      unreadable++;
    }
  }
  let settings = 0;
  for (const [name, value] of Object.entries(body.settings)) {
    try {
      await decryptJson(key, value, AAD.setting(name));
      settings++;
    } catch {
      unreadable++;
    }
  }
  return { folders: folders.size, memories, settings, unreadable };
}

const CHANGED = "This bundle was changed after it was made, or it was not made by your vault or one of its apps. It cannot be restored.";

/**
 * Whether the whole body is what this vault (or one of its own apps) made:
 * the hash covers it, and the vault's signature holds over it, or, for a
 * connector's bundle, the HMAC holds with the key from the secret of the app
 * named, opened here under the vault key. Anyone who changes a bundle on its
 * way (an app or capture key slipped in, memories left out, a relabelled
 * signer) cannot make either.
 */
async function assertMadeByThisVault(bundle: VaultBundle, key: CryptoKey, signKey: string): Promise<void> {
  const message = bundleMessage(bundle.body);
  if (hex32(sha256(message)) !== bundle.hash) throw new Error(CHANGED);
  if (bundle.signature != null) {
    let ok = false;
    try {
      ok = ed25519.verify(fromBase64Url(bundle.signature), message, fromBase64Url(signKey));
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(CHANGED);
    return;
  }
  const mac = bundle.mac;
  if (bundle.body.madeBy !== "connector" || !mac || typeof mac.appId !== "string" || typeof mac.tag !== "string") throw new Error(CHANGED);
  const app = (bundle.body.parts.apps as unknown as { table: string; row: Record<string, unknown> }[]).find((p) => p && p.table === "apps" && p.row && p.row.id === mac.appId);
  if (!app || typeof app.row.secret !== "string") throw new Error(CHANGED);
  let ok = false;
  try {
    const secret = await decryptBytes(key, app.row.secret, AAD.appSecret(mac.appId));
    ok = equalBytes(hmac(sha256, await bundleMacKey(secret), message), fromBase64Url(mac.tag));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(CHANGED);
}

// ---------------------------------------------------------------- the restore statement

export const RESTORE_WINDOW_MS = 10 * 60_000;

export interface RestoreStatement {
  /** The node the vault is restored on. */
  origin: string;
  bundle: string;
  issuedAt: string;
}

export function restoreMessage(s: RestoreStatement): string {
  return ["sigil-restore-v1", s.origin.replace(/\/$/, ""), s.bundle, s.issuedAt].join("\n");
}

/** Made on the owner's device once the vault key is unwrapped: proof for the node that whoever restores holds the vault. */
export function signRestore(key: SigningKey, s: RestoreStatement): string {
  return toBase64Url(ed25519.sign(utf8(restoreMessage(s)), key.seed));
}

export function verifyRestore(signKey: string, s: RestoreStatement, signature: string, now = Date.now()): boolean {
  const at = Date.parse(s.issuedAt);
  if (!Number.isFinite(at) || Math.abs(now - at) > RESTORE_WINDOW_MS) return false;
  try {
    const sig = fromBase64Url(signature);
    return sig.length === 64 && isSigningKey(signKey) && ed25519.verify(sig, utf8(restoreMessage(s)), fromBase64Url(signKey));
  } catch {
    return false;
  }
}
