// OAuth for live sync, run on the owner's device as a public client.
//
// The authorization code flow with PKCE: the device makes a random verifier,
// sends its SHA-256 (the challenge) with the request, and later proves it holds
// the verifier when it trades the code for tokens. There is no client secret on
// the Sigil server, and the tokens go from the provider straight to the device,
// where they are encrypted with the vault key before anything is saved.
//
// Client ids are public. A site sets them in its environment
// (SIGIL_GOOGLE_CLIENT_ID, SIGIL_SLACK_CLIENT_ID); without one, a source shows
// how to add it and does not pretend to connect. A provider whose client type
// still asks for a secret at the token step (some desktop clients do) can be
// given one in the connector's environment on the owner's own machine; the
// browser flow never sends one.

import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, randomId } from "../crypto";
import { toBase64Url, utf8 } from "../encoding";
import type { SourceKind } from "../vault";

export type SyncProvider = "google" | "slack";
export type SyncKind = "gmail" | "calendar" | "drive" | "slack";

export const SYNC_KINDS: readonly SyncKind[] = ["gmail", "calendar", "drive", "slack"];

export interface SyncKindInfo {
  provider: SyncProvider;
  label: string;
  /** What it reads, in plain words. */
  reads: string;
  scopes: string[];
  source: SourceKind;
  /** The folder a new source suggests. */
  folder: string;
}

export const SYNC_INFO: Record<SyncKind, SyncKindInfo> = {
  gmail: {
    provider: "google",
    label: "Gmail",
    reads: "Mail from the last 90 days, then every new message, one memory per thread. Spam and trash are left out.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    source: "gmail",
    folder: "Mail",
  },
  calendar: {
    provider: "google",
    label: "Google Calendar",
    reads: "The events of your main calendar, one memory each, kept up to date; cancelled events are removed.",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    source: "calendar",
    folder: "Calendar",
  },
  drive: {
    provider: "google",
    label: "Google Drive",
    reads: "Google Docs and text files, as text, one memory per file; trashed files are removed.",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    source: "drive",
    folder: "Drive",
  },
  slack: {
    provider: "slack",
    label: "Slack",
    reads: "Messages in your channels and direct messages from the last 30 days, then every new one, one memory per channel and day.",
    scopes: ["channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read", "mpim:history", "mpim:read", "users:read"],
    source: "slack",
    folder: "Slack",
  },
};

/** What acting in an account adds to reading it: sending mail, and answering invites. */
export const ACT_SCOPES: Partial<Record<SyncKind, string[]>> = {
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
};

/** Whether the tokens carry every scope acting in this kind of source needs. */
export function canAct(kind: SyncKind, scope: string): boolean {
  const want = ACT_SCOPES[kind];
  if (!want) return false;
  const have = scope.split(/[\s,]+/);
  return want.every((s) => have.includes(s));
}

