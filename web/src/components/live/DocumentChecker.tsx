"use client";

// Checks, in this browser, the signed documents a vault can hand out: a proof
// of a fact, a sealed agreement, an identity statement or a knowledge pack.
// Each is recognised by its format line. Nothing about it is sent anywhere,
// except the hours whose published roots are looked up.

import { useEffect, useState } from "react";
import {
  AGREEMENT_FORMAT,
  DISCLOSURE_FORMAT,
  IDENTITY_FORMAT,
  PACK_FORMAT,
  parseAgreement,
  parseDisclosure,
  parseIdentityStatement,
  parsePack,
  verifyAgreement,
  verifyDisclosure,
  verifyIdentityStatement,
  verifyPack,
  type CertificateCheck,
} from "@sigil/core";
import { chainRoots, siteRoots, type ChainInfo } from "@/lib/roots";

interface Outcome {
  ok: boolean;
  kind: string;
  /** The claim, the title or the name, in one line. */
  headline: string | null;
  attestedBy: string | null;
  checks: CertificateCheck[];
  /** Whether it rests on the site's seals. */
  seals: boolean;
}

type State = { kind: "idle" } | { kind: "loading" } | { kind: "error"; reason: string } | { kind: "done"; outcome: Outcome; chain: boolean };

async function sources() {
  let chain: ChainInfo | null = null;
  let period = 3600;
  try {
    const r = await fetch("/api/seals?limit=1", { cache: "no-store" });
    if (r.ok) {
      const body = (await r.json()) as { chain?: ChainInfo | null; periodSeconds?: number };
      chain = body.chain ?? null;
      period = body.periodSeconds ?? period;
    }
  } catch {
    chain = null;
  }
  return { chain, period };
}

export async function checkDocument(text: string): Promise<State> {
  let format = "";
  try {
    format = String((JSON.parse(text) as { format?: unknown }).format ?? "");
  } catch {
    return { kind: "error", reason: "This is not a signed document: it is not valid JSON." };
  }
  try {
    const { chain, period } = await sources();
    const onChain = chain ? chainRoots(chain) : undefined;
    if (format === DISCLOSURE_FORMAT) {
      const d = parseDisclosure(text);
      const same = d.statement.origin === window.location.origin;
      const r = await verifyDisclosure(d, { published: same ? siteRoots() : undefined, onChain });
      if (!same) r.checks.push({ name: "published", ok: false, detail: `This proof was made on ${d.statement.origin}. Check it on that site to compare its roots with the seals it publishes.` });
      return { kind: "done", chain: !!chain, outcome: { ok: r.ok && same, kind: "A proof of a fact", headline: r.claim, attestedBy: r.attestedBy, checks: r.checks, seals: true } };
    }
    if (format === AGREEMENT_FORMAT) {
      const a = parseAgreement(text);
      const r = await verifyAgreement(a, { published: siteRoots(), onChain, periodSeconds: period });
      return { kind: "done", chain: !!chain, outcome: { ok: r.ok, kind: "A sealed agreement", headline: a.doc?.title ?? null, attestedBy: "Both parties' vault keys, and this site's seals for when it was signed.", checks: r.checks, seals: true } };
    }
    if (format === IDENTITY_FORMAT) {
      const s = parseIdentityStatement(text);
      const r = verifyIdentityStatement(s);
      return { kind: "done", chain: !!chain, outcome: { ok: r.ok, kind: "An identity statement", headline: `${s.body.name}, self key ${s.body.selfKey}`, attestedBy: "The owner's vault key and the self's own key, together.", checks: r.checks, seals: false } };
    }
    if (format === PACK_FORMAT) {
      const p = parsePack(text);
      const r = verifyPack(p);
      return { kind: "done", chain: !!chain, outcome: { ok: r.ok, kind: "A knowledge pack", headline: `${p.body.title}, version ${p.body.version}`, attestedBy: "The publisher's vault key.", checks: r.checks, seals: false } };
    }
    return { kind: "error", reason: "This is not a document this page knows. Life certificates have their own checker above." };
  } catch (err) {
    return { kind: "error", reason: (err as Error).message };
  }
}

export function DocumentChecker() {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("proof");
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
    let alive = true;
    fetch(`/api/proofs/${id}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.text();
        if (!r.ok) throw new Error((JSON.parse(body) as { error?: string }).error ?? "This proof could not be loaded.");
        if (!alive) return;
        setText(body);
        setState(await checkDocument(body));
      })
      .catch((err) => alive && setState({ kind: "error", reason: (err as Error).message }));
    return () => {
      alive = false;
    };
  }, []);

  const run = async (value = text) => {
    setState({ kind: "loading" });
    setState(await checkDocument(value));
  };

  return (
    <div className="certificate-checker document-checker">
      <div className="field">
        <label className="field-label" htmlFor="doc-file">
          A signed file
        </label>
        <input
          id="doc-file"
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
        <label className="field-label" htmlFor="doc-text">
          Or its text
        </label>
        <textarea id="doc-text" className="textarea mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"format": "sigil-disclosure", ...}' spellCheck={false} />
      </div>
      <button type="button" className="button button-primary" disabled={!text.trim() || state.kind === "loading"} onClick={() => void run()}>
        {state.kind === "loading" ? "Checking" : "Check it"}
      </button>
      {state.kind === "error" ? (
        <div className="verifier-result" data-ok="false" role="status" data-testid="document-result">
          <p className="verifier-verdict">Not verified</p>
          <p className="small">{state.reason}</p>
        </div>
      ) : null}
      {state.kind === "done" ? (
        <div className="verifier-result certificate-result" data-ok={state.outcome.ok ? "true" : "false"} role="status" data-testid="document-result">
          <p className="verifier-verdict">{state.outcome.ok ? "Verified" : "Not verified"}</p>
          <p className="small muted">{state.outcome.kind}</p>
          {state.outcome.headline ? (
            <p className="document-headline" data-testid="document-headline">
              {state.outcome.headline}
            </p>
          ) : null}
          <ul className="proof-steps certificate-checks">
            {state.outcome.checks.map((c, i) => (
              <li key={`${c.name}-${i}`} data-ok={c.ok ? "true" : "false"}>
                {c.detail}
              </li>
            ))}
            {!state.chain && state.outcome.seals ? <li data-ok="none">The seals of this site are not anchored on chain, so only the roots it publishes were compared.</li> : null}
          </ul>
          {state.outcome.attestedBy ? <p className="small faint">Who stands behind it: {state.outcome.attestedBy}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
