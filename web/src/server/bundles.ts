// The vault as one bundle: built from what this node stores for a vault, and
// taken in whole on any node. Everything in it is ciphertext, sealed boxes,
// wrapped keys, hashes and public keys, exactly as the node already held it.
//
// Rows of the node's own tables travel as { table, row } in the bundle's parts.
// Ids that only mean something on this node are left out: the vault's own user
// id becomes "@vault", any other account's id becomes null, and the node that
// takes the bundle in finds other vaults again by their public keys.

import {
  bundleShapeError,
  hex32,
  merkleTree,
  fromHex32,
  verifyBundle,
  verifyRestore,
  tokenHash,
  randomId,
  BUNDLE_PARTS,
  type BundleBody,
  type BundleLogEntry,
  type ReadKind,
  type VaultBundle,
} from "@sigil/core";
import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { HttpError, logRead } from "./store";
import { userByBoxKey } from "./inbox";

type Row = Record<string, unknown>;
type PartRow = { table: string; row: Row };
const now = () => new Date().toISOString();

const OWNER = "@vault";
/** Columns that hold an account id of this node. */
const ACCOUNT_COLUMNS = ["user_id", "owner_id", "created_by", "trustee_id", "invite_user", "recipient_id"];

function scrub(row: Row, userId: string): Row {
  const out: Row = { ...row };
  for (const c of ACCOUNT_COLUMNS) if (c in out && out[c] != null) out[c] = out[c] === userId ? OWNER : null;
  return out;
}

