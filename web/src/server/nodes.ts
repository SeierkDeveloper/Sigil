// Nodes: this server's health, the vaults that move out of it and into it,
// and the addresses of a vault that moved away, sent on to its new node for the
// period its owner chose, after which the vault is deleted here.
//
// The old node gives the bundle only to whoever holds the move's secret (the
// new node, with the code the owner carried), and starts sending links on only
// when the vault's own signing key confirms the arrival.

import {
  bundleShapeError,
  cleanMove,
  nodeOrigin,
  parseMoveCode,
  sha256Hex,
  verifyArrival,
  verifyBundle,
  verifyMove,
  randomId,
  SPEC_VERSION,
  type SignedMove,
  type VaultBundle,
} from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";
import { guardedFetch, hostAllowed, PrivateAddressError, readLimited } from "./netguard";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
export const NODE_VERSION = "0.1.0";

export function health(origin: string) {
  return { ok: true, node: { origin, version: NODE_VERSION, spec: SPEC_VERSION }, time: now() };
}

// ---------------------------------------------------------------- talking to another node

export type NodeFetch = (input: string, init?: RequestInit) => Promise<Response>;
// Every address someone else named is fetched through guardedFetch: each name is checked against every address it resolves to when the connection is made.
let nodeFetch: NodeFetch = guardedFetch;

/** Tests answer other nodes themselves. */
export function setNodeFetch(f: NodeFetch | null): void {
  nodeFetch = f ?? guardedFetch;
}

/** Another node's address, refused when it points into a private network unless this node allows that (a node on one machine, or tests). */
export function remoteOrigin(value: string): string {
  let origin: string;
  try {
    origin = nodeOrigin(value);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "bad_node");
  }
  const host = new URL(origin).hostname;
  if (!hostAllowed(host)) {
    throw new HttpError(400, "That node is on a private network. This node only talks to public nodes.", "private_node");
  }
  return origin;
}

/** A request to another node or a storage address: a time limit, no redirects, a size limit. */
export async function fetchRemote(url: string, init: RequestInit = {}, maxBytes = 256 * 1024 * 1024): Promise<Response> {
  let res: Response;
  const signal = AbortSignal.timeout(30_000);
  try {
    res = await nodeFetch(url, { ...init, redirect: "manual", signal });
  } catch (err) {
    if (err instanceof PrivateAddressError) throw new HttpError(400, "That address is on a private network. This node only talks to public addresses.", "private_node");
    throw new HttpError(502, "The other side could not be reached.", "unreachable");
  }
  if (res.status >= 300 && res.status < 400) throw new HttpError(502, "The other side answered with a redirect, which is not followed.", "redirect");
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "What the other side sent is too large.", "too_large");
  // The body is read here, never past the limit, whatever length the other side declared (or left out).
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(res, maxBytes);
  } catch (err) {
    if (err instanceof RangeError) throw new HttpError(413, "What the other side sent is too large.", "too_large");
    throw new HttpError(502, "The other side stopped answering.", "unreachable");
  }
  return new Response(bytes.byteLength ? (bytes as BodyInit) : null, { status: res.status, headers: res.headers });
}

// ---------------------------------------------------------------- moving out

export interface MoveInput {
  move: SignedMove;
  secretHash: string;
  bundle: VaultBundle;
}

function signKeyOf(db: Db, userId: string): string {
  const r = db.prepare("SELECT public_key FROM sign_keys WHERE user_id = ?").get(userId) as Row | undefined;
  if (!r) throw new HttpError(409, "Open your vault once more first, so it has its signing key.", "no_keys");
  return String(r.public_key);
}

