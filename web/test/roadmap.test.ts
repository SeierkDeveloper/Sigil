// The roadmap and the changelog say what is built, and stage 03, A self that
// acts, is done: every part of it live, nothing left as still to build, and
// no wording from before the registry was on chain.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { releases } from "../src/lib/changelog";
import { stages } from "../src/lib/roadmap";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("the roadmap", () => {
  const acts = stages.find((s) => s.title === "A self that acts")!;

  it("shows stage 03, A self that acts, as done in full", () => {
    expect(stages.indexOf(acts)).toBe(2);
    expect(acts.horizon).toBe("built");
    expect(acts.items).toEqual([]);
    expect(acts.done).toBe("27 Nov");
    expect(acts.built).toHaveLength(6);
    const all = acts.built!.join("\n");
    expect(all).toContain("Runs your inbox and calendar end to end");
    expect(all).toContain("Negotiates times, prices and terms within ranges you set, and stops to ask at the edge of them");
    expect(all).toContain("through the connector");
  });

  it("says the registry is live on chain, not that it waits to be deployed", () => {
    const text = JSON.stringify(stages);
    expect(text).not.toMatch(/once this site's registry is deployed/i);
    expect(acts.built!.join("\n")).toContain("the registry of selves live on chain");
  });

  it("marks done only stages with nothing left to build, and leaves the rest as they were", () => {
    for (const s of stages) if (s.done) expect(s.items).toEqual([]);
    expect(stages).toHaveLength(10);
    expect(stages[0]).toMatchObject({ title: "Ask your whole life", horizon: "now" });
    expect(stages.slice(3).every((s) => s.horizon === "later" || s.horizon === "vision")).toBe(true);
  });

  it("shows the done mark as an engraved SVG, not a symbol", () => {
    const page = readFileSync(path.join(ROOT, "web/src/app/roadmap/page.tsx"), "utf8");
    expect(page).toContain("Done, every part live since");
    expect(page).toContain("<svg");
  });
});

describe("the changelog", () => {
  it("leads with this release, in the site's words and without a fee split", () => {
    const fix = releases[0];
    expect(fix).toMatchObject({ date: "2026-11-28", area: "Trust", title: "Every finding of the Oak Sapling Review fixed" });
    const fixText = [fix.title, fix.summary, ...fix.items].join("\n");
    expect(fixText).toContain("0x02Ad8D5D05c15460e9c4B663280a2B4e386Fa3EE");
    expect(fixText).not.toMatch(/\baudit(ed)?\b|\bsafe\b|%/i);
    expect(fixText).not.toMatch(/[\u2013\u2014]/);
    const r = releases[1];
    expect(r).toMatchObject({ date: "2026-11-27", area: "AI self", title: "A self that acts: your inbox, your calendar and your negotiations" });
    const text = [r.title, r.summary, ...r.items].join("\n");
    expect(text).toContain("Stage 03 of the roadmap is done");
    expect(text).toContain("check_action");
    expect(text).toContain("SIGIL_GOOGLE_CLIENT_ID");
    expect(text).not.toMatch(/\baudit(ed)?\b|\bsafe\b|%/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("is newest first", () => {
    const dates = releases.map((x) => x.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
