import { describe, expect, it } from "vitest";
import { cleanLimits } from "../src/limits";
import { agreementText, formatSlot, negotiate, negotiatePrice, negotiateTerms, nextFreeSlot, rangeFor, rangesForPrompt, turnPastRanges } from "../src/negotiate";

// Sunday 6 January 2030, 13:00 in Paris.
const NOW = Date.parse("2030-01-06T12:00:00Z");
const limits = cleanLimits({
  meetings: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "Europe/Paris" },
  calendar: { maxMinutes: 60 },
  neverTouch: ["exclusive deal"],
  ranges: {
    on: true,
    times: { on: true, minNoticeHours: 24, maxDaysAhead: 14 },
    prices: [
      { label: "Consulting day", side: "selling", min: "800", max: "1200", unit: "EUR" },
      { label: "Logo design", side: "buying", min: "300", max: "500", unit: "USD" },
    ],
    terms: { allowed: ["net 30", "remote work", "credit in the readme"], forbidden: ["exclusivity", "non-compete"] },
    maxRounds: 3,
  },
});
const day = limits.ranges.prices[0];
const logo = limits.ranges.prices[1];

describe("negotiating prices within a range", () => {
  it("are checked when saved", () => {
    expect(() => cleanLimits({ ranges: { prices: [{ label: "X", min: "10", max: "5", unit: "EUR" }] } })).toThrow(/above its highest/);
    expect(() => cleanLimits({ ranges: { prices: [{ label: "X", min: "1e3", max: "5", unit: "EUR" }] } })).toThrow(/amounts/);
    expect(() => cleanLimits({ ranges: { prices: [{ label: "X", min: "1", max: "5" }] } })).toThrow(/currency/);
    expect(() => cleanLimits({ ranges: { terms: { allowed: ["net 30"], forbidden: ["Net 30"] } } })).toThrow(/both allowed/);
  });

  it("open at the owner's opening price, selling and buying", () => {
    expect(negotiatePrice(day, {}, 3)).toMatchObject({ move: "counter", offer: { price: "1200", unit: "EUR" }, say: "My price is 1200 EUR." });
    expect(negotiatePrice(logo, {}, 3)).toMatchObject({ move: "counter", offer: { price: "300", unit: "USD" } });
  });

  it("counter halfway inside the range and accept an offer that meets its last counter", () => {
    const first = negotiatePrice(day, { theirs: { price: "900" } }, 3);
    expect(first).toMatchObject({ move: "counter", offer: { price: "1050" } });
    const second = negotiatePrice(day, { theirs: { price: "1000" }, ours: { price: "1050" }, round: 1 }, 3);
    expect(second).toMatchObject({ move: "counter", offer: { price: "1025" } });
    expect(negotiatePrice(day, { theirs: { price: "1025" }, ours: { price: "1025" }, round: 2 }, 3)).toMatchObject({ move: "accept", offer: { price: "1025" } });
    // Better than the opening price is accepted at once.
    expect(negotiatePrice(day, { theirs: { price: "1300" } }, 3)).toMatchObject({ move: "accept", offer: { price: "1300" } });
    expect(negotiatePrice(logo, { theirs: { price: "450" } }, 3)).toMatchObject({ move: "counter", offer: { price: "375" } });
  });

  it("stop and ask at the edge, past it, and after the most counters", () => {
    expect(negotiatePrice(day, { theirs: { price: "800" } }, 3)).toMatchObject({ move: "ask", reason: expect.stringContaining("at the edge") });
    const below = negotiatePrice(day, { theirs: { price: "700" } }, 3);
    expect(below).toMatchObject({ move: "ask", offer: { price: "800" }, say: "I cannot do 700 EUR. The best I can do is 800 EUR." });
    expect(below.reason).toContain("below the lowest you set (800 EUR)");
    // The two offers are as close as the range's precision allows: it asks, with their offer as what it would accept.
    expect(negotiatePrice(day, { theirs: { price: "801" }, ours: { price: "802" }, round: 1 }, 3)).toMatchObject({ move: "ask", offer: { price: "801" }, reason: "The two offers are as close as the range allows." });
    expect(negotiatePrice(day, { theirs: { price: "810" }, ours: { price: "820" }, round: 1 }, 3)).toMatchObject({ move: "counter", offer: { price: "815" } });
    expect(negotiatePrice(day, { theirs: { price: "805" }, ours: { price: "810" }, round: 1 }, 3)).toMatchObject({ move: "counter", offer: { price: "808" } });
    expect(negotiatePrice(day, { theirs: { price: "1000" }, ours: { price: "1100" }, round: 3 }, 3)).toMatchObject({ move: "ask", reason: expect.stringContaining("the most you allow") });
    expect(negotiatePrice(logo, { theirs: { price: "600" } }, 3)).toMatchObject({ move: "ask", reason: expect.stringContaining("above the most") });
    expect(negotiatePrice(day, { theirs: { price: "lots" } }, 3)).toMatchObject({ move: "ask", reason: "Their offer is not a plain amount." });
  });

  it("finds the range by what is negotiated", () => {
    expect(rangeFor(limits, "A consulting day in March")?.label).toBe("Consulting day");
    expect(rangeFor(limits, "logo")?.label).toBe("Logo design");
    expect(rangeFor(limits, "A car")).toBeNull();
    expect(negotiate(limits, { kind: "price", topic: "A car", who: "x" })).toMatchObject({ move: "ask", reason: 'There is no price range for "A car".' });
  });
});

