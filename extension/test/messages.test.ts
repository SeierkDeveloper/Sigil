import { describe, expect, it } from "vitest";
import { allowedFrom, parseMessage } from "../src/messages";

const conversation = { site: "chatgpt", title: "T", url: "https://chatgpt.com/c/1", turns: [{ speaker: "user", text: "hi" }] };

describe("messages between the extension's parts", () => {
  it("accepts the four known requests", () => {
    expect(parseMessage({ type: "sigil:capture-conversation", conversation })).toEqual({ type: "sigil:capture-conversation", conversation });
    expect(parseMessage({ type: "sigil:save-page", tabId: 4 })).toEqual({ type: "sigil:save-page", tabId: 4 });
    expect(parseMessage({ type: "sigil:save-selection", tabId: 0 })).toEqual({ type: "sigil:save-selection", tabId: 0 });
    expect(parseMessage({ type: "sigil:status", extra: 1 })).toEqual({ type: "sigil:status" });
  });

  it("refuses anything malformed", () => {
    const bad: unknown[] = [
      null,
      "sigil:status",
      [],
      { type: "sigil:unknown" },
      { type: "sigil:save-page" },
      { type: "sigil:save-page", tabId: -1 },
      { type: "sigil:save-page", tabId: 1.5 },
      { type: "sigil:save-page", tabId: "1" },
      { type: "sigil:capture-conversation" },
      { type: "sigil:capture-conversation", conversation: { ...conversation, site: "other" } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, url: "http://chatgpt.com/" } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, url: "javascript:alert(1)" } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, turns: [] } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, turns: [{ speaker: "system", text: "x" }] } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, turns: [{ speaker: "user", text: 5 }] } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, turns: [{ speaker: "user", text: "x".repeat(200_001) }] } },
      { type: "sigil:capture-conversation", conversation: { ...conversation, turns: Array.from({ length: 2001 }, () => ({ speaker: "user", text: "x" })) } },
    ];
    for (const b of bad) expect(parseMessage(b), JSON.stringify(b)?.slice(0, 80)).toBeNull();
  });

  it("cuts an overlong title", () => {
    const m = parseMessage({ type: "sigil:capture-conversation", conversation: { ...conversation, title: "t".repeat(1000) } });
    expect(m && m.type === "sigil:capture-conversation" && m.conversation.title.length).toBe(300);
  });

  it("lets only the popup ask to read a tab, never a script inside a page", () => {
    const page = parseMessage({ type: "sigil:save-page", tabId: 7 })!;
    const selection = parseMessage({ type: "sigil:save-selection", tabId: 7 })!;
    expect(allowedFrom(page, {})).toBe(true);
    expect(allowedFrom(page, { tab: { url: "https://chatgpt.com/c/1" } })).toBe(false);
    expect(allowedFrom(selection, { tab: { url: "https://claude.ai/chat/1" } })).toBe(false);
    expect(allowedFrom(parseMessage({ type: "sigil:capture-conversation", conversation })!, { tab: { url: "https://chatgpt.com/c/1" } })).toBe(true);
  });
});
