// The connector's model loader against the tiny model in the core fixtures:
// real files on disk, the real runtime, and never the network.

import { describe, expect, it } from "vitest";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cosine } from "@sigil/core";
import { embedSettings, loadEmbedder, defaultModelDir } from "../src/embed";

const FIXTURE = path.resolve(import.meta.dirname, "../../packages/core/test/fixtures/tiny-model");
const MODEL = "sigil/tiny-embedder";

describe("loading the model", () => {
  it("reads the settings, with search by meaning on unless switched off", () => {
    expect(embedSettings({ SIGIL_SEMANTIC: "off" })).toBeNull();
    expect(embedSettings({})).toMatchObject({ model: "Xenova/all-MiniLM-L6-v2", fetch: true });
    expect(embedSettings({ SIGIL_EMBED_MODEL: MODEL, SIGIL_MODEL_DIR: "/x", SIGIL_MODEL_FETCH: "off" })).toEqual({ model: MODEL, dir: "/x", fetch: false });
    expect(defaultModelDir()).toBe(path.resolve(import.meta.dirname, "../../.data/models"));
  });

  it("runs a model from disk without the network", async () => {
    const noNetwork = (() => Promise.reject(new Error("no network in tests"))) as unknown as typeof fetch;
    const e = await loadEmbedder({ model: MODEL, dir: FIXTURE, fetch: false }, noNetwork);
    const [car, auto, pasta] = await e.embed(["my car", "automobile", "pasta"]);
    expect(cosine(car, auto)).toBeGreaterThan(0.8);
    expect(cosine(car, pasta)).toBeLessThan(0.3);
  });

  it("fetches a missing file once and keeps it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sigil-models-"));
    cpSync(path.join(FIXTURE, MODEL, "tokenizer.json"), path.join(dir, MODEL, "tokenizer.json"), { recursive: true });
    cpSync(path.join(FIXTURE, MODEL, "tokenizer_config.json"), path.join(dir, MODEL, "tokenizer_config.json"));
    const asked: string[] = [];
    const hub = (async (url: string) => {
      asked.push(url);
      const { readFile } = await import("node:fs/promises");
      return new Response(new Uint8Array(await readFile(path.join(FIXTURE, MODEL, "onnx/model_quantized.onnx"))));
    }) as unknown as typeof fetch;
    await loadEmbedder({ model: MODEL, dir, fetch: true }, hub);
    expect(asked).toEqual([`https://huggingface.co/${MODEL}/resolve/main/onnx/model_quantized.onnx`]);
    expect(existsSync(path.join(dir, MODEL, "onnx/model_quantized.onnx"))).toBe(true);
    await loadEmbedder({ model: MODEL, dir, fetch: true }, hub);
    expect(asked).toHaveLength(1);
    await expect(loadEmbedder({ model: "../../etc", dir, fetch: false })).rejects.toThrow("not a model id");
    await expect(loadEmbedder({ model: "sigil/missing", dir, fetch: false })).rejects.toThrow("fetching is off");
  });
});
