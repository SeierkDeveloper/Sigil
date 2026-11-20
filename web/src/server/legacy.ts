// Legacy plans on the server: the heartbeat, the warning stages, invites, the
// release room and what a trusted person may open once a plan is released.
//
// Everything stored here is a sealed box or an envelope under a key the server
// never holds, plus public keys, folder ids and times. The server decides one
// thing on its own: whether the owner has been inactive for the whole period.
// Until then it hands out no share and no bundle.

import { isBoxPublicKey, type StoredMemory } from "@sigil/core";
import { tx, type Db } from "./db";
import { serverConfig } from "./config";
import { HttpError, lastActive, logRead, touchActive } from "./store";
import { getBoxKey, userByBoxKey } from "./inbox";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

/** The read log's app id for steps the owner takes on their own plan. */
export const LEGACY_OWNER = "legacy";

export type LegacyStage = 0 | 1 | 2 | 3;

/**
 * The stages of a plan, from the owner's last sign-in or vault action:
 *   0  all well
 *   1  first warning: a month before the period ends (a third of it for short periods)
 *   2  last warning: a week before (a tenth of it for short periods)
 *   3  the period has passed: trusted people may ask for a release
 */
export function stageTimes(lastActiveAt: string, periodDays: number) {
  const day = serverConfig.legacyDayMs;
  const start = Date.parse(lastActiveAt);
  const period = periodDays * day;
  const due = start + period;
  return {
    due,
    first: due - Math.min(30 * day, Math.floor(period / 3)),
    last: due - Math.min(7 * day, Math.floor(period / 10)),
  };
}

export function stageAt(lastActiveAt: string, periodDays: number, at = Date.now()): LegacyStage {
  const t = stageTimes(lastActiveAt, periodDays);
  if (at >= t.due) return 3;
  if (at >= t.last) return 2;
  if (at >= t.first) return 1;
  return 0;
}

const STAGE_STEP: Record<Exclude<LegacyStage, 0>, string> = { 1: "warning-first", 2: "warning-last", 3: "release-open" };

function planRow(db: Db, where: string, value: string): Row | undefined {
  return db.prepare(`SELECT * FROM legacy_plans WHERE ${where} = ?`).get(value) as Row | undefined;
}

function log(db: Db, ownerId: string, who: string, step: string, at = new Date(), note: string | null = null, count = 1) {
  logRead(db, { appId: who, userId: ownerId }, "legacy", step, count, at, note);
}

/**
 * Writes the stages a plan reached since the last look, once each, into the
 * owner's log. Runs on the server's timer and before any legacy request.
 */
export function legacyTick(db: Db, at = Date.now()): void {
  const plans = db.prepare("SELECT p.id, p.user_id, p.period_days, p.warned_stage FROM legacy_plans p").all() as Row[];
  for (const p of plans) {
    const last = lastActive(db, String(p.user_id));
    if (!last) continue;
    const stage = stageAt(last, Number(p.period_days), at);
    if (stage <= Number(p.warned_stage)) continue;
    tx(db, () => {
      for (let s = Number(p.warned_stage) + 1; s <= stage; s++) log(db, String(p.user_id), String(p.id), STAGE_STEP[s as 1 | 2 | 3], new Date(at));
      db.prepare("UPDATE legacy_plans SET warned_stage = ?, warned_at = ? WHERE id = ?").run(stage, new Date(at).toISOString(), String(p.id));
    });
  }
}

/**
 * The owner did something: the heartbeat moves on. If a warning stage was
 * reached while they were away, it is kept to show once in the vault.
 */
export function markActive(db: Db, userId: string, at = new Date()): void {
  if (!touchActive(db, userId, at)) return;
  const p = planRow(db, "user_id", userId);
  if (!p || Number(p.warned_stage) === 0) return;
  db.prepare("UPDATE legacy_plans SET missed_stage = MAX(missed_stage, warned_stage), missed_at = warned_at, warned_stage = 0 WHERE id = ?").run(String(p.id));
}

export function isReleasable(db: Db, p: Row, at = Date.now()): boolean {
  const last = lastActive(db, String(p.user_id));
  return !!last && stageAt(last, Number(p.period_days), at) === 3;
}

// ---------------------------------------------------------------- the owner's side

