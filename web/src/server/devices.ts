// Adding a device by QR code, and the devices that may open the vault.
//
// The relay keeps one sealed box per pairing for at most ten minutes and hands
// it only to the device holding the poll secret, once. The box is sealed to a
// one-time key made on the new device; the server cannot open it.

import { pairingCode, PAIRING_MINUTES, tokenHash, isBoxPublicKey } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, insertKeyslot, logRead, type KeyslotInput } from "./store";

type Row = Record<string, unknown>;

/** The read log's app id for device steps. */
export const DEVICE_APP = "devices";

function clean(db: Db, at = Date.now()): void {
  db.prepare("DELETE FROM device_pairings WHERE expires_at < ?").run(at);
}

/** The new device opens a pairing: its one-time public key, the code made from it, and a hash of its poll secret. */
export function openPairing(db: Db, p: { id: string; publicKey: string; code: string; pollSecret: string }, at = Date.now()): { expiresAt: string } {
  return tx(db, () => {
    clean(db, at);
    if (!isBoxPublicKey(p.publicKey) || pairingCode(p.publicKey) !== p.code) throw new HttpError(400, "The code does not belong to that key.", "invalid");
    if (db.prepare("SELECT 1 FROM device_pairings WHERE id = ? OR code = ?").get(p.id, p.code)) throw new HttpError(409, "Make a new code and try again.", "taken");
    const n = db.prepare("SELECT COUNT(*) AS n FROM device_pairings").get() as Row;
    if (Number(n.n) > 10_000) throw new HttpError(503, "Too many devices are being added right now. Try again in a few minutes.", "busy");
    const expires = at + PAIRING_MINUTES * 60_000;
    db.prepare("INSERT INTO device_pairings (id, code, public_key, poll_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.code, p.publicKey, tokenHash(p.pollSecret), at, expires);
    return { expiresAt: new Date(expires).toISOString() };
  });
}

/** The signed-in device looks a pairing up by its code. It checks the key against the code itself. */
export function findPairing(db: Db, code: string, at = Date.now()): { id: string; publicKey: string; expiresAt: string } {
  clean(db, at);
  const r = db.prepare("SELECT id, public_key, expires_at, sealed FROM device_pairings WHERE code = ?").get(code) as Row | undefined;
  if (!r || r.sealed) throw new HttpError(404, "No new device is waiting with this code. Check the code, or make a new one on the new device.", "no_pairing");
  return { id: String(r.id), publicKey: String(r.public_key), expiresAt: new Date(Number(r.expires_at)).toISOString() };
}

export function pairingById(db: Db, id: string, at = Date.now()): { id: string; publicKey: string; code: string } {
  clean(db, at);
  const r = db.prepare("SELECT id, public_key, code, sealed FROM device_pairings WHERE id = ?").get(id) as Row | undefined;
  if (!r || r.sealed) throw new HttpError(404, "This code has expired or was already used. Make a new one on the new device.", "no_pairing");
  return { id: String(r.id), publicKey: String(r.public_key), code: String(r.code) };
}

/**
 * The signed-in device sends the sealed keys and makes the new device's key
 * slot in the same step, so a device exists only once its keys are on the way.
 */
export function sendToDevice(db: Db, userId: string, pairingId: string, sealed: string, slot: KeyslotInput & { kind: "device" }, at = Date.now()): void {
  tx(db, () => {
    clean(db, at);
    const r = db.prepare("SELECT sealed FROM device_pairings WHERE id = ?").get(pairingId) as Row | undefined;
    if (!r || r.sealed) throw new HttpError(404, "This code has expired or was already used. Make a new one on the new device.", "no_pairing");
    if (db.prepare("SELECT 1 FROM keyslots WHERE kind = 'device' AND ref = ?").get(slot.ref)) throw new HttpError(409, "This device already exists.", "taken");
    const n = db.prepare("SELECT COUNT(*) AS n FROM keyslots WHERE user_id = ? AND kind = 'device'").get(userId) as Row;
    if (Number(n.n) >= 20) throw new HttpError(400, "A vault can have up to 20 paired devices. Revoke one first.");
    insertKeyslot(db, userId, slot);
    db.prepare("UPDATE device_pairings SET sealed = ?, user_id = ? WHERE id = ?").run(sealed, userId, pairingId);
    logRead(db, { appId: DEVICE_APP, userId }, "device", `added-${slot.ref}`, 1);
  });
}

/** The new device picks up its sealed box, once. */
export function pickUp(db: Db, pairingId: string, pollSecret: string, at = Date.now()): { state: "waiting" | "ready" | "gone"; sealed?: string } {
  return tx(db, () => {
    clean(db, at);
    const r = db.prepare("SELECT poll_hash, sealed FROM device_pairings WHERE id = ?").get(pairingId) as Row | undefined;
    if (!r || String(r.poll_hash) !== tokenHash(pollSecret)) return { state: "gone" as const };
    if (!r.sealed) return { state: "waiting" as const };
    db.prepare("DELETE FROM device_pairings WHERE id = ?").run(pairingId);
    return { state: "ready" as const, sealed: String(r.sealed) };
  });
}

export function logDeviceStep(db: Db, userId: string, step: string): void {
  logRead(db, { appId: DEVICE_APP, userId }, "device", step, 1);
}

/** Revoking a device removes its key slot and ends every session it opened, at once. */
export function revokeDevice(db: Db, userId: string, keyslotId: string): void {
  tx(db, () => {
    const r = db.prepare("SELECT ref FROM keyslots WHERE id = ? AND user_id = ? AND kind = 'device'").get(keyslotId, userId) as Row | undefined;
    if (!r) throw new HttpError(404, "That device was not found.");
    db.prepare("DELETE FROM keyslots WHERE id = ?").run(keyslotId);
    db.prepare("DELETE FROM sessions WHERE keyslot_id = ?").run(keyslotId);
    logRead(db, { appId: DEVICE_APP, userId }, "device", `revoked-${String(r.ref)}`, 1);
  });
}

export function deviceSlot(db: Db, deviceId: string): { id: string; userId: string; lastUsedAt: string | null } | null {
  const r = db.prepare("SELECT id, user_id, last_used_at FROM keyslots WHERE kind = 'device' AND ref = ?").get(deviceId) as Row | undefined;
  return r ? { id: String(r.id), userId: String(r.user_id), lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at) } : null;
}

