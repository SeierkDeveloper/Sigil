// One live sync source, and a pass over it, the same in the browser and in the
// connector.
//
// A source's state (which service, which folder, the tokens, the cursor) is one
// JSON document, encrypted with the vault key before it is saved, and, for a
// connector the owner lets sync in the background, also under a key derived
// from that app's secret. The server keeps the two envelopes and a revision
// number for each, and nothing it can read.
//
// A pass refreshes the access token when it is about to end, asks the provider
// for what changed since the cursor, and writes each item as a memory: on the
// memory that already holds the same thing (same source and ref, from an
// earlier sync or a Takeout import) when there is one, otherwise under an id
// derived from the folder key and the ref, so two devices syncing the same
// thing write the same memory instead of two.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decryptJson, encryptJson, hkdf, importKey } from "../crypto";
import { toBase64Url, utf8 } from "../encoding";
import { AAD, appSyncKey } from "../keys";
import { buildMemory, makeSnippet, type Memory, type OpenFolder, type SourceKind } from "../vault";
import { syncCalendar, syncDrive, syncGmail, type ProviderCtx, type SyncBatch } from "./google";
import { SYNC_INFO, SYNC_KINDS, SyncError, refreshTokens, tokenExpired, type SyncFetch, type SyncKind, type SyncTokens } from "./oauth";
import { syncSlack } from "./slack";

export interface SyncRun {
  at: string;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

export interface SyncState {
  v: 1;
  kind: SyncKind;
  folderId: string;
  clientId: string;
  tokens: SyncTokens;
  cursor: string | null;
  /** The account, as the provider names it (an address or a workspace). */
  account: string;
  /** Goes up with every change, so the newer of two copies wins. */
  rev: number;
  last: SyncRun | null;
  /**
   * "connector": the sign-in was made on the owner's computer by the connector
   * (for a provider that needs a client secret, which a browser cannot keep), and
   * only the connector syncs it. The vault never runs a pass for it.
   */
  via?: "connector";
}

export function cleanSyncState(value: unknown): SyncState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const t = (v.tokens && typeof v.tokens === "object" ? v.tokens : {}) as Record<string, unknown>;
  if (!SYNC_KINDS.includes(v.kind as SyncKind) || typeof v.folderId !== "string" || typeof t.access !== "string") return null;
  const last = v.last && typeof v.last === "object" ? (v.last as SyncRun) : null;
  return {
    v: 1,
    kind: v.kind as SyncKind,
    folderId: v.folderId,
    clientId: String(v.clientId ?? ""),
    tokens: { access: t.access, refresh: typeof t.refresh === "string" ? t.refresh : null, expiresAt: typeof t.expiresAt === "string" ? t.expiresAt : null, scope: String(t.scope ?? "") },
    cursor: typeof v.cursor === "string" ? v.cursor : null,
    account: String(v.account ?? "").slice(0, 200),
    rev: Number.isInteger(v.rev) ? Number(v.rev) : 0,
    last: last ? { at: String(last.at), added: Number(last.added) || 0, updated: Number(last.updated) || 0, removed: Number(last.removed) || 0, error: last.error ? String(last.error) : null } : null,
    ...(v.via === "connector" ? { via: "connector" as const } : {}),
  };
}

/** A source waiting for its sign-in on the owner's computer: no tokens yet, synced only by the connector. */
export function waitingForConnector(kind: SyncKind, folderId: string, clientId: string): SyncState {
  return { v: 1, kind, folderId, clientId, tokens: { access: "", refresh: null, expiresAt: null, scope: "" }, cursor: null, account: "", rev: 1, last: null, via: "connector" };
}

export async function sealSyncState(vaultKey: CryptoKey, sourceId: string, state: SyncState): Promise<string> {
  return encryptJson(vaultKey, state, AAD.syncOwner(sourceId));
}

export async function openSyncState(vaultKey: CryptoKey, sourceId: string, envelope: string): Promise<SyncState | null> {
  return cleanSyncState(await decryptJson(vaultKey, envelope, AAD.syncOwner(sourceId)));
}

export async function sealSyncForApp(appSecret: Uint8Array, appId: string, sourceId: string, state: SyncState): Promise<string> {
  return encryptJson(await importKey(await appSyncKey(appSecret)), state, AAD.syncApp(appId, sourceId));
}

export async function openSyncForApp(appSecret: Uint8Array, appId: string, sourceId: string, envelope: string): Promise<SyncState | null> {
  return cleanSyncState(await decryptJson(await importKey(await appSyncKey(appSecret)), envelope, AAD.syncApp(appId, sourceId)));
}

