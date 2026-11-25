"use client";

// A model of you: the folders it learns from, the lessons it wrote, the choices
// that train its ranker on this device, how well it knows you, whether apps
// may read it, and its history. Everything is kept encrypted in the vault.

import { useMemo, useState } from "react";
import { LESSON_KIND_NAME, LESSON_KINDS, nextPair, YOU_MIN_CHOICES, type YouState } from "@sigil/core";
import { formatDateTime, plural } from "@/lib/format";
import * as holderOps from "../holderOps";
import { errorText, useVault } from "../context";
import { Notice, PlateHead } from "../ui";
import { addChoice, dropLesson, learnLessons, rollBack, saveYou, syncYouMemory, trainOnDevice, withYouMemory, youFolders, youPool } from "../youOps";

const snippet = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);

export function YouTab() {
  const { api, vault, data, update, openMemory, goTo } = useVault();
  const you = data.you;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seed, setSeed] = useState(() => Date.now() & 0x7fffffff);

  const folders = useMemo(() => youFolders(data), [data]);
  const pool = useMemo(() => youPool(data, you), [data, you]);
  const byId = useMemo(() => new Map(data.memories.map((m) => [m.id, m])), [data.memories]);
  const pair = useMemo(() => nextPair(pool, you.choices, seed), [pool, you.choices, seed]);
  const caller = holderOps.answerCaller(data, api);

  /** Saves a new state, keeps the memory apps read in step, and shows it. */
  const commit = async (next: YouState, done: string | null, label: string) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await saveYou(api, vault, next);
      update((d) => ({ ...d, you: next }));
      const synced = await syncYouMemory(api, vault, data, next);
      if (synced.written || synced.removed.length) update((d) => withYouMemory(d, synced));
      setNote(done);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async (label: string, fn: () => Promise<YouState> | YouState, done: (s: YouState) => string) => {
    setBusy(label);
    setError(null);
    setNote(null);
    let next: YouState;
    try {
      next = await fn();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
      return;
    }
    await commit(next, done(next), label);
  };

  const toggleFolder = (id: string, on: boolean) =>
    void commit({ ...you, folders: on ? [...new Set([...you.folders, id])] : you.folders.filter((f) => f !== id), updatedAt: new Date().toISOString() }, null, "folders");

  const choose = (win: string, lose: string) => {
    const next = addChoice(you, win, lose);
    const usable = next.choices.length;
    setSeed((s) => (s * 1103515245 + 12345) & 0x7fffffff);
    // Every tenth choice trains the model again, here in the browser.
    if (usable >= YOU_MIN_CHOICES && usable % 10 === 0) {
      void run("train", () => trainOnDevice(data, next), (s) => `Trained on ${plural(s.ranker?.trainedOn ?? 0, "choice")} on this device.`);
    } else {
      void commit(next, null, "choice");
    }
  };

  const history = [...you.history].reverse();
  const latest = history[0]?.at;

  return (
    <div className="you">
      <div className="panel-header">
        <h2 className="panel-title">A model of you</h2>
        <p className="small muted">
          Sigil learns how you write, what matters most to you and where your limits are, only from the folders you choose. A small model is trained here in your
          browser on the choices you make. All of it is encrypted in your vault, and you can undo any part of it.
        </p>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}

      <section className="subpanel plate" aria-labelledby="you-folders">
        <PlateHead number="01" id="you-folders" title="Folders it learns from" lead="Nothing outside these folders is read. Protected folders are never read here.">
          <span className="plate-state" data-on={you.folders.length ? "true" : "false"}>
            {plural(you.folders.length, "folder")}
          </span>
        </PlateHead>
        {folders.length ? (
          <ul className="you-folders">
            {folders.map((f) => (
              <li key={f.id}>
                <label className="checkbox">
                  <input type="checkbox" checked={you.folders.includes(f.id)} disabled={!!busy || f.protect} onChange={(e) => toggleFolder(f.id, e.target.checked)} />
                  <span>
                    {f.name} <span className="faint small">{f.protect ? "Protected" : plural(f.count, "memory", "memories")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Make a folder and save a few memories first.</p>
        )}
      </section>

      <section className="subpanel plate" aria-labelledby="you-lessons">
        <PlateHead
          number="02"
          id="you-lessons"
          title="Lessons"
          lead={you.learnedAt ? `Learned ${formatDateTime(you.learnedAt)} from ${plural(you.learnedFrom, "memory", "memories")}.` : "Plain sentences about you, each linked to the memories it came from."}
        />
        {you.lessons.length ? (
          <div className="you-lessons">
            {LESSON_KINDS.map((k) => {
              const ls = you.lessons.filter((l) => l.kind === k);
              if (!ls.length) return null;
              return (
                <div key={k} className="you-lesson-group">
                  <h4 className="you-lesson-kind">{LESSON_KIND_NAME[k]}</h4>
                  <ul>
                    {ls.map((l) => (
                      <li key={l.id} className="you-lesson">
                        <p className="you-lesson-text">{l.text}</p>
                        <p className="you-lesson-from small faint">
                          From{" "}
                          {l.sources.map((id, i) => {
                            const m = byId.get(id);
                            return (
                              <span key={id}>
                                {i ? ", " : ""}
                                {m ? (
                                  <button type="button" className="text-button" onClick={() => openMemory(id)}>
                                    {snippet(m.title, 48)}
                                  </button>
                                ) : (
                                  "a memory since deleted"
                                )}
                              </span>
                            );
                          })}
                        </p>
                        <button type="button" className="text-button you-lesson-remove" disabled={!!busy} onClick={() => void run("drop", () => dropLesson(you, l.id), () => "Lesson removed. It will not come back.")}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : null}
        {caller ? (
          <div className="form-actions">
            <button
              type="button"
              className={you.lessons.length ? "button" : "button button-primary"}
              disabled={!!busy || pool.length < 3}
              data-testid="you-learn"
              onClick={() => void run("learn", () => learnLessons(data, you, caller), (s) => `${plural(s.lessons.length, "lesson")} learned.`)}
            >
              {busy === "learn" ? "Reading your memories" : you.lessons.length ? "Learn again" : "Learn from my folders"}
            </button>
            {pool.length < 3 ? <span className="small muted">Choose folders with at least 3 memories.</span> : null}
          </div>
        ) : (
          <p className="small muted">
            Learning lessons needs a model: add your own model key under{" "}
            <button type="button" className="text-button" onClick={() => goTo("self")}>
              AI self
            </button>
            , or link your wallet under{" "}
            <button type="button" className="text-button" onClick={() => goTo("holder")}>
              Holder
            </button>{" "}
            for included answers.
          </p>
        )}
        <p className="small faint">The memories go from this device to the model for this one answer and are not kept there. Each round reads up to 60 of the newest.</p>
      </section>

      <section className="subpanel plate" aria-labelledby="you-teach">
        <PlateHead number="03" id="you-teach" title="Which matters more to you?" lead="Each choice teaches the model on this device to rank things the way you do.">
          <span className="plate-state" data-on={you.choices.length ? "true" : "false"} data-testid="you-choices">
            {plural(you.choices.length, "choice")}
          </span>
        </PlateHead>
        {pair ? (
          <div className="you-pair">
            {pair.map((m, i) => (
              <button key={m.id} type="button" className="you-pick" disabled={!!busy} onClick={() => choose(m.id, pair[1 - i].id)} data-testid={`you-pick-${i}`}>
                <span className="you-pick-folder mono small faint">{m.folder}</span>
                <span className="you-pick-title">{snippet(m.title, 80)}</span>
                <span className="you-pick-body small muted">{snippet(m.body)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="small muted">{pool.length < 2 ? "Choose folders with at least 2 memories to start." : "You have answered every pair for now. Add memories or folders for more."}</p>
        )}
        <div className="form-actions">
          {pair ? (
            <button type="button" className="button button-ghost" disabled={!!busy} onClick={() => setSeed((s) => (s * 1103515245 + 12345) & 0x7fffffff)}>
              Skip this pair
            </button>
          ) : null}
          <button
            type="button"
            className="button"
            disabled={!!busy || you.choices.length < YOU_MIN_CHOICES}
            onClick={() => void run("train", () => trainOnDevice(data, you), (s) => `Trained on ${plural(s.ranker?.trainedOn ?? 0, "choice")} on this device.`)}
          >
            {busy === "train" ? "Training" : "Train on this device"}
          </button>
          {you.choices.length < YOU_MIN_CHOICES ? <span className="small muted">{YOU_MIN_CHOICES - you.choices.length} more to train.</span> : null}
        </div>
        {you.ranker ? (
          <p className="small faint">
            Trained {formatDateTime(you.ranker.at)} on {plural(you.ranker.trainedOn, "choice")}, in this browser. Its {Math.round((you.ranker.dim * 4) / 1024)} KB of weights are
            encrypted in your vault and move with it. Your inbox shows the suggestions most like you first.
          </p>
        ) : null}
      </section>

      <section className="subpanel plate" aria-labelledby="you-score">
        <PlateHead number="04" id="you-score" title="How well it knows you" lead="It holds back some of your choices while it trains, then predicts them." />
        {you.score ? (
          <div className="you-score">
            <span className="you-score-value" data-testid="you-score">
              {you.score.value}
            </span>
            <span className="you-score-of">of 100</span>
            <p className="small muted">
              Right on {Math.round((you.score.value * you.score.tested) / 100)} of {plural(you.score.tested, "choice")} it did not train on. More choices make it better.
            </p>
          </div>
        ) : (
          <p className="small muted">Make {YOU_MIN_CHOICES} choices and train it to see a score.</p>
        )}
      </section>

      <section className="subpanel plate" aria-labelledby="you-apps">
        <PlateHead number="05" id="you-apps" title="One you in every app" lead="Claude, ChatGPT, Cursor and any app you gave the Self card folder read the lessons when they ask who you are.">
          <span className="plate-state" data-on={you.shareWithApps ? "true" : "false"}>
            {you.shareWithApps ? "Shared" : "Not shared"}
          </span>
        </PlateHead>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={you.shareWithApps}
            disabled={!!busy}
            onChange={(e) => {
              const on = e.target.checked;
              void commit({ ...you, shareWithApps: on, updatedAt: new Date().toISOString() }, on ? "Your apps can read the lessons now." : "The lessons are no longer shared with apps.", "share");
            }}
          />
          <span>
            Share the lessons with apps that can read my Self card
            <span className="field-hint">They are written into your Self card folder as one memory, kept in step with every change. Turn it off and it is deleted.</span>
          </span>
        </label>
        <p className="small faint">Your AI self uses the lessons too, whenever its rules let it read the Self card.</p>
      </section>

      <section className="subpanel plate" aria-labelledby="you-history">
        <PlateHead number="06" id="you-history" title="History" lead="Every change is kept, so you can put the whole model back as it was." />
        {history.length ? (
          <ul className="you-history">
            {history.map((h) => (
              <li key={h.at}>
                <span>{formatDateTime(h.at)}</span>
                <span className="small muted">{h.reason}</span>
                <span className="small faint">
                  {plural(h.lessons.length, "lesson")}
                  {h.score ? `, score ${h.score.value}` : ""}
                </span>
                {h.at === latest ? (
                  <span className="small faint">Now</span>
                ) : (
                  <button type="button" className="text-button" disabled={!!busy} onClick={() => void run("rollback", () => rollBack(you, h.at), () => `Rolled back to ${formatDateTime(h.at)}.`)}>
                    Roll back to this
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing yet. The first lessons or the first training start the history.</p>
        )}
      </section>
    </div>
  );
}
