import { describe, expect, it } from "vitest";
import {
  buildProfileBody,
  bytesToVector,
  cosine,
  embedAll,
  embeddingCacheKey,
  embeddingText,
  findDuplicates,
  hybridSearch,
  importKey,
  newVaultKey,
  normalize,
  openVector,
  parseProfileBody,
  sealVector,
  vectorToBytes,
  DecryptError,
  type Embedder,
} from "../src/index";
import { conceptEmbedder } from "./fixtures/embedder";

const item = (id: string, title: string, text: string, editedAt = "2026-01-01T00:00:00.000Z", tags: string[] = []) => ({ id, title, text, tags, editedAt });

describe("vectors", () => {
  it("measures cosine similarity", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(new Float32Array([0, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosine(new Float32Array([1]), new Float32Array([1, 0]))).toBe(0);
    const n = normalize(new Float32Array([3, 4]));
    expect([n[0], n[1]]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
  });

  it("round trips through bytes and through encryption, bound to model and key", async () => {
    const v = new Float32Array([0.25, -1.5, 3]);
    expect(bytesToVector(vectorToBytes(v))).toEqual(v);
    const key = await importKey(newVaultKey());
    const env = await sealVector(key, "model-a", "k1", v);
    expect(await openVector(key, "model-a", "k1", env)).toEqual(v);
    await expect(openVector(key, "model-b", "k1", env)).rejects.toThrow(DecryptError);
    await expect(openVector(key, "model-a", "k2", env)).rejects.toThrow(DecryptError);
    await expect(openVector(await importKey(newVaultKey()), "model-a", "k1", env)).rejects.toThrow(DecryptError);
  });

  it("derives cache keys that hide the text", () => {
    const secret = newVaultKey();
    const k = embeddingCacheKey(secret, "m", "my private note");
    expect(k).toMatch(/^[0-9a-f]{40}$/);
    expect(embeddingCacheKey(secret, "m", "my private note")).toBe(k);
    expect(embeddingCacheKey(secret, "other", "my private note")).not.toBe(k);
    expect(embeddingCacheKey(newVaultKey(), "m", "my private note")).not.toBe(k);
  });
});

describe("embedding through a cache", () => {
  it("embeds only what is missing", async () => {
    let calls = 0;
    const inner = conceptEmbedder();
    const counting: Embedder = { model: inner.model, embed: async (t) => ((calls += t.length), inner.embed(t)) };
    const cache = new Map<string, Float32Array>();
    const store = { get: (k: string) => cache.get(k), set: (k: string, v: Float32Array) => void cache.set(k, v) };
    const items = [
      { key: "a", text: "car" },
      { key: "b", text: "pasta" },
    ];
    const first = await embedAll(counting, items, store, 1);
    expect(first.size).toBe(2);
    expect(calls).toBe(2);
    const progress: number[] = [];
    await embedAll(counting, [...items, { key: "c", text: "dog" }], store, 16, (d) => progress.push(d));
    expect(calls).toBe(3);
    expect(progress).toEqual([2, 3]);
  });
});

describe("hybrid search", () => {
  const items = [
    item("car", "My car", "Booked the garage for Tuesday, the brakes squeak"),
    item("pasta", "Pasta night", "Fresh tomatoes and basil for dinner"),
    item("dog", "The dog", "Vet appointment for the puppy"),
    item("plan", "Launch plan", "Ship the project before the deadline"),
  ];

  it("finds by meaning what keyword search misses", async () => {
    const e = conceptEmbedder();
    const vectors = await embedAll(e, items.map((i) => ({ key: i.id, text: embeddingText(i) })));
    const [q] = await e.embed(["automobile"]);
    expect(hybridSearch(items, "automobile").map((h) => h.item.id)).toEqual([]);
    const hits = hybridSearch(items, "automobile", { queryVector: q, vectors });
    expect(hits[0]).toMatchObject({ item: { id: "car" }, match: "meaning" });
    expect(hits.map((h) => h.item.id)).not.toContain("pasta");
  });

  it("ranks a memory found both ways first", async () => {
    const e = conceptEmbedder();
    const vectors = await embedAll(e, items.map((i) => ({ key: i.id, text: embeddingText(i) })));
    const [q] = await e.embed(["dinner"]);
    const hits = hybridSearch(items, "dinner", { queryVector: q, vectors });
    expect(hits[0]).toMatchObject({ item: { id: "pasta" }, match: "both" });
  });

  it("falls back to words without vectors, and lists everything for an empty query", () => {
    expect(hybridSearch(items, "garage").map((h) => [h.item.id, h.match])).toEqual([["car", "words"]]);
    expect(hybridSearch(items, "", { limit: 2 })).toHaveLength(2);
  });
});

describe("duplicates", () => {
  it("finds the same text, nearly the same text and the same meaning", async () => {
    const items = [
      item("a", "Allergy", "I am allergic to penicillin and must avoid it", "2026-01-03T00:00:00.000Z"),
      item("b", "Allergy", "I am allergic to penicillin and must avoid it", "2026-01-02T00:00:00.000Z"),
      item("c", "Trip notes", "We flew to Rome in May and stayed near the old market for a week", "2026-01-04T00:00:00.000Z"),
      item("d", "Trip notes", "We flew to Rome in May and stayed near the old market for two weeks", "2026-01-05T00:00:00.000Z"),
      item("e", "Car", "automobile vehicle truck", "2026-01-06T00:00:00.000Z"),
      item("f", "Vehicle", "car garage driving", "2026-01-07T00:00:00.000Z"),
      item("g", "Guitar", "Practice the new song", "2026-01-08T00:00:00.000Z"),
    ];
    const e = conceptEmbedder();
    const vectors = await embedAll(e, items.map((i) => ({ key: i.id, text: embeddingText(i) })));
    const pairs = findDuplicates(items, { vectors });
    const ids = pairs.map((p) => [p.kind, [p.a.id, p.b.id].sort().join("")]);
    expect(ids).toContainEqual(["same", "ab"]);
    expect(ids).toContainEqual(["near", "cd"]);
    expect(ids).toContainEqual(["meaning", "ef"]);
    expect(pairs[0].kind).toBe("same");
    expect(ids.flatMap(([, x]) => (x as string).split(""))).not.toContain("g");
    // Without vectors, only the wording counts.
    expect(findDuplicates(items).map((p) => p.kind)).toEqual(["same", "near"]);
  });
});

describe("the Self card", () => {
  it("round trips its three sections", () => {
    const body = buildProfileBody({ who: "A designer.", answers: "Short, plain.", projects: "A boat\nA book" });
    expect(body).toContain("## How I like answers");
    expect(parseProfileBody(body)).toEqual({ who: "A designer.", answers: "Short, plain.", projects: "A boat\nA book" });
    expect(parseProfileBody("Just some text")).toEqual({ who: "Just some text", answers: "", projects: "" });
  });
});
