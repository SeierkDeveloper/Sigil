"use client";

// Voice for a chat with an AI self: speak a question, and hear the answer. The
// speech model loads only when this is turned on, runs in a worker on this
// device, and puts what it heard in the question field to check before asking.

import { useEffect, useRef, useState } from "react";
import { MicIcon, SpeakerIcon } from "@/components/icons";
import { hasLocalVoice, Recording, speak, SpeechEngine, SPEECH_MODEL_MB, voiceConfig } from "./voice";

type State = "off" | "loading" | "ready" | "listening" | "writing" | "failed" | "unavailable";

interface Props {
  /** What was heard, to put in the question field. */
  onText(text: string): void;
  /** The latest answer: read aloud when it changes, if the person asked for that. */
  answer?: { id: string; text: string } | null;
  /** Start with the model loaded, when the owner turned voice on before. */
  startOn?: boolean;
  /** Told when voice is turned on or off, so the vault can remember it. */
  onSwitch?(on: boolean): void;
  label?: string;
}

export function VoiceControls({ onText, answer, startOn = false, onSwitch, label = "Voice" }: Props) {
  const [state, setState] = useState<State>("off");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [speakAnswers, setSpeakAnswers] = useState(false);
  const [localVoice, setLocalVoice] = useState(() => typeof speechSynthesis !== "undefined" && hasLocalVoice());
  const engine = useRef<SpeechEngine | null>(null);
  const recording = useRef<Recording | null>(null);
  const spoken = useRef<string | null>(null);

  const turnOn = async () => {
    setError(null);
    const cfg = await voiceConfig();
    if (!cfg.enabled) {
      setState("unavailable");
      return;
    }
    setState("loading");
    try {
      engine.current = await SpeechEngine.start(cfg.model, (done, total) => setProgress(Math.round((done / total) * 100)));
      setState("ready");
      onSwitch?.(true);
    } catch (err) {
      setError((err as Error).message);
      setState("failed");
    }
  };

  useEffect(() => {
    if (!startOn) return;
    const t = window.setTimeout(() => void turnOn(), 0);
    return () => window.clearTimeout(t);
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    // Voices often arrive after the page has loaded.
    const check = () => setLocalVoice(hasLocalVoice());
    speechSynthesis.addEventListener?.("voiceschanged", check);
    return () => speechSynthesis.removeEventListener?.("voiceschanged", check);
  }, []);

  // A new answer is read aloud once, when asked for.
  useEffect(() => {
    if (!answer || !speakAnswers || spoken.current === answer.id) return;
    spoken.current = answer.id;
    speak(answer.text);
  }, [answer, speakAnswers]);

  const toggle = async () => {
    setError(null);
    if (state === "listening" && recording.current) {
      const r = recording.current;
      recording.current = null;
      setState("writing");
      try {
        const samples = await r.stop();
        const text = await engine.current!.transcribe(samples);
        if (text) onText(text);
        else setError("Nothing was heard. Try again, a little closer to the microphone.");
      } catch (err) {
        setError((err as Error).message);
      }
      setState("ready");
      return;
    }
    try {
      recording.current = await Recording.start();
      setState("listening");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (state === "off" || state === "unavailable") {
    return (
      <div className="voice" data-state={state} data-testid="voice">
        <button type="button" className="button button-small voice-on" onClick={() => void turnOn()} disabled={state === "unavailable"}>
          <MicIcon /> Turn on voice
        </button>
        <p className="small faint voice-note">
          {state === "unavailable"
            ? "This site does not offer voice."
            : `Speech to text runs on this device. The speech model, about ${SPEECH_MODEL_MB} MB, is downloaded once from this site and kept by your browser. What you say never leaves this device.`}
        </p>
      </div>
    );
  }

  return (
    <div className="voice" data-state={state} data-testid="voice" aria-label={label}>
      {state === "loading" ? (
        <p className="small voice-line" role="status">
          <span className="spinner" aria-hidden="true" /> Loading the speech model{progress ? ` (${progress}%)` : ""}
        </p>
      ) : null}
      {state === "failed" ? (
        <p className="small voice-line" role="alert">
          The speech model could not start: {error}{" "}
          <button type="button" className="text-button" onClick={() => void turnOn()}>
            Try again
          </button>
        </p>
      ) : null}
      {state === "ready" || state === "listening" || state === "writing" ? (
        <div className="voice-row">
          <button type="button" className="button button-small voice-mic" aria-pressed={state === "listening"} onClick={() => void toggle()} disabled={state === "writing"} data-testid="voice-mic">
            <MicIcon /> {state === "listening" ? "Stop and write it down" : state === "writing" ? "Writing it down" : "Speak"}
          </button>
          <label className="checkbox voice-speak" htmlFor={`voice-speak-${label}`}>
            <input id={`voice-speak-${label}`} type="checkbox" checked={speakAnswers} onChange={(e) => setSpeakAnswers(e.target.checked)} disabled={!localVoice} />
            <span>
              <SpeakerIcon /> Read answers aloud
            </span>
          </label>
          <button
            type="button"
            className="text-button small"
            onClick={() => {
              recording.current?.stop().catch(() => undefined);
              recording.current = null;
              setState("off");
              onSwitch?.(false);
            }}
          >
            Turn voice off
          </button>
        </div>
      ) : null}
      {state === "listening" ? (
        <p className="small voice-line" role="status">
          Listening. What you say is written down here, on this device.
        </p>
      ) : null}
      {!localVoice && state !== "loading" ? <p className="small faint voice-line">No voice on this device speaks without a network, so answers are not read aloud.</p> : null}
      {error && state !== "failed" ? (
        <p className="small voice-line" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
