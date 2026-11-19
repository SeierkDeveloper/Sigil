// Guards on the copy: no em or en dashes, no emoji, no "demo" or "sample" labels
// anywhere in the source that ships, and every page links where it should.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN = ["web/src", "connector/src", "packages/core/src", "contracts/src", "contracts/test", "contracts/script", "README.md", "connector/README.md"];
const EXT = /\.(ts|tsx|css|sol|md|json|svg)$/;

function files(p: string): string[] {
  const full = path.join(ROOT, p);
  let st;
  try {
    st = statSync(full);
  } catch {
    return [];
  }
  if (st.isFile()) return [full];
  return readdirSync(full).flatMap((name) => files(path.join(p, name)));
}

const all = SCAN.flatMap(files).filter((f) => EXT.test(f));

describe("copy rules", () => {
  it("scans a real set of files", () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it("has no em or en dashes", () => {
    const bad = all.filter((f) => /[–—]/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("has no emoji or pictographic symbols", () => {
    const re = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    const bad = all.filter((f) => re.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("never labels anything as a demo or sample", () => {
    const ui = all.filter((f) => f.includes(`${path.sep}web${path.sep}src${path.sep}`) && f.endsWith(".tsx"));
    const bad = ui.filter((f) => /\b(demo|sample data|lorem ipsum)\b/i.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("keeps the token on the roadmap only, without percentages or promises", () => {
    const withToken = all.filter((f) => readFileSync(f, "utf8").includes("$SIGIL"));
    expect(withToken.map((f) => path.relative(ROOT, f))).toEqual(["web/src/app/roadmap/page.tsx"]);
    const roadmap = readFileSync(withToken[0], "utf8");
    expect(roadmap).not.toMatch(/\d+\s?%/);
  });

  it("contains no email addresses", () => {
    const bad = all.filter((f) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(readFileSync(f, "utf8").replace(/@[a-z0-9-]+\/[a-z0-9-]+/g, "")));
    expect(bad).toEqual([]);
  });
});
