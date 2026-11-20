// Sign in with Sigil.
//
// A web app asks for read access to a person's Sigil vault. A window from
// their vault opens; they unlock it, choose which folders the app may read (and
// whether it may suggest memories), and approve. The vault makes an app key for
// this app alone and hands it back to the page that asked, by postMessage to
// that page's exact origin. With the key, the app reads the chosen folders and
// decrypts them here, in the person's browser. Every read lands in their read
// log, and they can revoke the app at any time under Apps.

import { parseAppKey, VaultClient, type FolderInfo, type FullMemory, type ProposalDraft, type SearchResult } from "@sigil/core";

export type { FolderInfo, FullMemory, ProposalDraft, SearchResult };

export class SigilAccessError extends Error {
  constructor(
    message: string,
    public code: "denied" | "closed" | "blocked" | "timeout" | "invalid",
  ) {
    super(message);
    this.name = "SigilAccessError";
  }
}

export interface RequestAccessOptions {
  /** The address of the person's Sigil site, for example https://sigil.example. */
  vault: string;
  /** Your app's name, shown on the consent screen. */
  appName: string;
  /** Also ask to suggest memories to their inbox. They decide. */
  suggest?: boolean;
  /** How long to wait for an answer. Ten minutes by default. */
  timeoutMs?: number;
  /** For tests: the window to open the consent window from. */
  window?: Pick<Window, "open" | "addEventListener" | "removeEventListener" | "location" | "crypto">;
}

export interface Access {
  /** The app key for this app. Keep it as you would a password; it reads what the person allowed. */
  appKey: string;
  /** The vault's origin. */
  vault: string;
}

function randomState(w: Pick<Window, "crypto">): string {
  const bytes = new Uint8Array(24);
  w.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The address of the consent window, for apps that open it themselves. */
export function consentUrl(vault: string, appName: string, origin: string, state: string, suggest = false): string {
  const u = new URL("/vault/authorize", new URL(vault).origin);
  u.searchParams.set("name", appName.trim().slice(0, 60));
  u.searchParams.set("origin", origin);
  u.searchParams.set("state", state);
  if (suggest) u.searchParams.set("suggest", "1");
  return u.toString();
}

/** Opens the consent window and resolves with an app key once the person approves. Call it from a click. */
export function requestAccess(opts: RequestAccessOptions): Promise<Access> {
  const w = opts.window ?? window;
  let vaultOrigin: string;
  try {
    vaultOrigin = new URL(opts.vault).origin;
  } catch {
    return Promise.reject(new SigilAccessError("The vault address is not valid.", "invalid"));
  }
  const state = randomState(w);
  const popup = w.open(consentUrl(vaultOrigin, opts.appName, w.location.origin, state, opts.suggest), "sigil-access", "popup,width=560,height=780");
  if (!popup) return Promise.reject(new SigilAccessError("The browser blocked the Sigil window. Allow pop-ups for this site and try again.", "blocked"));

  return new Promise<Access>((resolve, reject) => {
    const finish = (fn: () => void) => {
      w.removeEventListener("message", onMessage as EventListener);
      clearInterval(watch);
      clearTimeout(timer);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      // Only the vault's own window may answer, and only for this request.
      if (e.origin !== vaultOrigin || !e.data || typeof e.data !== "object" || e.data.state !== state) return;
      if (e.data.type === "sigil:denied") return finish(() => reject(new SigilAccessError("The person did not allow access.", "denied")));
      if (e.data.type !== "sigil:authorized" || typeof e.data.appKey !== "string") return;
      try {
        parseAppKey(e.data.appKey);
      } catch {
        return finish(() => reject(new SigilAccessError("The vault sent a key that is not valid.", "invalid")));
      }
      finish(() => resolve({ appKey: e.data.appKey, vault: vaultOrigin }));
    };
    w.addEventListener("message", onMessage as EventListener);
    const watch = setInterval(() => {
      if (popup.closed) finish(() => reject(new SigilAccessError("The Sigil window was closed before access was given.", "closed")));
    }, 400);
    const timer = setTimeout(() => finish(() => reject(new SigilAccessError("No answer came from the Sigil window in time.", "timeout"))), opts.timeoutMs ?? 600_000);
  });
}

export interface SigilClientOptions {
  vault: string;
  appKey: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Reads what the person allowed, decrypting it here. Each call fetches fresh
 * ciphertext, so a revoked key fails on its next call.
 */
export class SigilClient {
  private readonly client: VaultClient;

  constructor(opts: SigilClientOptions) {
    this.client = new VaultClient({ appKey: opts.appKey, baseUrl: new URL(opts.vault).origin, fetcher: opts.fetch, via: "sdk" });
  }

  /** The folders this app may read, with how many memories each holds. */
  folders(): Promise<FolderInfo[]> {
    return this.client.listFolders();
  }

  /** Searches titles, tags and first lines, here in the browser. */
  search(query: string, opts: { folder?: string; limit?: number } = {}): Promise<SearchResult[]> {
    return this.client.search(query, opts);
  }

  /** Reads whole memories by id. */
  read(ids: string[]): Promise<{ memories: FullMemory[]; missing: string[] }> {
    return this.client.read(ids);
  }

  /** The Self card, if the person gave this app its folder. */
  profile(): Promise<FullMemory | null> {
    return this.client.profile();
  }

  /** Suggests a memory to the person's inbox, sealed here for their vault. Needs their permission. */
  suggest(draft: ProposalDraft): Promise<{ id: string }> {
    return this.client.propose(draft);
  }
}
