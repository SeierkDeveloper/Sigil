"use client";

// Checks proofs in this browser. The server only supplies the list of sibling
// fingerprints; the hashing and the comparison happen here, with the same code
// the vault uses (@sigil/core).

import { useEffect, useId, useState } from "react";
import { fromHex32, hex32, nodeHash, READ_KINDS, readEntryLeaf, verifyProof, type ReadEntryFields, type ReadKind } from "@sigil/core";
import { formatSealPeriod } from "@/lib/format";
import type { SealsResponse } from "./useLive";

export type VerifierMode = "fingerprint" | "entry" | "manual";

const MODE_LABEL: Record<VerifierMode, string> = {
  fingerprint: "A fingerprint",
  entry: "A log entry",
  manual: "A proof by hand",
};

interface Step {
  sibling: string;
  result: string;
}

type Result =
  | { ok: true; leaf: string; root: string; steps: Step[]; note: string }
  | { ok: false; reason: string; leaf?: string; steps?: Step[] };

const HEX32 = /^0x[0-9a-f]{64}$/;
const clean = (v: string) => v.trim().toLowerCase();

/** Walks a proof from the leaf to the root, keeping every step so it can be shown. */
function walk(leaf: string, proof: string[]): { root: string; steps: Step[] } {
  let node = fromHex32(leaf);
  const steps: Step[] = [];
  for (const sibling of proof) {
    node = nodeHash(node, fromHex32(sibling));
    steps.push({ sibling, result: hex32(node) });
  }
  return { root: hex32(node), steps };
}

async function getJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json();
    return res.ok ? { ok: true, data } : { ok: false, status: res.status, error: String(data?.error ?? "The server refused the request.") };
  } catch {
    return { ok: false, status: 0, error: "The server could not be reached." };
  }
}

async function checkFingerprint(hour: number, leaf: string): Promise<Result> {
  const proof = await getJson<{ root: string; leaf: string; proof: string[] }>(`/api/seals/${hour}/proof?leaf=${leaf}`);
  if (!proof.ok) return { ok: false, reason: proof.error, leaf };
  const published = await getJson<{ seal: { root: string } }>(`/api/seals/${hour}`);
  if (!published.ok) return { ok: false, reason: published.error, leaf };
  const { root, steps } = walk(leaf, proof.data.proof);
  if (root !== published.data.seal.root) return { ok: false, reason: "The proof does not lead to the published seal.", leaf, steps };
  return { ok: true, leaf, root, steps, note: "This fingerprint is part of the seal. The hashing was done in this browser." };
}

function parseEntry(text: string): (ReadEntryFields & { hour: number }) | string {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    return "That is not valid JSON. Paste the entry exactly as it was copied from your read log.";
  }
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  const id = str("id");
  const appId = str("appId");
  const kind = str("kind");
  const at = str("at");
  const salt = str("salt");
  if (!id || !appId || !at || !salt || !kind || !(READ_KINDS as readonly string[]).includes(kind)) {
    return "The entry is missing a field. It needs id, appId, kind, memoryId, count, at, salt and hour.";
  }
  if (typeof v.count !== "number" || typeof v.hour !== "number") return "The entry needs count and hour as numbers.";
  const memoryId = typeof v.memoryId === "string" ? v.memoryId : null;
  return { id, appId, kind: kind as ReadKind, memoryId, count: v.count, at, salt, hour: v.hour };
}

