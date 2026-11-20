// SQLite storage. Everything the server keeps lives in one file, and every
// column that holds user content holds ciphertext (see the privacy page for the
// full list of what is and is not encrypted).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- One row per way of opening the vault. wrapped_key is the vault key encrypted
-- on the device; auth_hash is the SHA-256 of a token derived on the device.
CREATE TABLE IF NOT EXISTS keyslots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'wallet', 'phrase', 'device')),
  ref TEXT NOT NULL,
  auth_hash TEXT,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  -- For a device: its name, encrypted under the vault key.
  note TEXT,
  UNIQUE (kind, ref)
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  meta TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS memories (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  head TEXT NOT NULL,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Set only for a memory the owner gave an expiry: its expiry plus the grace
  -- period. The row is deleted for real once this time has passed.
  delete_after TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, folder_id) REFERENCES folders(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memories_by_folder ON memories (user_id, folder_id);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meta TEXT NOT NULL,
  secret TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS grants (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, folder_id),
  FOREIGN KEY (user_id, folder_id) REFERENCES folders(user_id, id) ON DELETE CASCADE
);

READ_LOG_TABLE

-- The vault's X25519 public key, in the clear so apps and other vaults can seal
-- to it, and its private key wrapped by the vault key on the device.
CREATE TABLE IF NOT EXISTS box_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  wrapped_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Whether an app may suggest memories (off unless the owner turns it on), and
-- the tag the owner's device made so the app can check the vault public key.
CREATE TABLE IF NOT EXISTS app_inbox (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  tag TEXT,
  updated_at TEXT NOT NULL
);

-- Suggested memories waiting in the inbox: one sealed box each, which only the
-- vault's private key opens. Resolved proposals are deleted.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_by_user ON proposals (user_id, created_at);

