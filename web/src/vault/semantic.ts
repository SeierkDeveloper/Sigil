"use client";

// Search by meaning in the vault page. The model runs in a worker on this
// device; memories are embedded here and the vectors never leave the browser.
// They are kept between visits in this browser's storage, encrypted with a key
// derived from the vault key, under names that do not reveal the text.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  embedAll,
  embeddingCacheKey,
  embeddingText,
  hkdf,
  importKey,
  openVector,
  sealVector,
  type Embedder,
  type EmbeddingCache,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

// ---------------------------------------------------------------- the worker

type Out =
  | { type: "ready" }
  | { type: "failed"; reason: string }
  | { type: "vectors"; id: number; vectors: Float32Array[] }
  | { type: "error"; id: number; reason: string };

export class WorkerEmbedder implements Embedder {
  private next = 1;
  private readonly waiting = new Map<number, { resolve(v: Float32Array[]): void; reject(e: Error): void }>();

  private constructor(
    readonly model: string,
    private readonly worker: Worker,
  ) {
    worker.addEventListener("message", (e: MessageEvent<Out>) => {
      const m = e.data;
      if (m.type !== "vectors" && m.type !== "error") return;
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === "vectors") w.resolve(m.vectors);
      else w.reject(new Error(m.reason));
    });
  }

  static start(model: string): Promise<WorkerEmbedder> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker("/vendor/embed-worker.js", { type: "module", name: "sigil-embed" });
      } catch (err) {
        reject(err);
        return;
      }
      const onMessage = (e: MessageEvent<Out>) => {
        if (e.data.type === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve(new WorkerEmbedder(model, worker));
        } else if (e.data.type === "failed") {
          worker.terminate();
          reject(new Error(e.data.reason));
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (e) => {
        worker.terminate();
        reject(new Error(e.message || "The search model could not start."));
      });
      worker.postMessage({ type: "load", model });
    });
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: "embed", id, texts });
    });
  }

  stop(): void {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error("Stopped."));
    this.waiting.clear();
  }
}

// ---------------------------------------------------------------- the encrypted cache

const DB_NAME = "sigil-vectors";
const STORE = "v";

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function idbPut(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Removes every kept vector from this browser (used when the vault is deleted). */
export async function clearVectorCache(): Promise<void> {
  try {
    indexedDB.deleteDatabase(DB_NAME);
  } catch {
    // Nothing kept, or storage is not available.
  }
}

export interface VaultVectorCache extends EmbeddingCache {
  keyFor(text: string): string;
}

/** A cache whose names are HMACs and whose values are AES-256-GCM, both under keys derived from the vault key. */
export async function vectorCache(vault: Unlocked, model: string): Promise<VaultVectorCache> {
  const nameKey = await hkdf(vault.raw, "sigil:embed-cache:names");
  const valueKey = await importKey(await hkdf(vault.raw, "sigil:embed-cache:values"));
  const db = await idb();
  const memory = new Map<string, Float32Array>();
  return {
    keyFor: (text) => embeddingCacheKey(nameKey, model, text),
    async get(key) {
      const hit = memory.get(key);
      if (hit || !db) return hit;
      const env = await idbGet(db, key);
      if (!env) return undefined;
      try {
        const v = await openVector(valueKey, model, key, env);
        memory.set(key, v);
        return v;
      } catch {
        return undefined;
      }
    },
    async set(key, v) {
      memory.set(key, v);
      if (db) await idbPut(db, key, await sealVector(valueKey, model, key, v));
    },
  };
}

// ---------------------------------------------------------------- the index the vault tabs share

export type SemanticStatus =
  | { state: "off" }
  | { state: "loading" }
  | { state: "indexing"; done: number; total: number }
  | { state: "ready"; total: number }
  | { state: "failed"; reason: string };

export interface SemanticIndex {
  status: SemanticStatus;
  /** Vectors by memory id, for the memories understood so far. */
  vectors: Map<string, Float32Array>;
  /** The query's vector, or null when search by meaning is not available. */
  embedQuery(query: string): Promise<Float32Array | null>;
}

interface Indexable {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

const textOf = (m: Indexable) => embeddingText({ title: m.title, tags: m.tags, text: m.body });

export function useSemanticIndex(api: Api, vault: Unlocked, memories: Indexable[]): SemanticIndex {
  const [status, setStatus] = useState<SemanticStatus>({ state: "loading" });
  const [vectors, setVectors] = useState<Map<string, Float32Array>>(() => new Map());
  const engine = useRef<{ embedder: WorkerEmbedder; cache: VaultVectorCache } | null>(null);
  const [engineReady, setEngineReady] = useState(false);

  useEffect(() => {
    let alive = true;
    let started: WorkerEmbedder | null = null;
    (async () => {
      try {
        const info = await api.get<{ enabled: boolean; model: string }>("semantic");
        if (!info.enabled || typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
          if (alive) setStatus({ state: "off" });
          return;
        }
        const [embedder, cache] = await Promise.all([WorkerEmbedder.start(info.model), vectorCache(vault, info.model)]);
        started = embedder;
        if (!alive) return embedder.stop();
        engine.current = { embedder, cache };
        setEngineReady(true);
      } catch (err) {
        if (alive) setStatus({ state: "failed", reason: (err as Error).message });
      }
    })();
    return () => {
      alive = false;
      started?.stop();
      engine.current = null;
    };
  }, [api, vault]);

  // Embed whatever is new or changed, in the background, a batch at a time.
  const wanted = useMemo(() => memories.map((m) => ({ id: m.id, text: textOf(m) })), [memories]);
  useEffect(() => {
    const e = engine.current;
    if (!engineReady || !e) return;
    let alive = true;
    (async () => {
      const items = wanted.map((w) => ({ key: e.cache.keyFor(w.text), id: w.id, text: w.text }));
      try {
        const byKey = await embedAll(e.embedder, items, e.cache, 16, (done, total) => {
          if (alive && done < total) setStatus({ state: "indexing", done, total });
        });
        if (!alive) return;
        setVectors(new Map(items.map((i) => [i.id, byKey.get(i.key)!])));
        setStatus({ state: "ready", total: items.length });
      } catch (err) {
        if (alive) setStatus({ state: "failed", reason: (err as Error).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [wanted, engineReady]);

  const embedQuery = useCallback(async (query: string) => {
    const e = engine.current;
    if (!e || !query.trim()) return null;
    try {
      return (await e.embedder.embed([query]))[0];
    } catch {
      return null;
    }
  }, []);

  return { status, vectors, embedQuery };
}
