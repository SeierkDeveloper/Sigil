// Agents get their own memory: an agent is a connected app with an agent
// record. The record says which folder is its own, which tools it may use, and
// carries the public half of the key pair derived from its secret. Grants say
// per folder whether it may write. The server enforces both on every call and
// writes every call to the owner's read log.

import type { StoredApp, StoredFolder, StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead, putMemoriesIn, type AppAuth } from "./store";
import { AGENT_WRITES, tierOf } from "./holders";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export type AgentTool = "remember" | "recall" | "forget" | "handoff";

export interface AgentRulesInput {
  remember: boolean;
  recall: boolean;
  forget: boolean;
  handoff: boolean;
}

export interface AgentRow {
  appId: string;
  userId: string;
  homeFolderId: string;
  rules: AgentRulesInput;
  publicKey: string;
  createdAt: string;
}

function toAgent(r: Row): AgentRow {
  return {
    appId: String(r.app_id),
    userId: String(r.user_id),
    homeFolderId: String(r.home_folder_id),
    rules: { remember: Number(r.may_remember) === 1, recall: Number(r.may_recall) === 1, forget: Number(r.may_forget) === 1, handoff: Number(r.may_handoff) === 1 },
    publicKey: String(r.public_key),
    createdAt: String(r.created_at),
  };
}

export function agentOf(db: Db, appId: string): AgentRow | null {
  const r = db.prepare("SELECT * FROM agents WHERE app_id = ?").get(appId) as Row | undefined;
  return r ? toAgent(r) : null;
}

