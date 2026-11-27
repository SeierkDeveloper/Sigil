// A self that acts, end to end in-process: thresholds and ranges kept under the
// vault key; an AI app with its own mail access asking before it acts through
// the connector (allowed, needs-approval in Work, refused), the owner's answer
// sealed for that app, and a receipt the app signs under the self key's word;
// and the vault acting in the owner's own Gmail and Calendar through the
// device-side Google connection, played by fixtures, with receipts for what it
// did alone and steps that wait for the owner.

import { beforeEach, describe, expect, it } from "vitest";
import { checkReceipt, cleanLimits, DEFAULT_LIMITS, selfIdentityKey, type SelfLimits } from "@sigil/core";
import { count, dumpDb, harness, ORIGIN, readerFor, signedUp, type Harness } from "./helpers";
import { fake, gmailMessage, json } from "../../packages/core/test/fixtures/sync";
import * as ops from "../src/vault/ops";
import * as limitsOps from "../src/vault/limitsOps";
import * as acting from "../src/vault/actingOps";
import * as receipts from "../src/vault/receiptOps";
import * as sync from "../src/vault/syncOps";
import { sealPending } from "../src/server/seal";
import { ActingClient } from "../../connector/src/acting";

let h: Harness;
beforeEach(() => {
  h = harness();
});

// Tuesday 1 December 2026, 09:00 UTC: the fixtures' invites are later that week.
const NOW = Date.parse("2026-12-01T09:00:00Z");

const THRESHOLDS: Partial<SelfLimits> = {
  meetings: { on: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "UTC" },
  mail: { on: true, senders: ["sam@example.org", "@team.example"], kinds: ["scheduling", "question", "thanks", "money"], perDay: 2, mayStart: false },
  calendar: { on: true, people: ["@team.example"], maxMinutes: 60, perDay: 5, mayDecline: false },
  neverTouch: ["CANARY-never", "@bank.example"],
  ranges: { on: true, times: { on: true, minNoticeHours: 12, maxDaysAhead: 30 }, prices: [{ label: "Consulting day", side: "selling", min: "800", max: "1200", unit: "EUR" }], terms: { allowed: ["net 30"], forbidden: ["exclusivity"] }, maxRounds: 3 },
};

async function owner() {
  const s = await signedUp(h);
  await limitsOps.saveLimits(s.b.api, s.vault, cleanLimits({ ...DEFAULT_LIMITS, ...THRESHOLDS }));
  return { ...s, data: await ops.loadVault(s.b.api, s.vault) };
}

describe("thresholds and ranges", () => {
  it("are kept encrypted under the vault key like every limit", async () => {
    const o = await owner();
    expect(o.data.limits.mail.senders).toEqual(["sam@example.org", "@team.example"]);
    expect(o.data.limits.ranges.prices[0].label).toBe("Consulting day");
    const db = dumpDb(h.db);
    expect(db).not.toContain("CANARY-never");
    expect(db).not.toContain("Consulting day");
  });
});

