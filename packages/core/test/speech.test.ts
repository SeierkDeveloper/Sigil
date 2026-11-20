// Speech to text on the device, against the tiny stand-in model in fixtures/
// (make-tiny-whisper.mjs): the real spectrogram, the real ONNX runtime and the
// real greedy decoding and tokenizer, and no network and no real speech model.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import {
  createWhisperTranscriber,
  isSilent,
  logMelSpectrogram,
  melFilters,
  N_FRAMES,
  N_MELS,
  pickLocalVoice,
  speakable,
  SPEECH_SAMPLE_RATE,
  toSpeechSamples,
  type SpeechOrt,
} from "../src/index";

const MODEL = "sigil/tiny-whisper.en";
const DIR = path.join(import.meta.dirname, "fixtures/tiny-model", MODEL);

function tone(hz: number, seconds: number, rate = SPEECH_SAMPLE_RATE, gain = 0.3) {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => gain * Math.sin((2 * Math.PI * hz * i) / rate));
}

async function tiny() {
  return createWhisperTranscriber({
    model: MODEL,
    ort: ort as unknown as SpeechOrt,
    Tokenizer: Tokenizer as never,
    load: async (file) => (file.endsWith(".onnx") ? new Uint8Array(await readFile(path.join(DIR, file))) : readFile(path.join(DIR, file), "utf8")),
  });
}

describe("the spectrogram", () => {
  it("has Whisper's 80 Slaney mel bands over 201 frequency bins", () => {
    const f = melFilters();
    expect(f.length).toBe(80 * 201);
    for (let m = 0; m < 80; m++) {
      const row = f.subarray(m * 201, (m + 1) * 201);
      expect(Math.max(...row)).toBeGreaterThan(0);
      expect(Math.min(...row)).toBeGreaterThanOrEqual(0);
    }
    // The lowest band sits at the bottom of the spectrum, the highest near 8 kHz.
    const peakBin = (m: number) => f.subarray(m * 201, (m + 1) * 201).indexOf(Math.max(...f.subarray(m * 201, (m + 1) * 201)));
    expect(peakBin(0)).toBeLessThan(3);
    expect(peakBin(79)).toBeGreaterThan(180);
  });

  it("is flat for silence and peaks in the band of a tone, padded to thirty seconds", () => {
    const silent = logMelSpectrogram(new Float32Array(16_000));
    expect(silent.length).toBe(N_MELS * N_FRAMES);
    expect(new Set(silent).size).toBe(1);
    expect(silent[0]).toBeCloseTo(-1.5, 5);

    const spec = logMelSpectrogram(tone(1000, 1));
    const frame = 50;
    const column = Array.from({ length: N_MELS }, (_, m) => spec[m * N_FRAMES + frame]);
    const loudest = column.indexOf(Math.max(...column));
    // 1 kHz is the mel band whose filter peaks nearest to it.
    const f = melFilters();
    const centre = (m: number) => f.subarray(m * 201, (m + 1) * 201).indexOf(Math.max(...f.subarray(m * 201, (m + 1) * 201))) * 40;
    expect(Math.abs(centre(loudest) - 1000)).toBeLessThan(120);
    // Values are scaled into Whisper's range, and the padding after the tone is at the floor.
    expect(Math.max(...spec)).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(spec[loudest * N_FRAMES + N_FRAMES - 1]).toBeCloseTo(Math.min(...spec), 5);
  });

  it("mixes channels to mono and resamples to 16 kHz", () => {
    const left = tone(440, 0.5, 48_000);
    const right = tone(440, 0.5, 48_000);
    const out = toSpeechSamples([left, right], 48_000);
    expect(out.length).toBe(8000);
    expect(Math.max(...out)).toBeCloseTo(0.3, 1);
    const at16 = tone(440, 0.25);
    expect(toSpeechSamples([at16], 16_000)).toEqual(at16);
    expect(isSilent(new Float32Array(1000))).toBe(true);
    expect(isSilent(tone(440, 0.1))).toBe(false);
  });
});

describe("the transcriber", () => {
  it("runs the encoder once and decodes greedily until the end token", async () => {
    const t = await tiny();
    expect(t.model).toBe(MODEL);
    expect(await t.transcribe(tone(440, 1.2))).toBe("Where did I park the car?");
  });

  it("gives no text for silence, without asking the model", async () => {
    const t = await tiny();
    expect(await t.transcribe(new Float32Array(16_000))).toBe("");
  });
});

describe("spoken answers", () => {
  it("only ever picks a voice that runs on the device", () => {
    const voices = [
      { name: "Cloud English", lang: "en-US", localService: false },
      { name: "Local Swedish", lang: "sv-SE", localService: true },
      { name: "Local English", lang: "en-GB", localService: true },
    ];
    expect(pickLocalVoice(voices)?.name).toBe("Local English");
    expect(pickLocalVoice(voices, "sv")?.name).toBe("Local Swedish");
    expect(pickLocalVoice(voices.slice(0, 1))).toBeNull();
  });

  it("reads the answer without citation numbers or marks", () => {
    expect(speakable("I give **talks** about memory [1][2].\n\n# More")).toBe("I give talks about memory. More");
  });
});
