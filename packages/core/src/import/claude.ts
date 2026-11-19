// Claude export: conversations.json is a flat list of conversations with
// `chat_messages`; projects.json holds projects with their instructions and
// documents; memories.json, when present, holds the memory Claude kept.

import type { MemoryDraft } from "../vault";
import { toIso } from "./util";

interface ClaudeBlock {
  type?: string;
  text?: unknown;
}

interface ClaudeMessage {
  sender?: string;
  text?: unknown;
  content?: ClaudeBlock[];
  attachments?: { file_name?: string }[];
  files?: { file_name?: string }[];
}

interface ClaudeConversation {
  uuid?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

interface ClaudeProject {
  uuid?: string;
  name?: string;
  description?: string;
  prompt_template?: string;
  created_at?: string;
  updated_at?: string;
  docs?: { uuid?: string; filename?: string; content?: string; created_at?: string }[];
}

function messageText(m: ClaudeMessage): string {
  let text = "";
  if (Array.isArray(m.content) && m.content.length > 0) {
    text = m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => (b.text as string).trim())
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text && typeof m.text === "string") text = m.text.trim();
  const names = [...(m.attachments ?? []), ...(m.files ?? [])]
    .map((a) => a?.file_name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.length > 0) text += `${text ? "\n\n" : ""}[Attached: ${names.join(", ")}]`;
  return text;
}

export function parseClaudeConversations(list: unknown[]): { drafts: MemoryDraft[]; skipped: number } {
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const conv = raw as ClaudeConversation;
    const lines: string[] = [];
    for (const m of conv.chat_messages ?? []) {
      if (m?.sender !== "human" && m?.sender !== "assistant") continue;
      const text = messageText(m);
      if (!text) continue;
      lines.push(`### ${m.sender === "human" ? "You" : "Claude"}\n\n${text}`);
    }
    if (lines.length === 0) {
      skipped++;
      continue;
    }
    const created = toIso(conv.created_at);
    drafts.push({
      title: conv.name?.trim() || "Untitled conversation",
      body: lines.join("\n\n"),
      tags: ["claude"],
      source: { kind: "claude", ref: conv.uuid },
      createdAt: created,
      editedAt: toIso(conv.updated_at) ?? created,
    });
  }
  return { drafts, skipped };
}

export function parseClaudeProjects(data: unknown): { drafts: MemoryDraft[]; skipped: number } {
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  if (!Array.isArray(data)) return { drafts, skipped };
  for (const raw of data) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const p = raw as ClaudeProject;
    const name = p.name?.trim() || "Untitled project";
    const parts: string[] = [];
    if (p.description?.trim()) parts.push(`### Description\n\n${p.description.trim()}`);
    if (p.prompt_template?.trim()) parts.push(`### Instructions\n\n${p.prompt_template.trim()}`);
    const docs = (p.docs ?? []).filter((d) => d && typeof d.content === "string" && d.content.trim());
    if (docs.length > 0) parts.push(`### Documents\n\n${docs.map((d) => `- ${d.filename || "Untitled document"}`).join("\n")}`);
    const tag = `project-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "untitled"}`;
    const created = toIso(p.created_at);
    if (parts.length > 0) {
      drafts.push({
        title: `Project: ${name}`,
        body: parts.join("\n\n"),
        tags: ["claude", "project", tag],
        source: { kind: "claude", ref: p.uuid },
        createdAt: created,
        editedAt: toIso(p.updated_at) ?? created,
      });
    } else if (docs.length === 0) {
      skipped++;
    }
    for (const d of docs) {
      const docCreated = toIso(d.created_at) ?? created;
      drafts.push({
        title: `${name}: ${d.filename || "Untitled document"}`,
        body: (d.content as string).trim(),
        tags: ["claude", "document", tag],
        source: { kind: "claude", ref: d.uuid },
        createdAt: docCreated,
        editedAt: docCreated,
      });
    }
  }
  return { drafts, skipped };
}

/** Claude's memory export. The shape is read defensively: any string memory found becomes one memory. */
export function parseClaudeMemories(data: unknown): MemoryDraft[] {
  const drafts: MemoryDraft[] = [];
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.conversations_memory === "string" && record.conversations_memory.trim()) {
      drafts.push({
        title: "What Claude remembered",
        body: record.conversations_memory.trim(),
        tags: ["claude", "memory"],
        source: { kind: "claude", ref: "memory" },
      });
    }
    const projects = record.project_memories;
    if (projects && typeof projects === "object") {
      for (const [ref, value] of Object.entries(projects as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) {
          drafts.push({
            title: "What Claude remembered in a project",
            body: value.trim(),
            tags: ["claude", "memory", "project"],
            source: { kind: "claude", ref },
          });
        }
      }
    }
  }
  return drafts;
}
