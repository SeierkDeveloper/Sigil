// Files picked or dropped for a local import, and the small text helpers the
// parsers share. Everything runs on the device: a zip is opened in memory,
// read, and only the encrypted memories made from it leave the browser.

import { unzipSync } from "fflate";
import type { MemoryDraft, SourceKind } from "../vault";

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
        entries = unzipSync(f.bytes);
      } catch {
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
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Readable text from HTML: block elements become line breaks, list items get a dash, scripts and styles are dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "").replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * thread, an event id) or the same title and text. Also drops repeats inside the
 * import itself.
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
    if (ref) refs.add(ref);
    prints.add(print);
    fresh.push(d);
  }
  return { fresh, duplicates };
}
