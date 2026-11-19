import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { ImportError, MAX_BODY_CHARS, parseExport, utf8 } from "../src";
import { chatGptConversations, chatGptZip, claudeConversations, claudeZip } from "./fixtures/exports";

describe("ChatGPT export", () => {
  it("parses the zip, keeps the current branch and skips hidden, tool and empty messages", () => {
    const r = parseExport("export.zip", chatGptZip());
    expect(r.source).toBe("chatgpt");
    expect(r.drafts).toHaveLength(2);
    expect(r.skipped).toBe(1);

    const [garden, untitled] = r.drafts;
    expect(garden.title).toBe("Planning a garden");
    expect(garden.tags).toEqual(["chatgpt"]);
    expect(garden.source).toEqual({ kind: "chatgpt", ref: "conv-1" });
    expect(garden.createdAt).toBe("2025-01-01T12:00:00.500Z");
    expect(garden.editedAt).toBe("2025-01-01T13:00:00.250Z");
    expect(garden.body).toBe(
      [
        "### You\n\nWhich vegetables grow in shade?",
        "### ChatGPT\n\nLettuce, spinach and kale do well.",
        "### You\n\n[Attachment]\nHere is my plot.",
        "### ChatGPT\n\n```\nplant('kale')\n```",
      ].join("\n\n"),
    );
    expect(garden.body).not.toContain("abandoned branch");

    expect(untitled.title).toBe("Untitled conversation");
    expect(untitled.body).toBe("### You\n\nHello again");
  });

  it("parses a bare conversations.json", () => {
    const r = parseExport("conversations.json", utf8(JSON.stringify(chatGptConversations())));
    expect(r.source).toBe("chatgpt");
    expect(r.drafts).toHaveLength(2);
  });
});

describe("Claude export", () => {
  it("parses conversations, projects, documents and memory from the zip", () => {
    const r = parseExport("data.zip", claudeZip());
    expect(r.source).toBe("claude");
    expect(r.skipped).toBe(1);
    const titles = r.drafts.map((d) => d.title);
    expect(titles).toEqual([
      "Learning to sail",
      "Project: Novel draft",
      "Novel draft: chapter-1.md",
      "What Claude remembered",
      "What Claude remembered in a project",
    ]);
    const sail = r.drafts[0];
    expect(sail.body).toBe("### You\n\nWhat knots should I learn first?\n\n[Attached: boat.pdf]\n\n### Claude\n\nStart with the bowline.");
    expect(sail.body).not.toContain("hidden");
    expect(sail.source).toEqual({ kind: "claude", ref: "c-1" });
    expect(r.drafts[1].body).toContain("### Instructions\n\nWrite in a calm voice.");
    expect(r.drafts[1].tags).toEqual(["claude", "project", "project-novel-draft"]);
    expect(r.drafts[2].body).toBe("The lamp was lit at dusk.");
  });

  it("parses a bare Claude conversations.json", () => {
    const r = parseExport("conversations.json", utf8(JSON.stringify(claudeConversations())));
    expect(r.source).toBe("claude");
    expect(r.drafts).toHaveLength(1);
  });
});

describe("bad input", () => {
  it("explains what went wrong", () => {
    expect(() => parseExport("x.json", utf8("{nope"))).toThrow(ImportError);
    expect(() => parseExport("x.json", utf8(JSON.stringify({ hello: 1 })))).toThrow(/No ChatGPT or Claude conversations/);
    expect(() => parseExport("x.zip", zipSync({ "readme.txt": strToU8("hi") }))).toThrow(/No ChatGPT or Claude/);
    const broken = chatGptZip().slice(0, 40);
    expect(() => parseExport("x.zip", broken)).toThrow(ImportError);
  });

  it("shortens enormous conversations instead of failing", () => {
    const huge = chatGptConversations();
    (huge[0].mapping as Record<string, any>).n2.message.content.parts = ["x".repeat(MAX_BODY_CHARS + 10)];
    const r = parseExport("conversations.json", utf8(JSON.stringify(huge)));
    expect(r.drafts[0].body.length).toBeLessThan(MAX_BODY_CHARS + 200);
    expect(r.drafts[0].body).toContain("[Shortened on import");
  });

  it("ignores junk entries", () => {
    const r = parseExport("conversations.json", utf8(JSON.stringify([null, 3, ...chatGptConversations()])));
    expect(r.drafts).toHaveLength(2);
    expect(r.skipped).toBe(3);
  });
});
