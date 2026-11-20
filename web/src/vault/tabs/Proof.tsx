"use client";

import { useState } from "react";
import Link from "next/link";
import { signingFingerprint, verifyCertificate, type CertificateResult, type LifeCertificate } from "@sigil/core";
import { CertificateIcon, ImportIcon, SealIcon, ShareIcon } from "@/components/icons";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { siteRoots } from "@/lib/roots";
import * as life from "../lifeOps";
import { errorText, useVault } from "../context";
import { CopyButton, download, Empty, Fingerprint, Notice } from "../ui";

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
    </div>
  );
}
