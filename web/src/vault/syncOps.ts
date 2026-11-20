// Live sync on the owner's device: connecting a source with OAuth (PKCE, in a
// small window that hands the code back to this page), keeping the source's
// state encrypted with the vault key, running passes while the vault is open,
// pausing, disconnecting (which deletes the stored tokens), and letting a
// connector carry on in the background.
//
// The browser talks to Google and Slack directly with the owner's own tokens.
// What reaches Sigil is the encrypted state and encrypted memories.

import {
  AAD,
  appKeys,
  authorizeUrl,
  encryptBytes,
  exchangeCode,
  importKey,
  makeSnippet,
  newerState,
  newPkce,
  openAppSecret,
  openSyncForApp,
  openSyncState,
  randomId,
  runSyncPass,
  SYNC_INFO,
  sealSyncForApp,
  sealSyncState,
  type Memory,
  type OpenFolder,
  type SyncFetch,
  type SyncKind,
  type SyncState,
  type SyncTarget,
} from "@sigil/core";
import type { Api } from "./api";
import { deleteMemories, storedForSave, type AppView, type Unlocked, type VaultData } from "./ops";

export interface ServerSource {
  id: string;
  folderId: string;
  ownerBox: string;
  ownerRev: number;
  appId: string | null;
  appBox: string | null;
  appRev: number;
  paused: boolean;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface SyncSourceView {
  id: string;
  folderId: string;
  /** The newer of the vault's and the connector's copy, opened here. Null when it would not open. */
  state: SyncState | null;
  ownerRev: number;
  appId: string | null;
  appRev: number;
  paused: boolean;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface SyncClients {
  google: string | null;
  slack: string | null;
}

export const CONNECT_PATH = "/vault/connect";

export async function openSources(vault: Unlocked, apps: Pick<AppView, "id" | "secret">[], sources: ServerSource[]): Promise<{ sources: SyncSourceView[]; unreadable: number }> {
  let unreadable = 0;
  const out: SyncSourceView[] = [];
  for (const s of sources) {
    let mine: SyncState | null = null;
    let theirs: SyncState | null = null;
    try {
      mine = await openSyncState(vault.key, s.id, s.ownerBox);
    } catch {
      unreadable++;
    }
    const app = s.appId ? apps.find((a) => a.id === s.appId) : undefined;
    if (app && s.appBox) {
      try {
        theirs = await openSyncForApp(await openAppSecret(vault.key, app), app.id, s.id, s.appBox);
      } catch {
        theirs = null;
      }
    }
    out.push({ id: s.id, folderId: s.folderId, state: newerState(mine, theirs), ownerRev: s.ownerRev, appId: s.appId, appRev: s.appRev, paused: s.paused, lastSyncAt: s.lastSyncAt, createdAt: s.createdAt });
  }
  return { sources: out, unreadable };
}

export async function loadClients(api: Api): Promise<SyncClients> {
  return (await api.get<{ clients: SyncClients }>("sync/config")).clients;
}

// ---------------------------------------------------------------- connecting

export interface ConnectResult {
  code: string;
  state: string;
}

/** What the small window posts back to the vault page. */
export interface ConnectMessage {
  type: "sigil-connect";
  code: string | null;
  state: string | null;
  error: string | null;
}

/**
 * Opens the provider's sign-in in a small window and waits for the code. The
 * window lands on /vault/connect, which hands the code to this page (same
 * origin only, by postMessage to its opener and on a same-origin broadcast
 * channel, since a provider's page may cut the link to the opener) and closes.
 * The verifier never leaves this page.
 */
export function signInWindow(url: string, state: string, opts: { open?: (url: string) => Window | null; timeoutMs?: number } = {}): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const win = (opts.open ?? ((u) => window.open(u, "sigil-connect", "width=520,height=720")))(url);
    if (!win) {
      reject(new Error("The sign-in window was blocked. Allow pop-ups for this site and try again."));
      return;
    }
    let done = false;
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CONNECT_CHANNEL);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      channel?.close();
      window.clearTimeout(timer);
      fn();
    };
    const take = (m: ConnectMessage | null | undefined) => {
      if (!m || m.type !== "sigil-connect" || m.state !== state) return;
      finish(() => (m.code ? resolve({ code: m.code, state }) : reject(new Error(m.error ? `The service said: ${m.error}.` : "The sign-in was cancelled."))));
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin) take(e.data as ConnectMessage);
    };
    window.addEventListener("message", onMessage);
    if (channel) channel.onmessage = (e) => take(e.data as ConnectMessage);
    const timer = window.setTimeout(() => finish(() => reject(new Error("The sign-in took too long. Try again."))), opts.timeoutMs ?? 10 * 60_000);
  });
}

export const CONNECT_CHANNEL = "sigil-connect";

export interface ConnectInput {
  kind: SyncKind;
  clientId: string;
  folder: OpenFolder;
  origin: string;
  /** Opens the window and returns the code; tests pass their own. */
  authorize?: (url: string, state: string) => Promise<ConnectResult>;
  fetch?: SyncFetch;
}

