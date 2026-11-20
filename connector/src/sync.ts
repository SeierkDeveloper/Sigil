// Live sync in the background, on the owner's machine. When the owner lets this
// app sync a source (Gmail, Calendar, Drive or Slack) while the vault is
// closed, the vault wraps the source for this app's key and gives it the key of
// the source's folder. Here the source is opened, the provider is asked for
// what changed, every item is encrypted with the folder key, and only
// ciphertext goes to Sigil. The tokens are refreshed here too, and the new
// copy is sealed again for this app before it is saved.
//
// A provider client type that wants a secret at the token step can be given
// one in this machine's environment (SIGIL_GOOGLE_CLIENT_SECRET,
// SIGIL_SLACK_CLIENT_SECRET). It is never sent to Sigil.

import {
  appKeys,
  decryptHead,
  encryptMemory,
  importKey,
  makeSnippet,
  openFolderWithRaw,
  openGrant,
  openSyncForApp,
  runSyncPass,
  sealSyncForApp,
  SYNC_INFO,
  type OpenFolder,
  type SyncFetch,
  type SyncState,
  type SyncTarget,
} from "@sigil/core";
import type { VaultReader } from "./reader";

interface WireSource {
  id: string;
  folderId: string;
  box: string | null;
  rev: number;
  paused: boolean;
}

interface WireFolder {
  id: string;
  meta: string;
  wrappedKey: string;
}

export interface SyncReport {
  id: string;
  kind: string;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

export function clientSecretFor(kind: SyncState["kind"], env: Record<string, string | undefined> = process.env): string | undefined {
  const v = SYNC_INFO[kind].provider === "google" ? env.SIGIL_GOOGLE_CLIENT_SECRET : env.SIGIL_SLACK_CLIENT_SECRET;
  return v?.trim() || undefined;
}

export class SyncWorker {
  constructor(
    private readonly reader: VaultReader,
    private readonly opts: { fetch?: SyncFetch; env?: Record<string, string | undefined>; now?: () => number } = {},
  ) {}

  /** The sources the owner lets this app sync. Empty when there are none. */
  async sources(): Promise<WireSource[]> {
    const r = await this.reader.request<{ sources: WireSource[] }>("GET", "sync");
    return r.sources;
  }

  private async folder(folderId: string): Promise<OpenFolder> {
    const r = await this.reader.request<{ folders: WireFolder[] }>("GET", "folders");
    const f = r.folders.find((x) => x.id === folderId);
    if (!f) throw new Error("This app was not given the source's folder. Allow background sync again in the vault, under Sync.");
    const wrap = await importKey((await appKeys(this.reader.appSecret)).wrapKey);
    return openFolderWithRaw(f, await openGrant(this.reader.appId, wrap, { folderId: f.id, wrappedKey: f.wrappedKey }));
  }

  /** One pass over every source this app syncs. */
  async runOnce(): Promise<SyncReport[]> {
    const out: SyncReport[] = [];
    for (const src of await this.sources()) {
      if (src.paused || !src.box) continue;
      let state: SyncState | null = null;
      try {
        state = await openSyncForApp(this.reader.appSecret, this.reader.appId, src.id, src.box);
        if (!state) throw new Error("The source could not be read with this app's key.");
        const folder = await this.folder(src.folderId);
        const target = await this.target(src.id, folder);
        const r = await runSyncPass(state, {
          target,
          fetch: this.opts.fetch,
          now: this.opts.now?.(),
          clientSecret: clientSecretFor(state.kind, this.opts.env),
        });
        const rev = Math.max(r.state.rev, src.rev + 1);
        await this.reader.request("PUT", `sync/${src.id}`, { box: await sealSyncForApp(this.reader.appSecret, this.reader.appId, src.id, { ...r.state, rev }), rev });
        out.push({ id: src.id, kind: state.kind, added: r.added, updated: r.updated, removed: r.removed, error: null });
      } catch (err) {
        out.push({ id: src.id, kind: state?.kind ?? "unknown", added: 0, updated: 0, removed: 0, error: (err as Error).message });
      }
    }
    return out;
  }

  /** Writes go through the sync routes: encrypted here with the folder key, only into the source's folder. */
  private async target(sourceId: string, folder: OpenFolder): Promise<SyncTarget> {
    const r = await this.reader.request<{ memories: { id: string; folderId: string; head: string }[] }>("GET", "index");
    const known = new Map<string, { id: string; folderId: string; title: string; snippet: string; editedAt: string; createdAt: string }>();
    for (const m of r.memories) {
      if (m.folderId !== folder.id) continue;
      try {
        const h = await decryptHead(folder, m);
        if (h.source.ref) known.set(`${h.source.kind}\n${h.source.ref}`, { id: m.id, folderId: m.folderId, title: h.title, snippet: h.snippet, editedAt: h.editedAt, createdAt: h.createdAt });
      } catch {
        // Not ours to read.
      }
    }
    return {
      folder,
      existing: (kind, ref) => known.get(`${kind}\n${ref}`) ?? null,
      put: async (memories) => {
        for (let i = 0; i < memories.length; i += 50) {
          const batch = memories.slice(i, i + 50);
          await this.reader.request("POST", `sync/${sourceId}/memories`, { memories: await Promise.all(batch.map((m) => encryptMemory(folder, m))) });
          for (const m of batch) known.set(`${m.source.kind}\n${m.source.ref}`, { id: m.id, folderId: m.folderId, title: m.title, snippet: makeSnippet(m.body), editedAt: m.editedAt, createdAt: m.createdAt });
        }
      },
      remove: async (ids) => {
        await this.reader.request("POST", `sync/${sourceId}/delete`, { ids });
      },
    };
  }

  /** Syncs every few minutes until stopped. */
  async run(opts: { everyMs?: number; signal?: AbortSignal; onReport?: (r: SyncReport[]) => void; onError?: (err: Error) => void } = {}): Promise<void> {
    const every = opts.everyMs ?? 5 * 60_000;
    while (!opts.signal?.aborted) {
      try {
        opts.onReport?.(await this.runOnce());
      } catch (err) {
        opts.onError?.(err as Error);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
}
