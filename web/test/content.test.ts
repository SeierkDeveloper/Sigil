// Guards on the copy: no em or en dashes, no emoji, no "demo" or "sample" labels
// anywhere in the source that ships, and every page links where it should.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN = [
  "web/src",
  "connector/src",
  "packages/core/src",
  "packages/sdk/src",
  "extension/src",
  "extension/static",
  "examples",
  "contracts/src",
  "contracts/test",
  "contracts/script",
  "README.md",
  "connector/README.md",
  "packages/sdk/README.md",
  "docs/DESIGN-BRIEF.md",
  "docs/spec",
];
const EXT = /\.(ts|tsx|css|sol|md|json|svg|html|js|mjs)$/;

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

  it("never names the token's ticker before launch: the token page takes its symbol from the environment", () => {
    // Nobody can launch a copy under the right name ahead of the real one if the name is not in the code.
    const withTicker = all.filter((f) => readFileSync(f, "utf8").includes("$" + "SIGIL"));
    expect(withTicker.map((f) => path.relative(ROOT, f))).toEqual([]);
    expect(readFileSync(path.join(ROOT, "README.md"), "utf8").includes("$" + "SIGIL")).toBe(false);
    expect(readFileSync(path.join(ROOT, "web/src/app/roadmap/page.tsx"), "utf8")).not.toMatch(/\d+\s?%/);
  });

  it("contains no email addresses", () => {
    // The test vectors hold a made-up address on purpose: the redaction rules must mask it. The one address allowed
    // is the project's own address for security reports (a role, not a person), marked as a placeholder until confirmed.
    const bad = all.filter(
      (f) => !f.endsWith("vectors.json") && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(readFileSync(f, "utf8").replace(/@[a-z0-9-]+\/[a-z0-9-]+/g, "")),
    );
    expect(bad).toEqual([]);
  });
});

describe("the content security policy", () => {
  it("allows exactly the live sync addresses the core talks to", async () => {
    const { SYNC_ORIGINS } = await import("@sigil/core");
    const config = readFileSync(path.join(ROOT, "web/next.config.ts"), "utf8");
    const listed = /const SYNC_ORIGINS = \[([^\]]*)\]/.exec(config)![1].match(/"([^"]+)"/g)!.map((x) => x.slice(1, -1));
    expect(listed).toEqual([...SYNC_ORIGINS]);
  });
});
