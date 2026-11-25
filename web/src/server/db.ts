// SQLite storage. Everything the server keeps lives in one file, and every
// column that holds user content holds ciphertext (see the privacy page for the
// full list of what is and is not encrypted).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { trackVersions } from "./versions";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 9;

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

-- Protected folders: the server holds back their ciphertext from apps, agents
-- and links until the owner says yes for a read. What kind of folder it is
-- (health, money, legal) stays in the folder's encrypted meta.
CREATE TABLE IF NOT EXISTS protected_folders (
  user_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, folder_id),
  FOREIGN KEY (user_id, folder_id) REFERENCES folders(user_id, id) ON DELETE CASCADE
);

-- Requests to read a protected folder and the owner's answer. requester is an
-- app id, an ask link id, the public self's id, a meet id, or "self" for the
-- owner's own test chat. memory_ids is a JSON list; empty means the folder's
-- list of memories (scope index). An approval is good for one read, for a few
-- minutes.
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester TEXT NOT NULL,
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('app', 'link', 'public', 'meet', 'self')),
  folder_id TEXT NOT NULL,
  memory_ids TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'index')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'used')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_requests_by_user ON access_requests (user_id, state, created_at);

-- Live sync sources. owner_box is the source (service, tokens, cursor) under
-- the vault key; app_box the same under a key from the secret of the connector
-- the owner lets sync in the background. Each carries a revision so the newer
-- copy wins. Deleting the row deletes the stored tokens.
CREATE TABLE IF NOT EXISTS sync_sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  owner_box TEXT NOT NULL,
  owner_rev INTEGER NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  app_box TEXT,
  app_rev INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id, folder_id) REFERENCES folders(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sync_sources_by_app ON sync_sources (app_id);

-- The public AI self: a page at /@handle. owner_box is its X25519 private key
-- and rules under the vault key; app_box the same for a connector that answers
-- it. public_items is the plain public copy of the folders made public, the
-- only thing it answers from. public_wall holds answered questions the owner
-- lets the page show, until hidden.
CREATE TABLE IF NOT EXISTS public_selves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  greeting TEXT NOT NULL,
  public_key TEXT NOT NULL,
  owner_box TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  app_box TEXT,
  per_visitor_hour INTEGER NOT NULL,
  show_answers INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  copy_hash TEXT,
  published_at TEXT,
  agent_seen_at INTEGER,
  asked INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_items (
  self_id TEXT NOT NULL REFERENCES public_selves(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  PRIMARY KEY (self_id, id)
);
CREATE TABLE IF NOT EXISTS public_questions (
  id TEXT PRIMARY KEY,
  self_id TEXT NOT NULL REFERENCES public_selves(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  session_id TEXT NOT NULL,
  asker_key TEXT NOT NULL,
  sealed TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS public_questions_by_self ON public_questions (self_id, answered_at, created_at);
CREATE INDEX IF NOT EXISTS public_questions_by_visitor ON public_questions (self_id, visitor, created_at);
CREATE TABLE IF NOT EXISTS public_wall (
  id TEXT PRIMARY KEY,
  self_id TEXT NOT NULL REFERENCES public_selves(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS public_wall_by_self ON public_wall (self_id, created_at);

-- Selves meet selves: two vaults whose AI selves talk, after both said yes.
-- invite is sealed to the invitee, answer to the inviter; each side's own
-- record (purpose, folders, label) is under its own vault key. Messages are
-- encrypted under a key only the two vaults can derive.
CREATE TABLE IF NOT EXISTS meets (
  id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_key TEXT NOT NULL,
  invitee_key TEXT NOT NULL,
  turn_limit INTEGER NOT NULL,
  invite TEXT NOT NULL,
  answer TEXT,
  inviter_box TEXT NOT NULL,
  invitee_box TEXT,
  state TEXT NOT NULL CHECK (state IN ('invited', 'running', 'done', 'stopped', 'declined')),
  turns INTEGER NOT NULL DEFAULT 0,
  stopped_by TEXT,
  inviter_seen_at INTEGER,
  invitee_seen_at INTEGER,
  inviter_removed INTEGER NOT NULL DEFAULT 0,
  invitee_removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meets_by_inviter ON meets (inviter_id);
CREATE INDEX IF NOT EXISTS meets_by_invitee ON meets (invitee_id);
CREATE TABLE IF NOT EXISTS meet_messages (
  meet_id TEXT NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  box TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (meet_id, turn)
);

-- The AI self's identity: the address of its self key (derived on the owner's
-- device; public by nature) and the latest identity statement signed by the
-- vault key and the self key, which anyone may read at /api/identity/<address>.
CREATE TABLE IF NOT EXISTS self_identities (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  statement TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Drafts of the AI self waiting for the owner: replies, plans and answers.
-- box is the draft under the vault key. ref names what an answer answers (a
-- question, a turn) so the open vault never drafts it twice; it is an id the
-- server already knows.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'plan', 'answer')),
  ref TEXT,
  box TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, ref)
);
CREATE INDEX IF NOT EXISTS drafts_by_user ON drafts (user_id, state, created_at);

-- Proofs of a fact. entry_id is the "disclose" log entry that carries the
-- signed statement's hash; box is the proof under the vault key; published is
-- the complete proof, only when the owner shares it by link.
CREATE TABLE IF NOT EXISTS disclosures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  box TEXT NOT NULL,
  published TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS disclosures_by_user ON disclosures (user_id, created_at);

-- The emergency card: ciphertext under a key that lives only in the link's
-- fragment, which the server never receives. owner_box is that key and the
-- card under the vault key. One card per vault; re-issuing replaces it.
CREATE TABLE IF NOT EXISTS emergency_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  owner_box TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Each opening of the card, for its owner: the time, a device class and a
-- language. No address, no cookie, no identifier. Kept after a card is revoked.
CREATE TABLE IF NOT EXISTS emergency_opens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  at TEXT NOT NULL,
  device TEXT NOT NULL,
  lang TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS emergency_opens_by_user ON emergency_opens (user_id, at);

-- Sealed agreements between two vaults. offer is the document and the first
-- signature, sealed to the second vault; each side's own copy is under its own
-- vault key. The server sees the hash, the keys and the signatures, which it
-- checks against the vaults' signing keys; never the text. A signed agreement
-- is never changed: an amendment is a new row whose previous is the old hash.
-- A party that deletes its vault leaves the row to the other party (its id
-- becomes null), so nobody can erase the other side's signed record.
CREATE TABLE IF NOT EXISTS agreements (
  id TEXT PRIMARY KEY,
  from_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  previous TEXT,
  offer TEXT NOT NULL,
  from_box TEXT NOT NULL,
  to_box TEXT,
  from_sig TEXT NOT NULL,
  to_sig TEXT,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'signed', 'declined', 'withdrawn')),
  from_removed INTEGER NOT NULL DEFAULT 0,
  to_removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  signed_at TEXT
);
CREATE INDEX IF NOT EXISTS agreements_by_from ON agreements (from_id);
CREATE INDEX IF NOT EXISTS agreements_by_to ON agreements (to_id);

-- Knowledge packs: public, signed by the publisher's vault key. body is the
-- whole signed pack of the latest version; every version is kept.
CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  sign_key TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS packs_by_user ON packs (user_id);
CREATE TABLE IF NOT EXISTS pack_versions (
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pack_id, version)
);

