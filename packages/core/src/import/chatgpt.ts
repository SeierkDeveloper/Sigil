// ChatGPT export: conversations.json is a list of conversations, each holding a
// tree of messages in `mapping`. Edits and regenerations create branches; the
// branch the user last saw ends at `current_node`, so that is the one we keep.

import type { MemoryDraft } from "../vault";
import { toIso } from "./util";

interface GptMessage {
  author?: { role?: string };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[]; text?: unknown };
  metadata?: { is_visually_hidden_from_conversation?: boolean };
}

interface GptNode {
  id?: string;
  message?: GptMessage | null;
  parent?: string | null;
  children?: string[];
}

interface GptConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, GptNode>;
  current_node?: string | null;
}

function messageText(m: GptMessage): string {
  const c = m.content;
  if (!c) return "";
  switch (c.content_type) {
    case "text":
    case "multimodal_text": {
      const parts = Array.isArray(c.parts) ? c.parts : [];
      return parts
        .map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? "[Attachment]" : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    case "code":
      return typeof c.text === "string" && c.text.trim() ? "```\n" + c.text.trim() + "\n```" : "";
    default:
      return "";
  }
}

function pickLeaf(mapping: Record<string, GptNode>, current?: string | null): string | null {
  if (current && mapping[current]) return current;
  // Older exports have no current_node: take the newest leaf.
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    if (node.children && node.children.length > 0) continue;
    const t = node.message?.create_time ?? 0;
    if (t >= bestTime) {
      bestTime = t;
      best = id;
    }
  }
  return best;
}

export function threadOf(conv: GptConversation): GptMessage[] {
  const mapping = conv.mapping ?? {};
  const out: GptMessage[] = [];
  const seen = new Set<string>();
  let id = pickLeaf(mapping, conv.current_node);
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    if (node.message) out.push(node.message);
    id = node.parent ?? null;
  }
  return out.reverse();
}

export function parseChatGptConversations(list: unknown[]): { drafts: MemoryDraft[]; skipped: number } {
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const conv = raw as GptConversation;
    const lines: string[] = [];
    for (const m of threadOf(conv)) {
      const role = m.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      const text = messageText(m);
      if (!text) continue;
      lines.push(`### ${role === "user" ? "You" : "ChatGPT"}\n\n${text}`);
    }
    if (lines.length === 0) {
      skipped++;
      continue;
    }
    const created = toIso(conv.create_time);
    drafts.push({
      title: conv.title?.trim() || "Untitled conversation",
      body: lines.join("\n\n"),
      tags: ["chatgpt"],
      source: { kind: "chatgpt", ref: conv.conversation_id ?? conv.id },
      createdAt: created,
      editedAt: toIso(conv.update_time) ?? created,
    });
  }
  return { drafts, skipped };
}
