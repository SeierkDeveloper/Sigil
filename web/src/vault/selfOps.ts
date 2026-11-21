// Your AI self, on the owner's device: the rules and the model key (both saved
// encrypted in the vault), the apps allowed to answer as it, the ask links, and
// the agent that answers a link's questions while the vault is open. Nothing
// here sends readable text, a rule or a key to the server.

import {
  AAD,
  agentSessionKey,
  linkGreetingKey,
  answerAsSelf,
  appSelfKey,
  askNoteContext,
  askUrl,
  cleanQuestion,
  cleanRules,
  createModelCaller,
  decodeBoxPublicKey,
  encryptJson,
  fromBase64Url,
  importKey,
  linkPair,
  newAskLink,
  openAppSecret,
  openAskMessage,
  openSealedJson,
  parseProfileBody,
  sealAskMessage,
  sealIntro,
  sealJson,
  sealSetting,
  toBase64Url,
  withoutCitations,
  type AskLinkSecret,
  type AskNote,
  type AskReply,
  type BoxKeyPair,
  type ModelCaller,
  type ModelSettings,
  type SelfAnswer,
  type SelfMemory,
  type SelfRules,
  type SelfTurn,
  type ThinkingSettings,
} from "@sigil/core";
import type { Api } from "./api";
import { reportCaught } from "./immuneOps";
import { profileMemory, type AppView, type AskLinkView, type Unlocked, type VaultData } from "./ops";
import { ASKED_TEXT, guardedMemories, protectedGate } from "./protectOps";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- settings

export async function saveModel(api: Api, vault: Unlocked, settings: ModelSettings | null): Promise<void> {
  if (!settings) await api.del("settings/model");
  else await api.put("settings/model", { value: await sealSetting(vault.key, "model", settings) });
}

export async function saveRules(api: Api, vault: Unlocked, rules: SelfRules): Promise<SelfRules> {
  const clean = cleanRules(rules);
  await api.put("settings/self", { value: await sealSetting(vault.key, "self", clean) });
  return clean;
}

export async function saveThinking(api: Api, vault: Unlocked, thinking: ThinkingSettings): Promise<void> {
  await api.put("settings/thinking", { value: await sealSetting(vault.key, "thinking", thinking) });
}

export function modelCaller(data: Pick<VaultData, "model">, fetcher?: Fetch): ModelCaller | null {
  return data.model ? createModelCaller(data.model, fetcher ? { fetch: fetcher } : {}) : null;
}

// ---------------------------------------------------------------- what the AI self may read

/**
 * The vault's own memories, with folder names, as the AI self sees them:
 * expired memories, briefs and the Self card left out, protected folders left
 * out unless the owner said yes (`open`), and each masked with its folder's
 * redaction rules.
 */
export function selfMemories(data: Pick<VaultData, "memories" | "folders">, now = Date.now(), open: Set<string> = new Set()): SelfMemory[] {
  return guardedMemories(data, open, now);
}

/** The Self card's text, when the rules allow its folder. */
export function selfProfile(data: Pick<VaultData, "memories" | "folders">, rules: SelfRules): string | null {
  const card = profileMemory(data);
  if (!card || !rules.folderIds.includes(card.folderId)) return null;
  const p = parseProfileBody(card.body);
  return [p.who && `Who I am: ${p.who}`, p.answers && `How I like answers: ${p.answers}`, p.projects && `Current projects: ${p.projects}`].filter(Boolean).join("\n");
}

export interface MeaningDeps {
  embedQuery?: (q: string) => Promise<Float32Array | null>;
  vectors?: Map<string, Float32Array>;
}

/** The owner's own test chat: the same answer a guest would get, with the memories it used. `open` holds protected folders the owner said yes to for this answer. */
export async function askInVault(
  data: VaultData,
  rules: SelfRules,
  model: ModelCaller,
  question: string,
  history: SelfTurn[] = [],
  deps: MeaningDeps = {},
  open: Set<string> = new Set(),
): Promise<SelfAnswer> {
  const queryVector = deps.embedQuery ? await deps.embedQuery(question) : null;
  return answerAsSelf({
    question,
    history,
    rules,
    memories: selfMemories(data, Date.now(), open),
    profile: selfProfile(data, rules),
    model,
    asker: "owner",
    queryVector,
    vectors: deps.vectors,
    immune: data.immune,
  });
}

// ---------------------------------------------------------------- apps that answer as the AI self

export interface AppSelfConfig {
  v: 1;
  rules: SelfRules;
  model: ModelSettings;
  /** The vault public key, so the app can seal what it logs. Inside this envelope, so the server cannot swap it. */
  boxPublic: string;
}

async function appSelfEnvelope(vault: Unlocked, app: Pick<AppView, "id" | "secret">, config: AppSelfConfig): Promise<string> {
  const secret = await openAppSecret(vault.key, app);
  return encryptJson(await importKey(await appSelfKey(secret)), config, AAD.appSelf(app.id));
}

