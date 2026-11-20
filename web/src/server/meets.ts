// Selves meet selves on the server: an invite from one vault to another (by
// the public key in the other's vault code), the answer, and the turns. The
// server sees whose turn it is, how many turns are left, and boxes it cannot
// open: the invite and the answer are sealed to the other vault, every turn is
// encrypted under a key only the two vaults can derive. Either side can stop
// it. Every step goes into both owners' read logs, and so into both seals.

import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { HttpError, logRead } from "./store";
import { userByBoxKey } from "./inbox";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const MEET_MAX_TURNS = 12;
export const INVITES_PER_HOUR = 10;
export type MeetState = "invited" | "running" | "done" | "stopped" | "declined";

export interface MeetView {
  id: string;
  role: "inviter" | "invitee";
  myKey: string;
  peerKey: string;
  turnLimit: number;
  invite: string;
  answer: string | null;
  /** This side's own record, under its vault key. */
  box: string | null;
  state: MeetState;
  turns: number;
  stoppedBy: "me" | "peer" | null;
  /** Whether the other side's vault checked in a moment ago. */
  peerOnline: boolean;
  peerSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { turn: number; box: string; createdAt: string }[];
}

function online(seen: unknown, at = Date.now()): boolean {
  return seen != null && at - Number(seen) < serverConfig.agentOnlineMs;
}

function view(db: Db, r: Row, userId: string): MeetView {
  const role = String(r.inviter_id) === userId ? "inviter" : "invitee";
  const peerSeen = role === "inviter" ? r.invitee_seen_at : r.inviter_seen_at;
  return {
    id: String(r.id),
    role,
    myKey: String(role === "inviter" ? r.inviter_key : r.invitee_key),
    peerKey: String(role === "inviter" ? r.invitee_key : r.inviter_key),
    turnLimit: Number(r.turn_limit),
    invite: String(r.invite),
    answer: r.answer == null ? null : String(r.answer),
    box: (role === "inviter" ? r.inviter_box : r.invitee_box) == null ? null : String(role === "inviter" ? r.inviter_box : r.invitee_box),
    state: r.state as MeetState,
    turns: Number(r.turns),
    stoppedBy: r.stopped_by == null ? null : String(r.stopped_by) === userId ? "me" : "peer",
    peerOnline: online(peerSeen),
    peerSeenAt: peerSeen == null ? null : new Date(Number(peerSeen)).toISOString(),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    messages: (db.prepare("SELECT turn, box, created_at FROM meet_messages WHERE meet_id = ? ORDER BY turn").all(String(r.id)) as Row[]).map((m) => ({
      turn: Number(m.turn),
      box: String(m.box),
      createdAt: String(m.created_at),
    })),
  };
}

