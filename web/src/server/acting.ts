// A self that acts, on the server: the apps the owner lets act within the
// thresholds, and the steps the self took or wants to take with mail, invites
// and offers. Everything readable is sealed: a step is a box only the vault's
// key opens, the owner's answer to an app is an envelope under a key derived
// from that app's secret, and the thresholds reach the app the same way. The
// server keeps the area (mail, calendar, negotiation), the state and the
// times, and counts the steps taken alone since a time the caller names, so
// the owner's "at most this many a day" holds across the vault and every app.

import { tx, type Db } from "./db";
import { HttpError, logRead, type AppAuth } from "./store";
import { insertReceipt, type ReceiptRow } from "./receipts";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export type ActArea = "mail" | "calendar" | "negotiation";
export type ActState = "allowed" | "waiting" | "approved" | "declined" | "refused" | "done";

export const MAX_WAITING_ACTS = 300;
export const MAX_ACTS = 10_000;

export interface ActRow {
  id: string;
  appId: string | null;
  area: ActArea;
  state: ActState;
  alone: boolean;
  box: string;
  answer: string | null;
  receiptId: string | null;
  createdAt: string;
  updatedAt: string;
}

const toAct = (r: Row): ActRow => ({
  id: String(r.id),
  appId: r.app_id == null ? null : String(r.app_id),
  area: r.area as ActArea,
  state: r.state as ActState,
  alone: Number(r.alone) === 1,
  box: String(r.box),
  answer: r.answer == null ? null : String(r.answer),
  receiptId: r.receipt_id == null ? null : String(r.receipt_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

// ---------------------------------------------------------------- apps that may act

function activeApp(db: Db, userId: string, appId: string): void {
  const app = db.prepare("SELECT revoked_at FROM apps WHERE id = ? AND user_id = ?").get(appId, userId) as Row | undefined;
  if (!app) throw new HttpError(404, "That app was not found.");
  if (app.revoked_at) throw new HttpError(400, "This app was revoked. Connect it again to give it access.");
}

/** Lets an app act within the thresholds (its config wrapped for it), or stops it. */
export function setActApp(db: Db, userId: string, appId: string, config: string | null): void {
  tx(db, () => {
    activeApp(db, userId, appId);
    if (config === null) {
      db.prepare("DELETE FROM act_apps WHERE app_id = ? AND user_id = ?").run(appId, userId);
      return;
    }
    db.prepare("INSERT INTO act_apps (app_id, user_id, config, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (app_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at").run(
      appId,
      userId,
      config,
      now(),
    );
  });
}

export function actAppIds(db: Db, userId: string): Set<string> {
  return new Set((db.prepare("SELECT app_id FROM act_apps WHERE user_id = ?").all(userId) as Row[]).map((r) => String(r.app_id)));
}

function assertActing(db: Db, auth: AppAuth): string {
  const r = db.prepare("SELECT config FROM act_apps WHERE app_id = ? AND user_id = ?").get(auth.appId, auth.userId) as Row | undefined;
  if (!r) throw new HttpError(403, "This app may not act for the owner. The owner can allow it in their Sigil vault, under Limits.", "acting_off");
  return String(r.config);
}

/** How many steps the self took alone in each area since a time: by the vault and every app together. */
export function aloneSince(db: Db, userId: string, since: string): Record<ActArea, number> {
  const rows = db.prepare("SELECT area, COUNT(*) AS n FROM acts WHERE user_id = ? AND alone = 1 AND state IN ('allowed', 'done') AND created_at >= ? GROUP BY area").all(userId, since) as Row[];
  const out: Record<ActArea, number> = { mail: 0, calendar: 0, negotiation: 0 };
  for (const r of rows) out[r.area as ActArea] = Number(r.n);
  return out;
}

/**
 * What an app needs before it acts: its config, and when each step taken
 * alone in the last two days happened (by the vault and every app), so the app
 * counts them from midnight in the owner's time zone, which only it can read.
 */
export function actingForApp(db: Db, auth: AppAuth, nowMs = Date.now()) {
  const config = assertActing(db, auth);
  const since = new Date(nowMs - 2 * 86_400_000).toISOString();
  const recent = (db.prepare("SELECT area, created_at FROM acts WHERE user_id = ? AND alone = 1 AND state IN ('allowed', 'done') AND created_at >= ? ORDER BY created_at").all(auth.userId, since) as Row[]).map((r) => ({
    area: r.area as ActArea,
    at: String(r.created_at),
  }));
  return { config, recent };
}

// ---------------------------------------------------------------- steps

export function listActs(db: Db, userId: string): ActRow[] {
  return (db.prepare("SELECT * FROM acts WHERE user_id = ? ORDER BY created_at DESC LIMIT 400").all(userId) as Row[]).map(toAct);
}

function mine(db: Db, userId: string, id: string): ActRow {
  const r = db.prepare("SELECT * FROM acts WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!r) throw new HttpError(404, "That step was not found.", "no_act");
  return toAct(r);
}

/**
 * Keeps a step: one the self took alone ("allowed"), one waiting for the
 * owner, or one refused by a never-touch rule. Asked by the vault (app null)
 * or by an app the owner lets act.
 */
export function createAct(db: Db, userId: string, appId: string | null, a: { id: string; area: ActArea; state: "allowed" | "waiting" | "refused"; box: string }): ActRow {
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM acts WHERE id = ?").get(a.id)) throw new HttpError(409, "A step with this id already exists.");
    const total = db.prepare("SELECT COUNT(*) AS n FROM acts WHERE user_id = ?").get(userId) as Row;
    if (Number(total.n) >= MAX_ACTS) throw new HttpError(400, `Up to ${MAX_ACTS} steps are kept. The owner can remove decided ones under Work.`, "too_many");
    if (a.state === "waiting") {
      const n = db.prepare("SELECT COUNT(*) AS n FROM acts WHERE user_id = ? AND state = 'waiting'").get(userId) as Row;
      if (Number(n.n) >= MAX_WAITING_ACTS) throw new HttpError(400, `Up to ${MAX_WAITING_ACTS} steps can wait for the owner.`, "queue_full");
    }
    const at = now();
    db.prepare("INSERT INTO acts (id, user_id, app_id, area, state, alone, box, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      a.id,
      userId,
      appId,
      a.area,
      a.state,
      a.state === "allowed" ? 1 : 0,
      a.box,
      at,
      at,
    );
    logRead(db, { appId: appId ?? "self", userId }, "work", `act-${a.area}-${a.state}`, 1);
    return mine(db, userId, a.id);
  });
}

export function createActForApp(db: Db, auth: AppAuth, a: { id: string; area: ActArea; state: "allowed" | "waiting" | "refused"; box: string }): ActRow {
  assertActing(db, auth);
  return createAct(db, auth.userId, auth.appId, a);
}

/** The owner says yes or no to a waiting step. For an app's step, the answer is an envelope under that app's key. */
export function decideAct(db: Db, userId: string, id: string, input: { state: "approved" | "declined"; answer: string | null }): ActRow {
  return tx(db, () => {
    const a = mine(db, userId, id);
    if (a.state !== "waiting") throw new HttpError(409, "This step was already decided.", "decided");
    if (a.appId && !input.answer) throw new HttpError(400, "An app's step needs the answer sealed for it.");
    db.prepare("UPDATE acts SET state = ?, answer = ?, updated_at = ? WHERE id = ?").run(input.state, input.answer, now(), id);
    logRead(db, { appId: "self", userId }, "work", `act-${a.area}-${input.state}`, 1);
    return mine(db, userId, id);
  });
}

/** An app asks after its own step: the state and, once decided, the answer only it can open. */
export function actForApp(db: Db, auth: AppAuth, id: string): ActRow {
  assertActing(db, auth);
  const r = db.prepare("SELECT * FROM acts WHERE id = ? AND user_id = ? AND app_id = ?").get(id, auth.userId, auth.appId) as Row | undefined;
  if (!r) throw new HttpError(404, "That step was not found.", "not_found");
  return toAct(r);
}

/**
 * The step was carried out: its receipt joins this hour's seal and the step is
 * done. Only a step taken alone or approved by the owner can be done, once.
 */
export function finishAct(db: Db, userId: string, appId: string | null, id: string, receipt: { id: string; leaf: string; box: string }): { act: ActRow; receipt: ReceiptRow } {
  return tx(db, () => {
    const r = db.prepare("SELECT * FROM acts WHERE id = ? AND user_id = ? AND app_id IS ?").get(id, userId, appId) as Row | undefined;
    if (!r) throw new HttpError(404, "That step was not found.", "not_found");
    const a = toAct(r);
    if (a.state === "done") throw new HttpError(409, "This step already has its receipt.", "done");
    if (a.state !== "allowed" && a.state !== "approved") throw new HttpError(409, a.state === "waiting" ? "This step still waits for the owner." : "The owner did not allow this step.", "not_allowed");
    const kept = insertReceipt(db, userId, { ...receipt, appId, area: a.area });
    db.prepare("UPDATE acts SET state = 'done', receipt_id = ?, updated_at = ? WHERE id = ?").run(kept.id, now(), id);
    logRead(db, { appId: appId ?? "self", userId }, "work", `act-${a.area}-done`, 1);
    return { act: mine(db, userId, id), receipt: kept };
  });
}

export function finishActForApp(db: Db, auth: AppAuth, id: string, receipt: { id: string; leaf: string; box: string }) {
  assertActing(db, auth);
  return finishAct(db, auth.userId, auth.appId, id, receipt);
}

export function deleteAct(db: Db, userId: string, id: string): void {
  const a = mine(db, userId, id);
  if (a.state === "waiting") throw new HttpError(409, "Say yes or no to the step first.", "waiting");
  db.prepare("DELETE FROM acts WHERE id = ? AND user_id = ?").run(id, userId);
}
