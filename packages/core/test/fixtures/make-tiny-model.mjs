// Writes a tiny sentence-embedding model for tests that must not touch the
// network: a BERT-style WordPiece tokenizer over the words in concepts.json and
// an ONNX graph that looks each token up in a fixed table and masks padding.
// transformers.js loads it like any feature-extraction model, so the browser
// and the connector run their real model code against it.
//
//   node packages/core/test/fixtures/make-tiny-model.mjs
//
// The output is committed under tiny-model/; run this again only if the table changes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const spec = JSON.parse(readFileSync(path.join(here, "concepts.json"), "utf8"));
const out = path.join(here, "tiny-model", spec.model);

// ---------------------------------------------------------------- the same vectors as embedder.ts

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return h >>> 0;
}

const names = Object.keys(spec.concepts);
function wordVector(word) {
  const c = names.findIndex((n) => spec.concepts[n].includes(word));
  const v = new Float32Array(spec.dims);
  if (c < 0) return v;
  const rand = mulberry32(seedOf(word));
  for (let i = 0; i < v.length; i++) v[i] = (rand() * 2 - 1) * spec.noise;
  v[c] += 1;
  return v;
}

const specials = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"];
const words = [...names.flatMap((n) => spec.concepts[n]), ...spec.stop];
const vocab = [...specials, ...words];
const table = new Float32Array(vocab.length * spec.dims);
vocab.forEach((w, i) => table.set(specials.includes(w) ? new Float32Array(spec.dims) : wordVector(w), i * spec.dims));

// ---------------------------------------------------------------- a minimal protobuf writer

function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return bytes;
}
const key = (field, wire) => varint((field << 3) | wire);
const int = (field, n) => [...key(field, 0), ...varint(n)];
const bytes = (field, data) => [...key(field, 2), ...varint(data.length), ...data];
const str = (field, s) => bytes(field, [...Buffer.from(s, "utf8")]);
const msg = (field, parts) => bytes(field, parts.flat());

const FLOAT = 1;
const INT64 = 7;

function tensor(field, name, type, dims, raw) {
  return msg(field, [...dims.map((d) => int(1, d)), int(2, type), str(8, name), bytes(9, [...raw])]);
}

function valueInfo(field, name, type, dims) {
  const shape = dims.map((d) => msg(1, [typeof d === "number" ? int(1, d) : str(2, d)]));
  return msg(field, [str(1, name), msg(2, [msg(1, [int(1, type), msg(2, shape)])])]);
}

function node(op, inputs, outputs, attrs = []) {
  return msg(1, [...inputs.map((i) => str(1, i)), ...outputs.map((o) => str(2, o)), str(3, `${op.toLowerCase()}_${outputs[0]}`), str(4, op), ...attrs]);
}
const intAttr = (name, value) => msg(5, [str(1, name), int(3, value), int(20, 2)]);

const axes = new BigInt64Array([2n]);
const graph = msg(7, [
  node("Gather", ["embeddings", "input_ids"], ["gathered"], [intAttr("axis", 0)]),
  node("Cast", ["attention_mask"], ["mask_f"], [intAttr("to", FLOAT)]),
  node("Unsqueeze", ["mask_f", "axes"], ["mask_3d"]),
  node("Mul", ["gathered", "mask_3d"], ["last_hidden_state"]),
  str(2, "sigil_tiny_embedder"),
  tensor(5, "embeddings", FLOAT, [vocab.length, spec.dims], new Uint8Array(table.buffer)),
  tensor(5, "axes", INT64, [1], new Uint8Array(axes.buffer)),
  valueInfo(11, "input_ids", INT64, ["batch_size", "sequence_length"]),
  valueInfo(11, "attention_mask", INT64, ["batch_size", "sequence_length"]),
  valueInfo(12, "last_hidden_state", FLOAT, ["batch_size", "sequence_length", spec.dims]),
]);
const model = new Uint8Array([...int(1, 8), ...str(2, "sigil-test"), ...graph, ...msg(8, [str(1, ""), int(2, 13)])]);

// ---------------------------------------------------------------- tokenizer and config

const special = (content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true });
const tokenizer = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: specials.map((s, i) => special(s, i)),
  normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
  pre_tokenizer: { type: "BertPreTokenizer" },
  post_processor: {
    type: "TemplateProcessing",
    single: [{ SpecialToken: { id: "[CLS]", type_id: 0 } }, { Sequence: { id: "A", type_id: 0 } }, { SpecialToken: { id: "[SEP]", type_id: 0 } }],
    pair: [
      { SpecialToken: { id: "[CLS]", type_id: 0 } },
      { Sequence: { id: "A", type_id: 0 } },
      { SpecialToken: { id: "[SEP]", type_id: 0 } },
      { Sequence: { id: "B", type_id: 1 } },
      { SpecialToken: { id: "[SEP]", type_id: 1 } },
    ],
    special_tokens: {
      "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
      "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
    },
  },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab: Object.fromEntries(vocab.map((w, i) => [w, i])) },
};
const tokenizerConfig = {
  tokenizer_class: "BertTokenizer",
  do_lower_case: true,
  model_max_length: 512,
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  pad_token: "[PAD]",
  unk_token: "[UNK]",
  mask_token: "[MASK]",
};
const config = {
  model_type: "bert",
  architectures: ["BertModel"],
  hidden_size: spec.dims,
  num_attention_heads: 1,
  num_hidden_layers: 1,
  intermediate_size: spec.dims,
  vocab_size: vocab.length,
  max_position_embeddings: 512,
  type_vocab_size: 2,
  pad_token_id: 0,
};

mkdirSync(path.join(out, "onnx"), { recursive: true });
writeFileSync(path.join(out, "onnx", "model_quantized.onnx"), model);
writeFileSync(path.join(out, "tokenizer.json"), JSON.stringify(tokenizer));
writeFileSync(path.join(out, "tokenizer_config.json"), JSON.stringify(tokenizerConfig, null, 2) + "\n");
writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}: ${vocab.length} tokens, ${spec.dims} dimensions, ${model.length} bytes`);
