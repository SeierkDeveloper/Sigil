// Negotiating within ranges the owner sets: times, prices and terms. The
// self proposes and counters inside a range on its own, and stops to ask the
// owner at the edge of it, or for anything outside it, with the whole thread
// and what it would say next. The numbers and times come from here, never from
// a model: a model may only write the words around them.
//
//   prices  selling, it opens at the top of the range and never goes below
//           the bottom; buying, the other way round. Each counter moves
//           halfway toward the other side's offer. An offer that meets its
//           last counter (or beats its opening) is accepted. It asks when the
//           other side's offer is at or past the edge, when its next counter
//           would reach the edge, or after the most counters the owner allows.
//   times   a time in the free hours, with enough notice, not too far ahead,
//           not longer than the longest meeting allowed and clear of what is
//           in the calendar is accepted; otherwise it counters with the next
//           such time, and asks when there is none.
//   terms   every term on the owner's allowed list: accepted. A term the
//           owner never agrees to, or one not on either list: it asks.

import { neverTouchHit } from "./acting";
import { agreedTime, inFreeHours, localDate, localTime, wallTime, type PriceRange, type SelfLimits } from "./limits";

export type NegotiationKind = "time" | "price" | "terms";
export type Move = "accept" | "counter" | "ask";

export interface NegotiationOffer {
  kind: NegotiationKind;
  /** A price, as decimals, and its unit. */
  price?: string;
  unit?: string;
  /** A time, ISO, and how long. */
  time?: string;
  minutes?: number;
  terms?: string[];
  /** The range it worked within, by name. */
  range?: string;
}

export interface NegotiationInput {
  kind: NegotiationKind;
  /** What is being negotiated, such as "Consulting day" or "Call about the book". A price is matched to the range of that name. */
  topic: string;
  /** The other side. */
  who: string;
  /** What the other side offers now: a price, a time (ISO) with its length, or terms. Leave out to open. */
  theirs?: { price?: string; time?: string; minutes?: number; terms?: string[] };
  /** The self's own last offer in this negotiation, if it made one. */
  ours?: { price?: string; time?: string };
  /** How many counters the self already made. */
  round?: number;
  /** Times already taken in the calendar, for times. */
  busy?: { start: string; end: string }[];
  now?: number;
}

export interface NegotiationStep {
  move: Move;
  /** It accepts the other side's offer (now, or once the owner says yes): an agreed result. */
  agree?: boolean;
  /** The offer it makes or accepts; for "ask", what it would offer if the owner says yes. */
  offer: NegotiationOffer | null;
  /** What it would say next, in plain words. */
  say: string;
  /** Why, in plain words. */
  reason: string;
  /** The range it acted within, for the receipt. */
  range: string;
}

// ---------------------------------------------------------------- decimals

const SCALE = 6;

