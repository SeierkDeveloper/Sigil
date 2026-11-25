// The public AI self on the server: its settings and public key, the plain
// public copy of the folders the owner made public, the relay for visitors'
// questions (relay boxes only the visitor and the owner's device open), and the
// answers the owner lets the page show.
//
// The server never holds the public self's private key or rules in readable
// form, and no private folder ever reaches it in plain: only the public copy,
// which the owner's device publishes on purpose.

import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { HttpError, logRead, type AppAuth } from "./store";
import { tierOf } from "./holders";
import { sha256Hex } from "@sigil/core";
import { bookingFor, recordTurn } from "./sessions";
import { assertNotMoved } from "./nodes";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const onlineMs = () => serverConfig.agentOnlineMs;

export const ANSWER_WAIT_MS = 120_000;
export const QUESTION_KEEP_MS = 24 * 3600_000;
export const WALL_LIMIT = 200;
export const PUBLIC_COPY_BYTES = 8 * 1024 * 1024;

export interface PublicSelfInput {
  id: string;
  handle: string;
  name: string;
  greeting: string;
  publicKey: string;
  ownerBox: string;
  appId: string | null;
  appBox: string | null;
  perVisitorHour: number;
  showAnswers: boolean;
  enabled: boolean;
  voice?: boolean;
}

function online(seen: unknown, at = Date.now()): boolean {
  return seen != null && at - Number(seen) < onlineMs();
}

function selfRow(db: Db, userId: string): Row | undefined {
  return db.prepare("SELECT * FROM public_selves WHERE user_id = ?").get(userId) as Row | undefined;
}

function wall(db: Db, selfId: string, withHidden: boolean) {
  return (
    db.prepare(`SELECT * FROM public_wall WHERE self_id = ? ${withHidden ? "" : "AND hidden = 0"} ORDER BY created_at DESC LIMIT ${WALL_LIMIT}`).all(selfId) as Row[]
  ).map((r) => ({
    id: String(r.id),
    question: String(r.question),
    answer: String(r.answer),
    sources: JSON.parse(String(r.sources)) as { id: string; title: string }[],
    hidden: Number(r.hidden) === 1,
    createdAt: String(r.created_at),
  }));
}

/** The owner's view: settings, the encrypted key and rules, counts and every answer on the wall, hidden ones too. */
export function ownerPublicSelf(db: Db, userId: string) {
  const r = selfRow(db, userId);
  if (!r) return null;
  const items = db.prepare("SELECT COUNT(*) AS n FROM public_items WHERE self_id = ?").get(String(r.id)) as Row;
  return {
    id: String(r.id),
    handle: String(r.handle),
    name: String(r.name),
    greeting: String(r.greeting),
    publicKey: String(r.public_key),
    ownerBox: String(r.owner_box),
    appId: r.app_id == null ? null : String(r.app_id),
    perVisitorHour: Number(r.per_visitor_hour),
    showAnswers: Number(r.show_answers) === 1,
    enabled: Number(r.enabled) === 1,
    voice: Number(r.voice) === 1,
    copyHash: r.copy_hash == null ? null : String(r.copy_hash),
    publishedAt: r.published_at == null ? null : String(r.published_at),
    items: Number(items.n),
    asked: Number(r.asked),
    answered: Number(r.answered),
    online: online(r.agent_seen_at),
    wall: wall(db, String(r.id), true),
    createdAt: String(r.created_at),
  };
}