describe("negotiating times", () => {
  it("accept a time that fits and counter with the next one that does", () => {
    // Tuesday 8 January, 10:00 in Paris.
    const fits = negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-08T09:00:00Z", minutes: 30 }, now: NOW });
    expect(fits).toMatchObject({ move: "accept", offer: { time: "2030-01-08T09:00:00.000Z", minutes: 30 } });
    expect(fits.say).toBe("Tuesday 8 January at 10:00 (2030-01-08 10:00 Europe/Paris) works for me.");
    // Saturday: the next time that fits is Monday morning.
    const sat = negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-12T09:00:00Z", minutes: 30 }, now: NOW });
    expect(sat).toMatchObject({ move: "counter", offer: { time: "2030-01-14T08:00:00.000Z" } });
    // Busy at 10:00 on Tuesday: it offers 10:30.
    const busy = negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-08T09:00:00Z", minutes: 30 }, busy: [{ start: "2030-01-08T09:00:00Z", end: "2030-01-08T09:30:00Z" }], now: NOW });
    expect(busy).toMatchObject({ move: "counter", offer: { time: "2030-01-08T09:30:00.000Z" } });
    // Too soon: Monday 7 January at 10:00 is under 24 hours away; the first time with notice is Monday at 13:00.
    const soon = negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-07T09:00:00Z", minutes: 30 }, now: NOW });
    expect(soon).toMatchObject({ move: "counter", offer: { time: "2030-01-07T12:00:00.000Z" } });
    // Opening: the first time that fits.
    expect(negotiate(limits, { kind: "time", topic: "Call", who: "x", now: NOW })).toMatchObject({ move: "counter", offer: { time: "2030-01-07T12:00:00.000Z", minutes: 30 } });
  });

  it("ask when nothing fits, when a meeting is too long, and after the most counters", () => {
    expect(negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-08T09:00:00Z", minutes: 120 }, now: NOW })).toMatchObject({ move: "ask", offer: null });
    expect(negotiate(limits, { kind: "time", topic: "Call", who: "x", theirs: { time: "2030-01-12T09:00:00Z", minutes: 30 }, round: 3, now: NOW })).toMatchObject({ move: "ask" });
    expect(nextFreeSlot(cleanLimits({ ...limits, meetings: { ...limits.meetings, days: [] } }), 30, [], NOW)).toBeNull();
    expect(formatSlot(new Date("2030-01-08T09:00:00Z"), "UTC")).toBe("Tuesday 8 January at 09:00 (2030-01-08 09:00 UTC)");
  });
});

describe("negotiating terms", () => {
  it("accept only allowed terms and ask about anything else", () => {
    expect(negotiateTerms(limits, ["Net 30", "Remote work"])).toMatchObject({ move: "accept" });
    expect(negotiateTerms(limits, ["Net 30", "Exclusivity for a year"])).toMatchObject({ move: "ask", reason: '"exclusivity" is a term you never agree to.', say: "I cannot agree to exclusivity. The rest works for me." });
    expect(negotiateTerms(limits, ["Net 60"])).toMatchObject({ move: "ask", reason: '"Net 60" is not on your list of terms it may agree to.' });
    expect(negotiateTerms(limits, [])).toMatchObject({ move: "ask" });
  });
});

describe("a negotiation", () => {
  it("stops before anything when negotiating is off or a never-touch entry is named", () => {
    expect(negotiate(cleanLimits({}), { kind: "price", topic: "Consulting day", who: "x" })).toMatchObject({ move: "ask", reason: "Negotiating on its own is off." });
    expect(negotiate(limits, { kind: "terms", topic: "An exclusive deal", who: "x", theirs: { terms: ["net 30"] } })).toMatchObject({ move: "ask", reason: expect.stringContaining("never-touch") });
  });

  it("gives a meeting of selves the ranges and holds a turn that goes past them", () => {
    const lines = rangesForPrompt(limits);
    expect(lines.join("\n")).toContain("Consulting day: start at 1200 EUR, never below 800 EUR.");
    expect(lines.join("\n")).toContain("Never agree to: exclusivity; non-compete.");
    expect(rangesForPrompt(cleanLimits({}))).toEqual([]);
    expect(turnPastRanges(limits, "I can do 1,000 EUR for the day.")).toBeNull();
    expect(turnPastRanges(limits, "Fine, 750 EUR then.")).toBe("It names 750 EUR, at or past the edge of Consulting day.");
    expect(turnPastRanges(limits, "We could pay USD 500.")).toContain("Logo design");
    expect(turnPastRanges(limits, "With a non-compete, of course.")).toContain("non-compete");
  });

  it("writes an agreed result out for a sealed agreement", () => {
    const a = agreementText({ topic: "Consulting day", who: "Kim <kim@team.example>", me: "Sam", offer: { kind: "price", price: "1025", unit: "EUR" }, timeZone: "UTC" });
    expect(a.title).toBe("Consulting day: agreed with Kim");
    expect(a.text).toBe("Sam and Kim <kim@team.example> agree:\n\nThe price for Consulting day is 1025 EUR.");
  });
});

describe("a negotiation in a message", () => {
  it("is found when a message names a range with an amount in its unit, or a plain time to meet", async () => {
    const { negotiationFromMessage } = await import("../src/negotiate");
    expect(negotiationFromMessage(limits, { who: "Kim", subject: "Consulting day in March", text: "Could you do it for 950 EUR?" })).toEqual({ kind: "price", topic: "Consulting day", who: "Kim", theirs: { price: "950" } });
    expect(negotiationFromMessage(limits, { who: "Kim", subject: "Logo design", text: "Our budget is USD 1,200." })).toMatchObject({ kind: "price", topic: "Logo design", theirs: { price: "1200" } });
    // A stray amount about something else is not an offer.
    expect(negotiationFromMessage(limits, { who: "Kim", subject: "Lunch", text: "It was 40 EUR." })).toBeNull();
    expect(negotiationFromMessage(limits, { who: "Kim", subject: "Call", text: "Can we meet 2030-01-08 10:00?" })).toEqual({ kind: "time", topic: "Call", who: "Kim", theirs: { time: "2030-01-08T09:00:00.000Z", minutes: 30 } });
    expect(negotiationFromMessage(cleanLimits({}), { who: "Kim", subject: "Call", text: "Can we meet 2030-01-08 10:00?" })).toBeNull();
  });
});
