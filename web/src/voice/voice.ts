"use client";

// Voice in the page: speech to text with the speech model in a worker on this
// device, and spoken answers with the browser's own speech synthesis, using
// only voices that run on the device. The worker, and with it the model, is
// started only when someone turns voice on. The browser's SpeechRecognition is
// never used: in most browsers it sends the audio to a cloud service.

import { pickLocalVoice, speakable, toSpeechSamples, SPEECH_MODEL_MB } from "@sigil/core";

export { SPEECH_MODEL_MB };

type Out =
  | { type: "ready" }
  | { type: "failed"; reason: string }
  | { type: "progress"; done: number; total: number }
  | { type: "text"; id: number; text: string }
  | { type: "error"; id: number; reason: string };

export interface VoiceConfig {
  enabled: boolean;
  model: string;
}

let config: Promise<VoiceConfig> | null = null;

/** Whether this site offers voice, and which speech model it serves. */
export function voiceConfig(): Promise<VoiceConfig> {
  config ??= fetch("/api/voice", { credentials: "omit" })
    .then((r) => (r.ok ? (r.json() as Promise<VoiceConfig>) : { enabled: false, model: "" }))
    .catch(() => ({ enabled: false, model: "" }));
  return config;
}

/** The speech model in its worker. One per page, started on first use. */
export class SpeechEngine {
  private next = 1;
  private readonly waiting = new Map<number, { resolve(t: string): void; reject(e: Error): void }>();

  private constructor(private readonly worker: Worker) {
    worker.addEventListener("message", (e: MessageEvent<Out>) => {
      const m = e.data;
      if (m.type !== "text" && m.type !== "error") return;
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === "text") w.resolve(m.text);
      else w.reject(new Error(m.reason));
    });
  }

  private static started: Promise<SpeechEngine> | null = null;

  static start(model: string, onProgress?: (done: number, total: number) => void): Promise<SpeechEngine> {
    SpeechEngine.started ??= new Promise<SpeechEngine>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker("/vendor/speech-worker.js", { type: "module", name: "sigil-speech" });
      } catch (err) {
        reject(err);
        return;
      }
      const onMessage = (e: MessageEvent<Out>) => {
        if (e.data.type === "progress") onProgress?.(e.data.done, e.data.total);
        else if (e.data.type === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve(new SpeechEngine(worker));
        } else if (e.data.type === "failed") {
          worker.terminate();
          reject(new Error(e.data.reason));
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (e) => {
        worker.terminate();
        reject(new Error(e.message || "The speech model could not start."));
      });
      worker.postMessage({ type: "load", model });
    }).catch((err) => {
      SpeechEngine.started = null;
      throw err;
    });
    return SpeechEngine.started;
  }

  transcribe(samples: Float32Array): Promise<string> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: "transcribe", id, samples }, [samples.buffer as ArrayBuffer]);
    });
  }
}

/** A recording from the microphone, stopped by the caller, turned into 16 kHz samples on this device. */
export class Recording {
  private readonly chunks: Blob[] = [];
  private readonly done: Promise<Blob>;

  private constructor(
    private readonly recorder: MediaRecorder,
    private readonly stream: MediaStream,
  ) {
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) this.chunks.push(e.data);
    });
    this.done = new Promise((resolve) => recorder.addEventListener("stop", () => resolve(new Blob(this.chunks, { type: recorder.mimeType })), { once: true }));
    recorder.start();
  }

  static async start(): Promise<Recording> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser cannot record from a microphone.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      throw new Error("The microphone could not be used. Allow it for this site, then try again.");
    }
    return new Recording(new MediaRecorder(stream), stream);
  }

  async stop(): Promise<Float32Array> {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    const blob = await this.done;
    for (const t of this.stream.getTracks()) t.stop();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      return toSpeechSamples(channels, audio.sampleRate);
    } finally {
      void ctx.close();
    }
  }
}

/** Reads an answer aloud with a voice that runs on this device. False when the device has none, so nothing is sent anywhere. */
export function speak(text: string, onDone?: () => void): boolean {
  if (typeof speechSynthesis === "undefined") return false;
  const voice = pickLocalVoice(speechSynthesis.getVoices(), (navigator.language || "en").slice(0, 2));
  if (!voice) return false;
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.voice = voice;
  u.lang = voice.lang;
  if (onDone) {
    u.onend = onDone;
    u.onerror = onDone;
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return true;
}

export function hasLocalVoice(): boolean {
  return typeof speechSynthesis !== "undefined" && !!pickLocalVoice(speechSynthesis.getVoices());
}
