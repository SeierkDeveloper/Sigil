// A fixed, offline embedder for tests. Words belong to a handful of concepts;
// a text's vector is the normalized sum of its words' concept vectors. The tiny
// ONNX model in tiny-model/ is generated from the same table (make-tiny-model.mjs),
// so the real model runtime and this stand-in agree.

import concepts from "./concepts.json" with { type: "json" };
import type { Embedder } from "../../src/semantic";
import { tokenize } from "../../src/search";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The vector of one known word, or null for words outside every concept. */
export function wordVector(word: string): Float32Array | null {
  const names = Object.keys(concepts.concepts) as (keyof typeof concepts.concepts)[];
  const c = names.findIndex((n) => (concepts.concepts[n] as string[]).includes(word));
  if (c < 0) return null;
  const rand = mulberry32(seedOf(word));
  const v = new Float32Array(concepts.dims);
  for (let i = 0; i < v.length; i++) v[i] = (rand() * 2 - 1) * concepts.noise;
  v[c] += 1;
  return v;
}

export function conceptEmbedder(): Embedder {
  return {
    model: concepts.model,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const sum = new Float32Array(concepts.dims);
        for (const w of tokenize(t)) {
          const v = wordVector(w);
          if (v) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
        }
        let n = 0;
        for (const x of sum) n += x * x;
        n = Math.sqrt(n);
        return n === 0 ? sum : sum.map((x) => x / n);
      });
    },
  };
}
