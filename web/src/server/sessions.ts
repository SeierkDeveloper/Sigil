// Sessions with the public AI self on the server. The offer is public; a
// booking holds the topic, the slot, the visitor's intake sealed to the public
// self's key (which the server cannot open), the consent text the visitor
// agreed to, and the hash of the session token. Questions travel through the
// public self's relay, tied to the booking; each answered turn leaves a note
// sealed to the owner's vault for the transcript.

import { askProblem, bookingProblem, cleanOffer, openSlots, type SessionOffer } from "@sigil/core";
import { tokenHash } from "@sigil/core";
import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { HttpError, logRead } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const BOOKINGS_KEPT = 500;

function selfOf(db: Db, userId: string): Row {
  const r = db.prepare("SELECT * FROM public_selves WHERE user_id = ?").get(userId) as Row | undefined;
  if (!r) throw new HttpError(404, "Set up your public AI self first.", "no_public");
  return r;
}

function offerRow(db: Db, selfId: string): SessionOffer | null {
  const r = db.prepare("SELECT offer FROM session_offers WHERE self_id = ?").get(selfId) as Row | undefined;
  return r ? cleanOffer(JSON.parse(String(r.offer))) : null;
}

export function saveOffer(db: Db, userId: string, offer: unknown): SessionOffer {
  const self = selfOf(db, userId);
  const clean = cleanOffer(offer);
  db.prepare("INSERT INTO session_offers (self_id, offer, updated_at) VALUES (?, ?, ?) ON CONFLICT (self_id) DO UPDATE SET offer = excluded.offer, updated_at = excluded.updated_at").run(
    String(self.id),
    JSON.stringify(clean),
    now(),
  );
  return clean;
}

function booked(db: Db, selfId: string) {
  return (db.prepare("SELECT slot_start, state FROM session_bookings WHERE self_id = ?").all(selfId) as Row[]).map((r) => ({ start: String(r.slot_start), state: r.state as "booked" | "ended" | "blocked" }));
}

function toBooking(r: Row) {
  return {
    id: String(r.id),
    topic: String(r.topic),
    slotStart: String(r.slot_start),
    slotEnd: String(r.slot_end),
    turns: Number(r.turns),
    used: Number(r.used),
    state: r.state as "booked" | "ended" | "blocked",
    createdAt: String(r.created_at),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
  };
}

/** The owner's view: the offer, and every booking with its sealed intake, the consent text and each turn's sealed note. */
export function ownerSessions(db: Db, userId: string) {
  const self = db.prepare("SELECT id FROM public_selves WHERE user_id = ?").get(userId) as Row | undefined;
  if (!self) return { offer: null, bookings: [] };
  const turns = db.prepare("SELECT turn, note, created_at FROM session_turns WHERE booking_id = ? ORDER BY turn");
  return {
    offer: offerRow(db, String(self.id)),
    bookings: (db.prepare("SELECT * FROM session_bookings WHERE self_id = ? ORDER BY slot_start DESC LIMIT ?").all(String(self.id), BOOKINGS_KEPT) as Row[]).map((r) => ({
      ...toBooking(r),
      intake: String(r.intake),
      consent: String(r.consent),
      transcript: (turns.all(String(r.id)) as Row[]).map((t) => ({ turn: Number(t.turn), note: String(t.note), at: String(t.created_at) })),
    })),
  };
}

// ---------------------------------------------------------------- the public side

function byHandle(db: Db, handle: string): Row {
  const r = db.prepare("SELECT * FROM public_selves WHERE handle = ?").get(handle) as Row | undefined;
  if (!r) throw new HttpError(404, "There is no public AI self with that name.", "no_public");
  return r;
}

const online = (seen: unknown, at = Date.now()) => seen != null && at - Number(seen) < serverConfig.agentOnlineMs;

