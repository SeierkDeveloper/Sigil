// Ask your whole life, on the owner's device: one question searched across
// every folder at once, answered by the owner's own model when one is set (the
// call goes from this browser straight to the provider), or shown as the best
// matching memories when not. The server learns nothing: no question, no
// answer, no new request. Protected folders still need the owner's yes, and
// a saved answer is an ordinary encrypted memory.

import { answerMemoryBody, askLife, findEvidence, readTimeWords, type AskMemory, type LifeAnswer, type Memory, type ModelCaller } from "@sigil/core";
import type { Api } from "./api";
import { reportCaught } from "./immuneOps";
import { createMemory, type VaultData } from "./ops";
import { approveHere, guardedMemories, protectedFolderIds } from "./protectOps";

/** The source ref of an answer kept as a memory. Ask never uses its own saved answers as a source. */
export const ANSWER_REF = "ask";

type AskData = Pick<VaultData, "memories" | "folders" | "shares">;

/**
 * Every memory Ask may read on this device, as one array: the vault's own
 * (masked by each folder's redaction rules; protected folders included, the
 * ask decides whether they may be used) and folders other vaults shared with
 * this one. The Self card, weekly briefs and saved answers are left out. Make
 * it once per change of the data: search keeps its word index per array.
 */
export function askPool(data: AskData, now = Date.now()): AskMemory[] {
  const own = guardedMemories(
    { memories: data.memories.filter((m) => !(m.source.kind === "note" && m.source.ref === ANSWER_REF)), folders: data.folders },
    protectedFolderIds(data),
    now,
  );
  const shared: AskMemory[] = data.shares.incoming
    .filter((s) => s.acceptedAt && s.folder)
    .flatMap((s) =>
      s.memories.map((m) => ({
        id: m.id,
        folderId: s.folderId,
        folder: s.folder!.name,
        title: m.title,
        tags: m.tags,
        body: m.body,
        editedAt: m.editedAt,
        createdAt: m.createdAt,
        ...(m.when ? { when: m.when } : {}),
        expiresAt: m.expiresAt,
        source: { kind: m.source.kind },
      })),
    );
  return [...own, ...shared];
}

/** Every folder Ask can search: the vault's own, then the shared ones, by id and name. */
export function askFolders(data: Pick<VaultData, "folders" | "shares">): { id: string; name: string; shared: boolean; protect: boolean }[] {
  return [
    ...data.folders.map((f) => ({ id: f.id, name: f.name, shared: false, protect: !!f.protect })),
    ...data.shares.incoming.filter((s) => s.acceptedAt && s.folder).map((s) => ({ id: s.folderId, name: s.folder!.name, shared: true, protect: false })),
  ];
}

export type RangeChoice = "any" | "month" | "quarter" | "year" | "this-year" | "last-year" | "custom";

export const RANGE_LABELS: Record<RangeChoice, string> = {
  any: "Any time",
  month: "Past month",
  quarter: "Past three months",
  year: "Past year",
  "this-year": "This year",
  "last-year": "Last year",
  custom: "Between two dates",
};

/** The range the owner chose, in local time. Custom dates are YYYY-MM-DD, both days included. */
export function rangeFor(choice: RangeChoice, custom: { from: string; to: string } = { from: "", to: "" }, now = Date.now()): { from: number | null; to: number | null } | null {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const back = (days: number) => ({ from: today - (days - 1) * 86_400_000, to: today + 86_400_000 });
  switch (choice) {
    case "any":
      return null;
    case "month":
      return back(30);
    case "quarter":
      return back(91);
    case "year":
      return back(365);
    case "this-year":
      return { from: new Date(d.getFullYear(), 0).getTime(), to: new Date(d.getFullYear() + 1, 0).getTime() };
    case "last-year":
      return { from: new Date(d.getFullYear() - 1, 0).getTime(), to: new Date(d.getFullYear(), 0).getTime() };
    case "custom": {
      const day = (v: string, end: boolean) => {
        const [y, m, dd] = v.split("-").map(Number);
        return y && m && dd ? new Date(y, m - 1, dd + (end ? 1 : 0)).getTime() : null;
      };
      const r = { from: day(custom.from, false), to: day(custom.to, true) };
      return r.from === null && r.to === null ? null : r;
    }
  }
}

export interface AskInput {
  question: string;
  /** Folders chosen; empty for every folder. */
  folderIds: string[];
  range: { from: number | null; to: number | null } | null;
  /** Protected folders the owner said yes to for this question. */
  open: Set<string>;
}

