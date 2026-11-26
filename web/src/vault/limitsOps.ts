// Limits for acting, on the owner's device: what the AI self may do on its
// own, kept as an encrypted setting ("limits") like every other setting.
// Everything past a limit goes to the approval queue in Work. When the self
// acts within a limit, it signs a receipt (receiptOps.ts).

import { cleanLimits, DEFAULT_LIMITS, openSetting, sealSetting, type SelfLimits } from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

export async function openLimits(vault: Unlocked, envelope: string | undefined): Promise<SelfLimits> {
  if (!envelope) return DEFAULT_LIMITS;
  return cleanLimits(await openSetting<unknown>(vault.key, "limits", envelope));
}

export async function saveLimits(api: Api, vault: Unlocked, limits: SelfLimits): Promise<SelfLimits> {
  const clean = cleanLimits(limits);
  await api.put("settings/limits", { value: await sealSetting(vault.key, "limits", clean) });
  return clean;
}

/** The owner's time zone as this browser knows it, for free hours. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
