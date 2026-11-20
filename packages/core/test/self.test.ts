import { describe, expect, it } from "vitest";
import {
  answerAsSelf,
  buildSelfPrompt,
  citedSources,
  cleanRules,
  looseSearch,
  mentions,
  retrieve,
  screenAnswer,
  screenQuestion,
  withoutCitations,
  type ModelCaller,
  type ModelRequest,
  type SelfMemory,
} from "../src";

const memories: SelfMemory[] = [
  { id: "m-food-0001", folderId: "f-life", folder: "Life", title: "Favourite food", tags: ["food"], body: "I love mushroom risotto, and I never eat olives.", editedAt: "2026-01-02T00:00:00Z" },
  { id: "m-work-0001", folderId: "f-work", folder: "Work", title: "Current job", tags: [], body: "I build boats at a small yard.", editedAt: "2026-01-03T00:00:00Z" },
  { id: "m-health-01", folderId: "f-health", folder: "Health", title: "Blood test", tags: ["health"], body: "SECRET-HEALTH cholesterol 5.1, food diary started.", editedAt: "2026-01-04T00:00:00Z" },
  { id: "m-old-00001", folderId: "f-life", folder: "Life", title: "Old food plan", tags: [], body: "Food plan that expired.", editedAt: "2025-01-01T00:00:00Z", expiresAt: "2025-06-01T00:00:00Z" },
];

/** A model stand-in: records every request and answers from a function. Never touches a network. */
function fakeModel(answer: (req: ModelRequest) => string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async complete(req) {
      calls.push(req);
      return answer(req);
    },
  };
  return { model, calls };
}

const rules = cleanRules({ name: "Sam's AI self", folderIds: ["f-life", "f-work"], denyTopics: ["salary"], neverSay: ["home address"], tone: "Dry and friendly." });

describe("rules", () => {
  it("cleans what the owner typed", () => {
    const r = cleanRules({ name: "  ", folderIds: ["a", "a", ""], maxSources: 99, unknown: "redirect", allowTopics: [" boats ", "boats"] });
    expect(r.name).toBe("My AI self");
    expect(r.folderIds).toEqual(["a"]);
    expect(r.maxSources).toBe(6);
    expect(r.unknown).toBe("redirect");
    expect(r.allowTopics).toEqual(["boats"]);
  });

  it("refuses denied topics and, with an allow list, everything else", () => {
    expect(mentions("What is your salary?", "salary")).toBe(true);
    expect(mentions("What do you eat?", "salary")).toBe(false);
    expect(screenQuestion(rules, "How big is your SALARY these days")).toMatchObject({ ok: false, reason: "denied_topic" });
    const only = cleanRules({ allowTopics: ["boats", "food"] });
    expect(screenQuestion(only, "Tell me about boats")).toEqual({ ok: true });
    const off = screenQuestion(only, "Who do you vote for?");
    expect(off).toMatchObject({ ok: false, reason: "off_topic" });
    expect(off.ok ? "" : off.reply).toContain("boats and food");
  });

  it("blocks an answer with a phrase it must never say, whatever the case and spacing", () => {
    expect(screenAnswer(rules, "My Home   Address is 4 Main St").blocked).toBe(true);
    expect(screenAnswer(rules, "I live by the sea").blocked).toBe(false);
  });
});

describe("retrieval", () => {
  it("uses only the allowed folders and skips expired memories", () => {
    const got = retrieve(rules, memories, "What food do you like?", { now: Date.parse("2026-02-01") });
    expect(got.map((s) => s.id)).toEqual(["m-food-0001"]);
    expect(JSON.stringify(got)).not.toContain("SECRET-HEALTH");
  });

  it("finds memories by any meaningful word of a question", () => {
    const items = memories.map((m) => ({ ...m, text: m.body }));
    expect(looseSearch(items, "where do you work and build?").map((m) => m.id)).toEqual(["m-work-0001"]);
    expect(looseSearch(items, "what is it")).toEqual([]);
  });

  it("uses meaning when vectors are given", () => {
    const v = (x: number[]) => new Float32Array(x);
    const vectors = new Map([
      ["m-work-0001", v([1, 0])],
      ["m-food-0001", v([0, 1])],
    ]);
    const got = retrieve(rules, memories, "occupation", { queryVector: v([0.9, 0.1]), vectors, now: Date.parse("2026-02-01") });
    expect(got[0].id).toBe("m-work-0001");
  });
});

