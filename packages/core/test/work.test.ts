import { describe, expect, it } from "vitest";
import { cleanLesson, cleanWork, DEFAULT_WORK, editLessons, eventTimes, freeBlocks, lessonPrompt, newDraft, plainPlan, plainReply, replyPrompt, styleHints, weekAgenda, wordDiff } from "../src";

describe("drafts", () => {
  it("start waiting, with nothing approved", () => {
    const d = newDraft({ kind: "reply", draft: "Hi" });
    expect(d).toMatchObject({ kind: "reply", title: "A reply", final: null, decidedAt: null, learned: null, usedModel: false });
  });

  it("hold nothing back unless the owner says so, and learn by default", () => {
    expect(cleanWork(null)).toEqual(DEFAULT_WORK);
    expect(cleanWork({ holdLinks: true, learn: false, bogus: 1 })).toEqual({ ...DEFAULT_WORK, holdLinks: true, learn: false });
  });
});

describe("learning from an edit", () => {
  const draft = "Hi Alex,\n\nThank you for your message about the invoice. I have read it and will come back to you on it soon.\n\nBest regards";
  const edited = "Hey Alex,\n\nThanks for the note about the invoice. I will pay it on Friday.\n\nCheers,\nSam";

  it("finds what changed, word by word", () => {
    const d = wordDiff("the quick brown fox", "the slow brown dog jumps");
    expect(d.replaced).toEqual([
      ["quick", "slow"],
      ["fox", "dog jumps"],
    ]);
    expect(wordDiff("a b c", "a b c")).toEqual({ removed: [], added: [], replaced: [] });
  });

  it("turns the greeting, the sign-off and the length into plain notes, with the name left out", () => {
    const lessons = editLessons(draft, edited, "Alex Example <alex@example.org>");
    expect(lessons[0]).toBe("Greeting: Hey {name},");
    expect(lessons[1]).toBe("Sign-off: Cheers,\\nSam");
    expect(lessons.some((l) => l.startsWith("Writes shorter"))).toBe(true);
    expect(editLessons(draft, draft)).toEqual([]);
  });

  it("feeds later drafts: the newest greeting and sign-off win", () => {
    const hints = styleHints([
      { body: "Greeting: Hello {name},\nSign-off: Kind regards", editedAt: "2026-11-01T00:00:00Z" },
      { body: "Greeting: Hey {name},\nSign-off: Cheers,\\nSam\nWrites shorter.", editedAt: "2026-11-10T00:00:00Z" },
    ]);
    expect(hints).toEqual({ greeting: "Hey {name},", signoff: "Cheers,\nSam", notes: ["Writes shorter."] });
    const reply = plainReply({ message: "Subject: Lunch\nAre you free on Friday?", from: "Robin Example" }, hints);
    expect(reply.startsWith("Hey Robin,")).toBe(true);
    expect(reply).toContain("about Lunch");
    expect(reply.endsWith("Cheers,\nSam")).toBe(true);
    const prompt = replyPrompt({ name: "Sam", tone: "Short.", message: "Are you free?", from: "Robin", hints, sources: [] });
    expect(prompt.system).toContain("Hey {name},");
    expect(prompt.system).toContain("Writes shorter.");
    expect(prompt.system).toContain("you send nothing");
  });

  it("asks the model for style only, and keeps its answer to a few lines", () => {
    expect(lessonPrompt(draft, edited).system).toContain("describe style, not content");
    expect(cleanLesson("- Prefers short replies.\n- Greeting: Hey {name},\n\n" + "x".repeat(300))).toEqual(["Prefers short replies.", "Greeting: Hey {name},"]);
  });
});

describe("planning the week", () => {
  const now = new Date(2026, 10, 23, 8, 0);
  const at = (d: number, h: number, m = 0) => {
    const t = new Date(2026, 10, d, h, m);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  };
  const calendar = [
    { id: "e1", title: "Dentist", body: `When: ${at(24, 10)} to ${at(24, 11)}`, createdAt: new Date(2026, 10, 24, 10).toISOString() },
    { id: "e2", title: "Team day", body: `When: ${at(25, 0).slice(0, 10)} (all day)`, createdAt: new Date(2026, 10, 25).toISOString() },
    { id: "e3", title: "Old", body: `When: ${at(10, 9)}`, createdAt: new Date(2026, 10, 10, 9).toISOString() },
    { id: "e4", title: "Called off", body: `When: ${at(26, 9)}\nCancelled`, createdAt: new Date(2026, 10, 26, 9).toISOString() },
  ];

  it("reads event times from the When line", () => {
    const t = eventTimes(calendar[0])!;
    expect(t.start.getHours()).toBe(10);
    expect(t.end?.getHours()).toBe(11);
    expect(eventTimes(calendar[1])!.allDay).toBe(true);
  });

  it("lays out seven days with events and free time, leaving out the past and the cancelled", () => {
    const agenda = weekAgenda(calendar, now);
    expect(agenda).toHaveLength(7);
    expect(agenda[1].events.map((e) => e.title)).toEqual(["Dentist"]);
    expect(freeBlocks(agenda[1])).toEqual(["09:00 to 10:00", "11:00 to 17:00"]);
    expect(freeBlocks(agenda[2])).toEqual([]);
    const plan = plainPlan(agenda);
    expect(plan).toContain("2 events in the next seven days.");
    expect(plan).toContain("- 10:00 to 11:00: Dentist");
    expect(plan).toContain("- All day: Team day");
    expect(plan).not.toContain("Old");
    expect(plan).not.toContain("Called off");
  });
});
