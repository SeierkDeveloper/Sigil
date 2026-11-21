// The getting-started guide: where the owner is, worked out from the vault
// itself (memories imported, an app connected, an app's first read) plus a
// small record kept encrypted as the "guide" setting, so it resumes on any
// device and can be skipped step by step or as a whole.

import { cleanGuide, newGuide, sealSetting, GUIDE_STEPS, type GuideState, type GuideStep } from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

export type { GuideState, GuideStep };

export async function saveGuide(api: Api, vault: Unlocked, guide: GuideState): Promise<GuideState> {
  const clean = cleanGuide(guide)!;
  await api.put("settings/guide", { value: await sealSetting(vault.key, "guide", clean) });
  return clean;
}

/** The guide of a vault just made: the phrase was saved and checked on the way in. */
export function startGuide(api: Api, vault: Unlocked): Promise<GuideState> {
  return saveGuide(api, vault, newGuide(true));
}

/** Apps a person talks to (not agents, the extension or a web app signed in with Sigil). */
export function chatApps(data: Pick<VaultData, "apps" | "agents">) {
  return data.apps.filter((a) => !a.revokedAt && !data.agents.some((x) => x.appId === a.id) && a.kind !== "extension" && a.kind !== "web");
}

export type StepState = "done" | "skipped" | "todo";

export function stepStates(data: Pick<VaultData, "guide" | "memories" | "apps" | "agents">): Record<GuideStep, StepState> {
  const g = data.guide;
  const skipped = new Set(g?.skipped ?? []);
  const state = (done: boolean, step: GuideStep): StepState => (done ? "done" : skipped.has(step) ? "skipped" : "todo");
  return {
    phrase: state(!!g?.phraseChecked, "phrase"),
    import: state(data.memories.some((m) => m.source.kind === "chatgpt" || m.source.kind === "claude"), "import"),
    connect: state(chatApps(data).length > 0, "connect"),
    answer: state(!!g?.answeredAt, "answer"),
  };
}

/** The first step still to do, or null when every step is done or skipped. */
export function currentStep(states: Record<GuideStep, StepState>): GuideStep | null {
  return GUIDE_STEPS.find((s) => states[s] === "todo") ?? null;
}

/** Whether the guide shows: started in this vault, and not closed. */
export function guideOpen(data: Pick<VaultData, "guide">): boolean {
  return !!data.guide && !data.guide.dismissed;
}
