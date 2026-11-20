"use client";

import { useEffect, useState } from "react";
import { MEET_DEFAULT_TURNS, MEET_PURPOSES, parseVaultCode, vaultFingerprint, type MeetPurpose } from "@sigil/core";
import { MeetIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as meet from "../meetOps";
import { errorText, useVault } from "../context";
import { Empty, Fingerprint, Notice, PlateHead, Quiet } from "../ui";

const PURPOSES = Object.keys(MEET_PURPOSES) as MeetPurpose[];

const STATE_WORD: Record<meet.MeetView["state"], string> = {
  invited: "Waiting for a yes",
  running: "Talking",
  done: "Done",
  stopped: "Stopped",
  declined: "Declined",
};

/** Selves meet selves: your AI self talks with another vault's, after both of you said yes, for one purpose. */
export function MeetTab() {
  const { api, vault, data, update } = useVault();
  const [inviting, setInviting] = useState(false);

  // While this tab is open, the conversations are read again every few seconds.
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(() => {
      api
        .get<{ meets: meet.ServerMeet[] }>("meets")
        .then((r) => meet.openMeets(vault, data.box, r.meets))
        .then((r) => alive && update((d) => ({ ...d, meets: r.meets })))
        .catch(() => undefined);
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, vault, data.box, update]);

  const invites = data.meets.filter((m) => m.role === "invitee" && m.state === "invited");
  const rest = data.meets.filter((m) => !(m.role === "invitee" && m.state === "invited"));

  return (
    <div className="meet">
      <div className="panel-header">
        <h2 className="panel-title">Selves meet</h2>
        {!inviting ? (
          <button type="button" className="button button-primary" onClick={() => setInviting(true)}>
            <MeetIcon /> Invite another self
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Your AI self talks with someone else&apos;s, only after both of you said yes, for one purpose and a fixed number of turns. Each answers within its own rules, from
        the folders its owner chose. Every message is encrypted between the two vaults; Sigil passes it on and cannot read it. You both get the whole transcript, and
        either of you can stop it. Your AI self takes its turns while this vault is open, with your own model key.
      </p>
      {!data.model || !data.self ? <Notice>Add your model key and save your AI self&apos;s rules under AI self first: they are what your self talks with.</Notice> : null}
      {inviting ? <InviteForm onDone={() => setInviting(false)} /> : null}
      {invites.map((m) => (
        <InviteCard key={m.id} meeting={m} />
      ))}
      {rest.length === 0 && invites.length === 0 && !inviting ? (
        <Empty icon={<MeetIcon />} title="No conversations yet">
          Ask someone for their vault code (under Folders, Your vault code), and invite their AI self to find a time, see whether a collab fits, or swap intros.
        </Empty>
      ) : null}
      {rest.map((m) => (
        <MeetCard key={m.id} meeting={m} />
      ))}
    </div>
  );
}

function FolderPick({ id, selected, onChange }: { id: string; selected: Set<string>; onChange(s: Set<string>): void }) {
  const { data } = useVault();
  return (
    <fieldset className="checkbox-list">
      <legend className="visually-hidden">Folders your self may use</legend>
      {data.folders.map((f) => (
        <label key={f.id} className="checkbox" htmlFor={`${id}-${f.id}`}>
          <input
            id={`${id}-${f.id}`}
            type="checkbox"
            checked={selected.has(f.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(f.id);
              else next.delete(f.id);
              onChange(next);
            }}
          />
          <span>
            {f.name}
            {f.protect ? " (protected: each read asks you)" : ""}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function InviteForm({ onDone }: { onDone(): void }) {
  const { api, vault, reload } = useVault();
  const [code, setCode] = useState("");
  const [purpose, setPurpose] = useState<MeetPurpose>("find_time");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");
  const [me, setMe] = useState("");
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [calendar, setCalendar] = useState(true);
  const [turns, setTurns] = useState(MEET_DEFAULT_TURNS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let fingerprint: string | null = null;
  let codeError: string | null = null;
  if (code.trim()) {
    try {
      fingerprint = vaultFingerprint(parseVaultCode(code));
    } catch (err) {
      codeError = errorText(err);
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await meet.inviteSelf(api, vault, { code, purpose, note, label, me, folderIds: [...folders], calendar: purpose === "find_time" && calendar, turnLimit: turns });
      await reload();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel plate meet-form" onSubmit={submit} aria-label="Invite another self">
      <PlateHead number="01" title="Invite another self" lead="Their owner gets the invite in their vault and says yes or no. Nothing is said before that." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="field">
        <label className="field-label" htmlFor="meet-code">
          Their vault code
        </label>
        <input id="meet-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sigil_vault..." autoComplete="off" spellCheck={false} required />
        <span className="field-hint" aria-live="polite">
          {codeError ?? (fingerprint ? "Ask them to read their fingerprint to you; it must match the one below." : "They find it in their vault, under Folders.")}
        </span>
        {fingerprint ? <Fingerprint value={fingerprint} /> : null}
      </div>
      <div className="field">
        <span className="field-label">What for</span>
        <div className="segmented" role="group" aria-label="What for">
          {PURPOSES.map((p) => (
            <button key={p} type="button" aria-pressed={purpose === p} onClick={() => setPurpose(p)}>
              {MEET_PURPOSES[p].label}
            </button>
          ))}
        </div>
        <span className="field-hint">{MEET_PURPOSES[purpose].goal}</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="meet-note">
          A line for both selves
        </label>
        <input id="meet-note" className="input" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder="For example 30 minutes next week about the book" />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor="meet-label">
            What you call them
          </label>
          <input id="meet-label" className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Only you see this" required />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="meet-me">
            Your name, as they see it
          </label>
          <input id="meet-me" className="input" value={me} maxLength={80} onChange={(e) => setMe(e.target.value)} required />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Folders your self may use</span>
        <FolderPick id="meet-folders" selected={folders} onChange={setFolders} />
        {purpose === "find_time" ? (
          <label className="checkbox" htmlFor="meet-calendar">
            <input id="meet-calendar" type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} />
            <span>
              May read my calendar
              <span className="field-hint">Calendar memories from live sync or an import, wherever they are. It says a slot is taken without saying why.</span>
            </span>
          </label>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="meet-turns">
          Turns, both sides together
        </label>
        <input id="meet-turns" className="input" type="number" min={2} max={12} value={turns} onChange={(e) => setTurns(Math.min(12, Math.max(2, Number(e.target.value) || 2)))} />
      </div>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !fingerprint || !label.trim() || !me.trim()}>
          {busy ? "Sending" : "Send invite"}
        </button>
        <button type="button" className="button button-ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function InviteCard({ meeting }: { meeting: meet.MeetView }) {
  const { api, vault, reload } = useVault();
  const [label, setLabel] = useState(meeting.peerName);
  const [me, setMe] = useState("");
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [calendar, setCalendar] = useState(meeting.purpose === "find_time");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="subpanel plate meet-invite" aria-label={`Invite from ${meeting.peerName}`} data-testid="meet-invite">
      <PlateHead number="02" title={`${meeting.peerName} invites your AI self`} lead={`${MEET_PURPOSES[meeting.purpose].label}, in up to ${meeting.turnLimit} turns.`}>
        <span className="plate-state" data-on="false">
          Waiting for you
        </span>
      </PlateHead>
      {meeting.note ? <p className="meet-note">&ldquo;{meeting.note}&rdquo;</p> : null}
      <p className="small muted">
        Their vault: <Fingerprint value={vaultFingerprint(meeting.peerKey)} />. Compare it with what they read to you if you are not sure who this is.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="grid grid-2">
        <div className="field">
          <label className="field-label" htmlFor={`accept-label-${meeting.id}`}>
            What you call them
          </label>
          <input id={`accept-label-${meeting.id}`} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`accept-me-${meeting.id}`}>
            Your name, as they see it
          </label>
          <input id={`accept-me-${meeting.id}`} className="input" value={me} maxLength={80} onChange={(e) => setMe(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Folders your self may use</span>
        <FolderPick id={`accept-folders-${meeting.id}`} selected={folders} onChange={setFolders} />
        {meeting.purpose === "find_time" ? (
          <label className="checkbox" htmlFor={`accept-calendar-${meeting.id}`}>
            <input id={`accept-calendar-${meeting.id}`} type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} />
            <span>May read my calendar</span>
          </label>
        ) : null}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !me.trim()}
          onClick={() => void act(() => meet.acceptMeet(api, vault, meeting, { label, me, folderIds: [...folders], calendar }))}
        >
          Say yes
        </button>
        <button type="button" className="button button-ghost" disabled={busy} onClick={() => void act(() => meet.declineMeet(api, meeting.id))}>
          Decline
        </button>
      </div>
    </section>
  );
}

function MeetCard({ meeting }: { meeting: meet.MeetView }) {
  const { api, data, reload } = useVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderNames = (meeting.record?.folderIds ?? []).map((id) => data.folders.find((f) => f.id === id)?.name).filter(Boolean) as string[];
  const open = meeting.state === "invited" || meeting.state === "running";

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const waitingLine =
    meeting.state === "invited"
      ? `Waiting for ${meeting.peerName} to say yes.`
      : meeting.state === "running"
        ? meeting.next === "me"
          ? "Your AI self's turn. It writes while this vault is open."
          : meeting.peerOnline
            ? `${meeting.peerName}'s AI self is writing.`
            : `Waiting for ${meeting.peerName}'s AI self: their vault is not open right now.`
        : meeting.state === "stopped"
          ? `Stopped by ${meeting.stoppedBy === "me" ? "you" : meeting.peerName}.`
          : meeting.state === "declined"
            ? `${meeting.peerName} said no.`
            : `Done after ${plural(meeting.turns, "turn")}.`;

  return (
    <section className="subpanel plate meet-card" data-state={meeting.state} data-testid="meet-card" aria-label={`Conversation with ${meeting.record?.label ?? meeting.peerName}`}>
      <PlateHead number={meeting.role === "inviter" ? "Out" : "In"} title={`${meeting.record?.label ?? meeting.peerName}: ${MEET_PURPOSES[meeting.purpose].label}`} lead={waitingLine}>
        <span className="plate-state" data-on={open ? "true" : "false"}>
          {STATE_WORD[meeting.state]}
        </span>
      </PlateHead>
      {meeting.note ? <p className="meet-note">&ldquo;{meeting.note}&rdquo;</p> : null}
      <p className="small faint">
        Started {formatDateTime(meeting.createdAt)}. {meeting.turns} of {meeting.turnLimit} turns.{" "}
        {folderNames.length ? `Your self may use ${folderNames.join(", ")}` : "Your self uses no folder"}
        {meeting.record?.calendar ? " and your calendar." : "."}
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {meeting.lines.length ? (
        <ol className="chat meet-transcript" aria-label="Transcript">
          {meeting.lines.map((l) => (
            <li key={l.turn} className="chat-turn" data-mine={l.mine ? "true" : "false"} data-testid="meet-line">
              <div className="chat-answer">
                <p className="chat-by">
                  <span className="chat-by-name">{l.mine ? "Your AI self" : `${meeting.peerName}'s AI self`}</span>
                  <span className="chat-by-kind">AI</span>
                  <span className="faint"> Turn {l.turn}</span>
                </p>
                <p>{l.ok ? l.text : "This message could not be opened: it was not written by either vault."}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Quiet>{meeting.state === "invited" ? "Nothing is said until they say yes." : "No turns yet."}</Quiet>
      )}
      <div className="form-actions">
        {open ? (
          <button type="button" className="button button-small button-danger" disabled={busy} onClick={() => void act(() => meet.stopMeet(api, meeting.id))}>
            Stop
          </button>
        ) : (
          <button type="button" className="button button-small button-ghost" disabled={busy} onClick={() => void act(() => meet.removeMeet(api, meeting.id))}>
            Remove from my list
          </button>
        )}
      </div>
    </section>
  );
}