/** The owner's device signed a move out of this node: keep the statement and the bundle for the new node. */
export function startMove(db: Db, userId: string, origin: string, input: MoveInput): { id: string } {
  const signKey = signKeyOf(db, userId);
  if (!verifyMove(input.move, signKey)) throw new HttpError(400, "The move is not signed by this vault's key.", "bad_move");
  const s = cleanMove(input.move.statement);
  if (s.from !== origin) throw new HttpError(400, `The move must start from this node, ${origin}.`, "bad_move");
  const shape = bundleShapeError(input.bundle.body);
  if (shape || !verifyBundle(input.bundle).ok || input.bundle.hash !== s.bundle || input.bundle.body.vault.signKey !== signKey) {
    throw new HttpError(400, "The bundle that goes with the move did not pass its checks.", "bad_bundle");
  }
  return tx(db, () => {
    const open = db.prepare("SELECT 1 FROM moves WHERE user_id = ? AND state IN ('signed', 'sent')").get(userId);
    if (open) throw new HttpError(409, "A move is already under way. Cancel it first.", "move_open");
    db.prepare(
      "INSERT INTO moves (id, user_id, to_origin, statement, signature, secret_hash, bundle, bundle_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'signed', ?)",
    ).run(s.id, userId, s.to, JSON.stringify(s), input.move.signature, input.secretHash, JSON.stringify(input.bundle), input.bundle.hash, now());
    logRead(db, { appId: "vault", userId }, "node", `move-signed-${s.id}`, 1);
    return { id: s.id };
  });
}

export function cancelMove(db: Db, userId: string, moveId: string): void {
  tx(db, () => {
    const r = db.prepare("UPDATE moves SET state = 'cancelled', bundle = '' WHERE id = ? AND user_id = ? AND state IN ('signed', 'sent')").run(moveId, userId);
    if (r.changes === 0) throw new HttpError(404, "There is no move under way with that id.", "no_move");
    logRead(db, { appId: "vault", userId }, "node", `move-cancelled-${moveId}`, 1);
  });
}

function moveBySecret(db: Db, moveId: string, secret: string): Row {
  const r = db.prepare("SELECT * FROM moves WHERE id = ?").get(moveId) as Row | undefined;
  if (!r || String(r.secret_hash) !== sha256Hex(secret)) throw new HttpError(404, "There is no such move.", "no_move");
  return r;
}

/** The new node asks for the bundle with the secret from the move code. */
export function sendMove(db: Db, moveId: string, secret: string): { move: SignedMove; bundle: VaultBundle } {
  return tx(db, () => {
    const r = moveBySecret(db, moveId, secret);
    if (r.state !== "signed" && r.state !== "sent") throw new HttpError(410, "This move was cancelled or is done.", "move_closed");
    if (r.state === "signed") {
      db.prepare("UPDATE moves SET state = 'sent', sent_at = ? WHERE id = ?").run(now(), moveId);
      logRead(db, { appId: "vault", userId: String(r.user_id) }, "node", `bundle-sent-${moveId}`, 1);
    }
    return { move: { statement: JSON.parse(String(r.statement)), signature: String(r.signature) }, bundle: JSON.parse(String(r.bundle)) as VaultBundle };
  });
}

/**
 * The new node passes on the arrival the owner's device signed there. Once it
 * holds under the vault's key, this node sends the vault's addresses on to the
 * new node and deletes the vault when the period ends.
 */
