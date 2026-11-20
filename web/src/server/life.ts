// Proof of a real life on the server: the vault's signing key, one presence
// entry per seal period while the vault is open, the sealed presence history
// with its proofs, and certificates the owner publishes by link.

import { fromHex32, hex32, merkleProof, parseCertificate, PRESENCE_APP, verifyPresence, type CertificateHour } from "@sigil/core";
import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { hourOf, HttpError, logRead } from "./store";
import { sealPending } from "./seal";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export function getSignKey(db: Db, userId: string): string | null {
  const r = db.prepare("SELECT public_key FROM sign_keys WHERE user_id = ?").get(userId) as Row | undefined;
  return r ? String(r.public_key) : null;
}

/** A vault registers its signing key once. It is never replaced, so old presence keeps its meaning. */
export function setSignKey(db: Db, userId: string, publicKey: string): void {
  const have = getSignKey(db, userId);
  if (have === publicKey) return;
  if (have) throw new HttpError(409, "This vault already has a signing key.", "sign_exists");
  if (db.prepare("SELECT 1 FROM sign_keys WHERE public_key = ?").get(publicKey)) throw new HttpError(409, "That signing key is already in use.", "sign_taken");
  db.prepare("INSERT INTO sign_keys (user_id, public_key, created_at) VALUES (?, ?, ?)").run(userId, publicKey, now());
}

function presenceIn(db: Db, userId: string, hour: number): boolean {
  return !!db.prepare("SELECT 1 FROM read_log WHERE user_id = ? AND kind = 'presence' AND hour = ?").get(userId, hour);
}

/** What the vault signs this period, and whether it already did. */
export function presenceTask(db: Db, userId: string, origin: string, at = Date.now()) {
  const hour = hourOf(at);
  return { hour, periodSeconds: serverConfig.sealSeconds, origin, done: presenceIn(db, userId, hour), signingKey: getSignKey(db, userId) };
}

/** Records the vault's signed presence for the current period, once. */
export function recordPresence(db: Db, userId: string, origin: string, hour: number, sig: string, at = new Date()): { recorded: boolean } {
  return tx(db, () => {
    const key = getSignKey(db, userId);
    if (!key) throw new HttpError(400, "This vault has no signing key yet. Reload the vault.", "no_sign_key");
    const current = hourOf(at.getTime());
    if (hour !== current) throw new HttpError(409, "That period is over. Sign the current one.", "stale");
    if (!verifyPresence(key, origin, hour, serverConfig.sealSeconds, sig)) throw new HttpError(400, "The signature does not check out.", "bad_signature");
    if (presenceIn(db, userId, hour)) return { recorded: false };
    logRead(db, { appId: PRESENCE_APP, userId }, "presence", sig, 1, at);
    return { recorded: true };
  });
}

export function presenceCounts(db: Db, userId: string) {
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(sealed), 0) AS sealed, MIN(hour) AS first, MAX(hour) AS last FROM read_log WHERE user_id = ? AND kind = 'presence'").get(userId) as Row;
  return { total: Number(r.n), sealed: Number(r.sealed), firstHour: r.first == null ? null : Number(r.first), lastHour: r.last == null ? null : Number(r.last) };
}

export const MAX_CERT_HOURS = 20_000;

/** Every sealed presence hour of this vault with the proof up to that hour's root, for a certificate made on the device. */
export function presenceProofs(db: Db, userId: string): CertificateHour[] {
  sealPending(db);
  const rows = db
    .prepare("SELECT r.id, r.at, r.salt, r.memory_id, r.hour, r.leaf, s.root FROM read_log r JOIN seals s ON s.hour = r.hour WHERE r.user_id = ? AND r.kind = 'presence' AND r.sealed = 1 ORDER BY r.hour DESC LIMIT ?")
    .all(userId, MAX_CERT_HOURS) as Row[];
  const leavesOf = db.prepare("SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx");
  return rows
    .map((r) => {
      const leaves = (leavesOf.all(Number(r.hour)) as Row[]).map((x) => String(x.leaf));
      const index = leaves.indexOf(String(r.leaf));
      if (index < 0) return null;
      return {
        hour: Number(r.hour),
        entry: { id: String(r.id), at: String(r.at), salt: String(r.salt), sig: String(r.memory_id) },
        index,
        proof: merkleProof(leaves.map(fromHex32), index).map(hex32),
        root: String(r.root),
      };
    })
    .filter((x): x is CertificateHour => !!x)
    .sort((a, b) => a.hour - b.hour);
}

// ---------------------------------------------------------------- published certificates

export const MAX_CERT_BYTES = 8 * 1024 * 1024;

export function publishCertificate(db: Db, userId: string, id: string, text: string): { id: string } {
  let cert;
  try {
    cert = parseCertificate(text);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "invalid");
  }
  if (cert.body.signingKey !== getSignKey(db, userId)) throw new HttpError(400, "This certificate was not made by this vault.", "invalid");
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM certificates WHERE id = ?").get(id)) throw new HttpError(409, "A certificate with this id already exists.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?").get(userId) as Row;
    if (Number(n.n) >= 20) throw new HttpError(400, "A vault can publish up to 20 certificates. Remove an older one first.");
    const s = cert.body.summary;
    const summary = JSON.stringify({ from: s.from, to: s.to, activeHours: s.activeHours, activeDays: s.activeDays, continuousMonths: s.continuousMonths });
    db.prepare("INSERT INTO certificates (id, user_id, body, size, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, text, text.length, summary, now());
    return { id };
  });
}

export function getCertificate(db: Db, id: string): string {
  const r = db.prepare("SELECT body FROM certificates WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new HttpError(404, "There is no certificate at this link. Its owner may have taken it down.", "no_certificate");
  return String(r.body);
}

export function listCertificates(db: Db, userId: string) {
  return (db.prepare("SELECT id, size, summary, created_at FROM certificates WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[]).map((r) => ({
    id: String(r.id),
    size: Number(r.size),
    summary: JSON.parse(String(r.summary)) as { from: string; to: string; activeHours: number; activeDays: number; continuousMonths: number },
    createdAt: String(r.created_at),
  }));
}

export function deleteCertificate(db: Db, userId: string, id: string): void {
  const r = db.prepare("DELETE FROM certificates WHERE id = ? AND user_id = ?").run(id, userId);
  if (r.changes === 0) throw new HttpError(404, "That certificate was not found.");
}

/** Published roots for many hours at once, for checking a certificate. */
export function rootsFor(db: Db, hours: number[]): Record<string, string> {
  const q = db.prepare("SELECT root FROM seals WHERE hour = ?");
  const out: Record<string, string> = {};
  for (const h of hours) {
    const r = q.get(h) as Row | undefined;
    if (r) out[String(h)] = String(r.root);
  }
  return out;
}
