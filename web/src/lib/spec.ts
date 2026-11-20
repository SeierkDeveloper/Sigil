// The open standard's files, read from docs/spec at build time.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SPEC_DIR = path.resolve(process.cwd(), "..", "docs", "spec");

export interface SpecPart {
  file: string;
  /** The id the part gets on the /spec page. */
  id: string;
  source: string;
}

export function specParts(): SpecPart[] {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)))
    .map((file) => ({ file, id: file === "README.md" ? "overview" : file.replace(/^\d+-/, "").replace(/\.md$/, ""), source: readFileSync(path.join(SPEC_DIR, file), "utf8") }));
}

export function specVectors(): string {
  return readFileSync(path.join(SPEC_DIR, "vectors.json"), "utf8");
}
