// Small local exports in the shapes the apps produce: an Obsidian vault, Apple
// Notes files, a Google Takeout zip (Gmail mbox and Calendar ics), a Notion
// Markdown export (a zip inside a zip) and GitHub API answers. Used by the
// parser tests and by the end-to-end import test.

import { strToU8, zipSync } from "fflate";
import type { ImportFile } from "../../src";

const file = (path: string, text: string, modified = "2026-03-02T10:00:00.000Z"): ImportFile => ({ path, bytes: strToU8(text), modified });

export function obsidianFiles(marker = ""): ImportFile[] {
  return [
    file(
      "Daily/2026-03-01.md",
      `---\ntags: [journal, garden]\ncreated: 2026-03-01\n---\n# Sunday\n\nPlanted the tomatoes by the south wall. #outdoors ${marker}\n`,
    ),
    file("Projects/Boat.md", "---\ntags:\n  - boat\n  - project\n---\nVarnish the hull in April. See [[Sailing]].\n\n```\n#not-a-tag\n```\n"),
    file("Empty.md", "---\ntags: [x]\n---\n\n"),
    file(".obsidian/workspace.json", "{}"),
    file(".obsidian/plugins/x.md", "should be ignored"),
    file("Attachments/photo.png", "png"),
  ];
}

export function appleNotesZip(): Uint8Array {
  return zipSync({
    "iCloud Notes/Notes/Shopping list/Shopping list.txt": strToU8("Shopping list\nOat milk\nBread\n"),
    "iCloud Notes/Notes/Note/Note.txt": strToU8("Wifi at the cabin\nThe password is on the fridge.\n"),
    "Exported/Recipe.html": strToU8("<html><head><title>Pancakes</title></head><body><div>Pancakes</div><div>Two eggs &amp; flour</div><ul><li>Whisk</li><li>Fry</li></ul></body></html>"),
    "iCloud Notes/Notes Details.csv": strToU8("Title,Created\n"),
    "Blank.txt": strToU8("   \n"),
  });
}

export const MBOX = [
  "From 1790000000000000001@xxx Mon Jan 12 09:00:00 +0000 2026",
  "X-GM-THRID: 1790000000000000001",
  "X-Gmail-Labels: Inbox,Important",
  "Message-ID: <a1@mail.example>",
  "Date: Mon, 12 Jan 2026 09:00:00 +0000",
  "From: Robin Ash <robin@example.org>",
  "To: me@example.org",
  "Subject: =?UTF-8?B?VHJpcCB0byB0aGUgY29hc3Q=?=",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Shall we leave on Friday? The ferry is at 8=",
  ":15.",
  ">From the harbour we walk.",
  "",
  "From 1790000000000000002@xxx Mon Jan 12 18:00:00 +0000 2026",
  "X-GM-THRID: 1790000000000000001",
  "X-Gmail-Labels: Inbox",
  "Message-ID: <a2@mail.example>",
  "In-Reply-To: <a1@mail.example>",
  "Date: Mon, 12 Jan 2026 18:00:00 +0000",
  "From: me@example.org",
  "To: Robin Ash <robin@example.org>",
  "Subject: Re: Trip to the coast",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  "WWVzLCBGcmlkYXkgd29ya3MuIEknbGwgYnJpbmcgdGhlIHRlbnQu",
  "",
  "On Mon, Robin wrote:",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Yes, Friday works.</p>",
  "--b1--",
  "",
  "From 1790000000000000003@xxx Tue Jan 13 08:00:00 +0000 2026",
  "X-GM-THRID: 1790000000000000003",
  "X-Gmail-Labels: Spam",
  "Message-ID: <s1@spam.example>",
  "Date: Tue, 13 Jan 2026 08:00:00 +0000",
  "From: prize@spam.example",
  "Subject: You won",
  "",
  "Click here.",
  "",
  "From 1790000000000000004@xxx Wed Jan 14 08:00:00 +0000 2026",
  "X-GM-THRID: 1790000000000000004",
  "Message-ID: <h1@mail.example>",
  "Date: Wed, 14 Jan 2026 08:00:00 +0000",
  "From: Library <desk@library.example>",
  "Subject: Your books are due",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Return <b>two books</b> by Friday.</p>",
  "",
].join("\n");

export const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:evt-1@calendar",
  "DTSTART;TZID=Europe/Paris:20260220T093000",
  "DTEND;TZID=Europe/Paris:20260220T103000",
  "SUMMARY:Dentist",
  "LOCATION:Main street 4\\, second floor",
  "DESCRIPTION:Bring the insurance card.\\nAsk about the ",
  " crown.",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-2@calendar",
  "DTSTART;VALUE=DATE:20260301",
  "DTEND;VALUE=DATE:20260302",
  "SUMMARY:Birthday of Kim",
  "RRULE:FREQ=YEARLY",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-3@calendar",
  "DTSTART:20260105T080000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

export function takeoutZip(marker = ""): Uint8Array {
  return zipSync({
    "Takeout/Mail/All mail Including Spam and Trash.mbox": strToU8(MBOX.replace("Shall we leave", `${marker} Shall we leave`.trim())),
    "Takeout/Calendar/Personal.ics": strToU8(ICS),
    "Takeout/archive_browser.html": strToU8("<html></html>"),
  });
}

export function notionZip(): Uint8Array {
  const inner = zipSync({
    "Workspace 1a2b3c4d5e6f70819293a4b5c6d7e8f9/Reading list 0f1e2d3c4b5a69788796a5b4c3d2e1f0.md": strToU8(
      "# Reading list\n\nTags: books, Winter\n\nFinish the lighthouse novel.\n",
    ),
    "Workspace 1a2b3c4d5e6f70819293a4b5c6d7e8f9.md": strToU8("# Workspace\n\nHome page of the workspace.\n"),
    "Workspace 1a2b3c4d5e6f70819293a4b5c6d7e8f9/Tasks 11111111111111111111111111111111.csv": strToU8("Name,Done\n"),
    "Workspace 1a2b3c4d5e6f70819293a4b5c6d7e8f9/Blank 22222222222222222222222222222222.md": strToU8("# Blank\n"),
  });
  return zipSync({ "Export-5b2c/Part-1.zip": inner });
}

export const GITHUB_COMMITS = [
  { sha: "a1b2c3d4e5f6", commit: { message: "Add the sail plan\n\nWith the new jib.", author: { name: "Sam", date: "2026-02-10T09:00:00Z" } } },
  { sha: "b2c3d4e5f6a7", commit: { message: "Fix the rudder drawing", author: { name: "Sam", date: "2026-02-10T15:30:00Z" } } },
  { sha: "c3d4e5f6a7b8", commit: { message: "Start the boat repo", author: { name: "Sam", date: "2026-02-08T12:00:00Z" } } },
];

export const GITHUB_EVENTS = [
  { type: "PushEvent", created_at: "2026-02-11T10:00:00Z", repo: { name: "sam/boat" }, payload: { size: 2, commits: [{ message: "Paint\nlong" }, { message: "Sand" }] } },
  { type: "PullRequestEvent", created_at: "2026-02-11T12:00:00Z", repo: { name: "sam/boat" }, payload: { action: "opened", number: 4, pull_request: { title: "New mast" } } },
  { type: "WatchEvent", created_at: "2026-02-09T08:00:00Z", repo: { name: "kim/lighthouse" }, payload: {} },
  { type: "GollumEvent", created_at: "2026-02-09T09:00:00Z", repo: { name: "kim/lighthouse" }, payload: {} },
];
