"use client";

import { createContext, useContext } from "react";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";
import type { SemanticIndex } from "./semantic";
import type { AgentState } from "./useSelfAgent";
import type { SyncAgentState } from "./useLiveSync";

export interface VaultCtx {
  api: Api;
  vault: Unlocked;
  data: VaultData;
  /** Replace the decrypted data after a change (functional form like setState). */
  update(fn: (d: VaultData) => VaultData): void;
  /** Fetch and decrypt everything again. */
  reload(): Promise<void>;
  goTo(tab: TabId): void;
  /** Opens one memory in the Memories tab. */
  openMemory(id: string): void;
  /** The memory another tab asked to open in the Memories tab. */
  focus: string | null;
  /** Search by meaning, computed on this device. */
  semantic: SemanticIndex;
  /** Whether this open vault is answering ask links right now. */
  agent: AgentState;
  /** Live sync running in this open vault. */
  liveSync: SyncAgentState;
  /** Grows each time the read log has new lines (checked every half minute while the vault is open). */
  logTick: number;
  lock(): void;
  signOut(): Promise<void>;
}

export type TabId =
  | "memories"
  | "ask"
  | "inbox"
  | "self"
  | "work"
  | "identity"
  | "meet"
  | "agreements"
  | "review"
  | "timeline"
  | "profile"
  | "folders"
  | "apps"
  | "agents"
  | "devices"
  | "legacy"
  | "proof"
  | "emergency"
  | "packs"
  | "log"
  | "import"
  | "sync"
  | "storage"
  | "shared"
  | "settings";

export const Ctx = createContext<VaultCtx | null>(null);

export function useVault(): VaultCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside the vault");
  return v;
}

const TECHNICAL = /(undefined is not|is not a function|is not defined|Cannot read propert|Cannot set propert|Unexpected token|Unexpected end of JSON|at \w+ \(|Failed to execute|DOMException|OperationError)/;

/**
 * An error in words a person can act on. The server's and Sigil's own messages
 * are already written that way; anything that comes from deeper down (the
 * network, the browser's passkey prompt, a decryption, a bug) is put plainly,
 * and the original goes to the browser console for whoever debugs it.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong. Please try again.";
  const name = err.name;
  const msg = err.message ?? "";
  if (name === "ApiError" || name === "ModelError" || name === "SyncError" || name === "LegacyError" || name === "ImportError" || name === "LocalImportError") return msg || "Something went wrong. Please try again.";
  if (name === "NotAllowedError" || name === "AbortError") return "The request was cancelled or timed out. Try again when you are ready.";
  if (name === "DecryptError") return "This could not be opened with your vault key. It may belong to another vault, or it was changed.";
  if (name === "QuotaExceededError") return "This browser has no room left to keep that. Free some space and try again.";
  if (name === "TypeError" && /fetch|network|load failed/i.test(msg)) return "Sigil could not be reached. Check your connection and try again.";
  if (!msg || name === "TypeError" || name === "ReferenceError" || name === "RangeError" || name === "SyntaxError" || TECHNICAL.test(msg)) {
    console.error("[sigil]", err);
    return "Something went wrong on this page. Please try again; if it keeps happening, reload the page.";
  }
  return msg;
}