export const PROVIDER_INFO: Record<SyncProvider, { label: string; authorizeUrl: string; tokenUrl: string; env: string }> = {
  google: { label: "Google", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", env: "SIGIL_GOOGLE_CLIENT_ID" },
  slack: { label: "Slack", authorizeUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", env: "SIGIL_SLACK_CLIENT_ID" },
};

/** The addresses the device talks to for live sync. The site's content security policy allows exactly these. */
export const SYNC_ORIGINS = ["https://oauth2.googleapis.com", "https://gmail.googleapis.com", "https://www.googleapis.com", "https://slack.com"] as const;

export type SyncFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class SyncError extends Error {
  constructor(
    message: string,
    public code: "auth" | "gone" | "provider" | "network" | "config" = "provider",
    public status = 0,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

// ---------------------------------------------------------------- PKCE

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** RFC 7636: 32 random bytes as the verifier (43 characters), its SHA-256 as the S256 challenge. */
export function pkceChallenge(verifier: string): string {
  return toBase64Url(sha256(utf8(verifier)));
}

export function newPkce(): Pkce {
  const verifier = toBase64Url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), state: randomId() };
}

export function authorizeUrl(opts: { kind: SyncKind; clientId: string; redirectUri: string; pkce: Pick<Pkce, "challenge" | "state">; act?: boolean }): string {
  const base = SYNC_INFO[opts.kind];
  const info = opts.act && ACT_SCOPES[opts.kind] ? { ...base, scopes: [...base.scopes, ...ACT_SCOPES[opts.kind]!] } : base;
  const provider = PROVIDER_INFO[info.provider];
  const u = new URL(provider.authorizeUrl);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.pkce.state);
  u.searchParams.set("code_challenge", opts.pkce.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (info.provider === "google") {
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", info.scopes.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  } else {
    u.searchParams.set("user_scope", info.scopes.join(","));
  }
  return u.toString();
}

// ---------------------------------------------------------------- tokens

export interface SyncTokens {
  access: string;
  refresh: string | null;
  /** When the access token stops working, or null when it does not expire. */
  expiresAt: string | null;
  scope: string;
}

async function postForm(fetcher: SyncFetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  } catch {
    throw new SyncError("The provider could not be reached.", "network");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false || typeof data.error === "string") {
    const err = String(data.error_description ?? data.error ?? `HTTP ${res.status}`);
    throw new SyncError(`The provider refused the sign-in: ${err}.`, res.status === 400 || res.status === 401 || data.error === "invalid_grant" ? "auth" : "provider", res.status);
  }
  return data;
}

function readTokens(provider: SyncProvider, data: Record<string, unknown>, previous: SyncTokens | null, now: number): { tokens: SyncTokens; account: string } {
  const src = (provider === "slack" && data.authed_user && typeof data.authed_user === "object" ? data.authed_user : data) as Record<string, unknown>;
  const access = typeof src.access_token === "string" ? src.access_token : "";
  if (!access) throw new SyncError("The provider sent no access token.", "auth");
  const expires = Number(src.expires_in);
  const team = data.team && typeof data.team === "object" ? String((data.team as Record<string, unknown>).name ?? "") : "";
  return {
    tokens: {
      access,
      refresh: typeof src.refresh_token === "string" ? src.refresh_token : (previous?.refresh ?? null),
      expiresAt: Number.isFinite(expires) && expires > 0 ? new Date(now + expires * 1000).toISOString() : null,
      scope: String(src.scope ?? previous?.scope ?? ""),
    },
    account: team,
  };
}

export interface ExchangeInput {
  kind: SyncKind;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  /** Only ever set by the connector on the owner's machine, never by the browser or the server. */
  clientSecret?: string;
  fetch?: SyncFetch;
  now?: number;
}

/** Trades the code for tokens, proving the verifier. Runs on the device. */
export async function exchangeCode(input: ExchangeInput): Promise<{ tokens: SyncTokens; account: string }> {
  const provider = SYNC_INFO[input.kind].provider;
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  };
  if (input.clientSecret) form.client_secret = input.clientSecret;
  const data = await postForm(input.fetch ?? ((i, init) => fetch(i, init)), PROVIDER_INFO[provider].tokenUrl, form);
  return readTokens(provider, data, null, input.now ?? Date.now());
}

/** A fresh access token from the refresh token. The refresh token may change too (Slack rotates it). */
export async function refreshTokens(opts: { kind: SyncKind; clientId: string; tokens: SyncTokens; clientSecret?: string; fetch?: SyncFetch; now?: number }): Promise<SyncTokens> {
  if (!opts.tokens.refresh) throw new SyncError("This connection has expired. Connect the source again.", "auth");
  const provider = SYNC_INFO[opts.kind].provider;
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: opts.tokens.refresh, client_id: opts.clientId };
  if (opts.clientSecret) form.client_secret = opts.clientSecret;
  const data = await postForm(opts.fetch ?? ((i, init) => fetch(i, init)), PROVIDER_INFO[provider].tokenUrl, form);
  return readTokens(provider, data, opts.tokens, opts.now ?? Date.now()).tokens;
}

/** True when the access token is gone or ends within a minute. */
export function tokenExpired(tokens: SyncTokens, now = Date.now()): boolean {
  return !!tokens.expiresAt && Date.parse(tokens.expiresAt) - 60_000 <= now;
}
