"use client";

import { useMemo, useState } from "react";
import { agreementText, cleanWork, formatSlot, type PaymentChannel, type WorkSettings } from "@sigil/core";
import type { ChainConfig } from "../identityOps";
import { payApproved } from "../payOps";
import { connectWallet } from "../wallet";
import { AgreementIcon, CalendarIcon, DraftIcon, MailIcon, StyleIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as work from "../workOps";
import * as acting from "../actingOps";
import { modelCaller } from "../selfOps";
import { errorText, useVault } from "../context";
import { Band, Empty, Notice, PlateHead, Quiet } from "../ui";

const KIND_WORD = { reply: "Reply", plan: "Plan", answer: "Answer", payment: "Payment" } as const;

/** The owner's browser wallet, for a payment the owner approves; the chain from the site's settings. */
async function payFromWork(vault: Parameters<typeof payApproved>[0], channel: PaymentChannel, api: { get<T>(path: string): Promise<T> }) {
  const { chain } = await api.get<{ chain: ChainConfig | null }>("identity/config");
  if (!chain) throw new Error("This site has no registry on chain, so the payment cannot be sent.");
  return payApproved(vault, (await connectWallet()).provider, chain, channel);
}

/** The AI self at work: drafts in an approval queue, what it holds back, and what it learned from your edits. */
export function WorkTab() {
  const { data } = useVault();
  const waiting = data.drafts.filter((d) => d.state === "waiting");
  const decided = data.drafts.filter((d) => d.state !== "waiting");
  const asks = data.acts.filter((a) => a.state === "waiting");
  const steps = data.acts.filter((a) => a.state !== "waiting");
  return (
    <div className="work">
      <div className="panel-header">
        <h2 className="panel-title">Work</h2>
        <p className="small muted">
          Your AI self drafts replies, plans your week, answers people, runs your inbox and calendar and negotiates. Every draft and every step past your limits waits here
          for you, with the whole thread and what it would send next. Approving a reply or a plan copies it for you, and approving an answer sends it back the way the
          question came. Mail and invites go out only through your own Google account (connected under Sync) or the AI app that asked. When you change a draft before
          approving it, the change becomes a note under How I write, and later drafts follow it.
        </p>
      </div>
      {!data.model ? <Notice>With no model key under AI self, a reply is a plain start in your own greeting and sign-off, and a plan is a plain list of your week.</Notice> : null}
      <AskSection />
      <section className="subpanel plate work-queue" aria-labelledby="queue-title">
        <PlateHead number="02" id="queue-title" title="Waiting for you" lead="Read, change and approve, or discard.">
          <span className="plate-state" data-on={waiting.length + asks.length ? "true" : "false"}>
            {waiting.length + asks.length ? plural(waiting.length + asks.length, "item") : "Nothing waiting"}
          </span>
        </PlateHead>
        {waiting.length + asks.length === 0 ? (
          <Empty icon={<DraftIcon />} title="Nothing waiting">
            Ask for a reply or a plan above. Mail, invites and offers past your limits, and answers you hold for approval below, show up here.
          </Empty>
        ) : (
          <div className="draft-list">
            {asks.map((a) => (
              <ActCard key={a.id} view={a} />
            ))}
            {waiting.map((d) => (
              <DraftCard key={d.id} view={d} />
            ))}
          </div>
        )}
      </section>
      <HoldSection />
      <LessonsSection />
      {steps.length ? <StepsSection acts={steps} /> : null}
      {decided.length ? <DoneSection drafts={decided} /> : null}
    </div>
  );
}

const AREA_WORD = { mail: "Mail", calendar: "Invite", negotiation: "Negotiation" } as const;

/** Where a step comes from: the app that asked, by its name, or this vault in your own Google account. */
function byWhom(data: { apps: { id: string; name: string }[] }, appId: string | null, area?: string): string {
  if (appId) return data.apps.find((a) => a.id === appId)?.name ?? "A connected app";
  return area === "calendar" ? "Your Google Calendar, from this vault" : area === "mail" || area === "negotiation" ? "Your Gmail, from this vault" : "This vault";
}

/** A step with mail, an invite or an offer that went past a limit: the thread, why it waits, what it would send next. */
function ActCard({ view }: { view: acting.ActView }) {
  const { api, vault, data, update } = useVault();
  const r = view.request;
  const [text, setText] = useState(r?.next ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!r) return <Notice kind="error">A step could not be opened with your key.</Notice>;
  const editable = r.area !== "calendar";
  const decide = async (yes: boolean) => {
    setBusy(yes ? "approve" : "decline");
    setError(null);
    try {
      const out = yes ? await acting.approveAct(api, vault, data, view, text, { carryOut: acting.carryOutWith(api, vault, data) }) : await acting.declineAct(api, vault, data, view);
      update((d) => ({ ...d, acts: d.acts.map((x) => (x.id === view.id ? out : x)) }));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };
  const zone = data.limits.meetings.timeZone;
  const Icon = r.area === "calendar" ? CalendarIcon : r.area === "negotiation" ? AgreementIcon : MailIcon;
  const go = view.appId
    ? `Approving tells ${byWhom(data, view.appId)} it may go ahead${editable ? ", with your text" : ""}. It reports back, and a receipt is kept.`
    : r.area === "calendar"
      ? "Approving answers the invite from your own Google account, on this device, and keeps a receipt."
      : "Approving sends it from your own Gmail, on this device, and keeps a receipt.";
  return (
    <article className="draft-card act-card" data-kind={r.area} data-testid="act-card" aria-label={r.subject || AREA_WORD[r.area]}>
      <header className="draft-head">
        <span className="badge">{AREA_WORD[r.area]}</span>
        <p className="draft-title">
          <Icon /> {r.subject || "No subject"}
        </p>
        <span className="faint small">{formatDateTime(view.createdAt)}</span>
      </header>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <dl className="identity-facts act-facts">
        <div>
          <dt>With</dt>
          <dd>{r.who || "Unknown"}</dd>
        </div>
        <div>
          <dt>Through</dt>
          <dd>{byWhom(data, view.appId, r.area)}</dd>
        </div>
        {r.when ? (
          <div>
            <dt>When</dt>
            <dd>
              {formatSlot(new Date(r.when.start), zone)}, {r.when.minutes} minutes
            </dd>
          </div>
        ) : null}
        {r.offer?.price ? (
          <div>
            <dt>{r.action === "agree" ? "It would agree to" : "It would offer"}</dt>
            <dd>
              {r.offer.price} {r.offer.unit}
              {r.offer.range ? `, ${r.offer.range}` : ""}
            </dd>
          </div>
        ) : null}
        <div className="act-why">
          <dt>Why it waits</dt>
          <dd>{r.reason}</dd>
        </div>
      </dl>
      {r.thread.length ? (
        <details className="draft-input">
          <summary>The thread, {plural(r.thread.length, "message")}</summary>
          <ol className="act-thread">
            {r.thread.map((t, i) => (
              <li key={i}>
                <p className="act-thread-from">{t.from}</p>
                <p className="draft-input-text">{t.text}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {editable ? (
        <div className="field">
          <label className="field-label" htmlFor={`act-${view.id}`}>
            What it would send next
          </label>
          <textarea id={`act-${view.id}`} className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      ) : (
        <p className="small act-next">
          It would <strong>{r.action === "decline" ? "decline" : "accept"}</strong> the invite.
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!!busy || (editable && !text.trim())} onClick={() => void decide(true)}>
          {busy === "approve" ? "Approving" : r.area === "calendar" ? (r.action === "decline" ? "Approve and decline" : "Approve and accept") : "Approve and send"}
        </button>
        <button type="button" className="button button-ghost" disabled={!!busy} onClick={() => void decide(false)}>
          Decline
        </button>
      </div>
      <p className="small faint">{go}</p>
    </article>
  );
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const STEP_WORD: Record<acting.ActState, string> = { allowed: "Allowed", waiting: "Waiting", approved: "Approved", declined: "Declined", refused: "Refused", done: "Done" };

/** Steps the self took alone, the ones you answered, and the ones it refused. */
function StepsSection({ acts }: { acts: acting.ActView[] }) {
  const { api, data, update, goTo } = useVault();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="subpanel plate work-steps" aria-labelledby="steps-title">
      <PlateHead number="05" id="steps-title" title="Mail, invites and offers" lead="What your self did on its own, what you answered, and what it refused. Each step it carried out has a receipt under Limits.">
        <span className="plate-state" data-on="true">
          {plural(acts.length, "step")}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="list">
        {acts.slice(0, 50).map((a) => {
          const r = a.request;
          // An agreed price, time or terms: taken alone, or agreed with the owner's yes.
          const agreed = r?.area === "negotiation" && !!r.offer && r.action === "agree" && (a.state === "done" || a.state === "approved");
          return (
            <li key={a.id} className="list-row" data-state={a.state} data-testid="act-done">
              <div className="list-row-main">
                <p className="list-row-title">
                  {r ? `${AREA_WORD[r.area]}: ${r.subject || r.who}` : "A step that could not be opened"} <span className="badge">{a.alone && a.state === "done" ? "Done on its own" : STEP_WORD[a.state]}</span>
                </p>
                <p className="list-row-meta">
                  {formatDateTime(a.updatedAt)}. {byWhom(data, a.appId, r?.area)}
                  {r?.who ? `, with ${r.who}` : ""}. {r ? sentence(a.state === "refused" ? `Refused: ${r.reason}` : a.alone ? `Under: ${r.reason}` : r.reason) : ""}
                  {a.receiptId ? " Its receipt is under Limits." : ""}
                </p>
              </div>
              <div className="list-row-actions">
                {agreed && r?.offer ? (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => {
                      acting.handAgreement(agreementText({ topic: r.offer?.range || r.subject || "Our agreement", who: r.who, me: data.self?.name ?? "", offer: r.offer!, timeZone: data.limits.meetings.timeZone }));
                      goTo("agreements");
                    }}
                  >
                    <AgreementIcon /> Seal as an agreement
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button-small button-ghost"
                  onClick={async () => {
                    try {
                      await acting.removeAct(api, a.id);
                      update((x) => ({ ...x, acts: x.acts.filter((y) => y.id !== a.id) }));
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AskSection() {
  const { api, vault, data, update, semantic } = useVault();
  const [mode, setMode] = useState<"reply" | "plan">("reply");
  const [threadId, setThreadId] = useState("");
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState("");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = useMemo(() => work.mailThreads(data).slice(0, 50), [data]);
  const calendar = data.memories.filter((m) => m.source.kind === "calendar").length;

  const pickThread = (id: string) => {
    setThreadId(id);
    const t = threads.find((x) => x.id === id);
    if (!t) return;
    const last = work.lastMessage(t);
    setMessage(last.message);
    setFrom(last.from);
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const deps = { model: modelCaller(data), embedQuery: semantic.embedQuery, vectors: semantic.vectors };
      const d = mode === "reply" ? await work.draftReply(api, vault, data, { message, from, threadId: threadId || null }, deps) : await work.draftPlan(api, vault, data, focus, deps);
      update((x) => ({ ...x, drafts: [d, ...x.drafts] }));
      setMessage("");
      setFrom("");
      setThreadId("");
      setFocus("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel plate work-ask" onSubmit={run} aria-label="Ask for a draft">
      <PlateHead number="01" title="Ask for a draft" lead={data.model ? "Written by your own model on this device, from the folders your AI self may use." : "Written on this device without a model."} />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="segmented" role="group" aria-label="What to draft">
        <button type="button" aria-pressed={mode === "reply"} onClick={() => setMode("reply")}>
          A reply
        </button>
        <button type="button" aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>
          Plan my week
        </button>
      </div>
      {mode === "reply" ? (
        <>
          {threads.length ? (
            <div className="field">
              <label className="field-label" htmlFor="work-thread">
                A mail thread
              </label>
              <select id="work-thread" className="select" value={threadId} onChange={(e) => pickThread(e.target.value)}>
                <option value="">None, I paste the message</option>
                {threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label className="field-label" htmlFor="work-message">
              The message
            </label>
            <textarea id="work-message" className="textarea" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Paste the message you want to answer" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="work-from">
              From
            </label>
            <input id="work-from" className="input" value={from} maxLength={120} onChange={(e) => setFrom(e.target.value)} placeholder="Their name" />
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            From {plural(calendar, "calendar memory", "calendar memories")} in your vault (imported or synced), for the next seven days, with your free time between nine and five.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="work-focus">
              What you want to get done
            </label>
            <input id="work-focus" className="input" value={focus} maxLength={400} onChange={(e) => setFocus(e.target.value)} placeholder="Optional, for example finish the report" />
          </div>
        </>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || (mode === "reply" && !message.trim())}>
          <DraftIcon /> {busy ? "Drafting" : mode === "reply" ? "Draft a reply" : "Plan my week"}
        </button>
      </div>
    </form>
  );
}

function DraftCard({ view }: { view: work.DraftView }) {
  const { api, vault, data, update } = useVault();
  const r = view.record;
  const [text, setText] = useState(r?.draft ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!r) return <Notice kind="error">A draft could not be opened with your key.</Notice>;
  const edited = text.trim() !== r.draft.trim();

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      const out = await work.approve(api, vault, data, view, text, { model: modelCaller(data), settings: data.work, pay: (ch) => payFromWork(vault, ch, api) });
      if (r.kind === "reply" || r.kind === "plan") {
        try {
          await navigator.clipboard.writeText(text.trim());
        } catch {
          // The text stays in the list below to copy by hand.
        }
      }
      update((d) => ({
        ...d,
        drafts: d.drafts.map((x) => (x.id === view.id ? out.draft : x)),
        folders: out.createdFolder && out.folder ? [...d.folders, out.folder] : d.folders,
        memories: out.lesson ? [out.lesson, ...d.memories] : d.memories,
      }));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy("discard");
    setError(null);
    try {
      const out = await work.discard(api, vault, view);
      update((d) => ({ ...d, drafts: d.drafts.map((x) => (x.id === view.id ? out : x)) }));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const where =
    r.channel?.kind === "link" ? "the ask link it came from" : r.channel?.kind === "public" ? "your public page" : r.channel?.kind === "meet" ? "the conversation with the other self" : null;
  if (r.kind === "payment") return <PaymentCard view={view} busy={busy} error={error} onApprove={approve} onDiscard={discard} />;

  return (
    <article className="draft-card" data-kind={r.kind} data-testid="draft-card" aria-label={r.title}>
      <header className="draft-head">
        <span className="badge">{KIND_WORD[r.kind]}</span>
        <p className="draft-title">{r.title}</p>
        <span className="faint small">{formatDateTime(view.createdAt)}</span>
      </header>
      {r.input ? (
        <details className="draft-input">
          <summary>{r.kind === "plan" ? "What you asked for" : r.kind === "answer" ? "The question" : "The message"}</summary>
          <p className="draft-input-text">{r.input}</p>
        </details>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="field">
        <label className="field-label" htmlFor={`draft-${view.id}`}>
          Draft
        </label>
        <textarea id={`draft-${view.id}`} className="textarea" rows={r.kind === "plan" ? 12 : 7} value={text} onChange={(e) => setText(e.target.value)} />
        <span className="field-hint">
          {r.usedModel ? "Written by your model." : "Written without a model."}
          {r.sources.length ? ` From ${r.sources.map((s) => s.title).join(", ")}.` : ""}
          {edited && data.work.learn ? " Your change will be noted under How I write." : ""}
        </span>
      </div>
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!!busy || !text.trim()} onClick={() => void approve()}>
          {busy === "approve" ? (where ? "Sending" : "Approving") : where ? "Approve and send" : "Approve and copy"}
        </button>
        <button type="button" className="button button-ghost" disabled={!!busy} onClick={() => void discard()}>
          Discard
        </button>
      </div>
      {where ? <p className="small faint">Approving sends it to {where}, and only there.</p> : null}
    </article>
  );
}

/** A payment past the owner's limits: what the self would pay, and why it waits. Approving signs it with the self key and sends it from the owner's wallet. */
function PaymentCard({ view, busy, error, onApprove, onDiscard }: { view: work.DraftView; busy: string | null; error: string | null; onApprove: () => void; onDiscard: () => void }) {
  const r = view.record!;
  const ch = r.channel?.kind === "payment" ? r.channel : null;
  return (
    <article className="draft-card" data-kind="payment" data-testid="draft-card" aria-label={r.title}>
      <header className="draft-head">
        <span className="badge">{KIND_WORD.payment}</span>
        <p className="draft-title">{r.title}</p>
        <span className="faint small">{formatDateTime(view.createdAt)}</span>
      </header>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ch ? (
        <dl className="identity-facts draft-payment">
          <div>
            <dt>To</dt>
            <dd className="mono">{ch.to}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              {ch.amount} {ch.token ?? ""}
            </dd>
          </div>
          <div>
            <dt>From</dt>
            <dd className="mono">{ch.wallet}</dd>
          </div>
          <div>
            <dt>Why it waits</dt>
            <dd>{r.input}</dd>
          </div>
        </dl>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!!busy || !ch} onClick={onApprove}>
          {busy === "approve" ? "Paying" : "Approve and pay"}
        </button>
        <button type="button" className="button button-ghost" disabled={!!busy} onClick={onDiscard}>
          Discard
        </button>
      </div>
      <p className="small faint">Approving signs it with the self key and sends it from your own wallet. The wallet on chain still checks its rules and caps.</p>
    </article>
  );
}

function HoldSection() {
  const { api, vault, data, update } = useVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (patch: Partial<WorkSettings>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work.saveWork(api, vault, cleanWork({ ...data.work, ...patch }));
      update((d) => ({ ...d, work: next }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const box = (id: string, key: keyof WorkSettings, label: string, hint?: string, disabled = false) => (
    <label className="checkbox suggest-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={data.work[key]} disabled={busy || disabled} onChange={(e) => void set({ [key]: e.target.checked })} />
      <span>
        {label}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
  return (
    <section className="subpanel plate work-hold" aria-labelledby="hold-title">
      <PlateHead number="03" id="hold-title" title="Hold for approval" lead="Where your AI self answers people while this vault is open, it can draft the answer here instead of sending it." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="Answers" hint="Held answers wait here; the person asking waits too.">
        {box("hold-links", "holdLinks", "Hold answers to my ask links", "Links this vault answers. A link an app answers through the connector is not held.")}
        {box("hold-public", "holdPublic", "Hold answers on my public page")}
        {box("hold-meets", "holdMeets", "Hold my self's turns when it meets another self")}
      </Band>
      <Band label="Learning" hint="Notes go into the How I write folder, which you can read, change or delete.">
        {box("work-learn", "learn", "Learn from my edits")}
        {box("work-learn-model", "learnWithModel", "Let my model write the notes", data.model ? "It is told to describe style only, not what the text says. Off: a plain summary of the change." : "Add a model key under AI self first. Without it, notes are a plain summary of the change.", !data.model)}
      </Band>
    </section>
  );
}

function LessonsSection() {
  const { data } = useVault();
  const notes = work.lessons(data);
  return (
    <section className="subpanel plate work-lessons" aria-labelledby="lessons-title">
      <PlateHead number="04" id="lessons-title" title="How I write" lead="What your AI self learned from your edits. Later drafts follow these notes.">
        <span className="plate-state" data-on={notes.length ? "true" : "false"}>
          {plural(notes.length, "note")}
        </span>
      </PlateHead>
      {notes.length === 0 ? (
        <Quiet>Nothing learned yet. Change a draft before you approve it, and the change is noted here.</Quiet>
      ) : (
        <ul className="list lesson-list">
          {notes.map((m) => (
            <Lesson key={`${m.id}-${m.editedAt}`} id={m.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Lesson({ id }: { id: string }) {
  const { api, data, update } = useVault();
  const memory = data.memories.find((m) => m.id === id)!;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="list-row lesson" data-testid="lesson">
      <div className="list-row-main">
        <p className="list-row-title">
          <StyleIcon /> {memory.title}
        </p>
        {error ? <Notice kind="error">{error}</Notice> : null}
        {editing ? (
          <div className="field">
            <label className="field-label" htmlFor={`lesson-${id}`}>
              Note
            </label>
            <textarea id={`lesson-${id}`} className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        ) : (
          <p className="lesson-body">{memory.body}</p>
        )}
      </div>
      <div className="list-row-actions">
        {editing ? (
          <button
            type="button"
            className="button button-small"
            disabled={busy || !text.trim()}
            onClick={() =>
              void act(async () => {
                const m = await work.editLesson(api, data, memory, text);
                update((d) => ({ ...d, memories: d.memories.map((x) => (x.id === m.id ? m : x)) }));
                setEditing(false);
              })
            }
          >
            Save
          </button>
        ) : (
          <button type="button" className="button button-small" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
        <button
          type="button"
          className="button button-small button-ghost"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await work.deleteLesson(api, memory);
              update((d) => ({ ...d, memories: d.memories.filter((x) => x.id !== id) }));
            })
          }
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function DoneSection({ drafts }: { drafts: work.DraftView[] }) {
  const { api, data, update } = useVault();
  const stepsShown = data.acts.some((a) => a.state !== "waiting");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="subpanel plate work-done" aria-labelledby="done-title">
      <PlateHead number={stepsShown ? "06" : "05"} id="done-title" title="Decided" lead="Approved and discarded drafts, kept until you remove them." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ul className="list">
        {drafts.slice(0, 50).map((d) => (
          <li key={d.id} className="list-row" data-state={d.state} data-testid="draft-done">
            <div className="list-row-main">
              <p className="list-row-title">
                {d.record?.title ?? "A draft"} <span className="badge">{d.state === "approved" ? "Approved" : "Discarded"}</span>
              </p>
              <p className="list-row-meta">
                {formatDateTime(d.updatedAt)}
                {d.record?.learned ? ". Your edit was noted under How I write." : ""}
                {d.record?.auto ? `. ${d.record.auto.limit === "Approved by you in Work" ? "Signed by the self key once you approved it" : `Approved on its own, under: ${d.record.auto.limit}`}. Its receipt is under Limits.` : ""}
              </p>
              {d.state === "approved" && d.record?.final ? <p className="draft-final">{d.record.final}</p> : null}
            </div>
            <div className="list-row-actions">
              <button
                type="button"
                className="button button-small button-ghost"
                onClick={async () => {
                  try {
                    await work.removeDraft(api, d.id);
                    update((x) => ({ ...x, drafts: x.drafts.filter((y) => y.id !== d.id) }));
                  } catch (err) {
                    setError(errorText(err));
                  }
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
