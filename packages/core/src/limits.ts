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

export interface SelfLimits {
  v: 1;
  payments: PaymentLimits;
  replies: ReplyLimits;
  meetings: MeetingLimits;
}

export const DEFAULT_LIMITS: SelfLimits = {
  v: 1,
  payments: { on: false, maxPerPayment: "" },
  replies: { on: false, contacts: [] },
  meetings: { on: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "UTC" },
};

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

/** Checks and normalises limits. Throws with a plain reason for anything that cannot be a limit. */
export function cleanLimits(value: unknown): SelfLimits {
  const v = (value && typeof value === "object" ? value : {}) as Partial<SelfLimits>;
  const p = (v.payments ?? {}) as Partial<PaymentLimits>;
  const r = (v.replies ?? {}) as Partial<ReplyLimits>;
  const m = (v.meetings ?? {}) as Partial<MeetingLimits>;
  const max = String(p.maxPerPayment ?? "").trim();
  if (max && !/^\d+(\.\d{1,18})?$/.test(max)) throw new Error("The most per payment is an amount, like 0.05.");
  const contacts = [
    ...new Set(
      (Array.isArray(r.contacts) ? r.contacts : [])
        .map((c) => String(c).replace(/\s+/g, " ").trim().toLowerCase())
        .filter(Boolean)
        .map((c) => c.slice(0, 120)),
    ),
  ].slice(0, 100);
  const from = String(m.from ?? DEFAULT_LIMITS.meetings.from);
  const to = String(m.to ?? DEFAULT_LIMITS.meetings.to);
  if (!TIME.test(from) || !TIME.test(to)) throw new Error("Free hours are times like 09:00 and 17:00.");
  if (from >= to) throw new Error("Free hours end after they start.");
  const zone = String(m.timeZone ?? "UTC").trim() || "UTC";
  if (!validZone(zone)) throw new Error(`"${zone}" is not a time zone.`);
  const days = [...new Set((Array.isArray(m.days) ? m.days : DEFAULT_LIMITS.meetings.days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return {
    v: 1,
    payments: { on: p.on === true, maxPerPayment: max },
    replies: { on: r.on === true, contacts },
    meetings: { on: m.on === true, days, from, to, timeZone: zone },
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
  // Wall time in the owner's zone: start from UTC and correct by the zone's offset at that moment.
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
