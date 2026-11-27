// Gmail, Google Calendar and Google Drive, read incrementally on the device.
//
//   Gmail     the profile's history id is kept; the first passes list threads of
//             the last 90 days page by page, later passes ask the history API
//             for what changed since that id and fetch only those threads
//   Calendar  the events list, page by page, ends with a sync token; later
//             passes send it and get only what changed (410 starts over)
//   Drive     a start page token is kept; the first passes list Docs and text
//             files, later passes ask the changes API what changed since it
//
// Each pass does a bounded amount of work and says whether there is more, so a
// large mailbox fills in over several passes. Everything here is plain fetch
// calls with the access token; the fetch is injected, so tests play the APIs.

import type { MemoryDraft } from "../vault";
import { htmlToText } from "../import/files";
import { SyncError, type SyncFetch } from "./oauth";

export interface SyncItem {
  /** The provider's own id for the thing, kept as the memory's source ref. */
  ref: string;
  draft: MemoryDraft;
}

export interface SyncBatch {
  items: SyncItem[];
  /** Refs of things deleted at the provider: their memories are deleted too. */
  removed: string[];
  cursor: string;
  /** More work waits for the next pass. */
  more: boolean;
  /** Who the account is, when the provider says (an address or a workspace name). */
  account?: string;
}

export interface ProviderCtx {
  token: string;
  fetch: SyncFetch;
  cursor: string | null;
  now: number;
}

export const MAIL_WINDOW_DAYS = 90;
export const THREADS_PER_PASS = 25;
export const MESSAGE_CHARS = 4000;
export const THREAD_CHARS = 20_000;
export const FILE_CHARS = 100_000;

export async function getJson<T>(ctx: Pick<ProviderCtx, "token" | "fetch">, url: string): Promise<T> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { authorization: `Bearer ${ctx.token}` } });
  } catch {
    throw new SyncError("The provider could not be reached.", "network");
  }
  if (res.status === 401) throw new SyncError("The provider no longer accepts this connection.", "auth", 401);
  if (res.status === 404 || res.status === 410) throw new SyncError("The provider no longer has this.", "gone", res.status);
  if (!res.ok) throw new SyncError(`The provider answered ${res.status}.`, "provider", res.status);
  return (await res.json()) as T;
}

async function getText(ctx: Pick<ProviderCtx, "token" | "fetch">, url: string): Promise<string> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { authorization: `Bearer ${ctx.token}` } });
  } catch {
    throw new SyncError("The provider could not be reached.", "network");
  }
  if (res.status === 401) throw new SyncError("The provider no longer accepts this connection.", "auth", 401);
  if (res.status === 404 || res.status === 410) throw new SyncError("The provider no longer has this.", "gone", res.status);
  if (!res.ok) throw new SyncError(`The provider answered ${res.status}.`, "provider", res.status);
  return res.text();
}

