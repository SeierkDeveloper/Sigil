// Loads the sentence model for search by meaning, on this machine. The model
// files are public weights: they are read from SIGIL_MODEL_DIR, and fetched
// from the public model hub once if missing (unless SIGIL_MODEL_FETCH=off).
// The model runs on WebAssembly with one thread, so it works on any machine
// and stays light.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOnnxEmbedder, DEFAULT_EMBED_MODEL, isModelId, MODEL_FILES, type Embedder, type OrtLike, type TokenizerClass } from "@sigil/core";

export interface EmbedSettings {
  model: string;
  dir: string;
  fetch: boolean;
}

/** Inside the repository the models go in its .data folder (not committed); elsewhere in ~/.sigil/models. */
export function defaultModelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "../..");
  if (existsSync(path.join(repo, "connector")) && existsSync(path.join(repo, "packages", "core"))) return path.join(repo, ".data", "models");
  return path.join(homedir(), ".sigil", "models");
}

const flag = (v: string | undefined, fallback: boolean) => (v ? ["on", "1", "true", "yes"].includes(v.trim().toLowerCase()) : fallback);

/** Null when search by meaning is switched off. */
export function embedSettings(env: NodeJS.ProcessEnv = process.env): EmbedSettings | null {
  if (!flag(env.SIGIL_SEMANTIC, true)) return null;
  return {
    model: env.SIGIL_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    dir: env.SIGIL_MODEL_DIR?.trim() || defaultModelDir(),
    fetch: flag(env.SIGIL_MODEL_FETCH, true),
  };
}

async function file(settings: EmbedSettings, name: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const target = path.join(settings.dir, ...settings.model.split("/"), ...name.split("/"));
  if (existsSync(target)) return new Uint8Array(await readFile(target));
  if (!settings.fetch) throw new Error(`The model file ${name} is not in ${settings.dir} and fetching is off.`);
  const res = await fetcher(`https://huggingface.co/${settings.model}/resolve/main/${name}`);
  if (!res.ok) throw new Error(`The model hub answered ${res.status} for ${name}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part-${process.pid}`;
  await writeFile(part, bytes);
  await rename(part, target);
  return bytes;
}

export async function loadEmbedder(settings: EmbedSettings, fetcher: typeof fetch = fetch): Promise<Embedder> {
  if (!isModelId(settings.model)) throw new Error(`"${settings.model}" is not a model id.`);
  const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number }; logLevel?: string } };
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
  const { Tokenizer } = await import("@huggingface/tokenizers");
  return createOnnxEmbedder({
    model: settings.model,
    ort,
    Tokenizer: Tokenizer as unknown as TokenizerClass,
    load: async (name) => {
      const bytes = await file(settings, name, fetcher);
      return name.endsWith(".json") ? new TextDecoder().decode(bytes) : bytes;
    },
  });
}

export { MODEL_FILES };
