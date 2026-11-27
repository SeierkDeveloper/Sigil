// A self that runs the owner's inbox and calendar: before it acts on its own,
// every action is checked against the owner's thresholds (limits.ts), and the
// answer is one of three:
//
//   allowed         within every threshold: it may act, and signs a receipt
//   needs-approval  past a threshold: it waits in Work, with the thread and
//                   what the self would do or say next, for the owner's yes
//   refused         it names something on the owner's never-touch list: the
//                   self does not act and does not offer to
//
// The same check runs in the vault, for mail and invites it reads through the
// owner's own Google connection, and in the connector, for an AI app that has
// mail or calendar access of its own and asks Sigil first. The owner's
// thresholds reach the connector only inside an envelope under a key derived
// from that app's secret, like the rules of the AI self.
//
// What waits for the owner travels as a sealed box to the vault's public key;
// the owner's answer goes back to the app under the app's key, so the server
// can neither read a request nor forge a yes.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "./crypto";
import { toBase64Url, utf8 } from "./encoding";
import { canonicalJson } from "./life";
import { addressOf, inFreeHours, MESSAGE_KINDS, personIn, type MessageKind, type SelfLimits } from "./limits";
import type { NegotiationOffer } from "./negotiate";
import type { ReceiptDelegation } from "./receipts";

export type ActArea = "mail" | "calendar" | "negotiation";
export const ACT_AREAS: readonly ActArea[] = ["mail", "calendar", "negotiation"];

export type MailAction = "reply" | "send";
export type CalendarAction = "accept" | "decline" | "propose";
export type ActAction = MailAction | CalendarAction | "counter" | "agree";

export type Verdict = "allowed" | "needs-approval" | "refused";

export type ActVerdict = { verdict: "allowed"; limit: string } | { verdict: "needs-approval"; reason: string } | { verdict: "refused"; reason: string };

/** An action the self (or an app on its behalf) wants to take. */
export interface ActionAsk {
  area: "mail" | "calendar";
  action: MailAction | CalendarAction;
  /** Who it is with: the sender, the recipient or the organizer, as "Name <address>" or an address. */
  who: string;
  subject?: string;
  /** The message it answers, or the invite's description. */
  text?: string;
  /** What the app says the message is about. Sigil reads the text too; every kind found must be allowed. */
  kinds?: MessageKind[];
  /** For an invite: when it starts, ISO time, and how long it is. */
  start?: string;
  minutes?: number;
  /** For an invite: the app or the device found it overlaps something already in the calendar. */
  conflicts?: boolean;
}

// ---------------------------------------------------------------- what a message is about

const KIND_WORDS: [MessageKind, RegExp][] = [
  ["money", /(\b(invoice|invoices|payment|payments|pay|paid|price|prices|pricing|quote|cost|costs|fee|fees|budget|refund|bank|iban|wire|transfer|salary|usd|eur|gbp|sek)\b|[$€£])/i],
  ["legal", /\b(contract|contracts|nda|legal|lawyer|attorney|liability|clause|clauses|lawsuit|court|signature)\b/i],
  [
    "scheduling",
    /\b(meet|meeting|meetings|call|schedule|reschedule|calendar|available|availability|slot|invite|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s?(am|pm)|\d{4}-\d{2}-\d{2})\b/i,
  ],
  ["thanks", /\b(thanks|thank you|appreciate|appreciated|cheers|confirmed|confirming|got it|received)\b/i],
];

/** The kinds a message is about, read from its subject and text. "other" when nothing is recognised. */
export function messageKinds(subject: string, text: string): MessageKind[] {
  const all = `${subject}\n${text}`;
  const found = KIND_WORDS.filter(([, re]) => re.test(all)).map(([k]) => k);
  if (/\?/.test(all)) found.push("question");
  return found.length ? MESSAGE_KINDS.filter((k) => found.includes(k)) : ["other"];
}

export const KIND_LABEL: Record<MessageKind, string> = {
  scheduling: "times and meetings",
  question: "questions",
  thanks: "thanks and confirmations",
  money: "money",
  legal: "contracts and legal matters",
  other: "anything else",
};

// ---------------------------------------------------------------- never touch