function mine(db: Db, userId: string, meetId: string): Row {
  const r = db.prepare("SELECT * FROM meets WHERE id = ? AND (inviter_id = ? OR invitee_id = ?)").get(meetId, userId, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That conversation was not found.", "no_meet");
  return r;
}

function logBoth(db: Db, r: Row, step: string, count = 0, at = new Date()): void {
  for (const userId of [String(r.inviter_id), String(r.invitee_id)]) logRead(db, { appId: String(r.id), userId }, "meet", step, count, at);
}

export function listMeets(db: Db, userId: string): MeetView[] {
  return (
    db
      .prepare("SELECT * FROM meets WHERE (inviter_id = ? AND inviter_removed = 0) OR (invitee_id = ? AND invitee_removed = 0) ORDER BY created_at DESC LIMIT 100")
      .all(userId, userId) as Row[]
  ).map((r) => view(db, r, userId));
}

export interface InviteInput {
  id: string;
  /** The other vault's public key, from the vault code its owner gave. */
  toKey: string;
  invite: string;
  box: string;
  turnLimit: number;
}

export function invite(db: Db, userId: string, input: InviteInput, at = new Date()): MeetView {
  return tx(db, () => {
    const me = db.prepare("SELECT public_key FROM box_keys WHERE user_id = ?").get(userId) as Row | undefined;
    if (!me) throw new HttpError(409, "Your vault has no public key yet. Reload it and try again.", "no_box");
    const peer = userByBoxKey(db, input.toKey);
    if (!peer) throw new HttpError(404, "No vault on this site has that vault code.", "no_vault");
    if (peer === userId) throw new HttpError(400, "That is your own vault code.", "self");
    if (db.prepare("SELECT 1 FROM meets WHERE id = ?").get(input.id)) throw new HttpError(409, "A conversation with this id already exists.");
    const recent = db.prepare("SELECT COUNT(*) AS n FROM meets WHERE inviter_id = ? AND created_at > ?").get(userId, new Date(at.getTime() - 3600_000).toISOString()) as Row;
    if (Number(recent.n) >= INVITES_PER_HOUR) throw new HttpError(429, `A vault may send ${INVITES_PER_HOUR} invites an hour.`, "invite_limit");
    const open = db.prepare("SELECT 1 FROM meets WHERE inviter_id = ? AND invitee_id = ? AND state IN ('invited', 'running')").get(userId, peer);
    if (open) throw new HttpError(409, "There is already an open conversation with that vault. Stop it first.", "open_meet");
    const t = at.toISOString();
    db.prepare(
      `INSERT INTO meets (id, inviter_id, invitee_id, inviter_key, invitee_key, turn_limit, invite, inviter_box, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)`,
    ).run(input.id, userId, peer, String(me.public_key), input.toKey, Math.min(Math.max(input.turnLimit, 2), MEET_MAX_TURNS), input.invite, input.box, t, t);
    const r = mine(db, userId, input.id);
    logBoth(db, r, "invited", 0, at);
    return view(db, r, userId);
  });
}

export function acceptMeet(db: Db, userId: string, meetId: string, input: { answer: string; box: string }, at = new Date()): MeetView {
  return tx(db, () => {
    const r = mine(db, userId, meetId);
    if (String(r.invitee_id) !== userId) throw new HttpError(403, "Only the vault that was invited can accept.", "not_invitee");
    if (r.state !== "invited") throw new HttpError(409, "This invite was already answered.", "answered");
    db.prepare("UPDATE meets SET answer = ?, invitee_box = ?, state = 'running', updated_at = ? WHERE id = ?").run(input.answer, input.box, at.toISOString(), meetId);
    logBoth(db, r, "accepted", 0, at);
    return view(db, mine(db, userId, meetId), userId);
  });
}

export function declineMeet(db: Db, userId: string, meetId: string, at = new Date()): void {
  tx(db, () => {
    const r = mine(db, userId, meetId);
    if (String(r.invitee_id) !== userId) throw new HttpError(403, "Only the vault that was invited can decline.", "not_invitee");
    if (r.state !== "invited") throw new HttpError(409, "This invite was already answered.", "answered");
    db.prepare("UPDATE meets SET state = 'declined', updated_at = ? WHERE id = ?").run(at.toISOString(), meetId);
    logBoth(db, r, "declined", 0, at);
  });
}

/** Either side can stop it at any time; nothing more can be said after. */
export function stopMeet(db: Db, userId: string, meetId: string, at = new Date()): void {
  tx(db, () => {
    const r = mine(db, userId, meetId);
    if (r.state !== "invited" && r.state !== "running") throw new HttpError(409, "This conversation is already over.", "over");
    db.prepare("UPDATE meets SET state = 'stopped', stopped_by = ?, updated_at = ? WHERE id = ?").run(userId, at.toISOString(), meetId);
    logBoth(db, r, "stopped", Number(r.turns), at);
  });
}

/** Marks this vault as here for its conversations, and says which wait for its turn. */
export function meetsWaiting(db: Db, userId: string, at = Date.now()): MeetView[] {
  db.prepare("UPDATE meets SET inviter_seen_at = ? WHERE inviter_id = ? AND state IN ('invited', 'running')").run(at, userId);
  db.prepare("UPDATE meets SET invitee_seen_at = ? WHERE invitee_id = ? AND state IN ('invited', 'running')").run(at, userId);
  return (db.prepare("SELECT * FROM meets WHERE (inviter_id = ? OR invitee_id = ?) AND state = 'running'").all(userId, userId) as Row[])
    .map((r) => view(db, r, userId))
    .filter((m) => (m.turns % 2 === 0 ? "inviter" : "invitee") === m.role);
}

/** One turn: only from the side whose turn it is, in order, within the limit. The last turn, or one marked done, ends it. */
export function addTurn(db: Db, userId: string, meetId: string, input: { turn: number; box: string; done: boolean; cited: number }, at = new Date()): MeetView {
  return tx(db, () => {
    const r = mine(db, userId, meetId);
    if (r.state !== "running") throw new HttpError(409, r.state === "invited" ? "The other vault has not said yes yet." : "This conversation is over.", "not_running");
    const turns = Number(r.turns);
    if (input.turn !== turns + 1) throw new HttpError(409, "That is not the next turn.", "turn");
    const writer = input.turn % 2 === 1 ? String(r.inviter_id) : String(r.invitee_id);
    if (writer !== userId) throw new HttpError(409, "It is the other side's turn.", "not_your_turn");
    if (input.turn > Number(r.turn_limit)) throw new HttpError(409, "The turn limit was reached.", "limit");
    db.prepare("INSERT INTO meet_messages (meet_id, turn, box, created_at) VALUES (?, ?, ?, ?)").run(meetId, input.turn, input.box, at.toISOString());
    const done = input.done || input.turn >= Number(r.turn_limit);
    db.prepare("UPDATE meets SET turns = ?, state = ?, updated_at = ? WHERE id = ?").run(input.turn, done ? "done" : "running", at.toISOString(), meetId);
    logBoth(db, r, `turn-${input.turn}`, 0, at);
    if (done) logBoth(db, r, "done", input.turn, at);
    // The sources this side used are counted in its own log only.
    if (input.cited) logRead(db, { appId: meetId, userId }, "meet", `used-${input.turn}`, input.cited, at);
    return view(db, mine(db, userId, meetId), userId);
  });
}

/** The owner removes a finished conversation from their list. The other side keeps theirs until they remove it too; then it is deleted. */
export function removeMeet(db: Db, userId: string, meetId: string): void {
  tx(db, () => {
    const r = mine(db, userId, meetId);
    if (r.state === "invited" || r.state === "running") throw new HttpError(409, "Stop the conversation before removing it.", "open_meet");
    const role = String(r.inviter_id) === userId ? "inviter" : "invitee";
    db.prepare(`UPDATE meets SET ${role}_removed = 1, updated_at = ? WHERE id = ?`).run(now(), meetId);
    db.prepare("DELETE FROM meets WHERE id = ? AND inviter_removed = 1 AND invitee_removed = 1").run(meetId);
  });
}