export function listAgents(db: Db, userId: string): AgentRow[] {
  return (db.prepare("SELECT * FROM agents WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toAgent);
}

/**
 * Makes an agent in one step: its own folder, the app with its key hash and
 * grants (its own folder always writable), and the agent record.
 */
export function createAgent(db: Db, userId: string, input: { app: StoredApp; folder: StoredFolder; rules: AgentRulesInput; publicKey: string }): void {
  tx(db, () => {
    const { app, folder } = input;
    if (db.prepare("SELECT 1 FROM apps WHERE id = ?").get(app.id)) throw new HttpError(409, "An app with this id already exists.");
    if (db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?").get(userId, folder.id)) throw new HttpError(409, "A folder with this id already exists.");
    if (db.prepare("SELECT 1 FROM agents WHERE public_key = ?").get(input.publicKey)) throw new HttpError(409, "That agent key is already in use.");
    const active = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE user_id = ? AND revoked_at IS NULL").get(userId) as Row;
    if (Number(active.n) >= 50) throw new HttpError(400, "A vault can connect up to 50 apps and agents at once.");
    const folders = db.prepare("SELECT COUNT(*) AS n FROM folders WHERE user_id = ?").get(userId) as Row;
    if (Number(folders.n) >= 200) throw new HttpError(400, "A vault can hold up to 200 folders.");
    if (!app.grants.some((g) => g.folderId === folder.id && g.mode === "write")) throw new HttpError(400, "An agent may always write its own folder.", "invalid");
    const at = now();
    db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, folder.id, folder.meta, folder.wrappedKey, at, at);
    db.prepare("INSERT INTO apps (id, user_id, meta, secret, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(app.id, userId, app.meta, app.secret, app.tokenHash, at);
    writeAgentGrants(db, userId, app.id, folder.id, app.grants);
    const r = input.rules;
    db.prepare(
      "INSERT INTO agents (app_id, user_id, home_folder_id, may_remember, may_recall, may_forget, may_handoff, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(app.id, userId, folder.id, r.remember ? 1 : 0, r.recall ? 1 : 0, r.forget ? 1 : 0, r.handoff ? 1 : 0, input.publicKey, at);
  });
}

function writeAgentGrants(db: Db, userId: string, appId: string, home: string, grants: { folderId: string; wrappedKey: string; mode?: "read" | "write" }[]): void {
  db.prepare("DELETE FROM grants WHERE app_id = ?").run(appId);
  const folderOk = db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?");
  const ins = db.prepare("INSERT INTO grants (app_id, user_id, folder_id, wrapped_key, created_at, mode) VALUES (?, ?, ?, ?, ?, ?)");
  const at = now();
  for (const g of grants) {
    if (!folderOk.get(userId, g.folderId)) throw new HttpError(400, "A permission points at a folder that does not exist.");
    ins.run(appId, userId, g.folderId, g.wrappedKey, at, g.folderId === home || g.mode === "write" ? "write" : "read");
  }
  if (!grants.some((g) => g.folderId === home)) throw new HttpError(400, "An agent keeps its own folder.", "invalid");
}

export function updateAgent(db: Db, userId: string, appId: string, input: { rules: AgentRulesInput; grants: { folderId: string; wrappedKey: string; mode?: "read" | "write" }[] }): void {
  tx(db, () => {
    const a = agentOf(db, appId);
    const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
    if (!a || a.userId !== userId || !app) throw new HttpError(404, "That agent was not found.");
    if (app.revoked_at) throw new HttpError(400, "This agent was revoked. Make a new one to give it access.");
    writeAgentGrants(db, userId, appId, a.homeFolderId, input.grants);
    const r = input.rules;
    db.prepare("UPDATE agents SET may_remember = ?, may_recall = ?, may_forget = ?, may_handoff = ? WHERE app_id = ?").run(r.remember ? 1 : 0, r.recall ? 1 : 0, r.forget ? 1 : 0, r.handoff ? 1 : 0, appId);
  });
}

// ---------------------------------------------------------------- what the connector may do

const TOOL_TEXT: Record<AgentTool, string> = {
  remember: "This agent may not remember things in the vault. The owner can allow it under Agents.",
  recall: "This agent may not recall memories. The owner can allow it under Agents.",
  forget: "This agent may not forget memories. The owner can allow it under Agents.",
  handoff: "This agent may not leave or pick up handoff notes. The owner can allow it under Agents.",
};

/** For an agent, the tool must be allowed. Apps that are not agents only read, as before. */
export function assertTool(db: Db, auth: AppAuth, tool: AgentTool): AgentRow | null {
  const a = agentOf(db, auth.appId);
  if (!a) {
    if (tool === "recall") return null;
    throw new HttpError(403, "This app key is not an agent. Agents are made in the vault under Agents.", "not_agent");
  }
  if (!a.rules[tool]) throw new HttpError(403, TOOL_TEXT[tool], `${tool}_off`);
  return a;
}

export function agentProfile(db: Db, auth: AppAuth) {
  const a = agentOf(db, auth.appId);
  if (!a) throw new HttpError(403, "This app key is not an agent. Agents are made in the vault under Agents.", "not_agent");
  const writable = (db.prepare("SELECT folder_id FROM grants WHERE app_id = ? AND mode = 'write'").all(auth.appId) as Row[]).map((r) => String(r.folder_id));
  return { appId: a.appId, homeFolderId: a.homeFolderId, rules: a.rules, writable, publicKey: a.publicKey };
}

function writableFolder(db: Db, auth: AppAuth, folderId: string): boolean {
  return !!db.prepare("SELECT 1 FROM grants WHERE app_id = ? AND user_id = ? AND folder_id = ? AND mode = 'write'").get(auth.appId, auth.userId, folderId);
}

export const AGENT_WRITES_PER_HOUR = 300;

/** remember: memories encrypted in the connector with a folder key the agent may write. */
export function agentRemember(db: Db, auth: AppAuth, memories: StoredMemory[], at = new Date()): number {
  return tx(db, () => {
    assertTool(db, auth, "remember");
    const recent = db.prepare("SELECT COUNT(*) AS n FROM read_log WHERE app_id = ? AND kind = 'remember' AND at > ?").get(auth.appId, new Date(at.getTime() - 3600_000).toISOString()) as Row;
    // Holders' agents may write more: 1,000 / 3,000 / 10,000 an hour by tier.
    const limit = AGENT_WRITES[tierOf(db, auth.userId) ?? "none"];
    if (Number(recent.n) + memories.length > limit) throw new HttpError(429, `An agent may write ${limit} memories an hour.`, "remember_limit");
    const existing = db.prepare("SELECT folder_id FROM memories WHERE user_id = ? AND id = ?");
    for (const m of memories) {
      if (!writableFolder(db, auth, m.folderId)) throw new HttpError(403, "This agent may not write that folder.", "read_only");
      const e = existing.get(auth.userId, m.id) as Row | undefined;
      if (e && !writableFolder(db, auth, String(e.folder_id))) throw new HttpError(403, "This agent may not change that memory.", "read_only");
    }
    putMemoriesIn(db, auth.userId, memories);
    for (const m of memories) logRead(db, auth, "remember", m.id, 1, at);
    return memories.length;
  });
}

/** forget: deletes memories for real, only in folders the agent may write. */
export function agentForget(db: Db, auth: AppAuth, ids: string[], at = new Date()): { deleted: string[]; refused: string[] } {
  return tx(db, () => {
    assertTool(db, auth, "forget");
    const find = db.prepare("SELECT folder_id FROM memories WHERE user_id = ? AND id = ?");
    const del = db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?");
    const deleted: string[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const m = find.get(auth.userId, id) as Row | undefined;
      if (!m || !writableFolder(db, auth, String(m.folder_id))) {
        refused.push(id);
        continue;
      }
      del.run(auth.userId, id);
      deleted.push(id);
      logRead(db, auth, "forget", id, 1, at);
    }
    return { deleted, refused };
  });
}

// ---------------------------------------------------------------- handoff notes

export function leaveHandoff(db: Db, auth: AppAuth, h: { id: string; sealed: string; spaceId: string | null }, spaceMember: (spaceId: string) => boolean): void {
  tx(db, () => {
    assertTool(db, auth, "handoff");
    if (h.spaceId && !spaceMember(h.spaceId)) throw new HttpError(403, "This agent is not in that space.", "not_member");
    if (db.prepare("SELECT 1 FROM handoffs WHERE id = ?").get(h.id)) throw new HttpError(409, "A note with this id already exists.");
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE from_app = ?").get(auth.appId) as Row;
    if (Number(waiting.n) >= 500) db.prepare("DELETE FROM handoffs WHERE id IN (SELECT id FROM handoffs WHERE from_app = ? ORDER BY created_at LIMIT 100)").run(auth.appId);
    db.prepare("INSERT INTO handoffs (id, user_id, from_app, space_id, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(h.id, auth.userId, auth.appId, h.spaceId, h.sealed, now());
    logRead(db, auth, "handoff", `left-${h.id}`, 1);
  });
}

/** Notes waiting for this agent: its own, from earlier sessions, and those left in its spaces by others. */
export function pendingHandoffs(db: Db, auth: AppAuth, spaceIds: string[]) {
  assertTool(db, auth, "handoff");
  const own = db
    .prepare(
      `SELECT h.id, h.from_app, h.space_id, h.sealed, h.created_at FROM handoffs h
       WHERE h.from_app = ? AND h.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM handoff_picks p WHERE p.handoff_id = h.id AND p.app_id = ?)
       ORDER BY h.created_at LIMIT 50`,
    )
    .all(auth.appId, auth.appId) as Row[];
  const inSpaces = spaceIds.length
    ? (db
        .prepare(
          `SELECT h.id, h.from_app, h.space_id, h.sealed, h.created_at FROM handoffs h
           WHERE h.space_id IN (${spaceIds.map(() => "?").join(",")}) AND h.from_app != ? AND NOT EXISTS (SELECT 1 FROM handoff_picks p WHERE p.handoff_id = h.id AND p.app_id = ?)
           ORDER BY h.created_at LIMIT 50`,
        )
        .all(...spaceIds, auth.appId, auth.appId) as Row[])
    : [];
  return [...own, ...inSpaces].map((r) => ({ id: String(r.id), fromApp: String(r.from_app), spaceId: r.space_id == null ? null : String(r.space_id), sealed: String(r.sealed), createdAt: String(r.created_at) }));
}

export function pickHandoffs(db: Db, auth: AppAuth, ids: string[], spaceIds: string[]): void {
  tx(db, () => {
    const ins = db.prepare("INSERT OR IGNORE INTO handoff_picks (handoff_id, app_id, picked_at) VALUES (?, ?, ?)");
    // Only notes this agent may see: its own, and those left in the spaces it is in. Any other id is passed over in silence.
    const exists = db.prepare("SELECT space_id, from_app FROM handoffs WHERE id = ?");
    const spaces = new Set(spaceIds);
    for (const id of ids) {
      const h = exists.get(id) as Row | undefined;
      if (!h) continue;
      const mine = h.space_id == null ? String(h.from_app) === auth.appId : spaces.has(String(h.space_id));
      if (!mine) continue;
      if (Number(ins.run(id, auth.appId, now()).changes) > 0) logRead(db, auth, "handoff", `picked-${id}`, 1);
    }
  });
}

/** The owner sees every note an agent left for itself; the owner holds the agent's secret. */
export function ownerHandoffs(db: Db, userId: string, appId: string) {
  const a = agentOf(db, appId);
  if (!a || a.userId !== userId) throw new HttpError(404, "That agent was not found.");
  return (db.prepare("SELECT h.id, h.space_id, h.sealed, h.created_at, (SELECT MAX(picked_at) FROM handoff_picks p WHERE p.handoff_id = h.id) AS picked FROM handoffs h WHERE h.from_app = ? ORDER BY h.created_at DESC LIMIT 100").all(appId) as Row[]).map((r) => ({
    id: String(r.id),
    spaceId: r.space_id == null ? null : String(r.space_id),
    sealed: String(r.sealed),
    createdAt: String(r.created_at),
    pickedAt: r.picked == null ? null : String(r.picked),
  }));
}
