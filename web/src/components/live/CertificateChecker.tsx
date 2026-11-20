"use client";

// Checks a life certificate in this browser: its signature, every presence
// statement, every proof, the summary, the roots this site publishes and, when
// the seals are anchored, the roots on chain. Nothing about the certificate is
// sent anywhere except the list of hours whose roots are looked up.

import { useEffect, useState } from "react";
import { parseCertificate, signingFingerprint, verifyCertificate, type CertificateResult, type LifeCertificate } from "@sigil/core";
import { formatDateTime, plural } from "@/lib/format";
import { chainRoots, siteRoots, type ChainInfo } from "@/lib/roots";

type State = { kind: "idle" } | { kind: "loading" } | { kind: "error"; reason: string } | { kind: "done"; cert: LifeCertificate; result: CertificateResult; chain: boolean };

async function check(text: string): Promise<State> {
  let cert: LifeCertificate;
  try {
    cert = parseCertificate(text);
  } catch (err) {
    return { kind: "error", reason: (err as Error).message };
  }
  let chain: ChainInfo | null = null;
  try {
    const r = await fetch("/api/seals?limit=1", { cache: "no-store" });
    if (r.ok) chain = ((await r.json()) as { chain?: ChainInfo | null }).chain ?? null;
  } catch {
    chain = null;
  }
  const sameSite = cert.body.origin === window.location.origin;
  const result = await verifyCertificate(cert, { published: sameSite ? siteRoots() : undefined, onChain: chain ? chainRoots(chain) : undefined });
  if (!sameSite) {
    result.checks.push({ name: "published", ok: false, detail: `This certificate was made on ${cert.body.origin}. Check it on that site to compare its roots with the seals it publishes.` });
    result.ok = false;
  }
  return { kind: "done", cert, result, chain: !!chain };
}

export function CertificateChecker() {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("certificate");
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
    let alive = true;
    fetch(`/api/certificates/${id}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.text();
        if (!r.ok) throw new Error((JSON.parse(body) as { error?: string }).error ?? "This certificate could not be loaded.");
        if (!alive) return;
        setText(body);
        setState(await check(body));
      })
      .catch((err) => alive && setState({ kind: "error", reason: (err as Error).message }));
    return () => {
      alive = false;
    };
  }, []);

  const run = async (value = text) => {
    setState({ kind: "loading" });
    setState(await check(value));
  };

  return (
    <div className="certificate-checker">
      <div className="field">
        <label className="field-label" htmlFor="cert-file">
          A certificate file
        </label>
        <input
          id="cert-file"
          className="input"
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const v = await f.text();
            setText(v);
            void run(v);
          }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cert-text">
          Or its text
        </label>
        <textarea id="cert-text" className="textarea mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"format": "sigil-life-certificate", ...}' spellCheck={false} />
      </div>
      <button type="button" className="button button-primary" disabled={!text.trim() || state.kind === "loading"} onClick={() => void run()}>
        {state.kind === "loading" ? "Checking" : "Check the certificate"}
      </button>

      {state.kind === "error" ? (
        <div className="verifier-result" data-ok="false" role="status">
          <p className="verifier-verdict">Not verified</p>
          <p className="small">{state.reason}</p>
        </div>
      ) : null}
      {state.kind === "done" ? (
        <div className="verifier-result certificate-result" data-ok={state.result.ok ? "true" : "false"} role="status" data-testid="certificate-result">
          <p className="verifier-verdict">{state.result.ok ? "Verified" : "Not verified"}</p>
          {state.result.summary ? (
            <dl className="certificate-facts">
              <div>
                <dt>Continuous history</dt>
                <dd>{state.result.summary.continuousMonths > 0 ? plural(state.result.summary.continuousMonths, "month") : plural(state.result.summary.continuousDays, "day")}</dd>
              </div>
              <div>
                <dt>First seal</dt>
                <dd>{formatDateTime(state.result.summary.from)}</dd>
              </div>
              <div>
                <dt>Last seal</dt>
                <dd>{formatDateTime(state.result.summary.to)}</dd>
              </div>
              <div>
                <dt>Hours with activity</dt>
                <dd>{state.result.summary.activeHours}</dd>
              </div>
              <div>
                <dt>Days with activity</dt>
                <dd>{state.result.summary.activeDays}</dd>
              </div>
              <div>
                <dt>Longest gap</dt>
                <dd>{plural(state.result.summary.longestGapHours, "hour")}</dd>
              </div>
            </dl>
          ) : null}
          <ul className="proof-steps certificate-checks">
            {state.result.checks.map((c, i) => (
              <li key={`${c.name}-${i}`} data-ok={c.ok ? "true" : "false"}>
                {c.detail}
              </li>
            ))}
            {!state.chain ? <li data-ok="none">The seals of this site are not anchored on chain, so only the roots it publishes were compared.</li> : null}
          </ul>
          <p className="small faint">
            Signed by the key {signingFingerprint(state.cert.body.signingKey)}, issued {formatDateTime(state.cert.body.issuedAt)}.
          </p>
        </div>
      ) : null}
    </div>
  );
}
