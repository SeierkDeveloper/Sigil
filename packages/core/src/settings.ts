// Vault settings: small JSON documents (the AI self's rules, the model key, how
// the vault thinks) encrypted under the vault key on the device. The server
// stores each one as an envelope under a name and cannot read any of them.

import { decryptJson, encryptJson } from "./crypto";
import { AAD } from "./keys";

/**
 * self      the AI self's rules              model     the owner's model key
 * thinking  how the vault thinks             work      what the AI self holds for approval and how it learns
 * identity  the AI self's identity choices   wallet    the draft rules of its wallet
 * packs     the knowledge packs this vault follows
 */
export type SettingName = "self" | "model" | "thinking" | "work" | "identity" | "wallet" | "packs";

export const SETTING_NAMES: readonly SettingName[] = ["self", "model", "thinking", "work", "identity", "wallet", "packs"];

export function isSettingName(value: string): value is SettingName {
  return (SETTING_NAMES as readonly string[]).includes(value);
}

export async function sealSetting(vaultKey: CryptoKey, name: SettingName, value: unknown): Promise<string> {
  return encryptJson(vaultKey, value, AAD.setting(name));
}

export async function openSetting<T>(vaultKey: CryptoKey, name: SettingName, envelope: string): Promise<T> {
  return decryptJson<T>(vaultKey, envelope, AAD.setting(name));
}

/** How the vault thinks about its memories. Kept encrypted like every setting. */
export interface ThinkingSettings {
  /** Write a brief into the Briefs folder when the vault opens and the last one is a week old. */
  weeklyBrief: boolean;
  /** Let the owner's model write the brief. Off: the brief is made without a model. */
  briefWithModel: boolean;
  /** Ask the owner's model whether two close memories really disagree. */
  contradictionsWithModel: boolean;
  /** Days an expired memory waits in Expired before it is deleted for real. */
  graceDays: number;
}

export const DEFAULT_THINKING: ThinkingSettings = { weeklyBrief: true, briefWithModel: false, contradictionsWithModel: false, graceDays: 30 };

export const MAX_GRACE_DAYS = 365;

export function cleanThinking(value: unknown): ThinkingSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof ThinkingSettings, unknown>>;
  const grace = Number(v.graceDays);
  return {
    weeklyBrief: typeof v.weeklyBrief === "boolean" ? v.weeklyBrief : DEFAULT_THINKING.weeklyBrief,
    briefWithModel: v.briefWithModel === true,
    contradictionsWithModel: v.contradictionsWithModel === true,
    graceDays: Number.isInteger(grace) && grace >= 0 && grace <= MAX_GRACE_DAYS ? grace : DEFAULT_THINKING.graceDays,
  };
}
