// @vitest-environment happy-dom
// Reading conversations, selections and pages into suggestions, against fixed markup.

import { describe, expect, it } from "vitest";
import { conversationDrafts, PART_CHARS, pageDraft, parseChatGpt, parseClaude, parseConversation, selectionDraft, siteOf } from "../src/capture";

function doc(html: string, title: string): Document {
  const d = document.implementation.createHTMLDocument(title);
  d.title = title;
  d.body.innerHTML = html;
  return d;
}

const CHATGPT = `
  <main>
    <div data-message-author-role="user"><div class="whitespace-pre-wrap">Which vegetables grow in shade?</div></div>
    <div data-message-author-role="assistant"><div class="markdown"><p>Lettuce, spinach and kale.</p></div></div>
    <div data-message-author-role="system"><div>hidden instructions</div></div>
    <div data-message-author-role="user"><div class="whitespace-pre-wrap">And herbs?</div></div>
    <div data-message-author-role="assistant"><div class="markdown"><p>Mint and parsley.</p></div></div>
  </main>`;

const CLAUDE = `
  <div>
    <div data-testid="user-message"><p>Plan a sailing trip</p></div>
    <div class="font-claude-response"><div class="font-claude-response"><p>Start with a short coastal day.</p></div></div>
    <div data-testid="user-message"><p>For two people</p></div>
    <div class="font-claude-message"><p>Then rent a small boat.</p></div>
  </div>`;

describe("knowing the site", () => {
  it("recognises only the two chat sites", () => {
    expect(siteOf("https://chatgpt.com/c/123")).toBe("chatgpt");
    expect(siteOf("https://chat.openai.com/c/123")).toBe("chatgpt");
    expect(siteOf("https://claude.ai/chat/abc")).toBe("claude");
    expect(siteOf("https://claude.ai.example.com/")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
  });
});

describe("reading a ChatGPT conversation", () => {
  it("keeps the user and assistant turns in order and skips the rest", () => {
    const c = parseChatGpt(doc(CHATGPT, "Shade garden - ChatGPT"), "https://chatgpt.com/c/1");
    expect(c.title).toBe("Shade garden");
    expect(c.turns).toEqual([
      { speaker: "user", text: "Which vegetables grow in shade?" },
      { speaker: "assistant", text: "Lettuce, spinach and kale." },
      { speaker: "user", text: "And herbs?" },
      { speaker: "assistant", text: "Mint and parsley." },
    ]);
  });

  it("names an untitled conversation", () => {
    expect(parseChatGpt(doc(CHATGPT, "ChatGPT"), "https://chatgpt.com/").title).toBe("ChatGPT conversation");
  });
});

describe("reading a Claude conversation", () => {
  it("reads nested answers once", () => {
    const c = parseClaude(doc(CLAUDE, "Sailing - Claude"), "https://claude.ai/chat/1");
    expect(c.title).toBe("Sailing");
    expect(c.turns.map((t) => [t.speaker, t.text])).toEqual([
      ["user", "Plan a sailing trip"],
      ["assistant", "Start with a short coastal day."],
      ["user", "For two people"],
      ["assistant", "Then rent a small boat."],
    ]);
  });

  it("picks the parser from the address", () => {
    expect(parseConversation(doc(CLAUDE, "x"), "https://claude.ai/chat/1")?.site).toBe("claude");
    expect(parseConversation(doc(CLAUDE, "x"), "https://example.com/")).toBeNull();
  });
});

describe("making suggestions", () => {
  it("turns a conversation into one suggestion in the import format", () => {
    const c = parseChatGpt(doc(CHATGPT, "Shade garden - ChatGPT"), "https://chatgpt.com/c/1");
    const [d, ...rest] = conversationDrafts(c);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ title: "Shade garden", folder: "ChatGPT", tags: ["chatgpt", "conversation"], url: "https://chatgpt.com/c/1" });
    expect(d.body).toBe("### You\n\nWhich vegetables grow in shade?\n\n### ChatGPT\n\nLettuce, spinach and kale.\n\n### You\n\nAnd herbs?\n\n### ChatGPT\n\nMint and parsley.");
  });

  it("splits a very long conversation into numbered parts under the limit", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ speaker: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: "x".repeat(40_000) }));
    const drafts = conversationDrafts({ site: "claude", title: "Long", url: "https://claude.ai/chat/2", turns });
    expect(drafts.length).toBe(3);
    expect(drafts.map((d) => d.title)).toEqual(["Long (part 1 of 3)", "Long (part 2 of 3)", "Long (part 3 of 3)"]);
    expect(drafts.every((d) => d.body.length <= PART_CHARS)).toBe(true);
  });

  it("saves a selection and a page with where they came from", () => {
    expect(selectionDraft("  The key point.  ", { title: "An article", url: "https://example.org/a" })).toEqual({
      title: "From An article",
      body: "The key point.",
      tags: ["web", "selection"],
      url: "https://example.org/a",
    });
    const p = pageDraft({ title: "Recipe", url: "https://example.org/r", text: "Step one.\n\n\n\nStep two.", description: "Bread" });
    expect(p).toMatchObject({ title: "Recipe", body: "Bread\n\nStep one.\n\nStep two.", tags: ["web", "page"] });
    expect(pageDraft({ title: "", url: "https://example.org/e", text: "" })).toMatchObject({ title: "https://example.org/e", body: "https://example.org/e" });
  });
});
