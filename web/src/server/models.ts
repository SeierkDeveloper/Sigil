// Serves the files of the sentence model the vault page runs in the browser,
// and of the speech model a page runs when someone turns voice on. They are
// public model weights, the same for everyone; no memory, query, vector or
// sound ever comes here. Files are kept on disk under the data folder and, when
// missing, fetched once from the public model hub (SIGIL_MODEL_FETCH=off turns
// that off, so a server can be given the files by hand and never go online).

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isModelId, MODEL_FILES, SPEECH_MODEL_FILES } from "@sigil/core";
import { serverConfig } from "./config";
import { dataFile } from "./db";

const HUB = "https://huggingface.co";
const TYPES: Record<string, string> = { ".json": "application/json; charset=utf-8", ".onnx": "application/octet-stream" };

export function modelDir(): string {
  return serverConfig.modelDir ?? path.join(path.dirname(dataFile()), "models");
}

const inflight = new Map<string, Promise<void>>();

async function download(model: string, file: string, target: string, fetcher: typeof fetch): Promise<void> {
  const res = await fetcher(`${HUB}/${model}/resolve/main/${file}`);
  if (!res.ok || !res.body) throw new Error(`The model hub answered ${res.status} for ${file}.`);
  await mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part-${process.pid}-${Date.now()}`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  await rename(part, target);
}

/** The model a path asks for, if it is one this site serves, and its file. */
function served(parts: string[]): { model: string; file: string } | null {
  const offered: [string, boolean, readonly string[]][] = [
    [serverConfig.embedModel, serverConfig.semanticEnabled, MODEL_FILES],
    [serverConfig.speechModel, serverConfig.voiceEnabled, SPEECH_MODEL_FILES],
  ];
  for (const [model, on, files] of offered) {
    const prefix = model.split("/");
    const file = parts.slice(prefix.length).join("/");
    const sameModel = parts.length > prefix.length && prefix.every((p, i) => parts[i] === p);
    if (on && isModelId(model) && sameModel && files.includes(file)) return { model, file };
  }
  return null;
}

/** GET /models/<owner>/<name>/<file>, for the configured models and their known files only. */
export async function handleModel(req: Request, parts: string[], fetcher: typeof fetch = fetch): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const found = served(parts);
  if (!found) return new Response("Not found", { status: 404 });
  const { model, file } = found;
  const prefix = model.split("/");
  const target = path.join(modelDir(), ...prefix, ...file.split("/"));
  const exists = await stat(target).then((s) => s.isFile(), () => false);
  if (!exists) {
    if (!serverConfig.modelFetch) return new Response("Not found", { status: 404 });
    let job = inflight.get(target);
    if (!job) {
      job = download(model, file, target, fetcher).finally(() => inflight.delete(target));
      inflight.set(target, job);
    }
    try {
      await job;
    } catch (err) {
      console.error("[sigil] model download failed", (err as Error).message);
      return new Response("The model could not be fetched.", { status: 502 });
    }
  }
  const body = await readFile(target);
  return new Response(req.method === "HEAD" ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": String(body.length),
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
