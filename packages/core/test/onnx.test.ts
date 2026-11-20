// The real model runtime (onnxruntime-web on WebAssembly, the WordPiece
// tokenizer) against the tiny model in fixtures/, so no network is needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import { cosine, createOnnxEmbedder, isModelId, type OrtLike, type TokenizerClass } from "../src/index";
import { conceptEmbedder } from "./fixtures/embedder";

const MODEL = "sigil/tiny-embedder";
const DIR = path.join(import.meta.dirname, "fixtures/tiny-model", MODEL);

async function tiny() {
  return createOnnxEmbedder({
    model: MODEL,
    ort: ort as unknown as OrtLike,
    Tokenizer: Tokenizer as unknown as TokenizerClass,
    load: async (file) => (file.endsWith(".onnx") ? new Uint8Array(await readFile(path.join(DIR, file))) : readFile(path.join(DIR, file), "utf8")),
  });
}

describe("the on-device model runtime", () => {
  it("embeds with the same meaning as the reference table", async () => {
    const e = await tiny();
    const texts = ["My car needs the garage", "automobile", "Pasta for dinner", "nothing known here"];
    const got = await e.embed(texts);
    const want = await conceptEmbedder().embed(texts);
    expect(got).toHaveLength(4);
    for (let i = 0; i < 3; i++) expect(cosine(got[i], want[i])).toBeGreaterThan(0.999);
    expect(cosine(got[0], got[1])).toBeGreaterThan(0.9);
    expect(cosine(got[0], got[2])).toBeLessThan(0.3);
    expect(Array.from(got[3]).every((x) => x === 0)).toBe(true);
  });

  it("gives the same vector alone and in a padded batch, and cuts long input", async () => {
    const e = await tiny();
    const [alone] = await e.embed(["dog"]);
    const [, inBatch] = await e.embed(["the vet saw my puppy and my kitten today", "dog"]);
    expect(cosine(alone, inBatch)).toBeGreaterThan(0.9999);
    const [long] = await e.embed([`${"pasta ".repeat(600)} car`]);
    expect(long.length).toBe(16);
    expect(await e.embed([])).toEqual([]);
  });

  it("accepts only plain model ids", () => {
    expect(isModelId("Xenova/all-MiniLM-L6-v2")).toBe(true);
    expect(isModelId("../etc/passwd")).toBe(false);
    expect(isModelId("a/../../b")).toBe(false);
    expect(isModelId("nohandle")).toBe(false);
  });
});
