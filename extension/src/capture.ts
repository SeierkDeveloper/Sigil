// Turns what is on screen into memory suggestions: a selection, a page, or a
// whole ChatGPT or Claude conversation read from the page itself. Pure
// functions over the DOM, so they are tested against fixed markup.

import type { ProposalDraft } from "@sigil/core";

export type Site = "chatgpt" | "claude";
export type Speaker = "user" | "assistant";

export interface Turn {
  speaker: Speaker;
  text: string;
}

export interface Conversation {
  site: Site;
  title: string;
  url: string;
  turns: Turn[];
}

export interface PageCapture {
  title: string;
  url: string;
  text: string;
  description?: string;
}

/** Bodies are cut into parts below the inbox's limit for one suggestion. */
export const PART_CHARS = 90_000;
export const PAGE_TEXT_LIMIT = 20_000;

const SITE_NAME: Record<Site, string> = { chatgpt: "ChatGPT", claude: "Claude" };

export function siteOf(url: string): Site | null {
  try {
    const host = new URL(url).hostname;
    if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
    if (host === "claude.ai") return "claude";
  } catch {
    return null;
  }
  return null;
}

function clean(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOf(el: Element): string {
  const h = el as HTMLElement;
  return clean((typeof h.innerText === "string" && h.innerText) || el.textContent || "");
}

/** Drops matches that sit inside another match, so nested wrappers are not read twice. */
function outermost(els: Element[]): Element[] {
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}

function stripSuffix(title: string, suffixes: string[]): string {
  let t = title.trim();
  for (const s of suffixes) if (t.endsWith(s)) t = t.slice(0, -s.length).trim();
  return t;
}

/** ChatGPT marks each message with data-message-author-role. */
export function parseChatGpt(doc: Document, url: string): Conversation {
  const turns: Turn[] = [];
  for (const el of outermost([...doc.querySelectorAll("[data-message-author-role]")])) {
    const role = el.getAttribute("data-message-author-role");
    if (role !== "user" && role !== "assistant") continue;
    const body = el.querySelector(".markdown, .whitespace-pre-wrap") ?? el;
    const text = textOf(body);
    if (text) turns.push({ speaker: role, text });
  }
  const title = stripSuffix(doc.title, ["- ChatGPT", "| ChatGPT"]);
  return { site: "chatgpt", title: title && title !== "ChatGPT" ? title : "ChatGPT conversation", url, turns };
}

/** Claude marks the user's messages with a test id and its own answers with a font class. */
export function parseClaude(doc: Document, url: string): Conversation {
  const turns: Turn[] = [];
  const found = outermost([...doc.querySelectorAll('[data-testid="user-message"], .font-claude-response, .font-claude-message')]);
  for (const el of found) {
    const speaker: Speaker = el.matches('[data-testid="user-message"]') ? "user" : "assistant";
    const text = textOf(el);
    if (text) turns.push({ speaker, text });
  }
  const title = stripSuffix(doc.title, ["- Claude", "| Claude"]);
  return { site: "claude", title: title && title !== "Claude" ? title : "Claude conversation", url, turns };
}

export function parseConversation(doc: Document, url: string): Conversation | null {
  const site = siteOf(url);
  if (site === "chatgpt") return parseChatGpt(doc, url);
  if (site === "claude") return parseClaude(doc, url);
  return null;
}

/**
 * One suggestion per conversation, in the same shape the vault's import uses
 * ("### You" and "### ChatGPT" headings). Very long conversations become
 * numbered parts.
 */
export function conversationDrafts(c: Conversation): ProposalDraft[] {
  const name = SITE_NAME[c.site];
  const blocks = c.turns.map((t) => `### ${t.speaker === "user" ? "You" : name}\n\n${t.text}`);
  const parts: string[] = [];
  let current = "";
  for (const block of blocks) {
    const piece = block.length > PART_CHARS ? block.slice(0, PART_CHARS) : block;
    if (current && current.length + piece.length + 2 > PART_CHARS) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) parts.push(current);
  return parts.map((body, i) => ({
    title: parts.length > 1 ? `${c.title} (part ${i + 1} of ${parts.length})` : c.title,
    body,
    tags: [c.site, "conversation"],
    folder: name,
    url: c.url,
  }));
}

export function selectionDraft(selection: string, page: { title: string; url: string }): ProposalDraft {
  const text = clean(selection);
  const first = text.split("\n")[0].slice(0, 80);
  return { title: page.title ? `From ${page.title}` : first || "Saved selection", body: text, tags: ["web", "selection"], url: page.url };
}

export function pageDraft(page: PageCapture): ProposalDraft {
  const lines = [page.description ? clean(page.description) : "", clean(page.text).slice(0, PAGE_TEXT_LIMIT)].filter(Boolean);
  return { title: page.title || page.url, body: lines.join("\n\n") || page.url, tags: ["web", "page"], url: page.url };
}

/** Runs inside the page (injected by the extension) to read its title and main text. */
export function extractPage(): PageCapture {
  const main = document.querySelector("article, main, [role='main']") ?? document.body;
  const description = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
  return { title: document.title, url: location.href, text: (main as HTMLElement).innerText ?? "", description };
}