/** The id a synced thing gets in a folder: an HMAC of its ref under a key from the folder key. Every device with the folder key makes the same one. */
export async function syncMemoryId(folderRaw: Uint8Array, kind: SourceKind, ref: string): Promise<string> {
  const key = await hkdf(folderRaw, "sigil:sync-id");
  return toBase64Url(hmac(sha256, key, utf8(`${kind}\n${ref}`))).slice(0, 22);
}

export interface SyncedMemory {
  id: string;
  folderId: string;
  title: string;
  snippet: string;
  editedAt: string;
  createdAt?: string;
}

/** Where a pass writes. The vault and the connector each provide one. */
export interface SyncTarget {
  folder: Pick<OpenFolder, "id" | "raw">;
  /** A memory in reach that already holds this source and ref, if any. */
  existing(kind: SourceKind, ref: string): Promise<SyncedMemory | null> | SyncedMemory | null;
  /** Encrypts and saves. Each memory names its folder. */
  put(memories: Memory[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export interface PassOptions {
  target: SyncTarget;
  fetch?: SyncFetch;
  now?: number;
  /** Only the connector, on the owner's machine, ever sets this. */
  clientSecret?: string;
  /** Passes to run while the provider says there is more (4 unless set). */
  maxPasses?: number;
}

export interface PassResult {
  state: SyncState;
  added: number;
  updated: number;
  removed: number;
  more: boolean;
}

const PROVIDERS: Record<SyncKind, (ctx: ProviderCtx) => Promise<SyncBatch>> = {
  gmail: syncGmail,
  calendar: syncCalendar,
  drive: syncDrive,
  slack: syncSlack,
};

export async function runSyncPass(start: SyncState, opts: PassOptions): Promise<PassResult> {
  if (!start.tokens.access) throw new SyncError("This source has not been signed in yet. Run the connect command on your computer.", "auth");
  const fetcher = opts.fetch ?? ((i, init) => fetch(i, init));
  const now = opts.now ?? Date.now();
  let state: SyncState = { ...start };
  let refreshed = false;
  const refresh = async () => {
    state = { ...state, tokens: await refreshTokens({ kind: state.kind, clientId: state.clientId, tokens: state.tokens, clientSecret: opts.clientSecret, fetch: fetcher, now }) };
    refreshed = true;
  };
  if (tokenExpired(state.tokens, now)) await refresh();
  const source = SYNC_INFO[state.kind].source;
  let added = 0;
  let updated = 0;
  let removed = 0;
  let more = false;
  const passes = Math.max(1, opts.maxPasses ?? 4);
  for (let i = 0; i < passes; i++) {
    let batch: SyncBatch;
    try {
      batch = await PROVIDERS[state.kind]({ token: state.tokens.access, fetch: fetcher, cursor: state.cursor, now });
    } catch (err) {
      if (err instanceof SyncError && err.code === "auth" && !refreshed && state.tokens.refresh) {
        await refresh();
        batch = await PROVIDERS[state.kind]({ token: state.tokens.access, fetch: fetcher, cursor: state.cursor, now });
      } else throw err;
    }
    const write: Memory[] = [];
    for (const item of batch.items) {
      const ex = await opts.target.existing(source, item.ref);
      const snippet = makeSnippet(item.draft.body);
      if (ex && ex.title === item.draft.title.trim().slice(0, 300) && ex.snippet === snippet && ex.editedAt === item.draft.editedAt) continue;
      const id = ex?.id ?? (await syncMemoryId(opts.target.folder.raw, source, item.ref));
      const memory = buildMemory({ ...item.draft, createdAt: ex?.createdAt ?? item.draft.createdAt }, ex?.folderId ?? opts.target.folder.id, id, new Date(now).toISOString());
      write.push(memory);
      if (ex) updated++;
      else added++;
    }
    if (write.length) await opts.target.put(write);
    const gone: string[] = [];
    for (const ref of batch.removed) {
      const ex = await opts.target.existing(source, ref);
      if (ex) gone.push(ex.id);
    }
    if (gone.length) {
      await opts.target.remove(gone);
      removed += gone.length;
    }
    state = { ...state, cursor: batch.cursor || null, account: batch.account ?? state.account, rev: state.rev + 1 };
    more = batch.more;
    if (!more) break;
  }
  state = { ...state, last: { at: new Date(now).toISOString(), added, updated, removed, error: null } };
  return { state, added, updated, removed, more };
}

/** The newer of the vault's copy and the connector's copy of a source. */
export function newerState(a: SyncState | null, b: SyncState | null): SyncState | null {
  if (!a) return b;
  if (!b) return a;
  return b.rev > a.rev ? b : a;
}
