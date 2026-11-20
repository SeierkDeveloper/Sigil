"use client";

// The page behind an "Ask my AI self" link. The link's key is in the part of
// the address after #, which browsers never send to a server. This page checks
// the key the server holds against it, opens the greeting, makes a key pair
// for this conversation, and seals every question for the owner's agent. The
// server only passes boxes along; the answer is opened here.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { newAskSession, openAskMessage, openIntro, parseAskFragment, randomId, sealAskMessage, type AskIntro, type AskReply, type AskSession } from "@sigil/core";
import { createApi, ApiError } from "@/vault/api";
import { formatDate, plural } from "@/lib/format";
import { EditorIcon, EyeIcon, LockIcon, SealIcon } from "@/components/icons";
import { VoiceControls } from "@/voice/VoiceControls";

interface LinkInfo {
  id: string;
  publicKey: string;
  intro: string;
  state: "active" | "expired" | "revoked" | "used_up";
  online: boolean;
  expiresAt: string;
  remaining: number;
  /** The owner offers voice with this link: speech to text in the asker's own browser. */
  voice?: boolean;
}

type Phase =
  | { kind: "loading" }
  | { kind: "broken"; message: string }
  | { kind: "open"; info: LinkInfo; intro: AskIntro; session: AskSession };

interface Turn {
  id: string;
  question: string;
  answer: string | null;
  status: "waiting" | "answered" | "failed";
  note?: string;
}

const INACTIVE: Record<Exclude<LinkInfo["state"], "active">, string> = {
  expired: "This link has expired.",
  revoked: "The owner turned this link off.",
  used_up: "This link has been used as many times as the owner allowed.",
};

const POLL_MS = 1500;
const WAIT_MS = 120_000;

const subscribe = () => () => undefined;

