// The client side of an app key. The MCP connector, the browser extension and
// the Sign in with Sigil SDK all use this: it holds one app key, asks the
// server for the ciphertext that key was granted, and decrypts it where the
// app runs. Suggestions are sealed here, to the vault public key, after
// checking the vault vouched for that key. Nothing is cached between calls, so
// a revoked key stops working on the very next request.

import { decodeBoxPublicKey, verifyAppBoxTag } from "./box";
import { randomId, importKey } from "./crypto";
import { cleanProposal, sealProposal, type ProposalDraft, type ProposalVia } from "./inbox";
import { appKeys, parseAppKey } from "./keys";
import { search } from "./search";
import { redactMemory } from "./protect";
import {
  decryptHead,
  decryptMemory,
  isProfileMemory,
  openFolderWithRaw,
  openGrant,
  sourceLabel,
  type FolderKind,
  type MemoryHead,
  type MemorySource,
  type OpenFolder,
} from "./vault";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class ClientError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "error",
  ) {
    super(message);
    this.name = "ClientError";
  }
}

interface WireFolder {
  id: string;
  meta: string;
  wrappedKey: string;
  count: number;
  /** The owner protected it: its memories come only with the owner's yes for the read. */
  protected?: boolean;
}

interface WireHeld {
  folderId: string;
  memoryIds?: string[];
  requestId: string;
  state: string;
}

/** A read the server held back: the memories are in a protected folder and the owner has not said yes yet. */
export interface HeldRead {
  folderId: string;
  folder: string;
  memoryIds: string[];
  requestId: string;
  /** "pending" while the request waits in the owner's inbox; "denied" when the owner said no. */
  state: string;
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
  kind?: FolderKind;
  protected?: boolean;
}

export interface HeadInfo {
  id: string;
  folderId: string;
  folder: string;
  title: string;
  tags: string[];
  snippet: string;
  source: MemorySource;
  createdAt: string;
  editedAt: string;
  expiresAt?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  snippet: string;
  editedAt: string;
  /** How the memory matched: by its words, by meaning, or both. */
  match?: "words" | "meaning" | "both";
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

export interface ClientOptions {
  appKey: string;
  baseUrl: string;
  fetcher?: Fetcher;
  userAgent?: string;
  /** How suggestions from this client reached the inbox. */
  via?: ProposalVia;
}

export class VaultClient {
  readonly appId: string;
  protected readonly secret: Uint8Array;
  readonly baseUrl: string;
  protected readonly fetcher: Fetcher;
  private readonly userAgent?: string;
  private readonly via: ProposalVia;

  constructor(opts: ClientOptions) {
    const { appId, secret } = parseAppKey(opts.appKey);
    this.appId = appId;
    this.secret = secret;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.userAgent = opts.userAgent;
    this.via = opts.via ?? "mcp";
  }