describe("an AI app that asks before it acts", () => {
  async function withApp() {
    const o = await owner();
    const { appKey, appId } = await ops.connectApp(o.b.api, o.vault, { name: "Claude Desktop", kind: "claude-desktop" }, []);
    let data = await ops.loadVault(o.b.api, o.vault);
    const reader = readerFor(h, appKey);
    const client = new ActingClient(reader, () => NOW);
    return { ...o, appId, appKey, reader, client, data, refresh: async () => (data = await ops.loadVault(o.b.api, o.vault)) };
  }

  it("is refused until the owner lets it act, and gets the thresholds sealed for its key only", async () => {
    const o = await withApp();
    await expect(o.client.summary()).rejects.toMatchObject({ code: "acting_off" });
    await acting.setAppActing(o.b.api, o.vault, o.data, o.data.apps[0], true, ORIGIN);
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.apps[0].canAct).toBe(true);
    const lines = await o.client.summary();
    expect(lines[0]).toContain("sam@example.org");
    expect(lines.join("\n")).toContain("Price for Consulting day: opens at 1200 EUR, never below 800 EUR.");
    expect(dumpDb(h.db)).not.toContain("CANARY-never");
    // Saving the limits again wraps them again for the app.
    const saved = await limitsOps.saveLimits(o.b.api, o.vault, cleanLimits({ ...data.limits, neverTouch: ["CANARY-never", "CANARY-new"] }));
    expect(await acting.refreshAppActing(o.b.api, o.vault, { ...data, limits: saved }, ORIGIN)).toBe(1);
    expect((await o.client.summary()).at(-1)).toContain("canary-new");
    await acting.setAppActing(o.b.api, o.vault, data, data.apps[0], false);
    await expect(o.client.check({ area: "mail", action: "reply", who: "sam@example.org" })).rejects.toMatchObject({ code: "acting_off" });
  });

  it("answers allowed, needs-approval and refused, and keeps a receipt only for what it did", async () => {
    const o = await withApp();
    await acting.setAppActing(o.b.api, o.vault, o.data, o.data.apps[0], true, ORIGIN);
    const ok = await o.client.check({ area: "mail", action: "reply", who: "Sam <sam@example.org>", subject: "Lunch", text: "Free on Friday at 12:30?", next: "Friday works. CANARY-reply" });
    expect(ok).toMatchObject({ verdict: "allowed", limit: expect.stringContaining("replies to listed senders (sam@example.org)") });
    const held = await o.client.check({ area: "mail", action: "reply", who: "Stranger <x@else.example>", subject: "Offer", text: "Buy now?", next: "No thanks." });
    expect(held).toMatchObject({ verdict: "needs-approval", reason: "The other person is not one of the senders you listed." });
    const no = await o.client.check({ area: "mail", action: "reply", who: "Kim <kim@bank.example>", subject: "Hi", text: "Hello?" });
    expect(no).toMatchObject({ verdict: "refused" });
    // The server keeps the area and state; the request is sealed to the vault.
    expect(dumpDb(h.db)).not.toContain("CANARY-reply");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM acts WHERE app_id IS NOT NULL")).toBe(3);

    // Only an allowed (or approved) step takes a receipt, once.
    await expect(o.client.report({ id: held.id, what: "Replied" })).rejects.toThrow(/still waits/);
    await expect(o.client.report({ id: no.id, what: "Replied" })).rejects.toThrow(/did not allow/);
    const r = await o.client.report({ id: ok.id, what: "Replied to Sam that Friday works", ref: { message: "msg-1" } });
    await expect(o.client.report({ id: ok.id, what: "Again" })).rejects.toThrow(/already has its receipt/);

    // The owner reads the steps and the receipt, signed by the app's key under the self key's word.
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.acts.map((a) => a.state).sort()).toEqual(["done", "refused", "waiting"]);
    expect(data.acts.find((a) => a.state === "done")?.request).toMatchObject({ next: "Friday works. CANARY-reply", who: "Sam <sam@example.org>" });
    let list = await receipts.loadReceipts(o.b.api, o.vault, data.box);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r.receiptId, appId: o.appId });
    expect(list[0].receipt?.body).toMatchObject({ kind: "mail", what: "Replied to Sam that Friday works", selfKey: (await selfIdentityKey(o.vault.raw)).address, ref: { step: ok.id, message: "msg-1" } });
    expect(list[0].receipt?.body.via?.app).toBe(o.appId);
    sealPending(h.db, Date.now() + 2 * 3600_000);
    list = await receipts.loadReceipts(o.b.api, o.vault, data.box);
    const checked = checkReceipt(list[0].shared!);
    expect(checked.ok).toBe(true);
    expect(checked.checks[0].detail).toContain("by the receipt key it gave a connected app");
    expect(dumpDb(h.db)).not.toContain("Replied to Sam");
  });

  it("brings the owner's answer back under the app's key, with the owner's own text", async () => {
    const o = await withApp();
    await acting.setAppActing(o.b.api, o.vault, o.data, o.data.apps[0], true, ORIGIN);
    const held = await o.client.check({ area: "mail", action: "reply", who: "x@else.example", subject: "Offer", text: "Interested?", next: "Maybe." });
    const other = await o.client.check({ area: "mail", action: "reply", who: "y@else.example", subject: "Spam", text: "Win?", next: "No." });
    expect(await o.client.status(held.id)).toEqual({ state: "waiting" });
    let data = await ops.loadVault(o.b.api, o.vault);
    const step = data.acts.find((a) => a.id === held.id)!;
    expect(step.request?.reason).toContain("not one of the senders");
    await acting.approveAct(o.b.api, o.vault, data, step, "Yes, CANARY-owner-text.");
    await acting.declineAct(o.b.api, o.vault, data, data.acts.find((a) => a.id === other.id)!);
    expect(dumpDb(h.db)).not.toContain("CANARY-owner-text");
    expect(await o.client.status(held.id)).toEqual({ state: "approved", next: "Yes, CANARY-owner-text." });
    expect(await o.client.status(other.id)).toEqual({ state: "declined" });
    // An answer moved onto another step does not open as that step's answer.
    const rows = h.db.prepare("SELECT id, answer FROM acts WHERE id IN (?, ?)").all(held.id, other.id) as { id: string; answer: string }[];
    h.db.prepare("UPDATE acts SET answer = ? WHERE id = ?").run(rows.find((x) => x.id === held.id)!.answer, other.id);
    await expect(o.client.status(other.id)).rejects.toThrow();
    // Approved, it may act and keep a receipt.
    await o.client.report({ id: held.id, what: "Replied with the owner's text" });
    data = await ops.loadVault(o.b.api, o.vault);
    const list = await receipts.loadReceipts(o.b.api, o.vault, data.box);
    expect(list[0].receipt?.body.limit).toBe("Approved by the owner in Work");
  });

  it("counts the day's steps across the vault and every app", async () => {
    const o = await withApp();
    await acting.setAppActing(o.b.api, o.vault, o.data, o.data.apps[0], true, ORIGIN);
    // Counted from midnight today in the owner's time zone, on the server's own clock.
    const client = new ActingClient(o.reader);
    const ask = { area: "mail" as const, action: "reply" as const, who: "sam@example.org", subject: "Lunch", text: "Free Friday?" };
    expect((await client.check(ask)).verdict).toBe("allowed");
    expect((await client.check(ask)).verdict).toBe("allowed");
    expect(await client.check(ask)).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("2 messages on its own today") });
    expect(await acting.aloneToday(o.b.api, o.data.limits)).toMatchObject({ mail: 2 });
  });

  it("negotiates within the ranges and stops at the edge", async () => {
    const o = await withApp();
    await acting.setAppActing(o.b.api, o.vault, o.data, o.data.apps[0], true, ORIGIN);
    const open = await o.client.negotiate({ kind: "price", topic: "Consulting day in March", who: "Kim <kim@team.example>" });
    expect(open).toMatchObject({ state: "allowed", step: { move: "counter", offer: { price: "1200" } } });
    const counter = await o.client.negotiate({ kind: "price", topic: "Consulting day in March", who: "Kim <kim@team.example>", theirs: { price: "900" }, ours: { price: "1200" }, round: 1 });
    expect(counter.step).toMatchObject({ move: "counter", offer: { price: "1050" }, say: "I can do 1050 EUR." });
    await o.client.report({ id: counter.id, what: "Offered 1050 EUR" });
    const edge = await o.client.negotiate({ kind: "price", topic: "Consulting day in March", who: "Kim <kim@team.example>", theirs: { price: "750" }, ours: { price: "1050" }, round: 2, thread: [{ from: "Kim", text: "750 EUR is our budget." }] });
    expect(edge).toMatchObject({ state: "waiting", step: { move: "ask" } });
    const time = await o.client.negotiate({ kind: "time", topic: "Kick-off call", who: "Kim", theirs: { time: "2026-12-05T10:00:00Z", minutes: 30 } });
    // Saturday: it offers Monday 7 December at 09:00.
    expect(time.step).toMatchObject({ move: "counter", offer: { time: "2026-12-07T09:00:00.000Z" } });
    const terms = await o.client.negotiate({ kind: "terms", topic: "Contract", who: "Kim", theirs: { terms: ["Net 30", "Exclusivity"] } });
    expect(terms).toMatchObject({ state: "waiting", step: { move: "ask", reason: '"exclusivity" is a term you never agree to.' } });
    const data = await ops.loadVault(o.b.api, o.vault);
    const waiting = data.acts.find((a) => a.id === edge.id)!;
    expect(waiting.request).toMatchObject({ area: "negotiation", next: "I cannot do 750 EUR. The best I can do is 800 EUR.", thread: [{ from: "Kim", text: "750 EUR is our budget." }], offer: { price: "800", unit: "EUR" } });
    const list = await receipts.loadReceipts(o.b.api, o.vault, data.box);
    expect(list[0].receipt?.body).toMatchObject({ kind: "negotiation", what: "Offered 1050 EUR" });
  });
});

