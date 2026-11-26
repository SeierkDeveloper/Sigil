"use client";

import { useEffect, useState } from "react";
import { cleanLimits, type SelfLimits } from "@sigil/core";
import { DownloadIcon, ShieldIcon } from "@/components/icons";
import { formatDateTime, plural } from "@/lib/format";
import * as limitsOps from "../limitsOps";
import * as receipts from "../receiptOps";
import { errorText, useVault } from "../context";
import { Band, download, Empty, Notice, PlateHead, Quiet } from "../ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What the AI self may do on its own, and the receipts of what it did. Everything past a limit waits in Work. */
export function LimitsTab() {
  return (
    <div className="limits">
      <div className="panel-header">
        <h2 className="panel-title">Limits</h2>
        <p className="small muted">
          What your AI self may do on its own, without asking you first. Everything past a limit waits for you in Work. Each thing it does on its own gets a receipt, signed by
          its key and sealed with the hour, which you can keep private or share.
        </p>
      </div>
      <LimitsForm />
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
      const clean = await limitsOps.saveLimits(api, vault, draft());
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

  const toggle = (id: string, checked: boolean, onChange: (v: boolean) => void, label: string, hint: string) => (
    <label className="checkbox suggest-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        <span className="field-hint">{hint}</span>
      </span>
    </label>
  );
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
      <Band label="Replies" hint="A reply drafted in Work to a contact you list here is approved on its own. This site sends no mail itself: an approved reply is ready to send, not sent.">
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

const KIND_WORD = { payment: "Payment", approval: "Approval", agreement: "Meeting" } as const;

function ReceiptsSection() {
  const { api, vault } = useVault();
  const [list, setList] = useState<receipts.ReceiptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    receipts
      .loadReceipts(api, vault)
      .then((r) => alive && setList(r))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [api, vault]);

  return (
    <section className="subpanel plate limits-receipts" aria-labelledby="receipts-title">
      <PlateHead number="02" id="receipts-title" title="Receipts" lead="What your self did on its own, newest first. Only you can read them; share one and anyone can check it on the verify page.">
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
                  {r.receipt ? `. Under: ${r.receipt.body.limit}` : ""}. {r.shared?.seal ? `Sealed in hour ${r.shared.seal.hour}.` : "Sealed once its hour is over."}
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
      <Quiet>A receipt says what was done, when, and under which limit, signed by the self key. Its fingerprint, which says nothing on its own, is in the hourly seal.</Quiet>
    </section>
  );
}
