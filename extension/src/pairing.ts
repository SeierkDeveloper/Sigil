// Pairing the extension with a vault, and sending suggestions to it.
//
// The extension holds one app key, made in the vault's Apps screen with
// "May suggest memories" on. Before it seals anything it checks the vault
// public key against the tag the vault made with that key's own secret (in the
// core client), so a server cannot slip in a key of its own. Every suggestion
// is sealed here, in the browser, and reaches the server as a sealed box.

import { ClientError, parseAppKey, VaultClient, type Fetcher, type ProposalDraft } from "@sigil/core";

export interface Settings {
  baseUrl: string;
  appKey: string;
}

/** Where settings live. chrome.storage.local in the extension; a map in tests. */
export interface SettingsStore {
  get(): Promise<Settings | null>;
  set(s: Settings): Promise<void>;
  clear(): Promise<void>;
}

export function chromeStore(): SettingsStore {
  return {
    async get() {
      const r = await chrome.storage.local.get(["baseUrl", "appKey"]);
      return typeof r.baseUrl === "string" && typeof r.appKey === "string" ? { baseUrl: r.baseUrl, appKey: r.appKey } : null;
    },
    async set(s) {
      await chrome.storage.local.set(s);
    },
    async clear() {
      await chrome.storage.local.remove(["baseUrl", "appKey"]);
    },
  };
}

export function cleanBaseUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Enter the full address of your Sigil site, starting with https://.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("The address must start with https:// (or http://localhost for a vault on this computer).");
  return u.origin;
}

function client(s: Settings, fetcher?: Fetcher): VaultClient {
  return new VaultClient({ appKey: s.appKey, baseUrl: s.baseUrl, via: "extension", fetcher });
}

/** Checks the app key against the vault and keeps it. Throws with a plain reason if it cannot. */
export async function pair(store: SettingsStore, baseUrlInput: string, appKey: string, fetcher?: Fetcher): Promise<Settings> {
  const s = { baseUrl: cleanBaseUrl(baseUrlInput), appKey: appKey.trim() };
  parseAppKey(s.appKey);
  try {
    await client(s, fetcher).inboxKey();
  } catch (err) {
    if (err instanceof ClientError && err.code === "propose_off") {
      throw new Error("This app key may not suggest memories. In your vault, open Apps, choose Permissions for it and turn on suggestions.");
    }
    throw err;
  }
  await store.set(s);
  return s;
}

/** Seals and sends each draft. Returns how many arrived. */
export async function send(store: SettingsStore, drafts: ProposalDraft[], fetcher?: Fetcher): Promise<number> {
  const s = await store.get();
  if (!s) throw new Error("Pair the extension with your vault first: open its options and paste an app key.");
  const c = client(s, fetcher);
  let sent = 0;
  for (const d of drafts) {
    await c.propose(d);
    sent++;
  }
  return sent;
}
