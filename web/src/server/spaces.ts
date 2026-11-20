// Team spaces on the server. A space holds its name and memories as envelopes
// under the space key, and one row per member with the key sealed to that
// member, its role and a tag only key holders can make. The server enforces
// roles; it never holds the space key.

import type { StoredMemory } from "@sigil/core";
import { MAX_SPACE_MEMBERS, type SpaceRole } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";
import { getBoxKey, userByBoxKey } from "./inbox";
import { agentOf } from "./agents";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

export const SPACES_PER_VAULT = 50;
export const SPACE_MEMORY_LIMIT = 5000;

export type Actor = { kind: "vault"; userId: string } | { kind: "agent"; auth: AppAuth };

export interface MemberRow {
  id: string;
  spaceId: string;
  kind: "vault" | "agent";
  userId: string;
  appId: string | null;
  publicKey: string;
  role: SpaceRole;
  sealedKey: string;
  tag: string;
  label: string;
  createdAt: string;
  acceptedAt: string | null;
}

function toMember(r: Row): MemberRow {
  return {
    id: String(r.id),
    spaceId: String(r.space_id),
    kind: r.kind === "agent" ? "agent" : "vault",
    userId: String(r.user_id),
    appId: str(r.app_id),
    publicKey: String(r.public_key),
    role: r.role as SpaceRole,
    sealedKey: String(r.sealed_key),
    tag: String(r.tag),
    label: String(r.label),
    createdAt: String(r.created_at),
    acceptedAt: str(r.accepted_at),
  };
}

function spaceRow(db: Db, spaceId: string): Row {
  const r = db.prepare("SELECT * FROM spaces WHERE id = ?").get(spaceId) as Row | undefined;
  if (!r) throw new HttpError(404, "That space was not found.", "no_space");
  return r;
}

export function memberFor(db: Db, spaceId: string, actor: Actor): MemberRow | null {
  const r =
    actor.kind === "vault"
      ? (db.prepare("SELECT * FROM space_members WHERE space_id = ? AND kind = 'vault' AND user_id = ?").get(spaceId, actor.userId) as Row | undefined)
      : (db.prepare("SELECT * FROM space_members WHERE space_id = ? AND kind = 'agent' AND app_id = ?").get(spaceId, actor.auth.appId) as Row | undefined);
  return r ? toMember(r) : null;
}

function need(db: Db, spaceId: string, actor: Actor, role: "read" | "write" | "admin"): MemberRow {
  spaceRow(db, spaceId);
  const m = memberFor(db, spaceId, actor);
  if (!m) throw new HttpError(403, "You are not a member of this space.", "not_member");
  if (!m.acceptedAt && actor.kind === "vault") throw new HttpError(403, "Accept the space first.", "not_accepted");
  const rank = { read: 0, write: 1, admin: 2 } as const;
  if (rank[m.role] < rank[role]) throw new HttpError(403, role === "admin" ? "Only an admin of this space may do that." : "Your role in this space is read only.", "role");
  return m;
}

function logAgent(db: Db, actor: Actor, spaceId: string, step: string, count = 1): void {
  if (actor.kind === "agent") logRead(db, actor.auth, "space", `${step}-${spaceId}`, count);
}

export interface NewMember {
  id: string;
  kind: "vault" | "agent";
  publicKey: string;
  role: SpaceRole;
  sealedKey: string;
  tag: string;
  label: string;
  appId?: string | null;
}

