// Recorded shapes of the Google and Slack APIs, played back by a fake fetch.
// The responses follow the providers' documented formats field for field;
// the content is made up. No test reaches a real provider.

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function gmailMessage(o: { id: string; threadId: string; from: string; to: string; subject: string; at: string; text?: string; html?: string; labels?: string[] }) {
  const parts = [] as unknown[];
  if (o.text !== undefined) parts.push({ partId: "0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: o.text.length, data: b64url(o.text) } });
  if (o.html !== undefined) parts.push({ partId: "1", mimeType: "text/html", filename: "", headers: [], body: { size: o.html.length, data: b64url(o.html) } });
  parts.push({ partId: "2", mimeType: "application/pdf", filename: "invoice.pdf", headers: [], body: { attachmentId: "att-1", size: 1000 } });
  return {
    id: o.id,
    threadId: o.threadId,
    labelIds: o.labels ?? ["INBOX"],
    snippet: (o.text ?? "").slice(0, 100),
    historyId: "1001",
    internalDate: String(Date.parse(o.at)),
    sizeEstimate: 2000,
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [
        { name: "From", value: o.from },
        { name: "To", value: o.to },
        { name: "Subject", value: o.subject },
        { name: "Date", value: new Date(o.at).toUTCString() },
      ],
      body: { size: 0 },
      parts: [{ partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts }],
    },
  };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface FakeProvider {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: { method: string; url: string; body: string; auth: string }[];
}

export function fake(routes: [RegExp, Handler][]): FakeProvider {
  const calls: FakeProvider["calls"] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ method: init?.method ?? "GET", url: url.toString(), body: String(init?.body ?? ""), auth: new Headers(init?.headers).get("authorization") ?? "" });
      for (const [re, h] of routes) if (re.test(`${url.origin}${url.pathname}`)) return h(url, init);
      return new Response(JSON.stringify({ error: { code: 404, message: "Not found" } }), { status: 404 });
    },
  };
}

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** A small mailbox: two threads, one with a reply, one in spam; later a new message arrives. */
export function gmailWorld() {
  const threads: Record<string, ReturnType<typeof gmailMessage>[]> = {
    "18c2a1f3b4d5e6f7": [
      gmailMessage({ id: "m1", threadId: "18c2a1f3b4d5e6f7", from: "Robin <robin@example.org>", to: "me", subject: "Launch plan", at: "2026-11-10T09:00:00Z", text: "CANARY-mail-1 Let's launch on the 24th." }),
      gmailMessage({ id: "m2", threadId: "18c2a1f3b4d5e6f7", from: "me", to: "Robin", subject: "Re: Launch plan", at: "2026-11-10T10:00:00Z", text: "Agreed.\n\nOn Mon Robin wrote:\n> CANARY-mail-1 Let's launch" }),
    ],
    "18c2a1f3b4d5e6f8": [gmailMessage({ id: "m3", threadId: "18c2a1f3b4d5e6f8", from: "Shop", to: "me", subject: "Your receipt", at: "2026-11-11T09:00:00Z", html: "<p>Thanks for <b>buying</b></p>" })],
    "18c2a1f3b4d5e6f9": [gmailMessage({ id: "m4", threadId: "18c2a1f3b4d5e6f9", from: "Spam", to: "me", subject: "Win", at: "2026-11-12T09:00:00Z", text: "spam", labels: ["SPAM"] })],
  };
  let historyId = "5000";
  const history: { messagesAdded: { message: { id: string; threadId: string } }[] }[] = [];
  const p = fake([
    [/gmail\/v1\/users\/me\/profile$/, () => json({ emailAddress: "me@example.org", messagesTotal: 4, threadsTotal: 3, historyId })],
    [
      /gmail\/v1\/users\/me\/threads$/,
      (u) => {
        const ids = Object.keys(threads);
        const page = u.searchParams.get("pageToken") === "p2" ? ids.slice(2) : ids.slice(0, 2);
        return json({ threads: page.map((id) => ({ id, snippet: "", historyId })), resultSizeEstimate: ids.length, ...(u.searchParams.get("pageToken") ? {} : { nextPageToken: "p2" }) });
      },
    ],
    [
      /gmail\/v1\/users\/me\/threads\/[^/]+$/,
      (u) => {
        const id = u.pathname.split("/").pop()!;
        return threads[id] ? json({ id, historyId, messages: threads[id] }) : json({ error: { code: 404 } }, 404);
      },
    ],
    [/gmail\/v1\/users\/me\/history$/, (u) => (u.searchParams.get("startHistoryId") === "stale" ? json({ error: { code: 404 } }, 404) : json({ history, historyId }))],
  ]);
  const arrive = (m: ReturnType<typeof gmailMessage>) => {
    threads[m.threadId] = [...(threads[m.threadId] ?? []), m];
    historyId = String(Number(historyId) + 1);
    history.push({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] });
  };
  const remove = (threadId: string) => {
    delete threads[threadId];
    historyId = String(Number(historyId) + 1);
    history.push({ messagesAdded: [{ message: { id: "gone", threadId } }] });
  };
  return { ...p, threads, arrive, remove };
}

