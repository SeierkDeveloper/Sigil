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
  contextForBooking,
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
  sealTurnNote,
  toBase64Url,
  withoutCitations,
  type AskNote,
  type ModelCaller,
  type PendingBooking,
  type PublicItem,
  type PublicReply,
  type PublicSecret,
  type SelfRules,
} from "@sigil/core";
import type { Api } from "./api";
import { reportCaught } from "./immuneOps";
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
  /** Visitors may turn voice on: speech to text in their own browser. */
  voice?: boolean;
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
  /** Offer voice on the page: speech to text in the visitor's own browser. */
  voice?: boolean;
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
    voice: input.voice === true,
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

export interface PendingPublic {
  id: string;
  selfId: string;
  sessionId: string;
  askerKey: string;
  sealed: string;
  /** Set for a question in a booked session. */
  booking?: PendingBooking | null;
}

export const PUBLIC_ERROR_TEXT = "My AI self could not answer just now. Please try again later.";

export interface ComposedPublic {
  reply: PublicReply;
  question: string;
  /** Memories the immune system held back or neutralised for this answer. */
  caught?: number;
}

function publicKeyFor(self: NonNullable<VaultData["publicSelf"]>, q: Pick<PendingPublic, "sessionId" | "askerKey">): Uint8Array {
  const pair = linkPair({ secret: self.secret!.secret, label: "", rules: null, introKey: "" });
  return agentSessionKey(pair, self.id, q.sessionId, q.askerKey);
}

/** Writes the answer to one visitor's question without sending it: only from the public copy as published, within the public self's rules. Null when the question cannot be addressed. */
export async function composePublicAnswer(data: Pick<VaultData, "publicSelf">, items: PublicItem[], q: PendingPublic, model: ModelCaller): Promise<ComposedPublic | null> {
  const self = data.publicSelf;
  if (!self?.secret) return null;
  let key: Uint8Array;
  try {
    key = publicKeyFor(self, q);
  } catch {
    return null;
  }
  const ids = { linkId: self.id, sessionId: q.sessionId, messageId: q.id };
  let question = "";
  try {
    const opened = cleanQuestion(openAskMessage(key, ids, "q", q.sealed));
    question = opened.text;
    // A booked session: its house rules, topic and intake go to the model too, the intake opened with the public self's key.
    const pair = linkPair({ secret: self.secret.secret, label: "", rules: null, introKey: "" });
    const context = q.booking ? contextForBooking(pair, self.id, q.booking) : null;
    const a = await answerAsSelf({
      question,
      history: opened.history,
      rules: self.secret.rules,
      memories: publicMemories(items),
      model,
      asker: "public",
      context,
    });
    return { reply: { v: 1, text: withoutCitations(a.text), refused: a.refused, sources: a.citations.map((c) => ({ id: c.id, title: c.title })) }, question, caught: a.caught ? a.caught.held + a.caught.neutralised : 0 };
  } catch {
    return { reply: { v: 1, text: PUBLIC_ERROR_TEXT, refused: "error", sources: [] }, question: question || "(the question could not be opened)" };
  }
}

/** Seals a public answer for the visitor and the question and answer for this vault's log, and sends both. */
export async function sendPublicAnswer(api: Api, data: Pick<VaultData, "publicSelf" | "boxPublic">, q: Pick<PendingPublic, "id" | "sessionId" | "askerKey" | "booking">, composed: ComposedPublic): Promise<void> {
  const self = data.publicSelf;
  if (!self?.secret || !data.boxPublic) throw new Error("The public AI self is off.");
  const key = publicKeyFor(self, q);
  const ids = { linkId: self.id, sessionId: q.sessionId, messageId: q.id };
  const { reply, question } = composed;
  const note: AskNote = { v: 1, via: "public", label: self.name, question, answer: reply.text, citations: reply.sources, refused: reply.refused };
  // A turn of a booked session goes to the owner's transcript of that session, never to the page.
  const sealedNote = q.booking
    ? sealTurnNote(data.boxPublic, { v: 1, bookingId: q.booking.id, turn: q.booking.turn, question, answer: reply.text, sources: reply.sources, refused: reply.refused })
    : sealJson(decodeBoxPublicKey(data.boxPublic), note, askNoteContext(q.id, self.id));
  await api.post(`public/questions/${q.id}/answer`, {
    sealed: sealAskMessage(key, ids, "a", reply),
    note: sealedNote,
    cited: reply.sources.length,
    wall: reply.refused === "error" || q.booking ? null : { question, answer: reply.text, sources: reply.sources },
  });
}

/** The visitors waiting, and the public copy as published (fetched from the server, so an unpublished change never leaks). */
export async function pendingPublic(api: Api): Promise<{ questions: PendingPublic[]; items: PublicItem[] }> {
  const { questions } = await api.get<{ questions: PendingPublic[] }>("public/pending");
  if (questions.length === 0) return { questions, items: [] };
  const { items } = await api.get<{ items: PublicItem[] }>("public/self");
  return { questions, items };
}

/**
 * Answers waiting visitors: only from the public copy as published, within the
 * public self's rules, with the owner's model. The answer goes back sealed; the
 * question and answer are sealed into the owner's log.
 */
export async function servePublicOnce(api: Api, data: Pick<VaultData, "publicSelf" | "boxPublic">, deps: { model: ModelCaller; sessionsOnly?: boolean }): Promise<number> {
  const self = data.publicSelf;
  if (!self?.secret || !self.enabled || !data.boxPublic) return 0;
  const { questions, items } = await pendingPublic(api);
  let n = 0;
  for (const q of questions) {
    // With answers held for approval, questions in a booked session are still answered at once: a session runs within its time.
    if (deps.sessionsOnly && !q.booking) continue;
    const composed = await composePublicAnswer(data, items, q, deps.model);
    if (!composed) continue;
    reportCaught(api, q.booking ? "session" : "public", composed.caught ?? 0);
    try {
      await sendPublicAnswer(api, data, q, composed);
      n++;
    } catch {
      // Answered elsewhere or expired.
    }
  }
  return n;
}
