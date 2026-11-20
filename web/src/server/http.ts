// Request and response helpers for the API router.

import { serverConfig } from "./config";
import { HttpError } from "./store";

export const SESSION_COOKIE = "sigil_session";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    // A vault that moved to another node says where it went.
    const to = (err as HttpError & { to?: string }).to;
    return json({ error: err.message, code: err.code, ...(to ? { to } : {}) }, err.status);
  }
  console.error("[sigil] unexpected error", err);
  return json({ error: "Something went wrong on the server. Please try again.", code: "server" }, 500);
}

/**
 * Reads a JSON body, never holding more than maxBytes of it: the declared
 * length is checked first, then the body is read as a stream and dropped the
 * moment it grows past the limit (a body sent without a length cannot get
 * around it).
 */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "This request is too large.", "too_large");
  const bytes = await readBody(req, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "The request body is not valid text.", "bad_json");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.", "bad_json");
  }
}

/** The raw body, at most maxBytes long. */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "This request is too large.", "too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The site's own origin: the configured one, or the one the request arrived on. */
export function siteOrigin(req: Request): string {
  if (serverConfig.origin) return serverConfig.origin;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

export function sessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const secure = siteOrigin(req).startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearSessionCookie(req: Request): string {
  return sessionCookie(req, "", 0);
}

/**
 * Requests that change data with the session cookie must come from the site
 * itself. The cookie is SameSite=Lax already; this is a second, explicit check.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin || origin !== siteOrigin(req)) {
    throw new HttpError(403, "This request did not come from the Sigil site.", "origin");
  }
}

/**
 * Requests with the session cookie, reads included, must not come from another
 * site. Browsers say where a request came from in Sec-Fetch-Site; a page on
 * another site that links to or loads an API address gets "cross-site" and is
 * refused before anything is read or changed. (Callers that are not browsers
 * send no such header and are judged by the cookie and the origin check.)
 */
export function assertNotCrossSite(req: Request): void {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "This request did not come from the Sigil site.", "origin");
  }
}

/**
 * The address a request came from, for rate limits and per-visitor counts.
 *
 * The first address in X-Forwarded-For is whatever the caller wrote there, so
 * it is never used. With SIGIL_PROXY_HOPS proxies in front of the node (1 by
 * default: the host's own proxy, or Next.js itself when there is none), the
 * address that many places from the end of the list is the one the nearest
 * trusted proxy saw. With 0, forwarded headers are ignored altogether.
 */
export function clientIp(req: Request): string {
  const hops = serverConfig.proxyHops;
  if (hops === 0) return "local";
  const list = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.length) return list[Math.max(0, list.length - hops)].slice(0, 64);
  return req.headers.get("x-real-ip")?.trim().slice(0, 64) || "local";
}

// ---------------------------------------------------------------- rate limits (in memory, per process)

const windows = new Map<string, number[]>();

export function rateLimit(key: string, max: number, perMs: number): void {
  const t = Date.now();
  const list = (windows.get(key) ?? []).filter((x) => x > t - perMs);
  if (list.length >= max) {
    windows.set(key, list);
    throw new HttpError(429, "Too many requests. Please wait a moment and try again.", "rate_limited");
  }
  list.push(t);
  windows.set(key, list);
  if (windows.size > 50_000) {
    for (const [k, v] of windows) if (v.every((x) => x <= t - perMs)) windows.delete(k);
  }
}

export function resetRateLimits(): void {
  windows.clear();
}
