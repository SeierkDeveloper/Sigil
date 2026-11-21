// Small helpers shared by the export parsers.

import { unzipSync, type UnzipFileInfo } from "fflate";

/** The most the files in one zip may open to, together. A small zip that unpacks to gigabytes is refused before it is opened. */
export const MAX_UNZIPPED_BYTES = 1024 * 1024 * 1024;

export class ZipTooLarge extends Error {
  constructor() {
    super("This zip file opens to more than an import can hold.");
  }
}

/**
 * unzipSync with a ceiling: the sizes the zip declares for the files it keeps
 * are added up before anything is inflated, and each file is inflated into a
 * buffer of its declared size, so a file cannot grow past what it declared.
 */
export function unzipLimited(bytes: Uint8Array, keep: (f: UnzipFileInfo) => boolean = () => true, maxBytes = MAX_UNZIPPED_BYTES): Record<string, Uint8Array> {
  let total = 0;
  let tooLarge = false;
  const out = unzipSync(bytes, {
    filter: (f) => {
      if (!keep(f)) return false;
      total += f.originalSize;
      if (total > maxBytes) tooLarge = true;
      return !tooLarge;
    },
  });
  if (tooLarge) throw new ZipTooLarge();
  return out;
}

export const MAX_BODY_CHARS = 500_000;

export function clampBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n[Shortened on import: the original was ${body.length.toLocaleString("en-US")} characters.]`;
}

export function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // ChatGPT uses seconds, some tools use milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

