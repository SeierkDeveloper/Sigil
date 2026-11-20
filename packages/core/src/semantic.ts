// Search by meaning, on the device.
//
// Embeddings are computed where the plaintext already is: in the browser for
// the vault and in the connector on the user's machine. They are never sent to
// the server. When they are kept between sessions they are encrypted first
// (see sealVector), because an embedding says a lot about the text it came from.
//
// The model itself is pluggable (an Embedder), so tests run with a fixed one
// and the browser and the connector load a small sentence model.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decryptBytes, encryptBytes } from "./crypto";
import { toHex, utf8 } from "./encoding";
import { AAD } from "./keys";
import { search, tokenize, type Searchable } from "./search";

export interface Embedder {
  /** Names the model, so vectors from different models never mix. */
  readonly model: string;
  /** One unit-length vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingCache {
  get(key: string): Promise<Float32Array | undefined> | Float32Array | undefined;
  set(key: string, vector: Float32Array): Promise<void> | void;
}

export const EMBED_TEXT_LIMIT = 1200;

/** The text a memory is understood by: title, tags and the start of the text. */
export function embeddingText(item: { title: string; tags: string[]; text: string }): string {
  const tags = item.tags.length ? `\n${item.tags.join(", ")}` : "";
  return `${item.title}${tags}\n${item.text}`.slice(0, EMBED_TEXT_LIMIT);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Embeds many items through a cache. Keys are derived by the caller from the
 * model and the text, so an edited memory gets a fresh vector.
 */
export async function embedAll(
  embedder: Embedder,
  items: { key: string; text: string }[],
  cache?: EmbeddingCache,
  batch = 16,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: { key: string; text: string }[] = [];
  for (const item of items) {
    const hit = cache ? await cache.get(item.key) : undefined;
    if (hit) out.set(item.key, hit);
    else missing.push(item);
  }
  let done = items.length - missing.length;
  onProgress?.(done, items.length);
  for (let i = 0; i < missing.length; i += batch) {
    const chunk = missing.slice(i, i + batch);
    const vectors = await embedder.embed(chunk.map((c) => c.text));
    for (let j = 0; j < chunk.length; j++) {
      out.set(chunk[j].key, vectors[j]);
      if (cache) await cache.set(chunk[j].key, vectors[j]);
    }
    done += chunk.length;
    onProgress?.(done, items.length);
  }
  return out;
}

// ---------------------------------------------------------------- hybrid search

export type MatchKind = "words" | "meaning" | "both";

export interface HybridHit<T> {
  item: T;
  score: number;
  match: MatchKind;
  /** Cosine similarity to the query, when a vector was available. */
  similarity: number | null;
}

export interface HybridOptions {
  /** The query's vector, from the same model as the item vectors. */
  queryVector?: Float32Array | null;
  /** Item vectors by item id. */
  vectors?: Map<string, Float32Array>;
  limit?: number;
  /** Below this similarity a memory is not a match by meaning. */
  minSimilarity?: number;
}

export const DEFAULT_MIN_SIMILARITY = 0.35;
const RRF_K = 60;

/**
 * Keyword search and search by meaning, fused by reciprocal rank. A memory found
 * both ways ranks highest; one found only by meaning still appears, so "my car"
 * finds a note about the automobile. Without vectors it is plain keyword search.
 */
export function hybridSearch<T extends Searchable>(items: T[], query: string, opts: HybridOptions = {}): HybridHit<T>[] {
  const limit = opts.limit ?? Infinity;
  const words = search(items, query);
  const q = opts.queryVector;
  const vectors = opts.vectors;
  if (!q || !vectors || tokenize(query).length === 0) {
    return words.slice(0, limit).map((h) => ({ item: h.item, score: h.score, match: "words" as const, similarity: null }));
  }
  const min = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const sims = new Map<string, number>();
  for (const item of items) {
    const v = vectors.get(item.id);
    if (v) sims.set(item.id, cosine(q, v));
  }
  const byMeaning = items
    .filter((i) => (sims.get(i.id) ?? -1) >= min)
    .sort((a, b) => (sims.get(b.id) ?? 0) - (sims.get(a.id) ?? 0));

  const fused = new Map<string, { item: T; score: number; words: boolean; meaning: boolean }>();
  words.forEach((h, rank) => fused.set(h.item.id, { item: h.item, score: 1 / (RRF_K + rank + 1), words: true, meaning: false }));
  byMeaning.forEach((item, rank) => {
    const prev = fused.get(item.id);
    const add = 1 / (RRF_K + rank + 1);
    if (prev) {
      prev.score += add;
      prev.meaning = true;
    } else fused.set(item.id, { item, score: add, words: false, meaning: true });
  });
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((f) => ({
      item: f.item,
      score: f.score,
      match: f.words && f.meaning ? "both" : f.words ? "words" : "meaning",
      similarity: sims.get(f.item.id) ?? null,
    }));
}

// ---------------------------------------------------------------- duplicates

export type DuplicateKind = "same" | "near" | "meaning";

export interface DuplicatePair<T> {
  a: T;
  b: T;
  kind: DuplicateKind;
  /** 1 for the same text; word overlap or cosine similarity otherwise. */
  closeness: number;
}

export interface DuplicateOptions {
  vectors?: Map<string, Float32Array>;
  /** Word-shingle overlap from which two texts count as nearly the same. */
  nearOverlap?: number;
  /** Cosine similarity from which two memories count as the same thing said twice. */
  meaningSimilarity?: number;
  /** Compares at most this many items pairwise (the most recently edited). */
  maxPairwise?: number;
}

/** Duplicates are judged on the title and the start of the text, which keeps the pairwise pass quick on large vaults. */
const DUPLICATE_TEXT = 4000;

function normalizedText(item: Searchable): string {
  return tokenize(`${item.title} ${item.text.slice(0, DUPLICATE_TEXT)}`).join(" ");
}

function shingles(text: string): Set<string> {
  const words = text.split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < 3) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Finds memories that say the same thing twice: identical text, nearly identical
 * wording, or (with vectors) the same meaning in other words. Each pair is
 * reported once, closest first.
 */
export function findDuplicates<T extends Searchable>(items: T[], opts: DuplicateOptions = {}): DuplicatePair<T>[] {
  const nearOverlap = opts.nearOverlap ?? 0.6;
  const meaning = opts.meaningSimilarity ?? 0.92;
  const pairs: DuplicatePair<T>[] = [];
  const seen = new Set<string>();
  const key = (x: T, y: T) => (x.id < y.id ? `${x.id}|${y.id}` : `${y.id}|${x.id}`);

  const byText = new Map<string, T[]>();
  for (const item of items) {
    const t = normalizedText(item);
    if (!t) continue;
    byText.set(t, [...(byText.get(t) ?? []), item]);
  }
  for (const group of byText.values()) {
    for (let i = 1; i < group.length; i++) {
      seen.add(key(group[0], group[i]));
      pairs.push({ a: group[0], b: group[i], kind: "same", closeness: 1 });
    }
  }

  const recent = [...items].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1)).slice(0, opts.maxPairwise ?? 1000);
  const sh = recent.map((i) => shingles(normalizedText(i)));
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const k = key(recent[i], recent[j]);
      if (seen.has(k)) continue;
      const overlap = jaccard(sh[i], sh[j]);
      if (overlap >= nearOverlap) {
        seen.add(k);
        pairs.push({ a: recent[i], b: recent[j], kind: "near", closeness: overlap });
        continue;
      }
      const va = opts.vectors?.get(recent[i].id);
      const vb = opts.vectors?.get(recent[j].id);
      if (va && vb) {
        const sim = cosine(va, vb);
        if (sim >= meaning) {
          seen.add(k);
          pairs.push({ a: recent[i], b: recent[j], kind: "meaning", closeness: sim });
        }
      }
    }
  }
  const rank: Record<DuplicateKind, number> = { same: 0, near: 1, meaning: 2 };
  return pairs.sort((x, y) => rank[x.kind] - rank[y.kind] || y.closeness - x.closeness);
}

// ---------------------------------------------------------------- keeping vectors, encrypted

export function vectorToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  if (bytes.length % 4 !== 0) throw new Error("Not a vector.");
  return new Float32Array(bytes.slice().buffer);
}

/** Encrypts a vector for storage on the device, bound to its model and key. */
export async function sealVector(key: CryptoKey, model: string, cacheKey: string, v: Float32Array): Promise<string> {
  return encryptBytes(key, vectorToBytes(v), AAD.embedding(model, cacheKey));
}

export async function openVector(key: CryptoKey, model: string, cacheKey: string, envelope: string): Promise<Float32Array> {
  return bytesToVector(await decryptBytes(key, envelope, AAD.embedding(model, cacheKey)));
}

/**
 * The key a vector is cached under: an HMAC of the model and the text under a
 * secret only the device has, so the cache does not show which texts match.
 */
export function embeddingCacheKey(secret: Uint8Array, model: string, text: string): string {
  return toHex(hmac(sha256, secret, utf8(`${model}\n${text}`))).slice(0, 40);
}
