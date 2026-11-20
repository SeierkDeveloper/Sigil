"use client";

// A knowledge pack's public page: the pack as its publisher signed it, checked
// in this browser, and a way to follow it from your own vault. Free.

import { useEffect, useState } from "react";
import { parsePack, signingFingerprint, verifyPack, type KnowledgePack, type PackResult } from "@sigil/core";
import { PackIcon } from "@/components/icons";
import { formatDate, plural } from "@/lib/format";

type Phase = { kind: "loading" } | { kind: "broken"; message: string } | { kind: "open"; pack: KnowledgePack; check: PackResult };

export function PackApp({ packId }: { packId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    fetch(`/api/packs/at/${packId}`, { cache: "no-store" })
      .then(async (res) => {
        const text = await res.text();
        if (!res.ok) throw new Error((JSON.parse(text) as { error?: string }).error ?? "This pack could not be loaded.");
        const pack = parsePack(text);
        if (alive) setPhase({ kind: "open", pack, check: verifyPack(pack) });
      })
      .catch((err) => alive && setPhase({ kind: "broken", message: (err as Error).message }));
    return () => {
      alive = false;
    };
  }, [packId]);

  if (phase.kind !== "open") {
    return (
      <div className="page pack-page">
        <div className="container container-narrow">
          <p className="eyebrow">Knowledge pack</p>
          <p className="page-lead" role={phase.kind === "broken" ? "alert" : "status"}>
            {phase.kind === "loading" ? "Loading the pack." : phase.message}
          </p>
        </div>
      </div>
    );
  }
  const { pack, check } = phase;
  const b = pack.body;
  return (
    <div className="page pack-page">
      <div className="container container-narrow">
        <header className="page-header">
          <p className="eyebrow">Knowledge pack, version {b.version}</p>
          <h1 className="page-title">{b.title}</h1>
          {b.description ? <p className="page-lead">{b.description}</p> : null}
        </header>
        <section className="panel pack-card" data-ok={check.ok ? "true" : "false"} data-testid="pack-page">
          <p className="verifier-verdict">{check.ok ? "Signed by its publisher" : "Does not check out"}</p>
          <ul className="proof-steps">
            {check.checks.map((c) => (
              <li key={c.name} data-ok={c.ok ? "true" : "false"}>
                {c.detail}
              </li>
            ))}
          </ul>
          <p className="small muted">
            Published by {b.publisher.name || "a Sigil vault"} on {formatDate(b.publishedAt)}, vault key {signingFingerprint(b.publisher.signingKey)}. {plural(b.items.length, "memory", "memories")}.
          </p>
          <div className="row">
            <a className="button button-primary" href={`/vault?follow=${encodeURIComponent(b.id)}#packs`}>
              <PackIcon /> Follow in your vault
            </a>
          </div>
          <p className="small faint">
            Following copies the pack into a folder of your own vault and takes in each new version, checked against this publisher. It is free. Your AI self or your agents read
            it only if you give them that folder.
          </p>
        </section>
        <ol className="pack-items">
          {b.items.map((i) => (
            <li key={i.id} className="pack-item">
              <details>
                <summary className="pack-item-title">{i.title}</summary>
                <p className="pack-item-body">{i.body}</p>
              </details>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
