import { describe, expect, it } from "vitest";
import { search, tokenize } from "../src";

const items = [
  { id: "1", title: "Trip to the mountains", tags: ["travel"], text: "Pack boots and a warm jacket.", editedAt: "2026-01-03" },
  { id: "2", title: "Recipe: lentil soup", tags: ["food"], text: "Lentils, onion, cumin. Simmer for 30 minutes.", editedAt: "2026-01-05" },
  { id: "3", title: "Notes", tags: ["work", "travel-budget"], text: "Travel budget for the mountains trip is set.", editedAt: "2026-01-01" },
  { id: "4", title: "Café list", tags: [], text: "Crème brûlée at the corner place.", editedAt: "2026-01-04" },
];

describe("search", () => {
  it("tokenizes across scripts and strips accents", () => {
    expect(tokenize("Café, crème-brûlée! 42")).toEqual(["cafe", "creme", "brulee", "42"]);
  });

  it("requires every term and ranks title matches first", () => {
    const hits = search(items, "mountains trip");
    expect(hits.map((h) => h.item.id)).toEqual(["1", "3"]);
  });

  it("matches tags and prefixes", () => {
    expect(search(items, "trav").map((h) => h.item.id).sort()).toEqual(["1", "3"]);
    expect(search(items, "food").map((h) => h.item.id)).toEqual(["2"]);
  });

  it("matches without accents", () => {
    expect(search(items, "cafe").map((h) => h.item.id)).toEqual(["4"]);
  });

  it("returns newest first for an empty query and respects the limit", () => {
    expect(search(items, "  ").map((h) => h.item.id)).toEqual(["2", "4", "1", "3"]);
    expect(search(items, "", 2)).toHaveLength(2);
  });

  it("returns nothing when a term is missing", () => {
    expect(search(items, "mountains zebra")).toEqual([]);
  });
});

describe("search over a big vault", () => {
  it("answers from a word index with the same hits and order as the plain search", async () => {
    const { search: run, INDEX_FROM } = await import("../src/search");
    const words = "garden harbour invoice train bread starter tomato tomatoes guitar marathon".split(" ");
    const items = Array.from({ length: INDEX_FROM + 500 }, (_, i) => ({
      id: `m${i}`,
      title: `${words[i % words.length]} note ${i}`,
      tags: i % 3 ? [words[(i + 1) % words.length]] : [],
      text: Array.from({ length: 12 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" "),
      editedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    for (const q of ["garden", "tom", "harbour invoice", "note 12", "nothing-here", "guitar mara"]) {
      const big = run(items, q).map((h) => [h.item.id, h.score]);
      // The plain search, on each item alone, as the reference.
      const plain = items.flatMap((it) => run([it], q).map((h) => [h.item.id, h.score]));
      expect(new Set(big.map((x) => x[0]))).toEqual(new Set(plain.map((x) => x[0])));
      const scores = new Map(plain.map((x) => [x[0], x[1]]));
      for (const [id, score] of big) expect(Math.abs((score as number) - (scores.get(id) as number))).toBeLessThanOrEqual(0.5);
    }
  });
});
