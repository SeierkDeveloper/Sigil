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
 * backup    where the vault's bundles are stored, with the owner's storage tokens, and how often
 * voice     whether the test chat listens and speaks
 * guide     how far the owner got in the getting-started guide
 */
export type SettingName = "self" | "model" | "thinking" | "work" | "identity" | "wallet" | "packs" | "backup" | "voice" | "guide";

export const SETTING_NAMES: readonly SettingName[] = ["self", "model", "thinking", "work", "identity", "wallet", "packs", "backup", "voice", "guide"];

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

// ---------------------------------------------------------------- the getting-started guide

export type GuideStep = "phrase" | "import" | "connect" | "answer";

export const GUIDE_STEPS: readonly GuideStep[] = ["phrase", "import", "connect", "answer"];

/** How far the owner got in the guide. Kept encrypted like every setting, so it resumes on any device. */
export interface GuideState {
  v: 1;
  startedAt: string;
  /** The recovery phrase was saved and two of its words typed back. */
  phraseChecked: boolean;
  skipped: GuideStep[];
  /** The app made in the guide, whose first read finishes it. */
  appId: string | null;
  /** When an app first read from the vault. */
  answeredAt: string | null;
  /** Closed for good, finished or not. */
  dismissed: boolean;
}

export function newGuide(phraseChecked: boolean, now = new Date().toISOString()): GuideState {
  return { v: 1, startedAt: now, phraseChecked, skipped: [], appId: null, answeredAt: null, dismissed: false };
}

export function cleanGuide(value: unknown): GuideState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const at = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
  return {
    v: 1,
    startedAt: at(v.startedAt) ?? new Date(0).toISOString(),
    phraseChecked: v.phraseChecked === true,
    skipped: Array.isArray(v.skipped) ? GUIDE_STEPS.filter((s) => (v.skipped as unknown[]).includes(s)) : [],
    appId: typeof v.appId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v.appId) ? v.appId : null,
    answeredAt: at(v.answeredAt),
    dismissed: v.dismissed === true,
  };
}

/** Two word positions (1 to 24) to type back, different each time. */
export function phraseCheckPositions(random: () => number = Math.random): [number, number] {
  const a = 1 + Math.floor(random() * 24);
  let b = 1 + Math.floor(random() * 24);
  while (b === a) b = 1 + Math.floor(random() * 24);
  return a < b ? [a, b] : [b, a];
}