export interface PersonInput {
  id: string;
  publicKey: string | null;
  folderIds: string[];
  self: boolean;
  share: string | null;
  bundle: string | null;
  note: string | null;
  inviteIntro: string | null;
}

export interface PlanInput {
  id: string;
  epoch: number;
  threshold: number;
  periodDays: number;
  check: string;
  ownerBox: string;
  people: PersonInput[];
}

/**
 * Saves a plan made on the owner's device, replacing the last one whole. A new
 * plan or a change always comes with a new epoch, and the release room of the
 * old one is cleared, so nothing from before can be combined with it.
 */
export function savePlan(db: Db, userId: string, p: PlanInput): void {
  tx(db, () => {
    const old = planRow(db, "user_id", userId);
    if (old && String(old.id) !== p.id) throw new HttpError(409, "This vault already has a legacy plan. Reload the vault and change that one.", "stale");
    if (old && p.epoch <= Number(old.epoch)) throw new HttpError(409, "The plan changed on another device. Reload the vault and try again.", "stale");
    if (!old && planRow(db, "id", p.id)) throw new HttpError(409, "A plan with this id already exists.");
    const ready = p.people.filter((x) => x.publicKey);
    if (p.threshold < 1 || p.threshold > p.people.length) throw new HttpError(400, "The number of people needed must be between 1 and the number of trusted people.", "invalid");
    // Either every person with a key holds a share (the plan is complete) or nobody does (it waits for invites).
    const complete = ready.length >= p.threshold;
    if (new Set(p.people.map((x) => x.id)).size !== p.people.length) throw new HttpError(400, "A trusted person is listed twice.", "invalid");
    const folderOk = db.prepare("SELECT 1 FROM folders WHERE user_id = ? AND id = ?");
    const ownKey = getBoxKey(db, userId)?.publicKey;
    for (const x of p.people) {
      for (const f of x.folderIds) if (!folderOk.get(userId, f)) throw new HttpError(400, "A chosen folder does not exist.", "invalid");
      if (x.publicKey && !x.note) throw new HttpError(400, "A trusted person with a key needs a note.", "invalid");
      if (x.publicKey && complete !== !!(x.share && x.bundle)) throw new HttpError(400, "Every trusted person with a key needs a share and a bundle once the plan is complete.", "invalid");
      if (!x.publicKey && (x.share || x.bundle || x.note)) throw new HttpError(400, "A person without a key cannot hold a share.", "invalid");
      if (x.publicKey && x.publicKey === ownKey) throw new HttpError(400, "You cannot name your own vault as a trusted person.", "own_vault");
      if (!x.publicKey && !x.inviteIntro && !db.prepare("SELECT 1 FROM legacy_people WHERE id = ? AND owner_id = ?").get(x.id, userId)) {
        throw new HttpError(400, "A trusted person needs a vault key or an invite.", "invalid");
      }
    }
    const at = now();
    // Invite answers are kept across a change, so a person still waiting can be sealed for later.
    const answers = new Map(
      (db.prepare("SELECT id, invite_intro, invite_key, invite_tag, invite_user FROM legacy_people WHERE owner_id = ?").all(userId) as Row[]).map((r) => [String(r.id), r]),
    );
    if (old) {
      db.prepare("UPDATE legacy_plans SET epoch = ?, threshold = ?, period_days = ?, check_value = ?, owner_box = ?, warned_stage = 0, warned_at = NULL, released_at = NULL, updated_at = ? WHERE id = ?").run(
        p.epoch,
        p.threshold,
        p.periodDays,
        p.check,
        p.ownerBox,
        at,
        p.id,
      );
    } else {
      db.prepare("INSERT INTO legacy_plans (id, user_id, epoch, threshold, period_days, check_value, owner_box, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        p.id,
        userId,
        p.epoch,
        p.threshold,
        p.periodDays,
        p.check,
        p.ownerBox,
        at,
        at,
      );
    }
    db.prepare("DELETE FROM legacy_people WHERE plan_id = ?").run(p.id);
    db.prepare("DELETE FROM legacy_passes WHERE plan_id = ?").run(p.id);
    db.prepare("DELETE FROM legacy_requests WHERE plan_id = ?").run(p.id);
    const ins = db.prepare(
      `INSERT INTO legacy_people (id, plan_id, owner_id, public_key, trustee_id, folder_ids, self, share, bundle, note, invite_intro, invite_key, invite_tag, invite_user, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const x of p.people) {
      const prev = answers.get(x.id);
      const trustee = x.publicKey ? userByBoxKey(db, x.publicKey) : null;
      ins.run(
        x.id,
        p.id,
        userId,
        x.publicKey,
        trustee,
        JSON.stringify(x.folderIds),
        x.self ? 1 : 0,
        x.share,
        x.bundle,
        x.note,
        x.inviteIntro ?? str(prev?.invite_intro),
        str(prev?.invite_key),
        str(prev?.invite_tag),
        str(prev?.invite_user),
        at,
      );
    }
    log(db, userId, LEGACY_OWNER, old ? "changed" : "made");
  });
}

export function cancelPlan(db: Db, userId: string): void {
  tx(db, () => {
    const r = db.prepare("DELETE FROM legacy_plans WHERE user_id = ?").run(userId);
    if (r.changes === 0) throw new HttpError(404, "There is no legacy plan to cancel.", "not_found");
    log(db, userId, LEGACY_OWNER, "cancelled");
  });
}

export function checkIn(db: Db, userId: string): string {
  const at = new Date();
  db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(at.toISOString(), userId);
  const p = planRow(db, "user_id", userId);
  if (p && Number(p.warned_stage) > 0) {
    db.prepare("UPDATE legacy_plans SET missed_stage = MAX(missed_stage, warned_stage), missed_at = warned_at, warned_stage = 0 WHERE id = ?").run(String(p.id));
  }
  if (p) log(db, userId, LEGACY_OWNER, "check-in", at);
  return at.toISOString();
}

export function dismissMissed(db: Db, userId: string): void {
  db.prepare("UPDATE legacy_plans SET missed_stage = 0, missed_at = NULL WHERE user_id = ?").run(userId);
}

/** The plan as the owner's vault needs it: its sealed record, its people and how the heartbeat stands. */
export function ownerPlan(db: Db, userId: string, at = Date.now()) {
  const last = lastActive(db, userId);
  const p = planRow(db, "user_id", userId);
  if (!p) return { plan: null, lastActiveAt: last };
  const times = stageTimes(last ?? now(), Number(p.period_days));
  const people = (db.prepare("SELECT * FROM legacy_people WHERE plan_id = ? ORDER BY created_at, id").all(String(p.id)) as Row[]).map((r) => ({
    id: String(r.id),
    publicKey: str(r.public_key),
    hasVault: r.trustee_id != null,
    folderIds: JSON.parse(String(r.folder_ids)) as string[],
    self: Number(r.self) === 1,
    sealed: r.share != null,
    invite: r.invite_intro ? { answered: r.invite_key != null, publicKey: str(r.invite_key), tag: str(r.invite_tag) } : null,
    openedAt: str(r.opened_at),
  }));
  const requests = (db.prepare("SELECT person_id, created_at FROM legacy_requests WHERE plan_id = ? AND epoch = ?").all(String(p.id), Number(p.epoch)) as Row[]).map((r) => ({
    personId: String(r.person_id),
    at: String(r.created_at),
  }));
  return {
    lastActiveAt: last,
    plan: {
      id: String(p.id),
      epoch: Number(p.epoch),
      threshold: Number(p.threshold),
      periodDays: Number(p.period_days),
      ownerBox: String(p.owner_box),
      createdAt: String(p.created_at),
      updatedAt: String(p.updated_at),
      dueAt: new Date(times.due).toISOString(),
      firstWarningAt: new Date(times.first).toISOString(),
      lastWarningAt: new Date(times.last).toISOString(),
      stage: last ? stageAt(last, Number(p.period_days), at) : 0,
      missed: Number(p.missed_stage) > 0 ? { stage: Number(p.missed_stage), at: str(p.missed_at) } : null,
      releasedAt: str(p.released_at),
      people,
      requests,
    },
  };
}

// ---------------------------------------------------------------- invites

/** What an invite link shows before it is answered: the greeting under the link's secret. */
export function inviteFor(db: Db, personId: string) {
  const r = db.prepare("SELECT invite_intro, invite_key, invite_user FROM legacy_people WHERE id = ?").get(personId) as Row | undefined;
  if (!r || !r.invite_intro) throw new HttpError(404, "This invite does not exist. The owner may have changed their plan.", "no_invite");
  return { intro: String(r.invite_intro), answered: r.invite_key != null };
}

export function answerInvite(db: Db, userId: string, personId: string, publicKey: string, tag: string): void {
  tx(db, () => {
    const r = db.prepare("SELECT owner_id, invite_intro, invite_key FROM legacy_people WHERE id = ?").get(personId) as Row | undefined;
    if (!r || !r.invite_intro) throw new HttpError(404, "This invite does not exist. The owner may have changed their plan.", "no_invite");
    if (String(r.owner_id) === userId) throw new HttpError(400, "This is your own invite. Send the link to the person you want to name.", "own_vault");
    if (r.invite_key) throw new HttpError(409, "This invite was already answered.", "answered");
    const mine = getBoxKey(db, userId)?.publicKey;
    if (!mine || mine !== publicKey || !isBoxPublicKey(publicKey)) throw new HttpError(400, "Answer with your own vault's key.", "invalid");
    db.prepare("UPDATE legacy_people SET invite_key = ?, invite_tag = ?, invite_user = ? WHERE id = ?").run(publicKey, tag, userId, personId);
    log(db, String(r.owner_id), personId, "invite-answered");
  });
}

// ---------------------------------------------------------------- the trusted person's side

function myPerson(db: Db, userId: string, planId: string): { plan: Row; person: Row } {
  const plan = planRow(db, "id", planId);
  const person = plan ? (db.prepare("SELECT * FROM legacy_people WHERE plan_id = ? AND trustee_id = ? AND share IS NOT NULL").get(planId, userId) as Row | undefined) : undefined;
  if (!plan || !person) throw new HttpError(404, "You are not a trusted person in this plan.", "not_trustee");
  return { plan, person };
}

function needReleasable(db: Db, plan: Row): void {
  legacyTick(db);
  if (!isReleasable(db, plan)) throw new HttpError(403, "This plan cannot be released: its owner has been active within the period they set.", "not_releasable");
}

/** Every plan that names this vault, with what may be done with it now. */
export function trustedPlans(db: Db, userId: string, at = Date.now()) {
  legacyTick(db, at);
  const rows = db
    .prepare(
      `SELECT x.*, p.epoch AS plan_epoch, p.threshold, p.period_days, p.released_at, p.user_id AS owner FROM legacy_people x JOIN legacy_plans p ON p.id = x.plan_id
       WHERE x.trustee_id = ? AND x.note IS NOT NULL ORDER BY x.created_at`,
    )
    .all(userId) as Row[];
  return rows.map((r) => {
    const planId = String(r.plan_id);
    const epoch = Number(r.plan_epoch);
    const releasable = r.share != null && isReleasable(db, { user_id: r.owner, period_days: r.period_days }, at);
    const passes = releasable
      ? (db.prepare("SELECT from_id, sealed FROM legacy_passes WHERE plan_id = ? AND epoch = ? AND to_id = ?").all(planId, epoch, String(r.id)) as Row[]).map((x) => ({
          from: String(x.from_id),
          sealed: String(x.sealed),
        }))
      : [];
    const passedTo = (db.prepare("SELECT to_id FROM legacy_passes WHERE plan_id = ? AND epoch = ? AND from_id = ?").all(planId, epoch, String(r.id)) as Row[]).map((x) => String(x.to_id));
    const requests = (db.prepare("SELECT person_id, created_at FROM legacy_requests WHERE plan_id = ? AND epoch = ?").all(planId, epoch) as Row[]).map((x) => ({
      personId: String(x.person_id),
      at: String(x.created_at),
    }));
    return {
      planId,
      personId: String(r.id),
      epoch,
      note: String(r.note),
      state: releasable ? ("open" as const) : r.share == null ? ("incomplete" as const) : ("waiting" as const),
      // The share itself is handed out only once the plan may be released.
      share: releasable ? String(r.share) : null,
      passes,
      passedTo,
      requests,
      kept: str(r.kept),
      openedAt: str(r.opened_at),
      releasedAt: str(r.released_at),
    };
  });
}

export function requestRelease(db: Db, userId: string, planId: string): void {
  tx(db, () => {
    const { plan, person } = myPerson(db, userId, planId);
    needReleasable(db, plan);
    const r = db.prepare("INSERT OR IGNORE INTO legacy_requests (plan_id, epoch, person_id, created_at) VALUES (?, ?, ?, ?)").run(planId, Number(plan.epoch), String(person.id), now());
    if (r.changes > 0) log(db, String(plan.user_id), String(person.id), "request");
  });
}

/** Relays a share one trusted person passes to another. The server only checks both are in the plan. */
export function passShare(db: Db, userId: string, planId: string, to: string, sealed: string): void {
  tx(db, () => {
    const { plan, person } = myPerson(db, userId, planId);
    needReleasable(db, plan);
    if (to === String(person.id)) throw new HttpError(400, "A share is not passed to oneself.", "invalid");
    if (!db.prepare("SELECT 1 FROM legacy_people WHERE id = ? AND plan_id = ? AND share IS NOT NULL").get(to, planId)) throw new HttpError(404, "That person is not in this plan.", "not_trustee");
    const r = db.prepare("INSERT OR IGNORE INTO legacy_passes (plan_id, epoch, from_id, to_id, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(planId, Number(plan.epoch), String(person.id), to, sealed, now());
    if (r.changes > 0) log(db, String(plan.user_id), String(person.id), "share-passed");
  });
}

/** The person's own bundle, sealed to them and under the legacy key. Useless without the shares. */
export function bundleFor(db: Db, userId: string, planId: string) {
  const { plan, person } = myPerson(db, userId, planId);
  needReleasable(db, plan);
  return { personId: String(person.id), epoch: Number(plan.epoch), bundle: String(person.bundle) };
}

/** The person opened their bundle in their browser and kept a copy under their own vault key. */
export function markOpened(db: Db, userId: string, planId: string, kept: string): void {
  tx(db, () => {
    const { plan, person } = myPerson(db, userId, planId);
    needReleasable(db, plan);
    const at = now();
    db.prepare("UPDATE legacy_people SET kept = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?").run(kept, at, String(person.id));
    if (!plan.released_at) {
      db.prepare("UPDATE legacy_plans SET released_at = ? WHERE id = ?").run(at, planId);
      log(db, String(plan.user_id), String(person.id), "released");
    }
    log(db, String(plan.user_id), String(person.id), "opened");
  });
}

/** The folders a person received, while the plan stays released. Every opening is in the owner's log. */
export function releasedFolders(db: Db, userId: string, planId: string) {
  const { plan, person } = myPerson(db, userId, planId);
  needReleasable(db, plan);
  if (!person.opened_at) throw new HttpError(403, "Open your share first.", "not_opened");
  const ids = JSON.parse(String(person.folder_ids)) as string[];
  const ownerId = String(plan.user_id);
  const folder = db.prepare("SELECT id, meta FROM folders WHERE user_id = ? AND id = ?");
  const mems = db.prepare("SELECT id, folder_id, head, body FROM memories WHERE user_id = ? AND folder_id = ? ORDER BY updated_at DESC, id");
  const folders: { id: string; meta: string }[] = [];
  const memories: StoredMemory[] = [];
  for (const id of ids) {
    const f = folder.get(ownerId, id) as Row | undefined;
    if (!f) continue;
    folders.push({ id: String(f.id), meta: String(f.meta) });
    for (const m of mems.all(ownerId, id) as Row[]) memories.push({ id: String(m.id), folderId: String(m.folder_id), head: String(m.head), body: String(m.body) });
  }
  log(db, ownerId, String(person.id), "read", new Date(), null, memories.length);
  return { folders, memories };
}

/** A question to the AI self in legacy mode: only its note, sealed to the owner's vault key, is kept. */
export function logLegacyAsk(db: Db, userId: string, planId: string, noteId: string, note: string, cited: number): void {
  const { plan, person } = myPerson(db, userId, planId);
  needReleasable(db, plan);
  if (Number(person.self) !== 1) throw new HttpError(403, "The owner did not give you their AI self.", "self_off");
  if (!person.opened_at) throw new HttpError(403, "Open your share first.", "not_opened");
  log(db, String(plan.user_id), String(person.id), `ask-${noteId}`, new Date(), note, cited);
}
