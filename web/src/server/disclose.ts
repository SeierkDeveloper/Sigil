// Proofs of a fact on the server. The vault signs a statement on the device
// and sends only its hash, which goes into the read log as a "disclose" entry;
// once that hour is sealed, the server hands back the entry's proof. A proof
// the owner chooses to share is kept whole and served by its link: it holds the
// one claim and its evidence, and nothing else from the vault.

import { DISCLOSE_APP, parseDisclosure, verifyDisclosure, type SealedEntry } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logEntry, logRead } from "./store";
import { proofFor, sealPending } from "./seal";
import { getSignKey, rootsFor } from "./life";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const MAX_DISCLOSURES = 200;
export const MAX_PROOF_BYTES = 256 * 1024;

export interface DisclosureRow {
  id: string;
  box: string;
  published: boolean;
  createdAt: string;
}

export function listDisclosures(db: Db, userId: string): DisclosureRow[] {
  return (db.prepare("SELECT id, box, published IS NOT NULL AS pub, created_at FROM disclosures WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    box: String(r.box),
    published: Number(r.pub) === 1,
    createdAt: String(r.created_at),
  }));
}

/** Writes the statement's hash into the log. The proof is complete once that hour is sealed. */
export function createDisclosure(db: Db, userId: string, input: { id: string; hash: string; box: string }): DisclosureRow {
  return tx(db, () => {
    if (!getSignKey(db, userId)) throw new HttpError(409, "This vault has no signing key yet. Reload the vault.", "no_sign_key");
    if (db.prepare("SELECT 1 FROM disclosures WHERE id = ?").get(input.id)) throw new HttpError(409, "A proof with this id already exists.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM disclosures WHERE user_id = ?").get(userId) as Row;
    if (Number(n.n) >= MAX_DISCLOSURES) throw new HttpError(400, `A vault keeps up to ${MAX_DISCLOSURES} proofs. Delete an older one first.`);
    const entry = logRead(db, { appId: DISCLOSE_APP, userId }, "disclose", input.hash, 1);
    db.prepare("INSERT INTO disclosures (id, user_id, entry_id, box, created_at) VALUES (?, ?, ?, ?, ?)").run(input.id, userId, entry.id, input.box, now());
    return { id: input.id, box: input.box, published: false, createdAt: now() };
  });
}

/** The sealed "disclose" entry with its proof, or null while its hour is not over. */
export function disclosureAnchor(db: Db, userId: string, id: string): SealedEntry | null {
  const r = db.prepare("SELECT entry_id FROM disclosures WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That proof was not found.", "no_proof");
  sealPending(db);
  const entry = logEntry(db, userId, String(r.entry_id));
  if (!entry) throw new HttpError(404, "The log entry of this proof is gone.", "no_entry");
  const p = proofFor(db, entry);
  if (!p) return null;
  return { id: entry.id, appId: entry.appId, kind: entry.kind, memoryId: entry.memoryId, count: entry.count, at: entry.at, salt: entry.salt, hour: p.hour, index: p.index, proof: p.proof, root: p.root };
}

/** Shares a complete proof by link, after checking it was made by this vault and is sealed. */
export async function publishDisclosure(db: Db, userId: string, id: string, text: string): Promise<void> {
  let d;
  try {
    d = parseDisclosure(text);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "invalid");
  }
  const row = db.prepare("SELECT entry_id FROM disclosures WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!row) throw new HttpError(404, "That proof was not found.", "no_proof");
  if (d.statement.signingKey !== getSignKey(db, userId)) throw new HttpError(400, "This proof was not made by this vault.", "invalid");
  if (!d.anchor || d.anchor.id !== String(row.entry_id)) throw new HttpError(400, "This proof is not sealed yet, or belongs to another entry.", "not_sealed");
  // The roots in the proof are compared with this node's own seals: a proof that made up its own roots is refused.
  sealPending(db);
  const published = async (hours: number[]) => new Map(Object.entries(rootsFor(db, hours)).map(([h, root]) => [Number(h), root]));
  const r = await verifyDisclosure(d, { published });
  if (!r.ok) throw new HttpError(400, "This proof does not check out against this node's seals.", "invalid");
  db.prepare("UPDATE disclosures SET published = ? WHERE id = ? AND user_id = ?").run(text, id, userId);
}

/** Keeps the completed proof (with its sealed entry) in the owner's encrypted copy. */
export function updateDisclosureBox(db: Db, userId: string, id: string, box: string): void {
  const r = db.prepare("UPDATE disclosures SET box = ? WHERE id = ? AND user_id = ?").run(box, id, userId);
  if (r.changes === 0) throw new HttpError(404, "That proof was not found.", "no_proof");
}

export function unpublishDisclosure(db: Db, userId: string, id: string): void {
  const r = db.prepare("UPDATE disclosures SET published = NULL WHERE id = ? AND user_id = ?").run(id, userId);
  if (r.changes === 0) throw new HttpError(404, "That proof was not found.", "no_proof");
}

export function deleteDisclosure(db: Db, userId: string, id: string): void {
  const r = db.prepare("DELETE FROM disclosures WHERE id = ? AND user_id = ?").run(id, userId);
  if (r.changes === 0) throw new HttpError(404, "That proof was not found.", "no_proof");
}

export function publishedDisclosure(db: Db, id: string): string {
  const r = db.prepare("SELECT published FROM disclosures WHERE id = ?").get(id) as Row | undefined;
  if (!r?.published) throw new HttpError(404, "There is no proof at this link. Its owner may have taken it down.", "no_proof");
  return String(r.published);
}

/** The vault's own sealed entry of joining a team space, for a membership claim. */
export function spaceJoinEntry(db: Db, userId: string, spaceId: string): SealedEntry | null {
  sealPending(db);
  const r = db.prepare("SELECT id FROM read_log WHERE user_id = ? AND kind = 'space' AND app_id = 'vault' AND memory_id = ? ORDER BY at LIMIT 1").get(userId, `joined-${spaceId}`) as Row | undefined;
  if (!r) return null;
  const entry = logEntry(db, userId, String(r.id));
  const p = entry ? proofFor(db, entry) : null;
  if (!entry || !p) return null;
  return { id: entry.id, appId: entry.appId, kind: entry.kind, memoryId: entry.memoryId, count: entry.count, at: entry.at, salt: entry.salt, hour: p.hour, index: p.index, proof: p.proof, root: p.root };
}