  protected async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const { authToken } = await appKeys(this.secret);
    const headers: Record<string, string> = { authorization: `Bearer ${authToken}` };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/connector/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ClientError(`Could not reach Sigil at ${this.baseUrl}: ${(err as Error).message}`, 0, "network");
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // fall through with an empty object
    }
    if (!res.ok) {
      throw new ClientError(typeof data.error === "string" ? data.error : `Sigil answered ${res.status}.`, res.status, typeof data.code === "string" ? data.code : "error");
    }
    return data as T;
  }

  protected async openFolders(wire: WireFolder[]): Promise<Map<string, OpenFolder>> {
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
    return r.folders.map((f) => {
      const o = open.get(f.id)!;
      return { id: f.id, name: o.name, memories: f.count, ...(o.kind ? { kind: o.kind } : {}), ...(f.protected ? { protected: true } : {}) };
    });
  }

  /** Protected folders the last index left out, by name, and the reads the server held back last. */
  lastSkipped: string[] = [];
  lastHeld: HeldRead[] = [];

  /**
   * Titles, tags and first lines of every memory this app may see, decrypted
   * here and masked with each folder's redaction rules. One read-log entry.
   * Protected folders are left out; naming one in `folder` asks the owner for
   * a look at it (the server answers with the request until they say yes).
   */
  async heads(opts: { folder?: string } = {}): Promise<HeadInfo[]> {
    let r = await this.call<{ folders: WireFolder[]; memories: WireMemory[]; held?: WireHeld[] }>("GET", "index");
    let folders = await this.openFolders(r.folders);
    const wanted = opts.folder?.trim().toLowerCase();
    const guarded = r.folders.filter((f) => f.protected).map((f) => folders.get(f.id)!);
    const asked = wanted ? guarded.find((f) => f.name.toLowerCase() === wanted || f.id === opts.folder) : undefined;
    this.lastHeld = [];
    if (asked) {
      r = await this.call("GET", `index?protected=${encodeURIComponent(asked.id)}`);
      folders = await this.openFolders(r.folders);
      this.lastHeld = (r.held ?? []).map((h) => ({ folderId: h.folderId, folder: asked.name, memoryIds: h.memoryIds ?? [], requestId: h.requestId, state: h.state }));
    }
    const shown = new Set(r.memories.map((m) => m.folderId));
    this.lastSkipped = guarded.filter((f) => !shown.has(f.id)).map((f) => f.name);
    const out: HeadInfo[] = [];
    for (const m of r.memories) {
      const folder = folders.get(m.folderId);
      if (!folder) continue;
      if (wanted && folder.name.toLowerCase() !== wanted && folder.id !== opts.folder) continue;
      const head: MemoryHead = await decryptHead(folder, m);
      // An expired memory waits in the owner's Expired view and is not offered to apps.
      if (head.expiresAt && new Date(head.expiresAt).getTime() <= Date.now()) continue;
      const { body: _body, ...masked } = redactMemory({ ...head, body: "" }, folder.redact);
      out.push({ ...masked, id: m.id, folderId: folder.id, folder: folder.name });
    }
    return out;
  }

  /** Keyword search over titles, tags and first lines. The query never leaves this machine. */
  async search(query: string, opts: { folder?: string; limit?: number } = {}): Promise<SearchResult[]> {
    const heads = await this.heads(opts);
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    return search(
      heads.map((h) => ({ ...h, text: h.snippet })),
      query,
      limit,
    ).map(({ item }) => toResult(item, "words"));
  }

  /**
   * Reads whole memories, masked with each folder's redaction rules. Each one
   * read is written to the owner's read log. Memories in a protected folder
   * come back in `held` until the owner says yes for this read.
   */
  async read(ids: string[]): Promise<{ memories: FullMemory[]; missing: string[]; held: HeldRead[] }> {
    const r = await this.call<{ folders: WireFolder[]; memories: WireMemory[]; missing: string[]; held?: WireHeld[] }>("POST", "read", { ids });
    const folders = await this.openFolders(r.folders);
    const memories: FullMemory[] = [];
    for (const m of r.memories) {
      const folder = folders.get(m.folderId);
      if (!folder) continue;
      const full = redactMemory(await decryptMemory(folder, m), folder.redact);
      memories.push({
        id: full.id,
        title: full.title,
        folder: folder.name,
        tags: full.tags,
        source: sourceLabel(full.source),
        createdAt: full.createdAt,
        editedAt: full.editedAt,
        body: full.body,
      });
    }
    const held = (r.held ?? []).map((h) => ({ folderId: h.folderId, folder: "a protected folder", memoryIds: h.memoryIds ?? [], requestId: h.requestId, state: h.state }));
    this.lastHeld = held;
    return { memories, missing: r.missing, held };
  }

  /** The Self card, when this app may read its folder. Null when it may not, or none exists. */
  async profile(): Promise<FullMemory | null> {
    const heads = await this.heads();
    const card = heads.filter((h) => isProfileMemory(h)).sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1))[0];
    if (!card) return null;
    const { memories } = await this.read([card.id]);
    return memories[0] ?? null;
  }

  /**
   * The vault public key, checked against the tag the vault made with this app's
   * own secret. A key the server made up fails the check and nothing is sealed.
   */
  async inboxKey(): Promise<Uint8Array> {
    const r = await this.call<{ publicKey: string; tag: string | null }>("GET", "inbox");
    if (!r.tag || !(await verifyAppBoxTag(this.secret, r.publicKey, r.tag))) {
      throw new ClientError(
        "The vault public key could not be verified, so nothing was sent. Turn suggestions off and on again for this app in your vault.",
        0,
        "unverified_key",
      );
    }
    return decodeBoxPublicKey(r.publicKey);
  }

  /** Seals a suggested memory on this machine and puts it in the owner's inbox. */
  async propose(draft: ProposalDraft): Promise<{ id: string }> {
    const payload = cleanProposal(draft, this.via);
    const publicKey = await this.inboxKey();
    const id = randomId();
    const sealed = sealProposal(publicKey, id, this.appId, payload);
    await this.call("POST", "proposals", { id, sealed });
    return { id };
  }
}

export function toResult(item: HeadInfo, match: SearchResult["match"]): SearchResult {
  return { id: item.id, title: item.title, folder: item.folder, tags: item.tags, snippet: item.snippet, editedAt: item.editedAt, match };
}
