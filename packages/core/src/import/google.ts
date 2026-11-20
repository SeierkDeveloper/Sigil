// Google Takeout: Gmail (one .mbox file per label) and Calendar (one .ics file
// per calendar). Mail becomes one memory per thread, with the headers and the
// text of each message, kept within size limits. Events become one memory each.

import type { MemoryDraft } from "../vault";
import { toIso } from "./util";
import { expandFiles, extension, htmlToText, LocalImportError, LOCAL_LABELS, textOf, type ImportFile, type LocalImport } from "./files";

/** Text kept from one message, and from one thread. */
export const MAIL_MESSAGE_CHARS = 4000;
export const MAIL_THREAD_CHARS = 20_000;
/** Threads taken from one import, newest first. */
export const MAX_THREADS = 5000;

// ---------------------------------------------------------------- mail parsing

export interface MailMessage {
  headers: Map<string, string>;
  text: string;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function base64Bytes(text: string): Uint8Array {
  try {
    const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
    return latin1Bytes(bin);
  } catch {
    return new Uint8Array();
  }
}

function quotedPrintableBytes(text: string, header = false): Uint8Array {
  const src = (header ? text.replace(/_/g, " ") : text).replace(/=\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = src.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else out.push(...new TextEncoder().encode(c));
    }
  }
  return new Uint8Array(out);
}

/** =?UTF-8?B?...?= and =?ISO-8859-1?Q?...?= words in headers. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, data: string) =>
      decodeBytes(enc.toUpperCase() === "B" ? base64Bytes(data) : quotedPrintableBytes(data, true), charset),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = block.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(i + 1).trim());
  }
  return headers;
}

function param(header: string | undefined, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(header ?? "");
  return m ? (m[2] ?? m[1]) : "";
}

function decodePart(body: string, headers: Map<string, string>): string {
  const enc = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = param(headers.get("content-type"), "charset") || "utf-8";
  if (enc === "base64") return decodeBytes(base64Bytes(body), charset);
  if (enc === "quoted-printable") return decodeBytes(quotedPrintableBytes(body), charset);
  // 8bit and 7bit: the file was read as UTF-8 already.
  return body;
}

/** The readable text of a message part: text/plain first, HTML as text when there is no plain part. */
function partText(raw: string, depth = 0): { plain: string | null; html: string | null } {
  const split = raw.indexOf("\n\n");
  const headers = parseHeaders(split >= 0 ? raw.slice(0, split) : raw);
  const body = split >= 0 ? raw.slice(split + 2) : "";
  const type = (headers.get("content-type") ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/") && depth < 6) {
    const boundary = param(headers.get("content-type"), "boundary");
    if (!boundary) return { plain: body, html: null };
    let plain: string | null = null;
    let html: string | null = null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const r = partText(part.replace(/^\n/, ""), depth + 1);
      plain ??= r.plain;
      html ??= r.html;
    }
    return { plain, html };
  }
  const disposition = (headers.get("content-disposition") ?? "").toLowerCase();
  if (disposition.startsWith("attachment")) return { plain: null, html: null };
  if (type.startsWith("text/plain")) return { plain: decodePart(body, headers), html: null };
  if (type.startsWith("text/html")) return { plain: null, html: decodePart(body, headers) };
  return { plain: null, html: null };
}

export function parseMailMessage(raw: string): MailMessage {
  const split = raw.indexOf("\n\n");
  const headers = parseHeaders(split >= 0 ? raw.slice(0, split) : raw);
  const parts = partText(raw);
  const text = parts.plain ?? (parts.html ? htmlToText(parts.html) : "");
  return { headers, text: text.replace(/\r/g, "").trim() };
}

/** Splits an mbox file into messages. Lines starting "From " begin a message; ">From " inside one is unquoted. */
export function splitMbox(text: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  let blank = true;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("From ") && blank) {
      if (current) out.push(current.join("\n"));
      current = [];
    } else if (current) {
      current.push(/^>+From /.test(line) ? line.slice(1) : line);
    }
    blank = line === "";
  }
  if (current && current.length) out.push(current.join("\n"));
  return out;
}

const SUBJECT_PREFIX = /^((re|fw|fwd|aw|sv|vs)(\[\d+\])?:\s*)+/i;