export function createSpace(db: Db, userId: string, s: { id: string; meta: string; member: NewMember }): void {
  tx(db, () => {
    if (db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(s.id)) throw new HttpError(409, "A space with this id already exists.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE user_id = ? AND kind = 'vault'").get(userId) as Row;
    if (Number(n.n) >= SPACES_PER_VAULT) throw new HttpError(400, `A vault can be in up to ${SPACES_PER_VAULT} spaces.`);
    if (s.member.kind !== "vault" || s.member.role !== "admin") throw new HttpError(400, "A space is made by a vault, as its first admin.", "invalid");
    if (getBoxKey(db, userId)?.publicKey !== s.member.publicKey) throw new HttpError(400, "A space is sealed first to your own vault key.", "invalid");
    const at = now();
    db.prepare("INSERT INTO spaces (id, created_by, meta, epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(s.id, userId, s.meta, at, at);
    insertMember(db, s.id, userId, null, s.member, null, at, at);
    // The vault's own sealed record of joining: a proof of membership can rest on it.
    logRead(db, { appId: "vault", userId }, "space", `joined-${s.id}`, 1);
  });
}

function insertMember(db: Db, spaceId: string, userId: string, appId: string | null, m: NewMember, addedBy: string | null, at: string, acceptedAt: string | null): void {
  if (db.prepare("SELECT 1 FROM space_members WHERE id = ?").get(m.id)) throw new HttpError(409, "A member with this id already exists.");
  if (db.prepare("SELECT 1 FROM space_members WHERE space_id = ? AND public_key = ?").get(spaceId, m.publicKey)) throw new HttpError(409, "That vault or agent is already in this space.", "already_member");
  db.prepare(
    "INSERT INTO space_members (id, space_id, kind, user_id, app_id, public_key, role, sealed_key, tag, label, added_by, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(m.id, spaceId, m.kind, userId, appId, m.publicKey, m.role, m.sealedKey, m.tag, m.label, addedBy, at, acceptedAt);
}

/**
 * Adds a member. An admin may add anyone with any role. A member who may write
 * may add an agent of their own, to read or write, so their agents can work
 * alongside them.
 */
export function addMember(db: Db, userId: string, spaceId: string, m: NewMember): void {
  tx(db, () => {
    const me = need(db, spaceId, { kind: "vault", userId }, "write");
    const n = db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?").get(spaceId) as Row;
    if (Number(n.n) >= MAX_SPACE_MEMBERS) throw new HttpError(400, `A space has up to ${MAX_SPACE_MEMBERS} members.`);
    const at = now();
    if (m.kind === "vault") {
      if (me.role !== "admin") throw new HttpError(403, "Only an admin of this space may add people.", "role");
      const recipient = userByBoxKey(db, m.publicKey);
      if (!recipient) throw new HttpError(404, "No vault has this code. Ask for the code again.", "unknown_vault");
      insertMember(db, spaceId, recipient, null, m, me.id, at, null);
      return;
    }
    const agent = m.appId ? agentOf(db, m.appId) : null;
    const app = m.appId ? (db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(m.appId, userId) as Row | undefined) : undefined;
    if (!agent || agent.userId !== userId || !app || app.revoked_at) throw new HttpError(404, "That agent was not found in your vault.", "no_agent");
    if (agent.publicKey !== m.publicKey) throw new HttpError(400, "That is not the agent's key.", "invalid");
    if (me.role !== "admin" && m.role === "admin") throw new HttpError(403, "Only an admin may make another admin.", "role");
    insertMember(db, spaceId, userId, agent.appId, m, me.id, at, at);
    logRead(db, { appId: agent.appId, userId }, "space", `joined-${spaceId}`, 1);
  });
}

export function acceptSpace(db: Db, userId: string, spaceId: string): void {
  tx(db, () => {
    const was = db.prepare("SELECT accepted_at FROM space_members WHERE space_id = ? AND kind = 'vault' AND user_id = ?").get(spaceId, userId) as Row | undefined;
    if (!was) throw new HttpError(404, "That space was not found. You may have been removed from it.", "no_space");
    if (was.accepted_at) return;
    db.prepare("UPDATE space_members SET accepted_at = ? WHERE space_id = ? AND kind = 'vault' AND user_id = ?").run(now(), spaceId, userId);
    // The vault's own sealed record of joining: a proof of membership can rest on it.
    logRead(db, { appId: "vault", userId }, "space", `joined-${spaceId}`, 1);
  });
}

export function setRole(db: Db, userId: string, spaceId: string, memberId: string, role: SpaceRole, tag: string): void {
  tx(db, () => {
    need(db, spaceId, { kind: "vault", userId }, "admin");
    const m = db.prepare("SELECT kind, role FROM space_members WHERE id = ? AND space_id = ?").get(memberId, spaceId) as Row | undefined;
    if (!m) throw new HttpError(404, "That member was not found.");
    if (m.kind === "agent" && role === "admin") throw new HttpError(400, "An agent can read or write, not be an admin.", "invalid");
    if (m.role === "admin" && role !== "admin") {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE space_id = ? AND role = 'admin'").get(spaceId) as Row;
      if (Number(admins.n) <= 1) throw new HttpError(400, "A space keeps at least one admin.", "last_admin");
    }
    db.prepare("UPDATE space_members SET role = ?, tag = ? WHERE id = ?").run(role, tag, memberId);
  });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/**
 * Removes members by giving the space a new key, made on an admin's device. It
 * must cover every memory and every member who stays, or nothing changes.
 */
export function rotateSpace(
  db: Db,
  userId: string,
  spaceId: string,
  r: { epoch: number; meta: string; memories: StoredMemory[]; members: { id: string; sealedKey: string; tag: string; label: string }[]; remove: string[] },
): void {
  tx(db, () => {
    const me = need(db, spaceId, { kind: "vault", userId }, "admin");
    const s = spaceRow(db, spaceId);
    const stale = () => new HttpError(409, "The space changed while its new key was being made. Reload and try again.", "stale");
    if (r.epoch !== Number(s.epoch) + 1) throw stale();
    const memIds = (db.prepare("SELECT id FROM space_memories WHERE space_id = ?").all(spaceId) as Row[]).map((x) => String(x.id));
    if (!sameSet(r.memories.map((m) => m.id), memIds)) throw stale();
    const memberIds = (db.prepare("SELECT id FROM space_members WHERE space_id = ?").all(spaceId) as Row[]).map((x) => String(x.id));
    if (!sameSet([...r.members.map((m) => m.id), ...r.remove], memberIds)) throw stale();
    if (r.remove.includes(me.id)) throw new HttpError(400, "Hand the space to another admin before you leave it.", "invalid");
    const at = now();
    db.prepare("UPDATE spaces SET meta = ?, epoch = ?, updated_at = ? WHERE id = ?").run(r.meta, r.epoch, at, spaceId);
    const mem = db.prepare("UPDATE space_memories SET head = ?, body = ?, size = ? WHERE id = ? AND space_id = ?");
    for (const m of r.memories) mem.run(m.head, m.body!, m.head.length + m.body!.length, m.id, spaceId);
    const upd = db.prepare("UPDATE space_members SET sealed_key = ?, tag = ?, label = ? WHERE id = ? AND space_id = ?");
    for (const m of r.members) upd.run(m.sealedKey, m.tag, m.label, m.id, spaceId);
    const agents = db.prepare("SELECT app_id, user_id FROM space_members WHERE id = ? AND kind = 'agent'");
    const del = db.prepare("DELETE FROM space_members WHERE id = ? AND space_id = ?");
    for (const id of r.remove) {
      const a = agents.get(id) as Row | undefined;
      if (a?.app_id) logRead(db, { appId: String(a.app_id), userId: String(a.user_id) }, "space", `removed-${spaceId}`, 1);
      del.run(id, spaceId);
    }
    if (!db.prepare("SELECT 1 FROM space_members WHERE space_id = ? AND role = 'admin'").get(spaceId)) throw new HttpError(400, "A space keeps at least one admin.", "last_admin");
    const orphan = db
      .prepare("SELECT 1 FROM space_members a WHERE a.space_id = ? AND a.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM space_members v WHERE v.space_id = a.space_id AND v.kind = 'vault' AND v.user_id = a.user_id)")
      .get(spaceId);
    if (orphan) throw new HttpError(400, "Remove the agents of a vault together with that vault.", "invalid");
  });
}

export function deleteSpace(db: Db, userId: string, spaceId: string): void {
  tx(db, () => {
    need(db, spaceId, { kind: "vault", userId }, "admin");
    db.prepare("DELETE FROM handoffs WHERE space_id = ?").run(spaceId);
    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
  });
}

/** A member who may write adds or changes memories, encrypted on their device with the space key. */
export function putSpaceMemories(db: Db, actor: Actor, spaceId: string, memories: StoredMemory[]): number {
  return tx(db, () => {
    const me = need(db, spaceId, actor, "write");
    const n = db.prepare("SELECT COUNT(*) AS n FROM space_memories WHERE space_id = ?").get(spaceId) as Row;
    const elsewhere = db.prepare("SELECT space_id FROM space_memories WHERE id = ?");
    const upsert = db.prepare(`INSERT INTO space_memories (id, space_id, head, body, size, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET head = excluded.head, body = excluded.body, size = excluded.size, author = excluded.author, updated_at = excluded.updated_at`);
    let added = 0;
    const at = now();
    for (const m of memories) {
      if (m.folderId !== spaceId || !m.body) throw new HttpError(400, "A memory points at another space.", "invalid");
      const e = elsewhere.get(m.id) as Row | undefined;
      if (e && String(e.space_id) !== spaceId) throw new HttpError(409, "A memory with this id already exists elsewhere.");
      if (!e) added++;
      upsert.run(m.id, spaceId, m.head, m.body, m.head.length + m.body.length, me.id, at, at);
    }
    if (Number(n.n) + added > SPACE_MEMORY_LIMIT) throw new HttpError(400, `A space holds up to ${SPACE_MEMORY_LIMIT} memories.`);
    db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(at, spaceId);
    logAgent(db, actor, spaceId, "wrote", memories.length);
    return memories.length;
  });
}

export function deleteSpaceMemories(db: Db, actor: Actor, spaceId: string, ids: string[]): number {
  return tx(db, () => {
    need(db, spaceId, actor, "write");
    const del = db.prepare("DELETE FROM space_memories WHERE id = ? AND space_id = ?");
    let n = 0;
    for (const id of ids) n += Number(del.run(id, spaceId).changes);
    logAgent(db, actor, spaceId, "forgot", n);
    return n;
  });
}

function spaceView(db: Db, spaceId: string, me: MemberRow) {
  const s = spaceRow(db, spaceId);
  const members = (db.prepare("SELECT * FROM space_members WHERE space_id = ? ORDER BY created_at, id").all(spaceId) as Row[]).map(toMember);
  const readable = me.acceptedAt != null;
  const memories = readable
    ? (db.prepare("SELECT id, head, body, author, updated_at FROM space_memories WHERE space_id = ? ORDER BY updated_at DESC, id").all(spaceId) as Row[]).map((m) => ({
        id: String(m.id),
        folderId: spaceId,
        head: String(m.head),
        body: String(m.body),
        author: str(m.author),
        updatedAt: String(m.updated_at),
      }))
    : [];
  return {
    id: spaceId,
    meta: String(s.meta),
    epoch: Number(s.epoch),
    me: { id: me.id, role: me.role, sealedKey: me.sealedKey, acceptedAt: me.acceptedAt },
    members: members.map((m) => ({
      id: m.id,
      kind: m.kind,
      appId: m.userId === me.userId ? m.appId : null,
      publicKey: m.publicKey,
      role: m.role,
      tag: m.tag,
      label: m.label,
      acceptedAt: m.acceptedAt,
      // For an agent, the member id of the vault it belongs to.
      owner: m.kind === "agent" ? (members.find((v) => v.kind === "vault" && v.userId === m.userId)?.id ?? null) : null,
    })),
    memories,
  };
}

/** Every space this vault is a member of, with its members and, once accepted, its memories. */
export function vaultSpaces(db: Db, userId: string) {
  const mine = (db.prepare("SELECT * FROM space_members WHERE kind = 'vault' AND user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toMember);
  return mine.map((m) => spaceView(db, m.spaceId, m));
}

/** The spaces an agent is in, read through the connector. Each read is in its owner's log. */
export function agentSpaces(db: Db, auth: AppAuth) {
  const mine = (db.prepare("SELECT * FROM space_members WHERE kind = 'agent' AND app_id = ? ORDER BY created_at").all(auth.appId) as Row[]).map(toMember);
  const out = mine.map((m) => spaceView(db, m.spaceId, m));
  for (const s of out) logRead(db, auth, "space", `read-${s.id}`, s.memories.length);
  return out;
}

export function agentSpaceIds(db: Db, appId: string): string[] {
  return (db.prepare("SELECT space_id FROM space_members WHERE kind = 'agent' AND app_id = ?").all(appId) as Row[]).map((r) => String(r.space_id));
}
