// The connector's view of a vault: the shared app-key client from the core,
// plus search by meaning computed on this machine. Memories are decrypted
// here, embedded here and searched here; the server sees only that the index
// was read. Vectors are kept in memory for this process only and never written
// anywhere.

import {
  ClientError,
  embeddingText,
  hybridSearch,
  sha256Hex,
  toResult,
  VaultClient,
  type ClientOptions,
  type Embedder,
  type SearchResult,
} from "@sigil/core";

export { ClientError as ReaderError };
export type { FolderInfo, FullMemory, SearchResult } from "@sigil/core";

export type EmbedderLoader = () => Promise<Embedder>;

export interface ReaderOptions extends ClientOptions {
  /** Loads the sentence model on first use. Without it, search is by words only. */
  embedder?: EmbedderLoader;
}

export type SemanticState = { state: "off" } | { state: "loading" } | { state: "ready"; model: string } | { state: "failed"; reason: string };

const CACHE_LIMIT = 20_000;

export class VaultReader extends VaultClient {
  private readonly loadEmbedder?: EmbedderLoader;
  private embedder: Promise<Embedder> | null = null;
  private semanticState: SemanticState;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(opts: ReaderOptions) {
    super(opts);
    this.loadEmbedder = opts.embedder;
    this.semanticState = opts.embedder ? { state: "loading" } : { state: "off" };
  }

  get semantic(): SemanticState {
    return this.semanticState;
  }

  private async model(): Promise<Embedder | null> {
    if (!this.loadEmbedder || this.semanticState.state === "failed") return null;
    if (!this.embedder) {
      this.embedder = this.loadEmbedder();
      this.embedder.then(
        (e) => (this.semanticState = { state: "ready", model: e.model }),
        (err) => (this.semanticState = { state: "failed", reason: (err as Error).message }),
      );
    }
    try {
      return await this.embedder;
    } catch {
      return null;
    }
  }

  private async embed(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map((t) => sha256Hex(`${embedder.model}\n${t}`));
    const missing = [...new Set(keys.filter((k) => !this.vectors.has(k)))];
    const byKey = new Map(keys.map((k, i) => [k, texts[i]]));
    for (let i = 0; i < missing.length; i += 16) {
      const chunk = missing.slice(i, i + 16);
      const out = await embedder.embed(chunk.map((k) => byKey.get(k)!));
      chunk.forEach((k, j) => this.vectors.set(k, out[j]));
    }
    if (this.vectors.size > CACHE_LIMIT) this.vectors.clear();
    return keys.map((k) => this.vectors.get(k)!);
  }

  /**
   * Searches by words and by meaning. The query and the memories are embedded
   * on this machine; nothing about the query reaches the server.
   */
  override async search(query: string, opts: { folder?: string; limit?: number } = {}): Promise<SearchResult[]> {
    const heads = await this.heads(opts);
    const items = heads.map((h) => ({ ...h, text: h.snippet }));
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const embedder = query.trim() ? await this.model() : null;
    if (!embedder) return hybridSearch(items, query, { limit }).map((h) => toResult(h.item, "words"));
    const [queryVector, ...vecs] = await this.embed(embedder, [query, ...items.map(embeddingText)]);
    const vectors = new Map(items.map((item, i) => [item.id, vecs[i]]));
    return hybridSearch(items, query, { queryVector, vectors, limit }).map((h) => toResult(h.item, h.match));
  }
}
