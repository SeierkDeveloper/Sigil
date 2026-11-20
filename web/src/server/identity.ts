// The AI self's identity on the server: the address of its self key and the
// latest identity statement, checked here (both signatures, the right keys)
// before it is kept and served. Nothing here can sign: the keys are on the
// owner's device. The wallet rules are an encrypted vault setting.

import { parseIdentityStatement, sameAddress, verifyIdentityStatement } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";
import { getSignKey } from "./life";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface IdentityRow {
  address: string;
  statement: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getIdentity(db: Db, userId: string): IdentityRow | null {
  const r = db.prepare("SELECT * FROM self_identities WHERE user_id = ?").get(userId) as Row | undefined;
  return r ? { address: String(r.address), statement: r.statement == null ? null : String(r.statement), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null;
}

/** Records the self key's address once. The same vault always derives the same key, so it never changes. */
export function setSelfKey(db: Db, userId: string, address: string): IdentityRow {
  return tx(db, () => {
    const have = getIdentity(db, userId);
    if (have) {
      if (!sameAddress(have.address, address)) throw new HttpError(409, "This vault already has a self key.", "self_exists");
      return have;
    }
    if (db.prepare("SELECT 1 FROM self_identities WHERE lower(address) = lower(?)").get(address)) throw new HttpError(409, "That self key is already in use.", "self_taken");
    const at = now();
    db.prepare("INSERT INTO self_identities (user_id, address, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, address, at, at);
    logRead(db, { appId: "self", userId }, "identity", "key-made", 1);
    return getIdentity(db, userId)!;
  });
}

/** Keeps a new identity statement, after checking it is signed by this vault's signing key and its self key. */
export function putStatement(db: Db, userId: string, text: string): IdentityRow {
  let st;
  try {
    st = parseIdentityStatement(text);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "invalid");
  }
  const have = getIdentity(db, userId);
  if (!have) throw new HttpError(409, "Make the self key first.", "no_self");
  if (!sameAddress(st.body.selfKey, have.address)) throw new HttpError(400, "This statement names another self key.", "invalid");
  if (st.body.signingKey !== getSignKey(db, userId)) throw new HttpError(400, "This statement is not signed by this vault.", "invalid");
  if (!verifyIdentityStatement(st).ok) throw new HttpError(400, "The statement's signatures do not check out.", "bad_signature");
  db.prepare("UPDATE self_identities SET statement = ?, updated_at = ? WHERE user_id = ?").run(text, now(), userId);
  logRead(db, { appId: "self", userId }, "identity", "statement-signed", 1);
  return getIdentity(db, userId)!;
}

export function withdrawStatement(db: Db, userId: string): void {
  db.prepare("UPDATE self_identities SET statement = NULL, updated_at = ? WHERE user_id = ?").run(now(), userId);
  logRead(db, { appId: "self", userId }, "identity", "statement-withdrawn", 1);
}

/** The public statement of a self key, the metadata the registry points at. */
export function publicStatement(db: Db, address: string): string {
  const r = db.prepare("SELECT statement FROM self_identities WHERE lower(address) = lower(?)").get(address) as Row | undefined;
  if (!r?.statement) throw new HttpError(404, "There is no identity statement for this self key.", "no_identity");
  return String(r.statement);
}