function threadKey(h: Map<string, string>): string {
  const gm = h.get("x-gm-thrid");
  if (gm) return gm;
  const refs = (h.get("references") ?? "").match(/<[^>]+>/g);
  if (refs?.length) return refs[0];
  const reply = /<[^>]+>/.exec(h.get("in-reply-to") ?? "")?.[0];
  if (reply) return reply;
  return h.get("message-id") ?? `subject:${decodeHeader(h.get("subject") ?? "").replace(SUBJECT_PREFIX, "").toLowerCase()}`;
}

/** Quoted replies ("> ...") and the "On ... wrote:" line before them repeat the thread; they are left out. */
function withoutQuotes(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .replace(/\n[^\n]*wrote:\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SKIP_LABELS = ["spam", "trash"];

export function mboxDrafts(text: string, fileName = "mail.mbox"): { drafts: MemoryDraft[]; skipped: number; notes: string[] } {
  const threads = new Map<string, { subject: string; messages: { at: number; from: string; to: string; text: string }[] }>();
  let skipped = 0;
  for (const raw of splitMbox(text)) {
    const msg = parseMailMessage(raw);
    const h = msg.headers;
    const labels = (h.get("x-gmail-labels") ?? "").toLowerCase().split(",").map((l) => l.trim());
    if (labels.some((l) => SKIP_LABELS.includes(l)) || (!msg.text && !h.get("subject"))) {
      skipped++;
      continue;
    }
    const key = threadKey(h);
    const subject = decodeHeader(h.get("subject") ?? "").replace(SUBJECT_PREFIX, "").trim();
    const at = new Date(h.get("date") ?? "").getTime();
    const t = threads.get(key) ?? { subject, messages: [] };
    if (!t.subject && subject) t.subject = subject;
    t.messages.push({ at: Number.isFinite(at) ? at : 0, from: decodeHeader(h.get("from") ?? ""), to: decodeHeader(h.get("to") ?? ""), text: withoutQuotes(msg.text) });
    threads.set(key, t);
  }
  const notes: string[] = [];
  let list = [...threads.entries()].map(([key, t]) => ({ key, ...t, last: Math.max(...t.messages.map((m) => m.at)) }));
  list.sort((a, b) => b.last - a.last);
  if (list.length > MAX_THREADS) {
    notes.push(`${fileName}: only the newest ${MAX_THREADS.toLocaleString("en-US")} of ${list.length.toLocaleString("en-US")} threads were taken.`);
    list = list.slice(0, MAX_THREADS);
  }
  let shortened = 0;
  const drafts = list.map((t) => {
    t.messages.sort((a, b) => a.at - b.at);
    const parts: string[] = [];
    let size = 0;
    for (const m of t.messages) {
      const when = m.at ? new Date(m.at).toISOString().replace("T", " ").slice(0, 16) : "unknown date";
      const text = m.text.length > MAIL_MESSAGE_CHARS ? `${m.text.slice(0, MAIL_MESSAGE_CHARS)}\n[Shortened]` : m.text;
      const block = `### ${m.from || "Unknown sender"}\nTo: ${m.to || "unknown"}\nDate: ${when}\n\n${text || "(no text)"}`;
      if (size + block.length > MAIL_THREAD_CHARS) {
        parts.push(`[${t.messages.length - parts.length} more ${t.messages.length - parts.length === 1 ? "message" : "messages"} in this thread were left out.]`);
        shortened++;
        break;
      }
      parts.push(block);
      size += block.length;
    }
    const first = t.messages[0]?.at;
    return {
      title: (t.subject || "(no subject)").slice(0, 300),
      body: parts.join("\n\n"),
      tags: ["gmail", "email"],
      source: { kind: "gmail" as const, ref: t.key.slice(0, 300) },
      createdAt: first ? new Date(first).toISOString() : undefined,
      editedAt: t.last ? new Date(t.last).toISOString() : undefined,
    };
  });
  if (shortened) notes.push(`${shortened.toLocaleString("en-US")} long ${shortened === 1 ? "thread was" : "threads were"} shortened.`);
  return { drafts, skipped, notes };
}

// ---------------------------------------------------------------- calendar

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function icsUnescape(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseIcsLine(line: string): IcsProp | null {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon <= 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const [k, v] = p.split("=");
    if (k && v) params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** 20260115T093000Z, 20260115T093000 (local time, kept as written) and 20260115 (a whole day). */
export function icsDate(p: IcsProp | undefined): { iso: string; allDay: boolean; text: string } | null {
  if (!p) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { iso: `${y}-${mo}-${d}T00:00:00.000Z`, allDay: true, text: `${y}-${mo}-${d}` };
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const zone = z ? "UTC" : p.params.TZID ?? "";
  return { iso, allDay: false, text: `${y}-${mo}-${d} ${h}:${mi}${zone ? ` ${zone}` : ""}` };
}

export function icsDrafts(text: string): { drafts: MemoryDraft[]; skipped: number } {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  let event: IcsProp[] | null = null;
  let nested = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      event = [];
      nested = 0;
      continue;
    }
    if (!event) continue;
    if (line.startsWith("BEGIN:")) nested++;
    else if (line.startsWith("END:") && line !== "END:VEVENT") nested--;
    else if (line === "END:VEVENT") {
      const get = (n: string) => event!.find((p) => p.name === n);
      const summary = icsUnescape(get("SUMMARY")?.value ?? "").trim();
      const description = icsUnescape(get("DESCRIPTION")?.value ?? "").trim();
      const start = icsDate(get("DTSTART"));
      if ((!summary && !description) || !start) {
        skipped++;
        event = null;
        continue;
      }
      const end = icsDate(get("DTEND"));
      const location = icsUnescape(get("LOCATION")?.value ?? "").trim();
      const rule = get("RRULE")?.value;
      const status = get("STATUS")?.value?.toUpperCase();
      const attendees = event.filter((p) => p.name === "ATTENDEE").length;
      const organizer = get("ORGANIZER");
      const body = [
        `When: ${start.text}${end && end.text !== start.text ? ` to ${end.text}` : ""}${start.allDay ? " (all day)" : ""}`,
        location ? `Where: ${location}` : "",
        rule ? `Repeats: ${(/FREQ=(\w+)/.exec(rule)?.[1] ?? "yes").toLowerCase()}` : "",
        organizer ? `Organizer: ${organizer.params.CN ?? organizer.value.replace(/^mailto:/i, "")}` : "",
        attendees ? `Guests: ${attendees}` : "",
        status === "CANCELLED" ? "Cancelled" : "",
        description ? `\n${description}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const uid = get("UID")?.value ?? `${summary}@${start.iso}`;
      const recurrence = get("RECURRENCE-ID")?.value;
      const stamp = toIso(icsDate(get("LAST-MODIFIED"))?.iso) ?? start.iso;
      drafts.push({
        title: (summary || "Untitled event").slice(0, 300),
        body,
        tags: ["calendar", "event"],
        source: { kind: "calendar", ref: (recurrence ? `${uid}#${recurrence}` : uid).slice(0, 300) },
        createdAt: start.iso,
        editedAt: stamp,
      });
      event = null;
    } else if (nested === 0) {
      const p = parseIcsLine(line);
      if (p) event.push(p);
    }
  }
  return { drafts, skipped };
}

// ---------------------------------------------------------------- the Takeout

export function parseTakeout(files: ImportFile[]): LocalImport {
  const all = expandFiles(files);
  const mail = all.filter((f) => extension(f.path) === "mbox");
  const calendars = all.filter((f) => extension(f.path) === "ics");
  if (!mail.length && !calendars.length) {
    throw new LocalImportError("No mail (.mbox) or calendar (.ics) files were found. Choose the Takeout zip, or the .mbox and .ics files inside it.");
  }
  const drafts: MemoryDraft[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const f of mail) {
    const r = mboxDrafts(textOf(f.bytes), f.path.split("/").pop());
    drafts.push(...r.drafts);
    notes.push(...r.notes);
    skipped += r.skipped;
  }
  for (const f of calendars) {
    const r = icsDrafts(textOf(f.bytes));
    drafts.push(...r.drafts);
    skipped += r.skipped;
  }
  if (skipped) notes.push("Mail labelled spam or trash, and empty items, were left out.");
  return { kind: "takeout", label: LOCAL_LABELS.takeout, drafts, skipped, notes };
}
