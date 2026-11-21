// Parses ChatGPT and Claude data exports into memory drafts. It runs in the
// browser: the export file is read, parsed and encrypted on the device, and the
// server only ever receives the encrypted result.

import type { MemoryDraft, SourceKind } from "../vault";
import { parseChatGptConversations } from "./chatgpt";
import { parseClaudeConversations, parseClaudeMemories, parseClaudeProjects } from "./claude";
import { clampBody, unzipLimited, ZipTooLarge } from "./util";

export { toIso, clampBody, MAX_BODY_CHARS } from "./util";

export interface ImportResult {
  source: Extract<SourceKind, "chatgpt" | "claude">;
  drafts: MemoryDraft[];
  /** Conversations or documents that had nothing readable in them. */
  skipped: number;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}


function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError(`${name} is not valid JSON.`);
  }
}

const decoder = new TextDecoder("utf-8");

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

type Detected = "chatgpt" | "claude" | null;

export function detectConversations(data: unknown): Detected {
  if (!Array.isArray(data)) return null;
  const sample = data.find((c) => c && typeof c === "object");
  if (!sample) return null;
  if ("mapping" in sample) return "chatgpt";
  if ("chat_messages" in sample) return "claude";
  return null;
}

/**
 * Accepts the zip a user downloads from ChatGPT or Claude, or the conversations.json
 * inside it. Returns the drafts to encrypt and store.
 */
export function parseExport(fileName: string, bytes: Uint8Array): ImportResult {
  const files = new Map<string, unknown>();

  if (isZip(bytes)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipLimited(bytes, (f) => f.name.toLowerCase().endsWith(".json") && !f.name.startsWith("__MACOSX"));
    } catch (err) {
      if (err instanceof ZipTooLarge) throw new ImportError("This zip file opens to more than an import can hold.");
      throw new ImportError("This zip file could not be opened.");
    }
    for (const [path, content] of Object.entries(entries)) {
      files.set(baseName(path).toLowerCase(), parseJson(decoder.decode(content), baseName(path)));
    }
  } else {
    const text = decoder.decode(bytes).replace(/^﻿/, "");
    files.set(baseName(fileName).toLowerCase() || "conversations.json", parseJson(text, fileName));
  }

  const conversationFiles = [...files.entries()].filter(([name]) => /^conversations(-\d+)?\.json$/.test(name));
  const anyConversations = conversationFiles.length > 0 ? conversationFiles : [...files.entries()].filter(([, d]) => detectConversations(d));

  let kind: Detected = null;
  for (const [, data] of anyConversations) {
    kind = detectConversations(data);
    if (kind) break;
  }
  const isClaudeExtras = files.has("projects.json") || files.has("memories.json");
  if (!kind && isClaudeExtras) kind = "claude";
  if (!kind) {
    throw new ImportError("No ChatGPT or Claude conversations were found in this file. Choose the zip you downloaded from the app's data export.");
  }

  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  const conversations = anyConversations.flatMap(([, data]) => (Array.isArray(data) ? data : []));

  if (kind === "chatgpt") {
    const r = parseChatGptConversations(conversations);
    drafts.push(...r.drafts);
    skipped += r.skipped;
  } else {
    const r = parseClaudeConversations(conversations);
    drafts.push(...r.drafts);
    skipped += r.skipped;
    if (files.has("projects.json")) {
      const p = parseClaudeProjects(files.get("projects.json"));
      drafts.push(...p.drafts);
      skipped += p.skipped;
    }
    if (files.has("memories.json")) {
      drafts.push(...parseClaudeMemories(files.get("memories.json")));
    }
  }

  for (const d of drafts) d.body = clampBody(d.body);
  return { source: kind, drafts, skipped };
}

export { parseChatGptConversations } from "./chatgpt";
export { parseClaudeConversations, parseClaudeProjects, parseClaudeMemories } from "./claude";

export * from "./files";
export * from "./notes";
export * from "./google";
export * from "./github";
export * from "./meeting";
