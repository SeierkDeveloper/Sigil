// Speech to text on the device: Whisper (an open speech model) in ONNX form,
// run by onnxruntime-web in a worker of the page, the same runtime the search
// model uses. Audio never leaves the device: the page records it, this code
// turns it into a log-mel spectrogram, the encoder reads that, and a greedy
// decoder writes the text one token at a time. The browser's own
// SpeechRecognition is not used, because in most browsers it sends the audio
// to a cloud service.
//
// The model is fetched from the node only when someone turns voice on, once,
// and kept by the browser. Answers are spoken with the browser's speech
// synthesis, using only voices that run on the device.
//
// The feature extraction is Whisper's own: 16 kHz mono, padded or cut to 30
// seconds, a 400-point short-time Fourier transform with a Hann window every
// 160 samples, power spectrum, 80 mel bands (Slaney scale and norm, as in
// librosa), log10, a floor 8 below the peak, then (x + 4) / 4.

import type { OrtLike, TokenizerClass } from "./onnx";

export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_SECONDS = 30;
export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const N_FRAMES = (SPEECH_SAMPLE_RATE * SPEECH_SECONDS) / HOP;

/** The default model: English only, about 41 MB quantized, fetched once when voice is turned on. */
export const DEFAULT_SPEECH_MODEL = "Xenova/whisper-tiny.en";
export const SPEECH_MODEL_FILES = ["tokenizer.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_quantized.onnx"] as const;
export type SpeechModelFile = (typeof SPEECH_MODEL_FILES)[number];
export const SPEECH_MODEL_MB = 41;

// ---------------------------------------------------------------- mel filters (Slaney, as librosa)

function hzToMel(f: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logStep : f / fSp;
}

function melToHz(m: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fSp * m;
}

let filters: Float32Array | null = null;

/** The 80 x 201 mel filter bank, made once. */
export function melFilters(): Float32Array {
  if (filters) return filters;
  const bins = N_FFT / 2 + 1;
  const fftFreqs = Array.from({ length: bins }, (_, i) => (i * SPEECH_SAMPLE_RATE) / N_FFT);
  const lo = hzToMel(0);
  const hi = hzToMel(SPEECH_SAMPLE_RATE / 2);
  const melF = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)));
  const out = new Float32Array(N_MELS * bins);
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (melF[m + 2] - melF[m]);
    for (let k = 0; k < bins; k++) {
      const lower = (fftFreqs[k] - melF[m]) / (melF[m + 1] - melF[m]);
      const upper = (melF[m + 2] - fftFreqs[k]) / (melF[m + 2] - melF[m + 1]);
      out[m * bins + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  filters = out;
  return out;
}

let tables: { cos: Float32Array; sin: Float32Array; window: Float32Array } | null = null;

function dftTables() {
  if (tables) return tables;
  const bins = N_FFT / 2 + 1;
  const cos = new Float32Array(bins * N_FFT);
  const sin = new Float32Array(bins * N_FFT);
  for (let k = 0; k < bins; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const a = (2 * Math.PI * k * n) / N_FFT;
      cos[k * N_FFT + n] = Math.cos(a);
      sin[k * N_FFT + n] = Math.sin(a);
    }
  }
  // A periodic Hann window, as torch.hann_window(400).
  const window = Float32Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT));
  tables = { cos, sin, window };
  return tables;
}

/**
 * The 80 x 3000 log-mel spectrogram Whisper reads, from 16 kHz mono samples.
 * Frames that lie wholly in the padding are silent and are not computed.
 */
export function logMelSpectrogram(samples: Float32Array): Float32Array {
  const total = SPEECH_SAMPLE_RATE * SPEECH_SECONDS;
  const audio = new Float32Array(total);
  audio.set(samples.subarray(0, total));
  const pad = N_FFT / 2;
  const at = (i: number) => {
    // Reflect padding at both ends, as the transform is centred.
    let j = i - pad;
    if (j < 0) j = -j;
    if (j >= total) j = 2 * (total - 1) - j;
    return audio[j];
  };
  const bins = N_FFT / 2 + 1;
  const { cos, sin, window } = dftTables();
  const mel = melFilters();
  const out = new Float32Array(N_MELS * N_FRAMES);
  const power = new Float32Array(bins);
  const frame = new Float32Array(N_FFT);
  const live = Math.min(N_FRAMES, Math.ceil((Math.min(samples.length, total) + pad) / HOP) + 1);
  let peak = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    if (t < live) {
      for (let n = 0; n < N_FFT; n++) frame[n] = at(t * HOP + n) * window[n];
      for (let k = 0; k < bins; k++) {
        let re = 0;
        let im = 0;
        const base = k * N_FFT;
        for (let n = 0; n < N_FFT; n++) {
          re += frame[n] * cos[base + n];
          im -= frame[n] * sin[base + n];
        }
        power[k] = re * re + im * im;
      }
    } else power.fill(0);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const base = m * bins;
      for (let k = 0; k < bins; k++) s += mel[base + k] * power[k];
      const v = Math.log10(Math.max(s, 1e-10));
      out[m * N_FRAMES + t] = v;
      if (v > peak) peak = v;
    }
  }
  const floor = peak - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}

