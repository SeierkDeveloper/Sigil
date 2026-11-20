// Backups and restoring, on the owner's device. The node builds the vault's
// bundle from the ciphertext it holds; this device signs it with the vault's
// signing key and writes it to the storage the owner chose, with the owner's
// own tokens, which are kept only in the vault's encrypted "backup" setting.
// Restoring runs here too: the bundle is opened with the owner's sign-in and
// checked in full before the node is asked to take it in.

import {
  backendFor,
  backupRecordContext,
  bundleName,
  cleanBackup,
  decodeBoxPublicKey,
  decodeBundle,
  encodeBundle,
  ipfsUrl,
  openAppSecret,
  openBundle,
  openSealedJson,
  openSetting,
  phraseKeys,
  presignS3Get,
  randomId,
  sealBackupForApp,
  sealBundle,
  sealJson,
  sealSetting,
  signRestore,
  unwrapFromBundle,
  vaultCryptoKey,
  vaultSigningKey,
  verifyBundle,
  walletKeys,
  EMPTY_BACKUP,
  type BackupPlace,
  type BackupRecord,
  type BackupSettings,
  type BoxKeyPair,
  type BundleBody,
  type S3Target,
  type VaultBundle,
} from "@sigil/core";
import type { Api, Fetcher } from "./api";
import type { AppView, Unlocked, VaultData } from "./ops";

export interface ServerBackups {
  runs: { id: string; byApp: string | null; hash: string; size: number; record: string; createdAt: string }[];
  apps: string[];
}

export interface BackupRunView {
  id: string;
  byApp: string | null;
  hash: string;
  size: number;
  createdAt: string;
  /** Where it went, opened on this device. Null if the record would not open. */
  record: BackupRecord | null;
}

export interface BackupView {
  settings: BackupSettings;
  runs: BackupRunView[];
  /** Connectors that back the vault up while they watch. */
  apps: string[];
}

export const NO_BACKUPS: BackupView = { settings: EMPTY_BACKUP, runs: [], apps: [] };

export async function openBackups(vault: Unlocked, box: BoxKeyPair | null, envelope: string | undefined, server: ServerBackups | undefined): Promise<{ backups: BackupView; unreadable: number }> {
  let unreadable = 0;
  let settings = EMPTY_BACKUP;
  if (envelope) {
    try {
      settings = cleanBackup(await openSetting(vault.key, "backup", envelope));
    } catch {
      unreadable++;
    }
  }
  const runs = (server?.runs ?? []).map((r) => {
    let record: BackupRecord | null = null;
    try {
      if (box) record = openSealedJson<BackupRecord>(box, r.record, backupRecordContext(r.id));
    } catch {
      record = null;
    }
    return { id: r.id, byApp: r.byApp, hash: r.hash, size: r.size, createdAt: r.createdAt, record };
  });
  return { backups: { settings, runs, apps: server?.apps ?? [] }, unreadable };
}

export async function saveBackupSettings(api: Api, vault: Unlocked, settings: BackupSettings): Promise<BackupSettings> {
  const clean = cleanBackup(settings);
  await api.put("settings/backup", { value: await sealSetting(vault.key, "backup", clean) });
  return clean;
}

/** The vault as a bundle: built by the node from its ciphertext, signed here with the vault's key. */
export async function makeBundle(api: Api, vault: Unlocked): Promise<VaultBundle> {
  const { body } = await api.get<{ body: BundleBody }>("bundle");
  const bundle = sealBundle(body, await vaultSigningKey(vault.raw));
  // The node made it, so it is opened here before it is stored: a part that does not open is caught now, not on the day of a restore.
  const opened = await openBundle(bundle, vault.raw);
  if (opened.unreadable) throw new Error(`${opened.unreadable} parts of the bundle did not open with your key. Nothing was stored.`);
  return bundle;
}

export interface BackupResult {
  bundle: VaultBundle;
  bytes: Uint8Array;
  name: string;
  record: BackupRecord;
}

/**
 * Makes a bundle and writes it to every chosen target from this device, then
 * logs it with a record of where it went, sealed to the vault public key. With
 * `download`, the file is also saved on this device.
 */
export async function runBackup(
  api: Api,
  vault: Unlocked,
  data: Pick<VaultData, "boxPublic" | "backups">,
  opts: { fetcher?: Fetcher; download?: (bytes: Uint8Array, name: string) => void; targets?: string[] } = {},
): Promise<BackupResult> {
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  const bundle = await makeBundle(api, vault);
  const bytes = encodeBundle(bundle);
  const name = bundleName(bundle.hash);
  const places: BackupPlace[] = [];
  const failed: BackupRecord["failed"] = [];
  const at = new Date().toISOString();
  if (opts.download) {
    opts.download(bytes, name);
    places.push({ targetId: "file", kind: "file", label: "A file on this device", ref: name, url: null, at });
  }
  const targets = data.backups.settings.targets.filter((t) => !opts.targets || opts.targets.includes(t.id));
  for (const t of targets) {
    try {
      places.push(await backendFor(t, opts.fetcher).put(bytes, name));
    } catch (err) {
      failed.push({ targetId: t.id, label: t.label, reason: (err as Error).message });
    }
  }
  const record: BackupRecord = { v: 1, hash: bundle.hash, size: bytes.length, places, failed, by: "vault" };
  const id = randomId();
  await api.post("backups", { id, hash: bundle.hash, size: bytes.length, record: sealJson(decodeBoxPublicKey(data.boxPublic), record, backupRecordContext(id)), places: places.length });
  return { bundle, bytes, name, record };
}

