"use client";

import { useState } from "react";
import { phraseCheckPositions } from "@sigil/core";
import { CopyButton, download } from "./ui";

/**
 * Shows a recovery phrase once and does not let the user go on until they
 * confirm it is saved. With `check`, two of its words must also be typed back,
 * so a phrase that was only glanced at is caught now, not on the day it is needed.
 */
export function PhraseScreen({ phrase, title, onDone, doneLabel = "Open my vault", check = false }: { phrase: string; title: string; onDone: () => void; doneLabel?: string; check?: boolean }) {
  const [saved, setSaved] = useState(false);
  const [positions] = useState(() => phraseCheckPositions());
  const [typed, setTyped] = useState<[string, string]>(["", ""]);
  const words = phrase.split(" ");
  const matches = positions.map((p, i) => typed[i].trim().toLowerCase() === words[p - 1]);
  const ready = saved && (!check || matches.every(Boolean));
  return (
    <section className="phrase-screen" aria-labelledby="phrase-title">
      <h2 id="phrase-title" className="vault-gate-title">
        {title}
      </h2>
      <p className="muted">
        These 24 words are the only way back into your vault if you lose your passkey or wallet. Sigil does not keep a copy and cannot show them
        again. Write them down and keep them somewhere safe and offline.
      </p>
      <ol className="phrase-grid" aria-label="Recovery phrase" data-testid="recovery-phrase">
        {words.map((w, i) => (
          <li key={i} className="phrase-word">
            {w}
          </li>
        ))}
      </ol>
      <div className="row">
        <CopyButton text={phrase} label="Copy words" />
        <button type="button" className="button button-small" onClick={() => download("sigil-recovery-phrase.txt", `${phrase}\n`, "text/plain")}>
          Download as a text file
        </button>
      </div>
      <label className="checkbox phrase-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved my recovery phrase somewhere safe.</span>
      </label>
      {check && saved ? (
        <fieldset className="phrase-check" data-testid="phrase-check">
          <legend className="small">To be sure it is saved, type two of the words from where you wrote them down.</legend>
          {positions.map((p, i) => (
            <label key={p} className="field">
              <span className="field-label">Word {p}</span>
              <input
                className="input"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-word={p}
                value={typed[i]}
                aria-invalid={typed[i].trim() !== "" && !matches[i] ? "true" : undefined}
                onChange={(e) => setTyped((t) => (i === 0 ? [e.target.value, t[1]] : [t[0], e.target.value]))}
              />
            </label>
          ))}
          {typed.every((t) => t.trim()) && !matches.every(Boolean) ? <p className="small field-error">That is not the word at that place. Look again at what you wrote down.</p> : null}
        </fieldset>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!ready} onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </section>
  );
}
