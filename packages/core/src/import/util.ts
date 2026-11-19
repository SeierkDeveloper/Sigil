// Small helpers shared by the export parsers.

export const MAX_BODY_CHARS = 500_000;

export function clampBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n[Shortened on import: the original was ${body.length.toLocaleString("en-US")} characters.]`;
}

export function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // ChatGPT uses seconds, some tools use milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

