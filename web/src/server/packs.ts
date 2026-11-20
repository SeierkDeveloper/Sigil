// Knowledge packs on the server: public by design, signed by the publisher's
// vault key. A new version is accepted only if it is signed by the key that
// published the first one and follows the version before it; every version is
// kept, so a follower can always check the chain. Which vaults follow a pack is
// kept in each follower's encrypted settings; the server only sees that a pack
// is fetched, and the follower's own log line when it takes a version in.

import { parsePack, verifyPack } from "@sigil/core";
import { tx, type Db } from "./db";
import { HttpError, logRead } from "./store";
import { getSignKey } from "./life";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export const PACKS_PER_VAULT = 20;

export interface PackRow {
  id: string;
  folderId: string;
  title: string;
  version: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

const toRow = (r: Row): PackRow => ({
  id: String(r.id),
  folderId: String(r.folder_id),
  title: String(r.title),
  version: Number(r.version),
  hash: String(r.hash),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export function listPacks(db: Db, userId: string): PackRow[] {
  return (db.prepare("SELECT * FROM packs WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toRow);
}

/** Publishes the first version of a pack, or a new one. */
export function publishPack(db: Db, userId: string, input: { folderId: string; pack: string }): PackRow {
  let p;
  try {
    p = parsePack(input.pack);
  } catch (err) {
    throw new HttpError(400, (err as Error).message, "invalid");
  }
  const key = getSignKey(db, userId);
  if (!key || p.body.publisher.signingKey !== key) throw new HttpError(400, "This pack is not signed by this vault.", "invalid");
  return tx(db, () => {
    const have = db.prepare("SELECT * FROM packs WHERE id = ?").get(p.body.id) as Row | undefined;
    if (have && String(have.user_id) !== userId) throw new HttpError(409, "A pack with this id already exists.", "exists");
    const check = verifyPack(p, have ? { pinnedKey: String(have.sign_key), after: { version: Number(have.version), hash: String(have.hash) } } : {});
    const strict = have ? p.body.version === Number(have.version) + 1 && p.body.previous === String(have.hash) : p.body.version === 1;
    if (!check.ok || !strict) throw new HttpError(400, check.checks.find((c) => !c.ok)?.detail ?? "A new version follows the one before it.", "invalid");
    const at = now();
    if (!have) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM packs WHERE user_id = ?").get(userId) as Row;
      if (Number(n.n) >= PACKS_PER_VAULT) throw new HttpError(400, `A vault can publish up to ${PACKS_PER_VAULT} packs.`);
      db.prepare("INSERT INTO packs (id, user_id, folder_id, sign_key, title, version, hash, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        p.body.id,
        userId,
        input.folderId,
        key,
        p.body.title,
        p.body.version,
        p.hash,
        input.pack,
        at,
        at,
      );
    } else {
      db.prepare("UPDATE packs SET title = ?, version = ?, hash = ?, body = ?, folder_id = ?, updated_at = ? WHERE id = ?").run(p.body.title, p.body.version, p.hash, input.pack, input.folderId, at, p.body.id);
    }
    db.prepare("INSERT INTO pack_versions (pack_id, version, hash, body, created_at) VALUES (?, ?, ?, ?, ?)").run(p.body.id, p.body.version, p.hash, input.pack, at);
    logRead(db, { appId: p.body.id, userId }, "pack", `published-${p.body.version}`, p.body.items.length);
    return toRow(db.prepare("SELECT * FROM packs WHERE id = ?").get(p.body.id) as Row);
  });
}

/** Takes a pack down for good, with every version. Followers keep what they took in. */
export function deletePack(db: Db, userId: string, id: string): void {
  tx(db, () => {
    const r = db.prepare("DELETE FROM packs WHERE id = ? AND user_id = ?").run(id, userId);
    if (r.changes === 0) throw new HttpError(404, "That pack was not found.", "no_pack");
    logRead(db, { appId: id, userId }, "pack", "withdrawn", 0);
  });
}

export function publicPack(db: Db, id: string, version?: number): string {
  const r = (
    version
      ? db.prepare("SELECT body FROM pack_versions WHERE pack_id = ? AND version = ?").get(id, version)
      : db.prepare("SELECT body FROM packs WHERE id = ?").get(id)
  ) as Row | undefined;
  if (!r) throw new HttpError(404, "There is no pack at this link. Its publisher may have taken it down.", "no_pack");
  return String(r.body);
}

export function packVersions(db: Db, id: string): { version: number; hash: string; createdAt: string }[] {
  if (!db.prepare("SELECT 1 FROM packs WHERE id = ?").get(id)) throw new HttpError(404, "There is no pack at this link.", "no_pack");
  return (db.prepare("SELECT version, hash, created_at FROM pack_versions WHERE pack_id = ? ORDER BY version").all(id) as Row[]).map((r) => ({ version: Number(r.version), hash: String(r.hash), createdAt: String(r.created_at) }));
}

/** A follower's own log line: it followed a pack, or took a new version in. */
export function logFollow(db: Db, userId: string, packId: string, step: "followed" | "updated" | "unfollowed", version: number, items: number): void {
  logRead(db, { appId: packId, userId }, "pack", `${step}-${version}`, items);
}