export function calendarWorld() {
  const events = [
    {
      kind: "calendar#event",
      id: "evt1",
      status: "confirmed",
      summary: "Dentist",
      start: { dateTime: "2026-11-24T10:00:00+01:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-11-24T11:00:00+01:00", timeZone: "Europe/Paris" },
      iCalUID: "evt1@google.com",
      updated: "2026-11-01T08:00:00.000Z",
      organizer: { email: "me@example.org", self: true },
      attendees: [{ email: "me@example.org", self: true }, { email: "dr@example.org", displayName: "The clinic" }],
    },
    { kind: "calendar#event", id: "evt2", status: "confirmed", summary: "Team day", start: { date: "2026-11-26" }, end: { date: "2026-11-27" }, iCalUID: "evt2@google.com", updated: "2026-11-02T08:00:00.000Z" },
  ];
  let changes: unknown[] = [];
  const p = fake([
    [
      /calendar\/v3\/calendars\/primary\/events$/,
      (u) => {
        const sync = u.searchParams.get("syncToken");
        if (sync === "expired") return json({ error: { code: 410, message: "Sync token is no longer valid" } }, 410);
        if (sync) return json({ kind: "calendar#events", summary: "me@example.org", items: changes, nextSyncToken: `sync-${Date.now()}` });
        if (!u.searchParams.get("pageToken")) return json({ kind: "calendar#events", summary: "me@example.org", items: [events[0]], nextPageToken: "e2" });
        return json({ kind: "calendar#events", summary: "me@example.org", items: [events[1]], nextSyncToken: "sync-1" });
      },
    ],
  ]);
  return { ...p, setChanges: (c: unknown[]) => (changes = c) };
}