function toUnits(text: string): bigint | null {
  const t = String(text ?? "").replace(/[\s,]/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  return BigInt(a) * 10n ** BigInt(SCALE) + BigInt((b + "000000").slice(0, SCALE));
}

function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** BigInt(SCALE);
  const frac = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}${decimals ? `.${frac}` : ""}`;
}

function decimalsOf(...texts: string[]): number {
  return Math.min(SCALE, Math.max(0, ...texts.map((t) => (String(t).split(".")[1] ?? "").length)));
}

/** Rounds to the range's precision, toward the owner's side. */
function roundToward(v: bigint, decimals: number, up: boolean): bigint {
  const step = 10n ** BigInt(SCALE - decimals);
  const rem = v % step;
  if (rem === 0n) return v;
  return up ? v - rem + step : v - rem;
}

/** The price range a topic names: the one whose name appears in it, or the only one there is. */
export function rangeFor(limits: SelfLimits, topic: string): PriceRange | null {
  const list = limits.ranges.prices;
  const t = topic.toLowerCase();
  return list.find((r) => t.includes(r.label.toLowerCase()) || (t.trim().length > 2 && r.label.toLowerCase().includes(t.trim()))) ?? (list.length === 1 ? list[0] : null);
}

// ---------------------------------------------------------------- prices

export function negotiatePrice(range: PriceRange, input: Pick<NegotiationInput, "theirs" | "ours" | "round">, maxRounds: number): NegotiationStep {
  const selling = range.side === "selling";
  const min = toUnits(range.min)!;
  const max = toUnits(range.max)!;
  const open = selling ? max : min;
  const edge = selling ? min : max;
  const dec = decimalsOf(range.min, range.max);
  const fmt = (v: bigint) => `${fromUnits(v, dec)} ${range.unit}`;
  const name = `${range.label}: ${selling ? `${fmt(max)} down to ${fmt(min)}` : `${fmt(min)} up to ${fmt(max)}`}`;
  const offer = (v: bigint): NegotiationOffer => ({ kind: "price", price: fromUnits(v, dec), unit: range.unit, range: range.label });
  const better = (a: bigint, b: bigint) => (selling ? a >= b : a <= b);
  const theirs = input.theirs?.price != null ? toUnits(input.theirs.price) : null;
  const ours = input.ours?.price != null ? toUnits(input.ours.price) : null;
  if (input.theirs?.price != null && theirs === null) return { move: "ask", offer: offer(open), say: `My price is ${fmt(open)}.`, reason: "Their offer is not a plain amount.", range: name };
  if (theirs === null) return { move: "counter", offer: offer(ours ?? open), say: `My price is ${fmt(ours ?? open)}.`, reason: "It opens at your opening price.", range: name };
  const last = ours ?? open;
  if (better(theirs, last)) return { move: "accept", agree: true, offer: offer(theirs), say: `${fmt(theirs)} works for me. Let us go ahead.`, reason: `Their offer of ${fmt(theirs)} meets ${ours ? "its last counter" : "your opening price"}.`, range: name };
  if (theirs === edge) return { move: "ask", agree: true, offer: offer(edge), say: `${fmt(edge)} works for me. Let us go ahead.`, reason: `Their offer of ${fmt(theirs)} is at the edge of your range.`, range: name };
  if (!better(theirs, edge)) return { move: "ask", offer: offer(edge), say: `I cannot do ${fmt(theirs)}. The best I can do is ${fmt(edge)}.`, reason: `Their offer of ${fmt(theirs)} is ${selling ? "below the lowest" : "above the most"} you set (${fmt(edge)}).`, range: name };
  if ((input.round ?? 0) >= maxRounds) {
    const next = roundToward(last + (theirs - last) / 2n, dec, selling);
    return { move: "ask", offer: offer(next), say: `I can do ${fmt(next)}.`, reason: `It already countered ${input.round} ${input.round === 1 ? "time" : "times"}, the most you allow.`, range: name };
  }
  // Halfway toward their offer, rounded to the owner's side, never past the edge.
  let next = roundToward(last + (theirs - last) / 2n, dec, selling);
  if (!better(next, edge) || next === edge) {
    next = edge;
    return { move: "ask", offer: offer(next), say: `I can do ${fmt(next)}.`, reason: `Its next counter would reach the edge of your range (${fmt(edge)}).`, range: name };
  }
  if (next === last) return { move: "ask", agree: true, offer: offer(theirs), say: `${fmt(theirs)} works for me. Let us go ahead.`, reason: "The two offers are as close as the range allows.", range: name };
  return { move: "counter", offer: offer(next), say: `I can do ${fmt(next)}.`, reason: `Inside your range: it moves halfway toward their ${fmt(theirs)}.`, range: name };
}

// ---------------------------------------------------------------- times

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A time as people read it, with the plain form (2026-12-03 14:00) the vault can read back. */
export function formatSlot(at: Date, timeZone: string): string {
  const l = localTime(at, timeZone);
  const d = localDate(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAY[l.day]} ${d.d} ${MONTH[d.mo - 1]} at ${l.time} (${d.y}-${pad(d.mo)}-${pad(d.d)} ${l.time} ${timeZone})`;
}