/** What a visitor sees before booking: the offer and the free times. */
export function publicOffer(db: Db, handle: string, at = new Date()) {
  const r = byHandle(db, handle);
  const offer = offerRow(db, String(r.id));
  const open = Number(r.enabled) === 1 && !!offer?.enabled;
  return {
    selfId: String(r.id),
    handle: String(r.handle),
    name: String(r.name),
    publicKey: String(r.public_key),
    voice: Number(r.voice) === 1,
    offer: open ? offer : null,
    slots: open && offer ? openSlots(offer, booked(db, String(r.id)), at) : [],
  };
}

export interface BookingInput {
  id: string;
  slotStart: string;
  topic: string;
  intake: string;
  tokenHash: string;
  askerKey: string;
}

export function book(db: Db, handle: string, visitor: string, b: BookingInput, at = new Date()): { id: string; slotStart: string; slotEnd: string } {
  return tx(db, () => {
    const r = byHandle(db, handle);
    const selfId = String(r.id);
    const offer = offerRow(db, selfId);
    if (Number(r.enabled) !== 1 || !offer) throw new HttpError(410, "This person is not taking sessions right now.", "no_sessions");
    if (db.prepare("SELECT 1 FROM session_blocks WHERE self_id = ? AND visitor = ?").get(selfId, visitor)) throw new HttpError(403, "The host does not take sessions from you.", "blocked");
    const problem = bookingProblem(offer, booked(db, selfId), b.slotStart, at);
    if (problem) throw new HttpError(409, problem, "slot_taken");
    if (offer.topics.length && !offer.topics.includes(b.topic)) throw new HttpError(400, "Pick one of the topics offered.", "invalid");
    const mine = db.prepare("SELECT COUNT(*) AS n FROM session_bookings WHERE self_id = ? AND visitor = ? AND state = 'booked' AND slot_end > ?").get(selfId, visitor, at.toISOString()) as Row;
    if (Number(mine.n) >= 2) throw new HttpError(429, "You already have two sessions booked with this person.", "visitor_limit");
    const slotEnd = new Date(Date.parse(b.slotStart) + offer.slotMinutes * 60_000).toISOString();
    db.prepare(
      "INSERT INTO session_bookings (id, self_id, user_id, topic, slot_start, slot_end, turns, intake, consent, token_hash, asker_key, visitor, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?)",
    ).run(b.id, selfId, String(r.user_id), b.topic, b.slotStart, slotEnd, offer.turns, b.intake, offer.consent, b.tokenHash, b.askerKey, visitor, at.toISOString());
    logRead(db, { appId: selfId, userId: String(r.user_id) }, "session", `booked-${b.id}`, 1, at);
    return { id: b.id, slotStart: b.slotStart, slotEnd };
  });
}

/** A session, for whoever holds its link. */
export function bookingByToken(db: Db, bookingId: string, token: string): Row {
  const r = db.prepare("SELECT * FROM session_bookings WHERE id = ?").get(bookingId) as Row | undefined;
  if (!r || String(r.token_hash) !== tokenHash(token)) throw new HttpError(404, "This session link does not work. Book again from the person's page.", "no_session");
  return r;
}

export function sessionStatus(db: Db, bookingId: string, token: string, at = Date.now()) {
  const r = bookingByToken(db, bookingId, token);
  const self = db.prepare("SELECT handle, name, public_key, agent_seen_at, enabled, voice FROM public_selves WHERE id = ?").get(String(r.self_id)) as Row;
  const offer = offerRow(db, String(r.self_id));
  const b = toBooking(r);
  return {
    ...b,
    selfId: String(r.self_id),
    handle: String(self.handle),
    name: String(self.name),
    publicKey: String(self.public_key),
    askerKey: String(r.asker_key),
    voice: Number(self.voice) === 1,
    houseRules: offer?.houseRules ?? "",
    online: Number(self.enabled) === 1 && online(self.agent_seen_at, at),
    problem: askProblem(b, at),
  };
}

