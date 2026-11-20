"use client";

// The privacy score of one app or agent, computed in this browser from the
// owner's own read log: what it read, which folders, protected reads, how
// often, and its writes. It shows where every point went, and claims nothing
// the log does not show.

import { useEffect, useState } from "react";
import Link from "next/link";
import { LEVEL_TEXT, privacyScore, SCORE_WINDOW_DAYS, type PrivacyScore } from "@sigil/core";
import { formatDateTime } from "@/lib/format";
import type { AppView, LogEntryView } from "./ops";
import { useVault } from "./context";

const LOG_LIMIT = 1000;

export function scoreFor(data: ReturnType<typeof useVault>["data"], app: Pick<AppView, "folderIds">, entries: LogEntryView[]): PrivacyScore {
  const granted = new Set(app.folderIds);
  return privacyScore({
    entries,
    memoryFolder: new Map(data.memories.map((m) => [m.id, m.folderId])),
    folders: data.folders.map((f) => ({ id: f.id, name: f.name, protect: f.protect })),
    readable: data.memories.filter((m) => granted.has(m.folderId)).length,
    partial: entries.length >= LOG_LIMIT,
  });
}

export function PrivacyScoreCard({ app }: { app: AppView }) {
  const { api, data } = useVault();
  const [entries, setEntries] = useState<LogEntryView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ entries: LogEntryView[] }>(`log?app=${encodeURIComponent(app.id)}&limit=${LOG_LIMIT}`)
      .then((r) => alive && setEntries(r.entries))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [api, app.id]);

  if (failed) return null;
  if (!entries) return <span className="chip score-chip" data-level="loading">Privacy score: reading your log</span>;
  const s = scoreFor(data, app, entries);
  return (
    <div className="score" data-level={s.level} data-testid="privacy-score" style={{ "--score": s.score } as React.CSSProperties}>
      <button type="button" className="chip score-chip" data-level={s.level} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Privacy score <span className="score-number">{s.score}</span>
        <span className="score-meter" aria-hidden="true" />
        <span className="faint score-level"> {LEVEL_TEXT[s.level]}</span>
      </button>
      {open ? (
        <div className="subpanel score-detail">
          <p className="small muted">
            From your own read log of the last {SCORE_WINDOW_DAYS} days, counted in this browser. 100 means it read nothing; each line below takes points away.
            {s.facts.partial ? " Only its latest 1,000 log entries were looked at." : ""} It shows what was read, not what the app did with it.
          </p>
          <dl className="score-parts">
            {s.parts.map((p) => (
              <div key={p.key} className="score-part" data-points={p.points} style={{ "--share": p.max ? p.points / p.max : 0 } as React.CSSProperties}>
                <dt>
                  <span className="score-part-label">{p.label}</span>{" "}
                  <span className="score-part-points">
                    <span className="mono">-{p.points}</span>
                    <span className="faint"> of {p.max}</span>
                  </span>
                </dt>
                <dd>{p.why}</dd>
              </div>
            ))}
          </dl>
          <p className="small faint">
            {s.facts.folders.length ? `Folders read: ${s.facts.folders.map((f) => `${f.name} (${f.reads})`).join(", ")}. ` : ""}
            {s.facts.searches ? `${s.facts.searches} searches or folder lists. ` : ""}
            {s.facts.lastAt ? `Last activity ${formatDateTime(s.facts.lastAt)}.` : "No activity in this window."}{" "}
            <Link href="/docs#privacy-score">How the score is made</Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