function overlaps(start: number, end: number, busy: { start: string; end: string }[]): boolean {
  return busy.some((b) => {
    const s = Date.parse(b.start);
    const e = Date.parse(b.end);
    return Number.isFinite(s) && Number.isFinite(e) && s < end && start < e;
  });
}

/** Why a time does not fit the owner's ranges, or null when it fits. */
export function timeProblem(limits: SelfLimits, start: Date, minutes: number, busy: { start: string; end: string }[], now: number): string | null {
  const t = limits.ranges.times;
  const m = limits.meetings;
  if (!Number.isFinite(start.getTime())) return "The time is not clear.";
  if (start.getTime() < now + t.minNoticeHours * 3600_000) return `It is less than ${t.minNoticeHours} hours from now.`;
  if (start.getTime() > now + t.maxDaysAhead * 86_400_000) return `It is more than ${t.maxDaysAhead} days ahead.`;
  if (minutes > limits.calendar.maxMinutes) return `It is ${minutes} minutes, longer than the ${limits.calendar.maxMinutes} you allow.`;
  if (!inFreeHours(m, start, minutes)) return `It is outside your free hours (${m.from} to ${m.to}, ${m.timeZone}).`;
  if (overlaps(start.getTime(), start.getTime() + minutes * 60_000, busy)) return "It overlaps something already in your calendar.";
  return null;
}

/** The first time from `after` that fits the ranges, on the half hour, or null within the days allowed. */
export function nextFreeSlot(limits: SelfLimits, minutes: number, busy: { start: string; end: string }[], now: number, after = now): Date | null {
  const t = limits.ranges.times;
  const m = limits.meetings;
  const first = Math.max(after, now + t.minNoticeHours * 3600_000);
  const last = now + t.maxDaysAhead * 86_400_000;
  const [fh, fm] = m.from.split(":").map(Number);
  const day0 = localDate(new Date(first), m.timeZone);
  for (let i = 0; i <= t.maxDaysAhead + 1; i++) {
    const base = wallTime(day0.y, day0.mo, day0.d + i, fh, fm, m.timeZone);
    if (!base) continue;
    for (let s = base.getTime(); s <= last; s += 30 * 60_000) {
      const at = new Date(s);
      if (localDate(at, m.timeZone).d !== localDate(base, m.timeZone).d) break;
      if (s < first) continue;
      if (!inFreeHours(m, at, minutes)) {
        if (localTime(at, m.timeZone).time >= m.to) break;
        continue;
      }
      if (!timeProblem(limits, at, minutes, busy, now)) return at;
    }
  }
  return null;
}

export function negotiateTime(limits: SelfLimits, input: Pick<NegotiationInput, "theirs" | "round" | "busy" | "now">): NegotiationStep {
  const now = input.now ?? Date.now();
  const zone = limits.meetings.timeZone;
  const minutes = Math.max(5, Math.round(Number(input.theirs?.minutes ?? 30)));
  const busy = input.busy ?? [];
  const range = `Times in your free hours, ${limits.ranges.times.minNoticeHours} hours' notice, up to ${limits.ranges.times.maxDaysAhead} days ahead`;
  const offer = (at: Date): NegotiationOffer => ({ kind: "time", time: at.toISOString(), minutes });
  const theirs = input.theirs?.time ? new Date(input.theirs.time) : null;
  if (theirs) {
    const problem = timeProblem(limits, theirs, minutes, busy, now);
    if (!problem) return { move: "accept", agree: true, offer: offer(theirs), say: `${formatSlot(theirs, zone)} works for me.`, reason: "The time fits your free hours and ranges.", range };
    const slot = nextFreeSlot(limits, minutes, busy, now, Math.max(now, theirs.getTime()));
    if (!slot) return { move: "ask", offer: null, say: "That time does not work for me. Could you suggest another?", reason: `${problem} No other time fits your ranges.`, range };
    if ((input.round ?? 0) >= limits.ranges.maxRounds) return { move: "ask", offer: offer(slot), say: `That time does not work for me. How about ${formatSlot(slot, zone)}?`, reason: `${problem} It already countered the most times you allow.`, range };
    return { move: "counter", offer: offer(slot), say: `That time does not work for me. How about ${formatSlot(slot, zone)}?`, reason: `${problem} It offers the next time that fits.`, range };
  }
  const slot = nextFreeSlot(limits, minutes, busy, now);
  if (!slot) return { move: "ask", offer: null, say: "Could you suggest a time that suits you?", reason: "No time fits your ranges.", range };
  return { move: "counter", offer: offer(slot), say: `How about ${formatSlot(slot, zone)}?`, reason: "It offers the first time that fits your ranges.", range };
}

