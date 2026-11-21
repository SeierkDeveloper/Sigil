// Address checks for the connector: where it may send the app key's token, and
// the secret path of its own HTTP mode.

import { timingSafeEqual } from "node:crypto";

/** https anywhere; http only to this machine. */
export function isSafeBaseUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && isLoopbackHost(u.hostname);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Compares the request path with the secret one in constant time. */
export function samePath(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