/** The latest backup that reached at least one place, for the schedule. */
export function lastBackupAt(b: BackupView): string | null {
  return b.runs.find((r) => !r.record || r.record.places.length > 0)?.createdAt ?? null;
}

/** Lets a connector back the vault up while it watches: the targets, wrapped for that app's key only. */
export async function setConnectorBackup(api: Api, vault: Unlocked, data: Pick<VaultData, "boxPublic" | "backups">, app: Pick<AppView, "id" | "secret">, enabled: boolean): Promise<void> {
  if (!enabled) {
    await api.del(`apps/${app.id}/backup`);
    return;
  }
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  const secret = await openAppSecret(vault.key, app);
  const s = data.backups.settings;
  await api.put(`apps/${app.id}/backup`, { box: await sealBackupForApp(secret, app.id, { v: 1, targets: s.targets, every: s.every, boxPublic: data.boxPublic }) });
}

/** After the targets or the schedule change, every connector that backs up gets them again. */
export async function refreshConnectorBackups(api: Api, vault: Unlocked, data: Pick<VaultData, "boxPublic" | "backups" | "apps">): Promise<void> {
  for (const id of data.backups.apps) {
    const app = data.apps.find((a) => a.id === id && !a.revokedAt);
    if (app) await setConnectorBackup(api, vault, data, app, true);
  }
}

// ---------------------------------------------------------------- restoring

export type RestoreSource =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "url"; url: string }
  | { kind: "ipfs"; cid: string; gateway: string }
  | { kind: "arweave"; id: string; gateway: string }
  | { kind: "s3"; target: S3Target; key: string };

/** The address a source is read from. A bucket's address is presigned here, so the keys never leave this device. */
export function sourceUrl(s: Exclude<RestoreSource, { kind: "file" }>): string {
  if (s.kind === "url") return s.url.trim();
  if (s.kind === "ipfs") return ipfsUrl(s.gateway, s.cid.trim());
  if (s.kind === "arweave") return `${s.gateway.replace(/\/+$/, "")}/${s.id.trim()}`;
  return presignS3Get(s.target, s.key.trim());
}

/** Reads a bundle: a file on this device, or an address the node fetches (it cannot open what it fetches). */
export async function loadBundle(source: RestoreSource, fetcher: Fetcher = (i, init) => fetch(i, init)): Promise<VaultBundle> {
  if (source.kind === "file") return decodeBundle(source.bytes);
  const res = await fetcher("/api/restore/fetch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: sourceUrl(source) }) });
  if (!res.ok) {
    let msg = `The bundle could not be fetched (${res.status}).`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // keep the plain message
    }
    throw new Error(msg);
  }
  return decodeBundle(new Uint8Array(await res.arrayBuffer()));
}

export type RestoreSignIn = { kind: "phrase"; phrase: string } | { kind: "wallet"; address: string; signature: string };

export interface OpenedForRestore {
  vault: Unlocked;
  signIn: { kind: "wallet" | "phrase"; ref: string; authToken: string };
  /** What opened: every folder, memory and setting under the vault key. */
  opened: Awaited<ReturnType<typeof openBundle>>;
}

/** Opens the bundle with the owner's sign-in, on this device, and checks every part of it. */
export async function openForRestore(bundle: VaultBundle, how: RestoreSignIn): Promise<OpenedForRestore> {
  const checked = verifyBundle(bundle);
  if (!checked.ok) throw new Error(`This bundle did not pass its checks: ${checked.checks.find((c) => !c.ok)?.detail}`);
  let raw: Uint8Array;
  let signIn: OpenedForRestore["signIn"];
  if (how.kind === "phrase") {
    const pk = await phraseKeys(how.phrase);
    raw = await unwrapFromBundle(bundle, "phrase", pk.lookupId, pk.kek);
    signIn = { kind: "phrase", ref: pk.lookupId, authToken: pk.authToken };
  } else {
    const wk = await walletKeys(how.address, how.signature);
    raw = await unwrapFromBundle(bundle, "wallet", how.address.toLowerCase(), wk.kek);
    signIn = { kind: "wallet", ref: how.address.toLowerCase(), authToken: wk.authToken };
  }
  const opened = await openBundle(bundle, raw);
  if (opened.unreadable) throw new Error(`${opened.unreadable} parts of this bundle did not open with your key. It was not restored.`);
  return { vault: { raw, key: await vaultCryptoKey(raw) }, signIn, opened };
}

export interface RestoreResult {
  report: { userId: string; hash: string; folders: number; memories: number; logEntries: number; taken: Record<string, number>; left: Record<string, number> };
  confirmed: boolean | null;
}

/** Asks this node to take the bundle in, with a restore statement signed for this node. */
export async function restoreHere(api: Api, opened: OpenedForRestore, bundle: VaultBundle, origin: string, arrival?: { code: string; at: string; signature: string; redirectDays: number }): Promise<RestoreResult> {
  const issuedAt = new Date().toISOString();
  const signature = signRestore(await vaultSigningKey(opened.vault.raw), { origin, bundle: bundle.hash, issuedAt });
  return api.post<RestoreResult>("restore", { bundle, signIn: opened.signIn, statement: { issuedAt, signature }, ...(arrival ? { arrival } : {}) });
}
