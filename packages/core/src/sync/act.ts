// Acting in the owner's own Google account, from the device: the mail that
// waits for an answer and the invites that wait for a yes or no, read with the
// owner's own tokens, and a reply sent or an invite answered when the owner's
// thresholds allow it (acting.ts) or the owner said yes in Work. This needs a
// Google client the site is configured with (SIGIL_GOOGLE_CLIENT_ID) and two
// more scopes than reading does: gmail.send and calendar.events. Nothing here
// goes through Sigil's server; the fetch is injected, so tests play the APIs.

import { toBase64Url, utf8 } from "../encoding";
import { addressOf } from "../limits";
import { CALENDAR, GMAIL, getJson, gmailHeader, gmailMessageText, type CalendarEvent, type GmailThread, type ProviderCtx } from "./google";
import { SyncError } from "./oauth";

/** A message waiting for an answer: the last one in its thread, from someone else. */
export interface InboxMessage {
  threadId: string;
  messageId: string;
  /** The Message-ID header, for the reply's In-Reply-To. */
  rfcId: string;
  references: string;
  from: string;
  subject: string;
  text: string;
  at: string;
  /** The thread so far, oldest first, as the owner reads it in Work. */
  thread: { from: string; text: string }[];
}

/** An invite waiting for the owner's answer. */
export interface Invite {
  eventId: string;
  /** The event's iCalendar UID: the ref its synced memory carries. */
  uid: string;
  title: string;
  organizer: string;
  start: string;
  minutes: number;
  description: string;
  attendees: NonNullable<CalendarEvent["attendees"]>;
}

type Ctx = Pick<ProviderCtx, "token" | "fetch">;

async function send(ctx: Ctx, method: "POST" | "PATCH", url: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { method, headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new SyncError("The provider could not be reached.", "network");
  }
  if (res.status === 401) throw new SyncError("The provider no longer accepts this connection.", "auth", 401);
  if (res.status === 403) throw new SyncError("This connection may read but not act. Turn acting on again to grant it.", "auth", 403);
  if (!res.ok) throw new SyncError(`The provider answered ${res.status}.`, "provider", res.status);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Mail that waits for an answer: threads in the inbox from the last two days
 * whose newest message is from someone other than the account, newer than
 * `since` and not handled before. At most `max` of them.
 */
export async function inboxToAnswer(ctx: Ctx, opts: { account: string; since: number; handled: string[]; max?: number }): Promise<InboxMessage[]> {
  const q = encodeURIComponent("in:inbox newer_than:2d -in:spam -in:trash -in:chats");
  const list = await getJson<{ threads?: { id: string }[] }>(ctx, `${GMAIL}/threads?maxResults=20&q=${q}`);
  const me = opts.account.toLowerCase();
  const out: InboxMessage[] = [];
  for (const { id } of list.threads ?? []) {
    if (out.length >= (opts.max ?? 10)) break;
    let t: GmailThread;
    try {
      t = await getJson<GmailThread>(ctx, `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`);
    } catch (err) {
      if (err instanceof SyncError && err.code === "gone") continue;
      throw err;
    }
    const messages = (t.messages ?? []).filter((m) => !(m.labelIds ?? []).some((l) => l === "SPAM" || l === "TRASH")).sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    const last = messages[messages.length - 1];
    if (!last) continue;
    const from = gmailHeader(last, "from");
    const at = Number(last.internalDate ?? 0);
    if ((last.labelIds ?? []).includes("SENT") || (me && addressOf(from) === me)) continue;
    if (at < opts.since || opts.handled.includes(last.id)) continue;
    out.push({
      threadId: t.id,
      messageId: last.id,
      rfcId: gmailHeader(last, "message-id"),
      references: gmailHeader(last, "references"),
      from,
      subject: gmailHeader(last, "subject"),
      text: gmailMessageText(last).slice(0, 8000),
      at: new Date(at).toISOString(),
      thread: messages.slice(-10).map((m) => ({ from: gmailHeader(m, "from") || "Unknown sender", text: gmailMessageText(m).slice(0, 4000) })),
    });
  }
  return out;
}

const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** Standard base64 (with + / and padding), as MIME wants it. */
function base64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
}

