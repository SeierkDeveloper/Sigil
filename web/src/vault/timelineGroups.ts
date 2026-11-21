// The timeline's months and days, worked out once per change of the memories.
// Kept apart from the screen so the performance check can time it on a large vault.

import type { Memory, SourceKind } from "@sigil/core";

export type DateField = "createdAt" | "editedAt";

export interface TimelineMonth {
  key: string;
  label: string;
  days: { key: string; label: string; items: Memory[] }[];
  count: number;
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export function groupByMonth(memories: Memory[], source: SourceKind | "all", field: DateField): TimelineMonth[] {
  const pool = (source === "all" ? memories : memories.filter((m) => m.source.kind === source)).slice();
  pool.sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
  const out: TimelineMonth[] = [];
  for (const m of pool) {
    const iso = m[field];
    const mk = iso.slice(0, 7);
    let month = out[out.length - 1];
    if (!month || month.key !== mk) {
      month = { key: mk, label: monthFormat.format(new Date(iso)), days: [], count: 0 };
      out.push(month);
    }
    const dk = iso.slice(0, 10);
    let day = month.days[month.days.length - 1];
    if (!day || day.key !== dk) {
      day = { key: dk, label: dayFormat.format(new Date(iso)), items: [] };
      month.days.push(day);
    }
    day.items.push(m);
    month.count++;
  }
  return out;
}