export function AskApp({ linkId }: { linkId: string }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const api = useMemo(() => createApi(), []);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hash === null) return;
    let alive = true;
    (async () => {
      let fragment: { publicKey: string; introKey: Uint8Array };
      try {
        fragment = parseAskFragment(hash);
      } catch (err) {
        if (alive) setPhase({ kind: "broken", message: (err as Error).message });
        return;
      }
      try {
        const info = await api.get<LinkInfo>(`ask/${linkId}`);
        // The key in the link is the one that counts; a server that handed out another could read nothing, so stop here.
        if (info.publicKey !== fragment.publicKey) {
          if (alive) setPhase({ kind: "broken", message: "This link does not match what the server holds, so nothing will be sent. Ask the owner for the link again." });
          return;
        }
        const intro = await openIntro(fragment.introKey, linkId, info.intro);
        if (alive) setPhase({ kind: "open", info, intro, session: newAskSession(linkId, info.publicKey) });
      } catch (err) {
        if (alive) setPhase({ kind: "broken", message: err instanceof ApiError && err.status === 404 ? "This link does not exist. It may have been deleted." : "This link could not be opened. Ask the owner for it again." });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, hash, linkId]);

  // Whether anyone is there to answer changes; look again now and then.
  const refresh = useCallback(async () => {
    try {
      const info = await api.get<LinkInfo>(`ask/${linkId}`);
      setPhase((p) => (p.kind === "open" && info.publicKey === p.info.publicKey ? { ...p, info } : p));
    } catch {
      // Keep what is shown.
    }
  }, [api, linkId]);
  useEffect(() => {
    if (phase.kind !== "open") return;
    const t = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(t);
  }, [phase.kind, refresh]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.kind !== "open" || !question.trim()) return;
    const { session } = phase;
    const text = question.trim();
    const id = randomId();
    const ids = { linkId, sessionId: session.id, messageId: id };
    const history = turns.filter((t) => t.answer && t.status === "answered").slice(-4).map((t) => ({ question: t.question, answer: t.answer! }));
    setBusy(true);
    setError(null);
    try {
      await api.post(`ask/${linkId}/questions`, { id, sessionId: session.id, askerKey: session.publicKey, sealed: sealAskMessage(session.key, ids, "q", { v: 1, text, history }) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The question could not be sent.");
      setBusy(false);
      void refresh();
      return;
    }
    setQuestion("");
    setTurns((t) => [...t, { id, question: text, answer: null, status: "waiting" }]);
    const started = Date.now();
    const finish = (patch: Partial<Turn>) => {
      setTurns((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      setBusy(false);
      void refresh();
    };
    const poll = async () => {
      try {
        const r = await api.get<{ status: "waiting" | "answered" | "gone"; answer?: string }>(`ask/${linkId}/questions/${id}`);
        if (r.status === "answered" && r.answer) {
          try {
            const reply = openAskMessage<AskReply>(session.key, ids, "a", r.answer);
            finish({ status: "answered", answer: String(reply.text ?? "") });
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
          <span className="spinner" aria-hidden="true" /> Opening the link
        </div>
      </div>
    );
  }
  if (phase.kind === "broken") {
    return (
      <div className="container ask-page">
        <div className="vault-gate ask-card" data-state="broken">
          <span className="ask-seal" aria-hidden="true">
            <SealIcon />
          </span>
          <h1 className="page-title">This link cannot be used</h1>
          <div className="notice notice-error" role="alert">
            <div>{phase.message}</div>
          </div>
        </div>
      </div>
    );
  }

  const { info, intro } = phase;
  const inactive = info.state !== "active" ? INACTIVE[info.state] : null;
  return (
    <div className="container ask-page">
      <div className="vault-gate ask-card" data-state={info.state} data-online={info.online ? "true" : "false"}>
        <header className="ask-head">
          <span className="ask-seal" aria-hidden="true">
            <SealIcon />
          </span>
          <p className="eyebrow">An AI self</p>
          <h1 className="page-title">{intro.name}</h1>
          {intro.greeting ? <p className="page-lead">{intro.greeting}</p> : null}
        </header>
        <p className="ask-status" data-online={info.online ? "true" : "false"} data-state={info.state} data-testid="ask-status">
          <span className="ask-status-lamp" aria-hidden="true" />
          <span>
            {inactive
              ? inactive
              : info.online
                ? `Online. ${plural(info.remaining, "question")} left on this link, until ${formatDate(info.expiresAt)}.`
                : "Offline right now: the owner's vault is not open and their connector is not running. Questions can be asked once it is back."}
          </span>
        </p>

        {turns.length ? (
          <ol className="chat" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} className="chat-turn" data-testid="ask-turn" data-status={t.status}>
                <p className="chat-question">{t.question}</p>
                <div className="chat-answer">
                  <p className="chat-by">
                    <span className="chat-by-name">{intro.name}</span>
                    <span className="chat-by-kind">AI</span>
                  </p>
                  {t.status === "waiting" ? (
                    <p className="faint chat-waiting">
                      <span className="spinner" aria-hidden="true" /> Waiting for the answer
                    </p>
                  ) : t.answer ? (
                    <p>{t.answer}</p>
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

        {!inactive && info.voice ? (
          <VoiceControls
            label="Ask link voice"
            onText={(text) => setQuestion(text)}
            answer={(() => {
              const last = [...turns].reverse().find((t) => t.status === "answered" && t.answer);
              return last ? { id: last.id, text: last.answer! } : null;
            })()}
          />
        ) : null}
        {!inactive ? (
          <form className="chat-form" onSubmit={ask} aria-label="Ask a question">
            <label className="field-label" htmlFor="ask-question">
              Your question
            </label>
            <textarea
              id="ask-question"
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

        <ul className="ask-fine">
          <li>
            <LockIcon />
            <span>Your questions are encrypted in this browser for this AI self, and the answers are opened here. Sigil&apos;s server passes them on without being able to read them.</span>
          </li>
          <li>
            <EyeIcon />
            <span>The owner sees your questions and the answers in their vault.</span>
          </li>
          <li>
            <EditorIcon />
            <span>Answers are written by an AI from the owner&apos;s notes, not by the person, and can be wrong.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