function all(db: Db, sql: string, ...params: (string | number)[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function tagged(table: string, rows: Row[], userId: string): PartRow[] {
  return rows.map((row) => ({ table, row: scrub(row, userId) }));
}

/** Each entry's seal: the node, the root of its hour and its path, from this node's seals or from the bundle it came with. */
function logWithSeals(db: Db, userId: string, origin: string): BundleLogEntry[] {
  const rows = all(db, "SELECT * FROM read_log WHERE user_id = ? ORDER BY at, id", userId);
  // Each sealed hour's tree is built once, with a map from leaf to its place, for all of that hour's entries.
  const hours = new Map<number, { root: string; at: Map<string, number>; tree: ReturnType<typeof merkleTree> } | null>();
  const sealOf = (hour: number) => {
    if (!hours.has(hour)) {
      const s = db.prepare("SELECT root FROM seals WHERE hour = ?").get(hour) as Row | undefined;
      if (!s) hours.set(hour, null);
      else {
        const leaves = all(db, "SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx", hour).map((r) => String(r.leaf));
        hours.set(hour, { root: String(s.root), at: new Map(leaves.map((l, i) => [l, i])), tree: merkleTree(leaves.map(fromHex32)) });
      }
    }
    return hours.get(hour)!;
  };
  return rows.map((r) => {
    let seal: BundleLogEntry["seal"] = null;
    if (r.carried) {
      const c = JSON.parse(String(r.carried)) as BundleLogEntry["seal"] | { unsealed: true };
      seal = c && "root" in c ? c : null;
    } else if (Number(r.sealed) === 1) {
      const s = sealOf(Number(r.hour));
      const index = s ? (s.at.get(String(r.leaf)) ?? -1) : -1;
      if (s && index >= 0) seal = { origin, periodSeconds: serverConfig.sealSeconds, root: s.root, index, proof: s.tree.proof(index).map(hex32) };
    }
    return {
      id: String(r.id),
      appId: String(r.app_id),
      kind: r.kind as ReadKind,
      memoryId: r.memory_id == null ? null : String(r.memory_id),
      count: Number(r.count),
      at: String(r.at),
      salt: String(r.salt),
      leaf: String(r.leaf),
      hour: Number(r.hour),
      note: r.note == null ? null : String(r.note),
      seal,
    };
  });
}

/** Everything this node keeps for a vault, as a bundle body. The owner's device seals it; a connector sends it as it is. */
export function bundleBody(db: Db, userId: string, origin: string, madeBy: "vault" | "connector"): BundleBody {
  const user = db.prepare("SELECT created_at FROM users WHERE id = ?").get(userId) as Row | undefined;
  if (!user) throw new HttpError(404, "That vault was not found.");
  const box = db.prepare("SELECT public_key, wrapped_secret FROM box_keys WHERE user_id = ?").get(userId) as Row | undefined;
  const sign = db.prepare("SELECT public_key FROM sign_keys WHERE user_id = ?").get(userId) as Row | undefined;
  if (!box || !sign) throw new HttpError(409, "Open your vault once more first, so it has its public keys.", "no_keys");
  const passkeys = new Map(all(db, "SELECT * FROM passkeys WHERE user_id = ?", userId).map((p) => [String(p.credential_id), p]));
  const spaces = all(db, "SELECT space_id FROM space_members WHERE kind = 'vault' AND user_id = ?", userId).map((r) => String(r.space_id));
  const selfIds = all(db, "SELECT id FROM public_selves WHERE user_id = ?", userId).map((r) => String(r.id));
  const packIds = all(db, "SELECT id FROM packs WHERE user_id = ?", userId).map((r) => String(r.id));
  const bookingIds = all(db, "SELECT id FROM session_bookings WHERE user_id = ?", userId).map((r) => String(r.id));
  const inList = (ids: string[]) => (ids.length ? ids.map(() => "?").join(",") : "NULL");
  const parts: BundleBody["parts"] = {
    apps: [
      ...tagged("apps", all(db, "SELECT * FROM apps WHERE user_id = ?", userId), userId),
      ...tagged("grants", all(db, "SELECT * FROM grants WHERE user_id = ?", userId), userId),
      ...tagged("app_inbox", all(db, "SELECT * FROM app_inbox WHERE user_id = ?", userId), userId),
      ...tagged("self_apps", all(db, "SELECT * FROM self_apps WHERE user_id = ?", userId), userId),
      ...tagged("agents", all(db, "SELECT * FROM agents WHERE user_id = ?", userId), userId),
      ...tagged("backup_apps", all(db, "SELECT * FROM backup_apps WHERE user_id = ?", userId), userId),
    ],
    legacy: [
      ...tagged("legacy_plans", all(db, "SELECT * FROM legacy_plans WHERE user_id = ?", userId), userId),
      ...tagged("legacy_people", all(db, "SELECT * FROM legacy_people WHERE owner_id = ?", userId), userId),
    ],
    spaces: [
      ...tagged("spaces", all(db, `SELECT * FROM spaces WHERE id IN (${inList(spaces)})`, ...spaces), userId),
      ...tagged("space_members", all(db, `SELECT * FROM space_members WHERE space_id IN (${inList(spaces)})`, ...spaces), userId),
      ...tagged("space_memories", all(db, `SELECT * FROM space_memories WHERE space_id IN (${inList(spaces)})`, ...spaces), userId),
      ...tagged("space_heirs", all(db, `SELECT * FROM space_heirs WHERE space_id IN (${inList(spaces)})`, ...spaces), userId),
    ],
    publicSelf: [
      ...tagged("public_selves", all(db, "SELECT * FROM public_selves WHERE user_id = ?", userId).map(({ agent_seen_at: _a, ...r }) => r), userId),
      ...tagged("public_items", all(db, `SELECT * FROM public_items WHERE self_id IN (${inList(selfIds)})`, ...selfIds), userId),
      ...tagged("public_wall", all(db, `SELECT * FROM public_wall WHERE self_id IN (${inList(selfIds)})`, ...selfIds), userId),
    ],
    askLinks: tagged("ask_links", all(db, "SELECT * FROM ask_links WHERE user_id = ?", userId).map(({ agent_seen_at: _a, ...r }) => r), userId),
    packs: [
      ...tagged("packs", all(db, "SELECT * FROM packs WHERE user_id = ?", userId), userId),
      ...tagged("pack_versions", all(db, `SELECT * FROM pack_versions WHERE pack_id IN (${inList(packIds)})`, ...packIds), userId),
    ],
    emergency: [
      ...tagged("emergency_cards", all(db, "SELECT * FROM emergency_cards WHERE user_id = ?", userId), userId),
      ...tagged("emergency_opens", all(db, "SELECT * FROM emergency_opens WHERE user_id = ?", userId), userId),
    ],
    proposals: tagged("proposals", all(db, "SELECT * FROM proposals WHERE user_id = ?", userId), userId),
    drafts: tagged("drafts", all(db, "SELECT * FROM drafts WHERE user_id = ?", userId), userId),
    disclosures: tagged("disclosures", all(db, "SELECT * FROM disclosures WHERE user_id = ?", userId), userId),
    certificates: tagged("certificates", all(db, "SELECT * FROM certificates WHERE user_id = ?", userId), userId),
    sync: tagged("sync_sources", all(db, "SELECT * FROM sync_sources WHERE user_id = ?", userId), userId),
    identity: tagged("self_identities", all(db, "SELECT * FROM self_identities WHERE user_id = ?", userId), userId),
    nodes: tagged("vault_nodes", all(db, "SELECT * FROM vault_nodes WHERE user_id = ?", userId), userId),
    captureKeys: tagged("capture_keys", all(db, "SELECT * FROM capture_keys WHERE user_id = ?", userId), userId),
    sessions: [
      ...tagged("session_offers", all(db, `SELECT * FROM session_offers WHERE self_id IN (${inList(selfIds)})`, ...selfIds), userId),
      ...tagged("session_bookings", all(db, "SELECT * FROM session_bookings WHERE user_id = ?", userId), userId),
      ...tagged("session_turns", all(db, `SELECT * FROM session_turns WHERE booking_id IN (${inList(bookingIds)})`, ...bookingIds), userId),
      ...tagged("session_blocks", all(db, `SELECT * FROM session_blocks WHERE self_id IN (${inList(selfIds)})`, ...selfIds), userId),
    ],
    backups: tagged("backup_runs", all(db, "SELECT * FROM backup_runs WHERE user_id = ?", userId), userId),
  };
  const protectedIds = new Set(all(db, "SELECT folder_id FROM protected_folders WHERE user_id = ?", userId).map((r) => String(r.folder_id)));
  return {
    origin: origin.replace(/\/$/, ""),
    periodSeconds: serverConfig.sealSeconds,
    createdAt: now(),
    madeBy,
    vault: { boxPublicKey: String(box.public_key), boxWrappedSecret: String(box.wrapped_secret), signKey: String(sign.public_key), createdAt: String(user.created_at) },
    keyslots: all(db, "SELECT kind, ref, auth_hash, wrapped_key FROM keyslots WHERE user_id = ? AND kind != 'device' ORDER BY created_at", userId).map((k) => {
      const p = k.kind === "passkey" ? passkeys.get(String(k.ref)) : undefined;
      return {
        kind: k.kind as "passkey" | "wallet" | "phrase",
        ref: String(k.ref),
        authHash: k.auth_hash == null ? null : String(k.auth_hash),
        wrappedKey: String(k.wrapped_key),
        ...(p ? { passkey: { publicKey: String(p.public_key), counter: Number(p.counter), transports: JSON.parse(String(p.transports ?? "[]")) as string[] } } : {}),
      };
    }),
    folders: all(db, "SELECT id, meta, wrapped_key, created_at FROM folders WHERE user_id = ? ORDER BY created_at, id", userId).map((f) => ({
      id: String(f.id),
      meta: String(f.meta),
      wrappedKey: String(f.wrapped_key),
      protected: protectedIds.has(String(f.id)),
      createdAt: String(f.created_at),
    })),
    memories: all(db, "SELECT id, folder_id, head, body, delete_after, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at, id", userId).map((m) => ({
      id: String(m.id),
      folderId: String(m.folder_id),
      head: String(m.head),
      body: String(m.body),
      deleteAfter: m.delete_after == null ? null : String(m.delete_after),
      updatedAt: String(m.updated_at),
    })),
    settings: Object.fromEntries(all(db, "SELECT name, value FROM vault_settings WHERE user_id = ? ORDER BY name", userId).map((s) => [String(s.name), String(s.value)])),
    log: logWithSeals(db, userId, origin),
    parts,
  };
}

// ---------------------------------------------------------------- taking a bundle in

/** The order rows go in, so that what they point at is already there. */
const TABLE_ORDER = [
  "apps",
  "grants",
  "app_inbox",
  "self_apps",
  "agents",
  "backup_apps",
  "legacy_plans",
  "legacy_people",
  "ask_links",
  "public_selves",
  "public_items",
  "public_wall",
  "packs",
  "pack_versions",
  "emergency_cards",
  "emergency_opens",
  "proposals",
  "drafts",
  "disclosures",
  "certificates",
  "sync_sources",
  "self_identities",
  "vault_nodes",
  "capture_keys",
  "session_offers",
  "session_bookings",
  "session_turns",
  "session_blocks",
  "backup_runs",
  "spaces",
  "space_members",
  "space_memories",
  "space_heirs",
];

export interface SignInProof {
  kind: "wallet" | "phrase";
  ref: string;
  authToken: string;
}

export interface RestoreReport {
  userId: string;
  hash: string;
  folders: number;
  memories: number;
  logEntries: number;
  taken: Record<string, number>;
  /** Rows this node could not take in, by table: an id already used here, or what they point at is not here. */
  left: Record<string, number>;
}

function columnsOf(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function isPrimitive(v: unknown): v is string | number | null {
  return v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Takes a checked bundle in as a new vault. The caller proved it holds the
 * vault key (the restore statement) and a sign-in method the bundle carries.
 * Nothing is merged into a vault that is already on this node.
 */
export function importBundle(db: Db, bundle: VaultBundle, origin: string, signIn: SignInProof, statement: { issuedAt: string; signature: string }, at = new Date()): RestoreReport {
  const shape = bundleShapeError(bundle.body);
  if (shape) throw new HttpError(400, shape, "bad_bundle");
  const check = verifyBundle(bundle);
  if (!check.ok) throw new HttpError(400, `This bundle did not pass its checks: ${check.checks.find((c) => !c.ok)?.detail}`, "bad_bundle");
  const body = bundle.body;
  if (!verifyRestore(body.vault.signKey, { origin, bundle: bundle.hash, issuedAt: statement.issuedAt }, statement.signature, at.getTime())) {
    throw new HttpError(403, "The restore was not signed for this node by the vault's key, or it is too old. Sign in again.", "bad_restore");
  }
  const slot = body.keyslots.find((k) => k.kind === signIn.kind && k.ref.toLowerCase() === signIn.ref.toLowerCase());
  if (!slot || !slot.authHash || slot.authHash !== tokenHash(signIn.authToken)) throw new HttpError(403, "That sign-in does not open this bundle.", "bad_sign_in");

  return tx(db, () => {
    if (userByBoxKey(db, body.vault.boxPublicKey) || db.prepare("SELECT 1 FROM sign_keys WHERE public_key = ?").get(body.vault.signKey)) {
      throw new HttpError(409, "This vault already lives on this node. Sign in to it instead.", "vault_exists");
    }
    for (const k of body.keyslots) {
      if (db.prepare("SELECT 1 FROM keyslots WHERE kind = ? AND ref = ?").get(k.kind, k.ref)) throw new HttpError(409, "A sign-in method of this vault already opens another vault on this node.", "taken");
    }
    const userId = randomId();
    const stamp = at.toISOString();
    db.prepare("INSERT INTO users (id, created_at, last_active_at) VALUES (?, ?, ?)").run(userId, body.vault.createdAt, stamp);
    const slotIns = db.prepare("INSERT INTO keyslots (id, user_id, kind, ref, auth_hash, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const k of body.keyslots) {
      slotIns.run(randomId(), userId, k.kind, k.ref, k.authHash, k.wrappedKey, stamp);
      if (k.kind === "passkey" && k.passkey && !db.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").get(k.ref)) {
        db.prepare("INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(k.ref, userId, k.passkey.publicKey, k.passkey.counter, JSON.stringify(k.passkey.transports ?? []), stamp);
      }
    }
    db.prepare("INSERT INTO box_keys (user_id, public_key, wrapped_secret, created_at) VALUES (?, ?, ?, ?)").run(userId, body.vault.boxPublicKey, body.vault.boxWrappedSecret, stamp);
    db.prepare("INSERT INTO sign_keys (user_id, public_key, created_at) VALUES (?, ?, ?)").run(userId, body.vault.signKey, stamp);
    const folderIns = db.prepare("INSERT INTO folders (user_id, id, meta, wrapped_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const f of body.folders) {
      folderIns.run(userId, f.id, f.meta, f.wrappedKey, f.createdAt, stamp);
      if (f.protected) db.prepare("INSERT INTO protected_folders (user_id, folder_id, created_at) VALUES (?, ?, ?)").run(userId, f.id, stamp);
    }
    const memIns = db.prepare("INSERT INTO memories (user_id, id, folder_id, head, body, size, created_at, updated_at, delete_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const m of body.memories) memIns.run(userId, m.id, m.folderId, m.head, m.body, m.head.length + m.body.length, m.updatedAt, m.updatedAt, m.deleteAfter);
    const setIns = db.prepare("INSERT INTO vault_settings (user_id, name, value, updated_at) VALUES (?, ?, ?, ?)");
    for (const [name, value] of Object.entries(body.settings)) setIns.run(userId, name, value, stamp);

    const taken: Record<string, number> = {};
    const left: Record<string, number> = {};
    const count = (into: Record<string, number>, t: string) => (into[t] = (into[t] ?? 0) + 1);

    // The log as it was, each entry with the proof it was sealed with where it was made.
    const logIns = db.prepare("INSERT OR IGNORE INTO read_log (id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed, note, carried) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)");
    let logEntries = 0;
    for (const e of body.log) {
      const carried = JSON.stringify(e.seal ?? { origin: body.origin, unsealed: true });
      logEntries += Number(logIns.run(e.id, userId, e.appId, e.kind, e.memoryId, e.count, e.at, e.salt, e.leaf, e.hour, e.note, carried).changes);
    }

    const rows = BUNDLE_PARTS.flatMap((p) => body.parts[p] as unknown as PartRow[]).filter((x) => x && typeof x.table === "string" && x.row && typeof x.row === "object");
    const cols = new Map<string, Set<string>>();
    // The ids of rows this import put in, by table: a row that points at a parent row may only point at one of these.
    const placed = new Map<string, Set<string>>();
    for (const table of TABLE_ORDER) {
      if (!cols.has(table)) cols.set(table, columnsOf(db, table));
      const known = cols.get(table)!;
      for (const { row: raw } of rows.filter((x) => x.table === table)) {
        const row: Row = {};
        for (const [k, v] of Object.entries(raw)) if (known.has(k) && isPrimitive(v)) row[k] = v === OWNER ? userId : v;
        if (!placeRow(db, table, row, userId, placed)) {
          count(left, table);
          continue;
        }
        const keys = Object.keys(row);
        try {
          db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k] as string | number | null));
          count(taken, table);
          if (row.id != null) {
            if (!placed.has(table)) placed.set(table, new Set());
            placed.get(table)!.add(String(row.id));
          }
        } catch {
          // An id already in use here, or a row that points at something this node does not hold.
          count(left, table);
        }
      }
    }
    logRead(db, { appId: "vault", userId }, "node", `restored-${bundle.hash}`, 1, at);
    return { userId, hash: bundle.hash, folders: body.folders.length, memories: body.memories.length, logEntries, taken, left };
  });
}

/**
 * Rows that hang off another row of the bundle: the column that points at it
 * and the table it is in. A restored vault brings its own apps, plans, public
 * self, packs, sessions and spaces, so each such row must point at one this
 * same import put in. Without this, a bundle anyone can make could hang rows
 * off another vault's public self, pack, plan or space on this node.
 */
const PARENTS: Record<string, [column: string, table: string, nullable?: boolean][]> = {
  grants: [["app_id", "apps"]],
  app_inbox: [["app_id", "apps"]],
  self_apps: [["app_id", "apps"]],
  agents: [["app_id", "apps"]],
  backup_apps: [["app_id", "apps"]],
  legacy_people: [["plan_id", "legacy_plans"]],
  ask_links: [["app_id", "apps", true]],
  public_selves: [["app_id", "apps", true]],
  public_items: [["self_id", "public_selves"]],
  public_wall: [["self_id", "public_selves"]],
  pack_versions: [["pack_id", "packs"]],
  emergency_opens: [["card_id", "emergency_cards"]],
  sync_sources: [["app_id", "apps", true]],
  session_offers: [["self_id", "public_selves"]],
  session_bookings: [["self_id", "public_selves"]],
  session_turns: [["booking_id", "session_bookings"]],
  session_blocks: [["self_id", "public_selves"]],
  space_members: [
    ["space_id", "spaces"],
    ["app_id", "apps", true],
  ],
  space_memories: [["space_id", "spaces"]],
  space_heirs: [["space_id", "spaces"]],
};

/** Adjusts one row for this node before it goes in. False leaves it out. */
function placeRow(db: Db, table: string, row: Row, userId: string, placed: Map<string, Set<string>>): boolean {
  // Every account column is this vault's own (the bundle's "@vault") or empty. Any other account id is refused.
  for (const c of ACCOUNT_COLUMNS) if (c in row && row[c] != null && row[c] !== userId) return false;
  for (const [column, parent, nullable] of PARENTS[table] ?? []) {
    const v = row[column];
    if (v == null) {
      if (nullable) continue;
      return false;
    }
    if (!placed.get(parent)?.has(String(v))) return false;
  }
  if (table === "legacy_people") {
    // A trusted person is found again by their vault's public key, if their vault is on this node.
    row.trustee_id = row.public_key ? userByBoxKey(db, String(row.public_key)) : null;
    row.invite_user = null;
  }
  if (table === "space_members") {
    if (row.user_id === userId) return true;
    // Another vault in the space: on this node only if its vault is here too, and it accepts the space again.
    if (row.kind !== "vault") return false;
    const other = userByBoxKey(db, String(row.public_key));
    if (!other) return false;
    row.user_id = other;
    row.accepted_at = null;
    return true;
  }
  if (table === "public_questions" || table === "ask_questions") return false;
  return true;
}

/** The parts of a bundle as a node reads them, for the restore page's report. */
export function partCounts(bundle: VaultBundle): Record<string, number> {
  return Object.fromEntries(BUNDLE_PARTS.map((p) => [p, (bundle.body.parts[p] as unknown[]).length]));
}