/** A header value in plain ASCII, or as an encoded word when it is not. */
function headerValue(v: string): string {
  const line = oneLine(v);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(line) ? line : `=?UTF-8?B?${base64(utf8(line))}?=`;
}

/** The reply as a raw RFC 2822 message, base64url as the Gmail API takes it. */
export function replyRaw(m: Pick<InboxMessage, "from" | "subject" | "rfcId" | "references">, text: string): string {
  const subject = /^re:/i.test(m.subject.trim()) ? m.subject : `Re: ${m.subject}`;
  const body = base64(utf8(text.replace(/\r?\n/g, "\r\n"))).match(/.{1,76}/g)?.join("\r\n") ?? "";
  const lines = [
    `To: ${oneLine(m.from)}`,
    `Subject: ${headerValue(subject)}`,
    ...(m.rfcId ? [`In-Reply-To: ${oneLine(m.rfcId)}`, `References: ${oneLine(`${m.references} ${m.rfcId}`)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return toBase64Url(utf8(lines.join("\r\n")));
}

/** Sends a reply in its thread. Returns the id of the message sent. */
export async function sendReply(ctx: Ctx, m: InboxMessage, text: string): Promise<string> {
  const r = await send(ctx, "POST", `${GMAIL}/messages/send`, { raw: replyRaw(m, text), threadId: m.threadId });
  return String(r.id ?? "");
}

/** Invites in the next 60 days that wait for the owner's answer. All-day events are left out. */
export async function invitesToAnswer(ctx: Ctx, opts: { now: number; handled: string[]; max?: number }): Promise<Invite[]> {
  const params = new URLSearchParams({ timeMin: new Date(opts.now).toISOString(), timeMax: new Date(opts.now + 60 * 86_400_000).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
  const page = await getJson<{ items?: CalendarEvent[] }>(ctx, `${CALENDAR}?${params}`);
  const out: Invite[] = [];
  for (const e of page.items ?? []) {
    if (out.length >= (opts.max ?? 10)) break;
    const me = (e.attendees ?? []).find((a) => a.self);
    if (e.status === "cancelled" || !me || me.responseStatus !== "needsAction" || !e.start?.dateTime || !e.end?.dateTime) continue;
    if (opts.handled.includes(e.id)) continue;
    const start = Date.parse(e.start.dateTime);
    const end = Date.parse(e.end.dateTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({
      eventId: e.id,
      uid: e.iCalUID ?? e.id,
      title: e.summary || "Untitled event",
      organizer: e.organizer?.email ? (e.organizer.displayName ? `${e.organizer.displayName} <${e.organizer.email}>` : e.organizer.email) : "",
      start: new Date(start).toISOString(),
      minutes: Math.round((end - start) / 60_000),
      description: (e.description ?? "").slice(0, 4000),
      attendees: e.attendees ?? [],
    });
  }
  return out;
}

/** Answers an invite as the owner: accepted or declined, and the organizer is told. */
export async function answerInvite(ctx: Ctx, invite: Pick<Invite, "eventId" | "attendees">, answer: "accepted" | "declined"): Promise<void> {
  const attendees = invite.attendees.map((a) => (a.self ? { ...a, responseStatus: answer } : a));
  await send(ctx, "PATCH", `${CALENDAR}/${encodeURIComponent(invite.eventId)}?sendUpdates=all`, { attendees });
}

/** Answers an invite by its event id, reading its guests first (for a step the owner approved later). */
export async function answerInviteById(ctx: Ctx, eventId: string, answer: "accepted" | "declined"): Promise<void> {
  const e = await getJson<CalendarEvent>(ctx, `${CALENDAR}/${encodeURIComponent(eventId)}`);
  if (!(e.attendees ?? []).some((a) => a.self)) throw new SyncError("You are not a guest of this event any more.", "gone");
  await answerInvite(ctx, { eventId, attendees: e.attendees ?? [] }, answer);
}