// ---------------------------------------------------------------- terms

export function negotiateTerms(limits: SelfLimits, terms: string[]): NegotiationStep {
  const { allowed, forbidden } = limits.ranges.terms;
  const asked = terms.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30);
  const range = "The terms you allow";
  const offer: NegotiationOffer = { kind: "terms", terms: asked };
  if (!asked.length) return { move: "ask", offer: null, say: "Which terms do you have in mind?", reason: "No terms were named.", range };
  const has = (list: string[], t: string) => list.find((x) => t.toLowerCase().includes(x));
  const bad = asked.map((t) => has(forbidden, t)).find(Boolean);
  if (bad) return { move: "ask", offer, say: `I cannot agree to ${bad}. The rest works for me.`, reason: `"${bad}" is a term you never agree to.`, range };
  const unknown = asked.filter((t) => !has(allowed, t));
  if (unknown.length) return { move: "ask", agree: true, offer, say: "Those terms work for me.", reason: `${unknown.map((t) => `"${t}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not on your list of terms it may agree to.`, range };
  return { move: "accept", agree: true, offer, say: "Those terms work for me.", reason: "Every term is on your allowed list.", range };
}

// ---------------------------------------------------------------- one step

/** One step of a negotiation within the owner's ranges. Never-touch rules and a switched-off negotiation stop it first. */
export function negotiate(limits: SelfLimits, input: NegotiationInput): NegotiationStep {
  const hit = neverTouchHit(limits, [input.who], [input.topic, ...(input.theirs?.terms ?? [])]);
  if (hit) return { move: "ask", offer: null, say: "", reason: `It names "${hit}", which is on your never-touch list. It will not negotiate this.`, range: "" };
  if (!limits.ranges.on) return { move: "ask", offer: null, say: "", reason: "Negotiating on its own is off.", range: "" };
  if (input.kind === "time") {
    if (!limits.ranges.times.on) return { move: "ask", offer: null, say: "", reason: "Agreeing times on its own is off.", range: "" };
    return negotiateTime(limits, input);
  }
  if (input.kind === "terms") return negotiateTerms(limits, input.theirs?.terms ?? []);
  const range = rangeFor(limits, input.topic);
  if (!range) return { move: "ask", offer: null, say: "", reason: `There is no price range for "${input.topic}".`, range: "" };
  return negotiatePrice(range, input, limits.ranges.maxRounds);
}

/** The owner's ranges as lines for a meeting of selves, so the self proposes inside them. */
export function rangesForPrompt(limits: SelfLimits): string[] {
  const r = limits.ranges;
  if (!r.on) return [];
  const out = ["Ranges your owner set. Propose and agree only inside them; when the other side wants something outside them, say you will check with your owner and end your message with [done]."];
  if (r.times.on) out.push(`- Times: ${limits.meetings.days.map((d) => DAY[d]).join(", ")} ${limits.meetings.from} to ${limits.meetings.to} (${limits.meetings.timeZone}), at least ${r.times.minNoticeHours} hours from now, at most ${r.times.maxDaysAhead} days ahead, at most ${limits.calendar.maxMinutes} minutes. Write a time as 2026-12-03 14:00.`);
  for (const p of r.prices) out.push(`- ${p.label}: ${p.side === "selling" ? `start at ${p.max} ${p.unit}, never below ${p.min} ${p.unit}` : `start at ${p.min} ${p.unit}, never above ${p.max} ${p.unit}`}.`);
  if (r.terms.allowed.length) out.push(`- Terms you may agree to: ${r.terms.allowed.join("; ")}.`);
  if (r.terms.forbidden.length) out.push(`- Never agree to: ${r.terms.forbidden.join("; ")}.`);
  return out;
}

