// Vault settings, the apps that may answer as the AI self, and the relay for
// "Ask my AI self" links. Everything stored here is an envelope under a key the
// server never holds, a public key, or a relay box only the asker and the
// owner's agent can open. The server checks limits and moves boxes; it cannot
// read a question, an answer, a rule or a model key.

import { tx, type Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

/** How long the owner's agent counts as online after it last asked for questions. */
export const AGENT_ONLINE_MS = 30_000;
/** How long an asker waits for an answer before the question is given up. */
export const ANSWER_WAIT_MS = 120_000;
/** Questions are deleted this long after they were asked, answered or not. */
export const QUESTION_KEEP_MS = 24 * 3600_000;
export const LINKS_PER_VAULT = 50;
export const MAX_LINK_USES = 1000;
export const MAX_PER_HOUR = 120;

// ---------------------------------------------------------------- settings

export function listSettings(db: Db, userId: string): Record<string, string> {
  const rows = db.prepare("SELECT name, value FROM vault_settings WHERE user_id = ?").all(userId) as Row[];
  return Object.fromEntries(rows.map((r) => [String(r.name), String(r.value)]));
}

export function putSetting(db: Db, userId: string, name: string, value: string): void {
  db.prepare(
    "INSERT INTO vault_settings (user_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(userId, name, value, now());
}

export function deleteSetting(db: Db, userId: string, name: string): void {
  db.prepare("DELETE FROM vault_settings WHERE user_id = ? AND name = ?").run(userId, name);
}

// ---------------------------------------------------------------- apps that answer as the AI self

function activeApp(db: Db, userId: string, appId: string): void {
  const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
  if (!app) throw new HttpError(404, "That app was not found.");
  if (app.revoked_at) throw new HttpError(400, "This app was revoked. Connect it again to give it access.");
}

export function setSelfApp(db: Db, userId: string, appId: string, config: string | null): void {
  tx(db, () => {
    activeApp(db, userId, appId);
    if (config === null) {
      db.prepare("DELETE FROM self_apps WHERE app_id = ? AND user_id = ?").run(appId, userId);
      // Links this app answered stop working with it.
      db.prepare("UPDATE ask_links SET revoked_at = COALESCE(revoked_at, ?) WHERE app_id = ? AND user_id = ?").run(now(), appId, userId);
      return;
    }
    db.prepare(
      "INSERT INTO self_apps (app_id, user_id, config, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (app_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
    ).run(appId, userId, config, now());
  });
}

export function selfAppIds(db: Db, userId: string): Set<string> {
  return new Set((db.prepare("SELECT app_id FROM self_apps WHERE user_id = ?").all(userId) as Row[]).map((r) => String(r.app_id)));
}

/** What a connected app needs to answer as the AI self: its encrypted config and the links it answers. */
export function selfForApp(db: Db, auth: AppAuth) {
  const r = db.prepare("SELECT config FROM self_apps WHERE app_id = ? AND user_id = ?").get(auth.appId, auth.userId) as Row | undefined;
  if (!r) throw new HttpError(403, "This app may not answer as the owner's AI self. The owner can allow it in their Sigil vault, under AI self.", "self_off");
  const links = (
    db.prepare("SELECT id, public_key, app_box FROM ask_links WHERE app_id = ? AND user_id = ? AND revoked_at IS NULL AND app_box IS NOT NULL").all(auth.appId, auth.userId) as Row[]
  ).map((l) => ({ id: String(l.id), publicKey: String(l.public_key), box: String(l.app_box) }));
  return { config: String(r.config), links };
}

// ---------------------------------------------------------------- links

export interface LinkInput {
  id: string;
  publicKey: string;
  intro: string;
  ownerBox: string;
  appId?: string | null;
  appBox?: string | null;
  expiresAt: string;
  maxUses: number;
  perHour: number;
}

export function createLink(db: Db, userId: string, l: LinkInput): void {
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM ask_links WHERE id = ?").get(l.id)) throw new HttpError(409, "A link with this id already exists.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM ask_links WHERE user_id = ? AND revoked_at IS NULL").get(userId) as Row;
    if (Number(n.n) >= LINKS_PER_VAULT) throw new HttpError(400, `A vault can have up to ${LINKS_PER_VAULT} active links.`);
    if (new Date(l.expiresAt).getTime() <= Date.now()) throw new HttpError(400, "The link would already be expired.");
    if (l.appId) {
      activeApp(db, userId, l.appId);
      if (!db.prepare("SELECT 1 FROM self_apps WHERE app_id = ? AND user_id = ?").get(l.appId, userId)) {
        throw new HttpError(400, "That app may not answer as your AI self. Allow it first.", "self_off");
      }
      if (!l.appBox) throw new HttpError(400, "A link answered by an app needs the key wrapped for that app.", "invalid");
    }
    db.prepare(
      `INSERT INTO ask_links (id, user_id, public_key, intro, owner_box, app_id, app_box, expires_at, max_uses, per_hour, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(l.id, userId, l.publicKey, l.intro, l.ownerBox, l.appId ?? null, l.appId ? (l.appBox ?? null) : null, new Date(l.expiresAt).toISOString(), l.maxUses, l.perHour, now());
  });
}

function online(seen: unknown, at = Date.now()): boolean {
  return seen != null && at - Number(seen) < AGENT_ONLINE_MS;
}

export function listLinks(db: Db, userId: string) {
  return (db.prepare("SELECT * FROM ask_links WHERE user_id = ? ORDER BY created_at DESC, id").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    publicKey: String(r.public_key),
    intro: String(r.intro),
    ownerBox: String(r.owner_box),
    appId: str(r.app_id),
    expiresAt: String(r.expires_at),
    maxUses: Number(r.max_uses),
    perHour: Number(r.per_hour),
    uses: Number(r.uses),
    answered: Number(r.answered),
    lastAskedAt: str(r.last_asked_at),
    online: online(r.agent_seen_at),
    createdAt: String(r.created_at),
    revokedAt: str(r.revoked_at),
  }));
}

export function revokeLink(db: Db, userId: string, linkId: string): void {
  tx(db, () => {
    const r = db.prepare("UPDATE ask_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?").run(now(), linkId, userId);
    if (r.changes === 0) throw new HttpError(404, "That link was not found.");
    db.prepare("DELETE FROM ask_questions WHERE link_id = ? AND answered_at IS NULL").run(linkId);
  });
}

export function deleteLink(db: Db, userId: string, linkId: string): void {
  const r = db.prepare("DELETE FROM ask_links WHERE id = ? AND user_id = ?").run(linkId, userId);
  if (r.changes === 0) throw new HttpError(404, "That link was not found.");
}

// ---------------------------------------------------------------- the public side of a link

export type LinkState = "active" | "expired" | "revoked" | "used_up";

function linkRow(db: Db, linkId: string): Row {
  const r = db.prepare("SELECT * FROM ask_links WHERE id = ?").get(linkId) as Row | undefined;
  if (!r) throw new HttpError(404, "This link does not exist. It may have been deleted.", "no_link");
  return r;
}

function stateOf(r: Row, at = Date.now()): LinkState {
  if (r.revoked_at) return "revoked";
  if (new Date(String(r.expires_at)).getTime() <= at) return "expired";
  if (Number(r.uses) >= Number(r.max_uses)) return "used_up";
  return "active";
}

/** What the asker's page needs: the link key (to check against its own copy), the sealed greeting, and whether anyone is there to answer. */
export function publicLink(db: Db, linkId: string) {
  const r = linkRow(db, linkId);
  const state = stateOf(r);
  return {
    id: String(r.id),
    publicKey: String(r.public_key),
    intro: String(r.intro),
    state,
    online: state === "active" && online(r.agent_seen_at),
    expiresAt: String(r.expires_at),
    remaining: Math.max(0, Number(r.max_uses) - Number(r.uses)),
  };
}

const STATE_TEXT: Record<Exclude<LinkState, "active">, string> = {
  revoked: "The owner turned this link off.",
  expired: "This link has expired.",
  used_up: "This link has been used as many times as the owner allowed.",
};

export function cleanQuestions(db: Db, at = Date.now()): void {
  db.prepare("DELETE FROM ask_questions WHERE created_at < ?").run(at - QUESTION_KEEP_MS);
}

export function askQuestion(db: Db, linkId: string, q: { id: string; sessionId: string; askerKey: string; sealed: string }, at = Date.now()): { id: string } {
  return tx(db, () => {
    cleanQuestions(db, at);
    const r = linkRow(db, linkId);
    const state = stateOf(r, at);
    if (state !== "active") throw new HttpError(410, STATE_TEXT[state], state);
    if (!online(r.agent_seen_at, at)) {
      throw new HttpError(503, "The owner's AI self is offline right now: their vault is not open and their connector is not running. Try again later.", "offline");
    }
    const hour = db.prepare("SELECT COUNT(*) AS n FROM ask_questions WHERE link_id = ? AND created_at > ?").get(linkId, at - 3600_000) as Row;
    if (Number(hour.n) >= Number(r.per_hour)) throw new HttpError(429, "This link has had as many questions as it takes in an hour. Try again later.", "link_busy");
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM ask_questions WHERE session_id = ? AND answered_at IS NULL AND created_at > ?").get(q.sessionId, at - ANSWER_WAIT_MS) as Row;
    if (Number(waiting.n) > 0) throw new HttpError(429, "Wait for the answer to your last question first.", "waiting");
    if (db.prepare("SELECT 1 FROM ask_questions WHERE id = ?").get(q.id)) throw new HttpError(409, "A question with this id already exists.");
    db.prepare("INSERT INTO ask_questions (id, link_id, user_id, session_id, asker_key, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      q.id,
      linkId,
      String(r.user_id),
      q.sessionId,
      q.askerKey,
      q.sealed,
      at,
    );
    db.prepare("UPDATE ask_links SET uses = uses + 1, last_asked_at = ? WHERE id = ?").run(new Date(at).toISOString(), linkId);
    return { id: q.id };
  });
}

export function questionStatus(db: Db, linkId: string, questionId: string, at = Date.now()): { status: "waiting" | "answered" | "gone"; answer?: string } {
  const r = db.prepare("SELECT answer, created_at FROM ask_questions WHERE id = ? AND link_id = ?").get(questionId, linkId) as Row | undefined;
  if (!r) return { status: "gone" };
  if (r.answer) return { status: "answered", answer: String(r.answer) };
  if (at - Number(r.created_at) > ANSWER_WAIT_MS) return { status: "gone" };
  return { status: "waiting" };
}

// ---------------------------------------------------------------- the owner's agent

export type Agent = { kind: "vault"; userId: string } | { kind: "app"; auth: AppAuth };

/** Marks the agent online for the links it answers, and hands it the questions waiting for them. */
export function pendingFor(db: Db, agent: Agent, at = Date.now()) {
  cleanQuestions(db, at);
  const [where, params] =
    agent.kind === "vault"
      ? ["l.user_id = ? AND l.app_id IS NULL", [agent.userId]]
      : ["l.user_id = ? AND l.app_id = ? AND EXISTS (SELECT 1 FROM self_apps s WHERE s.app_id = l.app_id)", [agent.auth.userId, agent.auth.appId]];
  db.prepare(`UPDATE ask_links AS l SET agent_seen_at = ? WHERE ${where} AND l.revoked_at IS NULL`).run(at, ...params);
  return (
    db
      .prepare(
        `SELECT q.id, q.link_id, q.session_id, q.asker_key, q.sealed, q.created_at FROM ask_questions q JOIN ask_links l ON l.id = q.link_id
         WHERE ${where} AND l.revoked_at IS NULL AND q.answered_at IS NULL AND q.created_at > ? ORDER BY q.created_at LIMIT 20`,
      )
      .all(...params, at - ANSWER_WAIT_MS) as Row[]
  ).map((r) => ({
    id: String(r.id),
    linkId: String(r.link_id),
    sessionId: String(r.session_id),
    askerKey: String(r.asker_key),
    sealed: String(r.sealed),
    createdAt: new Date(Number(r.created_at)).toISOString(),
  }));
}

/** Stores the answer for the asker and writes the question and answer, sealed, to the owner's log. */
export function answerQuestion(db: Db, agent: Agent, questionId: string, a: { sealed: string; note: string; cited: number }, at = new Date()): void {
  tx(db, () => {
    const userId = agent.kind === "vault" ? agent.userId : agent.auth.userId;
    const r = db
      .prepare("SELECT q.answered_at, q.link_id, l.app_id FROM ask_questions q JOIN ask_links l ON l.id = q.link_id WHERE q.id = ? AND q.user_id = ?")
      .get(questionId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That question was not found. It may have expired.", "no_question");
    const mine = agent.kind === "vault" ? r.app_id == null : r.app_id === agent.auth.appId;
    if (!mine) throw new HttpError(403, "This question is for another of the owner's agents.", "not_yours");
    if (r.answered_at) throw new HttpError(409, "That question was already answered.", "answered");
    db.prepare("UPDATE ask_questions SET answer = ?, answered_at = ? WHERE id = ?").run(a.sealed, at.getTime(), questionId);
    db.prepare("UPDATE ask_links SET answered = answered + 1 WHERE id = ?").run(String(r.link_id));
    logRead(db, { appId: String(r.link_id), userId }, "ask", questionId, a.cited, at, a.note);
  });
}

/** The ask_self tool of a connected app: the answer was made on the owner's machine; only its sealed note is logged here. */
export function logSelfAnswer(db: Db, auth: AppAuth, ref: string, note: string, cited: number, at = new Date()): void {
  if (!db.prepare("SELECT 1 FROM self_apps WHERE app_id = ? AND user_id = ?").get(auth.appId, auth.userId)) {
    throw new HttpError(403, "This app may not answer as the owner's AI self.", "self_off");
  }
  logRead(db, auth, "ask", ref, cited, at, note);
}