export function driveWorld() {
  const p = fake([
    [/drive\/v3\/changes\/startPageToken$/, () => json({ kind: "drive#startPageToken", startPageToken: "100" })],
    [
      /drive\/v3\/files$/,
      () =>
        json({
          kind: "drive#fileList",
          files: [
            { id: "doc1", name: "Book outline", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-05T10:00:00.000Z", createdTime: "2026-10-01T10:00:00.000Z", webViewLink: "https://docs.google.com/document/d/doc1" },
            { id: "txt1", name: "notes.md", mimeType: "text/markdown", modifiedTime: "2026-11-06T10:00:00.000Z", createdTime: "2026-11-06T10:00:00.000Z", size: "20" },
            { id: "img1", name: "photo.jpg", mimeType: "image/jpeg", modifiedTime: "2026-11-06T10:00:00.000Z" },
          ],
        }),
    ],
    [/drive\/v3\/files\/doc1\/export$/, () => new Response("﻿CANARY-doc Chapter one.\r\nChapter two.", { status: 200 })],
    [/drive\/v3\/files\/txt1$/, () => new Response("# Notes\nCANARY-md", { status: 200 })],
    [
      /drive\/v3\/changes$/,
      () =>
        json({
          kind: "drive#changeList",
          newStartPageToken: "101",
          changes: [
            { kind: "drive#change", fileId: "txt1", removed: false, file: { id: "txt1", trashed: true } },
            { kind: "drive#change", fileId: "doc1", removed: false, file: { id: "doc1", name: "Book outline v2", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-07T10:00:00.000Z" } },
          ],
        }),
    ],
  ]);
  return p;
}

export function slackWorld(nowSec: number) {
  const day = (offsetDays: number, h: number) => String(nowSec - offsetDays * 86_400 + h * 60 + 0.000123);
  const messages: Record<string, { ts: string; user?: string; text: string; type: string; subtype?: string }[]> = {
    C1: [
      { type: "message", ts: day(2, 0), user: "U1", text: "CANARY-slack <@U2> can you ship <https://example.org/x|the doc>?" },
      { type: "message", ts: day(2, 5), user: "U2", text: "Yes, by Friday in <#C1|general>" },
      { type: "message", ts: day(2, 6), subtype: "channel_join", user: "U3", text: "joined" },
    ],
    D1: [{ type: "message", ts: day(1, 0), user: "U2", text: "Lunch?" }],
  };
  const p = fake([
    [/slack\.com\/api\/auth\.test$/, () => json({ ok: true, url: "https://team.slack.com/", team: "Team", user: "me", team_id: "T1", user_id: "U1" })],
    [/slack\.com\/api\/users\.list$/, () => json({ ok: true, members: [{ id: "U1", name: "me", profile: { display_name: "Sam" } }, { id: "U2", name: "robin", real_name: "Robin" }], response_metadata: { next_cursor: "" } })],
    [/slack\.com\/api\/users\.conversations$/, () => json({ ok: true, channels: [{ id: "C1", name: "general", is_channel: true }, { id: "D1", is_im: true, user: "U2" }], response_metadata: { next_cursor: "" } })],
    [
      /slack\.com\/api\/conversations\.history$/,
      (_u, init) => {
        const f = new URLSearchParams(String(init?.body ?? ""));
        if (f.get("token") === "revoked") return json({ ok: false, error: "invalid_auth" });
        const oldest = Number(f.get("oldest") ?? 0);
        const latest = f.get("latest") ? Number(f.get("latest")) : Infinity;
        const list = (messages[f.get("channel") ?? ""] ?? []).filter((m) => Number(m.ts) > oldest - (f.get("inclusive") ? 0.001 : 0) && Number(m.ts) <= latest).reverse();
        return json({ ok: true, messages: list, has_more: false });
      },
    ],
  ]);
  return { ...p, messages, day };
}

export function tokenServer(opts: { refreshTo?: string; slack?: boolean } = {}) {
  return fake([
    [
      /oauth2\.googleapis\.com\/token$|slack\.com\/api\/oauth\.v2\.access$/,
      (_u, init) => {
        const f = new URLSearchParams(String(init?.body ?? ""));
        if (f.get("grant_type") === "authorization_code") {
          if (f.get("code") !== "good-code" || !f.get("code_verifier")) return json({ error: "invalid_grant", error_description: "Bad code" }, 400);
          return opts.slack
            ? json({ ok: true, app_id: "A1", authed_user: { id: "U1", scope: "channels:history", access_token: "xoxp-CANARY-access", token_type: "user", refresh_token: "xoxe-CANARY-refresh", expires_in: 43200 }, team: { id: "T1", name: "Team" } })
            : json({ access_token: "ya29.CANARY-access", expires_in: 3599, refresh_token: "1//CANARY-refresh", scope: "https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" });
        }
        if (f.get("grant_type") === "refresh_token") return json({ access_token: opts.refreshTo ?? "ya29.fresh", expires_in: 3599, scope: "s", token_type: "Bearer" });
        return json({ error: "unsupported_grant_type" }, 400);
      },
    ],
  ]);
}