describe("answering as the owner", () => {
  it("gives the model the rules and only allowed memories, and returns the cited ones", async () => {
    const { model, calls } = fakeModel(() => "Mushroom risotto, every time [1].");
    const r = await answerAsSelf({ question: "What is your favourite food?", rules, memories, model, asker: "guest", now: Date.parse("2026-02-01") });
    expect(r).toMatchObject({ text: "Mushroom risotto, every time [1].", refused: null, usedModel: true });
    expect(r.citations).toEqual([{ id: "m-food-0001", title: "Favourite food", folder: "Life" }]);
    expect(calls).toHaveLength(1);
    const prompt = calls[0].system;
    expect(prompt).toContain("You are Sam's AI self");
    expect(prompt).toContain("Tone: Dry and friendly.");
    expect(prompt).toContain("Never discuss: salary.");
    expect(prompt).toContain('"home address"');
    expect(prompt).toContain("I love mushroom risotto");
    expect(prompt).not.toContain("SECRET-HEALTH");
    expect(prompt).not.toContain("Food plan that expired");
    expect(withoutCitations(r.text)).toBe("Mushroom risotto, every time.");
  });

  it("refuses before the model when the topic is denied", async () => {
    const { model, calls } = fakeModel(() => "should not be called");
    const r = await answerAsSelf({ question: "What is your salary?", rules, memories, model, asker: "guest" });
    expect(r.refused).toBe("denied_topic");
    expect(r.usedModel).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("says it does not know, without calling the model, when nothing allowed matches", async () => {
    const { model, calls } = fakeModel(() => "x");
    const r = await answerAsSelf({ question: "What is your cholesterol?", rules: cleanRules({ ...rules, folderIds: ["f-work"] }), memories, model, asker: "owner" });
    expect(r).toMatchObject({ refused: "unknown", usedModel: false, citations: [] });
    expect(r.text).toContain("I don't know");
    expect(calls).toHaveLength(0);
  });

  it("replaces an answer that says what it must never say", async () => {
    const { model } = fakeModel(() => "Sure, my home address is 4 Main St [1].");
    const r = await answerAsSelf({ question: "Where does your food come from?", rules, memories, model, asker: "guest", now: Date.parse("2026-02-01") });
    expect(r.refused).toBe("never_say");
    expect(r.text).not.toContain("Main St");
    expect(r.citations).toEqual([]);
  });

  it("passes the last turns of the conversation along, without citation numbers", async () => {
    const { model, calls } = fakeModel(() => "Yes [1].");
    await answerAsSelf({
      question: "And olives?",
      history: [{ question: "Favourite food?", answer: "Risotto [1]." }],
      rules,
      memories,
      model,
      asker: "owner",
      now: Date.parse("2026-02-01"),
    });
    expect(calls[0].messages).toEqual([
      { role: "user", content: "Favourite food?" },
      { role: "assistant", content: "Risotto." },
      { role: "user", content: "And olives?" },
    ]);
  });

  it("reads citations and escapes memory titles in the prompt", () => {
    const sources = [{ n: 1, id: "a", title: 'A "quoted" <title>', folder: "F", text: "t", editedAt: "2026-01-01" }];
    expect(buildSelfPrompt(rules, sources, { asker: "owner" })).toContain('title="A &quot;quoted&quot; &lt;title&gt;"');
    expect(citedSources("See [2] and [1][1].", [...sources, { ...sources[0], n: 2, id: "b" }]).map((s) => s.id)).toEqual(["b", "a"]);
  });
});