// ---------------------------------------------------------------- the vault, in the owner's own Google account

const SEND = "https://www.googleapis.com/auth/gmail.send";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";

function googleActing() {
  const threads: Record<string, ReturnType<typeof gmailMessage>[]> = {
    t1: [gmailMessage({ id: "a1", threadId: "t1", from: "Sam <sam@example.org>", to: "me@example.org", subject: "Lunch", at: "2026-12-01T08:00:00Z", text: "Are you free for lunch on Friday?" })],
    t2: [gmailMessage({ id: "b1", threadId: "t2", from: "Stranger <x@else.example>", to: "me@example.org", subject: "Partnership", at: "2026-12-01T08:10:00Z", text: "Could we talk about a partnership?" })],
    t3: [gmailMessage({ id: "c1", threadId: "t3", from: "Kim <kim@team.example>", to: "me@example.org", subject: "Consulting day in March", at: "2026-12-01T08:20:00Z", text: "Could you do the consulting day for 900 EUR?" })],
    t4: [gmailMessage({ id: "d1", threadId: "t4", from: "Bank <info@bank.example>", to: "me@example.org", subject: "Your account", at: "2026-12-01T08:30:00Z", text: "Please confirm?" })],
    t5: [
      gmailMessage({ id: "e1", threadId: "t5", from: "Sam <sam@example.org>", to: "me@example.org", subject: "Old", at: "2026-12-01T07:00:00Z", text: "Thanks!" }),
      gmailMessage({ id: "e2", threadId: "t5", from: "me@example.org", to: "Sam", subject: "Re: Old", at: "2026-12-01T07:30:00Z", text: "You are welcome.", labels: ["SENT"] }),
    ],
  };
  const events = [
    { id: "inv1", iCalUID: "inv1@google.com", status: "confirmed", summary: "Planning", start: { dateTime: "2026-12-03T10:00:00Z" }, end: { dateTime: "2026-12-03T10:30:00Z" }, organizer: { email: "lee@team.example", displayName: "Lee" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "needsAction" }, { email: "lee@team.example" }] },
    { id: "inv2", iCalUID: "inv2@google.com", status: "confirmed", summary: "Late review", start: { dateTime: "2026-12-03T16:30:00Z" }, end: { dateTime: "2026-12-03T17:30:00Z" }, organizer: { email: "lee@team.example" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "needsAction" }] },
    { id: "evt3", iCalUID: "evt3@google.com", status: "confirmed", summary: "Mine", start: { dateTime: "2026-12-04T10:00:00Z" }, end: { dateTime: "2026-12-04T11:00:00Z" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "accepted" }] },
  ];
  const sent: { raw: string; threadId: string }[] = [];
  const answered: { id: string; status: string }[] = [];
  const READ = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";
  let signIns = 0;
  const p = fake([
    [
      /oauth2\.googleapis\.com\/token$/,
      (_u, init) => {
        const f = new URLSearchParams(String(init?.body ?? ""));
        // The first sign-in reads only; the second, for acting, also grants sending and answering. A refresh keeps what was granted.
        if (f.get("grant_type") === "refresh_token") return json({ access_token: "ya29.CANARY-fresh", expires_in: 3599, scope: `${READ} ${SEND} ${EVENTS}`, token_type: "Bearer" });
        if (f.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
        signIns++;
        return json({ access_token: "ya29.CANARY-act", expires_in: 3599, refresh_token: "1//r", scope: signIns === 1 ? READ : `${READ} ${SEND} ${EVENTS}`, token_type: "Bearer" });
      },
    ],
    [/gmail\/v1\/users\/me\/threads$/, () => json({ threads: Object.keys(threads).map((id) => ({ id })) })],
    [/gmail\/v1\/users\/me\/threads\/[^/]+$/, (u) => json({ id: u.pathname.split("/").pop(), messages: threads[u.pathname.split("/").pop()!] })],
    [
      /gmail\/v1\/users\/me\/messages\/send$/,
      (_u, init) => {
        const b = JSON.parse(String(init?.body)) as { raw: string; threadId: string };
        sent.push(b);
        return json({ id: `sent-${sent.length}`, threadId: b.threadId });
      },
    ],
    [/calendar\/v3\/calendars\/primary\/events$/, () => json({ items: events })],
    [
      /calendar\/v3\/calendars\/primary\/events\/[^/]+$/,
      (u, init) => {
        const id = u.pathname.split("/").pop()!;
        const e = events.find((x) => x.id === id);
        if (!init?.method || init.method === "GET") return e ? json(e) : json({}, 404);
        const b = JSON.parse(String(init.body)) as { attendees: { self?: boolean; responseStatus?: string }[] };
        answered.push({ id, status: b.attendees.find((a) => a.self)?.responseStatus ?? "" });
        return json({ ...e, attendees: b.attendees });
      },
    ],
  ]);
  const decode = (raw: string) => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const [head, body] = text.split("\r\n\r\n");
    return { head, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") };
  };
  return { ...p, sent, answered, decode };
}