/** Lets an app answer as the AI self (the ask_self tool, and links it answers), or stops it. */
export async function setAppSelf(api: Api, vault: Unlocked, data: VaultData, app: Pick<AppView, "id" | "secret">, enabled: boolean): Promise<void> {
  if (!enabled) {
    await api.del(`apps/${app.id}/self`);
    return;
  }
  if (!data.self) throw new Error("Save your AI self's rules first.");
  if (!data.model) throw new Error("Add your model key first.");
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  await api.put(`apps/${app.id}/self`, { config: await appSelfEnvelope(vault, app, { v: 1, rules: data.self, model: data.model, boxPublic: data.boxPublic }) });
}

/** After the rules or the model key change, the apps that answer as the AI self get the new ones. */
export async function refreshAppSelf(api: Api, vault: Unlocked, data: VaultData): Promise<number> {
  const apps = data.apps.filter((a) => a.canAskSelf && !a.revokedAt);
  for (const a of apps) await setAppSelf(api, vault, data, a, true);
  return apps.length;
}

// ---------------------------------------------------------------- links

export interface NewLinkInput {
  label: string;
  /** The name and greeting the asker sees. */
  name: string;
  greeting: string;
  rules: SelfRules;
  expiresInDays: number;
  maxUses: number;
  perHour: number;
  /** null: this vault answers while it is open. An app id: the connector with that app key answers. */
  appId: string | null;
  /** Offer voice to whoever opens the link. */
  voice?: boolean;
}

export function linkUrl(origin: string, link: Pick<AskLinkView, "id" | "publicKey" | "secret">): string | null {
  if (!link.secret?.introKey) return null;
  return askUrl(origin, link.id, link.publicKey, fromBase64Url(link.secret.introKey));
}

