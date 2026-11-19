"use client";

// Direction B: the same six lines of a vault, as four different readers get
// them. You see your words, Sigil's server holds only ciphertext, and each app
// gets plain text only for the folders it was given.

import { useEffect, useRef, useState } from "react";
import { ClaudeIcon, CursorIcon } from "@/components/icons";
import { cipherText, useOnScreen, useReducedMotion } from "./clock";

const LINES = [
  { folder: "Work", text: "I do my best work before nine." },
  { folder: "Work", text: "Short answers first, details after." },
  { folder: "Writing", text: "The novel opens at dusk, with a lamp." },
  { folder: "Health", text: "I am allergic to penicillin." },
  { folder: "Health", text: "Coffee after two keeps me awake." },
  { folder: "Money", text: "Rent leaves my account on the first." },
].map((l, i) => ({ ...l, cipherLength: Math.round(l.text.length * 0.95), seed: i + 3 }));

const VIEWS = [
  { name: "You", icon: null, folders: ["Work", "Writing", "Health", "Money"], note: "Unlocked on your own device, by you alone.", dwell: 3200 },
  { name: "Sigil’s server", icon: null, folders: [], note: "Holds ciphertext. It cannot read a word.", dwell: 4800 },
  { name: "Claude", icon: ClaudeIcon, folders: ["Work", "Writing"], note: "Given two folders: Work and Writing.", dwell: 5400 },
  { name: "Cursor", icon: CursorIcon, folders: ["Work"], note: "Given one folder: Work.", dwell: 5400 },
] as const;

const REST_VIEW = 2;
const HOLD_MS = 14000;

function Line({ index, folder, text, cipherLength, seed, open, still }: (typeof LINES)[number] & { index: number; open: boolean; still: boolean }) {
  const [cipher, setCipher] = useState(() => cipherText(seed, cipherLength));
  const first = useRef(true);

  // While a line locks or unlocks, its ciphertext churns for a moment.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (still) return;
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      setCipher(cipherText(seed * 31 + n * 7 + Date.now() % 997, cipherLength));
      if (n >= 9) window.clearInterval(id);
    }, 75);
    return () => window.clearInterval(id);
  }, [open, still, seed, cipherLength]);

  return (
    <li className="views-line" data-open={open} style={{ ["--i" as string]: index }}>
      <span className="views-tag">
        <span>{String(index + 1).padStart(2, "0")}</span>
        {folder}
      </span>
      <span className="views-text">
        <span className="views-plain" aria-hidden={!open}>
          {text}
        </span>
        <span className="views-cipher" aria-hidden="true">
          {cipher}
        </span>
      </span>
    </li>
  );
}

export function HeroViews() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const onScreen = useOnScreen(ref);
  const [auto, setAuto] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [moved, setMoved] = useState(false);
  const running = onScreen && !reduced;

  useEffect(() => {
    if (!running) return;
    if (picked !== null) {
      const id = window.setTimeout(() => {
        setAuto(picked);
        setPicked(null);
      }, HOLD_MS);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => {
      setMoved(true);
      setAuto((v) => (v + 1) % VIEWS.length);
    }, VIEWS[auto].dwell);
    return () => window.clearTimeout(id);
  }, [running, auto, picked]);

  const current = picked ?? (reduced ? REST_VIEW : auto);
  const view = VIEWS[current];
  const allowed: readonly string[] = view.folders;
  const readable = LINES.filter((l) => allowed.includes(l.folder)).length;

  return (
    <div ref={ref} className="views" data-running={running && picked === null} data-moved={moved}>
      <p className="views-label">One vault, as seen by</p>
      <div className="views-tabs">
        {VIEWS.map((v, i) => {
          const Icon = v.icon;
          return (
            <button key={v.name} type="button" className="views-tab" aria-pressed={i === current} onClick={() => {
                setMoved(true);
                setPicked(i);
              }} style={{ ["--dwell" as string]: `${v.dwell}ms` }}>
              {Icon ? <Icon /> : null}
              {v.name}
            </button>
          );
        })}
      </div>
      <p key={current} className="views-note">
        {view.note}
      </p>
      <ol className="views-lines">
        {LINES.map((l, i) => (
          <Line key={l.text} index={i} {...l} open={allowed.includes(l.folder)} still={reduced} />
        ))}
      </ol>
      <div className="views-foot">
        <p className="views-count">
          <strong>{readable}</strong> of {LINES.length} lines readable
        </p>
        <span className="views-meter" aria-hidden="true">
          {LINES.map((l, i) => (
            <i key={l.text} data-on={allowed.includes(l.folder)} style={{ ["--i" as string]: i }} />
          ))}
        </span>
      </div>
    </div>
  );
}
