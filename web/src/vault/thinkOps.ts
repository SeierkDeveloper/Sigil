// Memory that thinks, on the owner's device: the weekly brief saved into the
// Briefs folder, expiry and the grace period, contradictions, and merging every
// duplicate group at once. All text is read and written here; the server sees
// only new envelopes, ids, and the time an expiring memory is deleted.

import {
  BRIEFS_FOLDER,
  briefDue,
  briefFacts,
  briefTitle,
  buildMemory,
  deleteAfter,
  findContradictions,
  groupDuplicates,
  findDuplicates,
  isExpired,
  mergeGroup,
  writeBrief,
  type ContradictionCandidate,
  type Memory,
  type ModelCaller,
  type OpenFolder,
} from "@sigil/core";
import type { Api } from "./api";
import { addFolder, deleteMemories, saveMemory, updateMemory, type Unlocked, type VaultData } from "./ops";

// ---------------------------------------------------------------- the weekly brief

export function briefFolder(data: Pick<VaultData, "folders">): OpenFolder | null {
  return data.folders.find((f) => f.name.toLowerCase() === BRIEFS_FOLDER.toLowerCase()) ?? null;
}

export function briefs(data: Pick<VaultData, "memories">): Memory[] {
  return data.memories.filter((m) => m.source.kind === "brief").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Whether to write a brief on its own when the vault opens: the owner wants it,
 * the last brief is a week old, and the vault itself is at least a week old
 * (a new vault has no week to look back on yet; Make a brief now works at once).
 */
export function shouldMakeBrief(data: Pick<VaultData, "memories" | "thinking" | "createdAt">, now = new Date()): boolean {
  const own = data.memories.filter((m) => m.source.kind !== "brief" && m.source.kind !== "profile" && m.source.kind !== "model");
  const weekOld = !!data.createdAt && now.getTime() - new Date(data.createdAt).getTime() >= 7 * 86_400_000;
  return data.thinking.weeklyBrief && weekOld && own.length > 0 && briefDue(data.memories, now);
}

/** Writes this week's brief and saves it as a memory in the Briefs folder (made the first time). */
export async function makeBrief(
  api: Api,
  vault: Unlocked,
  data: VaultData,
  model: ModelCaller | null,
  now = new Date(),
): Promise<{ memory: Memory; folder: OpenFolder; createdFolder: boolean; usedModel: boolean }> {
  const names = new Map(data.folders.map((f) => [f.id, f.name]));
  const facts = briefFacts(
    data.memories.filter((m) => !isExpired(m, now.getTime())).map((m) => ({ ...m, folder: names.get(m.folderId) ?? "" })),
    now,
  );
  const { body, usedModel } = await writeBrief(facts, model);
  let folder = briefFolder(data);
  let createdFolder = false;
  if (!folder) {
    folder = await addFolder(api, vault, BRIEFS_FOLDER);
    createdFolder = true;
  }
  const at = now.toISOString();
  const memory = buildMemory({ title: briefTitle(facts), body, tags: ["brief"], source: { kind: "brief" }, createdAt: at, editedAt: at }, folder.id);
  await saveMemory(api, folder, memory);
  return { memory, folder, createdFolder, usedModel };
}

// ---------------------------------------------------------------- expiry

export function expired(data: Pick<VaultData, "memories">, now = Date.now()): Memory[] {
  return data.memories.filter((m) => isExpired(m, now)).sort((a, b) => ((a.expiresAt ?? "") < (b.expiresAt ?? "") ? -1 : 1));
}

export async function setExpiry(api: Api, data: VaultData, memory: Memory, expiresAt: string | null): Promise<Memory> {
  return updateMemory(api, data.folders, memory, { expiresAt }, data.thinking.graceDays);
}

/** After the grace period changes, every expiring memory gets its new deletion time. */
export async function applyGrace(api: Api, data: VaultData, graceDays: number): Promise<number> {
  const items = data.memories.filter((m) => m.expiresAt).map((m) => ({ id: m.id, deleteAfter: deleteAfter(m.expiresAt, graceDays) }));
  if (!items.length) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i += 5000) n += (await api.post<{ updated: number }>("memories/delete-after", { items: items.slice(i, i + 5000) })).updated;
  return n;
}

// ---------------------------------------------------------------- contradictions

export const CONTRADICTIONS_DISMISSED = "sigil-contradictions-dismissed";

export function contradictions(data: Pick<VaultData, "memories">, vectors?: Map<string, Float32Array>, now = Date.now()): ContradictionCandidate<Memory & { text: string }>[] {
  const pool = data.memories.filter((m) => !isExpired(m, now) && m.source.kind !== "brief" && m.source.kind !== "profile" && m.source.kind !== "model").map((m) => ({ ...m, text: m.body }));
  return findContradictions(pool, { vectors });
}

/** Resolves a contradiction by keeping one memory and deleting the other. */
export async function keepOne(api: Api, drop: Memory): Promise<void> {
  await deleteMemories(api, [drop.id]);
}

// ---------------------------------------------------------------- duplicate groups

export function duplicateGroups(data: Pick<VaultData, "memories">, vectors?: Map<string, Float32Array>, dismissed: Set<string> = new Set()) {
  const items = data.memories.filter((m) => m.source.kind !== "profile" && m.source.kind !== "model" && m.source.kind !== "brief").map((m) => ({ ...m, text: m.body }));
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  return groupDuplicates(findDuplicates(items, { vectors }).filter((p) => !dismissed.has(key(p.a.id, p.b.id))));
}

/** Merges every group after one approval: each group into its newest memory, the others deleted. */
export async function mergeAllGroups(api: Api, data: VaultData, groups: Memory[][]): Promise<{ saved: Memory[]; deleted: string[] }> {
  const saved: Memory[] = [];
  const deleted: string[] = [];
  for (const group of groups) {
    const m = mergeGroup(group);
    saved.push(await updateMemory(api, data.folders, m.keep, { body: m.body, tags: m.tags }, data.thinking.graceDays));
    deleted.push(...m.drop.map((d) => d.id));
  }
  if (deleted.length) await deleteMemories(api, deleted);
  return { saved, deleted };
}
