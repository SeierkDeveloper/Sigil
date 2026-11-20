// Agents get their own memory.
//
// An agent (Cursor, Claude Code, any MCP client) is a connected app with an
// agent record: its own folder, the other folders it may read or write, and
// rules for each of its tools. Its key is an ordinary app key, so the same
// connector runs it, and every call lands in the same read log and seals.
//
// From the agent's secret the vault and the connector both derive:
//   an X25519 key pair    so a team space can seal its key to the agent
//   a handoff key         for notes the agent leaves for its next session
// The owner holds the app secret under the vault key, so the owner can read
// those notes too.

import { hkdf as hkdfSync } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { boxKeyPairFromSecret, encodeBoxPublicKey, type BoxKeyPair } from "./box";
import { DecryptError, decryptJson, encryptJson, hkdf, importKey } from "./crypto";
import { utf8 } from "./encoding";
import { AAD } from "./keys";

export interface AgentRules {
  /** remember: write new memories to its own folder and to folders it may write. */
  remember: boolean;
  /** recall: search and read the folders it may read. */
  recall: boolean;
  /** forget: delete memories, only in folders it may write. */
  forget: boolean;
  /** handoff: leave and pick up notes for its next session and for team spaces. */
  handoff: boolean;
}

export const DEFAULT_AGENT_RULES: AgentRules = { remember: true, recall: true, forget: false, handoff: true };

export const AGENT_TOOLS: (keyof AgentRules)[] = ["remember", "recall", "forget", "handoff"];

export function cleanAgentRules(value: unknown): AgentRules {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof AgentRules, unknown>>;
  return {
    remember: typeof v.remember === "boolean" ? v.remember : DEFAULT_AGENT_RULES.remember,
    recall: typeof v.recall === "boolean" ? v.recall : DEFAULT_AGENT_RULES.recall,
    forget: v.forget === true,
    handoff: typeof v.handoff === "boolean" ? v.handoff : DEFAULT_AGENT_RULES.handoff,
  };
}

/** The agent's own X25519 key pair, the same on the owner's device and in the connector. */
export function agentBoxPair(secret: Uint8Array): BoxKeyPair {
  if (secret.length !== 32) throw new Error("An app secret is 32 bytes.");
  return boxKeyPairFromSecret(hkdfSync(sha256, secret, utf8("sigil/agent-box/v1"), utf8("sigil:agent-box"), 32));
}

export function agentPublicKey(secret: Uint8Array): string {
  return encodeBoxPublicKey(agentBoxPair(secret).publicKey);
}

// ---------------------------------------------------------------- handoff notes

export interface HandoffNote {
  v: 1;
  /** The agent that left it, by the name the owner gave it. */
  from: string;
  text: string;
  /** For a note in a space: the agent it is meant for, by name, if any. */
  to: string | null;
  createdAt: string;
}

export const MAX_HANDOFF = 20_000;

/** The key for notes an agent leaves for its own next session. */
export async function agentHandoffKey(secret: Uint8Array): Promise<Uint8Array> {
  return hkdf(secret, "sigil:handoff:self");
}

/** The key for notes left in a team space, readable by every member. */
export async function spaceHandoffKey(spaceKey: Uint8Array): Promise<Uint8Array> {
  return hkdf(spaceKey, "sigil:handoff:space");
}

export function cleanHandoff(note: Partial<HandoffNote>, now = new Date().toISOString()): HandoffNote {
  const text = String(note.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_HANDOFF);
  if (!text) throw new Error("A handoff note needs some text.");
  return { v: 1, from: String(note.from ?? "").trim().slice(0, 80) || "An agent", text, to: note.to ? String(note.to).trim().slice(0, 80) : null, createdAt: note.createdAt ?? now };
}

export async function sealHandoff(key: Uint8Array, handoffId: string, note: HandoffNote): Promise<string> {
  return encryptJson(await importKey(key), note, AAD.handoff(handoffId));
}

export async function openHandoff(key: Uint8Array, handoffId: string, envelope: string): Promise<HandoffNote> {
  const n = await decryptJson<HandoffNote>(await importKey(key), envelope, AAD.handoff(handoffId));
  if (typeof n.text !== "string") throw new DecryptError("This handoff note is damaged.");
  return cleanHandoff(n);
}
