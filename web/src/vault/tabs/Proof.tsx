"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { describeClaim, fieldDate, memoryFields, signingFingerprint, verifyCertificate, yearsBefore, type CertificateResult, type LifeCertificate } from "@sigil/core";
import { CertificateIcon, ImportIcon, SealIcon, ShareIcon } from "@/components/icons";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { siteRoots } from "@/lib/roots";
import * as life from "../lifeOps";
import * as disclose from "../discloseOps";
import { errorText, useVault } from "../context";
import { CopyButton, download, Empty, Fingerprint, Notice, PlateHead, Quiet } from "../ui";

export function ProofTab() {
  const { api, vault, data, update } = useVault();
  const [cert, setCert] = useState<LifeCertificate | null>(null);
  const [check, setCheck] = useState<CertificateResult | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const s = cert?.body.summary;

  return (
    <div className="proof">
      <div className="panel-header">
        <h2 className="panel-title">Proof of a real life</h2>
        <p className="small muted">A certificate that this vault has a long, continuous sealed history, without a word of what is in it.</p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="proof-facts">
        <div className="proof-fact">
          <span className="proof-fact-number">{data.presence.total}</span>
          <span className="proof-fact-label">{data.presence.total === 1 ? "hour" : "hours"} with your vault open</span>
        </div>
        <div className="proof-fact">
          <span className="proof-fact-number">{data.presence.sealed}</span>
          <span className="proof-fact-label">sealed so far</span>
        </div>
        <div className="proof-fact">
          <span className="proof-fact-number">{data.certificates.length}</span>
          <span className="proof-fact-label">{data.certificates.length === 1 ? "certificate" : "certificates"} shared by link</span>
        </div>
      </div>

      <p className="small muted">
        While this vault is open, your browser signs one short statement each hour with a key made from your vault key: this vault was open in this hour. Sigil checks the
        signature and puts it in that hour&apos;s seal. A certificate gathers those hours with their proofs and is signed by the same key.
      </p>
      {data.signKey ? (
        <p className="small faint">
          Signing key fingerprint <Fingerprint value={signingFingerprint(data.signKey)} />
        </p>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={!!busy || data.presence.total === 0}
          onClick={() =>
            void act("make", async () => {
              setLink(null);
              const c = await life.makeCertificate(api, vault);
              setCert(c);
              setCheck(await verifyCertificate(c, { published: siteRoots() }));
            })
          }
        >
          <CertificateIcon /> {busy === "make" ? "Building" : "Make a certificate"}
        </button>
      </div>
      {data.presence.total === 0 ? (
        <Empty icon={<SealIcon />} title="Nothing sealed yet">
          Each hour your vault is open is sealed once that hour is over. Come back after an hour to make the first certificate; the longer you keep using the vault, the more
          it shows.
        </Empty>
      ) : null}

      {cert && s ? (
        <section className="certificate subpanel" aria-label="Certificate" data-ok={check?.ok ? "true" : "false"} data-testid="certificate">
          <div className="certificate-head">
            <span className="certificate-mark" aria-hidden="true">
              <CertificateIcon />
            </span>
            <div>
              <p className="eyebrow">Life certificate</p>
              <p className="certificate-title">
                {s.continuousMonths > 0 ? `${plural(s.continuousMonths, "month")} of continuous sealed history` : `${plural(s.continuousDays, "day")} of continuous sealed history`}
              </p>
            </div>
          </div>
          <dl className="certificate-facts">
            <div>
              <dt>First seal</dt>
              <dd>{formatDateTime(s.from)}</dd>
            </div>
            <div>
              <dt>Last seal</dt>
              <dd>{formatDateTime(s.to)}</dd>
            </div>
            <div>
              <dt>Hours with activity</dt>
              <dd>{s.activeHours}</dd>
            </div>
            <div>
              <dt>Days with activity</dt>
              <dd>{s.activeDays}</dd>
            </div>
            <div>
              <dt>Longest gap</dt>
              <dd>{s.longestGapHours < 48 ? plural(s.longestGapHours, "hour") : plural(Math.floor(s.longestGapHours / 24), "day")}</dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>{formatDate(cert.body.issuedAt)}</dd>
            </div>
          </dl>
          {check ? (
            <ul className="proof-steps certificate-checks">
              {check.checks.map((c) => (
                <li key={c.name} data-ok={c.ok ? "true" : "false"}>
                  {c.detail}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row">
            <button type="button" className="button button-small" onClick={() => download(`sigil-life-certificate-${cert.body.issuedAt.slice(0, 10)}.json`, JSON.stringify(cert, null, 2))}>
              <ImportIcon /> Download
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={!!busy}
              onClick={() =>
                void act("share", async () => {
                  const id = await life.publishCertificate(api, cert);
                  setLink(life.certificateLink(origin, id));
                  update((d) => ({
                    ...d,
                    certificates: [{ id, size: JSON.stringify(cert).length, summary: { from: s.from, to: s.to, activeHours: s.activeHours, activeDays: s.activeDays, continuousMonths: s.continuousMonths }, createdAt: new Date().toISOString() }, ...d.certificates],
                  }));
                })
              }
            >
              <ShareIcon /> {busy === "share" ? "Publishing" : "Make a share link"}
            </button>
          </div>
          {link ? (
            <div className="certificate-link">
              <code className="mono small" data-testid="certificate-link">
                {link}
              </code>
              <CopyButton text={link} />
            </div>
          ) : null}
          <p className="small faint">
            What it proves: whoever could open this vault signed in each listed hour, and the site sealed it then. It does not say who that is. More on the{" "}
            <Link href="/verify#certificate">verify page</Link>.
          </p>
        </section>
      ) : null}

      {data.certificates.length ? (
        <>
          <h3 className="settings-heading">Shared by link</h3>
          <ul className="list">
            {data.certificates.map((c) => (
              <li key={c.id} className="list-row">
                <div className="list-row-main">
                  <p className="list-row-title">
                    <CertificateIcon /> {formatDate(c.summary.from)} to {formatDate(c.summary.to)}
                  </p>
                  <p className="list-row-meta">
                    {plural(c.summary.activeDays, "day")} with activity, {plural(c.summary.continuousMonths, "month")} continuous. Published {formatDateTime(c.createdAt)}.
                  </p>
                </div>
                <div className="list-row-actions">
                  <CopyButton text={life.certificateLink(origin, c.id)} label="Copy link" />
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void act("down-" + c.id, async () => {
                        await life.unpublishCertificate(api, c.id);
                        update((d) => ({ ...d, certificates: d.certificates.filter((x) => x.id !== c.id) }));
                      })
                    }
                  >
                    Take down
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <ProveSection />
    </div>
  );
}

// ---------------------------------------------------------------- proving one fact

type Mode = "field" | "age" | "history" | "member";

const MODES: { id: Mode; label: string; lead: string }[] = [
  { id: "field", label: "One field", lead: "One line of one memory, such as Nationality: ..., shown with nothing else from the memory." },
  { id: "age", label: "An age", lead: "That a date in a memory, such as a birth date, is more than a number of years ago. The date itself stays hidden." },
  { id: "history", label: "Sealed history", lead: "How many months this vault has a sealed history, checked in full by anyone from two sealed hours." },
  { id: "member", label: "A team space", lead: "That this vault joined a team space, and since when, from the sealed record of joining." },
];

/** Proves one fact, signed by this vault and sealed with the hour, without showing anything else. */
function ProveSection() {
  const { api, vault, data, update } = useVault();
  const [mode, setMode] = useState<Mode>("field");
  const [memoryId, setMemoryId] = useState("");
  const [field, setField] = useState(0);
  const [years, setYears] = useState(18);
  const [spaceId, setSpaceId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const memories = useMemo(() => data.memories.filter((m) => m.source.kind !== "brief" && m.source.kind !== "profile" && m.source.kind !== "style").slice(0, 300), [data.memories]);
  const memory = memories.find((m) => m.id === memoryId) ?? null;
  const fields = memory ? memoryFields(memory) : [];
  const dateFields = fields.map((f, i) => ({ f, i })).filter((x) => x.f.name !== "Written" && fieldDate(x.f.value));
  const spaces = data.spaces.filter((s) => s.me.acceptedAt);
  const waiting = data.disclosures.some((d) => d.proof && !d.proof.anchor);

  // A proof is complete once its hour is sealed: look again now and then while one waits.
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const t = window.setInterval(async () => {
      for (const d of data.disclosures.filter((x) => x.proof && !x.proof.anchor)) {
        try {
          const next = await disclose.complete(api, vault, d);
          if (alive && next.proof?.anchor) update((x) => ({ ...x, disclosures: x.disclosures.map((y) => (y.id === next.id ? next : y)) }));
        } catch {
          // The next look tries again.
        }
      }
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, vault, data.disclosures, waiting, update]);

  const make = async () => {
    setBusy("make");
    setError(null);
    try {
      let view: disclose.DisclosureView;
      if (mode === "history") view = await disclose.proveHistory(api, vault);
      else if (mode === "member") {
        const s = spaces.find((x) => x.id === spaceId);
        if (!s) throw new Error("Choose a team space.");
        view = await disclose.proveMember(api, vault, { id: s.id, name: s.name });
      } else {
        if (!memory) throw new Error("Choose a memory.");
        view =
          mode === "field"
            ? await disclose.proveField(api, vault, memory, field, { kind: "field" })
            : await disclose.proveField(api, vault, memory, field, { kind: "before", date: yearsBefore(new Date().toISOString().slice(0, 10), years), years });
      }
      update((d) => ({ ...d, disclosures: [view, ...d.disclosures] }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate prove" aria-labelledby="prove-title" id="prove">
      <PlateHead number="02" id="prove-title" title="Prove a fact" lead="One claim, signed by this vault and sealed with the hour, that shows nothing else. Anyone can check it on the verify page." />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="segmented" role="group" aria-label="What to prove">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => (setMode(m.id), setField(m.id === "age" ? (dateFields[0]?.i ?? 0) : 0))}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="small muted">{MODES.find((m) => m.id === mode)!.lead}</p>
      {mode === "field" || mode === "age" ? (
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="prove-memory">
              Memory
            </label>
            <select
              id="prove-memory"
              className="select"
              value={memoryId}
              onChange={(e) => {
                setMemoryId(e.target.value);
                const m = memories.find((x) => x.id === e.target.value);
                const fs = m ? memoryFields(m) : [];
                setField(mode === "age" ? Math.max(0, fs.findIndex((f) => f.name !== "Written" && fieldDate(f.value))) : 0);
              }}
            >
              <option value="">Choose a memory</option>
              {memories.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="prove-field">
              {mode === "age" ? "Date" : "Field"}
            </label>
            <select id="prove-field" className="select" value={field} onChange={(e) => setField(Number(e.target.value))} disabled={!memory}>
              {(mode === "age" ? dateFields : fields.map((f, i) => ({ f, i }))).map(({ f, i }) => (
                <option key={i} value={i}>
                  {mode === "age" ? f.name : `${f.name}: ${f.value.slice(0, 40)}`}
                </option>
              ))}
            </select>
            {mode === "age" && memory && dateFields.length === 0 ? <span className="field-hint">This memory has no line with a date, like Born: 1990-04-02.</span> : null}
          </div>
          {mode === "age" ? (
            <div className="field">
              <label className="field-label" htmlFor="prove-years">
                At least this many years
              </label>
              <input id="prove-years" className="input" type="number" min={1} max={120} value={years} onChange={(e) => setYears(Math.min(120, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
          ) : null}
        </div>
      ) : null}
      {mode === "member" ? (
        spaces.length ? (
          <div className="field">
            <label className="field-label" htmlFor="prove-space">
              Team space
            </label>
            <select id="prove-space" className="select" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              <option value="">Choose a space</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <Quiet>This vault is in no team space yet.</Quiet>
        )
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!!busy || ((mode === "field" || mode === "age") && !memory) || (mode === "age" && dateFields.length === 0) || (mode === "member" && !spaceId)}
          onClick={() => void make()}
        >
          <SealIcon /> {busy === "make" ? "Signing" : "Make the proof"}
        </button>
      </div>
      <p className="small faint">
        Who stands behind each claim: sealed history and team spaces rest on the site&apos;s seals and are checked in full. A field or an age is your own vault&apos;s statement,
        committed and signed: nobody else has checked that it is true. Zero-knowledge proofs, where an age is computed without anyone seeing the date, are on the roadmap.
      </p>

      {data.disclosures.length ? (
        <ul className="list">
          {data.disclosures.map((d) => {
            const sealed = !!d.proof?.anchor;
            const link = links[d.id] ?? (d.published ? disclose.proofLink(origin, d.id) : null);
            return (
              <li key={d.id} className="list-row" data-testid="proof-row" data-sealed={sealed ? "true" : "false"}>
                <div className="list-row-main">
                  <p className="list-row-title">
                    <SealIcon /> {d.proof ? describeClaim(d.proof.statement.claim) : "A proof that could not be opened"}
                  </p>
                  <p className="list-row-meta">
                    {sealed ? "Sealed" : "Waiting for the seal of this hour"}. Made {formatDateTime(d.createdAt)}.
                  </p>
                  {link ? (
                    <code className="mono small" data-testid="proof-link">
                      {link}
                    </code>
                  ) : null}
                </div>
                <div className="list-row-actions">
                  {sealed && d.proof ? (
                    <>
                      <button type="button" className="button button-small" onClick={() => download(`sigil-proof-${d.id.slice(0, 8)}.json`, JSON.stringify(d.proof, null, 2))}>
                        <ImportIcon /> Download
                      </button>
                      {link ? (
                        <>
                          <CopyButton text={link} label="Copy link" />
                          <button
                            type="button"
                            className="button button-small button-ghost"
                            disabled={!!busy}
                            onClick={() =>
                              void act(d.id, async () => {
                                await disclose.unpublish(api, d.id);
                                setLinks((l) => {
                                  const { [d.id]: _gone, ...rest } = l;
                                  return rest;
                                });
                                update((x) => ({ ...x, disclosures: x.disclosures.map((y) => (y.id === d.id ? { ...y, published: false } : y)) }));
                              })
                            }
                          >
                            Take down
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button button-small"
                          disabled={!!busy}
                          onClick={() =>
                            void act(d.id, async () => {
                              await disclose.publish(api, d);
                              setLinks((l) => ({ ...l, [d.id]: disclose.proofLink(origin, d.id) }));
                              update((x) => ({ ...x, disclosures: x.disclosures.map((y) => (y.id === d.id ? { ...y, published: true } : y)) }));
                            })
                          }
                        >
                          <ShareIcon /> Make a share link
                        </button>
                      )}
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="button button-small button-ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void act(d.id, async () => {
                        await disclose.remove(api, d.id);
                        update((x) => ({ ...x, disclosures: x.disclosures.filter((y) => y.id !== d.id) }));
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
