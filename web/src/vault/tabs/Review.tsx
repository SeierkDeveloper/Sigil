"use client";

import { useEffect, useMemo, useState } from "react";
import { checkContradiction, cleanThinking, hkdf, MAX_GRACE_DAYS, toHex, type Memory, type ThinkingSettings } from "@sigil/core";
import { formatDate, plural } from "@/lib/format";
import * as selfOps from "../selfOps";
import * as think from "../thinkOps";
import { errorText, useVault } from "../context";
import { SourceMark } from "../marks";
import { Notice, PlateHead, Quiet } from "../ui";

/** Memory that thinks: the weekly brief, memories that disagree, and what has expired. All of it worked out on this device. */
export function ReviewTab() {
  return (
    <div className="review">
      <div className="panel-header">
        <h2 className="panel-title">Review</h2>
        <p className="small muted">Your vault, looked over on this device: a brief of the week, memories that disagree, and memories that have expired.</p>
      </div>
      <BriefSection />
      <ContradictionsSection />
      <ExpiredSection />
    </div>
  );
}

// ---------------------------------------------------------------- the brief

function BriefSection() {
  const { api, vault, data, update, openMemory } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const latest = think.briefs(data)[0] ?? null;

  const make = async () => {
    setBusy("make");
    setError(null);
    setNote(null);
    try {
      const model = data.thinking.briefWithModel ? selfOps.modelCaller(data) : null;
      const r = await think.makeBrief(api, vault, data, model);
      update((d) => ({ ...d, folders: r.createdFolder ? [...d.folders, r.folder] : d.folders, memories: [r.memory, ...d.memories] }));
      setNote(r.usedModel ? "Written by your model and saved in Briefs." : "Saved in Briefs.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const setThinking = async (patch: Partial<ThinkingSettings>) => {
    setBusy("settings");
    setError(null);
    try {
      const next = cleanThinking({ ...data.thinking, ...patch });
      await selfOps.saveThinking(api, vault, next);
      update((d) => ({ ...d, thinking: next }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate brief" aria-labelledby="brief-title">
      <PlateHead number="01" id="brief-title" title="Weekly brief" lead="What is new, what changed, and what you may have forgotten, saved as a memory in the Briefs folder.">
        <span className="plate-state" data-on={data.thinking.weeklyBrief ? "true" : "false"}>
          {data.thinking.weeklyBrief ? "Every week" : "By hand"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      <div className="brief-layout">
        {latest ? (
          <article className="brief-latest" data-testid="brief-latest">
            <header className="brief-head">
              <SourceMark kind="brief" />
              <p className="brief-title">
                <button type="button" className="text-button" onClick={() => openMemory(latest.id)}>
                  {latest.title}
                </button>
              </p>
            </header>
            <BriefBody text={latest.body} />
          </article>
        ) : (
          <div className="brief-latest brief-none">
            <Quiet>No brief yet.</Quiet>
            <p className="small faint">With the weekly switch on, the first one is written once your vault is a week old. The button writes one now.</p>
          </div>
        )}
        <div className="brief-side">
          <label className="checkbox suggest-toggle" htmlFor="brief-auto">
            <input id="brief-auto" type="checkbox" checked={data.thinking.weeklyBrief} disabled={busy === "settings"} onChange={(e) => void setThinking({ weeklyBrief: e.target.checked })} />
            <span>Make one when I open my vault and the last is a week old</span>
          </label>
          <label className="checkbox suggest-toggle" htmlFor="brief-model">
            <input
              id="brief-model"
              type="checkbox"
              checked={data.thinking.briefWithModel}
              disabled={busy === "settings" || !data.model}
              onChange={(e) => void setThinking({ briefWithModel: e.target.checked })}
            />
            <span>Let my model write it{data.model ? "" : " (add a model key under AI self)"}. Without it, the brief is three plain lists.</span>
          </label>
          <button type="button" className="button button-block" onClick={() => void make()} disabled={!!busy}>
            {busy === "make" ? "Writing" : "Make a brief now"}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * A brief is plain text with a few marks: "## " opens a part and "- " a line of a list.
 * They are set as headings and lists; the marks stay in the text for a reader that copies it.
 */
function BriefBody({ text }: { text: string }) {
  const blocks: { kind: "h" | "ul" | "p"; mark?: string; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const h = /^(#{1,3} )(.*)$/.exec(line);
    const li = /^([-*] )(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (h) blocks.push({ kind: "h", mark: h[1], lines: [h[2]] });
    else if (li && last?.kind === "ul") last.lines.push(li[2]);
    else if (li) blocks.push({ kind: "ul", mark: li[1], lines: [li[2]] });
    else if (last?.kind === "p" && last.lines.length) last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return (
    <div className="brief-body">
      {blocks.map((b, i) =>
        b.kind === "h" ? (
          <h4 key={i}>
            <span className="visually-hidden">{b.mark}</span>
            {b.lines[0]}
          </h4>
        ) : b.kind === "ul" ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>
                <span className="visually-hidden">{b.mark}</span>
                {l}
              </li>
            ))}
          </ul>
        ) : b.lines.length ? (
          <p key={i}>{b.lines.join("\n")}</p>
        ) : null,
      )}
    </div>
  );
}

// ---------------------------------------------------------------- contradictions

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Pairs the owner said do not disagree, kept in this browser under a name derived from the vault key. */
function useDismissed(raw: Uint8Array) {
  const [scope, setScope] = useState<string | null>(null);
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void hkdf(raw, "sigil:contradictions-dismissed", 8).then((b) => {
      if (!alive) return;
      const s = toHex(b);
      setScope(s);
      try {
        const all = JSON.parse(localStorage.getItem(think.CONTRADICTIONS_DISMISSED) ?? "{}") as Record<string, string[]>;
        setList(Array.isArray(all[s]) ? all[s] : []);
      } catch {
        setList([]);
      }
    });
    return () => {
      alive = false;
    };
  }, [raw]);
  const add = (key: string) => {
    const next = [...list, key];
    setList(next);
    if (!scope) return;
    try {
      const all = JSON.parse(localStorage.getItem(think.CONTRADICTIONS_DISMISSED) ?? "{}") as Record<string, string[]>;
      all[scope] = next.slice(-2000);
      localStorage.setItem(think.CONTRADICTIONS_DISMISSED, JSON.stringify(all));
    } catch {
      // Storage is not available; the choice holds for this visit.
    }
  };
  return { dismissed: new Set(list), dismiss: add };
}

function ContradictionsSection() {
  const { api, vault, data, update, semantic, openMemory } = useVault();
  const { dismissed, dismiss } = useDismissed(vault.raw);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const found = useMemo(() => think.contradictions(data, semantic.vectors).filter((c) => !dismissed.has(pairKey(c.a.id, c.b.id))), [data, semantic.vectors, dismissed]);
  const model = data.thinking.contradictionsWithModel ? selfOps.modelCaller(data) : null;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const keep = (keepIt: Memory, drop: Memory) =>
    act(pairKey(keepIt.id, drop.id), async () => {
      await think.keepOne(api, drop);
      update((d) => ({ ...d, memories: d.memories.filter((m) => m.id !== drop.id) }));
    });

  const check = (a: Memory, b: Memory) =>
    act(`check:${pairKey(a.id, b.id)}`, async () => {
      if (!model) return;
      const v = await checkContradiction(model, { title: a.title, text: a.body }, { title: b.title, text: b.body });
      setVerdicts((x) => ({ ...x, [pairKey(a.id, b.id)]: v.contradicts ? `Your model says they disagree: ${v.why}` : `Your model says they can both be true: ${v.why}` }));
    });

  const setUseModel = (on: boolean) =>
    act("settings", async () => {
      const next = cleanThinking({ ...data.thinking, contradictionsWithModel: on });
      await selfOps.saveThinking(api, vault, next);
      update((d) => ({ ...d, thinking: next }));
    });

  return (
    <section className="subpanel plate contradictions" aria-labelledby="contradictions-title">
      <PlateHead
        number="02"
        id="contradictions-title"
        title="Memories that disagree"
        lead={
          <>
            Pairs about the same thing that seem to say different things: one says no where the other says yes, opposite words, or other numbers and dates.{" "}
            {semantic.status.state === "ready" ? "Found by meaning and words." : "Found by words; by meaning once search by meaning is ready."} You decide which is true.
          </>
        }
      >
        <span className="plate-state" data-on={found.length ? "true" : "false"}>
          {found.length ? plural(found.length, "pair") : "None"}
        </span>
      </PlateHead>
      <label className="checkbox suggest-toggle" htmlFor="contradictions-model">
        <input id="contradictions-model" type="checkbox" checked={data.thinking.contradictionsWithModel} disabled={!data.model || busy === "settings"} onChange={(e) => void setUseModel(e.target.checked)} />
        <span>Let me ask my model about a pair{data.model ? "" : " (add a model key under AI self)"}</span>
      </label>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {found.length === 0 ? (
        <Quiet>No memories that disagree.</Quiet>
      ) : (
        <ul className="contradiction-list">
          {found.slice(0, 30).map((c) => {
            const key = pairKey(c.a.id, c.b.id);
            return (
              <li key={key} className="contradiction" data-testid="contradiction">
                <p className="contradiction-why">{c.signals.join(". ")}</p>
                <div className="contradiction-pair">
                  {[c.a, c.b].map((m, i) => {
                    const other = i === 0 ? c.b : c.a;
                    return (
                      <div key={m.id} className="contradiction-side">
                        <p className="contradiction-title">
                          <button type="button" className="text-button" onClick={() => openMemory(m.id)}>
                            {m.title}
                          </button>
                          <span className="contradiction-date"> {formatDate(m.editedAt)}</span>
                        </p>
                        <p className="contradiction-text">{m.snippet}</p>
                        <button type="button" className="button button-small" disabled={busy === key} onClick={() => void keep(m, other)}>
                          Keep &quot;{short(m.title)}&quot;
                        </button>
                      </div>
                    );
                  })}
                </div>
                {verdicts[key] ? <p className="contradiction-verdict">{verdicts[key]}</p> : null}
                <div className="contradiction-actions">
                  {model ? (
                    <button type="button" className="button button-small button-ghost" disabled={busy === `check:${key}`} onClick={() => void check(c.a, c.b)}>
                      {busy === `check:${key}` ? "Asking" : "Ask my model"}
                    </button>
                  ) : null}
                  <button type="button" className="button button-small button-ghost" onClick={() => dismiss(key)}>
                    Both are true
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function short(title: string): string {
  return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

// ---------------------------------------------------------------- expired

function ExpiredSection() {
  const { api, vault, data, update, openMemory } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grace, setGrace] = useState(String(data.thinking.graceDays));
  const [saved, setSaved] = useState<string | null>(null);
  const list = think.expired(data);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setSaved(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const restore = (m: Memory) =>
    act(m.id, async () => {
      const next = await think.setExpiry(api, data, m, null);
      update((d) => ({ ...d, memories: [next, ...d.memories.filter((x) => x.id !== next.id)] }));
    });

  const deleteNow = (m: Memory) =>
    act(m.id, async () => {
      await think.keepOne(api, m);
      update((d) => ({ ...d, memories: d.memories.filter((x) => x.id !== m.id) }));
    });

  const saveGrace = (e: React.FormEvent) => {
    e.preventDefault();
    void act("grace", async () => {
      const days = Number(grace);
      if (!Number.isInteger(days) || days < 0 || days > MAX_GRACE_DAYS) throw new Error(`Choose 0 to ${MAX_GRACE_DAYS} days.`);
      const next = cleanThinking({ ...data.thinking, graceDays: days });
      await selfOps.saveThinking(api, vault, next);
      const n = await think.applyGrace(api, data, days);
      update((d) => ({ ...d, thinking: next }));
      setSaved(n ? `Saved. ${plural(n, "expiring memory", "expiring memories")} now follow it.` : "Saved.");
    });
  };

  const graceEnd = (m: Memory) => new Date(new Date(m.expiresAt!).getTime() + data.thinking.graceDays * 86_400_000).toISOString();

  return (
    <section className="subpanel plate expired" aria-labelledby="expired-title">
      <PlateHead
        number="03"
        id="expired-title"
        title="Expired"
        lead="Memories past the expiry date you gave them. Apps no longer see them. Each is deleted for real when the grace period after its expiry is over, by the server, even while your vault is closed. The server knows that time, and nothing else about the memory."
      >
        <span className="plate-state" data-on={list.length ? "true" : "false"}>
          {list.length ? plural(list.length, "memory", "memories") : "None"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">{saved}</Notice> : null}
      <form className="grace-form" onSubmit={saveGrace} aria-label="Grace period">
        <label className="field-label" htmlFor="grace-days">
          Grace period in days
        </label>
        <input id="grace-days" className="input" type="number" min={0} max={MAX_GRACE_DAYS} value={grace} onChange={(e) => setGrace(e.target.value)} />
        <button type="submit" className="button button-small" disabled={busy === "grace" || grace === String(data.thinking.graceDays)}>
          {busy === "grace" ? "Saving" : "Save"}
        </button>
      </form>
      {list.length === 0 ? (
        <Quiet>Nothing has expired. Give a memory an expiry date in its editor.</Quiet>
      ) : (
        <ul className="list expired-list">
          {list.map((m) => (
            <li key={m.id} className="list-row" data-testid="expired-row">
              <div className="list-row-main">
                <p className="list-row-title">
                  <button type="button" className="text-button" onClick={() => openMemory(m.id)}>
                    {m.title}
                  </button>
                </p>
                <p className="list-row-meta">
                  Expired {formatDate(m.expiresAt!)}. Deleted for real on {formatDate(graceEnd(m))}.
                </p>
              </div>
              <div className="list-row-actions">
                <button type="button" className="button button-small" disabled={busy === m.id} onClick={() => void restore(m)}>
                  Keep it
                </button>
                <button type="button" className="button button-small button-ghost" disabled={busy === m.id} onClick={() => void deleteNow(m)}>
                  Delete now
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