/** The never-touch entry a text or a person names, if any: an address or @domain against the people, a word or phrase against everything. */
export function neverTouchHit(limits: Pick<SelfLimits, "neverTouch">, people: string[], texts: string[]): string | null {
  const addrs = people.map((p) => addressOf(p)).filter((a): a is string => !!a);
  const hay = [...people, ...texts].join("\n").toLowerCase();
  for (const entry of limits.neverTouch) {
    if (entry.startsWith("@")) {
      if (addrs.some((a) => a.endsWith(entry))) return entry;
    } else if (entry.includes("@")) {
      if (addrs.includes(entry)) return entry;
    } else {
      const re = new RegExp(`(^|[^a-z0-9])${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i");
      if (re.test(hay)) return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the check

const plainList = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * Whether the self may take this action on its own. `today` is how many it
 * already took on its own in this area today (the server counts them).
 */
export function checkAction(limits: SelfLimits, ask: ActionAsk, ctx: { today: number; now?: number }): ActVerdict {
  const now = ctx.now ?? Date.now();
  const hit = neverTouchHit(limits, [ask.who], [ask.subject ?? "", ask.text ?? ""]);
  if (hit) return { verdict: "refused", reason: `It names "${hit}", which is on your never-touch list.` };
  if (ask.area === "mail") {
    const m = limits.mail;
    if (!m.on) return { verdict: "needs-approval", reason: "Mail on its own is off." };
    if (ask.action !== "reply" && ask.action !== "send") return { verdict: "refused", reason: "That is not something it does with mail." };
    if (ask.action === "send" && !m.mayStart) return { verdict: "needs-approval", reason: "It may only reply on its own, not write first." };
    const who = personIn(m.senders, ask.who);
    if (!who) return { verdict: "needs-approval", reason: "The other person is not one of the senders you listed." };
    const kinds = [...new Set([...(ask.kinds ?? []).filter((k) => MESSAGE_KINDS.includes(k)), ...messageKinds(ask.subject ?? "", ask.text ?? "")])];
    const outside = kinds.filter((k) => !m.kinds.includes(k));
    if (outside.length) return { verdict: "needs-approval", reason: `The message is about ${plainList(outside.map((k) => KIND_LABEL[k]))}, which you did not let it answer on its own.` };
    if (ctx.today >= m.perDay) return { verdict: "needs-approval", reason: `It already handled ${ctx.today} ${ctx.today === 1 ? "message" : "messages"} on its own today, the most you allow.` };
    return { verdict: "allowed", limit: `Mail on its own: ${ask.action === "send" ? "new messages" : "replies"} to listed senders (${who}) about ${plainList(kinds.map((k) => KIND_LABEL[k]))}, up to ${m.perDay} a day` };
  }
  const c = limits.calendar;
  if (!c.on) return { verdict: "needs-approval", reason: "Answering invites on its own is off." };
  if (ask.action !== "accept" && ask.action !== "decline" && ask.action !== "propose") return { verdict: "refused", reason: "That is not something it does with invites." };
  const who = personIn(c.people, ask.who);
  if (!who) return { verdict: "needs-approval", reason: "The organizer is not one of the people you listed." };
  if (ctx.today >= c.perDay) return { verdict: "needs-approval", reason: `It already answered ${ctx.today} ${ctx.today === 1 ? "invite" : "invites"} on its own today, the most you allow.` };
  const start = ask.start ? new Date(ask.start) : null;
  const minutes = Math.round(Number(ask.minutes ?? 0));
  const hours = `${limits.meetings.from} to ${limits.meetings.to}, ${limits.meetings.timeZone}`;
  if (ask.action === "decline") {
    if (!c.mayDecline) return { verdict: "needs-approval", reason: "Declining on its own is off." };
    return { verdict: "allowed", limit: `Invites on its own: declines for listed people (${who}), up to ${c.perDay} a day` };
  }
  if (!start || !Number.isFinite(start.getTime())) return { verdict: "needs-approval", reason: "The invite has no clear start time." };
  if (!(minutes > 0)) return { verdict: "needs-approval", reason: "The invite has no clear length." };
  if (start.getTime() < now) return { verdict: "needs-approval", reason: "The time is in the past." };
  if (minutes > c.maxMinutes) return { verdict: "needs-approval", reason: `It is ${minutes} minutes, longer than the ${c.maxMinutes} you allow.` };
  if (!inFreeHours(limits.meetings, start, minutes)) return { verdict: "needs-approval", reason: `It is outside your free hours (${hours}).` };
  if (ask.conflicts) return { verdict: "needs-approval", reason: "It overlaps something already in your calendar." };
  return {
    verdict: "allowed",
    limit: `Invites on its own: ${ask.action === "propose" ? "new times" : "accepts"} for listed people (${who}), up to ${c.maxMinutes} minutes in your free hours (${hours}), up to ${c.perDay} a day`,
  };
}

/** The owner's thresholds in plain lines, for an app to read before it acts and for the vault to show. */
export function thresholdsSummary(limits: SelfLimits): string[] {
  const out: string[] = [];
  const m = limits.mail;
  out.push(
    m.on
      ? `Mail: it may ${m.mayStart ? "reply to and write to" : "reply to"} ${m.senders.length ? plainList(m.senders) : "nobody yet (no senders listed)"} about ${plainList(m.kinds.map((k) => KIND_LABEL[k])) || "nothing"}, up to ${m.perDay} a day. Everything else waits for the owner.`
      : "Mail: off. Every message waits for the owner.",
  );
  const c = limits.calendar;
  const hours = `${limits.meetings.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")} ${limits.meetings.from} to ${limits.meetings.to} (${limits.meetings.timeZone})`;
  out.push(
    c.on
      ? `Invites: it may accept invites from ${c.people.length ? plainList(c.people) : "nobody yet (no people listed)"} of up to ${c.maxMinutes} minutes in the free hours ${hours}${c.mayDecline ? ", and decline others from them" : ""}, up to ${c.perDay} a day.`
      : "Invites: off. Every invite waits for the owner.",
  );
  const r = limits.ranges;
  if (!r.on) out.push("Negotiation: off. Every offer waits for the owner.");
  else {
    if (r.times.on) out.push(`Times: in the free hours, at least ${r.times.minNoticeHours} hours from now and at most ${r.times.maxDaysAhead} days ahead.`);
    for (const p of r.prices) out.push(`Price for ${p.label}: ${p.side === "selling" ? `opens at ${p.max} ${p.unit}, never below ${p.min} ${p.unit}` : `opens at ${p.min} ${p.unit}, never above ${p.max} ${p.unit}`}.`);
    if (r.terms.allowed.length) out.push(`Terms it may agree to: ${plainList(r.terms.allowed)}.`);
    if (r.terms.forbidden.length) out.push(`Terms it never agrees to: ${plainList(r.terms.forbidden)}.`);
    out.push(`It counters at most ${r.maxRounds} ${r.maxRounds === 1 ? "time" : "times"}, then asks the owner.`);
  }
  if (limits.neverTouch.length) out.push(`Never touched: ${plainList(limits.neverTouch)}.`);
  return out;
}

// ---------------------------------------------------------------- what waits for the owner, and the answer

/** One step the self took or wants to take, as the owner reads it in Work. Sealed to the vault's public key. */
export interface ActRequest {
  v: 1;
  area: ActArea;
  action: ActAction;
  /** Who it is with. */
  who: string;
  subject: string;
  /** The thread so far, oldest first. */
  thread: { from: string; text: string }[];
  /** What the self would send or do next. The owner may change it before saying yes. */
  next: string;
  /** Why it waits, why it was refused, or the limit it acted under. */
  reason: string;
  /** For an invite or a time: when, and how long. */
  when: { start: string; minutes: number } | null;
  /** For a negotiation: the offer on the table and its range. */
  offer: NegotiationOffer | null;
  /** Where it lives: a thread, a message, an event (provider ids, short strings). */
  ref: Record<string, string>;
  at: string;
}

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const line = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

export function cleanActRequest(value: unknown): ActRequest {
  const v = (value && typeof value === "object" ? value : {}) as Partial<ActRequest>;
  const area = ACT_AREAS.includes(v.area as ActArea) ? (v.area as ActArea) : "mail";
  const when = v.when && typeof v.when === "object" && Number.isFinite(Date.parse(String(v.when.start))) ? { start: new Date(String(v.when.start)).toISOString(), minutes: Math.max(0, Math.min(24 * 60, Math.round(Number(v.when.minutes) || 0))) } : null;
  const ref: Record<string, string> = {};
  for (const [k, x] of Object.entries(v.ref ?? {}).slice(0, 10)) if (/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(k) && x != null && String(x).trim()) ref[k] = line(x, 300);
  return {
    v: 1,
    area,
    action: line(v.action, 20) as ActAction,
    who: line(v.who, 200),
    subject: line(v.subject, 300),
    thread: (Array.isArray(v.thread) ? v.thread : []).slice(-30).map((t) => ({ from: line(t?.from, 200), text: clip(t?.text, 8000) })),
    next: clip(v.next, 20_000),
    reason: line(v.reason, 400),
    when,
    offer: v.offer && typeof v.offer === "object" ? (JSON.parse(canonicalJson(v.offer)) as NegotiationOffer) : null,
    ref,
    at: Number.isFinite(Date.parse(String(v.at))) ? new Date(String(v.at)).toISOString() : new Date().toISOString(),
  };
}

/** The sealed box's context: a request is bound to its id and to who asked (an app id, or "vault"). */
export function actRequestContext(actId: string, by: string): string {
  return `act-request:${actId}:${by}`;
}

/**
 * The id of the vault's own step for one message or invite: an HMAC under a
 * key from the vault key, so every device makes the same one and the server
 * refuses a second step for the same thing, while the id says nothing.
 */
export async function actStepId(vaultKey: Uint8Array, sourceId: string, ref: string): Promise<string> {
  return toBase64Url(hmac(sha256, await hkdf(vaultKey, "sigil:act-step"), utf8(`${sourceId}\n${ref}`))).slice(0, 22);
}

/** The sealed box's context for a receipt an app signed: bound to its id and the app. */
export function receiptSealContext(receiptId: string, appId: string): string {
  return `self-receipt:${receiptId}:${appId}`;
}

/** The owner's answer to an app, under a key derived from the app's secret. */
export interface ActAnswer {
  v: 1;
  /** The request it answers: checked by the app, so an answer cannot be moved to another request. */
  id: string;
  verdict: "approved" | "declined";
  /** The text the owner settled on, when they changed what the self would say. */
  next: string | null;
  at: string;
}

/** What an app needs to act within the owner's thresholds, wrapped for that app's key only. */
export interface ActingConfig {
  v: 1;
  limits: SelfLimits;
  /** The vault's public key, so the app can seal requests and receipts. Inside the envelope, so the server cannot swap it. */
  boxPublic: string;
  /** The self key's word that this app's receipt key signs receipts for it. */
  delegation: ReceiptDelegation;
}
