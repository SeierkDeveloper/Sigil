"use client";

// Direction A: Sigil at work, told with the vault's own interface. An app gets
// its folders, lists them, reads one memory, and the hour's reads are sealed.
// Six steps on a timer; every movement is a CSS transition.

import { useRef } from "react";
import { ClaudeIcon, LockIcon } from "@/components/icons";
import { cipherText, useOnScreen, useReducedMotion, useSteps } from "./clock";

const DURATIONS = [1900, 2500, 2700, 3300, 3200, 4400] as const;
const LAST = DURATIONS.length - 1;

const FOLDERS = [
  { name: "Work", allowed: true, memory: "How I like answers" },
  { name: "Writing", allowed: true, memory: "" },
  { name: "Health", allowed: false, memory: "" },
  { name: "Money", allowed: false, memory: "" },
].map((f, i) => ({ ...f, cipher: cipherText(i + 11, 40) }));

const READS = [
  { from: 2, title: "Listed the 2 folders it may read", time: "2:41 PM" },
  { from: 3, title: "Read “How I like answers”", time: "2:42 PM" },
];

const CAPTIONS = [
  "Your vault, encrypted on your own device",
  "You choose what each app may read",
  "The app sees those folders, nothing else",
  "A read is decrypted locally and logged",
  "Each hour is sealed into one fingerprint",
  "Each hour is sealed into one fingerprint",
];

export function HeroFilm() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const onScreen = useOnScreen(ref);
  const ticking = useSteps(DURATIONS, onScreen && !reduced);
  const step = reduced ? LAST : ticking;
  const chapter = Math.min(step, 4);

  return (
    <div
      ref={ref}
      className="film"
      data-step={step}
      role="img"
      aria-label="Sigil at work: Claude Desktop may read the Work and Writing folders but not Health or Money, its reads appear in the log, and the hour is sealed into one fingerprint."
    >
      <div className="film-plate" aria-hidden="true">
        <div className="film-head">
          <span>Your vault</span>
          <span className="film-head-note">
            <LockIcon /> Encrypted <span className="film-wide">on this device</span>
          </span>
        </div>
        <ul className="film-folders">
          {FOLDERS.map((f, i) => {
            const open = f.memory !== "" && step >= 3;
            return (
              <li key={f.name} className="film-folder" data-allowed={f.allowed} data-known={step >= 1} data-lit={open} style={{ ["--i" as string]: i }}>
                <span className="film-folder-name">{f.name}</span>
                <span className="film-cell" data-open={open}>
                  <span className="film-cipher">{f.cipher}</span>
                  {f.memory ? <span className="film-plain">{f.memory}</span> : null}
                </span>
                <span className="badge">{f.allowed ? "Can read" : "No access"}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="film-wire" data-pulse={step === 2 || step === 3 ? step : undefined} aria-hidden="true">
        <span className="film-app-ring">
          <ClaudeIcon />
        </span>
        <span className="film-app-name">Claude Desktop</span>
        <span className="film-app-note">through the Sigil connector</span>
      </div>

      <div className="film-plate" aria-hidden="true">
        <div className="film-head">
          <span>Read log</span>
          <span>2 PM to 3 PM</span>
        </div>
        <div className="film-reads">
          <p className="film-empty" data-show={step < 2}>
            No app has read your vault yet
          </p>
          {READS.map((r) => (
            <div key={r.title} className="film-read" data-show={step >= r.from} data-sealed={step >= 4}>
              <div>
                <p className="film-read-title">{r.title}</p>
                <p className="film-read-meta">Claude Desktop, {r.time}</p>
              </div>
              <span className="film-seal-state">
                <span className="badge film-waiting">
                  Waiting<span className="film-wide"> for seal</span>
                </span>
                <span className="badge film-sealed">Sealed</span>
              </span>
            </div>
          ))}
        </div>
        <div className="film-root" data-sealed={step >= 4}>
          <span className="film-root-label">Seal</span>
          <span className="film-root-value">
            <span className="film-root-wait">Seals at 3:00 PM</span>
            <span className="film-root-hash">0x0603cf22a94e{"…"}8d1b51fa7337</span>
          </span>
        </div>
      </div>

      <div className="film-caption" aria-hidden="true">
        <span className="film-count">
          {String(chapter + 1).padStart(2, "0")} / 05
        </span>
        <span key={chapter} className="film-caption-text">
          {CAPTIONS[step]}
        </span>
        <span className="film-ticks">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} data-on={i <= chapter} />
          ))}
        </span>
      </div>
    </div>
  );
}