export async function createLink(api: Api, vault: Unlocked, data: VaultData, input: NewLinkInput, origin: string): Promise<{ link: AskLinkView; url: string }> {
  const link = newAskLink();
  const rules = cleanRules(input.rules);
  const label = input.label.trim().slice(0, 80) || "Ask link";
  const secret: AskLinkSecret = { secret: toBase64Url(link.pair.secretKey), label, rules, introKey: toBase64Url(link.introKey) };
  const days = Math.min(Math.max(Math.round(input.expiresInDays), 1), 365);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  let appBox: string | null = null;
  if (input.appId) {
    const app = data.apps.find((a) => a.id === input.appId && !a.revokedAt);
    if (!app) throw new Error("That app is not connected.");
    const appSecret = await openAppSecret(vault.key, app);
    appBox = await encryptJson(await importKey(await appSelfKey(appSecret)), secret, AAD.askLinkApp(app.id, link.id));
  }
  const body = {
    id: link.id,
    publicKey: link.publicKey,
    intro: await sealIntro(link.introKey, link.id, { name: input.name, greeting: input.greeting }),
    ownerBox: await encryptJson(vault.key, secret, AAD.askLinkOwner(link.id)),
    appId: input.appId,
    appBox,
    expiresAt,
    maxUses: Math.min(Math.max(Math.round(input.maxUses), 1), 1000),
    perHour: Math.min(Math.max(Math.round(input.perHour), 1), 120),
    voice: input.voice === true,
  };
  await api.post("self/links", body);
  const view: AskLinkView = {
    id: link.id,
    publicKey: link.publicKey,
    secret,
    label,
    appId: input.appId,
    expiresAt,
    maxUses: body.maxUses,
    perHour: body.perHour,
    uses: 0,
    answered: 0,
    lastAskedAt: null,
    online: false,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  return { link: view, url: askUrl(origin, link.id, link.publicKey, link.introKey) };
}

export async function revokeLink(api: Api, id: string): Promise<void> {
  await api.post(`self/links/${id}/revoke`);
}

export async function deleteLink(api: Api, id: string): Promise<void> {
  await api.del(`self/links/${id}`);
}

export async function refreshLinks(api: Api, data: VaultData): Promise<AskLinkView[]> {
  const r = await api.get<{ links: (Omit<AskLinkView, "secret" | "label"> & { ownerBox: string })[] }>("self/links");
  const known = new Map(data.askLinks.map((l) => [l.id, l]));
  return r.links.map(({ ownerBox: _b, ...l }) => ({ ...l, secret: known.get(l.id)?.secret ?? null, label: known.get(l.id)?.label ?? "Ask link" }));
}

// ---------------------------------------------------------------- answering, while the vault is open

export interface PendingQuestion {
  id: string;
  linkId: string;
  sessionId: string;
  askerKey: string;
  sealed: string;
  createdAt: string;
}

export const AGENT_ERROR_TEXT = "My AI self could not answer just now. Please try again later.";

export interface ServeDeps extends MeaningDeps {
  model: ModelCaller;
  box: BoxKeyPair;
  boxPublic: string;
}

export interface ComposedLink {
  reply: AskReply;
  question: string;
  citations: AskNote["citations"];
}

/**
 * Writes the answer to one waiting question of a link this vault answers,
 * without sending it: opens the question with the link's key and answers within
 * the link's rules from the allowed folders. Null for a link this vault does not hold.
 */
export async function composeLinkAnswer(api: Api, data: VaultData, q: PendingQuestion, deps: MeaningDeps & { model: ModelCaller }): Promise<ComposedLink | null> {
  const link = data.askLinks.find((l) => l.id === q.linkId);
  if (!link?.secret) return null;
  const ids = { linkId: q.linkId, sessionId: q.sessionId, messageId: q.id };
  const key = agentSessionKey(linkPair(link.secret), q.linkId, q.sessionId, q.askerKey, linkGreetingKey(link.secret));
  const rules = cleanRules(link.secret.rules);
  let question = "";
  try {
    const opened = cleanQuestion(openAskMessage(key, ids, "q", q.sealed));
    question = opened.text;
    const queryVector = deps.embedQuery ? await deps.embedQuery(question) : null;
    // Protected folders the link's rules name come in only with the owner's yes for this read.
    const gate = await protectedGate(api, data, rules, question, { id: q.linkId, kind: "link" });
    const a = await answerAsSelf({
      question,
      history: opened.history,
      rules,
      memories: [...selfMemories(data), ...gate.extra],
      profile: selfProfile(data, rules),
      model: deps.model,
      asker: "guest",
      queryVector,
      vectors: deps.vectors,
      immune: data.immune,
      onCaught: (c) => reportCaught(api, "link", c.held + c.neutralised, q.linkId),
    });
    if (gate.extra.length) await gate.use(gate.extra.map((m) => m.id));
    const text = withoutCitations(a.text);
    return { reply: { v: 1, text: gate.asked.length ? `${text}\n\n${ASKED_TEXT}` : text, refused: a.refused }, question, citations: a.citations.map((c) => ({ id: c.id, title: c.title })) };
  } catch {
    return { reply: { v: 1, text: AGENT_ERROR_TEXT, refused: "error" }, question: question || "(the question could not be opened)", citations: [] };
  }
}

/** Seals an answer for the asker and the question and answer for this vault's log, and sends both. */
export async function sendLinkAnswer(
  api: Api,
  data: Pick<VaultData, "askLinks">,
  q: Pick<PendingQuestion, "id" | "linkId" | "sessionId" | "askerKey">,
  composed: ComposedLink,
  boxPublic: string,
): Promise<void> {
  const link = data.askLinks.find((l) => l.id === q.linkId);
  if (!link?.secret) throw new Error("That ask link is gone.");
  const ids = { linkId: q.linkId, sessionId: q.sessionId, messageId: q.id };
  const key = agentSessionKey(linkPair(link.secret), q.linkId, q.sessionId, q.askerKey, linkGreetingKey(link.secret));
  const note: AskNote = { v: 1, via: "link", label: link.label, question: composed.question, answer: composed.reply.text, citations: composed.citations, refused: composed.reply.refused };
  await api.post(`self/questions/${q.id}/answer`, {
    sealed: sealAskMessage(key, ids, "a", composed.reply),
    note: sealJson(decodeBoxPublicKey(boxPublic), note, askNoteContext(q.id, q.linkId)),
    cited: composed.citations.length,
  });
}

/**
 * Answers one waiting question for a link this vault answers: opens it with the
 * link's key, answers within the link's rules from the allowed folders, seals the
 * answer for the asker, and seals the question and answer to this vault's own
 * public key for the read log.
 */
export async function answerPending(api: Api, data: VaultData, q: PendingQuestion, deps: ServeDeps): Promise<{ answered: boolean; reply: AskReply }> {
  const composed = await composeLinkAnswer(api, data, q, deps);
  if (!composed) return { answered: false, reply: { v: 1, text: "", refused: "unknown_link" } };
  await sendLinkAnswer(api, data, q, composed, deps.boxPublic);
  return { answered: true, reply: composed.reply };
}

/** One round of the agent: says it is online, and answers whatever is waiting. */
export async function serveOnce(api: Api, data: VaultData, deps: ServeDeps): Promise<number> {
  const { questions } = await api.get<{ questions: PendingQuestion[] }>("self/pending");
  let n = 0;
  for (const q of questions) {
    try {
      if ((await answerPending(api, data, q, deps)).answered) n++;
    } catch {
      // Answered on another device, or expired meanwhile. The next round moves on.
    }
  }
  return n;
}

/** Opens the sealed question and answer of a read log entry. */
export function openAskNote(box: BoxKeyPair, entry: { memoryId: string | null; appId: string; note?: string }): AskNote | null {
  if (!entry.note || !entry.memoryId) return null;
  try {
    return openSealedJson<AskNote>(box, entry.note, askNoteContext(entry.memoryId, entry.appId));
  } catch {
    return null;
  }
}
