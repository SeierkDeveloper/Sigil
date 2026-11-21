"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { sourceLabel, type ImmuneFinding } from "@sigil/core";
import { formatDateTime, plural } from "@/lib/format";
import * as ops from "../ops";
import { errorText, useVault } from "../context";
import { approveHeld, heldMemories, modelSecondOpinion, reportCaught, type HeldMemory } from "../immuneOps";
import { modelCaller } from "../selfOps";
import { Notice, PlateHead } from "../ui";

/** What this page reported already, so a reload of the data does not count the same memory twice. */
const reported = new Set<string>();

/** A few lines around the first finding, with every flagged place marked. */
function Excerpt({ text, findings }: { text: string; findings: ImmuneFinding[] }) {
  const marked = findings.filter((f) => f.weight > 0 || f.rule === "hidden");
  if (!marked.length) return <p className="held-excerpt">{text.slice(0, 240)}</p>;
  const from = Math.max(0, marked[0].start - 80);
  const to = Math.min(text.length, Math.max(marked[0].end + 160, from + 240));
  const parts: React.ReactNode[] = [];
  let at = from;
  for (const f of marked) {
    if (f.end <= at || f.start >= to) continue;
    const s = Math.max(f.start, at);
    parts.push(<Fragment key={`t${s}`}>{text.slice(at, s)}</Fragment>);
    const inner = text.slice(s, Math.min(f.end, to));
    parts.push(
      <mark key={`m${s}`} className="held-mark" title={f.rule}>
        {f.rule === "hidden" ? "[invisible characters]" : inner}
      </mark>,
    );
    at = Math.min(f.end, to);
  }
  parts.push(<Fragment key="end">{text.slice(at, to)}</Fragment>);
  return (
    <p className="held-excerpt">
      {from > 0 ? "..." : ""}
      {parts}
      {to < text.length ? "..." : ""}
    </p>
  );
}

/**
 * Held for review: memories from outside (mail, chats, imports, apps, shared
 * memory) that seem to carry instructions for an AI. They reach no model, no
 * app, no link and no public page until the owner lets them through.
 */
export function HeldForReview() {
  const { api, data, update, openMemory } = useVault();
  const held = useMemo(() => heldMemories(data), [data]);
  const [extra, setExtra] = useState<HeldMemory[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const all = [...held, ...extra.filter((x) => !held.some((h) => h.memory.id === x.memory.id) && data.memories.some((m) => m.id === x.memory.id))];

  // Each memory held for the first time on this page goes on the record once.
  useEffect(() => {
    const fresh = held.filter((h) => !reported.has(h.memory.id));
    for (const h of fresh) reported.add(h.memory.id);
    reportCaught(api, "quarantine", fresh.length);
  }, [api, held]);

  const model = data.immune.model ? modelCaller(data) : null;
  const second = async () => {
    if (!model) return;
    setBusy("model");
    setError(null);
    try {
      const more = await modelSecondOpinion(data, model, asked.current);
      setExtra((x) => [...x, ...more]);
      reportCaught(api, "quarantine", more.length);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
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
    <section className="subpanel plate held" aria-labelledby="held-title" data-testid="held">
      <PlateHead
        number="00"
        id="held-title"
        title="Held for review"
        lead="Memories from outside that seem to carry instructions for an AI. Until you let one through, no app, AI self, link or public page sees it."
      >
        <span className="plate-state" data-on={all.length ? "true" : "false"}>
          {all.length ? plural(all.length, "memory", "memories") : "Nothing held"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {all.length === 0 ? (
        <p className="quiet">
          Nothing is held. Mail, chats, imports and suggestions are checked on this device as they arrive; the owner&apos;s own notes are not. You can set how strict the
          check is under Settings.
        </p>
      ) : (
        <ul className="list held-list">
          {all.map((h) => (
            <li key={h.memory.id} className="list-row held-row" data-testid="held-row">
              <div className="list-row-main">
                <p className="list-row-title">{h.memory.title}</p>
                <p className="list-row-meta">
                  {sourceLabel(h.memory.source)}, {formatDateTime(h.memory.editedAt)}. Why: {h.reasons.join("; ")}.
                </p>
                <Excerpt text={`${h.memory.title}\n${h.memory.body}`} findings={h.result.findings} />
              </div>
              <div className="list-row-actions">
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!busy}
                  onClick={() =>
                    void act(h.memory.id, async () => {
                      const m = await approveHeld(api, data, h.memory);
                      update((d) => ({ ...d, memories: d.memories.map((x) => (x.id === m.id ? m : x)) }));
                      setExtra((x) => x.filter((y) => y.memory.id !== m.id));
                    })
                  }
                >
                  Let it through
                </button>
                <button type="button" className="button button-small button-ghost" onClick={() => openMemory(h.memory.id)}>
                  Open
                </button>
                <button
                  type="button"
                  className="button button-small button-ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void act(h.memory.id, async () => {
                      await ops.deleteMemories(api, [h.memory.id]);
                      update((d) => ({ ...d, memories: d.memories.filter((x) => x.id !== h.memory.id) }));
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {model ? (
        <div className="row">
          <button type="button" className="button button-small button-ghost" onClick={() => void second()} disabled={!!busy}>
            {busy === "model" ? "Asking your model" : "Ask my model about borderline memories"}
          </button>
          <span className="small muted">Sends up to ten borderline memories to your own model, with your own key, from this browser.</span>
        </div>
      ) : null}
    </section>
  );
}
