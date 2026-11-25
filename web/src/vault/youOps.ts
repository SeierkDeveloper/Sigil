// A model of you, on the owner's device: lessons learned from the folders the
// owner chose, the choices they make, the ranker trained on those choices in
// this browser, and the history that lets them undo. All of it is one setting
// encrypted under the vault key; the server stores an envelope it cannot read.
// When the owner shares it, the lessons are also written as a memory in the
// Self card folder, where only apps given that folder can read them.

import {
  buildMemory,
  dropLesson,
  isHeld,
  lessonSources,
  neutralise,
  PROFILE_FOLDER_NAME,
  parseYouLessons,
  randomId,
  rollBack,
  sealSetting,
  trainYou,
  withSnapshot,
  youFeatures,
  youLessonPrompt,
  youMemoryBody,
  YOU_MAX_CHOICES,
  YOU_MEMORY_TITLE,
  type ModelCaller,
  type SelfMemory,
  type YouState,
} from "@sigil/core";
import type { Api } from "./api";
import { addFolder, deleteMemories, profileFolder, saveMemory, type Unlocked, type VaultData } from "./ops";
import type { Memory, OpenFolder } from "@sigil/core";
import { guardedMemories } from "./protectOps";

export async function saveYou(api: Api, vault: Unlocked, you: YouState): Promise<YouState> {
  await api.put("settings/you", { value: await sealSetting(vault.key, "you", you) });
  return you;
}

/** The memories it may learn from: the chosen folders, without protected folders, held memories or the Self card. */
export function youPool(data: Pick<VaultData, "memories" | "folders" | "immune">, you: Pick<YouState, "folders">): SelfMemory[] {
  const chosen = new Set(you.folders);
  return guardedMemories(data).filter((m) => chosen.has(m.folderId) && !isHeld(m, data.immune));
}

/** Folders the owner can pick: every folder except the Self card and agents' own folders. */
export function youFolders(data: Pick<VaultData, "folders" | "memories">): { id: string; name: string; count: number; protect: boolean }[] {
  return data.folders
    .filter((f) => f.kind !== "profile" && f.kind !== "agent")
    .map((f) => ({ id: f.id, name: f.name, count: data.memories.filter((m) => m.folderId === f.id).length, protect: !!f.protect }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One round of learning: a model reads up to 60 of the newest memories in the chosen folders and writes the lessons. */
export async function learnLessons(data: Pick<VaultData, "memories" | "folders" | "immune">, you: YouState, model: ModelCaller, at = new Date()): Promise<YouState> {
  const pool = youPool(data, you);
  if (pool.length < 3) throw new Error("Choose folders with at least 3 memories first.");
  const sources = lessonSources(pool).map((m) => ({ ...m, body: neutralise(m.body).text }));
  const prompt = youLessonPrompt(sources, you.lessons);
  const text = await model.complete(prompt);
  const lessons = parseYouLessons(text, sources, you.dropped, randomId, at);
  if (!lessons.length) throw new Error("The model did not find lessons it could stand behind in these memories. Add more folders, or try again.");
  const next: YouState = { ...you, lessons, learnedAt: at.toISOString(), learnedFrom: sources.length };
  return withSnapshot(next, `Learned ${lessons.length} lessons from ${sources.length} memories`, at);
}

export function addChoice(you: YouState, win: string, lose: string, at = new Date()): YouState {
  return { ...you, choices: [...you.choices, { win, lose, at: at.toISOString() }].slice(-YOU_MAX_CHOICES), updatedAt: at.toISOString() };
}

/** Trains the ranker in this browser on the owner's choices, and scores it on the choices it held back. */
export function trainOnDevice(data: Pick<VaultData, "memories">, you: YouState, at = new Date()): YouState {
  const wanted = new Set(you.choices.flatMap((c) => [c.win, c.lose]));
  const features = new Map(data.memories.filter((m) => wanted.has(m.id)).map((m) => [m.id, youFeatures(m)] as const));
  return trainYou(you, features, at);
}

export { dropLesson, rollBack };

/** The memory apps read, kept in step with the lessons: written when shared, deleted when not. Returns what changed, for the open vault. */
export async function syncYouMemory(
  api: Api,
  vault: Unlocked,
  data: Pick<VaultData, "folders" | "memories">,
  you: YouState,
): Promise<{ folder: OpenFolder | null; written: Memory | null; removed: string[] }> {
  const existing = data.memories.filter((m) => m.source.kind === "model");
  if (!you.shareWithApps || !you.lessons.length) {
    if (!existing.length) return { folder: null, written: null, removed: [] };
    const removed = existing.map((m) => m.id);
    await deleteMemories(api, removed);
    return { folder: null, written: null, removed };
  }
  const had = profileFolder(data);
  const folder = had ?? (await addFolder(api, vault, PROFILE_FOLDER_NAME, "profile"));
  const keep = existing.find((m) => m.folderId === folder.id);
  const memory = buildMemory(
    { title: YOU_MEMORY_TITLE, body: youMemoryBody(you), tags: ["model-of-you"], source: { kind: "model" }, createdAt: keep?.createdAt, editedAt: new Date().toISOString() },
    folder.id,
    keep?.id,
  );
  await saveMemory(api, folder, memory);
  const removed = existing.filter((m) => m.id !== memory.id).map((m) => m.id);
  if (removed.length) await deleteMemories(api, removed);
  return { folder: had ? null : folder, written: memory, removed };
}

/** The open vault after a sync: the new folder, the memory written, the ones removed. */
export function withYouMemory<D extends Pick<VaultData, "folders" | "memories">>(d: D, r: Awaited<ReturnType<typeof syncYouMemory>>): D {
  const gone = new Set([...r.removed, ...(r.written ? [r.written.id] : [])]);
  return {
    ...d,
    folders: r.folder ? [...d.folders, r.folder] : d.folders,
    memories: [...d.memories.filter((m) => !gone.has(m.id)), ...(r.written ? [r.written] : [])],
  };
}
