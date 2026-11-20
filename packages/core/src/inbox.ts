// The memory inbox. A connected app, the browser extension or a signed-in web
// app may suggest a memory; it is sealed on the user's machine to the vault's
// public key (box.ts), so the server holds a proposal it cannot read. The
// owner opens it in the vault, edits it, and approves, merges or rejects it.
// Nothing becomes a memory without that step.

import { openSealedJson, sealJson, type BoxKeyPair } from "./box";
import { cleanTags, MAX_TITLE } from "./vault";

/** How a proposal reached the inbox. */
export type ProposalVia = "mcp" | "extension" | "sdk";

export interface ProposalDraft {
  title: string;
  body: string;
  tags?: string[];
  /** The folder the app suggests, by name. The owner decides. */
  folder?: string;
  /** For pages saved with the browser extension. */
  url?: string;
}

export interface ProposalPayload {
  v: 1;
  title: string;
  body: string;
  tags: string[];
  folder: string | null;
  url: string | null;
  via: ProposalVia;
  createdAt: string;
}

/** A proposal as the server stores it: ids, a time and one sealed box. */
export interface StoredProposal {
  id: string;
  appId: string;
  sealed: string;
  createdAt: string;
}

export const MAX_PROPOSAL_BODY = 100_000;

export function proposalContext(proposalId: string, appId: string): string {
  return `proposal:${proposalId}:${appId}`;
}

export function cleanProposal(draft: ProposalDraft, via: ProposalVia, now = new Date().toISOString()): ProposalPayload {
  const title = (draft.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const body = (draft.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_PROPOSAL_BODY);
  if (!title && !body) throw new Error("A suggested memory needs a title or some text.");
  let url: string | null = null;
  if (draft.url) {
    try {
      const u = new URL(draft.url);
      if (u.protocol === "https:" || u.protocol === "http:") url = u.toString().slice(0, 2000);
    } catch {
      url = null;
    }
  }
  const folder = draft.folder?.trim().slice(0, 120) || null;
  return { v: 1, title: title || body.slice(0, 80), body, tags: cleanTags(draft.tags), folder, url, via, createdAt: now };
}

/** Seals a proposal for the vault. Runs where the app runs: the connector, the extension or the SDK. */
export function sealProposal(vaultPublicKey: Uint8Array, proposalId: string, appId: string, payload: ProposalPayload): string {
  return sealJson(vaultPublicKey, payload, proposalContext(proposalId, appId));
}

/** Opens a proposal in the vault. Fails if it was moved to another id or claims another app. */
export function openProposal(pair: BoxKeyPair, stored: Pick<StoredProposal, "id" | "appId" | "sealed">): ProposalPayload {
  const p = openSealedJson<ProposalPayload>(pair, stored.sealed, proposalContext(stored.id, stored.appId));
  return {
    v: 1,
    title: String(p.title ?? ""),
    body: String(p.body ?? ""),
    tags: cleanTags(Array.isArray(p.tags) ? p.tags.map(String) : []),
    folder: typeof p.folder === "string" ? p.folder : null,
    url: typeof p.url === "string" ? p.url : null,
    via: p.via === "extension" || p.via === "sdk" ? p.via : "mcp",
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(0).toISOString(),
  };
}

/** Merging a proposal into a memory keeps the memory and adds the new text under a dated line. */
export function mergeBodies(existing: string, addition: string, at = new Date().toISOString()): string {
  const a = existing.trimEnd();
  const b = addition.trim();
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a}\n\n---\nAdded ${at.slice(0, 10)}\n\n${b}`;
}
