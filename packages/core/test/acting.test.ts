import { describe, expect, it } from "vitest";
import { checkAction, cleanActRequest, messageKinds, neverTouchHit, thresholdsSummary } from "../src/acting";
import { cleanLimits, DEFAULT_LIMITS, inFreeHours, personIn, startOfDay } from "../src/limits";

// Monday 7 January 2030 in Paris; the free hours are Monday to Friday, 09:00 to 17:00 there.
const NOW = Date.parse("2030-01-06T12:00:00Z");
const limits = cleanLimits({
  meetings: { on: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "Europe/Paris" },
  mail: { on: true, senders: ["Sam <sam@example.org>", "@team.example", "Robin Lee"], kinds: ["scheduling", "question", "thanks"], perDay: 3 },
  calendar: { on: true, people: ["@team.example"], maxMinutes: 45, perDay: 2 },
  neverTouch: ["lawyer", "boss@team.example", "@bank.example"],
});

describe("thresholds for mail and invites", () => {
  it("are off by default, kept within bounds, and keep what the owner typed in lower case", () => {
    expect(cleanLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.mail.on).toBe(false);
    expect(DEFAULT_LIMITS.calendar.on).toBe(false);
    expect(DEFAULT_LIMITS.ranges.on).toBe(false);
    expect(limits.mail.senders).toEqual(["sam@example.org", "@team.example", "robin lee"]);
    const odd = cleanLimits({ mail: { perDay: -4, kinds: ["money", "nonsense"] }, calendar: { maxMinutes: 100000 } });
    expect(odd.mail.perDay).toBe(DEFAULT_LIMITS.mail.perDay);
    expect(odd.mail.kinds).toEqual(["money"]);
    expect(odd.calendar.maxMinutes).toBe(DEFAULT_LIMITS.calendar.maxMinutes);
    // Off, nothing goes on its own: it waits for the owner.
    expect(checkAction(DEFAULT_LIMITS, { area: "mail", action: "reply", who: "sam@example.org" }, { today: 0 })).toEqual({ verdict: "needs-approval", reason: "Mail on its own is off." });
    expect(checkAction(DEFAULT_LIMITS, { area: "calendar", action: "accept", who: "sam@example.org" }, { today: 0 }).verdict).toBe("needs-approval");
  });

  it("match people by address, name or a whole domain, and nothing that only looks alike", () => {
    expect(personIn(limits.mail.senders, "Kim <kim@team.example>")).toBe("@team.example");
    expect(personIn(limits.mail.senders, '"Robin Lee" <robin@else.example>')).toBe("robin lee");
    expect(personIn(limits.mail.senders, "Mallory <kim@team.example.evil>")).toBeNull();
    expect(personIn(limits.mail.senders, "kim@notteam.example")).toBeNull();
  });

  it("read what a message is about", () => {
    expect(messageKinds("Lunch", "Are you free on Friday at 12:30?")).toEqual(["scheduling", "question"]);
    expect(messageKinds("Invoice 42", "Please pay the invoice by Monday.")).toEqual(["scheduling", "money"]);
    expect(messageKinds("Thanks", "Thank you, got it.")).toEqual(["thanks"]);
    expect(messageKinds("Hello", "Just saying hello.")).toEqual(["other"]);
    expect(messageKinds("NDA", "Here is the contract.")).toEqual(["legal"]);
  });

  it("allow a reply to a listed sender about an allowed kind, and say under which limit", () => {
    const v = checkAction(limits, { area: "mail", action: "reply", who: "Sam <sam@example.org>", subject: "Lunch", text: "Are you free Friday?" }, { today: 0, now: NOW });
    expect(v).toMatchObject({ verdict: "allowed" });
    expect(v.verdict === "allowed" && v.limit).toBe("Mail on its own: replies to listed senders (sam@example.org) about times and meetings and questions, up to 3 a day");
  });

  it("hold anyone else, any other kind, a first message and the day's limit for the owner", () => {
    const ask = { area: "mail" as const, action: "reply" as const, subject: "Lunch", text: "Are you free Friday?" };
    expect(checkAction(limits, { ...ask, who: "stranger@else.example" }, { today: 0 })).toEqual({ verdict: "needs-approval", reason: "The other person is not one of the senders you listed." });
    expect(checkAction(limits, { ...ask, who: "sam@example.org", text: "The invoice is attached, please pay." }, { today: 0 })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("money") });
    // The app's own word on the kind counts too: every kind found must be allowed.
    expect(checkAction(limits, { ...ask, who: "sam@example.org", kinds: ["legal"] }, { today: 0 })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("contracts") });
    expect(checkAction(limits, { ...ask, action: "send", who: "sam@example.org" }, { today: 0 })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("write first") });
    expect(checkAction(limits, { ...ask, who: "sam@example.org" }, { today: 3 })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("3 messages on its own today") });
  });

  it("refuse anything that names a never-touch entry, before any other threshold", () => {
    expect(neverTouchHit(limits, ["Boss <boss@team.example>"], [])).toBe("boss@team.example");
    expect(neverTouchHit(limits, ["x@bank.example"], [])).toBe("@bank.example");
    expect(neverTouchHit(limits, ["sam@example.org"], ["My lawyer says no"])).toBe("lawyer");
    expect(neverTouchHit(limits, ["sam@example.org"], ["The lawyers are fine"])).toBeNull();
    expect(checkAction(limits, { area: "mail", action: "reply", who: "Boss <boss@team.example>", text: "Free Friday?" }, { today: 0 })).toEqual({
      verdict: "refused",
      reason: 'It names "boss@team.example", which is on your never-touch list.',
    });
    expect(checkAction(DEFAULT_LIMITS, { area: "mail", action: "reply", who: "x" }, { today: 0 }).verdict).toBe("needs-approval");
  });

  it("accept an invite only from listed people, short enough, in free hours and clear of the calendar", () => {
    const ask = { area: "calendar" as const, action: "accept" as const, who: "Kim <kim@team.example>", subject: "Sync" };
    // Tuesday 8 January 2030, 10:00 in Paris (09:00 UTC), 30 minutes.
    expect(checkAction(limits, { ...ask, start: "2030-01-08T09:00:00Z", minutes: 30 }, { today: 0, now: NOW })).toMatchObject({ verdict: "allowed" });
    expect(checkAction(limits, { ...ask, start: "2030-01-08T09:00:00Z", minutes: 90 }, { today: 0, now: NOW })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("longer than the 45") });
    // 16:30 to 17:15 runs past the free hours.
    expect(checkAction(limits, { ...ask, start: "2030-01-08T15:30:00Z", minutes: 45 }, { today: 0, now: NOW })).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("free hours") });
    // Saturday.
    expect(checkAction(limits, { ...ask, start: "2030-01-12T09:00:00Z", minutes: 30 }, { today: 0, now: NOW }).verdict).toBe("needs-approval");
    expect(checkAction(limits, { ...ask, start: "2030-01-08T09:00:00Z", minutes: 30, conflicts: true }, { today: 0, now: NOW })).toMatchObject({ reason: "It overlaps something already in your calendar." });
    expect(checkAction(limits, { ...ask, start: "2029-01-08T09:00:00Z", minutes: 30 }, { today: 0, now: NOW })).toMatchObject({ reason: "The time is in the past." });
    expect(checkAction(limits, { ...ask, who: "sam@example.org", start: "2030-01-08T09:00:00Z", minutes: 30 }, { today: 0, now: NOW }).verdict).toBe("needs-approval");
    expect(checkAction(limits, { ...ask, start: "2030-01-08T09:00:00Z", minutes: 30 }, { today: 2, now: NOW }).verdict).toBe("needs-approval");
    // Declining on its own is a choice of its own.
    expect(checkAction(limits, { ...ask, action: "decline" }, { today: 0, now: NOW })).toEqual({ verdict: "needs-approval", reason: "Declining on its own is off." });
    expect(checkAction(cleanLimits({ ...limits, calendar: { ...limits.calendar, mayDecline: true } }), { ...ask, action: "decline" }, { today: 0, now: NOW }).verdict).toBe("allowed");
  });

  it("count the day from midnight in the owner's time zone, and a meeting must fit the free hours whole", () => {
    expect(startOfDay(new Date("2030-01-07T22:30:00Z"), "Europe/Paris").toISOString()).toBe("2030-01-06T23:00:00.000Z");
    expect(startOfDay(new Date("2030-01-07T23:30:00Z"), "Europe/Paris").toISOString()).toBe("2030-01-07T23:00:00.000Z");
    expect(startOfDay(new Date("2030-01-07T12:00:00Z"), "UTC").toISOString()).toBe("2030-01-07T00:00:00.000Z");
    expect(inFreeHours(limits.meetings, new Date("2030-01-08T15:00:00Z"), 60)).toBe(true);
    expect(inFreeHours(limits.meetings, new Date("2030-01-08T15:00:00Z"), 61)).toBe(false);
  });

  it("are summed up in plain lines for apps and the vault", () => {
    const lines = thresholdsSummary(limits);
    expect(lines[0]).toContain("Mail: it may reply to sam@example.org, @team.example and robin lee about times and meetings, questions and thanks and confirmations, up to 3 a day");
    expect(lines.some((l) => l.startsWith("Invites: it may accept invites from @team.example of up to 45 minutes"))).toBe(true);
    expect(lines).toContain("Negotiation: off. Every offer waits for the owner.");
    expect(lines.at(-1)).toBe("Never touched: lawyer, boss@team.example and @bank.example.");
  });

  it("keep a request for the owner to plain, bounded fields", () => {
    const r = cleanActRequest({ area: "nonsense", who: " Sam \n ", thread: Array.from({ length: 40 }, (_, i) => ({ from: "x", text: String(i) })), ref: { "bad key": "x", thread: "t1" }, when: { start: "not a time" } });
    expect(r.area).toBe("mail");
    expect(r.who).toBe("Sam");
    expect(r.thread).toHaveLength(30);
    expect(r.ref).toEqual({ thread: "t1" });
    expect(r.when).toBeNull();
  });
});
