// A sentence-embedding model run on the device: a WordPiece tokenizer
// (@huggingface/tokenizers) and an ONNX model (onnxruntime-web, WebAssembly),
// mean-pooled over the tokens and scaled to unit length, the same recipe as
// sentence-transformers. The runtime and the tokenizer are passed in, so the
// browser worker and the connector each bring their own build of them, and the
// core stays free of either.

import type { Embedder } from "./semantic";

/** The default model: small (about 23 MB quantized), English, 384 dimensions. */
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

/** The files a model needs, relative to its folder. */
export const MODEL_FILES = ["tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"] as const;
export type ModelFile = (typeof MODEL_FILES)[number];

export function isModelId(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,96}$/.test(value) && !value.includes("..");
}

interface OrtTensor {
  data: ArrayLike<number> | Float32Array;
  dims: readonly number[];
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}

/** The parts of onnxruntime-web this uses. */
export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}

/** The parts of @huggingface/tokenizers this uses. */
export interface TokenizerLike {
  encode(text: string): { ids: number[]; attention_mask: number[] };
}
export type TokenizerClass = new (tokenizer: object, config: object) => TokenizerLike;

export interface OnnxEmbedderOptions {
  model: string;
  ort: OrtLike;
  Tokenizer: TokenizerClass;
  /** Reads one of MODEL_FILES: text for the JSON files, bytes for the model. */
  load(file: ModelFile): Promise<string | Uint8Array>;
  /** Longer inputs are cut to this many tokens. */
  maxTokens?: number;
}

const asText = (v: string | Uint8Array) => (typeof v === "string" ? v : new TextDecoder().decode(v));

export async function createOnnxEmbedder(opts: OnnxEmbedderOptions): Promise<Embedder> {
  const [tokenizerJson, tokenizerConfig, onnx] = await Promise.all(MODEL_FILES.map((f) => opts.load(f)));
  const tokenizer = new opts.Tokenizer(JSON.parse(asText(tokenizerJson)), JSON.parse(asText(tokenizerConfig)));
  if (typeof onnx === "string") throw new Error("The model file must be binary.");
  const session = await opts.ort.InferenceSession.create(onnx, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const output = session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : session.outputNames[0];
  const max = opts.maxTokens ?? 256;

  const encode = (text: string) => {
    const e = tokenizer.encode(text);
    let ids = e.ids;
    if (ids.length > max) ids = [...ids.slice(0, max - 1), ids[ids.length - 1]];
    return ids;
  };

  return {
    model: opts.model,
    async embed(texts: string[]) {
      if (texts.length === 0) return [];
      const encoded = texts.map(encode);
      const len = Math.max(...encoded.map((x) => x.length));
      const n = encoded.length;
      const ids = new BigInt64Array(n * len);
      const mask = new BigInt64Array(n * len);
      encoded.forEach((row, i) =>
        row.forEach((id, j) => {
          ids[i * len + j] = BigInt(id);
          mask[i * len + j] = 1n;
        }),
      );
      const feeds: Record<string, unknown> = {
        input_ids: new opts.ort.Tensor("int64", ids, [n, len]),
        attention_mask: new opts.ort.Tensor("int64", mask, [n, len]),
      };
      if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new opts.ort.Tensor("int64", new BigInt64Array(n * len), [n, len]);
      const result = (await session.run(feeds))[output];
      const dim = result.dims[result.dims.length - 1];
      const data = result.data as Float32Array;
      return encoded.map((row, i) => {
        const v = new Float32Array(dim);
        for (let j = 0; j < row.length; j++) {
          const base = (i * len + j) * dim;
          for (let d = 0; d < dim; d++) v[d] += data[base + d];
        }
        let norm = 0;
        for (let d = 0; d < dim; d++) {
          v[d] /= row.length;
          norm += v[d] * v[d];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) for (let d = 0; d < dim; d++) v[d] /= norm;
        return v;
      });
    },
  };
}
