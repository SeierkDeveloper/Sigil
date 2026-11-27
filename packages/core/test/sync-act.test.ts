import { describe, expect, it } from "vitest";
import { answerInvite, inboxToAnswer, invitesToAnswer, replyRaw } from "../src/sync/act";
import { authorizeUrl, canAct } from "../src/sync/oauth";
import { fake, gmailMessage, json } from "./fixtures/sync";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("acting in the owner's Google account", () => {
  it("asks for sending or answering only when acting is turned on", () => {
    const pkce = { challenge: "c", state: "s" };
    const read = new URL(authorizeUrl({ kind: "gmail", clientId: "cid", redirectUri: "https://v.example/vault/connect", pkce }));
    expect(read.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    const act = new URL(authorizeUrl({ kind: "calendar", clientId: "cid", redirectUri: "https://v.example/vault/connect", pkce, act: true }));
    expect(act.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events");
    expect(canAct("gmail", "https://www.googleapis.com/auth/gmail.readonly")).toBe(false);
    expect(canAct("gmail", "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send")).toBe(true);
    expect(canAct("drive", "anything")).toBe(false);
  });

  it("writes a reply in its thread, with no way to add a header from the message", () => {
    const raw = decode(replyRaw({ from: "Sam <sam@example.org>\r\nBcc: evil@example.org", subject: "Lunch\nBcc: x@example.org", rfcId: "<m1@mail.example>", references: "<m0@mail.example>" }, "Friday works.\nSee you."));
    const [head, body] = raw.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "To: Sam <sam@example.org> Bcc: evil@example.org",
      "Subject: Re: Lunch Bcc: x@example.org",
      "In-Reply-To: <m1@mail.example>",
      "References: <m0@mail.example> <m1@mail.example>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Friday works.\r\nSee you.");
    expect(decode(replyRaw({ from: "x@example.org", subject: "Re: Café", rfcId: "", references: "" }, "Hi"))).toContain("Subject: =?UTF-8?B?");
  });

  it("reads only mail that waits for an answer, and only invites that wait for one", async () => {
    const threads: Record<string, unknown[]> = {
      t1: [gmailMessage({ id: "a1", threadId: "t1", from: "Sam <sam@example.org>", to: "me", subject: "Lunch", at: "2026-12-01T08:00:00Z", text: "Free?" })],
      t2: [
        gmailMessage({ id: "b1", threadId: "t2", from: "Sam <sam@example.org>", to: "me", subject: "Old", at: "2026-12-01T07:00:00Z", text: "Thanks" }),
        gmailMessage({ id: "b2", threadId: "t2", from: "Me <me@example.org>", to: "Sam", subject: "Re: Old", at: "2026-12-01T07:10:00Z", text: "Welcome" }),
      ],
      t3: [gmailMessage({ id: "c1", threadId: "t3", from: "Kim <kim@example.org>", to: "me", subject: "Older", at: "2026-11-20T07:00:00Z", text: "Hi" })],
    };
    const events = [
      { id: "e1", status: "confirmed", summary: "Sync", start: { dateTime: "2026-12-03T10:00:00Z" }, end: { dateTime: "2026-12-03T10:30:00Z" }, organizer: { email: "lee@example.org", displayName: "Lee" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "needsAction" }] },
      { id: "e2", status: "confirmed", summary: "Done", start: { dateTime: "2026-12-03T11:00:00Z" }, end: { dateTime: "2026-12-03T11:30:00Z" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "accepted" }] },
      { id: "e3", status: "confirmed", summary: "All day", start: { date: "2026-12-04" }, end: { date: "2026-12-05" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "needsAction" }] },
    ];
    const patched: unknown[] = [];
    const p = fake([
      [/threads$/, () => json({ threads: Object.keys(threads).map((id) => ({ id })) })],
      [/threads\/[^/]+$/, (u) => json({ id: u.pathname.split("/").pop(), messages: threads[u.pathname.split("/").pop()!] })],
      [/events$/, () => json({ items: events })],
      [/events\/e1$/, (_u, init) => (patched.push(JSON.parse(String(init?.body))), json({}))],
    ]);
    const ctx = { token: "t", fetch: p.fetch };
    const mail = await inboxToAnswer(ctx, { account: "me@example.org", since: Date.parse("2026-11-30T00:00:00Z"), handled: [] });
    expect(mail.map((m) => m.messageId)).toEqual(["a1"]);
    expect(mail[0]).toMatchObject({ from: "Sam <sam@example.org>", subject: "Lunch", text: "Free?", thread: [{ from: "Sam <sam@example.org>", text: "Free?" }] });
    expect(await inboxToAnswer(ctx, { account: "me@example.org", since: 0, handled: ["a1", "c1"] })).toEqual([]);
    const invites = await invitesToAnswer(ctx, { now: Date.parse("2026-12-01T00:00:00Z"), handled: [] });
    expect(invites).toEqual([expect.objectContaining({ eventId: "e1", title: "Sync", organizer: "Lee <lee@example.org>", minutes: 30, start: "2026-12-03T10:00:00.000Z" })]);
    await answerInvite(ctx, invites[0], "accepted");
    expect(patched).toEqual([{ attendees: [{ email: "me@example.org", self: true, responseStatus: "accepted" }] }]);
    expect(p.calls.at(-1)?.url).toContain("sendUpdates=all");
  });
});
