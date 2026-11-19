// The connector's view of a vault. It holds one app key, asks the Sigil server
// for the encrypted folders and memories this app was granted, and decrypts
// them here, on the user's machine. Nothing is cached between calls, so a
// revoked key stops working on the very next request.

import {
  appKeys,
  decryptHead,
  decryptMemory,
  importKey,
  openFolderWithRaw,
  openGrant,
  parseAppKey,
  search,
  type MemoryHead,
  type OpenFolder,
} from "@sigil/core";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class ReaderError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "error",
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

interface WireFolder {
  id: string;
  meta: string;
  wrappedKey: string;
  count: number;
}

interface WireMemory {
  id: string;
  folderId: string;
  head: string;
  body?: string;
}

export interface FolderInfo {
  id: string;
  name: string;
  memories: number;
}

export interface SearchResult {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  snippet: string;
  editedAt: string;
}

export interface FullMemory {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  source: string;
  createdAt: string;
  editedAt: string;
  body: string;
}

export interface ReaderOptions {
  appKey: string;
  baseUrl: string;
  fetcher?: Fetcher;
  userAgent?: string;
}

export class VaultReader {
  private readonly appId: string;
  private readonly secret: Uint8Array;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly userAgent: string;

  constructor(opts: ReaderOptions) {
    const { appId, secret } = parseAppKey(opts.appKey);
    this.appId = appId;
    this.secret = secret;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.userAgent = opts.userAgent ?? "sigil-connector";
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const { authToken } = await appKeys(this.secret);
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/connector/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${authToken}`,
          "user-agent": this.userAgent,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ReaderError(`Could not reach Sigil at ${this.baseUrl}: ${(err as Error).message}`, 0, "network");
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // fall through with an empty object
    }
    if (!res.ok) {
      throw new ReaderError(typeof data.error === "string" ? data.error : `Sigil answered ${res.status}.`, res.status, typeof data.code === "string" ? data.code : "error");
    }
    return data as T;
  }

  private async openFolders(wire: WireFolder[]): Promise<Map<string, OpenFolder>> {
    const wrapKey = await importKey((await appKeys(this.secret)).wrapKey);
    const out = new Map<string, OpenFolder>();
    for (const f of wire) {
      const raw = await openGrant(this.appId, wrapKey, { folderId: f.id, wrappedKey: f.wrappedKey });
      out.set(f.id, await openFolderWithRaw(f, raw));
    }
    return out;
  }

  async listFolders(): Promise<FolderInfo[]> {
    const r = await this.call<{ folders: WireFolder[] }>("GET", "folders");
    const open = await this.openFolders(r.folders);
    return r.folders.map((f) => ({ id: f.id, name: open.get(f.id)!.name, memories: f.count }));
  }

  /**
   * Searches titles, tags and the first lines of every memory this app may see.
   * The query never leaves this machine: the server only sees that the index was read.
   */
  async search(query: string, opts: { folder?: string; limit?: number } = {}): Promise<SearchResult[]> {
    const r = await this.call<{ folders: WireFolder[]; memories: WireMemory[] }>("GET", "index");
    const folders = await this.openFolders(r.folders);
    const wanted = opts.folder?.trim().toLowerCase();
    const heads: (MemoryHead & { id: string; folder: string; text: string })[] = [];
    for (const m of r.memories) {
      const folder = folders.get(m.folderId);
      if (!folder) continue;
      if (wanted && folder.name.toLowerCase() !== wanted && folder.id !== opts.folder) continue;
      const head = await decryptHead(folder, m);
      heads.push({ ...head, id: m.id, folder: folder.name, text: head.snippet });
    }
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    return search(heads, query, limit).map(({ item }) => ({
      id: item.id,
      title: item.title,
      folder: item.folder,
      tags: item.tags,
      snippet: item.snippet,
      editedAt: item.editedAt,
    }));
  }

  /** Reads whole memories. Each one read is written to the owner's read log. */
  async read(ids: string[]): Promise<{ memories: FullMemory[]; missing: string[] }> {
    const r = await this.call<{ folders: WireFolder[]; memories: WireMemory[]; missing: string[] }>("POST", "read", { ids });
    const folders = await this.openFolders(r.folders);
    const memories: FullMemory[] = [];
    for (const m of r.memories) {
      const folder = folders.get(m.folderId);
      if (!folder) continue;
      const full = await decryptMemory(folder, m);
      memories.push({
        id: full.id,
        title: full.title,
        folder: folder.name,
        tags: full.tags,
        source: full.source.kind === "note" ? "Written in Sigil" : full.source.kind === "chatgpt" ? "Imported from ChatGPT" : "Imported from Claude",
        createdAt: full.createdAt,
        editedAt: full.editedAt,
        body: full.body,
      });
    }
    return { memories, missing: r.missing };
  }
}
