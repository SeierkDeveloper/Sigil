// SQLite storage. Everything the server keeps lives in one file, and every
// column that holds user content holds ciphertext (see the privacy page for the
// full list of what is and is not encrypted).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 2;

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
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'wallet', 'phrase')),
  ref TEXT NOT NULL,
  auth_hash TEXT,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
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

// Every request a connected app makes, every suggestion it sends, and every time
// another vault opens a folder shared with it. leaf = Merkle leaf of the entry (salted).
const READ_LOG = `
CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read', 'propose', 'shared')),
  memory_id TEXT,
  count INTEGER NOT NULL,
  at TEXT NOT NULL,
  salt TEXT NOT NULL,
  leaf TEXT NOT NULL,
  hour INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS read_log_by_user ON read_log (user_id, at);
CREATE INDEX IF NOT EXISTS read_log_unsealed ON read_log (sealed, hour);
CREATE INDEX IF NOT EXISTS read_log_by_app ON read_log (app_id, kind, at);
`;

/** Version 1 allowed only reads in the log. Rebuild the table with the new kinds, keeping every row. */
function migrateReadLog(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_log'").get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'propose'")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE read_log RENAME TO read_log_v1");
    db.exec("DROP INDEX IF EXISTS read_log_by_user");
    db.exec("DROP INDEX IF EXISTS read_log_unsealed");
    db.exec(READ_LOG);
    db.exec("INSERT INTO read_log SELECT id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed FROM read_log_v1");
    db.exec("DROP TABLE read_log_v1");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
  db.exec(SCHEMA.replace("READ_LOG_TABLE", READ_LOG));
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
