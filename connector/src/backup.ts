// Backups in the background, on the owner's machine. When the owner lets this
// app back up the vault while it watches, the vault wraps the storage targets
// (with the owner's own tokens) for this app's key only. Here they are opened,
// the node is asked for the vault as a bundle (ciphertext, made by the node),
// the bundle is written to each target from this machine, and a record of
// where it went is sealed to the vault public key and logged. A connector never
// holds the vault key, so its bundles are not signed: each carries an HMAC with
// a key from this app's own secret instead, which the owner's device checks
// (with the app's secret, kept under the vault key) before it restores one.

import {
  backupDue,
  backupRecordContext,
  backendFor,
  bundleName,
  decodeBoxPublicKey,
  encodeBundle,
  openBackupForApp,
  randomId,
  macBundle,
  sealJson,
  type BackupPlace,
  type BackupRecord,
  type BundleBody,
} from "@sigil/core";
import type { VaultReader } from "./reader";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BackupReport {
  hash: string;
  size: number;
  places: BackupPlace[];
  failed: { targetId: string; label: string; reason: string }[];
}

export class BackupWorker {
  constructor(
    private readonly reader: VaultReader,
    private readonly fetcher: Fetch = (i, init) => fetch(i, init),
  ) {}

  /** Whether the owner let this app back up the vault. */
  async allowed(): Promise<boolean> {
    try {
      await this.reader.request("GET", "backup");
      return true;
    } catch {
      return false;
    }
  }

  /** One backup now, when it is due (or always, with force). Null when it was not due. */
  async once(opts: { force?: boolean; now?: number } = {}): Promise<BackupReport | null> {
    const { box, lastAt } = await this.reader.request<{ box: string; lastAt: string | null }>("GET", "backup");
    const settings = await openBackupForApp(this.reader.appSecret, this.reader.appId, box);
    if (!opts.force && !backupDue(settings.every, lastAt, opts.now)) return null;
    if (!settings.targets.length) throw new Error("No storage was chosen for backups. Add a bucket, IPFS or Arweave in the vault, under Storage.");
    const { body } = await this.reader.request<{ body: BundleBody }>("GET", "backup/bundle");
    const bundle = await macBundle(body, this.reader.appId, this.reader.appSecret);
    const bytes = encodeBundle(bundle);
    const name = bundleName(bundle.hash);
    const places: BackupPlace[] = [];
    const failed: BackupReport["failed"] = [];
    for (const target of settings.targets) {
      try {
        places.push(await backendFor(target, this.fetcher).put(bytes, name));
      } catch (err) {
        failed.push({ targetId: target.id, label: target.label, reason: (err as Error).message });
      }
    }
    const runId = randomId();
    const record: BackupRecord = { v: 1, hash: bundle.hash, size: bytes.length, places, failed, by: "connector" };
    await this.reader.request("POST", "backup/done", {
      id: runId,
      hash: bundle.hash,
      size: bytes.length,
      record: sealJson(decodeBoxPublicKey(settings.boxPublic), record, backupRecordContext(runId)),
      places: places.length,
    });
    return { hash: bundle.hash, size: bytes.length, places, failed };
  }

  /** Looks every so often whether a backup is due, until stopped. */
  async run(opts: { everyMs?: number; signal?: AbortSignal; onReport?: (r: BackupReport) => void; onError?: (err: Error) => void } = {}): Promise<void> {
    const every = opts.everyMs ?? 15 * 60_000;
    while (!opts.signal?.aborted) {
      try {
        const r = await this.once();
        if (r) opts.onReport?.(r);
      } catch (err) {
        opts.onError?.(err as Error);
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, every);
        opts.signal?.addEventListener("abort", () => (clearTimeout(t), resolve(null)), { once: true });
      });
    }
  }
}
