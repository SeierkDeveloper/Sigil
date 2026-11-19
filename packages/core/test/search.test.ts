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
