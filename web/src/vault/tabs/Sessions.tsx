"use client";

// Sessions with the public AI self, under AI self: when people may book a
// conversation with it, on which topics, how long, what they are asked first
// and the house rules every answer keeps; and each booking with what the
// visitor wrote, what they agreed to and the transcript, opened on this device.

import { useEffect, useState } from "react";
import { cleanOffer, splitList, DEFAULT_OFFER, SESSION_SLOT_MINUTES, type SessionOffer, type SessionWindow } from "@sigil/core";
import { formatDateTime, plural } from "@/lib/format";
import * as sessions from "../sessionOps";
import { errorText, useVault } from "../context";
import { Band, Notice, PlateHead, Quiet } from "../ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function SessionsSection() {
  const { api, data, update } = useVault();
  const self = data.publicSelf;
  const [editing, setEditing] = useState(false);
  const offer = data.sessions.offer;
  const box = data.box;

  // Bookings and turns arrive while the vault is open; the list follows.
  const selfId = self?.id ?? null;
  const hasOffer = !!offer;
  useEffect(() => {
    if (!selfId || !hasOffer) return;
    let alive = true;
    const t = window.setInterval(() => {
      api
        .get<sessions.ServerSessions>("sessions")
        .then((r) => alive && update((d) => ({ ...d, sessions: sessions.openSessions(d.publicSelf, box, r).sessions })))
        .catch(() => undefined);
    }, 5_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, update, box, selfId, hasOffer]);
  return (
    <section className="subpanel plate self-sessions" aria-labelledby="self-sessions" data-testid="sessions">
      <PlateHead
        number="07"
        id="self-sessions"
        title="Sessions"
        lead="Let people book a short conversation with your public AI self, on topics you choose, at times you set, under house rules every answer keeps. Free. Every answer is marked as AI, and you read every session."
      >
        {offer ? (
          <span className="plate-state" data-on={offer.enabled ? "true" : "false"}>
            {offer.enabled ? "Taking bookings" : "Closed"}
          </span>
        ) : null}
      </PlateHead>
      {!self ? (
        <Quiet>Set up your public AI self above first: sessions are held on its page.</Quiet>
      ) : editing || !offer ? (
        <OfferForm current={offer} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="public-facts">
            <div>
              <dt>Topics</dt>
              <dd>{offer.topics.length ? offer.topics.join(", ") : "Any"}</dd>
            </div>
            <div>
              <dt>A session</dt>
              <dd>
                {plural(offer.turns, "question")}, {offer.slotMinutes} minutes
              </dd>
            </div>
            <div>
              <dt>A day</dt>
              <dd>Up to {plural(offer.perDay, "session")}</dd>
            </div>
          </dl>
          <p className="small muted">
            {offer.windows.map((w) => `${w.days.map((d) => DAYS[d]).join(", ")} ${w.from} to ${w.to}`).join("; ")} ({offer.timeZone}). Booked on your page under Book a
            session.
          </p>
          <div className="row">
            <button type="button" className="button button-small" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </>
      )}
      <Bookings />
    </section>
  );
}

