"use client";

import { formatDateTime, formatSealPeriod, plural } from "@/lib/format";
import { untilNextSeal, useLive, useNow, type Stats, type StatusResponse } from "./useLive";

type Level = "ok" | "off" | "fault";
const WORD: Record<Level, string> = { ok: "Working", off: "Switched off", fault: "Fault" };

function Row({ name, level, children }: { name: string; level: Level; children: React.ReactNode }) {
  return (
    <li className="status-row" data-level={level}>
      <span className="status-mark" aria-hidden="true" />
      <div className="status-main">
        <p className="status-name">{name}</p>
        <p className="status-text">{children}</p>
      </div>
      <span className={level === "ok" ? "badge badge-strong" : "badge"}>{WORD[level]}</span>
    </li>
  );
}

function upFor(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 129_600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/** Live health, read from this server every half minute. */
export function StatusBoard() {
  const status = useLive<StatusResponse>("/api/status", 30_000);
  const stats = useLive<Stats>("/api/stats", 30_000);
  const now = useNow();

  if (status.status === "loading") {
    return (
      <div className="loading" role="status">
        <span className="spinner" aria-hidden="true" /> Asking the server
      </div>
    );
  }
  if (status.status === "error") {
    return (
      <div className="status-banner" data-level="fault" role="alert">
        <p className="status-banner-title">The server did not answer</p>
        <p className="status-banner-text">
          This page could not reach the Sigil server from your browser. Your vault is stored encrypted and is not affected by a status check. Try
          again in a moment.
        </p>
      </div>
    );
  }

  const s = status.data.seals;
  const sealLevel: Level = s.job === "ok" ? "ok" : s.job === "off" ? "off" : "fault";
  const allGood = status.data.ok && sealLevel !== "fault";
  return (
    <div className="status-board">
      <div className="status-banner" data-level={allGood ? "ok" : "fault"} role="status">
        <p className="status-banner-title">{allGood ? "Everything is working" : "Something needs attention"}</p>
        <p className="status-banner-text">
          Checked {formatDateTime(new Date(status.at).toISOString())}. The server answered in {status.ms} ms. This page asks again every 30
          seconds while it is open.
        </p>
      </div>

      <ul className="status-list" aria-label="Parts of the service">
        <Row name="Site and API" level="ok">
          Answering requests. Running for {upFor(status.data.upSeconds)} since its last start.
        </Row>
        <Row name="Vault database" level={status.data.database === "ok" ? "ok" : "fault"}>
          Reading and writing. It holds ciphertext, ids, sizes and times, never readable memories.
        </Row>
        <Row name="Seal job" level={sealLevel}>
          {s.job === "off"
            ? "Sealing is switched off on this server."
            : s.job === "failed"
              ? `${plural(s.overdue, "read")} from a finished hour ${s.overdue === 1 ? "is" : "are"} not sealed yet.`
              : s.latestHour === null
                ? "Ready. No hour has had a read to seal yet."
                : `Last seal: ${formatSealPeriod(s.latestHour, s.periodSeconds)}, written ${s.lastSealedAt ? formatDateTime(s.lastSealedAt) : ""}.`}
          {s.job !== "off" ? ` ${plural(s.open, "read")} waiting for this hour to close${now ? `, in ${untilNextSeal(now, s.periodSeconds)}` : ""}.` : ""}
        </Row>
        <Row name="Seals on chain" level={s.mode === "anchored" ? "ok" : "off"}>
          {s.mode === "anchored"
            ? "Seal roots are published to the SigilSeal contract."
            : "Seals are kept by this server for now. Publishing them on chain is on the roadmap and is not switched on."}
        </Row>
      </ul>

      <dl className="status-numbers">
        <div>
          <dt>Seals written</dt>
          <dd>{s.seals.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Reads sealed</dt>
          <dd>{s.leaves.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Vaults</dt>
          <dd>{stats.status === "ready" ? stats.data.vaults.toLocaleString("en-US") : "0"}</dd>
        </div>
        <div>
          <dt>Memories held encrypted</dt>
          <dd>{stats.status === "ready" ? stats.data.memories.toLocaleString("en-US") : "0"}</dd>
        </div>
        <div>
          <dt>Connected apps</dt>
          <dd>{stats.status === "ready" ? stats.data.apps.toLocaleString("en-US") : "0"}</dd>
        </div>
        <div>
          <dt>Seal period</dt>
          <dd>{s.periodSeconds === 3600 ? "1 hour" : `${s.periodSeconds} s`}</dd>
        </div>
      </dl>
    </div>
  );
}
