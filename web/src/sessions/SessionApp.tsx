"use client";

// A booked session at /s/<id>#<secret>. The secret after # is never sent: from
// it this browser makes the bearer for the session and the key pair its
// questions are sealed with, so the link alone opens the session, on any
// device. The owner's open vault (or connector) answers within the session's
// time, its number of questions and its house rules; every answer is an AI's.

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatDateTime, plural } from "@/lib/format";
import { CalendarIcon, EditorIcon, EyeIcon, LockIcon } from "@/components/icons";
import { VoiceControls } from "@/voice/VoiceControls";
import { SessionClient, type SessionStatus } from "@/vault/sessionOps";
import type { PublicReply } from "@sigil/core";

interface Turn {
  id: string;
  question: string;
  reply: PublicReply | null;
  status: "waiting" | "answered" | "failed";
  note?: string;
}

const POLL_MS = 1500;
const WAIT_MS = 120_000;
const subscribe = () => () => undefined;

type Phase = { kind: "loading" } | { kind: "broken"; message: string } | { kind: "open"; client: SessionClient; status: SessionStatus };

export function SessionApp({ bookingId }: { bookingId: string }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secret = hash === null ? null : hash.replace(/^#/, "");
  const complete = secret !== null && /^[A-Za-z0-9_-]{43}$/.test(secret);

  useEffect(() => {
    if (!complete || secret === null) return;
    let alive = true;
    SessionClient.open(bookingId, secret)
      .then(({ client, status }) => alive && setPhase({ kind: "open", client, status }))
      .catch((err) => alive && setPhase({ kind: "broken", message: (err as Error).message }));
    return () => {
      alive = false;
    };
  }, [secret, complete, bookingId]);

  // The session's state (online, questions left, ended) changes; look again now and then.
  useEffect(() => {
    if (phase.kind !== "open") return;
    const t = window.setInterval(() => {
      phase.client
        .status()
        .then((status) => setPhase((p) => (p.kind === "open" ? { ...p, status } : p)))
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(t);
  }, [phase]);

  if (secret !== null && !complete) {
    return (
      <div className="container ask-page">
        <div className="vault-gate ask-card" data-state="broken">
          <span className="ask-seal" aria-hidden="true">
            <CalendarIcon />
          </span>
          <h1 className="page-title">This session cannot be opened</h1>
          <p className="page-lead">This session link is not complete. Open it again from where you saved it.</p>
        </div>
      </div>
    );
  }
  if (phase.kind === "loading") {
    return (
      <div className="container ask-page">
        <div className="loading" role="status">
          <span className="spinner" aria-hidden="true" /> Opening the session
        </div>
      </div>
    );
  }
  if (phase.kind === "broken") {
    return (
      <div className="container ask-page">
        <div className="vault-gate ask-card" data-state="broken">
          <span className="ask-seal" aria-hidden="true">
            <CalendarIcon />
          </span>
          <h1 className="page-title">This session cannot be opened</h1>
          <p className="page-lead">{phase.message}</p>
        </div>
      </div>
    );
  }

  const { client, status } = phase;
  const left = Math.max(0, status.turns - status.used - turns.filter((t) => t.status === "waiting").length);
  const closed = status.state !== "booked";

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const history = turns.filter((t) => t.reply && t.status === "answered").map((t) => ({ question: t.question, answer: t.reply!.text }));
    let id: string;
    try {
      id = await client.ask(status, text, history);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }
    setQuestion("");
    setTurns((t) => [...t, { id, question: text, reply: null, status: "waiting" }]);
    const started = Date.now();
    const finish = (patch: Partial<Turn>) => {
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      setBusy(false);
      void client.status().then((s) => setPhase((p) => (p.kind === "open" ? { ...p, status: s } : p))).catch(() => undefined);
    };
    const poll = async () => {
      try {
        const r = await client.poll(status, id);
        if (r.status === "answered") return finish({ status: "answered", reply: r.reply });
        if (r.status === "gone" || Date.now() - started > WAIT_MS) return finish({ status: "failed", note: "No answer came. The host's AI self may have gone offline." });
      } catch {
        if (Date.now() - started > WAIT_MS) return finish({ status: "failed", note: "No answer came." });
      }
      window.setTimeout(() => void poll(), POLL_MS);
    };
    window.setTimeout(() => void poll(), POLL_MS);
  };

  return (
    <div className="container ask-page session-page">
      <div className="vault-gate ask-card session-card" data-state={closed ? "revoked" : "active"} data-online={status.online ? "true" : "false"}>
        <header className="ask-head">
          <span className="ask-seal" aria-hidden="true">
            <CalendarIcon />
          </span>
          <p className="eyebrow">A session with @{status.handle}, an AI self</p>
          <h1 className="page-title">{status.name}</h1>
          <p className="page-lead">
            {status.topic ? `${status.topic}. ` : ""}
            {formatDateTime(status.slotStart)} to {formatDateTime(status.slotEnd).split(", ").pop()}.
          </p>
        </header>
        <p className="ask-status" data-online={status.online ? "true" : "false"} data-state={closed ? "revoked" : "active"} data-testid="session-status">
          <span className="ask-status-lamp" aria-hidden="true" />
          <span>
            {status.problem ?? (status.online ? `Open. ${plural(left, "question")} left in this session.` : "The host's AI self is not answering right now. Try again in a moment.")}
          </span>
        </p>
        {status.houseRules ? (
          <div className="session-rules" data-testid="session-rules">
            <p className="eyebrow">House rules</p>
            <p>{status.houseRules}</p>
          </div>
        ) : null}

        {turns.length ? (
          <ol className="chat" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} className="chat-turn" data-testid="session-turn" data-status={t.status}>
                <p className="chat-question">{t.question}</p>
                <div className="chat-answer">
                  <p className="chat-by">
                    <span className="chat-by-name">{status.name}</span>
                    <span className="chat-by-kind">AI</span>
                  </p>
                  {t.status === "waiting" ? (
                    <p className="faint chat-waiting">
                      <span className="spinner" aria-hidden="true" /> Waiting for the answer
                    </p>
                  ) : t.reply ? (
                    <>
                      <p>{t.reply.text}</p>
                      {t.reply.sources.length ? (
                        <p className="chat-sources">
                          <span className="chat-sources-label">From</span>
                          {t.reply.sources.map((s) => (
                            <span key={s.id} className="chat-source">
                              {s.title}
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="faint">{t.note}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : null}

        {error ? (
          <div className="notice notice-error" role="alert">
            <div>{error}</div>
          </div>
        ) : null}

        {!closed && status.voice ? (
          <VoiceControls
            label="Session voice"
            onText={(text) => setQuestion(text)}
            answer={(() => {
              const last = [...turns].reverse().find((t) => t.status === "answered" && t.reply);
              return last ? { id: last.id, text: last.reply!.text } : null;
            })()}
          />
        ) : null}
        {!closed ? (
          <form className="chat-form" onSubmit={ask} aria-label="Ask a question">
            <label className="field-label" htmlFor="session-question">
              Your question
            </label>
            <textarea
              id="session-question"
              className="textarea"
              rows={3}
              maxLength={2000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="form-actions">
              <span className="chat-keys" aria-hidden="true">
                Enter to ask, Shift and Enter for a new line
              </span>
              <button type="submit" className="button button-primary" disabled={busy || !question.trim() || !status.online || !!status.problem || left === 0}>
                {busy ? "Waiting" : "Ask"}
              </button>
            </div>
          </form>
        ) : null}

        <ul className="ask-fine">
          <li>
            <EditorIcon />
            <span>Every answer is written by an AI from what the host made public, not by the host, and can be wrong.</span>
          </li>
          <li>
            <LockIcon />
            <span>Your questions are encrypted in this browser with a key from this link; Sigil&apos;s server passes them on without being able to read them.</span>
          </li>
          <li>
            <EyeIcon />
            <span>The host reads this conversation and what you wrote when booking, as you agreed.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
