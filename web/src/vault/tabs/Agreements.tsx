"use client";

import { useEffect, useState } from "react";
import { parseVaultCode, vaultFingerprint } from "@sigil/core";
import { AgreementIcon, ImportIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import * as ag from "../agreementOps";
import { clearAgreement, peekAgreement } from "../actingOps";
import { errorText, useVault } from "../context";
import { download, Empty, Fingerprint, Notice, PlateHead } from "../ui";

const STATE_WORD: Record<ag.AgreementState, string> = { proposed: "Waiting for a signature", signed: "Signed by both", declined: "Declined", withdrawn: "Withdrawn" };

/** Sealed agreements: one vault drafts, the other reviews and signs, both sign one hash, and it is sealed in both logs. */
export function AgreementsTab() {
  const { api, vault, data, update } = useVault();
  // An agreed result from Work opens as a new draft with its text.
  const [handed] = useState(() => peekAgreement());
  const [drafting, setDrafting] = useState<ag.AgreementView | "new" | null>(handed ? "new" : null);
  useEffect(() => clearAgreement(), []);

  // While this tab is open, the list is read again now and then, so a signature from the other side shows.
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(() => {
      api
        .get<{ agreements: ag.ServerAgreement[] }>("agreements")
        .then((r) => ag.openAgreements(vault, data.box, r.agreements))
        .then((r) => alive && update((d) => ({ ...d, agreements: r.agreements })))
        .catch(() => undefined);
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, vault, data.box, update]);

  return (
    <div className="agreements">
      <div className="panel-header">
        <h2 className="panel-title">Agreements</h2>
        {drafting === null ? (
          <button type="button" className="button button-primary" onClick={() => setDrafting("new")}>
            <AgreementIcon /> Draft an agreement
          </button>
        ) : null}
      </div>
      <p className="small muted">
        Write an agreement and send it to another vault. Its owner reads it in their vault and signs, or declines. Both of you sign the same fingerprint of the text, and once
        signed it goes into both of your hourly seals. Nothing can be changed after signing: a change is an amendment, a new version that points to the old one. The text travels
        sealed to the other vault; Sigil passes it on and cannot read it.
      </p>
      {drafting ? <DraftForm amends={drafting === "new" ? null : drafting} initial={drafting === "new" ? handed : null} onDone={() => setDrafting(null)} /> : null}
      {data.agreements.length === 0 && !drafting ? (
        <Empty icon={<AgreementIcon />} title="No agreements yet">
          Ask the other person for their vault code (under Folders, Your vault code), and draft the first one.
        </Empty>
      ) : null}
      {data.agreements.map((a) => (
        <AgreementCard key={a.id} view={a} onAmend={() => setDrafting(a)} />
      ))}
    </div>
  );
}

function DraftForm({ amends, initial, onDone }: { amends: ag.AgreementView | null; initial?: { title: string; text: string } | null; onDone(): void }) {
  const { api, vault, data, reload } = useVault();
  const me = amends?.doc ? amends.doc.parties[amends.role === "from" ? 0 : 1].name : "";
  const [code, setCode] = useState("");
  const [title, setTitle] = useState(amends?.doc?.title ?? initial?.title ?? "");
  const [text, setText] = useState(amends?.doc?.text ?? initial?.text ?? "");
  const [myName, setMyName] = useState(me);
  const [them, setThem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let fingerprint: string | null = null;
  let codeError: string | null = null;
  if (!amends && code.trim()) {
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
      if (amends) await ag.amend(api, vault, data, amends, { title, text });
      else await ag.propose(api, vault, data, { code, title, text, me: myName, them });
      await reload();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel plate agreement-form" onSubmit={submit} aria-label={amends ? "Amend the agreement" : "Draft an agreement"}>
      <PlateHead
        number="01"
        title={amends ? `Amend: ${amends.doc?.title ?? "agreement"}` : "Draft an agreement"}
        lead={amends ? `Version ${amends.version + 1}. The signed version stays as it is; this one points to it.` : "You sign it as you send it. They sign it once they agree."}
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!amends ? (
        <div className="field">
          <label className="field-label" htmlFor="ag-code">
            Their vault code
          </label>
          <input id="ag-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sigil_vault..." autoComplete="off" spellCheck={false} required />
          <span className="field-hint" aria-live="polite">
            {codeError ?? (fingerprint ? "Ask them to read their fingerprint to you; it must match the one below." : "They find it in their vault, under Folders.")}
          </span>
          {fingerprint ? <Fingerprint value={fingerprint} /> : null}
        </div>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="ag-title">
          Title
        </label>
        <input id="ag-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ag-text">
          The agreement
        </label>
        <textarea id="ag-text" className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} required />
      </div>
      {!amends ? (
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="ag-me">
              Your name, as you sign
            </label>
            <input id="ag-me" className="input" value={myName} maxLength={80} onChange={(e) => setMyName(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ag-them">
              Their name, as they sign
            </label>
            <input id="ag-them" className="input" value={them} maxLength={80} onChange={(e) => setThem(e.target.value)} required />
          </div>
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy || (!amends && !fingerprint) || !title.trim() || !text.trim()}>
          {busy ? "Signing" : "Sign and send"}
        </button>
        <button type="button" className="button button-ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AgreementCard({ view, onAmend }: { view: ag.AgreementView; onAmend(): void }) {
  const { api, vault, data, reload } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const doc = view.doc;
  const me = view.role === "from" ? 0 : 1;
  const peer = doc?.parties[1 - me]?.name || "the other vault";
  const amended = data.agreements.some((x) => x.previous === view.hash && (x.state === "proposed" || x.state === "signed"));

  const act = async (name: string, fn: () => Promise<void>, again = true) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (again) await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate agreement-card" data-state={view.state} data-role={view.role} data-testid="agreement-card" aria-label={doc?.title ?? "Agreement"}>
      <PlateHead number={`v${view.version}`} title={doc?.title ?? "An agreement that could not be opened"} lead={`With ${peer}. ${view.role === "from" ? "You sent it" : "Sent to you"} ${formatDateTime(view.createdAt)}.`}>
        <span className="plate-state" data-on={view.state === "signed" ? "true" : "false"}>
          {STATE_WORD[view.state]}
        </span>
      </PlateHead>
      {doc ? <p className="agreement-text">{doc.text}</p> : null}
      {doc ? (
        <p className="small faint">
          Parties: {doc.parties[0].name || "first party"} and {doc.parties[1].name || "second party"}. Fingerprint <code className="mono">{view.hash.slice(0, 18)}...</code>
          {view.previous ? ` Amends the version ${view.previous.slice(0, 12)}...` : ""}
          {view.signedAt ? ` Signed ${formatDateTime(view.signedAt)}.` : ""}
        </p>
      ) : null}
      {view.problems.length ? (
        <Notice kind="error">
          {view.problems.join(" ")} {view.state === "proposed" && view.role === "to" ? "Do not sign it." : ""}
        </Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice>{note}</Notice> : null}
      <div className="form-actions">
        {view.role === "to" && view.state === "proposed" ? (
          <>
            <button type="button" className="button button-primary" disabled={!!busy || view.problems.length > 0} onClick={() => void act("sign", () => ag.sign(api, vault, view))}>
              {busy === "sign" ? "Signing" : "Sign it"}
            </button>
            <button type="button" className="button button-ghost" disabled={!!busy} onClick={() => void act("decline", () => ag.decline(api, view.id))}>
              Decline
            </button>
          </>
        ) : null}
        {view.role === "from" && view.state === "proposed" ? (
          <button type="button" className="button button-ghost" disabled={!!busy} onClick={() => void act("withdraw", () => ag.decline(api, view.id))}>
            Withdraw
          </button>
        ) : null}
        {view.state === "signed" ? (
          <>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() =>
                void act(
                  "copy",
                  async () => {
                    const copy = await ag.verifiableCopy(api, view);
                    download(`sigil-agreement-${view.hash.slice(2, 10)}-v${view.version}.json`, JSON.stringify(copy, null, 2));
                    if (!copy.seal) setNote("Downloaded. The seal of this hour is not made yet, so the copy says so; download it again after the hour for a complete one.");
                  },
                  false,
                )
              }
            >
              <ImportIcon /> {busy === "copy" ? "Preparing" : "Download a verifiable copy"}
            </button>
            {!amended ? (
              <button type="button" className="button button-ghost" disabled={!!busy} onClick={onAmend}>
                Amend
              </button>
            ) : null}
          </>
        ) : null}
        {view.state !== "proposed" ? (
          <button type="button" className="button button-small button-ghost" disabled={!!busy} onClick={() => void act("remove", () => ag.remove(api, view.id))}>
            Remove from my list
          </button>
        ) : null}
      </div>
    </section>
  );
}