export function savePublicSelf(db: Db, userId: string, s: PublicSelfInput): void {
  tx(db, () => {
    const cur = selfRow(db, userId);
    if (cur && String(cur.id) !== s.id) throw new HttpError(409, "This vault already has a public AI self.", "exists");
    if (!cur && db.prepare("SELECT 1 FROM public_selves WHERE id = ?").get(s.id)) throw new HttpError(409, "That id is taken.");
    const taken = db.prepare("SELECT user_id FROM public_selves WHERE handle = ?").get(s.handle) as Row | undefined;
    if (taken && String(taken.user_id) !== userId) throw new HttpError(409, "That handle is taken. Choose another.", "handle_taken");
    // Handles of 3 or 4 characters are for Wardens; one already held stays with its owner.
    if (s.handle.length <= 4 && (!cur || String(cur.handle) !== s.handle) && tierOf(db, userId) !== "warden") {
      throw new HttpError(403, "Handles of 3 or 4 characters come with the Warden tier. Choose one of 5 or more.", "short_handle");
    }
    if (s.appId) {
      const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(s.appId, userId) as Row | undefined;
      if (!app || app.revoked_at) throw new HttpError(400, "That app is not connected.");
      if (!s.appBox) throw new HttpError(400, "An app that answers needs the key wrapped for it.", "invalid");
    }
    const at = now();
    if (!cur) {
      db.prepare(
        `INSERT INTO public_selves (id, user_id, handle, name, greeting, public_key, owner_box, app_id, app_box, per_visitor_hour, show_answers, enabled, voice, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(s.id, userId, s.handle, s.name, s.greeting, s.publicKey, s.ownerBox, s.appId, s.appId ? s.appBox : null, s.perVisitorHour, s.showAnswers ? 1 : 0, s.enabled ? 1 : 0, s.voice ? 1 : 0, at, at);
    } else {
      if (String(cur.public_key) !== s.publicKey) throw new HttpError(400, "The public key of a public AI self does not change. Turn it off and make a new one.", "invalid");
      db.prepare(
        "UPDATE public_selves SET handle = ?, name = ?, greeting = ?, owner_box = ?, app_id = ?, app_box = ?, per_visitor_hour = ?, show_answers = ?, enabled = ?, voice = ?, updated_at = ? WHERE id = ?",
      ).run(s.handle, s.name, s.greeting, s.ownerBox, s.appId, s.appId ? s.appBox : null, s.perVisitorHour, s.showAnswers ? 1 : 0, s.enabled ? 1 : 0, s.voice ? 1 : 0, at, s.id);
      if (!s.enabled) db.prepare("DELETE FROM public_questions WHERE self_id = ? AND answered_at IS NULL").run(s.id);
    }
  });
}

/** Turning it off for good: the settings, the public copy, the questions and the wall all go. */
export function deletePublicSelf(db: Db, userId: string): void {
  db.prepare("DELETE FROM public_selves WHERE user_id = ?").run(userId);
}

export interface PublicItemInput {
  id: string;
  title: string;
  body: string;
  tags: string[];
  editedAt: string;
}

/** Replaces the public copy with what the owner's device published. */
export function publishItems(db: Db, userId: string, items: PublicItemInput[], hash: string): number {
  return tx(db, () => {
    const r = selfRow(db, userId);
    if (!r) throw new HttpError(404, "Set up your public AI self first.", "no_public");
    const size = items.reduce((n, i) => n + i.title.length + i.body.length, 0);
    if (size > PUBLIC_COPY_BYTES) throw new HttpError(413, "The public copy is too large. Make fewer folders public.", "too_large");
    const id = String(r.id);
    db.prepare("DELETE FROM public_items WHERE self_id = ?").run(id);
    const ins = db.prepare("INSERT INTO public_items (self_id, id, title, body, tags, edited_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const i of items) ins.run(id, i.id, i.title, i.body, JSON.stringify(i.tags), i.editedAt);
    db.prepare("UPDATE public_selves SET copy_hash = ?, published_at = ? WHERE id = ?").run(hash, now(), id);
    return items.length;
  });
}

export function hideAnswer(db: Db, userId: string, answerId: string, hidden: boolean): void {
  const r = selfRow(db, userId);
  if (!r) throw new HttpError(404, "There is no public AI self.", "no_public");
  const u = db.prepare("UPDATE public_wall SET hidden = ? WHERE id = ? AND self_id = ?").run(hidden ? 1 : 0, answerId, String(r.id));
  if (u.changes === 0) throw new HttpError(404, "That answer was not found.");
}

// ---------------------------------------------------------------- the public page

function byHandle(db: Db, handle: string): Row {
  const r = db.prepare("SELECT * FROM public_selves WHERE handle = ?").get(handle) as Row | undefined;
  if (!r) {
    assertNotMoved(db, "public", handle);
    throw new HttpError(404, "There is no public AI self with that name.", "no_public");
  }
  const moved = db.prepare("SELECT moved_to FROM users WHERE id = ?").get(String(r.user_id)) as Row | undefined;
  if (moved?.moved_to) assertNotMoved(db, "public", handle);
  return r;
}

function items(db: Db, selfId: string) {
  return (db.prepare("SELECT id, title, body, tags, edited_at FROM public_items WHERE self_id = ? ORDER BY edited_at DESC, id").all(selfId) as Row[]).map((r) => ({
    id: String(r.id),
    title: String(r.title),
    body: String(r.body),
    tags: JSON.parse(String(r.tags)) as string[],
    editedAt: String(r.edited_at),
  }));
}

/** What a visitor's page needs. Nothing about the owner beyond what the owner published. */
export function publicPage(db: Db, handle: string) {
  const r = byHandle(db, handle);
  const enabled = Number(r.enabled) === 1;
  return {
    id: String(r.id),
    handle: String(r.handle),
    name: String(r.name),
    greeting: String(r.greeting),
    publicKey: String(r.public_key),
    enabled,
    online: enabled && online(r.agent_seen_at),
    perVisitorHour: Number(r.per_visitor_hour),
    showAnswers: Number(r.show_answers) === 1,
    voice: Number(r.voice) === 1,
    holder: tierOf(db, String(r.user_id)),
    sessions: enabled && !!db.prepare("SELECT 1 FROM session_offers WHERE self_id = ? AND json_extract(offer, '$.enabled') = 1").get(String(r.id)),
    items: enabled ? items(db, String(r.id)).map(({ body: _b, ...i }) => i) : [],
    wall: enabled && Number(r.show_answers) === 1 ? wall(db, String(r.id), false).map(({ hidden: _h, ...w }) => w) : [],
  };
}

export function publicItem(db: Db, handle: string, itemId: string) {
  const r = byHandle(db, handle);
  if (Number(r.enabled) !== 1) throw new HttpError(410, "The owner turned their public AI self off.", "off");
  const i = db.prepare("SELECT id, title, body, tags, edited_at FROM public_items WHERE self_id = ? AND id = ?").get(String(r.id), itemId) as Row | undefined;
  if (!i) throw new HttpError(404, "That source is no longer public.", "no_item");
  return { id: String(i.id), title: String(i.title), body: String(i.body), tags: JSON.parse(String(i.tags)) as string[], editedAt: String(i.edited_at) };
}

/** A visitor is counted by a hash of their address and the page, never the address itself. */
export function visitorOf(ip: string, selfId: string): string {
  return sha256Hex(`sigil-visitor:${selfId}:${ip}`).slice(0, 32);
}

export function askPublic(db: Db, handle: string, visitor: string, q: { id: string; sessionId: string; askerKey: string; sealed: string }, at = Date.now()): { id: string } {
  return tx(db, () => {
    db.prepare("DELETE FROM public_questions WHERE created_at < ?").run(at - QUESTION_KEEP_MS);
    const r = byHandle(db, handle);
    const selfId = String(r.id);
    if (Number(r.enabled) !== 1) throw new HttpError(410, "The owner turned their public AI self off.", "off");
    if (!online(r.agent_seen_at, at)) {
      throw new HttpError(503, "The owner's AI self is offline right now: their vault is not open and their connector is not running. Try again later.", "offline");
    }
    const mine = db.prepare("SELECT COUNT(*) AS n FROM public_questions WHERE self_id = ? AND visitor = ? AND created_at > ? AND booking_id IS NULL").get(selfId, visitor, at - 3600_000) as Row;
    if (Number(mine.n) >= Number(r.per_visitor_hour)) throw new HttpError(429, "You have asked as many questions as the owner allows in an hour. Try again later.", "visitor_limit");
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM public_questions WHERE session_id = ? AND answered_at IS NULL AND created_at > ?").get(q.sessionId, at - ANSWER_WAIT_MS) as Row;
    if (Number(waiting.n) > 0) throw new HttpError(429, "Wait for the answer to your last question first.", "waiting");
    if (db.prepare("SELECT 1 FROM public_questions WHERE id = ?").get(q.id)) throw new HttpError(409, "A question with this id already exists.");
    db.prepare("INSERT INTO public_questions (id, self_id, user_id, visitor, session_id, asker_key, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      q.id,
      selfId,
      String(r.user_id),
      visitor,
      q.sessionId,
      q.askerKey,
      q.sealed,
      at,
    );
    db.prepare("UPDATE public_selves SET asked = asked + 1 WHERE id = ?").run(selfId);
    return { id: q.id };
  });
}

export function publicQuestionStatus(db: Db, handle: string, questionId: string, at = Date.now()): { status: "waiting" | "answered" | "gone"; answer?: string } {
  const r = byHandle(db, handle);
  const q = db.prepare("SELECT answer, created_at FROM public_questions WHERE id = ? AND self_id = ?").get(questionId, String(r.id)) as Row | undefined;
  if (!q) return { status: "gone" };
  if (q.answer) return { status: "answered", answer: String(q.answer) };
  if (at - Number(q.created_at) > ANSWER_WAIT_MS) return { status: "gone" };
  return { status: "waiting" };
}

// ---------------------------------------------------------------- the owner's device answering

export type PublicAgent = { kind: "vault"; userId: string } | { kind: "app"; auth: AppAuth };

function agentSelf(db: Db, agent: PublicAgent): Row | null {
  if (agent.kind === "vault") return selfRow(db, agent.userId) ?? null;
  const r = db.prepare("SELECT * FROM public_selves WHERE user_id = ? AND app_id = ?").get(agent.auth.userId, agent.auth.appId) as Row | undefined;
  return r ?? null;
}

/** Marks the public self online and hands over waiting questions. */
export function publicPending(db: Db, agent: PublicAgent, at = Date.now()) {
  const r = agentSelf(db, agent);
  if (!r || Number(r.enabled) !== 1) return [];
  const selfId = String(r.id);
  db.prepare("UPDATE public_selves SET agent_seen_at = ? WHERE id = ?").run(at, selfId);
  return (
    db
      .prepare("SELECT id, session_id, asker_key, sealed, created_at, booking_id FROM public_questions WHERE self_id = ? AND answered_at IS NULL AND created_at > ? ORDER BY created_at LIMIT 20")
      .all(selfId, at - ANSWER_WAIT_MS) as Row[]
  ).map((q) => ({
    id: String(q.id),
    selfId,
    sessionId: String(q.session_id),
    askerKey: String(q.asker_key),
    sealed: String(q.sealed),
    createdAt: new Date(Number(q.created_at)).toISOString(),
    // A question in a booked session comes with its booking: the topic, the sealed intake, the house rules and which turn it is.
    booking: q.booking_id == null ? null : bookingFor(db, String(q.booking_id)),
  }));
}

/** The connector's copy of the public self (its key and rules wrapped for that app) and the public copy it answers from. */
export function appPublicSelf(db: Db, auth: AppAuth) {
  const r = agentSelf(db, { kind: "app", auth });
  if (!r) throw new HttpError(403, "This app does not answer the owner's public AI self.", "public_off");
  return { id: String(r.id), handle: String(r.handle), publicKey: String(r.public_key), box: String(r.app_box), enabled: Number(r.enabled) === 1, items: items(db, String(r.id)) };
}

export function ownerItems(db: Db, userId: string) {
  const r = selfRow(db, userId);
  return r ? items(db, String(r.id)) : [];
}

export interface PublicAnswerInput {
  sealed: string;
  note: string;
  cited: number;
  wall: { question: string; answer: string; sources: { id: string; title: string }[] } | null;
}

/** Stores the sealed answer for the visitor, the sealed note in the owner's log, and, when the owner allows, the answer on the page. */
export function answerPublic(db: Db, agent: PublicAgent, questionId: string, a: PublicAnswerInput, at = new Date()): void {
  tx(db, () => {
    const r = agentSelf(db, agent);
    if (!r) throw new HttpError(403, "This agent does not answer the public AI self.", "public_off");
    const selfId = String(r.id);
    const q = db.prepare("SELECT answered_at, booking_id FROM public_questions WHERE id = ? AND self_id = ?").get(questionId, selfId) as Row | undefined;
    if (!q) throw new HttpError(404, "That question was not found. It may have expired.", "no_question");
    if (q.answered_at) throw new HttpError(409, "That question was already answered.", "answered");
    db.prepare("UPDATE public_questions SET answer = ?, answered_at = ? WHERE id = ?").run(a.sealed, at.getTime(), questionId);
    if (q.booking_id != null) {
      // A turn of a booked session: the transcript gets the note, never the page.
      recordTurn(db, String(q.booking_id), a.note, a.cited, at);
      return;
    }
    db.prepare("UPDATE public_selves SET answered = answered + 1 WHERE id = ?").run(selfId);
    if (a.wall && Number(r.show_answers) === 1) {
      db.prepare("INSERT OR IGNORE INTO public_wall (id, self_id, question, answer, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        questionId,
        selfId,
        a.wall.question.slice(0, 2000),
        a.wall.answer.slice(0, 4000),
        JSON.stringify(a.wall.sources.slice(0, 12)),
        at.toISOString(),
      );
      db.prepare(`DELETE FROM public_wall WHERE self_id = ? AND id NOT IN (SELECT id FROM public_wall WHERE self_id = ? ORDER BY created_at DESC LIMIT ${WALL_LIMIT})`).run(selfId, selfId);
    }
    logRead(db, { appId: selfId, userId: String(r.user_id) }, "public", questionId, a.cited, at, a.note);
  });
}