async function actingSource(kind: "gmail" | "calendar") {
  const o = await owner();
  const folder = await ops.addFolder(o.b.api, o.vault, kind === "gmail" ? "Mail" : "Calendar");
  const g = googleActing();
  const source = await sync.connectSource(o.b.api, o.vault, { kind, clientId: "cid.apps.example", folder, origin: ORIGIN, fetch: g.fetch, authorize: async (_u, state) => ({ code: "good-code", state }) });
  let data = await ops.loadVault(o.b.api, o.vault);
  let asked = "";
  const on = await acting.enableActing(o.b.api, o.vault, data, data.sync[0], {
    clientId: "cid.apps.example",
    origin: ORIGIN,
    fetch: g.fetch,
    now: NOW - 3600_000,
    authorize: async (url, state) => {
      asked = url;
      return { code: "good-code", state };
    },
  });
  data = await ops.loadVault(o.b.api, o.vault);
  return { ...o, g, source, on, data: { ...data, sync: data.sync.map((s) => ({ ...s, state: s.state ? { ...s.state, account: "me@example.org" } : s.state })) }, asked };
}

describe("acting in the owner's own Gmail, from the device", () => {
  it("asks Google once for sending, keeps the source's state encrypted, and acts only when on", async () => {
    const s = await actingSource("gmail");
    expect(s.asked).toContain(encodeURIComponent(SEND));
    expect(s.on.state?.act).toMatchObject({ on: true, handled: [] });
    expect(acting.sourceActs(s.data.sync[0])).toBe(true);
    expect(dumpDb(h.db)).not.toContain("CANARY-act");
    const off = await acting.disableActing(s.b.api, s.vault, s.data, s.data.sync[0]);
    expect(acting.sourceActs(off)).toBe(false);
  });

  it("replies within the thresholds, negotiates within the ranges, and holds or refuses the rest", async () => {
    const s = await actingSource("gmail");
    const { outcome, source } = await acting.actOnSource(s.b.api, s.vault, s.data, s.data.sync[0], { fetch: s.g.fetch, now: NOW });
    // Sam's question: a plain reply, alone. Kim's price: a counter inside the range, alone. The stranger waits. The bank is refused. The answered thread is left alone.
    expect(outcome).toMatchObject({ acted: 2, waiting: 1, refused: 1 });
    expect(s.g.sent.map((x) => x.threadId).sort()).toEqual(["t1", "t3"]);
    const toSam = s.g.decode(s.g.sent.find((x) => x.threadId === "t1")!.raw);
    expect(toSam.head).toContain("To: Sam <sam@example.org>");
    expect(toSam.head).toContain("Subject: Re: Lunch");
    expect(toSam.body).toContain("Hi Sam,");
    const toKim = s.g.decode(s.g.sent.find((x) => x.threadId === "t3")!.raw);
    expect(toKim.body).toContain("I can do 1050 EUR.");
    expect(source.state?.act?.handled.sort()).toEqual(["a1", "b1", "c1", "d1"]);
    expect(source.state?.act?.last).toMatchObject({ acted: 2, waiting: 1, refused: 1, error: null });

    const data = await ops.loadVault(s.b.api, s.vault);
    const byWho = (w: string) => data.acts.find((a) => a.request?.who.includes(w))!;
    // Counted from the steps themselves (the test's clock is ahead of the server's, so from long ago here).
    const counted = { ...source, state: { ...source.state!, act: { ...source.state!.act!, since: "2000-01-01T00:00:00.000Z" } } };
    expect(acting.sourceSteps(data.acts, counted)).toEqual({ acted: 2, waiting: 1, refused: 1 });
    expect(byWho("Stranger")).toMatchObject({ state: "waiting", request: { area: "mail", reason: "The other person is not one of the senders you listed." } });
    expect(byWho("Bank").state).toBe("refused");
    expect(byWho("Kim")).toMatchObject({ state: "done", alone: true, request: { area: "negotiation", offer: { price: "1050" } } });
    const list = await receipts.loadReceipts(s.b.api, s.vault, data.box);
    expect(list.map((r) => r.receipt?.body.kind).sort()).toEqual(["mail", "negotiation"]);
    expect(list.every((r) => r.appId === null && checkReceipt(r.shared!).ok)).toBe(true);
    expect(dumpDb(h.db)).not.toContain("Partnership");

    // A second pass handles nothing twice.
    const again = await acting.actOnSource(s.b.api, s.vault, data, source, { fetch: s.g.fetch, now: NOW });
    expect(again.outcome).toMatchObject({ acted: 0, waiting: 0, refused: 0 });
    // Even a device with an older copy of the source, which has not seen what was handled, answers nothing twice.
    const stale = await acting.actOnSource(s.b.api, s.vault, data, { ...s.data.sync[0], ownerRev: 0, appRev: 0 }, { fetch: s.g.fetch, now: NOW }).catch((e: Error) => e);
    expect(s.g.sent).toHaveLength(2);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM acts")).toBe(4);
    void stale;

    // The owner says yes to the stranger's reply with their own text: it goes out from this device, with a receipt.
    const waiting = byWho("Stranger");
    const done = await acting.approveAct(s.b.api, s.vault, data, waiting, "Happy to talk. CANARY-own", { carryOut: acting.carryOutWith(s.b.api, s.vault, data, { fetch: s.g.fetch, now: NOW }) });
    expect(done.state).toBe("done");
    expect(s.g.decode(s.g.sent.at(-1)!.raw).body).toBe("Happy to talk. CANARY-own");
    const after = await receipts.loadReceipts(s.b.api, s.vault, data.box);
    expect(after[0].receipt?.body).toMatchObject({ kind: "mail", limit: "Approved by you in Work" });
  });
});

