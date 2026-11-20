// The emergency card on the server: ciphertext under a key that lives only in
// the link's fragment, so the server cannot read the card it serves. Each
// opening is logged for the owner with the time, a device class and a
// language, and nothing that identifies who opened it.

import { coarseDevice, coarseLanguage } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const MAX_OPENS_KEPT = 200;

export interface EmergencyRow {
  id: string;
  ownerBox: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmergencyOpen {
  cardId: string;
  at: string;
  device: string;
  lang: string;
}

export function ownerCard(db: Db, userId: string): EmergencyRow | null {
  const r = db.prepare("SELECT id, owner_box, created_at, updated_at FROM emergency_cards WHERE user_id = ?").get(userId) as Row | undefined;
  return r ? { id: String(r.id), ownerBox: String(r.owner_box), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null;
}

export function cardOpens(db: Db, userId: string): EmergencyOpen[] {
  return (db.prepare("SELECT card_id, at, device, lang FROM emergency_opens WHERE user_id = ? ORDER BY at DESC LIMIT 50").all(userId) as Row[]).map((r) => ({
    cardId: String(r.card_id),
    at: String(r.at),
    device: String(r.device),
    lang: String(r.lang),
  }));
}

/** Publishes the card, or changes it under the same link. A new id is a re-issue: the old card is deleted, so its link opens nothing. */
export function putCard(db: Db, userId: string, input: { id: string; card: string; ownerBox: string }): EmergencyRow {
  return tx(db, () => {
    const have = ownerCard(db, userId);
    const at = now();
    if (have && have.id === input.id) {
      db.prepare("UPDATE emergency_cards SET card = ?, owner_box = ?, updated_at = ? WHERE id = ?").run(input.card, input.ownerBox, at, input.id);
      logRead(db, { appId: input.id, userId }, "emergency", "changed", 1);
    } else {
      if (db.prepare("SELECT 1 FROM emergency_cards WHERE id = ?").get(input.id)) throw new HttpError(409, "A card with this id already exists.");
      db.prepare("DELETE FROM emergency_cards WHERE user_id = ?").run(userId);
      db.prepare("INSERT INTO emergency_cards (id, user_id, card, owner_box, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.id, userId, input.card, input.ownerBox, at, at);
      logRead(db, { appId: input.id, userId }, "emergency", have ? "reissued" : "published", 1);
    }
    return ownerCard(db, userId)!;
  });
}

export function revokeCard(db: Db, userId: string): void {
  tx(db, () => {
    const have = ownerCard(db, userId);
    if (!have) throw new HttpError(404, "There is no emergency card.", "no_card");
    db.prepare("DELETE FROM emergency_cards WHERE user_id = ?").run(userId);
    logRead(db, { appId: have.id, userId }, "emergency", "revoked", 1);
  });
}

/** Serves the ciphertext to whoever has the link, and logs that it was opened. */
export function openPublicCard(db: Db, cardId: string, req: Pick<Request, "headers">): { card: string; updatedAt: string } {
  return tx(db, () => {
    const r = db.prepare("SELECT user_id, card, updated_at FROM emergency_cards WHERE id = ?").get(cardId) as Row | undefined;
    if (!r) throw new HttpError(404, "This emergency card was taken down or replaced by its owner.", "no_card");
    const userId = String(r.user_id);
    db.prepare("INSERT INTO emergency_opens (user_id, card_id, at, device, lang) VALUES (?, ?, ?, ?, ?)").run(
      userId,
      cardId,
      now(),
      coarseDevice(req.headers.get("user-agent")),
      coarseLanguage(req.headers.get("accept-language")),
    );
    db.prepare(
      `DELETE FROM emergency_opens WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM emergency_opens WHERE user_id = ? ORDER BY at DESC LIMIT ${MAX_OPENS_KEPT})`,
    ).run(userId, userId);
    logRead(db, { appId: cardId, userId }, "emergency", "opened", 1);
    return { card: String(r.card), updatedAt: String(r.updated_at) };
  });
}