export interface AskDeps {
  /** The owner's model, or null for the best matching memories only. */
  model: ModelCaller | null;
  embedQuery?: (q: string) => Promise<Float32Array | null>;
  vectors?: Map<string, Float32Array>;
  now?: number;
  /** Puts a count of what the immune system caught on the owner's record, as the AI self does. */
  api?: Api;
}

/** The folders this question may read: those chosen (or all), protected ones only with a yes. */
function readable(data: Pick<VaultData, "folders" | "shares">, input: Pick<AskInput, "folderIds" | "open">): string[] {
  const guarded = protectedFolderIds(data);
  const chosen = input.folderIds.length ? input.folderIds : askFolders(data).map((f) => f.id);
  return chosen.filter((id) => !guarded.has(id) || input.open.has(id));
}

/** The question's vector, from its words without the time words, when search by meaning is ready. */
async function vectorFor(question: string, deps: Pick<AskDeps, "embedQuery" | "now">): Promise<Float32Array | null> {
  if (!deps.embedQuery) return null;
  const { rest } = readTimeWords(question, deps.now);
  return deps.embedQuery(rest || question);
}

/**
 * Protected folders whose memories this question's answer would use, and
 * which ones: the same search as the answer, with protected folders opened,
 * so the owner is asked only about what would really be read.
 */
export async function protectedMatches(
  data: AskData & Pick<VaultData, "immune">,
  pool: AskMemory[],
  input: Omit<AskInput, "open">,
  deps: Omit<AskDeps, "model" | "api"> = {},
): Promise<{ id: string; name: string; ids: string[] }[]> {
  const guarded = data.folders.filter((f) => f.protect && (!input.folderIds.length || input.folderIds.includes(f.id)));
  if (guarded.length === 0) return [];
  const ev = findEvidence({
    question: input.question,
    memories: pool,
    folderIds: readable(data, { folderIds: input.folderIds, open: new Set(guarded.map((f) => f.id)) }),
    range: input.range,
    queryVector: await vectorFor(input.question, deps),
    vectors: deps.vectors,
    now: deps.now,
    immune: data.immune,
  });
  return guarded.map((f) => ({ id: f.id, name: f.name, ids: ev.sources.filter((s) => s.folderId === f.id).map((s) => s.id) })).filter((f) => f.ids.length);
}

/**
 * The owner said yes to protected folders for one answer written by their
 * model: the yes goes on the record the same way as in the AI self's test
 * chat, so the read log shows each protected memory a model read.
 */
export async function allowProtected(api: Api, folders: { id: string; ids: string[] }[]): Promise<void> {
  for (const f of folders) {
    const req = await approveHere(api, f.id, f.ids);
    await api.post(`access/${req.id}/use`, { memoryIds: f.ids });
  }
}

/** One question, across every folder it may read, on this device. */
export async function askVault(data: AskData & Pick<VaultData, "immune">, pool: AskMemory[], input: AskInput, deps: AskDeps): Promise<LifeAnswer> {
  const folderIds = readable(data, input);
  const question = input.question.replace(/\s+/g, " ").trim();
  if (!question) throw new Error("Ask a question first.");
  if (folderIds.length === 0) return { kind: "nothing", question, sentences: [], sources: [], period: null, inPeriod: true, dropped: 0, usedModel: false };
  return askLife({
    question,
    memories: pool,
    folderIds,
    range: input.range,
    queryVector: await vectorFor(question, deps),
    vectors: deps.vectors,
    now: deps.now,
    immune: data.immune,
    model: deps.model,
    onCaught: deps.api ? (c) => reportCaught(deps.api!, "self", c.held + c.neutralised) : undefined,
  });
}

/** Folders an answer may be kept in: any folder of the vault, or only protected ones when it used a protected folder. */
export function saveFolders(data: Pick<VaultData, "folders">, answer: Pick<LifeAnswer, "sources">): VaultData["folders"] {
  const guarded = protectedFolderIds(data);
  const usedProtected = answer.sources.some((s) => guarded.has(s.folderId));
  return data.folders.filter((f) => !usedProtected || f.protect);
}

/** Keeps an answer, with its sources, as a new encrypted memory in a folder the owner picks. */
export async function saveAnswer(api: Api, data: Pick<VaultData, "folders" | "thinking">, folderId: string, answer: LifeAnswer, at = new Date()): Promise<Memory> {
  const folder = saveFolders(data, answer).find((f) => f.id === folderId);
  if (!folder) throw new Error("Choose a folder for the answer.");
  const { title, body } = answerMemoryBody(answer, at);
  return createMemory(api, folder, { title, body, tags: ["answer"], source: { kind: "note", ref: ANSWER_REF } }, data.thinking.graceDays);
}