export function finishMove(db: Db, moveId: string, secret: string, arrival: { at: string; signature: string }, at = new Date()): { until: string } {
  return tx(db, () => {
    const r = moveBySecret(db, moveId, secret);
    const s = cleanMove(JSON.parse(String(r.statement)));
    if (r.state === "done") return { until: String((db.prepare("SELECT until FROM vault_nodes WHERE move_id = ? AND role = 'next'").get(moveId) as Row | undefined)?.until ?? "") };
    if (r.state !== "sent") throw new HttpError(409, "The new node has not fetched this move.", "move_not_sent");
    if (!verifyArrival(s.vault, moveId, s.to, s.bundle, arrival.at, arrival.signature)) throw new HttpError(403, "The arrival is not signed by this vault's key.", "bad_arrival");
    const userId = String(r.user_id);
    const until = new Date(at.getTime() + s.redirectDays * 86_400_000).toISOString();
    db.prepare("UPDATE moves SET state = 'done', done_at = ?, bundle = '' WHERE id = ?").run(at.toISOString(), moveId);
    db.prepare("UPDATE users SET moved_to = ?, delete_at = ? WHERE id = ?").run(s.to, until, userId);
    db.prepare("INSERT INTO vault_nodes (id, user_id, origin, role, move_id, state, since, until) VALUES (?, ?, ?, 'next', ?, 'confirmed', ?, ?)").run(randomId(), userId, s.to, moveId, at.toISOString(), until);
    const point = db.prepare("INSERT OR REPLACE INTO moved (kind, ref, to_origin, until) VALUES (?, ?, ?, ?)");
    point.run("vault", userId, s.to, until);
    for (const l of db.prepare("SELECT id FROM ask_links WHERE user_id = ?").all(userId) as Row[]) point.run("ask", String(l.id), s.to, until);
    for (const p of db.prepare("SELECT handle FROM public_selves WHERE user_id = ?").all(userId) as Row[]) point.run("public", String(p.handle), s.to, until);
    for (const p of db.prepare("SELECT id FROM packs WHERE user_id = ?").all(userId) as Row[]) point.run("pack", String(p.id), s.to, until);
    for (const c of db.prepare("SELECT id FROM emergency_cards WHERE user_id = ?").all(userId) as Row[]) point.run("emergency", String(c.id), s.to, until);
    // Sessions end here at once; app keys and sign-ins are told where the vault went.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    logRead(db, { appId: s.to, userId }, "node", `moved-${moveId}`, 1, at);
    return { until };
  });
}

/** Where an address of a vault that moved away now lives, while the period lasts. */
export function movedTo(db: Db, kind: "vault" | "ask" | "public" | "pack" | "emergency", ref: string, at = new Date()): string | null {
  const r = db.prepare("SELECT to_origin, until FROM moved WHERE kind = ? AND ref = ?").get(kind, ref) as Row | undefined;
  return r && String(r.until) > at.toISOString() ? String(r.to_origin) : null;
}

export function assertNotMoved(db: Db, kind: "vault" | "ask" | "public" | "pack" | "emergency", ref: string): void {
  const to = movedTo(db, kind, ref);
  if (to) throw new MovedError(to);
}

export class MovedError extends HttpError {
  constructor(public to: string) {
    super(410, `This vault moved to another node: ${to}`, "moved");
  }
}

/** Ends the period of every vault that moved away: the vault is deleted here, and its addresses stop pointing on. */
export function moveTick(db: Db, at = new Date()): number {
  const iso = at.toISOString();
  const gone = db.prepare("SELECT id FROM users WHERE moved_to IS NOT NULL AND delete_at IS NOT NULL AND delete_at <= ?").all(iso) as Row[];
  for (const u of gone) {
    tx(db, () => {
      db.prepare("DELETE FROM grants WHERE user_id = ?").run(String(u.id));
      db.prepare("DELETE FROM memories WHERE user_id = ?").run(String(u.id));
      db.prepare("DELETE FROM users WHERE id = ?").run(String(u.id));
    });
  }
  db.prepare("DELETE FROM moved WHERE until <= ?").run(iso);
  return gone.length;
}

// ---------------------------------------------------------------- moving in