function OfferForm({ current, onDone }: { current: SessionOffer | null; onDone(): void }) {
  const { api, update } = useVault();
  const base = current ?? { ...DEFAULT_OFFER, enabled: true, timeZone: localZone() };
  const [enabled, setEnabled] = useState(base.enabled);
  const [topics, setTopics] = useState(base.topics.join(", "));
  const [turns, setTurns] = useState(base.turns);
  const [slot, setSlot] = useState(base.slotMinutes);
  const [windows, setWindows] = useState<SessionWindow[]>(base.windows.length ? base.windows : DEFAULT_OFFER.windows);
  const [zone, setZone] = useState(base.timeZone);
  const [intake, setIntake] = useState(base.intake);
  const [rules, setRules] = useState(base.houseRules);
  const [perDay, setPerDay] = useState(base.perDay);
  const [consent, setConsent] = useState(base.consent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setWindow = (i: number, patch: Partial<SessionWindow>) => setWindows(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <form
      className="session-offer"
      aria-label="Sessions"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const offer = cleanOffer({ enabled, topics: splitList(topics), turns, slotMinutes: slot, windows, timeZone: zone, intake, houseRules: rules, perDay, consent });
          if (offer.enabled && offer.windows.length === 0) throw new Error("Give at least one time window, with days and an end after its start.");
          const saved = await sessions.saveOffer(api, offer);
          update((d) => ({ ...d, sessions: { ...d.sessions, offer: saved } }));
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="What it is" hint="Shown to visitors before they book.">
        <div className="field">
          <label className="field-label" htmlFor="sess-topics">
            Topics
          </label>
          <input id="sess-topics" className="input" value={topics} placeholder="Soil, vegetables, pruning" onChange={(e) => setTopics(e.target.value)} />
          <span className="field-hint">Separated by commas. Empty: any topic your public notes cover.</span>
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="sess-turns">
              Questions in a session
            </label>
            <input id="sess-turns" className="input" type="number" min={1} max={40} value={turns} onChange={(e) => setTurns(Number(e.target.value) || 1)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sess-slot">
              Length
            </label>
            <select id="sess-slot" className="select" value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
              {SESSION_SLOT_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sess-rules">
            House rules
          </label>
          <textarea id="sess-rules" className="textarea" rows={3} value={rules} maxLength={1200} placeholder="Not medical advice. See a doctor for anything that worries you." onChange={(e) => setRules(e.target.value)} />
          <span className="field-hint">Shown with every session, and given to your AI self as rules it keeps in every answer.</span>
        </div>
      </Band>
      <Band label="When" hint="In your time zone. A slot is booked once; the session opens five minutes before it starts.">
        {windows.map((w, i) => (
          <div key={i} className="session-window">
            <fieldset className="session-days">
              <legend className="visually-hidden">Days of window {i + 1}</legend>
              {DAYS.map((d, n) => (
                <label key={d} className="checkbox session-day" htmlFor={`sess-w${i}-d${n}`}>
                  <input
                    id={`sess-w${i}-d${n}`}
                    type="checkbox"
                    checked={w.days.includes(n)}
                    onChange={(e) => setWindow(i, { days: e.target.checked ? [...w.days, n].sort() : w.days.filter((x) => x !== n) })}
                  />
                  <span>{d}</span>
                </label>
              ))}
            </fieldset>
            <div className="rules-row">
              <input aria-label={`Window ${i + 1} from`} className="input" type="time" value={w.from} onChange={(e) => setWindow(i, { from: e.target.value })} />
              <input aria-label={`Window ${i + 1} to`} className="input" type="time" value={w.to} onChange={(e) => setWindow(i, { to: e.target.value })} />
              {windows.length > 1 ? (
                <button type="button" className="button button-small button-ghost" onClick={() => setWindows(windows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {windows.length < 7 ? (
          <button type="button" className="button button-small" onClick={() => setWindows([...windows, { days: [6], from: "10:00", to: "12:00" }])}>
            Add a window
          </button>
        ) : null}
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="sess-zone">
              Time zone
            </label>
            <input id="sess-zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="sess-day">
              Sessions a day at most
            </label>
            <input id="sess-day" className="input" type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Number(e.target.value) || 1)} />
          </div>
        </div>
      </Band>
      <Band label="Before booking" hint="Up to six questions. Answers are sealed in the visitor's browser for your device only.">
        {intake.map((q, i) => (
          <div key={i} className="rules-row rules-row-wide">
            <input aria-label={`Intake question ${i + 1}`} className="input" value={q.label} maxLength={200} onChange={(e) => setIntake(intake.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <label className="checkbox" htmlFor={`sess-req-${i}`}>
              <input id={`sess-req-${i}`} type="checkbox" checked={q.required} onChange={(e) => setIntake(intake.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
              <span>Required</span>
            </label>
            <button type="button" className="button button-small button-ghost" onClick={() => setIntake(intake.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        {intake.length < 6 ? (
          <button type="button" className="button button-small" onClick={() => setIntake([...intake, { id: `q${Date.now().toString(36)}`, label: "", required: false }])}>
            Add a question
          </button>
        ) : null}
        <div className="field">
          <label className="field-label" htmlFor="sess-consent">
            What a visitor agrees to
          </label>
          <textarea id="sess-consent" className="textarea" rows={3} value={consent} maxLength={800} onChange={(e) => setConsent(e.target.value)} />
        </div>
        <label className="checkbox" htmlFor="sess-on">
          <input id="sess-on" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Taking bookings</span>
        </label>
      </Band>
      <div className="form-actions plate-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving" : "Save sessions"}
        </button>
        {current ? (
          <button type="button" className="button button-ghost" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Bookings() {
  const { api, data, reload } = useVault();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = data.sessions.bookings;
  if (!data.publicSelf) return null;
  return (
    <div className="session-bookings">
      <h4 className="settings-heading">Booked</h4>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {list.length === 0 ? (
        <Quiet>No sessions booked yet.</Quiet>
      ) : (
        <ul className="list">
          {list.map((b) => (
            <li key={b.id} className="list-row" data-testid="booking" data-state={b.state}>
              <div className="list-row-main">
                <p className="list-row-title">
                  {b.intake?.name || "A visitor"}, {b.topic || "any topic"} <span className="badge">{b.state === "booked" ? (Date.parse(b.slotEnd) < now ? "Over" : "Booked") : b.state === "ended" ? "Ended" : "Blocked"}</span>
                </p>
                <p className="list-row-meta">
                  {formatDateTime(b.slotStart)}. {b.used} of {plural(b.turns, "question")} asked.
                </p>
                {open === b.id ? (
                  <div className="session-detail" data-testid="booking-detail">
                    {b.intake ? (
                      <dl className="ask-note-turns">
                        {b.intake.answers.map((a) => (
                          <div key={a.id}>
                            <dt>{a.label}</dt>
                            <dd>{a.answer || "No answer"}</dd>
                          </div>
                        ))}
                        <div>
                          <dt>Agreed to</dt>
                          <dd>
                            {b.intake.consent} <span className="faint">({b.intake.consentAt ? formatDateTime(b.intake.consentAt) : "time not given"})</span>
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="small log-unverified">What the visitor wrote could not be opened with your public AI self&apos;s key.</p>
                    )}
                    {b.transcript.length ? (
                      <ol className="chat" aria-label="Transcript">
                        {b.transcript.map((t) => (
                          <li key={t.turn} className="chat-turn" data-testid="transcript-turn">
                            <p className="chat-question">{t.question}</p>
                            <div className="chat-answer">
                              <p className="chat-by">
                                <span className="chat-by-name">{data.publicSelf?.name}</span>
                                <span className="chat-by-kind">AI</span>
                              </p>
                              <p>{t.answer}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <Quiet>Nothing asked yet.</Quiet>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="list-row-actions">
                <button type="button" className="button button-small" onClick={() => setOpen(open === b.id ? null : b.id)}>
                  {open === b.id ? "Close" : "Read it"}
                </button>
                {b.state === "booked" ? (
                  <>
                    <button
                      type="button"
                      className="button button-small button-ghost"
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy(b.id);
                        try {
                          await sessions.endSession(api, b.id, false);
                          await reload();
                        } catch (err) {
                          setError(errorText(err));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      End
                    </button>
                    <button
                      type="button"
                      className="button button-small button-danger"
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy(b.id);
                        try {
                          await sessions.endSession(api, b.id, true);
                          await reload();
                        } catch (err) {
                          setError(errorText(err));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Block
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
