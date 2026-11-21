// Files picked or dropped for a local import, and the small text helpers the
// parsers share. Everything runs on the device: a zip is opened in memory,
// read, and only the encrypted memories made from it leave the browser.

import type { MemoryDraft, SourceKind } from "../vault";
import { unzipLimited, ZipTooLarge } from "./util";

export interface ImportFile {
  /** The path inside the folder or zip, with forward slashes. */
  path: string;
  bytes: Uint8Array;
  /** When the file was last changed, if the picker knows. */
  modified?: string;
}

export type LocalImportKind = "obsidian" | "apple-notes" | "takeout" | "notion" | "github";

export interface LocalImport {
  kind: LocalImportKind;
  /** The name of the folder the memories go into by default. */
  label: string;
  drafts: MemoryDraft[];
  /** Files or items that held nothing readable, or were left out on purpose (spam, trash). */
  skipped: number;
  /** Plain sentences about anything shortened or left out. */
  notes: string[];
}

export const LOCAL_LABELS: Record<LocalImportKind, string> = {
  obsidian: "Obsidian",
  "apple-notes": "Apple Notes",
  takeout: "Google",
  notion: "Notion",
  github: "GitHub",
};

export class LocalImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalImportError";
  }
}

const decoder = new TextDecoder("utf-8");

export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function hidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

/** Opens zips (and zips inside zips, one level down) into their files. Plain files pass through. */
export function expandFiles(files: ImportFile[], depth = 0): ImportFile[] {
  const out: ImportFile[] = [];
  for (const f of files) {
    if (hidden(f.path)) continue;
    if (isZipBytes(f.bytes)) {
      if (depth > 1) continue;
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipLimited(f.bytes);
      } catch (err) {
        if (err instanceof ZipTooLarge) throw new LocalImportError(`${baseName(f.path)} opens to more than an import can hold. Import its folders one at a time.`);
        throw new LocalImportError(`${baseName(f.path)} could not be opened as a zip file.`);
      }
      const inner = Object.entries(entries)
        .filter(([p, b]) => !p.endsWith("/") && b.length > 0)
        .map(([p, bytes]) => ({ path: p, bytes, modified: f.modified }));
      out.push(...expandFiles(inner, depth + 1));
    } else {
      out.push(f);
    }
  }
  return out;
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extension(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(baseName(path));
  return m ? m[1].toLowerCase() : "";
}

export function withoutExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    const name = code.toLowerCase();
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : all;
  });
}

/** The longest HTML read as text. Anything longer is cut first, so a huge message cannot stall an import or a sync. */
export const MAX_HTML_CHARS = 4_000_000;

/** Removes <script>, <style> and <head> blocks with plain searches (linear in the length, whatever the input). */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    let start = -1;
    let tag = "";
    for (const t of ["script", "style", "head"]) {
      const i = lower.indexOf(`<${t}`, at);
      if (i >= 0 && (start < 0 || i < start)) {
        start = i;
        tag = t;
      }
    }
    if (start < 0) return out + html.slice(at);
    out += html.slice(at, start);
    const end = lower.indexOf(`</${tag}`, start);
    if (end < 0) return out;
    const close = lower.indexOf(">", end);
    if (close < 0) return out;
    at = close + 1;
  }
}

/** Readable text from HTML: block elements become line breaks, list items get a dash, scripts and styles are dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripBlocks(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^<>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "").replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, "\n")
      // A tag runs to the next ">" and never across another "<": linear, where [^>]+ would be quadratic on many stray "<".
      .replace(/<[^<>]+>/g, ""),
  )
    .split("\n")
    .map(trimLineEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Spaces, tabs and no-break spaces at the end of a line, removed without a regex that would backtrack. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9 && c !== 0xa0) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

export function cleanTagWord(tag: string): string {
  return tag
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ---------------------------------------------------------------- dedupe against the vault

export interface ExistingMemory {
  title: string;
  body: string;
  source: { kind: SourceKind; ref?: string };
}

function fingerprint(title: string, body: string): string {
  return `${title}\n${body.slice(0, 4000)}`.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Leaves out what the vault already holds: the same source (a note path, a mail
 * thread, an event id) or the same title and text. Also drops items repeated
 * word for word inside the import itself.
 */
export function dedupeDrafts(drafts: MemoryDraft[], existing: ExistingMemory[]): { fresh: MemoryDraft[]; duplicates: number } {
  const refs = new Set(existing.filter((m) => m.source.ref).map((m) => `${m.source.kind}:${m.source.ref}`));
  const prints = new Set(existing.map((m) => fingerprint(m.title, m.body)));
  const fresh: MemoryDraft[] = [];
  let duplicates = 0;
  for (const d of drafts) {
    const ref = d.source?.ref ? `${d.source.kind}:${d.source.ref}` : null;
    const print = fingerprint(d.title, d.body);
    if ((ref && refs.has(ref)) || prints.has(print)) {
      duplicates++;
      continue;
    }
    // Inside one import only identical text counts as a repeat: two items may share a source (a project and its memory).
    prints.add(print);
    fresh.push(d);
  }
  return { fresh, duplicates };
}
