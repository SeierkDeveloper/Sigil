// Sealed agreements on the server. One vault sends a draft, sealed to the
// other vault's box key, with its own signature over the hash; the other vault
// opens it on its device, checks it, and signs the same hash. The server checks
// each signature against the signing key that vault registered, and keeps the
// hash, the keys and the signatures; never the text. Once both signed, the hash
// is written into both read logs, and so into both vaults' hourly seals. A
// signed agreement has no route that changes it.

import { verifyAgreementSignature, type SealedEntry } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logEntry, logRead } from "./store";
import { userByBoxKey, getBoxKey } from "./inbox";
import { getSignKey } from "./life";
import { proofFor, sealPending } from "./seal";

type Row = Record<string, unknown>;

export const OFFERS_PER_HOUR = 20;
export type AgreementState = "proposed" | "signed" | "declined" | "withdrawn";

export interface AgreementView {
  id: string;
  role: "from" | "to";
  myKey: string;
  peerKey: string;
  /** The signing keys the server holds for both vaults, for the device to compare with the document. */
  mySignKey: string | null;
  peerSignKey: string | null;
  hash: string;
  version: number;
  previous: string | null;
  offer: string;
  /** This side's own copy, under its vault key. */
  box: string | null;
  fromSig: string;
  toSig: string | null;
  state: AgreementState;
  createdAt: string;
  signedAt: string | null;
}

function view(db: Db, r: Row, userId: string): AgreementView {
  const role = String(r.from_id) === userId ? "from" : "to";
  const peerId = role === "from" ? String(r.to_id) : String(r.from_id);
  return {
    id: String(r.id),
    role,
    myKey: String(role === "from" ? r.from_key : r.to_key),
    peerKey: String(role === "from" ? r.to_key : r.from_key),
    mySignKey: getSignKey(db, userId),
    peerSignKey: getSignKey(db, peerId),
    hash: String(r.hash),
    version: Number(r.version),
    previous: r.previous == null ? null : String(r.previous),
    offer: String(r.offer),
    box: (role === "from" ? r.from_box : r.to_box) == null ? null : String(role === "from" ? r.from_box : r.to_box),
    fromSig: String(r.from_sig),
    toSig: r.to_sig == null ? null : String(r.to_sig),
    state: r.state as AgreementState,
    createdAt: String(r.created_at),
    signedAt: r.signed_at == null ? null : String(r.signed_at),
  };
}

