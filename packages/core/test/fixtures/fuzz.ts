// A small seeded fuzzer for the parsers of outside input. No dependency: a
// fixed seed makes every run the same, so a failure can be replayed; set
// SIGIL_FUZZ_SEED to try another and SIGIL_FUZZ_RUNS for more cases.

export const FUZZ_SEED = Number(process.env.SIGIL_FUZZ_SEED ?? 20261120);
export const FUZZ_RUNS = Number(process.env.SIGIL_FUZZ_RUNS ?? 150);

export type Rng = () => number;

/** mulberry32: a tiny, good enough PRNG for test inputs. */
export function rng(seed = FUZZ_SEED): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, max: number) => Math.floor(r() * max);
export const pick = <T>(r: Rng, list: readonly T[]): T => list[int(r, list.length)];

const PIECES = ["", " ", "\n", "\r\n", "\t", "<", ">", "</", "<script>", "</script>", "<li", "&amp;", "&#x1F600;", "&constructor;", '"', "'", ":", ";", "=", ",", ".", "..", "/", "\\", "#", "@", "%", "%00", "\u0000", "‮", "\ud800", "😀", "é", "WEBVTT", "-->", "00:00:01.000", "BEGIN:VEVENT", "END:VEVENT", "From ", "Subject: ", "=?utf-8?B?", "?=", "---", "#tag", "__proto__", "constructor", "prototype", "a@b.co", "0x", "s1.", "v1.", "r1.", "m1."];

/** A string of odd pieces and random characters. */
export function str(r: Rng, maxLen = 200): string {
  let out = "";
  const n = int(r, maxLen);
  while (out.length < n) {
    out += r() < 0.5 ? pick(r, PIECES) : String.fromCharCode(int(r, r() < 0.9 ? 128 : 0x10000));
  }
  return out;
}

export function bytes(r: Rng, maxLen = 512): Uint8Array {
  const out = new Uint8Array(int(r, maxLen));
  for (let i = 0; i < out.length; i++) out[i] = int(r, 256);
  return out;
}

const KEYS = ["__proto__", "constructor", "prototype", "id", "title", "name", "text", "body", "content", "parts", "mapping", "current_node", "chat_messages", "sender", "uuid", "created_at", "create_time", "docs", "attachments", "files", "message", "author", "role", "children", "parent", "items", "version", "signature", "hash", "statement", "claim", "kind", "format", "doc", "seal"];

/** Any JSON value, nested a few levels, with keys that trip careless code. */
export function json(r: Rng, depth = 0): unknown {
  const roll = r();
  if (depth > 4 || roll < 0.25) {
    return pick(r, [null, true, false, 0, -1, 1e16, Number.MAX_SAFE_INTEGER, 1.5, NaN, "", "x", str(r, 30)] as const);
  }
  if (roll < 0.55) return Array.from({ length: int(r, 5) }, () => json(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = int(r, 6); i > 0; i--) Object.defineProperty(o, r() < 0.7 ? pick(r, KEYS) : str(r, 12), { value: json(r, depth + 1), enumerable: true, configurable: true, writable: true });
  return o;
}

/** A copy of a JSON-like value with one random change: a field dropped, its type swapped, or a string changed. */
export function mutate(r: Rng, value: unknown): unknown {
  const copy = structuredClone(value) as unknown;
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (path.length) paths.push(path);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...path, k]);
  };
  walk(copy, []);
  if (!paths.length) return json(r);
  const path = pick(r, paths);
  let parent = copy as Record<string | number, unknown>;
  for (const p of path.slice(0, -1)) parent = parent[p] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  const cur = parent[last];
  const roll = r();
  if (roll < 0.25) delete parent[last];
  else if (roll < 0.5) parent[last] = json(r, 3);
  else if (typeof cur === "string" && cur.length) {
    const i = int(r, cur.length);
    const c = cur.charCodeAt(i);
    parent[last] = cur.slice(0, i) + String.fromCharCode(c === 65 ? 66 : 65) + cur.slice(i + 1);
  } else if (typeof cur === "number") parent[last] = cur + 1;
  else parent[last] = str(r, 20);
  return copy;
}

/** Runs fn and reports how it ended: a value, or the thing thrown. */
export function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function outcomeAsync<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** True when a throw is a proper Error with a message a person can read, not a crash from deep inside. */
export function plainError(e: unknown): boolean {
  return e instanceof Error && typeof e.message === "string" && e.message.length > 0 && !(e instanceof TypeError) && !(e instanceof RangeError && /call stack/i.test(e.message));
}

/** How long fn takes, in milliseconds. */
export function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}
