// Limits for acting: what the AI self may do on its own, without asking.
// Kept as an encrypted setting ("limits") under the vault key like every other
// setting. Everything past a limit goes to the approval queue in Work.
//
//   payments  the self key may sign a payment from its wallet to a listed
//             recipient, up to the wallet's own caps on chain (and a lower
//             amount the owner sets here, if any)
//   replies   a reply to a contact the owner lists is approved on its own
//   meetings  a time agreed in a meeting of selves is accepted on its own when
//             it falls in the owner's free hours
//   mail      thresholds for running the inbox: who, what kinds of message,
//             how many a day (acting.ts decides)
//   calendar  thresholds for answering invites: whose, how long, how many a
//             day, in the free hours above
//   neverTouch  words, addresses and domains the self never acts on
//   ranges    times, prices and terms it may negotiate within (negotiate.ts)
//
// Each check answers with the limit it acted under, in plain words, for the
// receipt, or with the reason it goes to the queue.

export const LIMITS_FORMAT = "sigil-self-limits";

export interface PaymentLimits {
  on: boolean;
  /** At most this much of the chain's coin per payment, as decimals; "" for up to the wallet's own cap. */
  maxPerPayment: string;
}

export interface ReplyLimits {
  on: boolean;
  /** Contacts the self may answer on its own: email addresses or names, as the owner typed them. */
  contacts: string[];
}

export interface MeetingLimits {
  on: boolean;
  /** Days of the week, 0 for Sunday to 6 for Saturday. */
  days: number[];
  /** "09:00" to "17:00", in the owner's time zone. */
  from: string;
  to: string;
  /** An IANA time zone, such as Europe/Paris. */
  timeZone: string;
}

/** What a message is about, as the self reads it. The owner picks the kinds it may answer on its own. */
export type MessageKind = "scheduling" | "question" | "thanks" | "money" | "legal" | "other";

export const MESSAGE_KINDS: readonly MessageKind[] = ["scheduling", "question", "thanks", "money", "legal", "other"];

export interface MailThresholds {
  on: boolean;
  /** Who it may answer on its own: addresses, names, or a whole domain written as @example.org. */
  senders: string[];
  /** The kinds of message it may answer on its own. */
  kinds: MessageKind[];
  /** At most this many on its own per day, counted from midnight in the free hours' time zone. */
  perDay: number;
  /** It may also write first to a listed sender, not only reply. */
  mayStart: boolean;
}

export interface CalendarThresholds {
  on: boolean;
  /** Whose invites it may answer on its own: organizers by address, name or @domain. */
  people: string[];
  /** The longest meeting it may accept, in minutes. */
  maxMinutes: number;
  perDay: number;
  /** It may decline an invite outside the free hours on its own; off, that waits for the owner too. */
  mayDecline: boolean;
}

export interface PriceRange {
  /** What the price is for, as the owner names it, such as "Consulting day". Matched against what is being negotiated. */
  label: string;
  /** Selling: it opens at max and never goes below min. Buying: it opens at min and never goes above max. */
  side: "selling" | "buying";
  min: string;
  max: string;
  /** The currency or unit, such as EUR. */
  unit: string;
}

export interface NegotiationRanges {
  on: boolean;
  times: {
    on: boolean;
    /** At least this many hours from now. */
    minNoticeHours: number;
    /** At most this many days ahead. */
    maxDaysAhead: number;
  };
  prices: PriceRange[];
  terms: {
    /** Terms it may agree to, in the owner's words. */
    allowed: string[];
    /** Terms it never agrees to: it stops and asks. */
    forbidden: string[];
  };
  /** Counters it may make in one negotiation before it stops and asks. */
  maxRounds: number;
}

export interface SelfLimits {
  v: 1;
  payments: PaymentLimits;
  replies: ReplyLimits;
  meetings: MeetingLimits;
  mail: MailThresholds;
  calendar: CalendarThresholds;
  /** Words, addresses and @domains it never acts on: anything that names one is refused. */
  neverTouch: string[];
  ranges: NegotiationRanges;
}

