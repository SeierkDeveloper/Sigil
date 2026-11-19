"use client";

import { useEffect, useState } from "react";
import { formatSealPeriod, plural, shortHash } from "@/lib/format";

interface Seal {
  hour: number;
  root: string;
  leaves: number;
  anchorTx: string | null;
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; mode: "local" | "anchored"; periodSeconds: number; seals: Seal[] };

/** The latest public seals. Roots only: nothing in them identifies a person or a memory. */
export function SealList({ limit = 12 }: { limit?: number }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    fetch(`/api/seals?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setState({ status: "ready", mode: d.mode, periodSeconds: d.periodSeconds, seals: d.seals }))
      .catch(() => alive && setState({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [limit]);

  if (state.status === "loading") {
    return (
      <div className="loading" role="status">
        <span className="spinner" aria-hidden="true" /> Loading seals
      </div>
    );
  }
  if (state.status === "error") {
    return <p className="notice notice-error">The seals could not be loaded right now. Please try again later.</p>;
  }
  if (state.seals.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">No seals yet</p>
        <p className="empty-state-text">A seal is made at the end of every hour in which a connected app read a vault. The first one will appear here.</p>
      </div>
    );
  }
  return (
    <ul className="seal-list" aria-label="Latest seals">
      {state.seals.map((s) => (
        <li key={s.hour} className="seal-row">
          <span className="seal-hour">{formatSealPeriod(s.hour, state.periodSeconds)}</span>
          <span className="seal-root" title={s.root}>
            {shortHash(s.root, 12)}
          </span>
          <span className="faint">{plural(s.leaves, "read")}</span>
          <span className="badge">{s.anchorTx ? "On chain" : "Local"}</span>
        </li>
      ))}
    </ul>
  );
}