/** A question in a session: within its time, its number of questions, while the owner's side is answering. */
export function askInSession(db: Db, bookingId: string, token: string, q: { id: string; sealed: string }, at = Date.now()): { id: string } {
  return tx(db, () => {
    const r = bookingByToken(db, bookingId, token);
    const problem = askProblem(toBooking(r), at);
    if (problem) throw new HttpError(409, problem, "session_closed");
    const self = db.prepare("SELECT * FROM public_selves WHERE id = ?").get(String(r.self_id)) as Row;
    if (Number(self.enabled) !== 1 || !online(self.agent_seen_at, at)) {
      throw new HttpError(503, "The host's AI self is not answering right now: their vault is not open and their connector is not running. Try again in a moment.", "offline");
    }
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM public_questions WHERE booking_id = ? AND answered_at IS NULL AND created_at > ?").get(bookingId, at - 120_000) as Row;
    if (Number(waiting.n) > 0) throw new HttpError(429, "Wait for the answer to your last question first.", "waiting");
    if (db.prepare("SELECT 1 FROM public_questions WHERE id = ?").get(q.id)) throw new HttpError(409, "A question with this id already exists.");
    db.prepare("INSERT INTO public_questions (id, self_id, user_id, visitor, session_id, asker_key, sealed, created_at, booking_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      q.id,
      String(r.self_id),
      String(r.user_id),
      String(r.visitor),
      bookingId,
      String(r.asker_key),
      q.sealed,
      at,
      bookingId,
    );
    return { id: q.id };
  });
}

export function sessionQuestionStatus(db: Db, bookingId: string, token: string, questionId: string, at = Date.now()): { status: "waiting" | "answered" | "gone"; answer?: string } {
  bookingByToken(db, bookingId, token);
  const q = db.prepare("SELECT answer, created_at FROM public_questions WHERE id = ? AND booking_id = ?").get(questionId, bookingId) as Row | undefined;
  if (!q) return { status: "gone" };
  if (q.answer) return { status: "answered", answer: String(q.answer) };
  if (at - Number(q.created_at) > 120_000) return { status: "gone" };
  return { status: "waiting" };
}

/** For the owner's answering side: the booking a waiting question belongs to. */
export function bookingFor(db: Db, bookingId: string) {
  const r = db.prepare("SELECT * FROM session_bookings WHERE id = ?").get(bookingId) as Row | undefined;
  if (!r) return null;
  const offer = offerRow(db, String(r.self_id));
  return { ...toBooking(r), intake: String(r.intake), houseRules: offer?.houseRules ?? "", turn: Number(r.used) + 1 };
}

/** Records one answered turn: the count goes up, the transcript gets the sealed note, the log a line. Inside the answer's transaction. */
export function recordTurn(db: Db, bookingId: string, note: string, cited: number, at = new Date()): void {
  const r = db.prepare("SELECT * FROM session_bookings WHERE id = ?").get(bookingId) as Row | undefined;
  if (!r) throw new HttpError(404, "That session was not found.", "no_session");
  const turn = Number(r.used) + 1;
  db.prepare("UPDATE session_bookings SET used = ? WHERE id = ?").run(turn, bookingId);
  db.prepare("INSERT INTO session_turns (booking_id, turn, note, created_at) VALUES (?, ?, ?, ?)").run(bookingId, turn, note, at.toISOString());
  logRead(db, { appId: String(r.self_id), userId: String(r.user_id) }, "session", `turn-${bookingId}-${turn}`, cited, at);
}


/** The owner ends a session, or ends it and blocks its visitor from booking again. */
export function closeSession(db: Db, userId: string, bookingId: string, block: boolean): void {
  tx(db, () => {
    const r = db.prepare("SELECT * FROM session_bookings WHERE id = ? AND user_id = ?").get(bookingId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That session was not found.", "no_session");
    db.prepare("UPDATE session_bookings SET state = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(block ? "blocked" : "ended", now(), bookingId);
    db.prepare("DELETE FROM public_questions WHERE booking_id = ? AND answered_at IS NULL").run(bookingId);
    if (block) db.prepare("INSERT OR IGNORE INTO session_blocks (self_id, visitor, created_at) VALUES (?, ?, ?)").run(String(r.self_id), String(r.visitor), now());
    logRead(db, { appId: String(r.self_id), userId }, "session", `${block ? "blocked" : "ended"}-${bookingId}`, 1);
  });
}