export const DEFAULT_LIMITS: SelfLimits = {
  v: 1,
  payments: { on: false, maxPerPayment: "" },
  replies: { on: false, contacts: [] },
  meetings: { on: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "UTC" },
  mail: { on: false, senders: [], kinds: ["scheduling", "question", "thanks"], perDay: 10, mayStart: false },
  calendar: { on: false, people: [], maxMinutes: 60, perDay: 5, mayDecline: false },
  neverTouch: [],
  ranges: { on: false, times: { on: true, minNoticeHours: 24, maxDaysAhead: 21 }, prices: [], terms: { allowed: [], forbidden: [] }, maxRounds: 3 },
};

export const MAX_PRICE_RANGES = 10;

export type LimitDecision = { ok: true; limit: string } | { ok: false; reason: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A list the owner typed: trimmed, lower case, without repeats. */
export function cleanList(value: unknown, max = 100, chars = 120): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : [])
        .map((c) => String(c).replace(/\s+/g, " ").trim().toLowerCase())
        .filter(Boolean)
        .map((c) => c.slice(0, chars)),
    ),
  ].slice(0, max);
}

/** People the owner typed: "Name <address>" keeps the address; names, addresses and @domains stay as typed. */
export function cleanPersonList(value: unknown, max = 100): string[] {
  return [...new Set(cleanList(value, max).map((c) => (/<[^<>\s]+@[^<>\s]+>/.test(c) ? (addressOf(c) ?? c) : c)))];
}

const AMOUNT = /^\d+(\.\d{1,6})?$/;

