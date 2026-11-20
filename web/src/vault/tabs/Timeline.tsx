"use client";

import { useMemo, useState } from "react";
import { SOURCE_LABELS, sourceLabel, type Memory, type SourceKind } from "@sigil/core";
import { TimelineIcon } from "@/components/icons";
import { plural } from "@/lib/format";
import { useVault } from "../context";
import { Empty } from "../ui";

type DateField = "createdAt" | "editedAt";

const monthLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const monthKey = (iso: string) => iso.slice(0, 7);
const dayKey = (iso: string) => iso.slice(0, 10);

/** Every memory on one line through time, by when it was written or last changed, and where it came from. */
export function TimelineTab() {
  const { data, openMemory, goTo } = useVault();
  const [source, setSource] = useState<SourceKind | "all">("all");
  const [field, setField] = useState<DateField>("createdAt");

  const sources = useMemo(() => {
    const counts = new Map<SourceKind, number>();
    for (const m of data.memories) counts.set(m.source.kind, (counts.get(m.source.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.memories]);

  const months = useMemo(() => {
    const pool = (source === "all" ? data.memories : data.memories.filter((m) => m.source.kind === source)).slice();
    pool.sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
    const out: { key: string; label: string; days: { key: string; label: string; items: Memory[] }[]; count: number }[] = [];
    for (const m of pool) {
      const iso = m[field];
      let month = out[out.length - 1];
      if (!month || month.key !== monthKey(iso)) {
        month = { key: monthKey(iso), label: monthLabel(iso), days: [], count: 0 };
        out.push(month);
      }
      let day = month.days[month.days.length - 1];
      if (!day || day.key !== dayKey(iso)) {
        day = { key: dayKey(iso), label: dayLabel(iso), items: [] };
        month.days.push(day);
      }
      day.items.push(m);
      month.count++;
    }
    return out;
  }, [data.memories, source, field]);

  const folderName = useMemo(() => new Map(data.folders.map((f) => [f.id, f.name])), [data.folders]);

  if (data.memories.length === 0) {
    return (
      <Empty
        icon={<TimelineIcon />}
        title="Nothing on the timeline yet"
        action={
          <button type="button" className="button" onClick={() => goTo("import")}>
            Import ChatGPT or Claude
          </button>
        }
      >
        Memories appear here by the day they were written, with where each came from. Imports keep the dates of the original conversations.
      </Empty>
    );
  }

  return (
    <div className="timeline">
      <div className="panel-header">
        <h2 className="panel-title">Timeline</h2>
        <div className="row">
          <label className="visually-hidden" htmlFor="timeline-source">
            Source
          </label>
          <select id="timeline-source" className="select" value={source} onChange={(e) => setSource(e.target.value as SourceKind | "all")}>
            <option value="all">All sources</option>
            {sources.map(([k, n]) => (
              <option key={k} value={k}>
                {SOURCE_LABELS[k]} ({n})
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="timeline-field">
            Date
          </label>
          <select id="timeline-field" className="select" value={field} onChange={(e) => setField(e.target.value as DateField)}>
            <option value="createdAt">By date written</option>
            <option value="editedAt">By last change</option>
          </select>
        </div>
      </div>

      <ol className="timeline-months">
        {months.map((month) => (
          <li key={month.key} className="timeline-month">
            <h3 className="timeline-month-title">
              {month.label} <span className="faint small">{plural(month.count, "memory", "memories")}</span>
            </h3>
            <ol className="timeline-days">
              {month.days.map((day) => (
                <li key={day.key} className="timeline-day">
                  <p className="timeline-day-label">{day.label}</p>
                  <ul className="timeline-items">
                    {day.items.map((m) => (
                      <li key={m.id}>
                        <button type="button" className="timeline-item" data-source={m.source.kind} onClick={() => openMemory(m.id)}>
                          <span className="timeline-item-title">{m.title}</span>
                          <span className="timeline-item-meta">
                            <span className="chip">{sourceLabel(m.source)}</span>
                            <span>{folderName.get(m.folderId)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
