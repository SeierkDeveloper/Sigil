"use client";

import { useMemo, useState } from "react";
import { SOURCE_LABELS, sourceLabel, type Memory, type SourceKind } from "@sigil/core";
import { TimelineIcon } from "@/components/icons";
import { formatDate, formatTime, plural } from "@/lib/format";
import { useVault } from "../context";
import { groupByMonth } from "../timelineGroups";
import { SourceMark } from "../marks";
import { Empty } from "../ui";

type DateField = "createdAt" | "editedAt";

const dayNumber = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric" });
const weekday = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short" });

/** One day's memories, kept in order and gathered under where they came from. */
function bySource(items: Memory[]): { label: string; kind: SourceKind; items: Memory[] }[] {
  const groups: { label: string; kind: SourceKind; items: Memory[] }[] = [];
  for (const m of items) {
    const label = sourceLabel(m.source);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, kind: m.source.kind, items: [] };
      groups.push(g);
    }
    g.items.push(m);
  }
  return groups;
}

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

  const months = useMemo(() => groupByMonth(data.memories, source, field), [data.memories, source, field]);

  const folderName = useMemo(() => new Map(data.folders.map((f) => [f.id, f.name])), [data.folders]);
  const span = useMemo(() => {
    const days = months.flatMap((m) => m.days);
    if (days.length === 0) return null;
    const first = days[days.length - 1].items[0][field];
    const last = days[0].items[0][field];
    return { first: formatDate(first), last: formatDate(last), days: days.length, count: months.reduce((n, m) => n + m.count, 0) };
  }, [months, field]);

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
          <label className="visually-hidden" htmlFor="timeline-field">
            Date
          </label>
          <select id="timeline-field" className="select" value={field} onChange={(e) => setField(e.target.value as DateField)}>
            <option value="createdAt">By date written</option>
            <option value="editedAt">By last change</option>
          </select>
        </div>
      </div>
      <p className="small muted screen-help">Your memories by date, newest first. Choose which date to go by: when something happened, when you wrote it down, or when you last changed it.</p>

      <div className="timeline-sources" role="group" aria-label="Source">
        <button type="button" className="timeline-source" aria-pressed={source === "all"} onClick={() => setSource("all")}>
          <span className="timeline-source-name">All sources</span>
          <span className="timeline-source-count">{data.memories.length}</span>
        </button>
        {sources.map(([k, n]) => (
          <button key={k} type="button" className="timeline-source" data-source={k} aria-pressed={source === k} onClick={() => setSource(k)}>
            <SourceMark kind={k} />
            <span className="timeline-source-name">{SOURCE_LABELS[k]}</span>
            <span className="timeline-source-count">{n}</span>
          </button>
        ))}
      </div>
      {span ? (
        <p className="timeline-span" aria-live="polite">
          <span>{plural(span.count, "memory", "memories")}</span>
          <span>{plural(span.days, "day")}</span>
          <span>{span.first === span.last ? span.last : `${span.first} to ${span.last}`}</span>
        </p>
      ) : null}

      <ol className="timeline-months">
        {months.map((month) => (
          <li key={month.key} className="timeline-month">
            <h3 className="timeline-month-title">
              <span>{month.label}</span> <span className="timeline-month-count">{plural(month.count, "memory", "memories")}</span>
            </h3>
            <ol className="timeline-days">
              {month.days.map((day) => (
                <li key={day.key} className="timeline-day">
                  <p className="timeline-day-label" aria-label={day.label}>
                    <span className="timeline-day-number" aria-hidden="true">
                      {dayNumber(day.items[0][field])}
                    </span>
                    <span className="timeline-day-week" aria-hidden="true">
                      {weekday(day.items[0][field])}
                    </span>
                  </p>
                  <ul className="timeline-groups">
                    {bySource(day.items).map((g) => (
                      <li key={g.label} className="timeline-group" data-source={g.kind}>
                        <p className="timeline-group-head">
                          <SourceMark kind={g.kind} />
                          <span className="timeline-group-name">{g.label}</span>
                          {g.items.length > 1 ? <span className="timeline-group-count">{g.items.length}</span> : null}
                        </p>
                        <ul className="timeline-items">
                          {g.items.map((m) => (
                            <li key={m.id}>
                              <button type="button" className="timeline-item" data-source={m.source.kind} onClick={() => openMemory(m.id)}>
                                <span className="timeline-item-title">{m.title}</span>
                                <span className="timeline-item-meta">
                                  <span className="visually-hidden">{g.label}. </span>
                                  <span className="timeline-item-folder">{folderName.get(m.folderId)}</span>
                                  <span className="timeline-item-time">{formatTime(m[field])}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
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