describe("acting in the owner's own Calendar, from the device", () => {
  it("accepts an invite within the thresholds and holds one past the free hours, with the next time that fits", async () => {
    const s = await actingSource("calendar");
    expect(s.asked).toContain(encodeURIComponent(EVENTS));
    const { outcome } = await acting.actOnSource(s.b.api, s.vault, s.data, s.data.sync[0], { fetch: s.g.fetch, now: NOW });
    expect(outcome).toMatchObject({ acted: 1, waiting: 1, refused: 0 });
    expect(s.g.answered).toEqual([{ id: "inv1", status: "accepted" }]);
    const data = await ops.loadVault(s.b.api, s.vault);
    const late = data.acts.find((a) => a.state === "waiting")!;
    expect(late.request).toMatchObject({ area: "calendar", subject: "Late review", when: { start: "2026-12-03T16:30:00.000Z", minutes: 60 } });
    expect(late.request?.reason).toContain("outside your free hours");
    expect(late.request?.reason).toContain("The next time that fits your ranges is Friday 4 December at 09:00");
    const list = await receipts.loadReceipts(s.b.api, s.vault, data.box);
    expect(list[0].receipt?.body).toMatchObject({ kind: "calendar", what: expect.stringContaining('Accepted "Planning" from Lee') });
    // The owner says yes: it is accepted from this device, with a receipt.
    await acting.approveAct(s.b.api, s.vault, data, late, "", { carryOut: acting.carryOutWith(s.b.api, s.vault, data, { fetch: s.g.fetch, now: NOW }) });
    expect(s.g.answered.at(-1)).toEqual({ id: "inv2", status: "accepted" });
  });
});
