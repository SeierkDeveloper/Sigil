// Writes a tiny stand-in for the speech model, for tests that must not touch
// the network or run a real model: Whisper's file layout and input and output
// names, a byte-level tokenizer over a handful of words, an encoder that
// averages the spectrogram, and a decoder that writes one fixed sentence one
// token per step, whatever it hears. The page and the tests run the real
// speech code (spectrogram, encoder, greedy decoding, tokenizer) against it.
//
//   node packages/core/test/fixtures/make-tiny-whisper.mjs
//
// The output is committed under tiny-model/; run this again only if the sentence changes.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MODEL = "sigil/tiny-whisper.en";
const out = path.join(import.meta.dirname, "tiny-model", MODEL);
export const SENTENCE = ["Where", "Ġdid", "ĠI", "Ġpark", "Ġthe", "Ġcar", "?"];
const specials = ["<|endoftext|>", "<|startoftranscript|>", "<|en|>", "<|transcribe|>", "<|notimestamps|>"];
const vocab = [...SENTENCE, ...specials];
const id = (t) => vocab.indexOf(t);
const V = vocab.length;
const ROWS = 24;

// ---------------------------------------------------------------- a minimal protobuf writer (as make-tiny-model.mjs)

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
const intsAttr = (name, values) => msg(5, [str(1, name), ...values.map((v) => int(8, v)), int(20, 7)]);
const model = (graph) => new Uint8Array([...int(1, 8), ...str(2, "sigil-test"), ...graph, ...msg(8, [str(1, ""), int(2, 13)])]);
const i64 = (...v) => new Uint8Array(new BigInt64Array(v.map(BigInt)).buffer);

// ---------------------------------------------------------------- the encoder: the mean over the mel bands

const encoder = model(
  msg(7, [
    node("ReduceMean", ["input_features"], ["last_hidden_state"], [intsAttr("axes", [1]), intAttr("keepdims", 1)]),
    str(2, "sigil_tiny_whisper_encoder"),
    valueInfo(11, "input_features", FLOAT, ["batch_size", 80, 3000]),
    valueInfo(12, "last_hidden_state", FLOAT, ["batch_size", 1, 3000]),
  ]),
);

// ---------------------------------------------------------------- the decoder: the next word of the sentence, by position

const table = new Float32Array(ROWS * V);
for (let row = 0; row < ROWS; row++) {
  // The prompt is two tokens long, so the logits read at position 1 give the first word.
  const next = row >= 1 && row - 1 < SENTENCE.length ? id(SENTENCE[row - 1]) : id("<|endoftext|>");
  table[row * V + next] = 10;
}
const decoder = model(
  msg(7, [
    node("Shape", ["input_ids"], ["ids_shape"]),
    node("Gather", ["ids_shape", "one"], ["seq_len"], [intAttr("axis", 0)]),
    node("Range", ["zero", "seq_len", "one"], ["positions"]),
    node("Gather", ["table", "positions"], ["rows"], [intAttr("axis", 0)]),
    node("Unsqueeze", ["rows", "batch_axis"], ["rows_3d"]),
    node("ReduceSum", ["encoder_hidden_states"], ["heard"], [intAttr("keepdims", 0)]),
    node("Mul", ["heard", "nothing"], ["heard_none"]),
    node("Add", ["rows_3d", "heard_none"], ["logits"]),
    str(2, "sigil_tiny_whisper_decoder"),
    tensor(5, "table", FLOAT, [ROWS, V], new Uint8Array(table.buffer)),
    tensor(5, "zero", INT64, [], i64(0)),
    tensor(5, "one", INT64, [], i64(1)),
    tensor(5, "batch_axis", INT64, [1], i64(0)),
    tensor(5, "nothing", FLOAT, [], new Uint8Array(new Float32Array([0]).buffer)),
    valueInfo(11, "input_ids", INT64, ["batch_size", "decoder_sequence_length"]),
    valueInfo(11, "encoder_hidden_states", FLOAT, ["batch_size", "encoder_sequence_length", "hidden"]),
    valueInfo(12, "logits", FLOAT, ["batch_size", "decoder_sequence_length", V]),
  ]),
);

// ---------------------------------------------------------------- the tokenizer

const added = (content, i) => ({ id: i, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true });
const tokenizer = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: specials.map((s) => added(s, id(s))),
  normalizer: null,
  pre_tokenizer: { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: true },
  post_processor: null,
  decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true, use_regex: true },
  model: { type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: "", end_of_word_suffix: "", fuse_unk: false, byte_fallback: false, vocab: Object.fromEntries(vocab.map((w, i) => [w, i])), merges: [] },
};

mkdirSync(path.join(out, "onnx"), { recursive: true });
writeFileSync(path.join(out, "onnx", "encoder_model_quantized.onnx"), encoder);
writeFileSync(path.join(out, "onnx", "decoder_model_quantized.onnx"), decoder);
writeFileSync(path.join(out, "tokenizer.json"), JSON.stringify(tokenizer));
console.log(`wrote ${path.relative(process.cwd(), out)}: ${V} tokens, ${encoder.length + decoder.length} bytes of model`);
