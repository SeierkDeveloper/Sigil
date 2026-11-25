// Holder tiers in the vault: linking the wallet that holds the token, reading
// the tier again, and the included AI answers a holder without a model key of
// their own gets each day. Own keys always come first: with a key, every call
// still goes from this device straight to the provider.

import { createModelCaller, ModelError, type ModelCaller, type ModelRequest } from "@sigil/core";
import { ApiError, type Api } from "./api";
import type { HolderView, VaultData } from "./ops";
import { connectWallet } from "./wallet";

export const TIER_NAME = { bearer: "Bearer", keeper: "Keeper", warden: "Warden" } as const;
export type Tier = keyof typeof TIER_NAME;

/** What each tier gives, in the order shown. Kept in step with server/holders.ts. */
export const TIERS: { tier: Tier; min: number; perks: string[] }[] = [
  { tier: "bearer", min: 1_000_000, perks: ["10 included AI answers a day in Ask and your AI self, no API key needed", "The holder mark on your public AI self page and ask links"] },
  { tier: "keeper", min: 5_000_000, perks: ["30 included AI answers a day", "The holder mark"] },
  {
    tier: "warden",
    min: 10_000_000,
    perks: ["75 included AI answers a day", "A short handle of 3 or 4 letters for your public AI self", "Each day's reads of your vault anchored on chain", "The Warden mark"],
  },
];

/** The label the vault shows for a model that is an included answer. */
export const INCLUDED_MODEL = "included";

/** Thrown when today's included answers are used: Ask then shows the memories that answer best. */
export class AnswersUsed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswersUsed";
  }
}

export function includedAvailable(data: Pick<VaultData, "model" | "holder">): boolean {
  return !data.model && !!data.holder?.tier && !!data.holder.includedOn;
}

export function answersLeft(holder: HolderView | null): number {
  return holder?.tier ? Math.max(0, holder.answersPerDay - holder.answersUsedToday) : 0;
}

/** The caller for answers: the owner's own key when there is one, otherwise the holder's included answers, otherwise none. */
export function answerCaller(data: Pick<VaultData, "model" | "holder">, api: Api): ModelCaller | null {
  if (data.model) return createModelCaller(data.model);
  if (!includedAvailable(data)) return null;
  return {
    provider: "anthropic",
    model: INCLUDED_MODEL,
    async complete(req: ModelRequest): Promise<string> {
      try {
        const r = await api.post<{ text: string; left: number }>("holder/answer", req);
        return r.text;
      } catch (err) {
        if (err instanceof ApiError && err.code === "answers_used") throw new AnswersUsed(err.message);
        if (err instanceof ApiError) throw new ModelError(err.message, err.status === 429 ? "rate" : "provider");
        throw err;
      }
    },
  };
}

export async function loadHolder(api: Api): Promise<HolderView> {
  return api.get<HolderView>("holder");
}

/** Connects the wallet, asks it to sign the link message once, and links it. Nothing is sent on chain. */
export async function linkWallet(api: Api): Promise<HolderView> {
  const { provider, address } = await connectWallet();
  const { challengeId, message } = await api.post<{ challengeId: string; message: string }>("holder/challenge", { address });
  let signature: string;
  try {
    const hex = "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
    signature = (await provider.request({ method: "personal_sign", params: [hex, address] })) as string;
  } catch (err) {
    const e = err as { code?: number; message?: string };
    throw new Error(e?.code === 4001 ? "You declined the request in your wallet." : (e?.message ?? "The wallet request failed."));
  }
  return api.post<HolderView>("holder/link", { challengeId, address, signature });
}

export async function refreshHolder(api: Api): Promise<HolderView> {
  return api.post<HolderView>("holder/refresh");
}

export async function unlinkWallet(api: Api): Promise<HolderView> {
  return api.del<HolderView>("holder");
}

/** The whole read log with every seal proof, as a file. */
export async function exportLog(api: Api): Promise<Blob> {
  const file = await api.get<unknown>("log/export");
  return new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
}
