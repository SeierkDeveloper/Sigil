// Messages between the extension's parts (the page script, the popup and the
// background worker). Anything arriving here is checked before it is used:
// a page script runs next to pages the extension does not control.

import type { Conversation, Speaker } from "./capture";

export type Message =
  | { type: "sigil:capture-conversation"; conversation: Conversation }
  | { type: "sigil:save-selection"; tabId: number }
  | { type: "sigil:save-page"; tabId: number }
  | { type: "sigil:status" };

export type Reply = { ok: true; sent: number; message: string } | { ok: false; error: string };

const MAX_TURNS = 2000;
const MAX_TEXT = 200_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTabId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function conversation(v: unknown): Conversation | null {
  if (!isObject(v)) return null;
  if (v.site !== "chatgpt" && v.site !== "claude") return null;
  if (typeof v.title !== "string" || typeof v.url !== "string" || !Array.isArray(v.turns)) return null;
  if (v.turns.length === 0 || v.turns.length > MAX_TURNS) return null;
  let url: URL;
  try {
    url = new URL(v.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const turns = [];
  for (const t of v.turns) {
    if (!isObject(t) || (t.speaker !== "user" && t.speaker !== "assistant") || typeof t.text !== "string") return null;
    if (t.text.length > MAX_TEXT) return null;
    turns.push({ speaker: t.speaker as Speaker, text: t.text });
  }
  return { site: v.site, title: v.title.slice(0, 300), url: url.toString(), turns };
}

export function parseMessage(raw: unknown): Message | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "sigil:capture-conversation": {
      const c = conversation(raw.conversation);
      return c ? { type: raw.type, conversation: c } : null;
    }
    case "sigil:save-selection":
    case "sigil:save-page":
      return isTabId(raw.tabId) ? { type: raw.type, tabId: raw.tabId } : null;
    case "sigil:status":
      return { type: raw.type };
    default:
      return null;
  }
}