function parseCursor<T extends object>(cursor: string | null): Partial<T> {
  if (!cursor) return {};
  try {
    const v = JSON.parse(cursor);
    return v && typeof v === "object" ? (v as Partial<T>) : {};
  } catch {
    return {};
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- Gmail

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

function b64urlText(data: string): string {
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function partText(p: GmailPart | undefined, depth = 0): { plain: string | null; html: string | null } {
  if (!p || depth > 8) return { plain: null, html: null };
  if (p.filename) return { plain: null, html: null };
  const type = (p.mimeType ?? "").toLowerCase();
  if (type.startsWith("multipart/")) {
    let plain: string | null = null;
    let html: string | null = null;
    for (const c of p.parts ?? []) {
      const r = partText(c, depth + 1);
      plain ??= r.plain;
      html ??= r.html;
    }
    return { plain, html };
  }
  const data = p.body?.data ? b64urlText(p.body.data) : "";
  if (type === "text/plain") return { plain: data, html: null };
  if (type === "text/html") return { plain: null, html: data };
  return { plain: null, html: null };
}

function header(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value?.trim() ?? "";
}

/** A header of a message, by its name in lower case. */
export const gmailHeader = header;

/** The text of a message, quotes left out, as the sync keeps it. */
export function gmailMessageText(m: GmailMessage): string {
  const t = partText(m.payload);
  return withoutQuotes(t.plain ?? (t.html ? htmlToText(t.html) : ""));
}

/** Quoted replies repeat the thread; they are left out, as in the Takeout import. */
function withoutQuotes(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .replace(/\n[^\n]*wrote:\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SUBJECT_PREFIX = /^((re|fw|fwd|aw|sv|vs)(\[\d+\])?:\s*)+/i;
const SKIP_LABELS = new Set(["SPAM", "TRASH"]);

/**
 * The Gmail API names a thread with the hex form of the same number the
 * Takeout files carry as X-GM-THRID. Using the decimal form as the ref makes a
 * synced thread land on the memory a Takeout import already made.
 */
export function gmailThreadRef(threadId: string): string {
  try {
    return BigInt(`0x${threadId}`).toString(10);
  } catch {
    return threadId;
  }
}

/** One memory per thread, in the same shape as a Takeout import. Null for a thread that is all spam or trash. */
export function gmailThreadDraft(thread: GmailThread): SyncItem | null {
  const messages = (thread.messages ?? []).filter((m) => !(m.labelIds ?? []).some((l) => SKIP_LABELS.has(l)));
  if (messages.length === 0) return null;
  messages.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  const parts: string[] = [];
  let size = 0;
  for (const m of messages) {
    const at = Number(m.internalDate ?? 0);
    const t = partText(m.payload);
    const text = withoutQuotes(t.plain ?? (t.html ? htmlToText(t.html) : ""));
    const clipped = text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}\n[Shortened]` : text;
    const block = `### ${header(m, "from") || "Unknown sender"}\nTo: ${header(m, "to") || "unknown"}\nDate: ${at ? iso(at).replace("T", " ").slice(0, 16) : "unknown date"}\n\n${clipped || "(no text)"}`;
    if (size + block.length > THREAD_CHARS) {
      const left = messages.length - parts.length;
      parts.push(`[${left} more ${left === 1 ? "message" : "messages"} in this thread were left out.]`);
      break;
    }
    parts.push(block);
    size += block.length;
  }
  const subject = header(messages.find((m) => header(m, "subject")) ?? messages[0], "subject").replace(SUBJECT_PREFIX, "").trim();
  const first = Number(messages[0].internalDate ?? 0);
  const last = Number(messages[messages.length - 1].internalDate ?? 0);
  const ref = gmailThreadRef(thread.id);
  return {
    ref,
    draft: {
      title: (subject || "(no subject)").slice(0, 300),
      body: parts.join("\n\n"),
      tags: ["gmail", "email"],
      source: { kind: "gmail", ref },
      createdAt: first ? iso(first) : undefined,
      editedAt: last ? iso(last) : undefined,
    },
  };
}

interface GmailCursor {
  historyId: string;
  /** While the first listing runs: where it got to. */
  pageToken: string | null;
  phase: "list" | "history";
}

async function gmailThreads(ctx: ProviderCtx, ids: string[]): Promise<{ items: SyncItem[]; removed: string[] }> {
  const items: SyncItem[] = [];
  const removed: string[] = [];
  for (const id of ids) {
    try {
      const t = await getJson<GmailThread>(ctx, `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`);
      const item = gmailThreadDraft(t);
      if (item) items.push(item);
      else removed.push(gmailThreadRef(id));
    } catch (err) {
      if (err instanceof SyncError && err.code === "gone") removed.push(gmailThreadRef(id));
      else throw err;
    }
  }
  return { items, removed };
}

export async function syncGmail(ctx: ProviderCtx): Promise<SyncBatch> {
  let c = parseCursor<GmailCursor>(ctx.cursor);
  let account: string | undefined;
  if (!c.historyId) {
    const profile = await getJson<{ emailAddress?: string; historyId: string }>(ctx, `${GMAIL}/profile`);
    account = profile.emailAddress;
    c = { historyId: String(profile.historyId), pageToken: null, phase: "list" };
  }
  if (c.phase === "list") {
    const q = encodeURIComponent(`newer_than:${MAIL_WINDOW_DAYS}d -in:spam -in:trash`);
    const page = await getJson<{ threads?: { id: string }[]; nextPageToken?: string }>(
      ctx,
      `${GMAIL}/threads?maxResults=${THREADS_PER_PASS}&q=${q}${c.pageToken ? `&pageToken=${encodeURIComponent(c.pageToken)}` : ""}`,
    );
    const { items, removed } = await gmailThreads(ctx, (page.threads ?? []).map((t) => t.id));
    const next: GmailCursor = page.nextPageToken ? { historyId: c.historyId!, pageToken: page.nextPageToken, phase: "list" } : { historyId: c.historyId!, pageToken: null, phase: "history" };
    return { items, removed, cursor: JSON.stringify(next), more: !!page.nextPageToken, account };
  }
  // Later passes: only the threads that changed since the last history id.
  let h: { history?: { messagesAdded?: { message: GmailMessage }[]; messagesDeleted?: { message: GmailMessage }[]; labelsAdded?: { message: GmailMessage }[] }[]; historyId?: string; nextPageToken?: string };
  try {
    h = await getJson(ctx, `${GMAIL}/history?startHistoryId=${encodeURIComponent(c.historyId!)}&maxResults=100${c.pageToken ? `&pageToken=${encodeURIComponent(c.pageToken)}` : ""}`);
  } catch (err) {
    // The history id is too old: start over with a fresh listing.
    if (err instanceof SyncError && err.code === "gone") return { items: [], removed: [], cursor: "", more: true };
    throw err;
  }
  const ids = new Set<string>();
  for (const rec of h.history ?? []) {
    for (const list of [rec.messagesAdded, rec.messagesDeleted, rec.labelsAdded]) for (const x of list ?? []) if (x.message?.threadId) ids.add(x.message.threadId);
  }
  const wanted = [...ids].slice(0, THREADS_PER_PASS);
  const { items, removed } = await gmailThreads(ctx, wanted);
  const more = ids.size > wanted.length || !!h.nextPageToken;
  const next: GmailCursor = {
    historyId: ids.size > wanted.length ? c.historyId! : String(h.historyId ?? c.historyId),
    pageToken: ids.size > wanted.length ? (c.pageToken ?? null) : (h.nextPageToken ?? null),
    phase: "history",
  };
  return { items, removed, cursor: JSON.stringify(next), more };
}

// ---------------------------------------------------------------- Calendar

export const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface CalendarTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: CalendarTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean }[];
  created?: string;
  updated?: string;
}

function calText(t: CalendarTime | undefined): { text: string; iso: string; allDay: boolean } | null {
  if (!t) return null;
  if (t.date) return { text: t.date, iso: `${t.date}T00:00:00.000Z`, allDay: true };
  if (t.dateTime) {
    const ms = Date.parse(t.dateTime);
    if (!Number.isFinite(ms)) return null;
    return { text: `${t.dateTime.slice(0, 10)} ${t.dateTime.slice(11, 16)}${t.timeZone ? ` ${t.timeZone}` : ` (UTC${t.dateTime.slice(19) || "Z"})`}`, iso: iso(ms), allDay: false };
  }
  return null;
}

/** The ICS form of a time (20260115T093000Z), as Takeout files write a recurrence id. */
function icsStamp(t: CalendarTime | undefined): string {
  if (t?.date) return t.date.replace(/-/g, "");
  const ms = t?.dateTime ? Date.parse(t.dateTime) : NaN;
  return Number.isFinite(ms) ? iso(ms).replace(/[-:]/g, "").replace(/\.\d{3}/, "") : "";
}

/** The ref matches what the Takeout import keeps (the UID, and the recurrence id for a moved instance), so a synced event lands on the imported memory. */
export function calendarRef(e: CalendarEvent): string {
  const uid = e.iCalUID ?? e.id;
  return (e.recurringEventId && e.originalStartTime ? `${uid}#${icsStamp(e.originalStartTime)}` : uid).slice(0, 300);
}

export function calendarDraft(e: CalendarEvent): SyncItem | null {
  const start = calText(e.start);
  if (!start || (!e.summary && !e.description)) return null;
  const end = calText(e.end);
  const guests = (e.attendees ?? []).filter((a) => !a.self);
  const body = [
    `When: ${start.text}${end && end.text !== start.text ? ` to ${end.text}` : ""}${start.allDay ? " (all day)" : ""}`,
    e.location ? `Where: ${e.location}` : "",
    e.recurrence?.length ? `Repeats: ${(/FREQ=(\w+)/.exec(e.recurrence.join(";"))?.[1] ?? "yes").toLowerCase()}` : "",
    e.organizer ? `Organizer: ${e.organizer.displayName ?? e.organizer.email ?? ""}` : "",
    guests.length ? `Guests: ${guests.map((g) => g.displayName ?? g.email ?? "a guest").join(", ")}` : "",
    e.description ? `\n${htmlToText(e.description)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const ref = calendarRef(e);
  return {
    ref,
    draft: {
      title: (e.summary || "Untitled event").slice(0, 300),
      body,
      tags: ["calendar", "event"],
      source: { kind: "calendar", ref },
      createdAt: start.iso,
      editedAt: e.updated ? iso(Date.parse(e.updated)) : start.iso,
    },
  };
}

interface CalendarCursor {
  syncToken: string | null;
  pageToken: string | null;
}

export async function syncCalendar(ctx: ProviderCtx): Promise<SyncBatch> {
  const c = parseCursor<CalendarCursor>(ctx.cursor);
  const params = new URLSearchParams({ maxResults: "100", showDeleted: "true" });
  if (c.syncToken) params.set("syncToken", c.syncToken);
  if (c.pageToken) params.set("pageToken", c.pageToken);
  let page: { items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string; summary?: string };
  try {
    page = await getJson(ctx, `${CALENDAR}?${params}`);
  } catch (err) {
    // The sync token expired: list everything again.
    if (err instanceof SyncError && err.code === "gone" && c.syncToken) return { items: [], removed: [], cursor: "", more: true };
    throw err;
  }
  const items: SyncItem[] = [];
  const removed: string[] = [];
  for (const e of page.items ?? []) {
    if (e.status === "cancelled") {
      removed.push(calendarRef(e));
      continue;
    }
    const item = calendarDraft(e);
    if (item) items.push(item);
  }
  const next: CalendarCursor = page.nextPageToken ? { syncToken: c.syncToken ?? null, pageToken: page.nextPageToken } : { syncToken: page.nextSyncToken ?? c.syncToken ?? null, pageToken: null };
  return { items, removed, cursor: JSON.stringify(next), more: !!page.nextPageToken, account: page.summary };
}

// ---------------------------------------------------------------- Drive

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOC = "application/vnd.google-apps.document";
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv"]);
const FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,trashed,webViewLink,size";

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  trashed?: boolean;
  webViewLink?: string;
  size?: string;
}

export function driveReadable(f: DriveFile): boolean {
  return f.mimeType === DOC || TEXT_TYPES.has(f.mimeType ?? "");
}

async function driveItem(ctx: ProviderCtx, f: DriveFile): Promise<SyncItem | null> {
  if (!driveReadable(f) || f.trashed) return null;
  if (f.mimeType !== DOC && Number(f.size ?? 0) > FILE_CHARS * 4) return null;
  const text = f.mimeType === DOC ? await getText(ctx, `${DRIVE}/files/${encodeURIComponent(f.id)}/export?mimeType=text/plain`) : await getText(ctx, `${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media`);
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  const body = clean.length > FILE_CHARS ? `${clean.slice(0, FILE_CHARS)}\n\n[Shortened: the file is longer.]` : clean;
  return {
    ref: f.id,
    draft: {
      title: (f.name || "Untitled file").slice(0, 300),
      body: `${body || "(empty file)"}${f.webViewLink ? `\n\nIn Drive: ${f.webViewLink}` : ""}`,
      tags: ["drive"],
      source: { kind: "drive", ref: f.id },
      createdAt: f.createdTime ? iso(Date.parse(f.createdTime)) : undefined,
      editedAt: f.modifiedTime ? iso(Date.parse(f.modifiedTime)) : undefined,
    },
  };
}

interface DriveCursor {
  startPageToken: string;
  /** While the first listing runs: where it got to. */
  listToken: string | null;
  phase: "list" | "changes";
}

export async function syncDrive(ctx: ProviderCtx): Promise<SyncBatch> {
  let c = parseCursor<DriveCursor>(ctx.cursor);
  if (!c.startPageToken) {
    const t = await getJson<{ startPageToken: string }>(ctx, `${DRIVE}/changes/startPageToken`);
    c = { startPageToken: t.startPageToken, listToken: null, phase: "list" };
  }
  const items: SyncItem[] = [];
  const removed: string[] = [];
  if (c.phase === "list") {
    const q = encodeURIComponent(`trashed = false and (mimeType = '${DOC}' or mimeType = 'text/plain' or mimeType = 'text/markdown')`);
    const page = await getJson<{ files?: DriveFile[]; nextPageToken?: string }>(
      ctx,
      `${DRIVE}/files?pageSize=${THREADS_PER_PASS}&orderBy=modifiedTime%20desc&q=${q}&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}${c.listToken ? `&pageToken=${encodeURIComponent(c.listToken)}` : ""}`,
    );
    for (const f of page.files ?? []) {
      const item = await driveItem(ctx, f);
      if (item) items.push(item);
    }
    const next: DriveCursor = page.nextPageToken ? { ...(c as DriveCursor), listToken: page.nextPageToken } : { startPageToken: c.startPageToken!, listToken: null, phase: "changes" };
    return { items, removed, cursor: JSON.stringify(next), more: !!page.nextPageToken };
  }
  const page = await getJson<{ changes?: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string }>(
    ctx,
    `${DRIVE}/changes?pageToken=${encodeURIComponent(c.startPageToken!)}&pageSize=${THREADS_PER_PASS}&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`)}`,
  );
  for (const ch of page.changes ?? []) {
    if (ch.removed || ch.file?.trashed) {
      removed.push(ch.fileId);
      continue;
    }
    if (!ch.file) continue;
    const item = await driveItem(ctx, ch.file);
    if (item) items.push(item);
  }
  const next: DriveCursor = { startPageToken: page.nextPageToken ?? page.newStartPageToken ?? c.startPageToken!, listToken: null, phase: "changes" };
  return { items, removed, cursor: JSON.stringify(next), more: !!page.nextPageToken };
}