function whole(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function cleanPrice(value: unknown): PriceRange {
  const p = (value && typeof value === "object" ? value : {}) as Partial<PriceRange>;
  const label = String(p.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!label) throw new Error("Each price range has a name, such as Consulting day.");
  const min = String(p.min ?? "").trim();
  const max = String(p.max ?? "").trim();
  if (!AMOUNT.test(min) || !AMOUNT.test(max)) throw new Error(`The prices for ${label} are amounts, like 800 or 1200.50.`);
  if (Number(min) > Number(max)) throw new Error(`The lowest price for ${label} is above its highest.`);
  const unit = String(p.unit ?? "").replace(/\s+/g, " ").trim().slice(0, 12);
  if (!unit) throw new Error(`Name the currency or unit for ${label}, such as EUR.`);
  return { label, side: p.side === "buying" ? "buying" : "selling", min, max, unit };
}

/** Checks and normalises limits. Throws with a plain reason for anything that cannot be a limit. */
export function cleanLimits(value: unknown): SelfLimits {
  const v = (value && typeof value === "object" ? value : {}) as Partial<SelfLimits>;
  const p = (v.payments ?? {}) as Partial<PaymentLimits>;
  const r = (v.replies ?? {}) as Partial<ReplyLimits>;
  const m = (v.meetings ?? {}) as Partial<MeetingLimits>;
  const mail = (v.mail ?? {}) as Partial<MailThresholds>;
  const cal = (v.calendar ?? {}) as Partial<CalendarThresholds>;
  const rg = (v.ranges ?? {}) as Partial<NegotiationRanges>;
  const D = DEFAULT_LIMITS;
  const max = String(p.maxPerPayment ?? "").trim();
  if (max && !/^\d+(\.\d{1,18})?$/.test(max)) throw new Error("The most per payment is an amount, like 0.05.");
  const from = String(m.from ?? D.meetings.from);
  const to = String(m.to ?? D.meetings.to);
  if (!TIME.test(from) || !TIME.test(to)) throw new Error("Free hours are times like 09:00 and 17:00.");
  if (from >= to) throw new Error("Free hours end after they start.");
  const zone = String(m.timeZone ?? "UTC").trim() || "UTC";
  if (!validZone(zone)) throw new Error(`"${zone}" is not a time zone.`);
  const days = [...new Set((Array.isArray(m.days) ? m.days : D.meetings.days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const kinds = Array.isArray(mail.kinds) ? MESSAGE_KINDS.filter((k) => (mail.kinds as unknown[]).includes(k)) : [...D.mail.kinds];
  const times = (rg.times ?? {}) as Partial<NegotiationRanges["times"]>;
  const terms = (rg.terms ?? {}) as Partial<NegotiationRanges["terms"]>;
  const prices = (Array.isArray(rg.prices) ? rg.prices : []).slice(0, MAX_PRICE_RANGES).map(cleanPrice);
  const labels = prices.map((x) => x.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error("Two price ranges have the same name.");
  const allowed = cleanList(terms.allowed, 50);
  const forbidden = cleanList(terms.forbidden, 50);
  const both = allowed.find((t) => forbidden.includes(t));
  if (both) throw new Error(`"${both}" is both allowed and never agreed to.`);
  return {
    v: 1,
    payments: { on: p.on === true, maxPerPayment: max },
    replies: { on: r.on === true, contacts: cleanList(r.contacts) },
    meetings: { on: m.on === true, days, from, to, timeZone: zone },
    mail: {
      on: mail.on === true,
      senders: cleanPersonList(mail.senders),
      kinds,
      perDay: whole(mail.perDay, D.mail.perDay, 0, 500),
      mayStart: mail.mayStart === true,
    },
    calendar: {
      on: cal.on === true,
      people: cleanPersonList(cal.people),
      maxMinutes: whole(cal.maxMinutes, D.calendar.maxMinutes, 5, 24 * 60),
      perDay: whole(cal.perDay, D.calendar.perDay, 0, 200),
      mayDecline: cal.mayDecline === true,
    },
    neverTouch: cleanList(v.neverTouch),
    ranges: {
      on: rg.on === true,
      times: {
        on: times.on !== false,
        minNoticeHours: whole(times.minNoticeHours, D.ranges.times.minNoticeHours, 0, 24 * 30),
        maxDaysAhead: whole(times.maxDaysAhead, D.ranges.times.maxDaysAhead, 1, 365),
      },
      prices,
      terms: { allowed, forbidden },
      maxRounds: whole(rg.maxRounds, D.ranges.maxRounds, 1, 10),
    },
  };
}

// ---------------------------------------------------------------- replies

/** The address inside "Name <address>", or the text itself. */
function contactKeys(from: string): string[] {
  const t = from.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return [];
  const addr = /<([^<>\s]+@[^<>\s]+)>/.exec(t)?.[1] ?? (/^[^\s@]+@[^\s@]+$/.test(t) ? t : null);
  const name = t.replace(/<[^<>]*>/g, "").replace(/"/g, "").trim();
  return [...new Set([addr, name].filter((x): x is string => !!x))];
}

/** The address of "Name <address>" (or a bare address), lower case, or null. */
export function addressOf(who: string): string | null {
  const t = who.replace(/\s+/g, " ").trim().toLowerCase();
  return /<([^<>\s]+@[^<>\s]+)>/.exec(t)?.[1] ?? (/^[^\s@<>]+@[^\s@<>]+$/.test(t) ? t : null);
}

/** The entry of a list a person matches: their address, their name, or their address's @domain. */
export function personIn(list: string[], who: string): string | null {
  const keys = contactKeys(who);
  const addr = addressOf(who);
  if (addr) keys.push(addr.slice(addr.indexOf("@")));
  return list.find((c) => keys.includes(c)) ?? null;
}

/** Whether a reply to this sender may be approved without asking. */
export function replyWithinLimits(limits: SelfLimits, from: string): LimitDecision {
  if (!limits.replies.on) return { ok: false, reason: "Replies on its own are off." };
  const keys = contactKeys(from);
  if (!keys.length) return { ok: false, reason: "The sender is not known." };
  const hit = limits.replies.contacts.find((c) => keys.includes(c));
  return hit ? { ok: true, limit: `Replies to listed contacts (${hit})` } : { ok: false, reason: "The sender is not one of the contacts you listed." };
}

// ---------------------------------------------------------------- meetings

/** The day of the week (0 Sunday) and "HH:MM" of an instant in a time zone. */
export function localTime(at: Date, timeZone: string): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, time: `${get("hour").padStart(2, "0")}:${get("minute").padStart(2, "0")}` };
}

/**
 * A time agreed in a meeting, when the text names one plainly: an ISO date and
 * time such as 2026-12-03 14:00 (read in the owner's time zone unless it
 * carries Z or an offset). Null when it names none, or more than one.
 */
export function agreedTime(text: string, timeZone: string): Date | null {
  const found = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?\b/g)];
  const unique = [...new Set(found.map((m) => m[0]))];
  if (unique.length !== 1) return null;
  const m = found[0];
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (m[6]) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${m[6] === "Z" ? "Z" : m[6].length === 5 ? `${m[6].slice(0, 3)}:${m[6].slice(3)}` : m[6]}`;
    const t = new Date(iso);
    return Number.isFinite(t.getTime()) ? t : null;
  }
  return wallTime(y, mo, d, h, mi, timeZone);
}

/** The instant of a wall time (month from 1) in a time zone. */
export function wallTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date | null {
  // Start from UTC and correct by the zone's offset at that moment.
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const local = localTime(new Date(guess), timeZone);
    const want = h * 60 + mi;
    const have = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3));
    let diff = want - have;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    guess += diff * 60_000;
  }
  const t = new Date(guess);
  return Number.isFinite(t.getTime()) ? t : null;
}

/** The date (year, month from 1, day) of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day") };
}

/** Midnight of today in a time zone: where "per day" counts start. */
export function startOfDay(now: Date, timeZone: string): Date {
  const { y, mo, d } = localDate(now, timeZone);
  return wallTime(y, mo, d, 0, 0, timeZone) ?? new Date(Date.UTC(y, mo - 1, d));
}

/** Whether a meeting from start for this many minutes lies in the free days and hours, all of it on the same day. */
export function inFreeHours(m: Pick<MeetingLimits, "days" | "from" | "to" | "timeZone">, start: Date, minutes: number): boolean {
  const a = localTime(start, m.timeZone);
  const end = new Date(start.getTime() + minutes * 60_000);
  const b = localTime(end, m.timeZone);
  if (!m.days.includes(a.day)) return false;
  if (a.time < m.from) return false;
  // Ends by the end of the free hours, on the same day (an end at exactly the closing time is inside).
  return b.day === a.day && b.time <= m.to && b.time > a.time;
}

/** Whether a meeting at this time may be accepted without asking. */
export function meetingWithinLimits(limits: SelfLimits, at: Date | null, now = Date.now()): LimitDecision {
  const m = limits.meetings;
  if (!m.on) return { ok: false, reason: "Accepting meetings on its own is off." };
  if (!at) return { ok: false, reason: "The agreed time is not written plainly as a date and a time." };
  if (at.getTime() < now) return { ok: false, reason: "The agreed time is in the past." };
  const local = localTime(at, m.timeZone);
  if (!m.days.includes(local.day)) return { ok: false, reason: "That day is not one of your free days." };
  if (local.time < m.from || local.time >= m.to) return { ok: false, reason: `That time is outside your free hours, ${m.from} to ${m.to}.` };
  const names = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  return { ok: true, limit: `Meetings in free hours (${names[local.day]} ${m.from} to ${m.to}, ${m.timeZone})` };
}

// ---------------------------------------------------------------- payments

export interface PaymentToCheck {
  /** Whether the recipient is one of the wallet rules' recipients, as set on chain. */
  listed: boolean;
  /** The chain's coin, in base units, or null for a token. */
  value: bigint | null;
  /** The owner's own most per payment here, in base units (from maxPerPayment), or null. */
  max: bigint | null;
  /** What the wallet answered when the payment was tried against it on chain: null when it would pass. */
  chainRefusal: string | null;
}

/** Whether the self key may sign this payment without asking. The wallet's own caps are checked on chain. */
export function paymentWithinLimits(limits: SelfLimits, p: PaymentToCheck): LimitDecision {
  if (!limits.payments.on) return { ok: false, reason: "Payments on its own are off." };
  if (!p.listed) return { ok: false, reason: "The recipient is not one of the wallet's recipients." };
  if (p.chainRefusal) return { ok: false, reason: p.chainRefusal };
  if (p.value !== null && p.max !== null && p.value > p.max) return { ok: false, reason: "Over the most per payment you set here." };
  return { ok: true, limit: limits.payments.maxPerPayment ? `Payments to listed recipients, up to ${limits.payments.maxPerPayment} each and the wallet's caps` : "Payments to listed recipients, within the wallet's caps on chain" };
}