/** The new node fetches a move from the old node with the code the owner carried, and checks it is meant for this node. */
export async function fetchMove(code: string, origin: string): Promise<{ move: SignedMove; bundle: VaultBundle; from: string }> {
  let c: ReturnType<typeof parseMoveCode>;
  try {
    c = parseMoveCode(code);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "bad_code");
  }
  const from = remoteOrigin(c.from);
  if (from === origin) throw new HttpError(400, "That move code is for a move out of this node.", "bad_code");
  const res = await fetchRemote(`${from}/api/nodes/moves/${c.id}`, { headers: { authorization: `Bearer ${c.secret}` } });
  if (!res.ok) throw new HttpError(502, res.status === 404 ? "The old node does not know this move. It may have been cancelled." : `The old node answered ${res.status}.`, "move_unavailable");
  let got: { move: SignedMove; bundle: VaultBundle };
  try {
    got = (await res.json()) as { move: SignedMove; bundle: VaultBundle };
  } catch {
    throw new HttpError(502, "The old node did not send a move.", "move_unavailable");
  }
  if (!verifyMove(got.move)) throw new HttpError(400, "The move statement does not hold.", "bad_move");
  const s = got.move.statement;
  if (s.to !== origin) throw new HttpError(400, `This move is for ${s.to}, not this node.`, "wrong_node");
  if (s.from !== from || s.id !== c.id) throw new HttpError(400, "The move does not match its code.", "bad_move");
  if (bundleShapeError(got.bundle?.body) || got.bundle.hash !== s.bundle || got.bundle.body.vault.signKey !== s.vault || !verifyBundle(got.bundle).ok) {
    throw new HttpError(400, "The bundle the old node sent is not the one the move names.", "bad_bundle");
  }
  return { ...got, from };
}

export interface Arrival {
  moveId: string;
  from: string;
  secret: string;
  at: string;
  signature: string;
}

/** After a restore from a move: the node list gets the old node, and the old node is told. */
export function recordArrival(db: Db, userId: string, a: Arrival, redirectDays: number): string {
  const id = randomId();
  const until = new Date(Date.parse(a.at) + redirectDays * 86_400_000).toISOString();
  db.prepare("INSERT INTO vault_nodes (id, user_id, origin, role, move_id, state, arrival, since, until) VALUES (?, ?, ?, 'previous', ?, 'waiting', ?, ?, ?)").run(
    id,
    userId,
    a.from,
    a.moveId,
    JSON.stringify(a),
    a.at,
    until,
  );
  logRead(db, { appId: "vault", userId }, "node", `arrived-${a.moveId}`, 1);
  return id;
}

/** Tells the old node the vault arrived. Kept and tried again from the vault until the old node confirms. */
export async function notifyOldNode(db: Db, userId: string, nodeRowId: string): Promise<boolean> {
  const r = db.prepare("SELECT * FROM vault_nodes WHERE id = ? AND user_id = ? AND role = 'previous'").get(nodeRowId, userId) as Row | undefined;
  if (!r || !r.arrival) throw new HttpError(404, "There is no such node in this vault's list.");
  if (r.state === "confirmed") return true;
  const a = JSON.parse(String(r.arrival)) as Arrival;
  let ok = false;
  try {
    const res = await fetchRemote(`${remoteOrigin(a.from)}/api/nodes/moves/${a.moveId}/done`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ at: a.at, signature: a.signature }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    tx(db, () => {
      db.prepare("UPDATE vault_nodes SET state = 'confirmed', arrival = NULL WHERE id = ?").run(nodeRowId);
      logRead(db, { appId: "vault", userId }, "node", `confirmed-${a.moveId}`, 1);
    });
  }
  return ok;
}

/** Where the vault lives: this node, the nodes it came from and went to, and moves under way. */
export function vaultNodes(db: Db, userId: string, origin: string) {
  return {
    here: origin,
    nodes: (db.prepare("SELECT id, origin, role, move_id, state, since, until FROM vault_nodes WHERE user_id = ? ORDER BY since").all(userId) as Row[]).map((r) => ({
      id: String(r.id),
      origin: String(r.origin),
      role: r.role as "previous" | "next",
      moveId: r.move_id == null ? null : String(r.move_id),
      state: r.state as "waiting" | "confirmed",
      since: String(r.since),
      until: r.until == null ? null : String(r.until),
    })),
    moves: (db.prepare("SELECT id, to_origin, state, bundle_hash, created_at, sent_at, done_at FROM moves WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(userId) as Row[]).map((r) => ({
      id: String(r.id),
      to: String(r.to_origin),
      state: r.state as "signed" | "sent" | "done" | "cancelled",
      bundle: String(r.bundle_hash),
      createdAt: String(r.created_at),
      sentAt: r.sent_at == null ? null : String(r.sent_at),
      doneAt: r.done_at == null ? null : String(r.done_at),
    })),
  };
}
