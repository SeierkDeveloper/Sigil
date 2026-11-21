// The memory immune system in the open vault: which memories are held back
// for the owner's review (Inbox, Held for review), approving or deleting them,
// the owner's settings, and putting what was caught on the record. The text is
// read only here, on this device; the server gets counts.

import { clearedHash, flagged, levelFor, modelSaysInstruction, reasons, scanMemory, sealSetting, cleanImmune, type ImmuneSettings, type Memory, type ModelCaller, type ScanResult } from "@sigil/core";
import type { Api } from "./api";
import { saveMemory, type Unlocked, type VaultData } from "./ops";

export type CaughtWhere = "quarantine" | "self" | "link" | "public" | "session" | "meet" | "legacy" | "connector" | "proposal";

/** Puts a catch on the record (a line in the read log, sealed with the hour). Never stops what it reports on. */
export function reportCaught(api: Api, where: CaughtWhere, count: number, ref?: string): void {
  if (count < 1) return;
  void api.post("immune/caught", { where, count: Math.min(count, 10_000), ...(ref ? { ref } : {}) }).catch(() => undefined);
}

export async function saveImmune(api: Api, vault: Unlocked, settings: ImmuneSettings): Promise<ImmuneSettings> {
  const clean = cleanImmune(settings);
  await api.put("settings/immune", { value: await sealSetting(vault.key, "immune", clean) });
  return clean;
}

export interface HeldMemory {
  memory: Memory;
  result: ScanResult;
  reasons: string[];
  /** True when the owner's model, not the rules alone, judged it. */
  byModel: boolean;
}

/** Every memory held back now: from outside, flagged at its source's level, not approved since. */
export function heldMemories(data: Pick<VaultData, "memories" | "immune">): HeldMemory[] {
  const out: HeldMemory[] = [];
  for (const m of data.memories) {
    if (m.cleared && m.cleared === clearedHash(m.body)) continue;
    const level = levelFor(data.immune, m.source.kind);
    if (level === "off") continue;
    const result = scanMemory(m);
    if (flagged(result, level)) out.push({ memory: m, result, reasons: reasons(result), byModel: false });
  }
  return out;
}

/** Borderline memories (some finding, below the hold level), asked of the owner's own model when the owner turned that on. At most `limit` per call. */
export async function modelSecondOpinion(data: Pick<VaultData, "memories" | "immune">, model: ModelCaller, asked: Set<string>, limit = 10): Promise<HeldMemory[]> {
  if (!data.immune.model) return [];
  const out: HeldMemory[] = [];
  for (const m of data.memories) {
    if (out.length >= limit) break;
    if (asked.has(m.id) || (m.cleared && m.cleared === clearedHash(m.body))) continue;
    const level = levelFor(data.immune, m.source.kind);
    if (level === "off") continue;
    const result = scanMemory(m);
    if (result.score === 0 || flagged(result, level)) continue;
    asked.add(m.id);
    if (await modelSaysInstruction(model, `${m.title}\n${m.body}`)) out.push({ memory: m, result, reasons: ["Your model judged it an instruction to an AI", ...reasons(result)], byModel: true });
  }
  return out;
}

/** The owner lets a held memory through: its body's fingerprint goes into its encrypted head. A later change to the body is checked again. */
export async function approveHeld(api: Api, data: Pick<VaultData, "folders" | "thinking">, memory: Memory): Promise<Memory> {
  const folder = data.folders.find((f) => f.id === memory.folderId);
  if (!folder) throw new Error("The folder of this memory is gone.");
  return saveMemory(api, folder, { ...memory, cleared: clearedHash(memory.body) }, data.thinking.graceDays);
}
