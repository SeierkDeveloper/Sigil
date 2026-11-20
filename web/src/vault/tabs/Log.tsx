"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SealIcon } from "@/components/icons";
import { formatDateTime, formatSealPeriod, formatTime, plural, shortHash } from "@/lib/format";
import * as ops from "../ops";
import { openAskNote } from "../selfOps";
import { openLegacyAskNote } from "../legacyOps";
import { errorText, useVault } from "../context";
import { Empty, Notice, Spinner } from "../ui";

type Verify = { state: "checking" } | ops.VerifyResult;

const LEGACY_STEPS: Record<string, string> = {
  made: "You made a legacy plan",
  changed: "You sealed your legacy plan again, with a new legacy key",
  cancelled: "You cancelled your legacy plan",
  "invite-answered": "A person you invited answered with their vault",
  "check-in": "You checked in",
  "warning-first": "Your legacy plan reached its first warning",
  "warning-last": "Your legacy plan reached its last warning",
  "release-open": "Your legacy plan's period ended: trusted people may ask for a release",
  request: "A trusted person asked for a release",
  "share-passed": "A trusted person passed their share to another",
  released: "Your legacy plan was released",
  opened: "A trusted person combined the shares and opened their bundle",
  read: "A trusted person read the folders you left them",
};

export function LogTab() {
  const { api, data, goTo } = useVault();
  const [log, setLog] = useState<ops.LogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState("all");
  const [checks, setChecks] = useState<Record<string, Verify>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setLog(await ops.loadLog(api));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    ops
      .loadLog(api)
      .then((l) => alive && setLog(l))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api]);

  const appName = useMemo(
    () =>
      new Map([
        ...data.apps.map((a) => [a.id, a.name] as const),
        ...data.shares.outgoing.map((s) => [s.id, s.label] as const),
        ...data.askLinks.map((l) => [l.id, `Ask link "${l.label}"`] as const),
      ]),
    [data.apps, data.shares.outgoing, data.askLinks],
  );
  const people = useMemo(() => new Map((data.legacy.record?.people ?? []).map((p) => [p.id, p.label] as const)), [data.legacy.record]);
  const whoDid = (e: ops.LogEntryView) => {
    if (e.kind === "legacy") return e.appId === "legacy" || e.appId === data.legacy.plan?.id ? "Your legacy plan" : (people.get(e.appId) ?? "A trusted person from an earlier plan");
    if (e.kind === "device") return "Your devices";
    return appName.get(e.appId) ?? (e.kind === "shared" ? "A vault you no longer share with" : e.kind === "ask" ? "A deleted ask link" : "Removed app");
  };
  const spaceName = (ref: string | null) => {
    const id = ref?.replace(/^[a-z]+-/, "");
    return data.spaces.find((x) => x.id === id)?.name ?? "a team space";
  };
  const title = useMemo(() => new Map(data.memories.map((m) => [m.id, m.title])), [data.memories]);

  if (!log && error) return <Notice kind="error">The read log could not be loaded: {error}</Notice>;
  if (!log) return <Spinner label="Loading the read log" />;

  // Presence is counted under Proof; listing one line per hour here would bury everything else.
  const shownEntries = log.entries.filter((e) => e.kind !== "presence");
  const entries = app === "all" ? shownEntries : shownEntries.filter((e) => e.appId === app);
  const appsInLog = [...new Set(shownEntries.map((e) => e.appId))];

  const describe = (e: ops.LogEntryView) => {
    const step = e.memoryId ?? "";
    if (e.kind === "legacy") {
      if (step.startsWith("ask-")) return `Your AI self answered a question in legacy mode${e.count ? `, from ${plural(e.count, "memory", "memories")}` : ""}`;
      return LEGACY_STEPS[step] ?? "A step of your legacy plan";
    }
    if (e.kind === "device") {
      if (step.startsWith("added-")) return "A device was added by code and received your vault, sealed to its own key";
      if (step.startsWith("signed-in-")) return "A device you added opened your vault for the first time";
      if (step.startsWith("revoked-")) return "A device was revoked: its key slot and sessions were removed";
      return "A device step";
    }
    if (e.kind === "remember") {
      const t = e.memoryId ? title.get(e.memoryId) : undefined;
      return t ? `Remembered "${t}"` : "Remembered a memory that has since been changed or deleted";
    }
    if (e.kind === "forget") return "Forgot a memory, for good";
    if (e.kind === "handoff") return step.startsWith("left-") ? "Left a handoff note" : "Picked up a handoff note";
    if (e.kind === "space") {
      const name = spaceName(step);
      if (step.startsWith("read-")) return `Read the space ${name} (${plural(e.count, "memory", "memories")})`;
      if (step.startsWith("wrote-")) return `Wrote ${plural(e.count, "memory", "memories")} to the space ${name}`;
      if (step.startsWith("forgot-")) return `Deleted ${plural(e.count, "memory", "memories")} from the space ${name}`;
      if (step.startsWith("joined-")) return `Joined the space ${name}`;
      if (step.startsWith("removed-")) return `Was removed from the space ${name}`;
      return `Used the space ${name}`;
    }
    if (e.kind === "propose") return "Suggested a memory to your inbox";
    if (e.kind === "ask") return `Your AI self answered a question${e.count ? `, from ${plural(e.count, "memory", "memories")}` : ""}`;
    if (e.kind === "shared") return `Opened a folder you share with them (${plural(e.count, "memory", "memories")})`;
    if (e.kind === "folders") return `Listed the ${plural(e.count, "folder")} it may read`;
    if (e.kind === "index") return `Searched the titles, tags and first lines of ${plural(e.count, "memory", "memories")}`;
    const t = e.memoryId ? title.get(e.memoryId) : undefined;
    return t ? `Read "${t}"` : "Read a memory that has since been deleted";
  };

  const sealsAt = (e: ops.LogEntryView) => new Date((e.hour + 1) * log.periodSeconds * 1000).toISOString();

  // The entry with its salt, as the public checker on the Verify page takes it.
  const copyEntry = async (e: ops.LogEntryView) => {
    const { id, appId, kind, memoryId, count, at, salt, hour } = e;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ id, appId, kind, memoryId, count, at, salt, hour }, null, 2));
      setCopied(e.id);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard access was refused; nothing to copy to.
    }
  };

  const verify = async (e: ops.LogEntryView) => {
    setChecks((c) => ({ ...c, [e.id]: { state: "checking" } }));
    const r = await ops.verifyEntry(api, e);
    setChecks((c) => ({ ...c, [e.id]: r }));
  };

  return (
    <div className="log">
      <div className="panel-header">
        <h2 className="panel-title">Read log</h2>
        <div className="row">
          {appsInLog.length > 1 ? (
            <>
              <label className="visually-hidden" htmlFor="log-app">
                App
              </label>
              <select id="log-app" className="select" value={app} onChange={(e) => setApp(e.target.value)}>
                <option value="all">All apps</option>
                {appsInLog.map((id) => (
                  <option key={id} value={id}>
                    {appName.get(id) ?? "Removed app or share"}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <button type="button" className="button button-small" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      <Notice>
        Every request a connected app or agent makes, every memory it suggests, every time another vault opens a folder you share, and every step of your legacy plan and your
        devices is written here. At the end of each hour all of it is sealed into one fingerprint you can verify in this browser. The hours your vault was open are sealed too
        and counted under Proof.{" "}
        {log.mode === "local" ? "Seals are kept by Sigil for now; publishing them on chain is planned." : "Seals are published on chain."}
      </Notice>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {shownEntries.length === 0 ? (
        <Empty
          icon={<SealIcon />}
          title="No app has read your vault yet"
          action={
            <button type="button" className="button" onClick={() => goTo("apps")}>
              Connect an app
            </button>
          }
        >
          When a connected app lists folders, searches, reads or suggests a memory, or a vault you share with opens your folder, it shows up here
          with the time and what it saw.
        </Empty>
      ) : (
        <ul className="list" aria-label="Reads">
          {entries.map((e) => {
            const check = checks[e.id];
            return (
              <li key={e.id} className="list-row log-row" data-kind={e.kind} data-sealed={e.sealed ? "true" : "false"}>
                <div className="list-row-main">
                  <p className="list-row-title">{describe(e)}</p>
                  <p className="list-row-meta">
                    {whoDid(e)}, {formatDateTime(e.at)}.
                    {e.sealed ? null : ` Sealed after ${formatTime(sealsAt(e))}.`}
                  </p>
                  {(e.kind === "ask" || (e.kind === "legacy" && e.memoryId?.startsWith("ask-"))) && e.note ? (
                    shown === e.id ? (
                      <AskNoteView entry={e} />
                    ) : (
                      <button type="button" className="text-button small" onClick={() => setShown(e.id)}>
                        Show the question and answer
                      </button>
                    )
                  ) : null}
                  {check && "ok" in check ? (
                    check.ok ? (
                      <p className="small log-verified" data-testid="verified">
                        Verified: part of the seal for {formatSealPeriod(check.hour, log.periodSeconds)}, root {shortHash(check.root, 8)}.{" "}
                        <button type="button" className="text-button" onClick={() => void copyEntry(e)}>
                          {copied === e.id ? "Copied" : "Copy entry"}
                        </button>
                      </p>
                    ) : (
                      <p className="small log-unverified">Not verified: {check.reason}</p>
                    )
                  ) : null}
                </div>
                <div className="list-row-actions">
                  <span className="badge">{e.sealed ? "Sealed" : "Waiting for seal"}</span>
                  {e.sealed ? (
                    <button type="button" className="button button-small" onClick={() => void verify(e)} disabled={!!check && "state" in check}>
                      {check && "state" in check ? "Checking" : "Verify"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The question and answer of one entry, opened with this vault's own key. The server holds them sealed. */
function AskNoteView({ entry }: { entry: ops.LogEntryView }) {
  const { data, openMemory } = useVault();
  const note = data.box ? (entry.kind === "legacy" ? openLegacyAskNote(data.box, data.legacy.plan?.id ?? "", entry) : openAskNote(data.box, entry)) : null;
  if (!note) return <p className="small log-unverified">This entry could not be opened with your vault key.</p>;
  return (
    <div className="ask-note" data-testid="ask-note">
      <dl className="ask-note-turns">
        <div>
          <dt>Asked</dt>
          <dd>{note.question}</dd>
        </div>
        <div>
          <dt>Answered</dt>
          <dd>{note.answer}</dd>
        </div>
      </dl>
      {note.citations.length ? (
        <p className="ask-note-from">
          From{" "}
          {note.citations.map((c, i) => (
            <span key={c.id}>
              {i ? ", " : ""}
              <button type="button" className="text-button" onClick={() => openMemory(c.id)}>
                {c.title}
              </button>
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}
