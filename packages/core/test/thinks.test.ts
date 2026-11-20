import { describe, expect, it } from "vitest";
import {
  briefDue,
  briefFacts,
  briefTitle,
  checkContradiction,
  cleanThinking,
  deleteAfter,
  disagreementSignals,
  findContradictions,
  findDuplicates,
  groupDuplicates,
  isExpired,
  mergeGroup,
  plainBrief,
  writeBrief,
  type BriefMemory,
  type ModelCaller,
} from "../src";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const mem = (id: string, title: string, created: string, edited: string, kind = "note"): BriefMemory => ({
  id,
  title,
  folder: "Notes",
  createdAt: created,
  editedAt: edited,
  snippet: `${title} text`,
  source: { kind },
});

const memories = [
  mem("a", "New recipe", "2026-11-18T10:00:00Z", "2026-11-18T10:00:00Z"),
  mem("b", "Boat plan", "2026-05-01T10:00:00Z", "2026-11-19T10:00:00Z"),
  mem("c", "Old passport note", "2025-01-01T10:00:00Z", "2025-02-01T10:00:00Z"),
  mem("d", "Steady note", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"),
  mem("e", "Last brief", "2026-11-15T10:00:00Z", "2026-11-15T10:00:00Z", "brief"),
];

const model = (answer: string | Error): ModelCaller => ({
  provider: "anthropic",
  model: "claude-opus-5-5",
  async complete() {
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

describe("the weekly brief", () => {
  it("lists what is new, what changed and what was forgotten, leaving briefs out", () => {
    const f = briefFacts(memories, NOW);
    expect(f.added.map((m) => m.id)).toEqual(["a"]);
    expect(f.changed.map((m) => m.id)).toEqual(["b"]);
    expect(f.forgotten.map((m) => m.id)).toEqual(["c"]);
    expect(f.total).toBe(4);
    expect(briefTitle(f)).toBe("Weekly brief, 2026-11-13 to 2026-11-20");
    const body = plainBrief(f);
    expect(body).toContain("## What is new\n\n- New recipe (Notes, added 2026-11-18)");
    expect(body).toContain("## What changed\n\n- Boat plan");
    expect(body).toContain("## What you may have forgotten\n\n- Old passport note (Notes, last edited 2025-02-01)");
  });

  it("is written by the owner's model when asked, and without it when the model fails", async () => {
    const f = briefFacts(memories, NOW);
    expect(await writeBrief(f, model("## What is new\nA recipe."))).toEqual({ body: "## What is new\nA recipe.", usedModel: true });
    const fallback = await writeBrief(f, model(new Error("down")));
    expect(fallback.usedModel).toBe(false);
    expect(fallback.body).toBe(plainBrief(f));
    expect((await writeBrief(f, null)).usedModel).toBe(false);
  });

  it("is due once a week", () => {
    expect(briefDue(memories, NOW)).toBe(false);
    expect(briefDue(memories, new Date("2026-11-23T10:00:00Z"))).toBe(true);
    expect(briefDue([], NOW)).toBe(true);
  });
});

describe("contradictions", () => {
  const item = (id: string, title: string, text: string) => ({ id, title, tags: [], text, editedAt: `2026-01-0${id.length}T00:00:00Z` });

  it("finds memories on the same thing that disagree, and leaves agreeing ones alone", () => {
    const items = [
      item("a", "Coffee", "I drink coffee every morning before work."),
      item("bb", "Coffee", "I never drink coffee before work in the morning."),
      item("ccc", "Garden", "The tomatoes grow by the south wall."),
      item("dddd", "Coffee habit", "I drink coffee every morning before work, black."),
    ];
    const found = findContradictions(items);
    expect(found.map((c) => [c.a.id, c.b.id].sort().join("+"))).toEqual(["a+bb", "bb+dddd"]);
    expect(found[0].signals).toContain("One says no where the other says yes");
  });

  it("names numbers, dates and opposite words", () => {
    expect(disagreementSignals("My flat is on floor 3", "My flat is on floor 5")).toEqual(["Different numbers or dates"]);
    expect(disagreementSignals("I love jazz", "I hate jazz")).toEqual(['"love" against "hate"']);
    expect(disagreementSignals("Same text", "Same text")).toEqual([]);
  });

  it("uses meaning when vectors are given, and skips pairs that are duplicates", () => {
    const items = [item("a", "Floor", "Office on floor 3"), item("bb", "Desk", "Desk on level 5"), item("ccc", "Copy", "Office on floor 4")];
    const vectors = new Map([
      ["a", new Float32Array([1, 0])],
      ["bb", new Float32Array([0.8, 0.6])],
      ["ccc", new Float32Array([1, 0])],
    ]);
    const found = findContradictions(items, { vectors });
    expect(found.map((c) => [c.a.id, c.b.id].sort().join("+")).sort()).toEqual(["a+bb", "bb+ccc"]);
  });

  it("asks the owner's model and reads its verdict", async () => {
    expect(await checkContradiction(model('{"contradicts": true, "why": "Morning against never."}'), { title: "A", text: "x" }, { title: "B", text: "y" })).toEqual({
      contradicts: true,
      why: "Morning against never.",
    });
    expect((await checkContradiction(model("I think they are fine"), { title: "A", text: "x" }, { title: "B", text: "y" })).contradicts).toBe(false);
  });
});

describe("duplicate groups", () => {
  it("joins pairs into groups and merges a group into the newest", () => {
    const m = (id: string, body: string, edited: string, tags: string[] = []) => ({ id, title: id === "d" ? "Other" : "Allergy", body, text: body, tags, editedAt: edited });
    const items = [m("a", "Allergic to penicillin.", "2026-01-01", ["health"]), m("b", "Allergic to penicillin.", "2026-02-01"), m("c", "Allergic to penicillin.", "2026-03-01", ["doctor"]), m("d", "Unrelated", "2026-01-01")];
    const groups = groupDuplicates(findDuplicates(items));
    expect(groups).toHaveLength(1);
    expect(groups[0].map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    const merged = mergeGroup(groups[0]);
    expect(merged.keep.id).toBe("c");
    expect(merged.drop.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(merged.body).toBe("Allergic to penicillin.");
    expect(merged.tags.sort()).toEqual(["doctor", "health"]);
    const differing = mergeGroup([m("x", "One", "2026-01-01"), m("y", "Two", "2026-02-01")]);
    expect(differing.body).toBe("Two\n\n---\nAllergy\n\nOne");
  });
});

describe("expiry", () => {
  it("knows what has expired and when it is deleted for real", () => {
    expect(isExpired({ expiresAt: "2026-11-19T00:00:00Z" }, NOW.getTime())).toBe(true);
    expect(isExpired({ expiresAt: "2026-12-01T00:00:00Z" }, NOW.getTime())).toBe(false);
    expect(isExpired({}, NOW.getTime())).toBe(false);
    expect(deleteAfter("2026-11-19T00:00:00.000Z", 30)).toBe("2026-12-19T00:00:00.000Z");
    expect(deleteAfter(undefined, 30)).toBeNull();
    expect(cleanThinking({ graceDays: 9999, weeklyBrief: false })).toEqual({ weeklyBrief: false, briefWithModel: false, contradictionsWithModel: false, graceDays: 30 });
  });
});
