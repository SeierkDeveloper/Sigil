// The public AI self on the owner's device: setting it up (a key pair made
// here, its private half and rules sealed with the vault key), publishing the
// public copy of the folders made public, answering visitors while the vault
// is open, and the wall of answers the owner can hide.

import {
  agentSessionKey,
  answerAsSelf,
  askNoteContext,
  cleanQuestion,
  cleanRules,
  decodeBoxPublicKey,
  encodeBoxPublicKey,
  linkPair,
  newBoxKeyPair,
  openAskMessage,
  openAppSecret,
  openPublicSecret,
  publicCopy,
  publicCopyHash,
  publicMemories,
  randomId,
  sealAskMessage,
  sealJson,
  sealPublicForApp,
  sealPublicSecret,
  toBase64Url,
  withoutCitations,
  type AskNote,
  type ModelCaller,
  type PublicItem,
  type PublicReply,
  type PublicSecret,
  type SelfRules,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

export interface WallEntry {
  id: string;
  question: string;
  answer: string;
  sources: { id: string; title: string }[];
  hidden: boolean;
  createdAt: string;
}

export interface ServerPublicSelf {
  id: string;
  handle: string;
  name: string;
  greeting: string;
  publicKey: string;
  ownerBox: string;
  appId: string | null;
  perVisitorHour: number;
  showAnswers: boolean;
  enabled: boolean;
  copyHash: string | null;
  publishedAt: string | null;
  items: number;
  asked: number;
  answered: number;
  online: boolean;
  wall: WallEntry[];
  createdAt: string;
}

export interface PublicSelfView extends Omit<ServerPublicSelf, "ownerBox"> {
  /** The private key, rules and public folders, opened on this device. Null if it would not open. */
  secret: PublicSecret | null;
}

export async function openPublicSelf(vault: Unlocked, s: ServerPublicSelf | null | undefined): Promise<{ self: PublicSelfView | null; unreadable: number }> {
  if (!s) return { self: null, unreadable: 0 };
  let secret: PublicSecret | null = null;
  try {
    secret = await openPublicSecret(vault.key, s.id, s.ownerBox);
  } catch {
    secret = null;
  }
  const { ownerBox: _b, ...rest } = s;
  return { self: { ...rest, secret }, unreadable: secret ? 0 : 1 };
}

export interface PublicInput {
  handle: string;
  name: string;
  greeting: string;
  /** Tone, topics and things never to say. Its folders are always the public copy. */
  rules: SelfRules;
  /** The folders made public. */
  folderIds: string[];
  perVisitorHour: number;
  showAnswers: boolean;
  enabled: boolean;
  /** A connector that answers while the vault is closed, or null. */
  appId: string | null;
}

/** The public copy as it should be now: the public folders, masked with their redaction rules, protected folders never. */
export function currentCopy(data: Pick<VaultData, "memories" | "folders">, folderIds: string[]): { items: PublicItem[]; hash: string } {
  const items = publicCopy(data.memories, data.folders, folderIds);
  return { items, hash: publicCopyHash(items) };
}

/** Sets up or changes the public AI self, and publishes its public copy. */
export async function savePublic(api: Api, vault: Unlocked, data: VaultData, input: PublicInput): Promise<PublicSelfView> {
  const existing = data.publicSelf;
  const id = existing?.id ?? randomId();
  let secretKey = existing?.secret?.secret;
  let publicKey = existing?.publicKey;
  if (!secretKey || !publicKey) {
    const pair = newBoxKeyPair();
    secretKey = toBase64Url(pair.secretKey);
    publicKey = encodeBoxPublicKey(pair.publicKey);
  }
  const folderIds = input.folderIds.filter((f) => data.folders.some((x) => x.id === f && !x.protect));
  const rules = cleanRules({ ...input.rules, folderIds: ["public"] });
  const secret: PublicSecret = { v: 1, secret: secretKey, rules, folderIds };
  let appBox: string | null = null;
  if (input.appId) {
    const app = data.apps.find((a) => a.id === input.appId && !a.revokedAt);
    if (!app) throw new Error("That app is not connected.");
    if (!data.model) throw new Error("Add your model key first: the app answers with it.");
    if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
    appBox = await sealPublicForApp(await openAppSecret(vault.key, app), app.id, id, { ...secret, model: data.model, boxPublic: data.boxPublic });
  }
  await api.put("public/self", {
    id,
    handle: input.handle,
    name: input.name.trim() || "My AI self",
    greeting: input.greeting.trim().slice(0, 400),
    publicKey,
    ownerBox: await sealPublicSecret(vault.key, id, secret),
    appId: input.appId,
    appBox,
    perVisitorHour: input.perVisitorHour,
    showAnswers: input.showAnswers,
    enabled: input.enabled,
  });
  const copy = currentCopy(data, folderIds);
  await api.put("public/self/items", copy);
  const r = await api.get<{ self: ServerPublicSelf }>("public/self");
  return (await openPublicSelf(vault, r.self)).self!;
}

/** Publishes the public copy again when what is in the public folders changed. Returns true when it did. */
export async function republish(api: Api, data: Pick<VaultData, "memories" | "folders" | "publicSelf">): Promise<boolean> {
  const self = data.publicSelf;
  if (!self?.secret) return false;
  const copy = currentCopy(data, self.secret.folderIds);
  if (copy.hash === self.copyHash) return false;
  await api.put("public/self/items", copy);
  return true;
}

export async function turnOffPublic(api: Api): Promise<void> {
  await api.del("public/self");
}

export async function hideWallAnswer(api: Api, id: string, hidden: boolean): Promise<void> {
  await api.post(`public/wall/${id}/hide`, { hidden });
}

export function publicUrl(origin: string, handle: string): string {
  return `${origin.replace(/\/$/, "")}/@${handle}`;
}

// ---------------------------------------------------------------- answering while the vault is open

interface PendingPublic {
  id: string;
  selfId: string;
  sessionId: string;
  askerKey: string;
  sealed: string;
}

export const PUBLIC_ERROR_TEXT = "My AI self could not answer just now. Please try again later.";

/**
 * Answers waiting visitors: only from the public copy as published (fetched
 * from the server, so an unpublished change never leaks), within the public
 * self's rules, with the owner's model. The answer goes back sealed; the
 * question and answer are sealed into the owner's log.
 */
export async function servePublicOnce(api: Api, data: Pick<VaultData, "publicSelf" | "boxPublic">, deps: { model: ModelCaller }): Promise<number> {
  const self = data.publicSelf;
  if (!self?.secret || !self.enabled || !data.boxPublic) return 0;
  const { questions } = await api.get<{ questions: PendingPublic[] }>("public/pending");
  if (questions.length === 0) return 0;
  const { items } = await api.get<{ items: PublicItem[] }>("public/self");
  const memories = publicMemories(items);
  const pair = linkPair({ secret: self.secret.secret, label: "", rules: null, introKey: "" });
  let n = 0;
  for (const q of questions) {
    const ids = { linkId: self.id, sessionId: q.sessionId, messageId: q.id };
    let reply: PublicReply;
    let question = "";
    let key: Uint8Array;
    try {
      key = agentSessionKey(pair, self.id, q.sessionId, q.askerKey);
    } catch {
      continue;
    }
    try {
      const opened = cleanQuestion(openAskMessage(key, ids, "q", q.sealed));
      question = opened.text;
      const a = await answerAsSelf({ question, history: opened.history, rules: self.secret.rules, memories, model: deps.model, asker: "public" });
      reply = { v: 1, text: withoutCitations(a.text), refused: a.refused, sources: a.citations.map((c) => ({ id: c.id, title: c.title })) };
    } catch {
      reply = { v: 1, text: PUBLIC_ERROR_TEXT, refused: "error", sources: [] };
      if (!question) question = "(the question could not be opened)";
    }
    const note: AskNote = { v: 1, via: "public", label: self.name, question, answer: reply.text, citations: reply.sources, refused: reply.refused };
    try {
      await api.post(`public/questions/${q.id}/answer`, {
        sealed: sealAskMessage(key, ids, "a", reply),
        note: sealJson(decodeBoxPublicKey(data.boxPublic), note, askNoteContext(q.id, self.id)),
        cited: reply.sources.length,
        wall: reply.refused === "error" ? null : { question, answer: reply.text, sources: reply.sources },
      });
      n++;
    } catch {
      // Answered elsewhere or expired.
    }
  }
  return n;
}
