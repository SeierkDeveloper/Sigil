"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { evidenceGroups, NOTHING_TEXT, tokenize, type AskSource, type LifeAnswer, type Memory } from "@sigil/core";
import { ArrowIcon, ChevronIcon, DeviceIcon, ImportIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { formatDate, plural } from "@/lib/format";
import * as askOps from "../askOps";
import { modelCaller } from "../selfOps";
import type { Unlocked } from "../ops";
import { errorText, useVault } from "../context";
import { Empty, Notice } from "../ui";

/** Questions to start from, for any vault. Each runs as soon as it is chosen. */
const STARTERS = ["What did I promise someone recently?", "What happened last week?", "What was I reading this year?", "Where did I go last spring?"];

interface Shown {
  answer: LifeAnswer;
  /** How many memories and folders were searched, for the line under the question. */
  searched: { memories: number; folders: number };
  /** The protected folders the owner opened for this answer. */
  opened: string[];
}

interface Kept {
  question: string;
  shown: Shown | null;
  reading: string | null;
}

/**
 * The last question and answer, kept while this vault stays open so a trip to
 * another section does not lose them. Keyed by the open vault: locking makes a
 * new one, and the old answer goes with the old key.
 */
const KEPT = new WeakMap<Unlocked, Kept>();

export function AskTab() {
  const { api, vault, data, semantic, goTo, openMemory, update } = useVault();
  const kept = KEPT.get(vault);
  const [question, setQuestion] = useState(kept?.question ?? "");
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [showFolders, setShowFolders] = useState(false);
  const [rangeChoice, setRangeChoice] = useState<askOps.RangeChoice>("any");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [written, setWritten] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ question: string; folders: { id: string; name: string; ids: string[] }[]; useModel: boolean } | null>(null);
  const [shown, setShown] = useState<Shown | null>(kept?.shown ?? null);
  const [reading, setReading] = useState<string | null>(kept?.reading ?? null);

  useEffect(() => {
    KEPT.set(vault, { question, shown, reading });
  }, [vault, question, shown, reading]);

  // One array per change of the vault: search keeps its word index for it, question after question.
  // Keyed on what it is made of, not the whole data: the data changes for many reasons (a presence beat, a badge) that leave the memories alone.
  const { memories, folders: vaultFolders, shares } = data;
  const pool = useMemo(() => askOps.askPool({ memories, folders: vaultFolders, shares }), [memories, vaultFolders, shares]);
  const folders = useMemo(() => askOps.askFolders({ folders: vaultFolders, shares }), [vaultFolders, shares]);
  const hasModel = !!data.model;
  const useModel = hasModel && written;

  const run = async (text: string, open: Set<string>, withModel: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const now = Date.now();
      const range = askOps.rangeFor(rangeChoice, custom, now);
      const answer = await askOps.askVault(
        data,
        pool,
        { question: text, folderIds, range, open },
        { model: withModel ? modelCaller(data) : null, embedQuery: semantic.embedQuery, vectors: semantic.vectors, now, api },
      );
      const searchedFolders = folderIds.length ? folderIds.length : folders.length;
      const ids = new Set(folderIds);
      const searchedMemories = folderIds.length ? pool.filter((m) => ids.has(m.folderId)).length : pool.length;
      setShown({ answer, searched: { memories: searchedMemories, folders: searchedFolders }, opened: [...open] });
      setReading(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ask = async (text: string) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (!q || busy) return;
    setQuestion(q);
    setGate(null);
    const now = Date.now();
    // A protected folder with matches: the owner says yes first, for this one answer.
    try {
      const matches = await askOps.protectedMatches(data, pool, { question: q, folderIds, range: askOps.rangeFor(rangeChoice, custom, now) }, { embedQuery: semantic.embedQuery, vectors: semantic.vectors, now });
      if (matches.length) {
        setGate({ question: q, folders: matches, useModel });
        return;
      }
    } catch (err) {
      setError(errorText(err));
      return;
    }
    await run(q, new Set(), useModel);
  };

  const decide = async (allow: boolean) => {
    if (!gate) return;
    const g = gate;
    setGate(null);
    if (!allow) return run(g.question, new Set(), g.useModel);
    // A model reads them: the yes goes on the record, as in the AI self's test chat. Shown only here, nothing leaves this device.
    if (g.useModel) {
      try {
        await askOps.allowProtected(api, g.folders);
      } catch (err) {
        setError(errorText(err));
        return;
      }
    }
    await run(g.question, new Set(g.folders.map((f) => f.id)), g.useModel);
  };

  const toggleFolder = (id: string) => setFolderIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  if (pool.length === 0 && data.memories.length === 0) {
    return (
      <Empty
        icon={<ImportIcon />}
        title="Nothing to ask yet"
        action={
          <div className="row">
            <button type="button" className="button button-primary" onClick={() => goTo("memories")}>
              <PlusIcon /> Write a memory
            </button>
            <button type="button" className="button" onClick={() => goTo("import")}>
              Import your history
            </button>
          </div>
        }
      >
        Ask answers from your memories, mail, chats, notes and meetings. Write a memory or bring in your history first, and ask about it here.
      </Empty>
    );
  }

  const one = !!gate && gate.folders.reduce((n, f) => n + f.ids.length, 0) === 1;
  const folderLabel = folderIds.length === 0 ? "All folders" : folderIds.length === 1 ? (folders.find((f) => f.id === folderIds[0])?.name ?? "1 folder") : plural(folderIds.length, "folder");

  return (
    <div className="ask">
      <p className="small muted screen-help">
        One question, answered from every folder at once. Your vault is searched by words and by meaning on this device, and every sentence of the answer links to
        the memory it came from.
      </p>

      <form
        className="ask-form"
        aria-label="Ask your vault"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <div className="toolbar ask-toolbar">
          <div className="search ask-search">
            <SearchIcon />
            <label className="visually-hidden" htmlFor="ask-question">
              Your question
            </label>
            <input
              id="ask-question"
              className="input"
              type="text"
              enterKeyHint="search"
              autoComplete="off"
              value={question}
              maxLength={2000}
              placeholder="What would you like to know?"
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <button type="button" className="button ask-filter" aria-expanded={showFolders} aria-controls="ask-folders" onClick={() => setShowFolders((s) => !s)}>
            {folderLabel}
            <ChevronIcon />
          </button>
          <label className="visually-hidden" htmlFor="ask-range">
            Time
          </label>
          <select id="ask-range" className="select ask-range" value={rangeChoice} onChange={(e) => setRangeChoice(e.target.value as askOps.RangeChoice)}>
            {(Object.keys(askOps.RANGE_LABELS) as askOps.RangeChoice[]).map((k) => (
              <option key={k} value={k}>
                {askOps.RANGE_LABELS[k]}
              </option>
            ))}
          </select>
          <button type="submit" className="button button-primary ask-submit" disabled={busy || !question.trim()}>
            {busy ? "Asking" : "Ask"}
          </button>
        </div>

        {rangeChoice === "custom" ? (
          <div className="ask-dates">
            <div className="field">
              <label className="field-label" htmlFor="ask-from">
                From
              </label>
              <input id="ask-from" className="input" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ask-to">
                To
              </label>
              <input id="ask-to" className="input" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          </div>
        ) : null}

        {showFolders ? (
          <div id="ask-folders" className="chips ask-folders" role="group" aria-label="Folders to ask">
            <button type="button" className="chip" data-on={folderIds.length === 0 ? "true" : undefined} aria-pressed={folderIds.length === 0} onClick={() => setFolderIds([])}>
              All folders
            </button>
            {folders.map((f) => (
              <button key={f.id} type="button" className="chip" data-on={folderIds.includes(f.id) ? "true" : undefined} aria-pressed={folderIds.includes(f.id)} onClick={() => toggleFolder(f.id)}>
                {f.shared ? `Shared: ${f.name}` : f.name}
                {f.protect ? <span className="ask-folder-note"> protected</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ask-under">
          {hasModel ? (
            <div className="segmented ask-mode" role="group" aria-label="How to answer">
              <button type="button" aria-pressed={written} onClick={() => setWritten(true)}>
                Written answer
              </button>
              <button type="button" aria-pressed={!written} onClick={() => setWritten(false)}>
                Memories only
              </button>
            </div>
          ) : null}
        <p className="small faint search-mode ask-where" data-state={semantic.status.state}>
          <DeviceIcon />
          <span>
            {semantic.status.state === "ready" ? "Searched by words and by meaning on this device" : "Searched by words on this device"}
            {useModel ? `, written by ${data.model!.model} with your own key` : ""}. Sigil&apos;s server never sees the question or the answer.
          </span>
        </p>
        </div>
      </form>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {gate ? (
        <div className="subpanel protect-gate" data-testid="protect-gate">
          <p className="small">
            {gate.useModel ? "This answer could use " : "Your question matches "}
            {gate.folders.map((f, i) => (
              <span key={f.id}>
                {i ? " and " : ""}
                {plural(f.ids.length, "memory", "memories")} in {f.name}
              </span>
            ))}
            , {gate.folders.length === 1 ? "a protected folder" : "protected folders"}.{" "}
            {gate.useModel
              ? `Allow your model to read ${one ? "it" : "them"} for this one answer? The read goes into your read log.`
              : `Show ${one ? "it" : "them"} here, for this one answer? Nothing leaves this device.`}
          </p>
          <div className="row">
            <button type="button" className="button button-small button-primary" onClick={() => void decide(true)}>
              {gate.useModel ? "Allow for this answer" : one ? "Show it" : "Show them"}
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => void decide(false)}>
              {gate.useModel ? `Answer without ${one ? "it" : "them"}` : `Leave ${one ? "it" : "them"} out`}
            </button>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="subpanel plate ask-result" data-status="waiting">
          <p className="ask-asked">{question}</p>
          <p className="faint chat-waiting">
            <span className="spinner" aria-hidden="true" /> {useModel ? "Reading your memories and writing the answer" : "Reading your memories"}
          </p>
        </div>
      ) : shown ? (
        <Result shown={shown} reading={reading} onRead={setReading} onOpenInMemories={openMemory} onAddModel={hasModel ? undefined : () => goTo("self")} onSaved={(m) => update((d) => ({ ...d, memories: [m, ...d.memories] }))} />
      ) : !gate ? (
        <section className="subpanel plate ask-start" aria-labelledby="ask-start-title">
          <h3 id="ask-start-title" className="plate-title">
            Start with a question
          </h3>
          <p className="plate-lead">
            Ask the way you would ask a friend who read everything you kept. Time words work too: last spring, in March, 2025, last week.
          </p>
          <ul className="ask-starters">
            {STARTERS.map((s) => (
              <li key={s}>
                <button type="button" className="ask-starter" onClick={() => void ask(s)}>
                  <span>{s}</span>
                  <ArrowIcon />
                </button>
              </li>
            ))}
          </ul>
          {!hasModel ? (
            <p className="small muted ask-start-note">
              Without a model key, Ask shows the memories that answer best, grouped by folder and date.{" "}
              <button type="button" className="text-button" onClick={() => goTo("self")}>
                Add a model key under AI self
              </button>{" "}
              and they become a written answer.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the answer

const PERIOD_FIRST = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A sentence without its last word, and its last word: the last word keeps its source numbers on its line. */
const head = (text: string) => {
  const at = text.trimEnd().lastIndexOf(" ");
  return at > 0 ? text.slice(0, at + 1) : "";
};
const tail = (text: string) => text.slice(head(text).length);

function Result({
  shown,
  reading,
  onRead,
  onOpenInMemories,
  onAddModel,
  onSaved,
}: {
  shown: Shown;
  reading: string | null;
  onRead(id: string | null): void;
  onOpenInMemories(id: string): void;
  /** Only when no model key is set: the note under memories-only results points to AI self. */
  onAddModel?: () => void;
  onSaved(m: Memory): void;
}) {
  const { answer } = shown;
  const number = useMemo(() => new Map(answer.sources.map((s, i) => [s.id, i + 1])), [answer.sources]);
  const current = answer.sources.find((s) => s.id === reading) ?? null;
  const [activeSentence, setActiveSentence] = useState<number | null>(null);
  const terms = useMemo(() => [...new Set(tokenize(answer.question).filter((t) => t.length >= 4))], [answer.question]);
  const pick = (i: number, id: string) => {
    setActiveSentence(i);
    onRead(id);
  };
  const keyPick = (e: React.KeyboardEvent, i: number, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(i, id);
    }
  };

  const meta =
    answer.kind === "answer"
      ? `Written by ${answer.model} from ${plural(answer.sources.length, "memory", "memories")}`
      : answer.kind === "evidence"
        ? answer.sources.length === 1
          ? "1 memory that answers best"
          : `${plural(answer.sources.length, "memory", "memories")} that answer best`
        : `Searched ${plural(shown.searched.memories, "memory", "memories")}`;

  return (
    <div className="ask-layout" data-reading={current ? "true" : "false"} data-kind={answer.kind}>
      <section className="subpanel plate ask-result" aria-labelledby="ask-asked" data-kind={answer.kind}>
        <header className="ask-result-head">
          <p id="ask-asked" className="ask-asked">
            {answer.question}
          </p>
          <p className="ask-meta">
            <span>{meta}</span>
            <span>{shown.searched.folders === 1 ? "1 folder" : plural(shown.searched.folders, "folder")}</span>
            {answer.period ? <span>{PERIOD_FIRST(answer.period.label)}</span> : null}
          </p>
        </header>

        {answer.period && !answer.inPeriod && answer.kind !== "nothing" ? (
          <p className="small muted ask-period-note">Nothing from {answer.period.label} matched, so these are from other times.</p>
        ) : null}

        {answer.kind === "answer" ? (
          <div className="ask-answer" data-testid="ask-answer">
            <p className="ask-sentences">
              {answer.sentences.map((s, i) => (
                <Fragment key={i}>
                  <span className="ask-sentence" data-active={activeSentence === i ? "true" : undefined} data-testid="ask-sentence">
                    {/* A sentence flows as text, which a button cannot do; it acts as one for keys and readers. Its last word stays on the line with its source numbers. */}
                    <span role="button" tabIndex={0} aria-label={s.text} className="ask-sentence-text" onClick={() => pick(i, s.ids[0])} onKeyDown={(e) => keyPick(e, i, s.ids[0])}>
                      {head(s.text)}
                    </span>
                    <span className="ask-tail">
                      <span className="ask-sentence-text" aria-hidden="true" onClick={() => pick(i, s.ids[0])}>
                        {tail(s.text)}
                      </span>
                      {s.ids.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="ask-ref"
                          aria-label={`Source ${number.get(id)}: ${answer.sources.find((x) => x.id === id)?.title ?? ""}`}
                          aria-current={reading === id ? "true" : undefined}
                          onClick={() => pick(i, id)}
                        >
                          {number.get(id)}
                        </button>
                      ))}
                    </span>
                  </span>{" "}
                </Fragment>
              ))}
            </p>
            {answer.dropped ? (
              <p className="small faint ask-dropped">
                {answer.dropped === 1 ? "One sentence" : `${answer.dropped} sentences`} the model wrote could not be linked to a memory, so {answer.dropped === 1 ? "it is" : "they are"} left out.
              </p>
            ) : null}
            <h4 className="ask-subhead">Sources</h4>
            <ol className="ask-sources">
              {answer.sources.map((s) => (
                <li key={s.id}>
                  <button type="button" className="ask-source" aria-current={reading === s.id ? "true" : undefined} onClick={() => onRead(s.id)}>
                    <span className="ask-source-n" aria-hidden="true">
                      {number.get(s.id)}
                    </span>
                    <span className="ask-source-title">{s.title}</span>
                    <span className="ask-source-meta">
                      <span>{s.folder}</span>
                      <span>{formatDate(s.editedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {answer.kind === "evidence" ? (
          <div className="ask-evidence" data-testid="ask-evidence">
            {answer.usedModel ? (
              <p className="small muted ask-mode-note">The model&apos;s answer could not be linked to your memories, so here are the memories themselves.</p>
            ) : null}
            {evidenceGroups(answer.sources).map((g) => (
              <section key={g.folderId} className="ask-group" aria-label={g.folder}>
                <h4 className="ask-subhead">
                  {g.folder} <span className="ask-subhead-count">{g.items.length}</span>
                </h4>
                <ul className="memory-list">
                  {g.items.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="memory-item" aria-current={reading === s.id ? "true" : undefined} onClick={() => onRead(s.id)}>
                        <span className="memory-item-title">{s.title}</span>
                        <span className="memory-item-meta">
                          <span>{formatDate(s.editedAt)}</span>
                          {s.match === "meaning" || s.match === "both" ? <span className="chip chip-strong">{s.match === "both" ? "Words and meaning" : "By meaning"}</span> : null}
                          {s.neutralised ? <span className="chip">Checked</span> : null}
                        </span>
                        <span className="memory-item-snippet">
                          <Marked text={s.passage} terms={s.match === "meaning" ? [] : terms} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!answer.usedModel && onAddModel ? (
              <p className="small muted ask-mode-note">
                These are the memories that answer best.{" "}
                <button type="button" className="text-button" onClick={onAddModel}>
                  Add a model key under AI self
                </button>{" "}
                and Ask writes them into an answer, each sentence linked to its memory.
              </p>
            ) : null}
          </div>
        ) : null}

        {answer.kind === "nothing" ? (
          <div className="ask-nothing" data-testid="ask-nothing">
            <p className="ask-nothing-title">{NOTHING_TEXT}</p>
            <p className="small muted">
              Nothing in {shown.searched.folders === 1 ? "that folder" : "the folders you asked"} answers it
              {answer.period ? ` for ${answer.period.label}` : ""}. Try other words, every folder or any time.
            </p>
          </div>
        ) : null}

        {answer.caught && (answer.caught.held || answer.caught.neutralised) ? (
          <p className="small faint ask-caught">
            {answer.caught.held ? `${plural(answer.caught.held, "match", "matches")} held for your review by the immune system ${answer.caught.held === 1 ? "was" : "were"} left out. ` : ""}
            {answer.caught.neutralised ? `${plural(answer.caught.neutralised, "source")} had a possible hidden instruction removed first.` : ""}
          </p>
        ) : null}

        {answer.kind !== "nothing" ? <SaveAnswer answer={answer} onSaved={onSaved} onOpen={onOpenInMemories} /> : null}
      </section>

      {current ? <Reader source={current} terms={terms} onClose={() => onRead(null)} onOpen={() => onOpenInMemories(current.id)} /> : <ReaderIdle kind={answer.kind} />}
    </div>
  );
}

function ReaderIdle({ kind }: { kind: LifeAnswer["kind"] }) {
  if (kind === "nothing") return null;
  return (
    <div className="editor editor-idle ask-reader-idle">
      <p className="muted small">{kind === "answer" ? "Choose a sentence or a source to read the memory behind it." : "Choose a memory to read it in full."}</p>
    </div>
  );
}

const startsWithTerm = (word: string, terms: string[]) => {
  const t = tokenize(word)[0];
  return !!t && terms.some((term) => t.startsWith(term));
};

function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {text.split(/([\p{L}\p{N}]+)/u).map((part, i) => (i % 2 && startsWithTerm(part, terms) ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/** One memory behind the answer, read in place, with the passage that answers set apart. */
function Reader({ source, terms, onClose, onOpen }: { source: AskSource; terms: string[]; onClose(): void; onOpen(): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [source.id]);
  const at = source.passage ? source.text.indexOf(source.passage.replace(/\.\.\.$/, "")) : -1;
  const passage = source.passage.replace(/\.\.\.$/, "");
  return (
    <article ref={ref} className="editor editor-readonly ask-reader" aria-label="Memory behind the answer" data-testid="ask-reader">
      <h3 className="editor-title">{source.title}</h3>
      <p className="editor-meta">
        In {source.folder}, from {formatDate(source.editedAt)}.
      </p>
      <div className="editor-body">
        {at >= 0 ? (
          <>
            {source.text.slice(0, at)}
            <mark className="ask-passage">{passage}</mark>
            {source.text.slice(at + passage.length)}
          </>
        ) : (
          <Marked text={source.text} terms={terms} />
        )}
      </div>
      <div className="form-actions">
        <button type="button" className="button button-small" onClick={onOpen}>
          Open in Memories
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </article>
  );
}

function SaveAnswer({ answer, onSaved, onOpen }: { answer: LifeAnswer; onSaved(m: Memory): void; onOpen(id: string): void }) {
  const { api, data } = useVault();
  const choices = askOps.saveFolders(data, answer);
  const [folderId, setFolderId] = useState(choices[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ id: string; folder: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usedProtected = choices.length < data.folders.length && choices.every((f) => f.protect);

  if (choices.length === 0) return null;
  if (saved) {
    return (
      <Notice kind="success">
        Saved in {saved.folder} as a new memory, with its sources.{" "}
        <button type="button" className="text-button" onClick={() => onOpen(saved.id)}>
          Open it
        </button>
      </Notice>
    );
  }
  return (
    <div className="ask-save">
      {error ? <Notice kind="error">{error}</Notice> : null}
      <label className="field-label" htmlFor="ask-save-folder">
        Keep this {answer.kind === "answer" ? "answer" : "list"} in
      </label>
      <div className="ask-save-row">
        <select id="ask-save-folder" className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          {choices.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={busy || !folderId}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const m = await askOps.saveAnswer(api, data, folderId, answer);
              onSaved(m);
              setSaved({ id: m.id, folder: choices.find((f) => f.id === folderId)?.name ?? "" });
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving" : "Save answer"}
        </button>
      </div>
      <p className="field-hint">{usedProtected ? "It used a protected folder, so it can only be kept in one." : "Encrypted on this device like any memory. Ask never uses saved answers as a source."}</p>
    </div>
  );
}
