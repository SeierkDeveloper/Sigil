// Runs the sentence model off the main thread, inside the vault page's own
// origin. It fetches the public model files from this site (/models/...),
// never from anywhere else, and only ever receives texts from the page and
// returns vectors to it. Built into public/vendor by scripts/vendor.mjs.

import * as ort from "onnxruntime-web/wasm";
import { Tokenizer } from "@huggingface/tokenizers";
import { createOnnxEmbedder, type Embedder, type OrtLike, type TokenizerClass } from "@sigil/core";

type In = { type: "load"; model: string } | { type: "embed"; id: number; texts: string[] };

const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<In>) => void) | null };
let embedder: Promise<Embedder> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = "/vendor/";
ort.env.logLevel = "error";

async function load(model: string): Promise<Embedder> {
  return createOnnxEmbedder({
    model,
    ort: ort as unknown as OrtLike,
    Tokenizer: Tokenizer as unknown as TokenizerClass,
    load: async (file) => {
      const res = await fetch(`/models/${model}/${file}`, { credentials: "omit" });
      if (!res.ok) throw new Error(`The model file ${file} is not available (${res.status}).`);
      return file.endsWith(".json") ? res.text() : new Uint8Array(await res.arrayBuffer());
    },
  });
}

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    embedder ??= load(msg.model);
    try {
      await embedder;
      scope.postMessage({ type: "ready" });
    } catch (err) {
      embedder = null;
      scope.postMessage({ type: "failed", reason: (err as Error).message });
    }
    return;
  }
  if (msg.type === "embed") {
    try {
      if (!embedder) throw new Error("The model is not loaded.");
      const vectors = await (await embedder).embed(msg.texts);
      scope.postMessage({ type: "vectors", id: msg.id, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
    } catch (err) {
      scope.postMessage({ type: "error", id: msg.id, reason: (err as Error).message });
    }
  }
};