-- A folder shared with another vault. sealed_key is the folder key sealed to the
-- recipient's public key; note is the owner's label for the recipient, encrypted
-- under the owner's vault key.
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  sealed_key TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (folder_id, owner_id, recipient_id),
  FOREIGN KEY (owner_id, folder_id) REFERENCES folders(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shares_by_recipient ON shares (recipient_id);

-- Vault settings (the AI self's rules, the model key, how the vault thinks),
-- each one an envelope under the vault key.
CREATE TABLE IF NOT EXISTS vault_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

-- Apps the owner lets answer as the AI self: rules, model key and the vault
-- public key, encrypted under a key derived from that app's own secret.
CREATE TABLE IF NOT EXISTS self_apps (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- "Ask my AI self" links. public_key is the link's X25519 public key (also in
-- the link's fragment); intro is the greeting under a key only the link holds;
-- owner_box is the link's private key and rules under the vault key; app_box,
-- for a link the connector answers, the same under that app's key.
CREATE TABLE IF NOT EXISTS ask_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  intro TEXT NOT NULL,
  owner_box TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  app_box TEXT,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  per_hour INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  last_asked_at TEXT,
  agent_seen_at INTEGER,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS ask_links_by_user ON ask_links (user_id);

-- Questions in flight: relay boxes only the asker and the owner's agent open.
-- Deleted a day after they were asked.
CREATE TABLE IF NOT EXISTS ask_questions (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES ask_links(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  asker_key TEXT NOT NULL,
  sealed TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS ask_questions_by_link ON ask_questions (link_id, answered_at, created_at);

-- Legacy: one plan per vault. owner_box is the legacy key and the plan under
-- the vault key; check_value tells whether combined shares gave the right key
-- and says nothing about it. The warning columns record the stages the owner
-- missed, shown once when they come back.
CREATE TABLE IF NOT EXISTS legacy_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  period_days INTEGER NOT NULL,
  check_value TEXT NOT NULL,
  owner_box TEXT NOT NULL,
  warned_stage INTEGER NOT NULL DEFAULT 0,
  warned_at TEXT,
  missed_stage INTEGER NOT NULL DEFAULT 0,
  missed_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The trusted people of a plan. share, bundle and note are sealed to
-- public_key; kept is the person's own copy after release, under their vault
-- key. invite_* is what an invited vault answered: its key and the tag made
-- with the secret in the invite link.
CREATE TABLE IF NOT EXISTS legacy_people (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES legacy_plans(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT,
  trustee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  folder_ids TEXT NOT NULL,
  self INTEGER NOT NULL DEFAULT 0,
  share TEXT,
  bundle TEXT,
  note TEXT,
  invite_intro TEXT,
  invite_key TEXT,
  invite_tag TEXT,
  invite_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  kept TEXT,
  opened_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS legacy_people_by_trustee ON legacy_people (trustee_id);

-- The release room: shares one trusted person passed to another, each sealed
-- to the receiver's key, and who asked for a release. Cleared when the plan changes.
CREATE TABLE IF NOT EXISTS legacy_passes (
  plan_id TEXT NOT NULL REFERENCES legacy_plans(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, epoch, from_id, to_id)
);
CREATE TABLE IF NOT EXISTS legacy_requests (
  plan_id TEXT NOT NULL REFERENCES legacy_plans(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, epoch, person_id)
);

-- Adding a device: the new device's one-time public key, the short code made
-- from it, a hash of the secret only the new device holds, and the sealed box
-- the signed-in device sends. Deleted once picked up, or after ten minutes.
CREATE TABLE IF NOT EXISTS device_pairings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  poll_hash TEXT NOT NULL,
  sealed TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Agents: an app with its own folder, tool rules the server enforces, and the
-- public half of the key pair derived from its secret (for team spaces).
CREATE TABLE IF NOT EXISTS agents (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home_folder_id TEXT NOT NULL,
  may_remember INTEGER NOT NULL DEFAULT 1,
  may_recall INTEGER NOT NULL DEFAULT 1,
  may_forget INTEGER NOT NULL DEFAULT 0,
  may_handoff INTEGER NOT NULL DEFAULT 1,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Handoff notes: encrypted for the agent's next session, or for a team space.
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_app TEXT NOT NULL,
  space_id TEXT,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_by_app ON handoffs (from_app, created_at);
CREATE INDEX IF NOT EXISTS handoffs_by_space ON handoffs (space_id, created_at);
CREATE TABLE IF NOT EXISTS handoff_picks (
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  picked_at TEXT NOT NULL,
  PRIMARY KEY (handoff_id, app_id)
);

-- Team spaces. meta is the name under the space key. Every member, the vault
-- that made the space included, holds the key sealed to its own public key;
-- tag is a MAC under the space key that admins check before sealing anything.
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  meta TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS space_members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('vault', 'agent')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  sealed_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  -- What the space calls the member, under the space key.
  label TEXT NOT NULL,
  added_by TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (space_id, public_key)
);
CREATE INDEX IF NOT EXISTS space_members_by_user ON space_members (user_id);
CREATE INDEX IF NOT EXISTS space_members_by_app ON space_members (app_id);
CREATE TABLE IF NOT EXISTS space_memories (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS space_memories_by_space ON space_memories (space_id, updated_at);

-- Proof of a real life: the vault's Ed25519 public key for presence
-- statements, and certificates the owner chose to publish by link.
CREATE TABLE IF NOT EXISTS sign_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Public: one Merkle root per hour with reads in it.
CREATE TABLE IF NOT EXISTS seals (
  hour INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  leaves INTEGER NOT NULL,
  sealed_at TEXT NOT NULL,
  anchor_tx TEXT,
  anchored_at TEXT
);

-- The leaves of each seal, in tree order, so proofs keep working after an
-- account (and with it the salts that link leaves to entries) is deleted.
CREATE TABLE IF NOT EXISTS seal_leaves (
  hour INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  leaf TEXT NOT NULL,
  PRIMARY KEY (hour, idx)
);
`;

// Every request a connected app makes, every suggestion it sends, every time
// another vault opens a folder shared with it, and every question the AI self
// answers. leaf = Merkle leaf of the entry (salted). note, for answers only, is
// the question and answer sealed to the vault's public key.
const READ_LOG = `
CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read', 'propose', 'shared', 'ask', 'legacy', 'device', 'presence', 'remember', 'forget', 'handoff', 'space')),
  memory_id TEXT,
  count INTEGER NOT NULL,
  at TEXT NOT NULL,
  salt TEXT NOT NULL,
  leaf TEXT NOT NULL,
  hour INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS read_log_by_user ON read_log (user_id, at);
CREATE INDEX IF NOT EXISTS read_log_unsealed ON read_log (sealed, hour);
CREATE INDEX IF NOT EXISTS read_log_by_app ON read_log (app_id, kind, at);
CREATE INDEX IF NOT EXISTS read_log_by_kind ON read_log (user_id, kind, hour);
`;

/** Older versions allowed fewer kinds in the log and had no notes. Rebuild the table, keeping every row. */
function migrateReadLog(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_log'").get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'space'")) return;
  const hasNote = row.sql.includes("note TEXT");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE read_log RENAME TO read_log_old");
    db.exec("DROP INDEX IF EXISTS read_log_by_user");
    db.exec("DROP INDEX IF EXISTS read_log_unsealed");
    db.exec("DROP INDEX IF EXISTS read_log_by_app");
    db.exec("DROP INDEX IF EXISTS read_log_by_kind");
    db.exec(READ_LOG);
    const cols = `id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed${hasNote ? ", note" : ""}`;
    db.exec(`INSERT INTO read_log (${cols}) SELECT ${cols} FROM read_log_old`);
    db.exec("DROP TABLE read_log_old");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Key slots for paired devices came later: the kind check gains 'device' and the table a note. Rebuild it, keeping every row. */
function migrateKeyslots(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'keyslots'").get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'device'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE keyslots RENAME TO keyslots_old");
    db.exec(`CREATE TABLE keyslots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'wallet', 'phrase', 'device')),
  ref TEXT NOT NULL,
  auth_hash TEXT,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  note TEXT,
  UNIQUE (kind, ref)
)`);
    db.exec("INSERT INTO keyslots (id, user_id, kind, ref, auth_hash, wrapped_key, created_at, last_used_at) SELECT id, user_id, kind, ref, auth_hash, wrapped_key, created_at, last_used_at FROM keyslots_old");
    db.exec("DROP TABLE keyslots_old");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function addColumn(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  // Deleted content is overwritten with zeros on disk, not just unlinked.
  db.exec("PRAGMA secure_delete = ON;");
  if (file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  migrateReadLog(db);
  migrateKeyslots(db);
  db.exec(SCHEMA.replace("READ_LOG_TABLE", READ_LOG));
  addColumn(db, "memories", "delete_after", "TEXT");
  // The last sign-in or vault action of the owner: the legacy plan's heartbeat.
  addColumn(db, "users", "last_active_at", "TEXT");
  // Which key slot a session was opened with, so revoking a device ends its sessions.
  addColumn(db, "sessions", "keyslot_id", "TEXT");
  // Whether an app may write a folder (agents) or only read it.
  addColumn(db, "grants", "mode", "TEXT NOT NULL DEFAULT 'read'");
  db.exec("CREATE INDEX IF NOT EXISTS memories_to_delete ON memories (delete_after) WHERE delete_after IS NOT NULL;");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return db;
}

let shared: Db | null = null;

export function dataFile(): string {
  if (process.env.SIGIL_DB) return process.env.SIGIL_DB;
  const dir = process.env.SIGIL_DATA_DIR || path.join(process.cwd(), ".data");
  return path.join(dir, "sigil.db");
}

export function getDb(): Db {
  if (!shared) shared = openDb(dataFile());
  return shared;
}

/** Tests swap in their own database. */
export function setDb(db: Db | null): void {
  shared = db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
