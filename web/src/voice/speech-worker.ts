// Runs the speech model off the main thread, inside the page's own origin. It
// fetches the public model files from this site (/models/...), never from
// anywhere else, only ever receives audio samples from the page and returns
// text to it. Built into public/vendor by scripts/vendor.mjs, and started only
// when someone turns voice on.

import * as ort from "onnxruntime-web/wasm";
import { Tokenizer } from "@huggingface/tokenizers";
import { createWhisperTranscriber, type SpeechOrt, type Transcriber } from "@sigil/core";

type In = { type: "load"; model: string } | { type: "transcribe"; id: number; samples: Float32Array };

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<In>) => void) | null };
let transcriber: Promise<Transcriber> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = "/vendor/";
ort.env.logLevel = "error";

async function load(model: string): Promise<Transcriber> {
  let done = 0;
  return createWhisperTranscriber({
    model,
    ort: ort as unknown as SpeechOrt,
    Tokenizer: Tokenizer as never,
    load: async (file) => {
      const res = await fetch(`/models/${model}/${file}`, { credentials: "omit" });
      if (!res.ok) throw new Error(`The speech model file ${file} is not available (${res.status}).`);
      const out = file.endsWith(".json") ? await res.text() : new Uint8Array(await res.arrayBuffer());
      scope.postMessage({ type: "progress", done: ++done, total: 3 });
      return out;
    },
  });
}

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    transcriber ??= load(msg.model);
    try {
      await transcriber;
      scope.postMessage({ type: "ready" });
    } catch (err) {
      transcriber = null;
      scope.postMessage({ type: "failed", reason: (err as Error).message });
    }
    return;
  }
  if (msg.type === "transcribe") {
    try {
      if (!transcriber) throw new Error("The speech model is not loaded.");
      const text = await (await transcriber).transcribe(msg.samples);
      scope.postMessage({ type: "text", id: msg.id, text });
    } catch (err) {
      scope.postMessage({ type: "error", id: msg.id, reason: (err as Error).message });
    }
  }
};
