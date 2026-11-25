// A model of you: lessons parsed from a model's lines with their sources,
// removed lessons that stay removed, a ranker trained on choices that learns
// them, a score on held-back choices, and a history to roll back to.

import { describe, expect, it } from "vitest";
import {
  cleanYou,
  dropLesson,
  emptyYou,
  lessonsText,
  nextPair,
  packWeights,
  parseYouLessons,
  rankLikeYou,
  rollBack,
  trainRanker,
  trainYou,
  unpackWeights,
  withSnapshot,
  youFeatures,
  youLessonPrompt,
  youMemoryBody,
  type YouState,
} from "../src";

let n = 0;
const id = () => `id${++n}`;
const at = (i: number) => new Date(Date.UTC(2026, 10, 25, 10, i));

describe("lessons", () => {
  const sources = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];

  it("reads kind, lesson and sources, and leaves out anything else", () => {
    const text = [
      "style | Writes short and never uses emojis. | 1, 3",
      "- priorities | Puts family before work on Sundays. | 2",
      "limit | Never agrees to calls before 10. | 9",
      "mood | Is happy. | 1",
      "Here are your lessons:",
      "STYLE | writes short and never uses emojis | 2",
    ].join("\n");
    const ls = parseYouLessons(text, sources, [], id, at(0));
    expect(ls.map((l) => [l.kind, l.text, l.sources])).toEqual([
      ["style", "Writes short and never uses emojis.", ["m1", "m3"]],
      ["priority", "Puts family before work on Sundays.", ["m2"]],
    ]);
  });

  it("never brings back a lesson the owner removed", () => {
    const s0: YouState = { ...emptyYou(), lessons: parseYouLessons("style | Writes short. | 1\nlimit | Says no to calls before 10. | 2", sources, [], id, at(0)) };
    const s1 = dropLesson(s0, s0.lessons[0].id, at(1));
    expect(s1.lessons.map((l) => l.text)).toEqual(["Says no to calls before 10."]);
    expect(s1.history.at(-1)?.reason).toBe("Removed a lesson");
    const again = parseYouLessons("style | Writes short | 1\nstyle | Signs off with first name only. | 3", sources, s1.dropped, id, at(2));
    expect(again.map((l) => l.text)).toEqual(["Signs off with first name only."]);
  });

  it("asks for lessons from numbered memories and writes them as plain text for apps", () => {
    const p = youLessonPrompt([{ id: "m1", title: 'A "note"', folder: "Work", body: "x".repeat(2000), editedAt: "2026-11-01" }], []);
    expect(p.messages[0].content).toContain('<memory n="1" title="A  note " folder="Work">');
    expect(p.messages[0].content.length).toBeLessThan(900);
    const s = { ...emptyYou(), lessons: parseYouLessons("style | Writes short. | 1\nlimit | No calls before 10. | 1", sources, [], id) };
    expect(lessonsText(s.lessons)).toBe("How you write:\n- Writes short.\n\nYour limits:\n- No calls before 10.");
    expect(youMemoryBody({ ...s, score: { value: 87, tested: 8, at: "x" } })).toContain("How well it knows me: 87 of 100.");
  });
});

describe("the ranker", () => {
  const mem = (i: number, topic: string) => ({ id: `m${i}`, title: `${topic} note ${i}`, body: `${topic} ${topic} plans and thoughts about ${topic}`, tags: [] });
  const sailing = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mem(i, "sailing"));
  const taxes = [11, 12, 13, 14, 15, 16, 17, 18].map((i) => mem(i, "taxes"));
  const all = [...sailing, ...taxes];
  const features = new Map(all.map((m) => [m.id, youFeatures(m)]));

  it("makes unit-length features and packs weights without loss", () => {
    const f = youFeatures(sailing[0]);
    expect(Math.abs(f.reduce((s, x) => s + x * x, 0) - 1)).toBeLessThan(1e-5);
    const w = trainRanker([{ win: f, lose: youFeatures(taxes[0]) }]);
    expect(Array.from(unpackWeights(packWeights(w)))).toEqual(Array.from(w));
  });

  it("learns the owner's choices, scores itself on the ones it held back, and ranks like them", () => {
    let s = emptyYou();
    expect(() => trainYou(s, features)).toThrow(/at least 10/);
    for (let i = 0; i < 15; i++) s = { ...s, choices: [...s.choices, { win: sailing[i % 8].id, lose: taxes[(i * 3) % 8].id, at: at(i).toISOString() }] };
    s = trainYou(s, features, at(30));
    expect(s.ranker?.trainedOn).toBe(15);
    expect(s.score).toMatchObject({ value: 100, tested: 3 });
    const ranked = rankLikeYou(s, [taxes[5], sailing[6], taxes[2], sailing[1]]);
    expect(ranked.slice(0, 2).map((m) => m.id).sort()).toEqual(["m2", "m7"]);
  });

  it("offers pairs it has not asked yet", () => {
    const choices = [{ win: "m1", lose: "m2", at: "" }];
    for (let seed = 1; seed < 50; seed++) {
      const p = nextPair(all.slice(0, 3), choices, seed)!;
      expect(p[0].id).not.toBe(p[1].id);
      expect([p[0].id, p[1].id].sort().join()).not.toBe("m1,m2");
    }
    expect(nextPair([sailing[0]], [], 1)).toBeNull();
  });
});

describe("history", () => {
  it("rolls the whole model back to a point, letting go of later choices", () => {
    let s = withSnapshot({ ...emptyYou(), lessons: parseYouLessons("style | Writes short. | 1", [{ id: "m1" }], [], id) }, "Learned", at(0));
    const first = s.history[0].at;
    s = { ...s, choices: [{ win: "a", lose: "b", at: "" }] };
    s = withSnapshot({ ...s, lessons: [] }, "Removed", at(1));
    const back = rollBack(s, first, at(2));
    expect(back.lessons.map((l) => l.text)).toEqual(["Writes short."]);
    expect(back.choices).toHaveLength(0);
    expect(back.history.at(-1)?.reason).toBe("Rolled back to 2026-11-25");
    expect(() => rollBack(s, "nope")).toThrow();
  });

  it("cleans whatever was stored", () => {
    expect(cleanYou(null)).toEqual(emptyYou());
    const c = cleanYou({ lessons: [{ id: "x", kind: "mood", text: "y" }, { id: "a", kind: "style", text: " Short. ", sources: ["m1", 3] }], shareWithApps: "yes", score: { value: 140, at: "t" } });
    expect(c.lessons).toEqual([expect.objectContaining({ id: "a", text: "Short.", sources: ["m1"] })]);
    expect(c.shareWithApps).toBe(false);
    expect(c.score?.value).toBe(100);
  });
});
