// Requests this node makes to addresses someone else named: another node in a
// move, or a public address a bundle is fetched from for a restore. They must
// never reach the node's own network (its metadata service, a database on the
// private network, the machine itself), unless SIGIL_NODE_ALLOW_PRIVATE says
// the nodes live on one machine or one private network.
//
// A name is checked when the connection is made, against every address it
// resolves to, so a name that resolves to a public address when asked and a
// private one a moment later (DNS rebinding) is still refused. Address
// literals are checked as written, in every form (IPv4-mapped IPv6, NAT64,
// decimal and hex forms are normalised by the URL parser first).

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { serverConfig } from "./config";

function v4Parts(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function privateV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p;
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier NAT)
    (a === 169 && b === 254) || // link local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The 8 groups of an IPv6 address, or null. Handles "::" and a trailing dotted IPv4 part. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = v4Parts(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + "0";
    if (s.endsWith("::0")) s = s.slice(0, -1);
    else s = s.slice(0, -2);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function privateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(v4(g[6], g[7])); // IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: reaches IPv4 through a gateway, refused
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard prefix
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return privateV4(v4(g[1], g[2])); // 6to4 carries an IPv4 address
  return false;
}

/** True for any address that is not a plain public internet address. Anything that does not parse counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const kind = net.isIP(bare.split("%")[0]);
  if (kind === 4) return privateV4(bare);
  if (kind === 6) return privateV6(bare);
  return true;
}

/** Host names that only mean something inside a network. */
export function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa") || !h.includes(".");
}

/** Whether a URL host (a name or an address literal) may be reached from this node. */
export function hostAllowed(host: string): boolean {
  if (serverConfig.nodeAllowPrivate) return true;
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return !isPrivateAddress(bare);
  return !isPrivateName(bare);
}

export class PrivateAddressError extends Error {
  constructor() {
    super("That address is on a private network.");
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses names resolving to any private address, used at connect time. */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void {
  const opts = typeof options === "number" ? { family: options } : options ?? {};
  dnsLookup(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    if (!list.length) return callback(Object.assign(new Error("The name did not resolve."), { code: "ENOTFOUND" }), "");
    if (!serverConfig.nodeAllowPrivate && list.some((a) => isPrivateAddress(a.address))) return callback(new PrivateAddressError(), "");
    if (opts.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * fetch for addresses someone else named: http(s) only, no redirects followed,
 * every resolved address checked when connecting. The body streams back; the
 * caller limits how much of it is read.
 */
export function guardedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      reject(new Error("That is not an address."));
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      reject(new Error("Only https addresses are fetched."));
      return;
    }
    if (!hostAllowed(url.hostname)) {
      reject(new PrivateAddressError());
      return;
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? init.body : init.body == null ? undefined : null;
    if (body === null) {
      reject(new Error("Unsupported request body."));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: init.method ?? "GET", headers, lookup: guardedLookup as unknown as net.LookupFunction, signal: init.signal ?? undefined },
      (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        const stream = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(stream, { status, headers: h }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Reads at most maxBytes of a response body, whatever it declared. */
export async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("too large");
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
