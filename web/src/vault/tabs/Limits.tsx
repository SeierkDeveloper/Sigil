"use client";

import { useEffect, useState } from "react";
import { cleanLimits, KIND_LABEL, MESSAGE_KINDS, thresholdsSummary, type MessageKind, type PriceRange, type SelfLimits } from "@sigil/core";
import { AgentIcon, DownloadIcon, PlusIcon, ShieldIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as limitsOps from "../limitsOps";
import * as acting from "../actingOps";
import * as receipts from "../receiptOps";
import { errorText, useVault } from "../context";
import { Band, download, Empty, Notice, PlateHead, Quiet } from "../ui";
import { AppMark } from "../marks";

/** A checkbox with its label and, on its own line, a hint. */
function toggle(id: string, checked: boolean, onChange: (v: boolean) => void, label: string, hint: string) {
  return (
    <label className="checkbox suggest-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        <span className="field-hint">{hint}</span>
      </span>
    </label>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What the AI self may do on its own, and the receipts of what it did. Everything past a limit waits in Work. */
export function LimitsTab() {
  return (
    <div className="limits">
      <div className="panel-header">
        <h2 className="panel-title">Limits</h2>
        <p className="small muted">
          What your AI self may do on its own, without asking you first: pay, reply, answer invites and negotiate. Everything past a limit waits for you in Work, and anything
          on your never-touch list is refused. Each thing it does on its own gets a receipt, signed by its key and sealed with the hour, which you can keep private or share.
        </p>
      </div>
      <LimitsForm />
      <InboxForm />
      <RangesForm />
      <ActingApps />
      <ReceiptsSection />
    </div>
  );
}

function LimitsForm() {
  const { api, vault, data, update } = useVault();
  const [form, setForm] = useState<SelfLimits>(data.limits);
  const [contacts, setContacts] = useState(data.limits.replies.contacts.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const zone = form.meetings.timeZone === "UTC" && !data.limits.meetings.on ? limitsOps.browserTimeZone() : form.meetings.timeZone;

  const draft = (): SelfLimits => ({ ...form, replies: { ...form.replies, contacts: contacts.split(/[\n,]/) }, meetings: { ...form.meetings, timeZone: zone } });
  let problem: string | null = null;
  try {
    cleanLimits(draft());
  } catch (err) {
    problem = errorText(err);
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clean = await limitsOps.saveLimits(api, vault, { ...data.limits, ...draft(), mail: data.limits.mail, calendar: data.limits.calendar, neverTouch: data.limits.neverTouch, ranges: data.limits.ranges });
      await acting.refreshAppActing(api, vault, { ...data, limits: clean });
      update((d) => ({ ...d, limits: clean }));
      setForm(clean);
      setContacts(clean.replies.contacts.join("\n"));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const on = [form.payments.on, form.replies.on, form.meetings.on].filter(Boolean).length;

  return (
    <form className="subpanel plate limits-form" onSubmit={save} aria-label="Limits for acting">
      <PlateHead number="01" id="limits-title" title="On its own" lead="Kept encrypted in your vault, like every setting. Off, everything waits for you.">
        <span className="plate-state" data-on={on ? "true" : "false"}>
          {on ? `${on} of 3 on` : "All off"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">Limits saved.</Notice> : null}
      <Band label="Payments" hint="From the self's wallet, to the recipients in its wallet rules. The wallet on chain checks its own caps on every payment as well.">
        {toggle("limits-pay", form.payments.on, (v) => setForm({ ...form, payments: { ...form.payments, on: v } }), "Pay listed recipients on its own", "Up to the wallet's caps on chain, and the amount below if you set one.")}
        <div className="field">
          <label className="field-label" htmlFor="limits-pay-max">
            At most per payment, in the chain&apos;s coin
          </label>
          <input
            id="limits-pay-max"
            className="input"
            inputMode="decimal"
            value={form.payments.maxPerPayment}
            placeholder="Empty: up to the wallet's own cap"
            onChange={(e) => setForm({ ...form, payments: { ...form.payments, maxPerPayment: e.target.value } })}
          />
        </div>
      </Band>
      <Band label="Replies" hint="A reply you ask for in Work, to a contact you list here, is approved on its own and ready to send, not sent. To let your self send mail, see Inbox and calendar below.">
        {toggle("limits-reply", form.replies.on, (v) => setForm({ ...form, replies: { ...form.replies, on: v } }), "Approve replies to these contacts on its own", "Anyone else's reply waits for you.")}
        <div className="field">
          <label className="field-label" htmlFor="limits-contacts">
            Contacts
          </label>
          <textarea id="limits-contacts" className="textarea" rows={3} value={contacts} placeholder={"An email address or a name on each line"} onChange={(e) => setContacts(e.target.value)} />
        </div>
      </Band>
      <Band label="Meetings" hint="When your self agrees a time with another self under Meet, it accepts on its own only a time written plainly (like 2026-12-03 14:00) that falls in these hours. Any other agreement waits for you.">
        {toggle("limits-meet", form.meetings.on, (v) => setForm({ ...form, meetings: { ...form.meetings, on: v } }), "Accept meetings in my free hours on its own", `Times are read in ${zone}.`)}
        <fieldset className="limits-days">
          <legend className="field-label">Free days</legend>
          <div className="limits-day-row">
            {DAYS.map((d, i) => (
              <label key={d} className="limits-day" htmlFor={`limits-day-${i}`}>
                <input
                  id={`limits-day-${i}`}
                  type="checkbox"
                  aria-label={DAY_NAMES[i]}
                  checked={form.meetings.days.includes(i)}
                  onChange={(e) => setForm({ ...form, meetings: { ...form.meetings, days: e.target.checked ? [...form.meetings.days, i] : form.meetings.days.filter((x) => x !== i) } })}
                />
                <span>{d}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="limits-from">
              From
            </label>
            <input id="limits-from" className="input" type="time" value={form.meetings.from} onChange={(e) => setForm({ ...form, meetings: { ...form.meetings, from: e.target.value } })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="limits-to">
              To
            </label>
            <input id="limits-to" className="input" type="time" value={form.meetings.to} onChange={(e) => setForm({ ...form, meetings: { ...form.meetings, to: e.target.value } })} />
          </div>
        </div>
      </Band>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !!problem}>
          {busy ? "Saving" : "Save the limits"}
        </button>
      </div>
    </form>
  );
}

const KIND_WORD = { payment: "Payment", approval: "Approval", agreement: "Meeting", mail: "Mail", calendar: "Invite", negotiation: "Negotiation" } as const;

function ReceiptsSection() {
  const { api, vault, data } = useVault();
  const [list, setList] = useState<receipts.ReceiptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    receipts
      .loadReceipts(api, vault, data.box)
      .then((r) => alive && setList(r))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, vault, data.box]);
  const appName = (id: string | null) => (id ? (data.apps.find((a) => a.id === id)?.name ?? "a connected app") : null);

  return (
    <section className="subpanel plate limits-receipts" aria-labelledby="receipts-title">
      <PlateHead number="05" id="receipts-title" title="Receipts" lead="What your self did on its own, newest first. Only you can read them; share one and anyone can check it on the verify page.">
        <span className="plate-state" data-on={list?.length ? "true" : "false"}>
          {list ? plural(list.length, "receipt") : "Reading"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {list === null ? null : list.length === 0 ? (
        <Empty icon={<ShieldIcon />} title="No receipts yet">
          Turn a limit on above. Each time your self acts within it, a receipt appears here.
        </Empty>
      ) : (
        <ul className="list receipt-list">
          {list.map((r) => (
            <li key={r.id} className="list-row" data-testid="receipt">
              <div className="list-row-main">
                <p className="list-row-title">
                  {r.receipt ? r.receipt.body.what : "A receipt that could not be opened with your key"}{" "}
                  {r.receipt ? <span className="badge">{KIND_WORD[r.receipt.body.kind]}</span> : null}
                </p>
                <p className="list-row-meta">
                  {formatDateTime(r.createdAt)}
                  {r.receipt ? `. Under: ${r.receipt.body.limit}` : ""}.{r.appId ? ` Signed by ${appName(r.appId)} under your self key's word.` : ""} {r.shared?.seal ? `In the seal of the hour from ${formatDateTime(new Date(r.shared.seal.hour * (r.shared.seal.periodSeconds ?? 3600) * 1000).toISOString())}.` : "Sealed once its hour is over."}
                </p>
              </div>
              {r.shared ? (
                <div className="list-row-actions">
                  <button type="button" className="button button-small" onClick={() => download(`sigil-receipt-${r.id}.json`, receipts.receiptFile(r))}>
                    <DownloadIcon /> Download
                  </button>
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(receipts.receiptFile(r));
                        setCopied(r.id);
                      } catch {
                        setCopied(null);
                      }
                    }}
                  >
                    {copied === r.id ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Quiet>
        A receipt says what was done, when, and under which limit, signed by the self key, or by an app&apos;s own key that the self key vouched for. Its fingerprint, which says
        nothing on its own, is in the hourly seal.
      </Quiet>
    </section>
  );
}

/** Saves one part of the limits on top of the rest, and wraps them again for every app that acts. */
function useSaveLimits() {
  const { api, vault, data, update } = useVault();
  return async (patch: Partial<SelfLimits>): Promise<SelfLimits> => {
    const clean = await limitsOps.saveLimits(api, vault, cleanLimits({ ...data.limits, ...patch }));
    await acting.refreshAppActing(api, vault, { ...data, limits: clean });
    update((d) => ({ ...d, limits: clean }));
    return clean;
  };
}

const lines = (v: string) => v.split(/[\n,]/);

function InboxForm() {
  const { data } = useVault();
  const save = useSaveLimits();
  const [mail, setMail] = useState(data.limits.mail);
  const [cal, setCal] = useState(data.limits.calendar);
  const [senders, setSenders] = useState(data.limits.mail.senders.join("\n"));
  const [people, setPeople] = useState(data.limits.calendar.people.join("\n"));
  const [never, setNever] = useState(data.limits.neverTouch.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const patch = (): Partial<SelfLimits> => ({ mail: { ...mail, senders: lines(senders) }, calendar: { ...cal, people: lines(people) }, neverTouch: lines(never) });
  const on = [mail.on, cal.on].filter(Boolean).length;
  const m = data.limits.meetings;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clean = await save(patch());
      setMail(clean.mail);
      setCal(clean.calendar);
      setSenders(clean.mail.senders.join("\n"));
      setPeople(clean.calendar.people.join("\n"));
      setNever(clean.neverTouch.join("\n"));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const kindToggle = (k: MessageKind) => (
    <label key={k} className="limits-day limits-chip" htmlFor={`limits-kind-${k}`}>
      <input id={`limits-kind-${k}`} type="checkbox" checked={mail.kinds.includes(k)} onChange={(e) => setMail({ ...mail, kinds: e.target.checked ? [...mail.kinds, k] : mail.kinds.filter((x) => x !== k) })} />
      <span>{KIND_LABEL[k]}</span>
    </label>
  );
  const number = (id: string, label: string, value: number, onChange: (v: number) => void, min: number, max: number) => (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );

  return (
    <form className="subpanel plate limits-form limits-inbox" onSubmit={submit} aria-label="Inbox and calendar">
      <PlateHead number="02" id="inbox-title" title="Inbox and calendar" lead="What it may answer on its own, from whom, how much a day. The rest waits for you in Work.">
        <span className="plate-state" data-on={on ? "true" : "false"}>
          {on ? `${on} of 2 on` : "Both off"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">Thresholds saved.</Notice> : null}
      <Band
        label="Mail"
        hint="It reads what waits for an answer and replies on its own only to the senders you list, about the kinds you tick, up to the number a day. Through your Gmail under Sync, or through an AI app you allow below."
      >
        {toggle("limits-mail", mail.on, (v) => setMail({ ...mail, on: v }), "Answer mail on its own", "Off, every message waits for you.")}
        <div className="field">
          <label className="field-label" htmlFor="limits-senders">
            Senders
          </label>
          <textarea id="limits-senders" className="textarea" rows={3} value={senders} placeholder={"An address, a name, or @ and a domain for everyone there, one on each line"} onChange={(e) => setSenders(e.target.value)} />
        </div>
        <fieldset className="limits-days">
          <legend className="field-label">About</legend>
          <div className="limits-chip-row">{MESSAGE_KINDS.map(kindToggle)}</div>
        </fieldset>
        <div className="limits-number">{number("limits-mail-day", "At most a day", mail.perDay, (v) => setMail({ ...mail, perDay: v }), 0, 500)}</div>
        {toggle("limits-mail-start", mail.mayStart, (v) => setMail({ ...mail, mayStart: v }), "Also write first to the senders you list", "Off, it only replies.")}
      </Band>
      <Band
        label="Invites"
        hint={`It accepts an invite on its own only from the people you list, when the whole meeting fits your free hours above (${m.from} to ${m.to}, ${m.timeZone}) and nothing in your calendar overlaps it.`}
      >
        {toggle("limits-cal", cal.on, (v) => setCal({ ...cal, on: v }), "Answer invites on its own", "Off, every invite waits for you.")}
        <div className="field">
          <label className="field-label" htmlFor="limits-people">
            People
          </label>
          <textarea id="limits-people" className="textarea" rows={3} value={people} placeholder={"Whose invites: an address, a name, or @ and a domain, one on each line"} onChange={(e) => setPeople(e.target.value)} />
        </div>
        <div className="grid grid-2">
          {number("limits-cal-minutes", "Longest meeting, in minutes", cal.maxMinutes, (v) => setCal({ ...cal, maxMinutes: v }), 5, 1440)}
          {number("limits-cal-day", "At most a day", cal.perDay, (v) => setCal({ ...cal, perDay: v }), 0, 200)}
        </div>
        {toggle("limits-cal-decline", cal.mayDecline, (v) => setCal({ ...cal, mayDecline: v }), "Decline the ones that do not fit", "From the people you list. Off, those wait for you too.")}
      </Band>
      <Band label="Never touch" hint="Words, addresses or @domains. A message, invite or offer that names one is refused: your self does not act on it, and it shows under Work.">
        <div className="field">
          <label className="field-label" htmlFor="limits-never">
            Words, addresses and domains
          </label>
          <textarea id="limits-never" className="textarea" rows={3} value={never} placeholder={"For example: lawyer, salary, @bank.example"} onChange={(e) => setNever(e.target.value)} />
        </div>
      </Band>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving" : "Save the thresholds"}
        </button>
      </div>
    </form>
  );
}

const EMPTY_PRICE: PriceRange = { label: "", side: "selling", min: "", max: "", unit: "" };

function RangesForm() {
  const { data } = useVault();
  const save = useSaveLimits();
  const [ranges, setRanges] = useState(data.limits.ranges);
  const [allowed, setAllowed] = useState(data.limits.ranges.terms.allowed.join("\n"));
  const [forbidden, setForbidden] = useState(data.limits.ranges.terms.forbidden.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const setPrice = (i: number, p: Partial<PriceRange>) => setRanges({ ...ranges, prices: ranges.prices.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const draft = (): SelfLimits => ({ ...data.limits, ranges: { ...ranges, terms: { allowed: lines(allowed), forbidden: lines(forbidden) } } });
  let problem: string | null = null;
  try {
    cleanLimits(draft());
  } catch (err) {
    problem = errorText(err);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clean = await save({ ranges: draft().ranges });
      setRanges(clean.ranges);
      setAllowed(clean.ranges.terms.allowed.join("\n"));
      setForbidden(clean.ranges.terms.forbidden.join("\n"));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const t = ranges.times;

  return (
    <form className="subpanel plate limits-form limits-ranges" onSubmit={submit} aria-label="Ranges for negotiating">
      <PlateHead number="03" id="ranges-title" title="Ranges" lead="Times, prices and terms it may negotiate within. At the edge of a range, or past it, it stops and asks you.">
        <span className="plate-state" data-on={ranges.on ? "true" : "false"}>
          {ranges.on ? "On" : "Off"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">Ranges saved.</Notice> : null}
      <Band label="Negotiating" hint="It proposes and counters inside your ranges, in mail it answers, with apps you allow and when it meets another self. The numbers and times come from your ranges, never from a model.">
        {toggle("ranges-on", ranges.on, (v) => setRanges({ ...ranges, on: v }), "Negotiate within these ranges on its own", "Off, every offer waits for you.")}
        <div className="field limits-rounds">
          <label className="field-label" htmlFor="ranges-rounds">
            Counters before it asks you
          </label>
          <input id="ranges-rounds" className="input" type="number" inputMode="numeric" min={1} max={10} value={ranges.maxRounds} onChange={(e) => setRanges({ ...ranges, maxRounds: Number(e.target.value) })} />
        </div>
      </Band>
      <Band label="Times" hint="Inside your free hours above, never longer than the longest meeting under Invites, and clear of your calendar.">
        {toggle("ranges-times", t.on, (v) => setRanges({ ...ranges, times: { ...t, on: v } }), "Agree times on its own", "It offers the next time that fits when theirs does not.")}
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="ranges-notice">
              Hours of notice, at least
            </label>
            <input id="ranges-notice" className="input" type="number" inputMode="numeric" min={0} max={720} value={t.minNoticeHours} onChange={(e) => setRanges({ ...ranges, times: { ...t, minNoticeHours: Number(e.target.value) } })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ranges-ahead">
              Days ahead, at most
            </label>
            <input id="ranges-ahead" className="input" type="number" inputMode="numeric" min={1} max={365} value={t.maxDaysAhead} onChange={(e) => setRanges({ ...ranges, times: { ...t, maxDaysAhead: Number(e.target.value) } })} />
          </div>
        </div>
      </Band>
      <Band label="Prices" hint="Selling, it opens at the top and never goes below the bottom. Buying, it opens at the bottom and never goes above the top. Each counter moves halfway toward their offer.">
        {ranges.prices.length === 0 ? <p className="small faint limits-none">No price ranges yet. Every price waits for you.</p> : null}
        {ranges.prices.map((p, i) => (
          <fieldset key={i} className="price-range" aria-label={p.label || `Price range ${i + 1}`}>
            <div className="field price-range-name">
              <label className="field-label" htmlFor={`price-label-${i}`}>
                What it is for
              </label>
              <input id={`price-label-${i}`} className="input" value={p.label} maxLength={80} placeholder="For example: Consulting day" onChange={(e) => setPrice(i, { label: e.target.value })} />
            </div>
            <div className="price-range-grid">
              <div className="field">
                <label className="field-label" htmlFor={`price-side-${i}`}>
                  You are
                </label>
                <select id={`price-side-${i}`} className="select" value={p.side} onChange={(e) => setPrice(i, { side: e.target.value === "buying" ? "buying" : "selling" })}>
                  <option value="selling">Selling</option>
                  <option value="buying">Buying</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`price-min-${i}`}>
                  Lowest
                </label>
                <input id={`price-min-${i}`} className="input" inputMode="decimal" value={p.min} onChange={(e) => setPrice(i, { min: e.target.value })} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`price-max-${i}`}>
                  Highest
                </label>
                <input id={`price-max-${i}`} className="input" inputMode="decimal" value={p.max} onChange={(e) => setPrice(i, { max: e.target.value })} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`price-unit-${i}`}>
                  Currency
                </label>
                <input id={`price-unit-${i}`} className="input" value={p.unit} maxLength={12} placeholder="EUR" onChange={(e) => setPrice(i, { unit: e.target.value })} />
              </div>
            </div>
            <button type="button" className="button button-small button-ghost price-range-remove" onClick={() => setRanges({ ...ranges, prices: ranges.prices.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </fieldset>
        ))}
        {ranges.prices.length < 10 ? (
          <button type="button" className="button button-small" onClick={() => setRanges({ ...ranges, prices: [...ranges.prices, EMPTY_PRICE] })}>
            <PlusIcon /> Add a price range
          </button>
        ) : null}
      </Band>
      <Band label="Terms" hint="It agrees only to terms on the first list. A term on the second list, or on neither, stops it and asks you.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="ranges-allowed">
              It may agree to
            </label>
            <textarea id="ranges-allowed" className="textarea" rows={3} value={allowed} placeholder={"For example: net 30, remote work"} onChange={(e) => setAllowed(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ranges-forbidden">
              It never agrees to
            </label>
            <textarea id="ranges-forbidden" className="textarea" rows={3} value={forbidden} placeholder={"For example: exclusivity, non-compete"} onChange={(e) => setForbidden(e.target.value)} />
          </div>
        </div>
      </Band>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || !!problem}>
          {busy ? "Saving" : "Save the ranges"}
        </button>
      </div>
    </form>
  );
}

/** Apps that ask before they act: each gets the thresholds wrapped for its key only. */
function ActingApps() {
  const { api, vault, data, update } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apps = data.apps.filter((a) => !a.revokedAt);
  const set = async (id: string, on: boolean) => {
    const app = data.apps.find((a) => a.id === id);
    if (!app) return;
    setBusy(id);
    setError(null);
    try {
      await acting.setAppActing(api, vault, data, app, on);
      update((d) => ({ ...d, apps: d.apps.map((a) => (a.id === id ? { ...a, canAct: on } : a)) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const count = apps.filter((a) => a.canAct).length;
  return (
    <section className="subpanel plate limits-apps" aria-labelledby="acting-apps-title">
      <PlateHead
        number="04"
        id="acting-apps-title"
        title="Apps that ask first"
        lead="An AI app with its own mail or calendar access, such as Claude with Gmail, asks your self before it acts, through the connector. No Google client is needed on this site for this."
      >
        <span className="plate-state" data-on={count ? "true" : "false"}>
          {count ? plural(count, "app") : "None"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {apps.length === 0 ? (
        <Empty icon={<AgentIcon />} title="No apps connected">
          Connect an app under Apps first. Then let it ask here before it sends mail, answers an invite or makes an offer.
        </Empty>
      ) : (
        <ul className="list limits-app-list">
          {apps.map((a) => (
            <li key={a.id} className="list-row" data-on={a.canAct ? "true" : "false"} data-testid="acting-app">
              <AppMark kind={a.kind} />
              <div className="list-row-main">
                <p className="list-row-title">{a.name}</p>
                <p className="list-row-meta">
                  {a.canAct
                    ? "Asks before it acts: allowed within your thresholds, waits in Work past them, refused for anything you never touch. It signs a receipt for what it did."
                    : "Does not act for you."}
                </p>
              </div>
              <label className="checkbox suggest-toggle" htmlFor={`acting-app-${a.id}`}>
                <input id={`acting-app-${a.id}`} type="checkbox" checked={a.canAct} disabled={busy === a.id || !data.boxPublic} onChange={(e) => void set(a.id, e.target.checked)} />
                <span>May act within your limits</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <details className="limits-summary">
        <summary>What an app reads with get_thresholds</summary>
        <ul className="limits-summary-list">
          {thresholdsSummary(data.limits).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