/** Connects a source: OAuth with PKCE on this device, then the state is encrypted with the vault key and saved. */
export async function connectSource(api: Api, vault: Unlocked, input: ConnectInput): Promise<SyncSourceView> {
  const pkce = newPkce();
  const redirectUri = `${input.origin.replace(/\/$/, "")}${CONNECT_PATH}`;
  const url = authorizeUrl({ kind: input.kind, clientId: input.clientId, redirectUri, pkce });
  const { code } = await (input.authorize ?? signInWindow)(url, pkce.state);
  const { tokens, account } = await exchangeCode({ kind: input.kind, clientId: input.clientId, redirectUri, code, verifier: pkce.verifier, fetch: input.fetch });
  const id = randomId();
  const state: SyncState = { v: 1, kind: input.kind, folderId: input.folder.id, clientId: input.clientId, tokens, cursor: null, account, rev: 1, last: null };
  await api.post("sync", { id, folderId: input.folder.id, ownerBox: await sealSyncState(vault.key, id, state), rev: 1 });
  return { id, folderId: input.folder.id, state, ownerRev: 1, appId: null, appRev: 0, paused: false, lastSyncAt: null, createdAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- a pass, on this device

/** Where a pass in the vault writes: on the memory that holds the same source and ref anywhere in the vault, otherwise into the source's folder. */
export function vaultTarget(api: Api, data: Pick<VaultData, "folders" | "memories" | "thinking">, folder: OpenFolder, onSaved: (m: Memory[], removed: string[]) => void): SyncTarget {
  const byRef = new Map<string, Memory>();
  for (const m of data.memories) if (m.source.ref) byRef.set(`${m.source.kind}\n${m.source.ref}`, m);
  const folders = new Map(data.folders.map((f) => [f.id, f]));
  return {
    folder,
    existing: (kind, ref) => {
      const m = byRef.get(`${kind}\n${ref}`);
      return m && folders.has(m.folderId) ? { id: m.id, folderId: m.folderId, title: m.title, snippet: makeSnippet(m.body), editedAt: m.editedAt, createdAt: m.createdAt } : null;
    },
    put: async (memories) => {
      for (let i = 0; i < memories.length; i += 100) {
        const batch = memories.slice(i, i + 100);
        await api.put("memories", {
          memories: await Promise.all(batch.map((m) => storedForSave(folders.get(m.folderId) ?? folder, m, data.thinking.graceDays))),
        });
        for (const m of batch) byRef.set(`${m.source.kind}\n${m.source.ref}`, m);
        onSaved(batch, []);
      }
    },
    remove: async (ids) => {
      await deleteMemories(api, ids);
      onSaved([], ids);
    },
  };
}

/** Saves a source's state: the vault's copy, and the connector's too when one syncs it in the background. */
export async function saveState(api: Api, vault: Unlocked, data: Pick<VaultData, "apps">, source: SyncSourceView, state: SyncState, synced = false): Promise<SyncSourceView> {
  const rev = Math.max(state.rev, source.ownerRev + 1, source.appRev + 1);
  const next = { ...state, rev };
  const body: Record<string, unknown> = { ownerBox: await sealSyncState(vault.key, source.id, next), rev, synced };
  const app = source.appId ? data.apps.find((a) => a.id === source.appId && !a.revokedAt) : undefined;
  if (app) {
    body.appBox = await sealSyncForApp(await openAppSecret(vault.key, app), app.id, source.id, next);
    body.appRev = rev;
  }
  await api.put(`sync/${source.id}`, body);
  return { ...source, state: next, ownerRev: rev, appRev: app ? rev : source.appRev, lastSyncAt: synced ? new Date().toISOString() : source.lastSyncAt };
}

export interface PassReport {
  added: number;
  updated: number;
  removed: number;
  more: boolean;
}

export async function syncNow(
  api: Api,
  vault: Unlocked,
  data: VaultData,
  source: SyncSourceView,
  opts: { fetch?: SyncFetch; onSaved?: (m: Memory[], removed: string[]) => void } = {},
): Promise<{ source: SyncSourceView; report: PassReport }> {
  if (!source.state) throw new Error("This source could not be opened with your vault key.");
  const folder = data.folders.find((f) => f.id === source.folderId);
  if (!folder) throw new Error("The folder this source writes to is gone. Disconnect it and connect it again.");
  try {
    const r = await runSyncPass(source.state, { target: vaultTarget(api, data, folder, opts.onSaved ?? (() => undefined)), fetch: opts.fetch });
    return { source: await saveState(api, vault, data, source, r.state, true), report: { added: r.added, updated: r.updated, removed: r.removed, more: r.more } };
  } catch (err) {
    const failed: SyncState = { ...source.state, rev: source.state.rev + 1, last: { at: new Date().toISOString(), added: 0, updated: 0, removed: 0, error: (err as Error).message } };
    await saveState(api, vault, data, source, failed).catch(() => undefined);
    throw err;
  }
}

export async function pauseSource(api: Api, id: string, paused: boolean): Promise<void> {
  await api.post(`sync/${id}/pause`, { paused });
}

/** Disconnects: the server deletes the source and both encrypted copies of its tokens. The memories it made stay. */
export async function disconnectSource(api: Api, id: string): Promise<void> {
  await api.del(`sync/${id}`);
}

/** Lets a connector keep the source in sync while the vault is closed: its own copy of the state and the folder key, wrapped for that app. */
export async function allowBackground(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView, app: Pick<AppView, "id" | "secret">): Promise<void> {
  if (!source.state) throw new Error("This source could not be opened with your vault key.");
  const folder = data.folders.find((f) => f.id === source.folderId);
  if (!folder) throw new Error("The folder this source writes to is gone.");
  const secret = await openAppSecret(vault.key, app);
  const rev = Math.max(source.ownerRev, source.appRev) + 1;
  const wrap = await importKey((await appKeys(secret)).wrapKey);
  await api.put(`sync/${source.id}/app`, {
    appId: app.id,
    appBox: await sealSyncForApp(secret, app.id, source.id, { ...source.state, rev }),
    appRev: rev,
    wrappedKey: await encryptBytes(wrap, folder.raw, AAD.appFolderKey(app.id, folder.id)),
  });
}

export async function stopBackground(api: Api, id: string): Promise<void> {
  await api.del(`sync/${id}/app`);
}

export function syncLabel(kind: SyncKind): string {
  return SYNC_INFO[kind].label;
}