/** Mixes to mono and resamples to 16 kHz with linear interpolation (the page records at whatever rate the device gives). */
export function toSpeechSamples(channels: Float32Array[], rate: number): Float32Array {
  if (channels.length === 0) return new Float32Array();
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) mono[i] += c[i] / channels.length;
  if (rate === SPEECH_SAMPLE_RATE) return mono;
  const outLen = Math.floor((len * SPEECH_SAMPLE_RATE) / rate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = (i * rate) / SPEECH_SAMPLE_RATE;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (mono[j] ?? 0) * (1 - f) + (mono[j + 1] ?? mono[j] ?? 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------- the transcriber

export interface Transcriber {
  readonly model: string;
  transcribe(samples: Float32Array): Promise<string>;
}

interface Tensor {
  data: ArrayLike<number> | Float32Array;
  dims: readonly number[];
}

interface SpeechSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
}

/** The parts of onnxruntime-web this uses: sessions, and int64 and float32 tensors. */
export interface SpeechOrt {
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<SpeechSession> };
  Tensor: new (type: "int64" | "float32", data: BigInt64Array | Float32Array, dims: number[]) => unknown;
}

export interface SpeechTokenizer {
  decode(ids: number[], options?: { skip_special_tokens?: boolean }): string;
  token_to_id(token: string): number | undefined;
}

export interface WhisperOptions {
  model: string;
  ort: SpeechOrt | OrtLike;
  Tokenizer: TokenizerClass | (new (tokenizer: object, config: object) => SpeechTokenizer);
  load(file: SpeechModelFile): Promise<string | Uint8Array>;
  /** Tokens written at most for one recording. */
  maxTokens?: number;
}

const asText = (v: string | Uint8Array) => (typeof v === "string" ? v : new TextDecoder().decode(v));

/** Very quiet audio gives no text, rather than whatever the model imagines in silence. */
export function isSilent(samples: Float32Array, threshold = 0.005): boolean {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return samples.length === 0 || Math.sqrt(sum / samples.length) < threshold;
}

export async function createWhisperTranscriber(opts: WhisperOptions): Promise<Transcriber> {
  const ort = opts.ort as SpeechOrt;
  const [tokenizerJson, encoderBytes, decoderBytes] = await Promise.all(SPEECH_MODEL_FILES.map((f) => opts.load(f)));
  if (typeof encoderBytes === "string" || typeof decoderBytes === "string") throw new Error("The speech model files must be binary.");
  const json = JSON.parse(asText(tokenizerJson)) as object;
  const tokenizer = new (opts.Tokenizer as new (t: object, c: object) => SpeechTokenizer)(json, {});
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const encoder = await ort.InferenceSession.create(encoderBytes, options);
  const decoder = await ort.InferenceSession.create(decoderBytes, options);
  const id = (t: string) => {
    const v = tokenizer.token_to_id(t);
    if (v === undefined) throw new Error(`The speech model has no ${t} token.`);
    return v;
  };
  const english = /\.en$/i.test(opts.model);
  const eot = id("<|endoftext|>");
  const prompt = english ? [id("<|startoftranscript|>"), id("<|notimestamps|>")] : [id("<|startoftranscript|>"), id("<|en|>"), id("<|transcribe|>"), id("<|notimestamps|>")];
  const featureName = encoder.inputNames[0];
  const hiddenOut = encoder.outputNames.includes("last_hidden_state") ? "last_hidden_state" : encoder.outputNames[0];
  const idsName = decoder.inputNames.find((n) => n.includes("input_ids")) ?? decoder.inputNames[0];
  const statesName = decoder.inputNames.find((n) => n.includes("encoder_hidden_states")) ?? decoder.inputNames[1];
  const logitsOut = decoder.outputNames.includes("logits") ? "logits" : decoder.outputNames[0];
  const max = opts.maxTokens ?? 120;
  // Timestamp tokens come after <|notimestamps|>; they are never written here.
  const firstTimestamp = id("<|notimestamps|>") + 1;

  return {
    model: opts.model,
    async transcribe(samples: Float32Array) {
      if (isSilent(samples)) return "";
      const features = logMelSpectrogram(samples);
      const enc = await encoder.run({ [featureName]: new ort.Tensor("float32", features, [1, N_MELS, N_FRAMES]) });
      const hidden = enc[hiddenOut];
      const states = new ort.Tensor("float32", hidden.data as Float32Array, [...hidden.dims]);
      const tokens = [...prompt];
      const written: number[] = [];
      while (written.length < max) {
        const ids = BigInt64Array.from(tokens.map((t) => BigInt(t)));
        const out = (await decoder.run({ [idsName]: new ort.Tensor("int64", ids, [1, tokens.length]), [statesName]: states }))[logitsOut];
        const vocab = out.dims[out.dims.length - 1];
        const base = (tokens.length - 1) * vocab;
        const data = out.data as Float32Array;
        let best = -1;
        let bestScore = -Infinity;
        for (let v = 0; v < vocab; v++) {
          if (v >= firstTimestamp) continue;
          const score = data[base + v];
          if (score > bestScore) {
            bestScore = score;
            best = v;
          }
        }
        if (best < 0 || best === eot) break;
        tokens.push(best);
        written.push(best);
        // A model stuck on one token stops rather than fill the field.
        if (written.length >= 8 && written.slice(-8).every((t) => t === best)) break;
      }
      return tokenizer.decode(written, { skip_special_tokens: true }).replace(/\s+/g, " ").trim();
    },
  };
}

// ---------------------------------------------------------------- spoken answers

export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}

/** A voice that runs on this device, in the language asked for if there is one. Voices that need a network are never picked. */
export function pickLocalVoice<T extends VoiceLike>(voices: T[], lang = "en"): T | null {
  const local = voices.filter((v) => v.localService);
  return local.find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase())) ?? local[0] ?? null;
}

/** What is read aloud: the answer without citation numbers or Markdown marks. */
export function speakable(text: string): string {
  return text
    .replace(/\s*\[\d{1,2}\]/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}
