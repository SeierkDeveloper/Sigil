"use client";

// Checks, in this browser, the signed documents a vault can hand out: a proof
// of a fact, a sealed agreement, an identity statement, a knowledge pack or a
// receipt of the AI self. Each is recognised by its format line. Nothing about
// it is sent anywhere, except the hours whose published roots are looked up, a
// receipt's fingerprint when its proof is asked for, and its self key when the
// identity statement behind it is read.

import { useEffect, useState } from "react";
import {
  AGREEMENT_FORMAT,
  checkReceipt,
  DISCLOSURE_FORMAT,
  IDENTITY_FORMAT,
  PACK_FORMAT,
  parseReceipt,
  RECEIPT_FORMAT,
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

const RECEIPT_KIND: Record<string, string> = { payment: "A payment", approval: "An approval within limits", agreement: "A meeting agreed" };

/** A receipt of the AI self: its signature, its proof to a sealed root, that root against the site's seals (and the chain's), and the identity statement of its self key. */
async function checkReceiptDocument(text: string, chain: ChainInfo | null, period: number): Promise<State> {
  const shared = parseReceipt(text);
  const body = shared.receipt.body;
  const same = body.origin === window.location.origin;
  // A receipt shared before its hour was sealed: ask this site for the proof of its fingerprint.
  if (!shared.seal && same) {
    const first = checkReceipt(shared);
    const atHour = Math.floor(Date.parse(body.at) / 1000 / period);
    for (const hour of [atHour, atHour + 1]) {
      if (!first.leaf) break;
      const r = await fetch(`/api/seals/${hour}/proof?leaf=${first.leaf}`, { cache: "no-store" });
      if (r.ok) {
        const p = (await r.json()) as { hour: number; root: string; proof: string[] };
        shared.seal = { hour: p.hour, root: p.root, proof: p.proof, periodSeconds: period };
        break;
      }
    }
  }
  const r = checkReceipt(shared);
  const checks: CertificateCheck[] = r.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail }));
  if (!shared.seal) checks.push({ name: "seal", ok: false, detail: same ? "Its fingerprint is not in a seal yet. Seals are made once an hour is over: try again after the hour." : `This receipt was made on ${body.origin}. Check it on that site to find its seal.` });
  else if (same) {
    const roots = await siteRoots()([shared.seal.hour]);
    const published = roots.get(shared.seal.hour);
    const match = !!published && published.toLowerCase() === shared.seal.root.toLowerCase();
    checks.push({ name: "published", ok: match, detail: match ? `The root is the one this site published for the hour from ${new Date(shared.seal.hour * (shared.seal.periodSeconds ?? period) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "The root is not the one this site published for that hour." });
    if (chain) {
      const onChain = (await chainRoots(chain)([shared.seal.hour])).get(shared.seal.hour);
      checks.push({ name: "chain", ok: !!onChain && onChain.toLowerCase() === shared.seal.root.toLowerCase(), detail: onChain ? "The root matches SigilSeal on chain." : "That hour is not on chain yet." });
    }
  } else checks.push({ name: "published", ok: false, detail: `This receipt was made on ${body.origin}. Check it on that site to compare its root with the seals it publishes.` });
  let attestedBy = `The self key ${body.selfKey}.`;
  if (same) {
    try {
      const st = await fetch(`/api/identity/at/${body.selfKey}`, { cache: "no-store" });
      if (st.ok) {
        const statement = parseIdentityStatement(await st.text());
        if (verifyIdentityStatement(statement).ok) attestedBy = `The self key ${body.selfKey}, whose signed identity statement names it ${statement.body.name}.`;
      }
    } catch {
      // No statement: the self key alone stands behind it.
    }
  }
  return {
    kind: "done",
    chain: !!chain,
    outcome: { ok: checks.every((c) => c.ok), kind: `A receipt of the AI self: ${RECEIPT_KIND[body.kind] ?? "an action"}`, headline: `${body.what}. Under: ${body.limit || "no limit named"}.`, attestedBy, checks, seals: true },
  };
}

export async function checkDocument(text: string): Promise<State> {
  let format = "";
  try {
    const v = JSON.parse(text) as { format?: unknown; receipt?: { format?: unknown } };
    format = String(v.format ?? v.receipt?.format ?? "");
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
    if (format === RECEIPT_FORMAT) return await checkReceiptDocument(text, chain, period);
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
    <div className="document-checker">
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
