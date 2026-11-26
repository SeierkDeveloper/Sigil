import { describe, expect, it } from "vitest";
import { agreedTime, cleanLimits, DEFAULT_LIMITS, localTime, meetingWithinLimits, paymentWithinLimits, replyWithinLimits } from "../src/limits";

describe("limits for acting", () => {
  it("are off until the owner turns them on, and refuse what cannot be a limit", () => {
    const l = cleanLimits({});
    expect(l).toEqual(DEFAULT_LIMITS);
    expect(replyWithinLimits(l, "sam@example.org")).toEqual({ ok: false, reason: "Replies on its own are off." });
    expect(meetingWithinLimits(l, new Date("2030-01-07T10:00:00Z"))).toMatchObject({ ok: false });
    expect(paymentWithinLimits(l, { listed: true, value: 1n, max: null, chainRefusal: null })).toMatchObject({ ok: false });
    expect(() => cleanLimits({ meetings: { from: "17:00", to: "09:00" } })).toThrow(/end after/);
    expect(() => cleanLimits({ meetings: { timeZone: "Not/AZone" } })).toThrow(/time zone/);
    expect(() => cleanLimits({ payments: { maxPerPayment: "1e5" } })).toThrow(/amount/);
  });

  it("let the self reply on its own only to listed contacts", () => {
    const l = cleanLimits({ replies: { on: true, contacts: ["Sam@Example.org", "Robin Lee", "sam@example.org"] } });
    expect(l.replies.contacts).toEqual(["sam@example.org", "robin lee"]);
    expect(replyWithinLimits(l, "Sam <sam@example.org>")).toEqual({ ok: true, limit: "Replies to listed contacts (sam@example.org)" });
    expect(replyWithinLimits(l, '"Robin Lee" <robin@elsewhere.example>')).toMatchObject({ ok: true });
    expect(replyWithinLimits(l, "Mallory <sam@example.org.evil>")).toMatchObject({ ok: false, reason: "The sender is not one of the contacts you listed." });
    expect(replyWithinLimits(l, "")).toMatchObject({ ok: false });
  });

  it("accept a meeting on its own only in free hours, in the owner's time zone", () => {
    const l = cleanLimits({ meetings: { on: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "Europe/Paris" } });
    const now = Date.parse("2029-01-01T00:00:00Z");
    // Monday 7 January 2030, 10:00 in Paris is 09:00 UTC.
    const at = agreedTime("Agreed: 2030-01-07 10:00 at the café. [done]", "Europe/Paris");
    expect(at?.toISOString()).toBe("2030-01-07T09:00:00.000Z");
    expect(meetingWithinLimits(l, at, now)).toEqual({ ok: true, limit: "Meetings in free hours (Mondays 09:00 to 17:00, Europe/Paris)" });
    expect(meetingWithinLimits(l, agreedTime("2030-01-07 18:30", "Europe/Paris"), now)).toMatchObject({ ok: false, reason: "That time is outside your free hours, 09:00 to 17:00." });
    expect(meetingWithinLimits(l, agreedTime("2030-01-05 10:00", "Europe/Paris"), now)).toMatchObject({ ok: false, reason: "That day is not one of your free days." });
    expect(meetingWithinLimits(l, agreedTime("2030-01-07T08:30Z", "Europe/Paris"), now)).toMatchObject({ ok: true });
    // No time, two times, or a time in the past: it goes to the queue.
    expect(meetingWithinLimits(l, agreedTime("Tuesday afternoon works", "Europe/Paris"), now)).toMatchObject({ ok: false });
    expect(agreedTime("2030-01-07 10:00 or 2030-01-08 10:00", "UTC")).toBeNull();
    expect(meetingWithinLimits(l, new Date("2020-01-06T10:00:00Z"), now)).toMatchObject({ ok: false, reason: "The agreed time is in the past." });
    expect(localTime(new Date("2030-01-07T23:30:00Z"), "Europe/Paris")).toEqual({ day: 2, time: "00:30" });
  });

  it("let the self key pay on its own only listed recipients, within the chain's answer and the owner's own amount", () => {
    const l = cleanLimits({ payments: { on: true, maxPerPayment: "0.05" } });
    expect(paymentWithinLimits(l, { listed: true, value: 10n, max: 20n, chainRefusal: null })).toMatchObject({ ok: true, limit: expect.stringContaining("up to 0.05") });
    expect(paymentWithinLimits(l, { listed: true, value: 30n, max: 20n, chainRefusal: null })).toMatchObject({ ok: false, reason: "Over the most per payment you set here." });
    expect(paymentWithinLimits(l, { listed: false, value: 1n, max: 20n, chainRefusal: null })).toMatchObject({ ok: false });
    expect(paymentWithinLimits(l, { listed: true, value: 1n, max: 20n, chainRefusal: "Over the cap per day." })).toEqual({ ok: false, reason: "Over the cap per day." });
  });
});
