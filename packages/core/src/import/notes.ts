// Note apps: an Obsidian vault (a folder of Markdown files), Apple Notes (the
// notes as text, Markdown or HTML files, as the iCloud data copy and export
// tools give them) and a Notion export (a zip of Markdown pages).

import type { MemoryDraft } from "../vault";
import { clampBody, toIso } from "./util";
import {
  baseName,
  cleanTagWord,
  expandFiles,
  extension,
  htmlToText,
  LocalImportError,
  LOCAL_LABELS,
  textOf,
  withoutExtension,
  type ImportFile,
  type LocalImport,
} from "./files";

// ---------------------------------------------------------------- Obsidian

interface Frontmatter {
  tags: string[];
  created?: string;
  body: string;
}

/** Reads the YAML block at the top of a note: its tags and its date. Anything else in it is left out of the text. */
export function splitFrontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { tags: [], body: text };
  const tags: string[] = [];
  let created: string | undefined;
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === "tags" || key === "tag") {
      if (value) {
        tags.push(...value.replace(/^\[|\]$/g, "").split(/[,\s]+/).map((t) => t.replace(/^["']|["']$/g, "")));
      } else {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) tags.push(lines[++i].replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, ""));
      }
    } else if ((key === "created" || key === "date") && value) {
      created = toIso(value.replace(/^["']|["']$/g, ""));
    }
  }
  return { tags: tags.map(cleanTagWord).filter(Boolean), created, body: text.slice(m[0].length) };
}

/** #tags written in the text. Headings (# Title) and numbers (#1) are not tags. */
export function inlineTags(text: string): string[] {
  const out = new Set<string>();
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const m of withoutCode.matchAll(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) out.add(cleanTagWord(m[2]));
  return [...out].filter(Boolean);
}

/** One Obsidian note. The path, relative to the vault folder, is how a later change finds the same memory. */
export function parseObsidianNote(path: string, text: string, modified?: string): MemoryDraft | null {
  const fm = splitFrontmatter(text.replace(/\r\n?/g, "\n"));
  const body = fm.body.trim();
  if (!body) return null;
  const edited = toIso(modified);
  return {
    title: withoutExtension(baseName(path)).slice(0, 300) || "Untitled note",
    body: clampBody(body),
    tags: ["obsidian", ...new Set([...fm.tags, ...inlineTags(body)])].slice(0, 32),
    source: { kind: "obsidian", ref: path },
    createdAt: fm.created ?? edited,
    editedAt: edited ?? fm.created,
  };
}

export function isObsidianNotePath(path: string): boolean {
  return extension(path) === "md" && !path.split("/").some((p) => p.startsWith(".") || p === "node_modules");
}

export function parseObsidianVault(files: ImportFile[]): LocalImport {
  const all = expandFiles(files);
  const notes = all.filter((f) => isObsidianNotePath(f.path));
  if (notes.length === 0) throw new LocalImportError("No Markdown notes were found. Choose the folder of your Obsidian vault.");
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  for (const f of notes) {
    const d = parseObsidianNote(f.path, textOf(f.bytes), f.modified);
    if (d) drafts.push(d);
    else skipped++;
  }
  return { kind: "obsidian", label: LOCAL_LABELS.obsidian, drafts, skipped, notes: [] };
}

// ---------------------------------------------------------------- Apple Notes

const NOTE_TYPES = new Set(["txt", "md", "markdown", "html", "htm"]);

export function parseAppleNotes(files: ImportFile[]): LocalImport {
  const all = expandFiles(files).filter((f) => NOTE_TYPES.has(extension(f.path)));
  if (all.length === 0) {
    throw new LocalImportError("No notes were found. Choose the Notes folder from your iCloud data copy, or notes exported as text, Markdown or HTML files.");
  }
  const drafts: MemoryDraft[] = [];
  let skipped = 0;
  for (const f of all) {
    const raw = textOf(f.bytes);
    const isHtml = /^html?$/.test(extension(f.path));
    let body = (isHtml ? htmlToText(raw) : raw).trim();
    const htmlTitle = isHtml ? /<title>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() : undefined;
    let title = htmlTitle || withoutExtension(baseName(f.path)).trim();
    const firstLine = body.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "";
    // A note's first line is its title in Notes; keep it once.
    if (firstLine && (firstLine === title || !title || /^(note|untitled)( \d+)?$/i.test(title))) {
      title = firstLine;
      body = body.split("\n").slice(1).join("\n").trim() || firstLine;
    }
    if (!body) {
      skipped++;
      continue;
    }
    const edited = toIso(f.modified);
    drafts.push({
      title: title.slice(0, 300) || "Untitled note",
      body: clampBody(body),
      tags: ["apple-notes"],
      source: { kind: "apple-notes", ref: f.path },
      createdAt: edited,
      editedAt: edited,
    });
  }
  return { kind: "apple-notes", label: LOCAL_LABELS["apple-notes"], drafts, skipped, notes: [] };
}

// ---------------------------------------------------------------- Notion

const NOTION_ID = /\s+([0-9a-f]{32})$/i;

/** "Trip plans 0f1e2d3c4b5a69788796a5b4c3d2e1f0" -> title and the page id Notion gives every page. */
export function notionName(name: string): { title: string; id: string | null } {
  const plain = withoutExtension(name);
  const m = NOTION_ID.exec(plain);
  return m ? { title: plain.slice(0, m.index).trim(), id: m[1].toLowerCase() } : { title: plain.trim(), id: null };
}

export function parseNotionExport(files: ImportFile[]): LocalImport {
  const all = expandFiles(files);
  const pages = all.filter((f) => extension(f.path) === "md");
  if (pages.length === 0) throw new LocalImportError("No Notion pages were found. Export your workspace from Notion as Markdown and CSV, then choose the zip.");
  const drafts: MemoryDraft[] = [];
  let skipped = all.filter((f) => extension(f.path) === "csv").length;
  for (const f of pages) {
    const { title, id } = notionName(baseName(f.path));
    let body = textOf(f.bytes).trim();
    const heading = /^#\s+(.+)\n?/.exec(body);
    if (heading && heading[1].trim() === title) body = body.slice(heading[0].length).trim();
    const tags = ["notion"];
    const tagLine = /^Tags:\s*(.+)$/m.exec(body.split("\n").slice(0, 12).join("\n"));
    if (tagLine) tags.push(...tagLine[1].split(",").map(cleanTagWord).filter(Boolean));
    const parents = f.path
      .split("/")
      .slice(0, -1)
      .map((p) => notionName(p).title)
      .filter((p) => p && !/^export-/i.test(p) && !/^part-\d+$/i.test(p));
    if (!body) {
      skipped++;
      continue;
    }
    const edited = toIso(f.modified);
    drafts.push({
      title: (title || "Untitled page").slice(0, 300),
      body: clampBody(parents.length ? `In ${parents.join(" / ")}\n\n${body}` : body),
      tags: [...new Set(tags)].slice(0, 32),
      source: { kind: "notion", ref: id ?? f.path },
      createdAt: edited,
      editedAt: edited,
    });
  }
  const notes = skipped ? ["Databases (CSV files) and empty pages were left out."] : [];
  return { kind: "notion", label: LOCAL_LABELS.notion, drafts, skipped, notes };
}