function mine(db: Db, userId: string, id: string): Row {
  const r = db.prepare("SELECT * FROM agreements WHERE id = ? AND (from_id = ? OR to_id = ?)").get(id, userId, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That agreement was not found.", "no_agreement");
  return r;
}

export function listAgreements(db: Db, userId: string): AgreementView[] {
  return (
    db.prepare("SELECT * FROM agreements WHERE (from_id = ? AND from_removed = 0) OR (to_id = ? AND to_removed = 0) ORDER BY created_at DESC LIMIT 200").all(userId, userId) as Row[]
  ).map((r) => view(db, r, userId));
}

/** The other vault's signing key, by its vault code's key: the device puts it in the document and the other side checks it is its own. */
export function peerSigningKey(db: Db, boxKey: string): string {
  const peer = userByBoxKey(db, boxKey);
  if (!peer) throw new HttpError(404, "No vault on this site has that vault code.", "no_vault");
  const key = getSignKey(db, peer);
  if (!key) throw new HttpError(409, "That vault has not opened since signing keys came in. Ask them to open their vault once.", "no_sign_key");
  return key;
}

export interface OfferInput {
  id: string;
  toKey: string;
  hash: string;
  version: number;
  previous: string | null;
  offer: string;
  box: string;
  signature: string;
}

export function proposeAgreement(db: Db, userId: string, input: OfferInput, at = new Date()): AgreementView {
  return tx(db, () => {
    const me = getBoxKey(db, userId);
    const signKey = getSignKey(db, userId);
    if (!me || !signKey) throw new HttpError(409, "Your vault has no keys yet. Reload it and try again.", "no_keys");
    const peer = userByBoxKey(db, input.toKey);
    if (!peer) throw new HttpError(404, "No vault on this site has that vault code.", "no_vault");
    if (peer === userId) throw new HttpError(400, "That is your own vault code.", "self");
    if (db.prepare("SELECT 1 FROM agreements WHERE id = ? OR hash = ?").get(input.id, input.hash)) throw new HttpError(409, "This agreement was already sent.", "exists");
    if (!verifyAgreementSignature(signKey, input.hash, input.signature)) throw new HttpError(400, "Your signature does not check out.", "bad_signature");
    if (input.previous) {
      const prev = db.prepare("SELECT * FROM agreements WHERE hash = ? AND state = 'signed'").get(input.previous) as Row | undefined;
      const sameParties = prev && [String(prev.from_id), String(prev.to_id)].sort().join() === [userId, peer].sort().join();
      if (!prev || !sameParties) throw new HttpError(400, "An amendment must follow an agreement both of you signed.", "no_previous");
      if (input.version !== Number(prev.version) + 1) throw new HttpError(400, "An amendment is the next version.", "version");
      if (db.prepare("SELECT 1 FROM agreements WHERE previous = ? AND state IN ('proposed', 'signed')").get(input.previous)) throw new HttpError(409, "That agreement already has an amendment.", "amended");
    } else if (input.version !== 1) throw new HttpError(400, "A new agreement is version 1.", "version");
    const recent = db.prepare("SELECT COUNT(*) AS n FROM agreements WHERE from_id = ? AND created_at > ?").get(userId, new Date(at.getTime() - 3600_000).toISOString()) as Row;
    if (Number(recent.n) >= OFFERS_PER_HOUR) throw new HttpError(429, `A vault may send ${OFFERS_PER_HOUR} agreements an hour.`, "limit");
    db.prepare(
      `INSERT INTO agreements (id, from_id, to_id, from_key, to_key, hash, version, previous, offer, from_box, from_sig, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
    ).run(input.id, userId, peer, me.publicKey, input.toKey, input.hash, input.version, input.previous, input.offer, input.box, input.signature, at.toISOString());
    for (const u of [userId, peer]) logRead(db, { appId: input.id, userId: u }, "agreement", `proposed-${input.id}`, 1, at);
    return view(db, mine(db, userId, input.id), userId);
  });
}

/** The second vault signs the same hash. Both logs get the hash, and with the hour's end both seals do. */
export function signAgreementRow(db: Db, userId: string, id: string, input: { signature: string; box: string }, at = new Date()): AgreementView {
  return tx(db, () => {
    const r = mine(db, userId, id);
    if (String(r.to_id) !== userId) throw new HttpError(403, "Only the vault it was sent to signs it.", "not_recipient");
    if (r.state !== "proposed") throw new HttpError(409, "This agreement is no longer open for signing.", "closed");
    const key = getSignKey(db, userId);
    if (!key || !verifyAgreementSignature(key, String(r.hash), input.signature)) throw new HttpError(400, "Your signature does not check out.", "bad_signature");
    db.prepare("UPDATE agreements SET to_sig = ?, to_box = ?, state = 'signed', signed_at = ? WHERE id = ?").run(input.signature, input.box, at.toISOString(), id);
    for (const u of [String(r.from_id), userId]) logRead(db, { appId: id, userId: u }, "agreement", String(r.hash), 2, at);
    return view(db, mine(db, userId, id), userId);
  });
}

export function declineAgreement(db: Db, userId: string, id: string): void {
  tx(db, () => {
    const r = mine(db, userId, id);
    if (r.state !== "proposed") throw new HttpError(409, "This agreement is no longer open.", "closed");
    const step = String(r.to_id) === userId ? "declined" : "withdrawn";
    db.prepare("UPDATE agreements SET state = ? WHERE id = ?").run(step, id);
    for (const u of [String(r.from_id), String(r.to_id)]) logRead(db, { appId: id, userId: u }, "agreement", `${step}-${id}`, 1);
  });
}

/** Removes an agreement from this side's list. A signed one stays for the other side, and in both seals. */
export function removeAgreement(db: Db, userId: string, id: string): void {
  tx(db, () => {
    const r = mine(db, userId, id);
    if (r.state === "proposed") throw new HttpError(409, "Withdraw or decline it first.", "open");
    const role = String(r.from_id) === userId ? "from" : "to";
    db.prepare(`UPDATE agreements SET ${role}_removed = 1 WHERE id = ?`).run(id);
    db.prepare("DELETE FROM agreements WHERE id = ? AND from_removed = 1 AND to_removed = 1").run(id);
  });
}

/** This vault's sealed entry of a signed agreement, with its proof, for a verifiable copy. Null until the hour is sealed. */
export function agreementSeal(db: Db, userId: string, id: string): SealedEntry | null {
  const r = mine(db, userId, id);
  if (r.state !== "signed") throw new HttpError(409, "Only a signed agreement is sealed.", "not_signed");
  sealPending(db);
  const e = db.prepare("SELECT id FROM read_log WHERE user_id = ? AND kind = 'agreement' AND app_id = ? AND memory_id = ?").get(userId, id, String(r.hash)) as Row | undefined;
  const entry = e ? logEntry(db, userId, String(e.id)) : null;
  const p = entry ? proofFor(db, entry) : null;
  if (!entry || !p) return null;
  return { id: entry.id, appId: entry.appId, kind: entry.kind, memoryId: entry.memoryId, count: entry.count, at: entry.at, salt: entry.salt, hour: p.hour, index: p.index, proof: p.proof, root: p.root };
}
