// Knowledge packs on the owner's device. Publishing: a folder's memories,
// masked with the folder's rules like the public AI self's copy (a protected
// folder can never be published), signed with the vault's signing key. Following:
// a pack is checked here against the publisher key pinned when it was first
// followed, copied into a folder of its own, and brought up to date whenever
// the vault opens. The list of follows is an encrypted setting.

import {
  cleanFollows,
  openSetting,
  packMemoryId,
  packUrl,
  parsePack,
  publicCopy,
  sealSetting,
  signPack,
  vaultSigningKey,
  verifyPack,
  buildMemory,
  randomId,
  type FollowedPack,
  type KnowledgePack,
  type Memory,
  type OpenFolder,
} from "@sigil/core";
import type { Api } from "./api";
import { addFolder, deleteMemories, storedForSave, type Unlocked, type VaultData } from "./ops";

export interface PackRow {
  id: string;
  folderId: string;
  title: string;
  version: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export async function openFollows(vault: Unlocked, envelope: string | undefined): Promise<FollowedPack[]> {
  if (!envelope) return [];
  return cleanFollows(await openSetting<unknown>(vault.key, "packs", envelope));
}

async function saveFollows(api: Api, vault: Unlocked, follows: FollowedPack[]): Promise<void> {
  await api.put("settings/packs", { value: await sealSetting(vault.key, "packs", follows) });
}

// ---------------------------------------------------------------- publishing

/** Publishes a folder as a pack, or its next version. Returns the pack as published. */
export async function publish(api: Api, vault: Unlocked, data: Pick<VaultData, "memories" | "folders" | "packs">, input: { folderId: string; title: string; description: string; publisher: string; origin: string }): Promise<{ row: PackRow; pack: KnowledgePack }> {
  const folder = data.folders.find((f) => f.id === input.folderId);
  if (!folder) throw new Error("That folder was not found.");
  if (folder.protect) throw new Error("A protected folder cannot be published.");
  const items = publicCopy(data.memories, data.folders, [folder.id]).map((i) => ({ id: i.id, title: i.title, body: i.body, tags: i.tags }));
  const have = data.packs.find((p) => p.folderId === folder.id);
  const pack = signPack(await vaultSigningKey(vault.raw), {
    id: have?.id ?? randomId(),
    title: input.title,
    description: input.description,
    version: have ? have.version + 1 : 1,
    previous: have?.hash ?? null,
    publisher: { name: input.publisher },
    items,
    origin: input.origin,
    publishedAt: new Date().toISOString(),
  });
  const r = await api.post<{ pack: PackRow }>("packs", { folderId: folder.id, pack: JSON.stringify(pack) });
  return { row: r.pack, pack };
}

export async function withdraw(api: Api, id: string): Promise<void> {
  await api.del(`packs/${id}`);
}

// ---------------------------------------------------------------- following

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A pack from its link or its id. The vault page may only talk to its own site
 * (its content security policy), so it follows packs published on this site.
 */
export function packRef(input: string, origin: string): { origin: string; id: string } {
  const t = input.trim();
  const m = /^(https?:\/\/[^/\s]+)\/p\/([A-Za-z0-9_-]{8,64})\/?$/.exec(t);
  if (m) {
    if (m[1] !== origin.replace(/\/$/, "")) throw new Error("This vault follows packs published on this site. That link is for another one.");
    return { origin: m[1], id: m[2] };
  }
  if (/^[A-Za-z0-9_-]{8,64}$/.test(t)) return { origin, id: t };
  throw new Error("Paste a pack's link, like https://.../p/<id>.");
}

export async function fetchPack(origin: string, id: string, version?: number, fetcher: Fetch = (i, init) => fetch(i, init)): Promise<KnowledgePack> {
  const res = await fetcher(`${origin.replace(/\/$/, "")}/api/packs/at/${id}${version ? `?version=${version}` : ""}`, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    let msg = `The pack could not be loaded (${res.status}).`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      // keep the plain message
    }
    throw new Error(msg);
  }
  return parsePack(text);
}

async function writeItems(api: Api, folder: OpenFolder, pack: KnowledgePack, existing: Memory[]): Promise<{ saved: Memory[]; removed: string[] }> {
  const at = new Date().toISOString();
  const saved: Memory[] = [];
  for (const item of pack.body.items) {
    const id = await packMemoryId(folder.raw, pack.body.id, item.id);
    const before = existing.find((m) => m.id === id);
    saved.push(
      buildMemory({ title: item.title, body: item.body, tags: item.tags, source: { kind: "pack", ref: pack.body.title }, createdAt: before?.createdAt ?? pack.body.publishedAt, editedAt: at }, folder.id, id),
    );
  }
  for (let i = 0; i < saved.length; i += 200) {
    await api.put("memories", { memories: await Promise.all(saved.slice(i, i + 200).map((m) => storedForSave(folder, m))) });
  }
  const keep = new Set(saved.map((m) => m.id));
  const removed = existing.filter((m) => m.folderId === folder.id && !keep.has(m.id)).map((m) => m.id);
  if (removed.length) await deleteMemories(api, removed);
  return { saved, removed };
}

