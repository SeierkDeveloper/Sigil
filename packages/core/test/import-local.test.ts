import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import {
  commitDrafts,
  decodeHeader,
  dedupeDrafts,
  eventDrafts,
  icsDrafts,
  importGithub,
  inlineTags,
  LocalImportError,
  MAIL_THREAD_CHARS,
  mboxDrafts,
  notionName,
  parseAppleNotes,
  parseNotionExport,
  parseObsidianNote,
  parseObsidianVault,
  parseRepo,
  parseTakeout,
  splitFrontmatter,
} from "../src";
import { appleNotesZip, GITHUB_COMMITS, GITHUB_EVENTS, ICS, MBOX, notionZip, obsidianFiles, takeoutZip } from "./fixtures/local";

describe("Obsidian", () => {
  it("reads notes with their front matter tags, inline tags and paths, and skips settings and empty notes", () => {
    const r = parseObsidianVault(obsidianFiles());
    expect(r.kind).toBe("obsidian");
    expect(r.label).toBe("Obsidian");
    expect(r.drafts.map((d) => d.title)).toEqual(["2026-03-01", "Boat"]);
    expect(r.skipped).toBe(1);
    const [day, boat] = r.drafts;
    expect(day.tags).toEqual(["obsidian", "journal", "garden", "outdoors"]);
    expect(day.body).toBe("# Sunday\n\nPlanted the tomatoes by the south wall. #outdoors");
    expect(day.source).toEqual({ kind: "obsidian", ref: "Daily/2026-03-01.md" });
    expect(day.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(day.editedAt).toBe("2026-03-02T10:00:00.000Z");
    expect(boat.tags).toEqual(["obsidian", "boat", "project"]);
    expect(boat.tags).not.toContain("not-a-tag");
    expect(boat.body).toContain("[[Sailing]]");
  });

  it("parses front matter in its list and inline forms, and leaves headings and numbers out of tags", () => {
    expect(splitFrontmatter("---\ntag: one two\ndate: 2025-12-24\n---\nText").tags).toEqual(["one", "two"]);
    expect(splitFrontmatter("No front matter").body).toBe("No front matter");
    expect(inlineTags("# Heading\nA #real tag, an issue #12 and `#code`.")).toEqual(["real"]);
    expect(parseObsidianNote("a.md", "   ")).toBeNull();
  });

  it("explains an empty pick", () => {
    expect(() => parseObsidianVault([{ path: "x.png", bytes: strToU8("x") }])).toThrow(LocalImportError);
  });
});

describe("Apple Notes", () => {
  it("reads text and HTML notes from the iCloud zip, takes the first line as the title, and skips blanks and the details file", () => {
    const r = parseAppleNotes([{ path: "notes.zip", bytes: appleNotesZip() }]);
    const byTitle = Object.fromEntries(r.drafts.map((d) => [d.title, d]));
    expect(Object.keys(byTitle).sort()).toEqual(["Pancakes", "Shopping list", "Wifi at the cabin"]);
    expect(byTitle["Shopping list"].body).toBe("Oat milk\nBread");
    expect(byTitle["Wifi at the cabin"].body).toBe("The password is on the fridge.");
    expect(byTitle.Pancakes.body).toBe("Two eggs & flour\n\n- Whisk\n- Fry");
    expect(byTitle.Pancakes.source?.kind).toBe("apple-notes");
    expect(r.skipped).toBe(1);
  });
});

describe("Google Takeout", () => {
  it("makes one memory per mail thread with headers and text, decoding base64, quoted-printable and encoded subjects", () => {
    const r = mboxDrafts(MBOX);
    expect(r.skipped).toBe(1);
    expect(r.drafts.map((d) => d.title)).toEqual(["Your books are due", "Trip to the coast"]);
    const trip = r.drafts[1];
    expect(trip.source).toEqual({ kind: "gmail", ref: "1790000000000000001" });
    expect(trip.body).toContain("### Robin Ash <robin@example.org>\nTo: me@example.org\nDate: 2026-01-12 09:00");
    expect(trip.body).toContain("The ferry is at 8:15.");
    expect(trip.body).toContain("From the harbour we walk.");
    expect(trip.body).toContain("Yes, Friday works. I'll bring the tent.");
    expect(trip.body).not.toContain("wrote:");
    expect(trip.createdAt).toBe("2026-01-12T09:00:00.000Z");
    expect(trip.editedAt).toBe("2026-01-12T18:00:00.000Z");
    expect(r.drafts[0].body).toContain("Return two books by Friday.");
    expect(r.drafts.some((d) => d.body.includes("Click here"))).toBe(false);
  });

  it("keeps long threads within the size limit", () => {
    const long = MBOX.replace("Shall we leave on Friday?", "x ".repeat(30_000));
    const many = Array.from({ length: 8 }, () => long.split("\nFrom 1790000000000000002")[0]).join("\n\n");
    const r = mboxDrafts(many);
    expect(r.drafts[0].body.length).toBeLessThan(MAIL_THREAD_CHARS + 500);
    expect(r.drafts[0].body).toContain("[Shortened]");
    expect(r.notes.join(" ")).toContain("shortened");
  });

  it("decodes header words", () => {
    expect(decodeHeader("=?ISO-8859-1?Q?Caf=E9_au_lait?=")).toBe("Café au lait");
    expect(decodeHeader("=?UTF-8?B?SGVq?= =?UTF-8?B?IGTDpHI=?=")).toBe("Hej där");
  });

  it("makes one memory per calendar event, unfolding lines and ignoring alarms", () => {
    const r = icsDrafts(ICS);
    expect(r.skipped).toBe(1);
    expect(r.drafts.map((d) => d.title)).toEqual(["Dentist", "Birthday of Kim"]);
    const [dentist, birthday] = r.drafts;
    expect(dentist.body).toBe(
      "When: 2026-02-20 09:30 Europe/Paris to 2026-02-20 10:30 Europe/Paris\nWhere: Main street 4, second floor\n\nBring the insurance card.\nAsk about the crown.",
    );
    expect(dentist.source).toEqual({ kind: "calendar", ref: "evt-1@calendar" });
    expect(dentist.createdAt).toBe("2026-02-20T09:30:00.000Z");
    expect(birthday.body).toBe("When: 2026-03-01 to 2026-03-02 (all day)\nRepeats: yearly");
  });

  it("reads mail and calendar from the Takeout zip", () => {
    const r = parseTakeout([{ path: "takeout.zip", bytes: takeoutZip() }]);
    expect(r.kind).toBe("takeout");
    expect(r.drafts.map((d) => d.source?.kind).sort()).toEqual(["calendar", "calendar", "gmail", "gmail"]);
    expect(() => parseTakeout([{ path: "a.txt", bytes: strToU8("x") }])).toThrow(/No mail/);
  });
});

describe("Notion", () => {
  it("opens the zip inside the zip, strips page ids from titles, reads tags and leaves databases out", () => {
    const r = parseNotionExport([{ path: "Export.zip", bytes: notionZip() }]);
    const titles = r.drafts.map((d) => d.title).sort();
    expect(titles).toEqual(["Reading list", "Workspace"]);
    const reading = r.drafts.find((d) => d.title === "Reading list")!;
    expect(reading.body).toBe("In Workspace\n\nTags: books, Winter\n\nFinish the lighthouse novel.");
    expect(reading.tags).toEqual(["notion", "books", "winter"]);
    expect(reading.source).toEqual({ kind: "notion", ref: "0f1e2d3c4b5a69788796a5b4c3d2e1f0" });
    expect(r.skipped).toBe(2);
    expect(notionName("Plain.md")).toEqual({ title: "Plain", id: null });
  });
});

describe("GitHub", () => {
  it("groups commits by day", () => {
    const drafts = commitDrafts("sam/boat", GITHUB_COMMITS);
    expect(drafts.map((d) => d.title)).toEqual(["sam/boat: 2 commits on 2026-02-10", "sam/boat: 1 commit on 2026-02-08"]);
    expect(drafts[0].body).toBe("- Add the sail plan (a1b2c3d, Sam)\n  With the new jib.\n- Fix the rudder drawing (b2c3d4e, Sam)");
    expect(drafts[0].source).toEqual({ kind: "github", ref: "sam/boat@2026-02-10" });
    expect(drafts[0].tags).toEqual(["github", "commits", "boat"]);
  });

  it("describes activity by day and skips kinds it does not know", () => {
    const r = eventDrafts("sam", GITHUB_EVENTS);
    expect(r.skipped).toBe(1);
    expect(r.drafts[0].body).toBe("- Pushed 2 commits to sam/boat\n  - Paint\n  - Sand\n- Opened pull request #4 in sam/boat: New mast");
    expect(r.drafts[1].body).toBe("- Starred kim/lighthouse");
  });

  it("asks GitHub from the device with the token only in the request, and pages through commits", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ sha: `${i}`.padStart(7, "0"), commit: { message: `c${i}`, author: { date: "2026-01-01T00:00:00Z" } } }));
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(url.endsWith("&page=1") ? page(100) : page(3)), { status: 200 });
    };
    const r = await importGithub({ mode: "repo", target: "https://github.com/sam/boat.git", token: "ghp_secret", fetcher });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/sam/boat/commits?per_page=100&page=1",
      "https://api.github.com/repos/sam/boat/commits?per_page=100&page=2",
    ]);
    expect(calls.every((c) => c.auth === "Bearer ghp_secret")).toBe(true);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].title).toBe("sam/boat: 103 commits on 2026-01-01");
    expect(JSON.stringify(r)).not.toContain("ghp_secret");
  });

  it("explains GitHub's answers", async () => {
    const answer = (status: number) => async () => new Response("{}", { status });
    await expect(importGithub({ mode: "repo", target: "sam/none", fetcher: answer(404) })).rejects.toThrow(/no such repository/);
    await expect(importGithub({ mode: "user", target: "sam", fetcher: answer(403) })).rejects.toThrow(/limit/);
    await expect(importGithub({ mode: "repo", target: "not a repo" })).rejects.toThrow(/owner\/name/);
    expect(parseRepo("sam/boat")).toBe("sam/boat");
    expect(parseRepo("github.com/sam/boat/tree/main")).toBe("sam/boat");
  });
});

describe("dedupe against the vault", () => {
  it("leaves out the same source and the same text, and repeats inside the import", () => {
    const drafts = parseObsidianVault(obsidianFiles()).drafts;
    const existing = [{ title: "Old", body: "x", source: { kind: "obsidian" as const, ref: "Daily/2026-03-01.md" } }];
    const r = dedupeDrafts([...drafts, { ...drafts[1], source: { kind: "obsidian", ref: "Copy/Boat.md" } }], existing);
    expect(r.fresh.map((d) => d.title)).toEqual(["Boat"]);
    expect(r.duplicates).toBe(2);
    const byText = dedupeDrafts([{ title: "Boat", body: drafts[1].body }], [{ title: "boat", body: drafts[1].body, source: { kind: "note" } }]);
    expect(byText.fresh).toHaveLength(0);
  });
});
