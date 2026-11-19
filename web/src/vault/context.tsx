"use client";

import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

export interface VaultCtx {
  api: Api;
  vault: Unlocked;
  data: VaultData;
  /** Replace the decrypted data after a change (functional form like setState). */
  update(fn: (d: VaultData) => VaultData): void;
  /** Fetch and decrypt everything again. */
  reload(): Promise<void>;
  goTo(tab: TabId): void;
  lock(): void;
  signOut(): Promise<void>;
}

export type TabId = "memories" | "folders" | "apps" | "log" | "import" | "settings";

export const Ctx = createContext<VaultCtx | null>(null);

export function useVault(): VaultCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside the vault");
  return v;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}
