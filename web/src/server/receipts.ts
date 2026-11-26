// Receipts of what the AI self did on its own, on the server: a fingerprint
// (a salted hash the server cannot read anything from) that joins the hourly
// seal like a read-log entry, and the receipt itself as an envelope under the
// vault key, so only the owner can read it, and share it if they choose.
// Nothing here can sign: the self key that signs receipts is on the owner's device.

import { tx, type Db } from "./db";
import { HttpError, hourOf, logRead } from "./store";
import { proofForLeaf } from "./seal";
import { serverConfig } from "./config";

type Row = Record<string, unknown>;

export const MAX_RECEIPTS = 10_000;

export interface ReceiptRow {
  id: string;
  leaf: string;
  hour: number;
  box: string;
  sealed: boolean;
  createdAt: string;
  /** Once sealed: the proof from the leaf to the hour's root. */
  seal: { hour: number; root: string; proof: string[]; periodSeconds: number } | null;
}

function toReceipt(db: Db, r: Row): ReceiptRow {
  const sealed = Number(r.sealed) === 1;
  const proof = sealed ? proofForLeaf(db, Number(r.hour), String(r.leaf)) : null;
  return {
    id: String(r.id),
    leaf: String(r.leaf),
    hour: Number(r.hour),
    box: String(r.box),
    sealed,
    createdAt: String(r.created_at),
    seal: proof ? { hour: proof.hour, root: proof.root, proof: proof.proof, periodSeconds: serverConfig.sealSeconds } : null,
  };
}

export function listReceipts(db: Db, userId: string): ReceiptRow[] {
  return (db.prepare("SELECT * FROM self_receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT 500").all(userId) as Row[]).map((r) => toReceipt(db, r));
}

/** Keeps a receipt the owner's device signed: its fingerprint joins this hour's seal. */
export function addReceipt(db: Db, userId: string, r: { id: string; leaf: string; box: string }, nowMs = Date.now()): ReceiptRow {
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM self_receipts WHERE id = ?").get(r.id)) throw new HttpError(409, "A receipt with this id already exists.");
    if (db.prepare("SELECT 1 FROM self_receipts WHERE user_id = ? AND leaf = ?").get(userId, r.leaf)) throw new HttpError(409, "This receipt is already kept.", "receipt_exists");
    const n = db.prepare("SELECT COUNT(*) AS n FROM self_receipts WHERE user_id = ?").get(userId) as Row;
    if (Number(n.n) >= MAX_RECEIPTS) throw new HttpError(400, `Up to ${MAX_RECEIPTS} receipts are kept. Delete old ones first.`, "too_many");
    const at = new Date(nowMs).toISOString();
    db.prepare("INSERT INTO self_receipts (id, user_id, leaf, hour, box, sealed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(r.id, userId, r.leaf, hourOf(nowMs), r.box, at);
    logRead(db, { appId: "self", userId }, "identity", "receipt", 1);
    return toReceipt(db, db.prepare("SELECT * FROM self_receipts WHERE id = ?").get(r.id) as Row);
  });
}

/** Deletes the owner's copy. A fingerprint already sealed stays in its seal, as every sealed leaf does. */
export function deleteReceipt(db: Db, userId: string, id: string): void {
  const r = db.prepare("DELETE FROM self_receipts WHERE id = ? AND user_id = ?").run(id, userId);
  if (Number(r.changes) === 0) throw new HttpError(404, "That receipt was not found.", "no_receipt");
}
