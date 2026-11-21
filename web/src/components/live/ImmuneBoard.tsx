"use client";

import { useState } from "react";
import { fromHex32, immuneLeaf, parseImmuneRecord, verifyProof, type ImmuneRecord } from "@sigil/core";
import { formatDateTime, plural } from "@/lib/format";
import { useLive } from "./useLive";

interface Round {
  hour: number;
  record: ImmuneRecord;
  leaf: string;
  seal: { root: string; index: number; proof: string[] } | null;
}

interface ImmuneResponse {
  enabled: boolean;
  model: string | null;
  strains: number;
  periodSeconds: number;
  rounds: Round[];
}

const DEFENCE: Record<string, string> = {
  scanner: "held back by the scanner",
  neutraliser: "removed from the prompt",
  model: "the model did not follow it",
  error: "the model gave no answer",
};

type Check = { state: "ok" | "bad"; text: string } | null;

/** Recomputes a round's leaf from its record and walks its proof up to the seal the site publishes for that hour. */
async function checkRound(round: Round): Promise<Check> {
  const record = parseImmuneRecord(round.record);
  const leaf = immuneLeaf(record);
  if (leaf !== round.leaf) return { state: "bad", text: "The record does not hash to the leaf listed for it." };
  if (!round.seal) return { state: "bad", text: "This round is not sealed yet: its hour is still running." };
  const res = await fetch(`/api/seals/${round.hour}`, { cache: "no-store" });
  if (!res.ok) return { state: "bad", text: "The seal of this hour could not be read." };
  const { seal } = (await res.json()) as { seal: { root: string } };
  if (seal.root !== round.seal.root) return { state: "bad", text: "The root differs from the seal the site publishes." };
  const ok = verifyProof(fromHex32(seal.root), fromHex32(leaf), round.seal.proof.map(fromHex32));
  return ok ? { state: "ok", text: `The record hashes to its leaf, and the leaf leads to the seal of that hour (root ${seal.root.slice(0, 14)}...).` } : { state: "bad", text: "The proof does not lead from the leaf to the seal." };
}

export function ImmuneBoard() {
  const live = useLive<ImmuneResponse>("/api/immune", 60_000);
  const [checks, setChecks] = useState<Record<number, Check>>({});

  if (live.status === "loading") {
    return (
      <div className="loading" role="status">
        <span className="spinner" aria-hidden="true" /> Reading the record
      </div>
    );
  }
  if (live.status === "error") return <p className="notice notice-error">The record could not be read. Try again in a moment.</p>;
  const d = live.data;
  if (!d.enabled && d.rounds.length === 0) {
    return (
      <p className="notice" data-testid="immune-off">
        This node does not run the public test. Whoever runs it switches it on with SIGIL_IMMUNE_MODEL (a test model, or a model key of their own).
      </p>
    );
  }
  const latest = d.rounds[0];
  const all = d.rounds.flatMap((r) => r.record.results);
  const held = all.filter((r) => r.outcome === "held").length;
  return (
    <div className="immune-board" data-testid="immune-board">
      <p className="immune-summary" aria-live="polite">
        <span>{plural(d.rounds.length, "round")} shown</span>
        <span>
          {held} of {all.length} attempts held
        </span>
        <span>Model: {d.model === "stub" ? "the test model (follows every instruction it can read)" : (d.model ?? "none")}</span>
        <span>Strains version {d.strains}</span>
      </p>
      {latest ? (
        <section aria-labelledby="immune-latest">
          <h3 id="immune-latest" className="section-subtitle">
            Latest round, started {formatDateTime(new Date(latest.hour * d.periodSeconds * 1000).toISOString())}
          </h3>
          <div className="table-wrap">
            <table className="table immune-table">
              <thead>
                <tr>
                  <th scope="col">Strain</th>
                  <th scope="col">Varied as</th>
                  <th scope="col">Result</th>
                  <th scope="col">What held it</th>
                </tr>
              </thead>
              <tbody>
                {latest.record.results.map((r) => (
                  <tr key={r.strain} data-outcome={r.outcome} data-testid="immune-result">
                    <td className="mono">{r.strain}</td>
                    <td className="mono">{r.variant}</td>
                    <td>{r.outcome === "held" ? "Held" : "Got through"}</td>
                    <td>{r.defence ? DEFENCE[r.defence] : "nothing"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section aria-labelledby="immune-rounds">
        <h3 id="immune-rounds" className="section-subtitle">
          Every round, with its seal
        </h3>
        <ul className="list">
          {d.rounds.map((r) => {
            const c = checks[r.hour];
            const h = r.record.results.filter((x) => x.outcome === "held").length;
            return (
              <li key={r.hour} className="list-row" data-testid="immune-round">
                <div className="list-row-main">
                  <p className="list-row-title">
                    {formatDateTime(new Date(r.hour * d.periodSeconds * 1000).toISOString())}: {h} of {r.record.results.length} held
                  </p>
                  <p className="list-row-meta mono">leaf {r.leaf.slice(0, 18)}... {r.seal ? `sealed, root ${r.seal.root.slice(0, 14)}...` : "not sealed yet"}</p>
                  {c ? (
                    <p className={c.state === "ok" ? "small" : "small field-error"} data-testid="immune-check" data-state={c.state}>
                      {c.text}
                    </p>
                  ) : null}
                </div>
                <div className="list-row-actions">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => void checkRound(r).then((x) => setChecks((m) => ({ ...m, [r.hour]: x }))).catch(() => setChecks((m) => ({ ...m, [r.hour]: { state: "bad", text: "The check could not run." } })))}
                  >
                    Check it
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