/** Why a turn of the self in a meeting goes past the owner's ranges (a price past an edge, a term never agreed to), or null. */
export function turnPastRanges(limits: SelfLimits, text: string): string | null {
  const r = limits.ranges;
  if (!r.on) return null;
  const lower = text.toLowerCase();
  const bad = r.terms.forbidden.find((t) => lower.includes(t));
  if (bad) return `It mentions "${bad}", a term you never agree to.`;
  for (const p of r.prices) {
    const unit = p.unit.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${unit}\\b|\\b${unit}\\s*(\\d[\\d,]*(?:\\.\\d+)?)`, "gi");
    for (const m of lower.matchAll(re)) {
      const v = toUnits((m[1] ?? m[2] ?? "").replace(/,/g, ""));
      if (v === null) continue;
      const edge = toUnits(p.side === "selling" ? p.min : p.max)!;
      if (p.side === "selling" ? v <= edge : v >= edge) return `It names ${fromUnits(v, decimalsOf(p.min, p.max))} ${p.unit}, at or past the edge of ${p.label}.`;
    }
  }
  return null;
}

/** An agreed result, written out for a sealed agreement. */
export function agreementText(input: { topic: string; who: string; me: string; offer: NegotiationOffer; timeZone: string }): { title: string; text: string } {
  const o = input.offer;
  const what =
    o.kind === "price"
      ? `The price for ${input.topic} is ${o.price} ${o.unit}.`
      : o.kind === "time"
        ? `${input.topic} takes place ${o.time ? formatSlot(new Date(o.time), input.timeZone) : "at the agreed time"}${o.minutes ? `, for ${o.minutes} minutes` : ""}.`
        : `The terms for ${input.topic} are: ${(o.terms ?? []).join("; ")}.`;
  return {
    title: `${input.topic}: agreed with ${input.who.replace(/<[^<>]*>/g, "").trim() || input.who}`.slice(0, 200),
    text: [input.me ? `${input.me} and ${input.who} agree:` : `${input.who} and I agree:`, "", what].join("\n"),
  };
}

/**
 * A negotiation a message opens, when the owner's ranges cover it: a price in
 * the unit of a range the subject or text names, or a
 * time written plainly (2026-12-03 14:00) in a message about meeting. Null
 * when it is neither, or negotiating is off.
 */
export function negotiationFromMessage(limits: SelfLimits, m: { who: string; subject: string; text: string; minutes?: number }): NegotiationInput | null {
  const r = limits.ranges;
  if (!r.on) return null;
  const all = `${m.subject}\n${m.text}`;
  // Only a range the message names: a stray amount in a message about something else is not an offer.
  const range = r.prices.find((p) => all.toLowerCase().includes(p.label.toLowerCase())) ?? null;
  if (range) {
    const unit = range.unit.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${unit}\\b|\\b${unit}\\s*(\\d[\\d,]*(?:\\.\\d+)?)`, "i");
    const hit = re.exec(all.toLowerCase());
    if (hit) return { kind: "price", topic: range.label, who: m.who, theirs: { price: (hit[1] ?? hit[2]).replace(/,/g, "") } };
  }
  if (r.times.on) {
    const at = agreedTime(all, limits.meetings.timeZone);
    if (at && /\b(meet|meeting|call|time|slot|available|free)\b/i.test(all)) return { kind: "time", topic: m.subject || "A meeting", who: m.who, theirs: { time: at.toISOString(), minutes: m.minutes ?? 30 } };
  }
  return null;
}
