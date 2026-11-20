"use client";

// Booking a session with someone's public AI self, on their page. The intake
// is sealed in this browser to the public self's key; the session link holds
// the only key to the session, after #, and is shown once here.

import { useEffect, useState } from "react";
import { formatDateTime, plural } from "@/lib/format";
import { CalendarIcon, LockIcon } from "@/components/icons";
import { CopyButton } from "@/vault/ui";
import { bookSession, loadOffer, type PublicOffer } from "@/vault/sessionOps";

export function SessionBooking({ handle, name }: { handle: string; name: string }) {
  const [offer, setOffer] = useState<PublicOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState("");
  const [topic, setTopic] = useState("");
  const [visitor, setVisitor] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ url: string; slotStart: string; slotEnd: string } | null>(null);

  useEffect(() => {
    let alive = true;
    loadOffer(handle)
      .then((o) => {
        if (!alive) return;
        setOffer(o);
        setSlot(o.slots[0]?.start ?? "");
        setTopic(o.offer?.topics[0] ?? "");
      })
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [handle]);

  if (!offer?.offer) return error ? <p className="small faint">{error}</p> : null;
  const o = offer.offer;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await bookSession(window.location.origin, offer, { slotStart: slot, topic, name: visitor, answers });
      setBooked(r);
    } catch (err) {
      setError((err as Error).message);
      void loadOffer(handle).then(setOffer).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="subpanel plate session-book" aria-labelledby="session-book" data-testid="session-book">
      <header className="plate-head">
        <span className="plate-number" aria-hidden="true">
          <CalendarIcon />
        </span>
        <div className="plate-heading">
          <h2 id="session-book" className="plate-title">
            Book a session
          </h2>
          <p className="plate-lead">
            A conversation of up to {plural(o.turns, "question")} in {o.slotMinutes} minutes with {name}, an AI that answers for {offer.handle ? `@${offer.handle}` : "the owner"} from what they made public. Free.
          </p>
        </div>
      </header>
      {o.houseRules ? (
        <div className="session-rules" data-testid="session-rules">
          <p className="eyebrow">House rules</p>
          <p>{o.houseRules}</p>
        </div>
      ) : null}
      {booked ? (
        <div className="notice notice-success session-booked" role="status" data-testid="session-booked">
          <div>
            <p>
              Booked for {formatDateTime(booked.slotStart)} to {formatDateTime(booked.slotEnd).split(", ").pop()}. Keep this link: it is the only way into your session, and
              it holds the key your questions are sealed with.
            </p>
            <p className="mono small session-link" data-testid="session-link">
              {booked.url}
            </p>
            <div className="row">
              <CopyButton text={booked.url} label="Copy the link" />
              <a className="button button-small button-primary" href={booked.url}>
                Open the session
              </a>
            </div>
          </div>
        </div>
      ) : offer.slots.length === 0 ? (
        <p className="quiet">No free times in the next two weeks. Look again later.</p>
      ) : (
        <form className="session-form" onSubmit={submit} aria-label="Book a session">
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label" htmlFor="session-slot">
                When
              </label>
              <select id="session-slot" className="select" value={slot} onChange={(e) => setSlot(e.target.value)}>
                {offer.slots.slice(0, 60).map((s) => (
                  <option key={s.start} value={s.start}>
                    {formatDateTime(s.start)}
                  </option>
                ))}
              </select>
            </div>
            {o.topics.length ? (
              <div className="field">
                <label className="field-label" htmlFor="session-topic">
                  Topic
                </label>
                <select id="session-topic" className="select" value={topic} onChange={(e) => setTopic(e.target.value)}>
                  {o.topics.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="session-name">
              Your name <span className="faint">(optional)</span>
            </label>
            <input id="session-name" className="input" value={visitor} maxLength={80} onChange={(e) => setVisitor(e.target.value)} />
          </div>
          {o.intake.map((q) => (
            <div className="field" key={q.id}>
              <label className="field-label" htmlFor={`session-q-${q.id}`}>
                {q.label} {q.required ? null : <span className="faint">(optional)</span>}
              </label>
              <textarea
                id={`session-q-${q.id}`}
                className="textarea"
                rows={2}
                maxLength={1500}
                required={q.required}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            </div>
          ))}
          <label className="checkbox session-consent" htmlFor="session-consent">
            <input id="session-consent" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{o.consent}</span>
          </label>
          {error ? (
            <div className="notice notice-error" role="alert">
              <div>{error}</div>
            </div>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy || !agreed || !slot}>
              {busy ? "Booking" : "Book the session"}
            </button>
            <span className="small faint">
              <LockIcon /> Your answers are sealed in this browser for the owner&apos;s device.
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