export function Verifier({ modes = ["fingerprint", "entry", "manual"] }: { modes?: VerifierMode[] }) {
  const uid = useId();
  const [mode, setMode] = useState<VerifierMode>(modes[0]);
  const [seals, setSeals] = useState<SealsResponse | null>(null);
  const [hour, setHour] = useState("");
  const [leaf, setLeaf] = useState("");
  const [entry, setEntry] = useState("");
  const [root, setRoot] = useState("");
  const [proofText, setProofText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/seals?limit=200")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: SealsResponse) => {
        if (!alive) return;
        setSeals(d);
        setHour((h) => h || (d.seals[0] ? String(d.seals[0].hour) : ""));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const choose = (m: VerifierMode) => {
    setMode(m);
    setResult(null);
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      if (mode === "manual") {
        const r = clean(root);
        const l = clean(leaf);
        const siblings = proofText.split(/[\s,]+/).map(clean).filter(Boolean);
        if (!HEX32.test(r) || !HEX32.test(l)) return setResult({ ok: false, reason: "The seal root and the fingerprint are each 0x followed by 64 hex characters." });
        if (siblings.some((s) => !HEX32.test(s))) return setResult({ ok: false, reason: "Every line of the proof is 0x followed by 64 hex characters." });
        const walked = walk(l, siblings);
        const ok = verifyProof(fromHex32(r), fromHex32(l), siblings.map(fromHex32));
        return setResult(
          ok
            ? { ok: true, leaf: l, root: r, steps: walked.steps, note: "The proof leads to this root. Nothing was sent anywhere; it was checked on this page alone." }
            : { ok: false, reason: "The proof does not lead to this root.", leaf: l, steps: walked.steps },
        );
      }
      if (mode === "entry") {
        const parsed = parseEntry(entry);
        if (typeof parsed === "string") return setResult({ ok: false, reason: parsed });
        const computed = hex32(readEntryLeaf(parsed));
        return setResult(await checkFingerprint(parsed.hour, computed));
      }
      const l = clean(leaf);
      if (!/^\d{1,12}$/.test(hour.trim())) return setResult({ ok: false, reason: "Choose a seal, or type its number." });
      if (!HEX32.test(l)) return setResult({ ok: false, reason: "A fingerprint is 0x followed by 64 hex characters." });
      setResult(await checkFingerprint(Number(hour.trim()), l));
    } catch {
      setResult({ ok: false, reason: "That could not be checked. Look at the values and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="verifier">
      {modes.length > 1 ? (
        <div className="segmented" role="group" aria-label="What to check">
          {modes.map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => choose(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="verifier-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {mode === "fingerprint" ? (
          <>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-hour`}>
                Seal
              </label>
              {seals && seals.seals.length > 0 ? (
                <select id={`${uid}-hour`} className="select" value={hour} onChange={(e) => setHour(e.target.value)}>
                  {seals.seals.map((s) => (
                    <option key={s.hour} value={s.hour}>
                      {formatSealPeriod(s.hour, seals.periodSeconds)} (number {s.hour})
                    </option>
                  ))}
                </select>
              ) : (
                <input id={`${uid}-hour`} className="input" inputMode="numeric" placeholder="Seal number" value={hour} onChange={(e) => setHour(e.target.value)} />
              )}
              <p className="field-hint">{seals && seals.seals.length === 0 ? "No hour has been sealed on this server yet, so there is nothing to check so far." : "The hour the read happened in."}</p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-leaf`}>
                Fingerprint
              </label>
              <input id={`${uid}-leaf`} className="input mono" placeholder="0x" spellCheck={false} autoComplete="off" value={leaf} onChange={(e) => setLeaf(e.target.value)} />
              <p className="field-hint">The salted hash of one read. A fingerprint alone says nothing about what was read.</p>
            </div>
          </>
        ) : null}

        {mode === "entry" ? (
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-entry`}>
              Entry from your read log
            </label>
            <textarea
              id={`${uid}-entry`}
              className="textarea mono"
              rows={10}
              spellCheck={false}
              placeholder={'{\n  "id": "",\n  "appId": "",\n  "kind": "read",\n  "memoryId": "",\n  "count": 1,\n  "at": "",\n  "salt": "",\n  "hour": 0\n}'}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
            <p className="field-hint">
              In your vault, open Read log, press Verify on a sealed row, then Copy entry. The fingerprint is computed here from these fields; only
              the fingerprint is sent to the server.
            </p>
          </div>
        ) : null}

        {mode === "manual" ? (
          <>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-root`}>
                Seal root
              </label>
              <input id={`${uid}-root`} className="input mono" placeholder="0x" spellCheck={false} autoComplete="off" value={root} onChange={(e) => setRoot(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-mleaf`}>
                Fingerprint
              </label>
              <input id={`${uid}-mleaf`} className="input mono" placeholder="0x" spellCheck={false} autoComplete="off" value={leaf} onChange={(e) => setLeaf(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-proof`}>
                Proof, one fingerprint per line
              </label>
              <textarea id={`${uid}-proof`} className="textarea mono" rows={5} spellCheck={false} placeholder="0x" value={proofText} onChange={(e) => setProofText(e.target.value)} />
              <p className="field-hint">Leave empty when the seal holds a single read: its fingerprint is then the root. Nothing on this tab is sent to the server.</p>
            </div>
          </>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Checking" : "Check"}
          </button>
        </div>
      </form>

      {result ? (
        <div className="verifier-result" data-ok={result.ok ? "true" : "false"} role="status" data-testid="verifier-result">
          <p className={result.ok ? "notice notice-success" : "notice notice-error"}>
            <span>{result.ok ? result.note : result.reason}</span>
          </p>
          {result.leaf ? (
            <ol className="proof-steps">
              <li>
                <span className="proof-step-label">Fingerprint</span>
                <code>{result.leaf}</code>
              </li>
              {(result.steps ?? []).map((s, i) => (
                <li key={`${s.sibling}-${i}`}>
                  <span className="proof-step-label">Hashed with</span>
                  <code>{s.sibling}</code>
                  <span className="proof-step-label">gives</span>
                  <code>{s.result}</code>
                </li>
              ))}
              {result.ok ? (
                <li data-final="true">
                  <span className="proof-step-label">Seal root</span>
                  <code>{result.root}</code>
                </li>
              ) : null}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
