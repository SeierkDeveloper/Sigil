"use client";

// The public AI self at /@handle. Anyone may ask. The question is sealed in
// this browser with a key pair made for this visit and the public self's
// published key; the owner's open vault (or connector) opens it, answers only
// from what the owner made public, and seals the answer back. Every answer is
// marked as written by an AI, with the public notes it came from.

import { useCallback, useEffect, useMemo, useState } from "react";
import { newAskSession, openAskMessage, randomId, sealAskMessage, type AskSession, type PublicReply } from "@sigil/core";
import { createApi, ApiError } from "@/vault/api";
import { formatDate, plural } from "@/lib/format";
import { EditorIcon, EyeIcon, LockIcon, PublicIcon } from "@/components/icons";

interface PageInfo {
  id: string;
  handle: string;
  name: string;
  greeting: string;
  publicKey: string;
  enabled: boolean;
  online: boolean;
  perVisitorHour: number;
  showAnswers: boolean;
  items: { id: string; title: string; tags: string[]; editedAt: string }[];
  wall: { id: string; question: string; answer: string; sources: { id: string; title: string }[]; createdAt: string }[];
}

interface Item {
  id: string;
  title: string;
  body: string;
  editedAt: string;
}

type Phase = { kind: "loading" } | { kind: "missing" } | { kind: "open"; info: PageInfo; session: AskSession };

interface Turn {
  id: string;
  question: string;
  reply: PublicReply | null;
  status: "waiting" | "answered" | "failed";
  note?: string;
}

const POLL_MS = 1500;
const WAIT_MS = 120_000;

