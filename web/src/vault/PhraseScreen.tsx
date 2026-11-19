"use client";

import { useState } from "react";
import { CopyButton, download } from "./ui";

/** Shows a recovery phrase once and does not let the user go on until they confirm it is saved. */
export function PhraseScreen({ phrase, title, onDone, doneLabel = "Open my vault" }: { phrase: string; title: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const words = phrase.split(" ");
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
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!saved} onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </section>
  );
}
