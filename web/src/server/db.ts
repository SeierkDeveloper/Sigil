// SQLite storage. Everything the server keeps lives in one file, and every
// column that holds user content holds ciphertext (see the privacy page for the
// full list of what is and is not encrypted).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 1;

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

-- Every request a connected app makes. leaf = Merkle leaf of the entry (salted).
CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read')),
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
  db.exec(SCHEMA);
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