export function PublicApp({ handle }: { handle: string }) {
  const api = useMemo(() => createApi(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Item | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<PageInfo>(`public/at/${handle}`)
      .then((info) => alive && setPhase({ kind: "open", info, session: newAskSession(info.id, info.publicKey) }))
      .catch((err) => alive && setPhase(err instanceof ApiError && err.status === 404 ? { kind: "missing" } : { kind: "missing" }));
    return () => {
      alive = false;
    };
  }, [api, handle]);

  const refresh = useCallback(async () => {
    try {
      const info = await api.get<PageInfo>(`public/at/${handle}`);
      setPhase((p) => (p.kind === "open" && info.publicKey === p.info.publicKey ? { ...p, info } : p));
    } catch {
      // Keep what is shown.
    }
  }, [api, handle]);
  useEffect(() => {
    if (phase.kind !== "open") return;
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, [phase.kind, refresh]);

  const openSource = async (id: string) => {
    try {
      setSource(await api.get<Item>(`public/at/${handle}/items/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That source could not be opened.");
    }
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.kind !== "open" || !question.trim()) return;
    const { session, info } = phase;
    const text = question.trim();
    const id = randomId();
    const ids = { linkId: info.id, sessionId: session.id, messageId: id };
    const history = turns
      .filter((t) => t.reply && t.status === "answered")
      .slice(-4)
      .map((t) => ({ question: t.question, answer: t.reply!.text }));
    setBusy(true);
    setError(null);
    try {
      await api.post(`public/at/${handle}/questions`, { id, sessionId: session.id, askerKey: session.publicKey, sealed: sealAskMessage(session.key, ids, "q", { v: 1, text, history }) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The question could not be sent.");
      setBusy(false);
      void refresh();
      return;
    }
    setQuestion("");
    setTurns((t) => [...t, { id, question: text, reply: null, status: "waiting" }]);
    const started = Date.now();
    const finish = (patch: Partial<Turn>) => {
      setTurns((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      setBusy(false);
      void refresh();
    };
    const poll = async () => {
      try {
        const r = await api.get<{ status: "waiting" | "answered" | "gone"; answer?: string }>(`public/at/${handle}/questions/${id}`);
        if (r.status === "answered" && r.answer) {
          try {
            const reply = openAskMessage<PublicReply>(session.key, ids, "a", r.answer);
            finish({ status: "answered", reply: { v: 1, text: String(reply.text ?? ""), refused: reply.refused ?? null, sources: Array.isArray(reply.sources) ? reply.sources : [] } });
          } catch {
            finish({ status: "failed", note: "The answer could not be opened in this browser." });
          }
          return;
        }
        if (r.status === "gone" || Date.now() - started > WAIT_MS) {
          finish({ status: "failed", note: "No answer came. The owner's AI self may have gone offline." });
          return;
        }
      } catch {
        if (Date.now() - started > WAIT_MS) {
          finish({ status: "failed", note: "No answer came." });
          return;
        }
      }
      window.setTimeout(() => void poll(), POLL_MS);
    };
    window.setTimeout(() => void poll(), POLL_MS);
  };

  if (phase.kind === "loading") {
    return (
      <div className="container ask-page">
        <div className="loading" role="status">
          <span className="spinner" aria-hidden="true" /> Opening the page
        </div>
      </div>
    );
  }
  if (phase.kind === "missing") {
    return (
      <div className="container ask-page">
        <div className="vault-gate ask-card" data-state="broken">
          <span className="ask-seal" aria-hidden="true">
            <PublicIcon />
          </span>
          <h1 className="page-title">No public AI self here</h1>
          <p className="page-lead">There is no public AI self called @{handle}. Its owner may have turned it off for good.</p>
        </div>
      </div>
    );
  }

  const { info } = phase;
  const state = !info.enabled ? "revoked" : "active";
  return (
    <div className="container ask-page public-page">
      <div className="vault-gate ask-card public-card" data-state={state} data-online={info.online ? "true" : "false"}>
        <header className="ask-head">
          <span className="ask-seal" aria-hidden="true">
            <PublicIcon />
          </span>
          <p className="eyebrow">@{info.handle}, a public AI self</p>
          <h1 className="page-title">{info.name}</h1>
          {info.greeting ? <p className="page-lead">{info.greeting}</p> : null}
        </header>
        <p className="ask-status" data-online={info.online ? "true" : "false"} data-state={state} data-testid="public-status">
          <span className="ask-status-lamp" aria-hidden="true" />
          <span>
            {!info.enabled
              ? "The owner has turned their public AI self off."
              : info.online
                ? `Online. It answers from ${plural(info.items.length, "public note")}, up to ${plural(info.perVisitorHour, "question")} an hour for each visitor.`
                : "Offline right now: the owner's device is not answering (their vault is not open and their connector is not running). Questions can be asked once it is back."}
          </span>
        </p>

        {turns.length ? (
          <ol className="chat" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} className="chat-turn" data-testid="public-turn" data-status={t.status}>
                <p className="chat-question">{t.question}</p>
                <div className="chat-answer">
                  <p className="chat-by">
                    <span className="chat-by-name">{info.name}</span>
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
                              <button type="button" className="text-button" onClick={() => void openSource(s.id)}>
                                {s.title}
                              </button>
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

        {source ? (
          <article className="subpanel public-source" aria-label="Source" data-testid="public-source">
            <p className="eyebrow">Public note, {formatDate(source.editedAt)}</p>
            <h2 className="public-source-title">{source.title}</h2>
            <p className="public-source-body">{source.body}</p>
            <button type="button" className="button button-small button-ghost" onClick={() => setSource(null)}>
              Close
            </button>
          </article>
        ) : null}

        {error ? (
          <div className="notice notice-error" role="alert">
            <div>{error}</div>
          </div>
        ) : null}

        {info.enabled ? (
          <form className="chat-form" onSubmit={ask} aria-label="Ask a question">
            <label className="field-label" htmlFor="public-question">
              Your question
            </label>
            <textarea
              id="public-question"
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
              <button type="submit" className="button button-primary" disabled={busy || !question.trim() || !info.online}>
                {busy ? "Waiting" : "Ask"}
              </button>
            </div>
          </form>
        ) : null}

        {info.wall.length ? (
          <section className="public-wall" aria-labelledby="public-wall">
            <h2 id="public-wall" className="settings-heading">
              Asked before
            </h2>
            <ol className="chat">
              {info.wall.map((w) => (
                <li key={w.id} className="chat-turn" data-status="answered">
                  <p className="chat-question">{w.question}</p>
                  <div className="chat-answer">
                    <p className="chat-by">
                      <span className="chat-by-name">{info.name}</span>
                      <span className="chat-by-kind">AI</span>
                      <span className="faint"> {formatDate(w.createdAt)}</span>
                    </p>
                    <p>{w.answer}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <ul className="ask-fine">
          <li>
            <EditorIcon />
            <span>Every answer is written by an AI from notes the owner chose to make public, not by the person, and can be wrong.</span>
          </li>
          <li>
            <LockIcon />
            <span>Your question is encrypted in this browser for the owner&apos;s device; Sigil&apos;s server passes it on. The AI self can read nothing the owner kept private.</span>
          </li>
          <li>
            <EyeIcon />
            <span>
              The owner sees every question and answer.{info.showAnswers ? " Answered questions may be shown on this page, without anything about who asked." : ""}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
