// Every date, size and count on the site goes through these.

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "19 Nov 2026, 14:00 to 15:00" for one seal period. */
export function formatSealPeriod(hour: number, periodSeconds: number): string {
  const start = new Date(hour * periodSeconds * 1000);
  const end = new Date((hour + 1) * periodSeconds * 1000);
  const day = start.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: periodSeconds < 60 ? "2-digit" : undefined });
  return `${day}, ${t(start)} to ${t(end)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function shortHash(hex: string, chars = 10): string {
  return hex.length > chars * 2 + 2 ? `${hex.slice(0, chars + 2)}...${hex.slice(-chars)}` : hex;
}