/** Follows a pack: checks it, copies it into a new folder of its own, pins its publisher. */
export async function follow(api: Api, vault: Unlocked, data: Pick<VaultData, "follows" | "memories">, ref: { origin: string; id: string }, fetcher?: Fetch): Promise<{ follow: FollowedPack; folder: OpenFolder; memories: Memory[] }> {
  if (data.follows.some((f) => f.id === ref.id)) throw new Error("You already follow this pack.");
  const pack = await fetchPack(ref.origin, ref.id, undefined, fetcher);
  const check = verifyPack(pack);
  if (!check.ok) throw new Error(check.checks.find((c) => !c.ok)?.detail ?? "This pack does not check out.");
  const folder = await addFolder(api, vault, `Pack: ${pack.body.title}`.slice(0, 120));
  const { saved } = await writeItems(api, folder, pack, []);
  const at = new Date().toISOString();
  const f: FollowedPack = { id: pack.body.id, origin: ref.origin, folderId: folder.id, publisherKey: pack.body.publisher.signingKey, title: pack.body.title, version: pack.body.version, hash: pack.hash, followedAt: at, updatedAt: at };
  await saveFollows(api, vault, [...data.follows, f]);
  await api.post(`packs/${pack.body.id}/log`, { step: "followed", version: pack.body.version, items: saved.length });
  return { follow: f, folder, memories: saved };
}

export interface FollowUpdate {
  id: string;
  title: string;
  from: number;
  to: number;
}

/**
 * Brings every followed pack up to date. Each version in between is fetched
 * and checked in order, so the chain from the version held to the newest is
 * signed by the pinned publisher, link by link. A pack that fails is left as it is.
 */
export async function refresh(api: Api, data: Pick<VaultData, "follows" | "folders" | "memories">, vault: Unlocked, fetcher?: Fetch): Promise<{ updated: FollowUpdate[]; failed: { id: string; reason: string }[] }> {
  const updated: FollowUpdate[] = [];
  const failed: { id: string; reason: string }[] = [];
  const follows = [...data.follows];
  for (let i = 0; i < follows.length; i++) {
    const f = follows[i];
    try {
      const latest = await fetchPack(f.origin, f.id, undefined, fetcher);
      if (latest.body.version <= f.version) continue;
      let held = { version: f.version, hash: f.hash };
      let pack = latest;
      for (let v = f.version + 1; v <= latest.body.version; v++) {
        pack = v === latest.body.version ? latest : await fetchPack(f.origin, f.id, v, fetcher);
        const check = verifyPack(pack, { pinnedKey: f.publisherKey, after: held });
        if (!check.ok || pack.body.previous !== held.hash) throw new Error(check.checks.find((c) => !c.ok)?.detail ?? "A version does not follow the one before it.");
        held = { version: pack.body.version, hash: pack.hash };
        if (v - f.version > 50) throw new Error("Too many versions behind. Unfollow and follow again.");
      }
      const folder = data.folders.find((x) => x.id === f.folderId);
      if (!folder) throw new Error("The pack's folder was deleted.");
      const { saved } = await writeItems(api, folder, pack, data.memories.filter((m) => m.folderId === folder.id));
      follows[i] = { ...f, title: pack.body.title, version: pack.body.version, hash: pack.hash, updatedAt: new Date().toISOString() };
      updated.push({ id: f.id, title: pack.body.title, from: f.version, to: pack.body.version });
      await api.post(`packs/${f.id}/log`, { step: "updated", version: pack.body.version, items: saved.length });
    } catch (err) {
      failed.push({ id: f.id, reason: (err as Error).message });
    }
  }
  if (updated.length) await saveFollows(api, vault, follows);
  return { updated, failed };
}

/** Stops following. The folder and what was taken in stay, unless the owner deletes them. */
export async function unfollow(api: Api, vault: Unlocked, data: Pick<VaultData, "follows">, id: string): Promise<FollowedPack[]> {
  const f = data.follows.find((x) => x.id === id);
  const next = data.follows.filter((x) => x.id !== id);
  await saveFollows(api, vault, next);
  if (f) await api.post(`packs/${id}/log`, { step: "unfollowed", version: f.version, items: 0 });
  return next;
}

export { packUrl };