-- Backups: each bundle the owner's device or connector made and stored. record
-- says where it went (object keys, content ids), sealed to the vault public key.
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  by_app TEXT,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backup_runs_by_user ON backup_runs (user_id, created_at);

-- A connector the owner lets back the vault up while it watches: the storage
-- targets and their tokens, under a key from that app's own secret.
CREATE TABLE IF NOT EXISTS backup_apps (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  box TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The nodes a vault came from (role previous) and, on the node it left, the
-- node it went to (role next). arrival is what the new node sends the old one,
-- kept until the old node confirmed it.
CREATE TABLE IF NOT EXISTS vault_nodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('previous', 'next')),
  move_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'confirmed')),
  arrival TEXT,
  since TEXT NOT NULL,
  until TEXT
);
CREATE INDEX IF NOT EXISTS vault_nodes_by_user ON vault_nodes (user_id, since);

-- Moves out of this node: the statement the owner's device signed, the bundle
-- that goes with it, and a hash of the secret the new node fetches it with.
CREATE TABLE IF NOT EXISTS moves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_origin TEXT NOT NULL,
  statement TEXT NOT NULL,
  signature TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  bundle TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('signed', 'sent', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS moves_by_user ON moves (user_id, created_at);

-- Addresses of a vault that moved away, sent on to its new node until "until".
-- Kept apart from the account, which is deleted when the period ends.
CREATE TABLE IF NOT EXISTS moved (
  kind TEXT NOT NULL CHECK (kind IN ('vault', 'ask', 'public', 'pack', 'emergency')),
  ref TEXT NOT NULL,
  to_origin TEXT NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Capture keys: one per device or shortcut, write-only into the inbox. note is
-- the owner's name for it under the vault key; tag vouches for the vault key.
CREATE TABLE IF NOT EXISTS capture_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE,
  tag TEXT NOT NULL,
  note TEXT NOT NULL,
  plain INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS capture_keys_by_user ON capture_keys (user_id);

-- Sessions with the public AI self: the owner's offer (public), the bookings
-- (the intake sealed to the public self's key), each turn's note sealed to the
-- vault public key for the owner's transcript, and visitors the owner blocked.
CREATE TABLE IF NOT EXISTS session_offers (
  self_id TEXT PRIMARY KEY REFERENCES public_selves(id) ON DELETE CASCADE,
  offer TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_bookings (
  id TEXT PRIMARY KEY,
  self_id TEXT NOT NULL REFERENCES public_selves(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  turns INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  intake TEXT NOT NULL,
  consent TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  asker_key TEXT NOT NULL,
  visitor TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('booked', 'ended', 'blocked')),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (self_id, slot_start)
);
CREATE INDEX IF NOT EXISTS session_bookings_by_user ON session_bookings (user_id, slot_start);
CREATE TABLE IF NOT EXISTS session_turns (
  booking_id TEXT NOT NULL REFERENCES session_bookings(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (booking_id, turn)
);
CREATE TABLE IF NOT EXISTS session_blocks (
  self_id TEXT NOT NULL REFERENCES public_selves(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (self_id, visitor)
);

-- Heirs of a shared memory: dormant members, sealed and tagged by an admin's
-- device, made members when the legacy plan of the member they are named for
-- (or of any member, when for_member is null) releases.
CREATE TABLE IF NOT EXISTS space_heirs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  sealed_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  label TEXT NOT NULL,
  for_member TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (space_id, public_key)
);

-- The immune system's public test: one record per hour (each strain, how it
-- varied, whether it was held and by what). Its leaf joins that hour's seal.
CREATE TABLE IF NOT EXISTS immune_records (
  hour INTEGER PRIMARY KEY,
  record TEXT NOT NULL,
  leaf TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
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
// another vault opens a folder shared with it, every question the AI self
// answers, every read of a protected folder and the owner's answer to it, and
// every step of a conversation between two AI selves, and the steps of the AI
// self's identity, its work, proofs of facts, the emergency card, agreements and
// knowledge packs, backups, moves between nodes, captures and sessions. leaf =
// Merkle leaf of the entry (salted). note, for answers only, is the question and
// answer sealed to the vault's public key. carried, for an entry that came with a
// bundle from another node, is where it was sealed there and its proof.
const READ_LOG = `
CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read', 'propose', 'shared', 'ask', 'legacy', 'device', 'presence', 'remember', 'forget', 'handoff', 'space', 'protected', 'approval', 'public', 'meet', 'sync', 'identity', 'work', 'disclose', 'emergency', 'agreement', 'pack', 'backup', 'node', 'capture', 'session', 'injection')),
  memory_id TEXT,
  count INTEGER NOT NULL,
  at TEXT NOT NULL,
  salt TEXT NOT NULL,
  leaf TEXT NOT NULL,
  hour INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  carried TEXT
);
CREATE INDEX IF NOT EXISTS read_log_by_user ON read_log (user_id, at);
CREATE INDEX IF NOT EXISTS read_log_unsealed ON read_log (sealed, hour);
CREATE INDEX IF NOT EXISTS read_log_by_app ON read_log (app_id, kind, at);
CREATE INDEX IF NOT EXISTS read_log_by_kind ON read_log (user_id, kind, hour);
`;

/** Older versions allowed fewer kinds in the log and had no notes. Rebuild the table, keeping every row. */
function migrateReadLog(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_log'").get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'injection'")) return;
  const hasNote = row.sql.includes("note TEXT");
  const hasCarried = row.sql.includes("carried TEXT");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE read_log RENAME TO read_log_old");
    db.exec("DROP INDEX IF EXISTS read_log_by_user");
    db.exec("DROP INDEX IF EXISTS read_log_unsealed");
    db.exec("DROP INDEX IF EXISTS read_log_by_app");
    db.exec("DROP INDEX IF EXISTS read_log_by_kind");
    db.exec(READ_LOG);
    const cols = `id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed${hasNote ? ", note" : ""}${hasCarried ? ", carried" : ""}`;
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

/** Agreements once went with either party's account. Now a party's id becomes null and the other keeps the row. Rebuild it, keeping every row. */
function migrateAgreements(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agreements'").get() as { sql?: string } | undefined;
  if (!row?.sql || !row.sql.includes("from_id TEXT NOT NULL")) return;
  const create = SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS agreements ("), SCHEMA.indexOf(");", SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS agreements (")) + 2);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE agreements RENAME TO agreements_old");
    db.exec(create);
    db.exec("INSERT INTO agreements SELECT * FROM agreements_old");
    db.exec("DROP TABLE agreements_old");
    db.exec("CREATE INDEX IF NOT EXISTS agreements_by_from ON agreements (from_id); CREATE INDEX IF NOT EXISTS agreements_by_to ON agreements (to_id);");
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
    // Reads come from memory where they can: the file is mapped (256 MB) and the
    // page cache holds 32 MB. Durability is unchanged: every commit still
    // reaches the disk before the request is answered (synchronous stays FULL).
    db.exec("PRAGMA mmap_size = 268435456;");
  }
  db.exec("PRAGMA cache_size = -32768;");
  db.exec("PRAGMA temp_store = MEMORY;");
  cacheStatements(db);
  migrateReadLog(db);
  migrateKeyslots(db);
  db.exec(SCHEMA.replace("READ_LOG_TABLE", READ_LOG));
  migrateAgreements(db);
  trackChanges(db);
  addColumn(db, "memories", "delete_after", "TEXT");
  // Versions of agents' own folders (pinned versions): needs agents and memories, both made above.
  trackVersions(db);
  // The last sign-in or vault action of the owner: the legacy plan's heartbeat.
  addColumn(db, "users", "last_active_at", "TEXT");
  // Which key slot a session was opened with, so revoking a device ends its sessions.
  addColumn(db, "sessions", "keyslot_id", "TEXT");
  // Whether an app may write a folder (agents) or only read it.
  addColumn(db, "grants", "mode", "TEXT NOT NULL DEFAULT 'read'");
  // Round seven: shared memories keep their kind in the clear, a vault that moved away points to its new node,
  // public questions may belong to a booked session, and the public page and ask links may offer voice.
  addColumn(db, "spaces", "kind", "TEXT NOT NULL DEFAULT 'team'");
  addColumn(db, "users", "moved_to", "TEXT");
  addColumn(db, "users", "delete_at", "TEXT");
  addColumn(db, "public_questions", "booking_id", "TEXT");
  addColumn(db, "public_selves", "voice", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "ask_links", "voice", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "legacy_plans", "release_hash", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS memories_to_delete ON memories (delete_after) WHERE delete_after IS NOT NULL;");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  // Fresh planner statistics for the tables that changed since the last start.
  db.exec("PRAGMA optimize = 0x10002;");
  return db;
}

/**
 * A counter per vault that moves whenever something an open vault shows is
 * written by anyone: memories and folders (an agent remembering, an app
 * writing, another device), inbox suggestions, apps and agents. Kept by the
 * database itself (triggers), so no write path can forget it. An open vault
 * asks for it every half minute and reloads only when it moved.
 */
function trackChanges(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS vault_changes (user_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;");
  const bump = (who: string) => `INSERT INTO vault_changes (user_id, n) VALUES (${who}.user_id, 1) ON CONFLICT (user_id) DO UPDATE SET n = n + 1;`;
  const watch: [string, string, string][] = [
    ["memories", "INSERT", "NEW"],
    ["memories", "UPDATE", "NEW"],
    ["memories", "DELETE", "OLD"],
    ["folders", "INSERT", "NEW"],
    ["folders", "UPDATE", "NEW"],
    ["folders", "DELETE", "OLD"],
    ["proposals", "INSERT", "NEW"],
    ["proposals", "DELETE", "OLD"],
    ["agents", "INSERT", "NEW"],
    ["agents", "UPDATE", "NEW"],
    ["agents", "DELETE", "OLD"],
    ["apps", "INSERT", "NEW"],
    // An app's last use is written on every call; only what the vault shows of it counts.
    ["apps", "UPDATE OF meta, revoked_at", "NEW"],
    ["apps", "DELETE", "OLD"],
  ];
  for (const [table, event, row] of watch) {
    const name = `changes_${table}_${event.split(" ")[0].toLowerCase()}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN ${bump(row)} END;`);
  }
}

/**
 * What an open vault compares to see whether anything changed: the vault's
 * counter and the newest line of its read log. Two indexed lookups; it writes
 * nothing, and it does not count as the owner being active.
 */
export function vaultStamp(db: Db, userId: string): { vault: number; log: string } {
  const v = db.prepare("SELECT n FROM vault_changes WHERE user_id = ?").get(userId) as { n: number } | undefined;
  const l = db.prepare("SELECT at, id FROM read_log WHERE user_id = ? ORDER BY at DESC LIMIT 1").get(userId) as { at: string; id: string } | undefined;
  return { vault: Number(v?.n ?? 0), log: l ? `${l.at}/${l.id}` : "" };
}

/** How many compiled statements one database keeps. The queries in the code are far fewer; the limit only matters for SQL built at run time. */
const STATEMENTS_KEPT = 512;

/**
 * Every query is compiled once and the compiled statement is reused, instead
 * of being compiled again on every request. Statements run synchronously, so
 * one is never in use twice at the same time.
 */
function cacheStatements(db: Db): void {
  const compile = db.prepare.bind(db);
  const kept = new Map<string, StatementSync>();
  db.prepare = ((sql: string) => {
    let st = kept.get(sql);
    if (!st) {
      st = compile(sql);
      if (kept.size >= STATEMENTS_KEPT) kept.delete(kept.keys().next().value as string);
      kept.set(sql, st);
    }
    return st;
  }) as Db["prepare"];
}

/**
 * Hourly upkeep: sign-in sessions and login challenges that ran out are
 * deleted, the planner's statistics are refreshed, and the write-ahead log is
 * folded back into the database file so it does not keep growing.
 */
export function housekeeping(db: Db, at = Date.now()): { sessions: number; challenges: number } {
  const sessions = Number(db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(at).changes);
  const challenges = Number(db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(at).changes);
  db.prepare("DELETE FROM vault_changes WHERE user_id NOT IN (SELECT id FROM users)").run();
  db.exec("PRAGMA optimize;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  return { sessions, challenges };
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
