// The AI self on the owner's machine. When the owner lets this app answer as
// their AI self, the vault wraps the rules, the owner's model key and the vault
// public key for this app's key only. Here they are opened, questions are
// answered from the folders the rules allow (read through this app's own
// grants, so every read is in the owner's log), the owner's model is called
// from this machine, and each question and answer is sealed to the vault's
// public key for the log. Ask links the owner assigned to this app are served
// the same way: their questions arrive as relay boxes only this machine opens.

import {
  AAD,
  agentSessionKey,
  answerAsSelf,
  appSelfKey,
  askNoteContext,
  cleanModelSettings,
  cleanQuestion,
  cleanRules,
  createModelCaller,
  decodeBoxPublicKey,
  decryptJson,
  importKey,
  linkPair,
  openAskMessage,
  openPublicForApp,
  publicMemories,
  randomId,
  sealAskMessage,
  sealJson,
  withoutCitations,
  type AskLinkSecret,
  type AskNote,
  type AskReply,
  type PublicItem,
  type PublicReply,
  type ModelCaller,
  type SelfAnswer,
  type SelfMemory,
  type SelfRules,
  type SelfTurn,
} from "@sigil/core";
import type { VaultReader } from "./reader";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface WireSelf {
  config: string;
  links: { id: string; publicKey: string; box: string }[];
}

interface PendingQuestion {
  id: string;
  linkId: string;
  sessionId: string;
  askerKey: string;
  sealed: string;
}

export interface OpenedSelf {
  rules: SelfRules;
  model: ModelCaller;
  boxPublic: Uint8Array;
  links: Map<string, AskLinkSecret>;
}

export const AGENT_ERROR_TEXT = "My AI self could not answer just now. Please try again later.";

export class SelfAgent {
  constructor(
    private readonly reader: VaultReader,
    private readonly opts: { fetch?: Fetch } = {},
  ) {}

  /** Fetches and opens this app's AI self config and its links. Nothing is kept between calls, so a change in the vault applies at once. */
  async open(): Promise<OpenedSelf> {
    const r = await this.reader.request<WireSelf>("GET", "self");
    const key = await importKey(await appSelfKey(this.reader.appSecret));
    const config = await decryptJson<{ rules: unknown; model: unknown; boxPublic: string }>(key, r.config, AAD.appSelf(this.reader.appId));
    const settings = cleanModelSettings(config.model);
    if (!settings) throw new Error("The AI self has no model key. Add one in the vault under AI self.");
    const links = new Map<string, AskLinkSecret>();
    for (const l of r.links) {
      try {
        links.set(l.id, await decryptJson<AskLinkSecret>(key, l.box, AAD.askLinkApp(this.reader.appId, l.id)));
      } catch {
        // A link that does not open with this app's key is not one it answers.
      }
    }
    return {
      rules: cleanRules(config.rules),
      model: createModelCaller(settings, this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      boxPublic: decodeBoxPublicKey(config.boxPublic),
      links,
    };
  }

  /** Answers one question within the given rules, from the folders this app may read and the rules allow. */
  private async answer(rules: SelfRules, model: ModelCaller, question: string, history: SelfTurn[], asker: "owner" | "guest"): Promise<SelfAnswer> {
    const allowed = new Set(rules.folderIds);
    const heads = (await this.reader.heads()).filter((h) => allowed.has(h.folderId));
    const ranked = heads.length ? await this.reader.rank(heads, question, rules.maxSources) : [];
    const { memories: full } = ranked.length ? await this.reader.read(ranked.map((h) => h.id)) : { memories: [] };
    const byId = new Map(ranked.map((h) => [h.id, h]));
    const memories: SelfMemory[] = full.map((m) => {
      const h = byId.get(m.id)!;
      return { id: m.id, folderId: h.folderId, folder: m.folder, title: m.title, tags: m.tags, body: m.body, editedAt: m.editedAt };
    });
    // Keep the ranking order from above.
    memories.sort((a, b) => ranked.findIndex((h) => h.id === a.id) - ranked.findIndex((h) => h.id === b.id));
    return answerAsSelf({ question, history, rules, memories, model, asker, ranked: true });
  }

  /** The ask_self tool: answers as the owner and writes the sealed question and answer to the owner's log. */
  async ask(question: string, history: SelfTurn[] = []): Promise<SelfAnswer> {
    const self = await this.open();
    const a = await this.answer(self.rules, self.model, question, history, "owner");
    const id = randomId();
    const note: AskNote = {
      v: 1,
      via: "app",
      label: self.rules.name,
      question,
      answer: a.text,
      citations: a.citations.map((c) => ({ id: c.id, title: c.title })),
      refused: a.refused,
    };
    await this.reader.request("POST", "self/asked", { id, note: sealJson(self.boxPublic, note, askNoteContext(id, this.reader.appId)), cited: a.citations.length });
    return a;
  }

  /** One round of serving links: marks this app online and answers whatever is waiting. */
  async serveOnce(): Promise<number> {
    const { questions } = await this.reader.request<{ questions: PendingQuestion[] }>("GET", "self/pending");
    if (!questions.length) return 0;
    const self = await this.open();
    let n = 0;
    for (const q of questions) {
      const link = self.links.get(q.linkId);
      if (!link) continue;
      const ids = { linkId: q.linkId, sessionId: q.sessionId, messageId: q.id };
      const key = agentSessionKey(linkPair(link), q.linkId, q.sessionId, q.askerKey);
      let reply: AskReply;
      let question = "";
      let citations: AskNote["citations"] = [];
      try {
        const opened = cleanQuestion(openAskMessage(key, ids, "q", q.sealed));
        question = opened.text;
        const a = await this.answer(cleanRules(link.rules), self.model, question, opened.history, "guest");
        reply = { v: 1, text: withoutCitations(a.text), refused: a.refused };
        citations = a.citations.map((c) => ({ id: c.id, title: c.title }));
      } catch {
        reply = { v: 1, text: AGENT_ERROR_TEXT, refused: "error" };
        if (!question) question = "(the question could not be opened)";
      }
      const note: AskNote = { v: 1, via: "link", label: link.label, question, answer: reply.text, citations, refused: reply.refused };
      try {
        await this.reader.request("POST", `self/questions/${q.id}/answer`, {
          sealed: sealAskMessage(key, ids, "a", reply),
          note: sealJson(self.boxPublic, note, askNoteContext(q.id, q.linkId)),
          cited: citations.length,
        });
        n++;
      } catch {
        // Expired or answered meanwhile.
      }
    }
    return n;
  }

  private publicOffUntil = 0;

  /**
   * One round of the public AI self, when the owner picked this app to answer
   * it: marks it online and answers waiting visitors, only from the public copy
   * the owner published. Each question and answer is sealed into the owner's log.
   */
  async servePublicOnce(now = Date.now()): Promise<number> {
    if (now < this.publicOffUntil) return 0;
    let pub: { id: string; publicKey: string; box: string; enabled: boolean; items: PublicItem[] };
    try {
      pub = (await this.reader.request<{ self: typeof pub }>("GET", "public")).self;
    } catch {
      // Not this app's to answer: look again in a minute.
      this.publicOffUntil = now + 60_000;
      return 0;
    }
    if (!pub.enabled) return 0;
    const { questions } = await this.reader.request<{ questions: { id: string; selfId: string; sessionId: string; askerKey: string; sealed: string }[] }>("GET", "public/pending");
    if (!questions.length) return 0;
    const secret = await openPublicForApp(this.reader.appSecret, this.reader.appId, pub.id, pub.box);
    const settings = cleanModelSettings(secret?.model);
    if (!secret || !settings || !secret.boxPublic) throw new Error("The public AI self could not be opened with this app's key. Choose the app again in the vault.");
    const model = createModelCaller(settings, this.opts.fetch ? { fetch: this.opts.fetch } : {});
    const pair = linkPair({ secret: secret.secret, label: "", rules: null, introKey: "" });
    const memories = publicMemories(pub.items);
    let n = 0;
    for (const q of questions) {
      const ids = { linkId: pub.id, sessionId: q.sessionId, messageId: q.id };
      const key = agentSessionKey(pair, pub.id, q.sessionId, q.askerKey);
      let reply: PublicReply;
      let question = "";
      try {
        const opened = cleanQuestion(openAskMessage(key, ids, "q", q.sealed));
        question = opened.text;
        const a = await answerAsSelf({ question, history: opened.history, rules: secret.rules, memories, model, asker: "public" });
        reply = { v: 1, text: withoutCitations(a.text), refused: a.refused, sources: a.citations.map((c) => ({ id: c.id, title: c.title })) };
      } catch {
        reply = { v: 1, text: AGENT_ERROR_TEXT, refused: "error", sources: [] };
        if (!question) question = "(the question could not be opened)";
      }
      const note: AskNote = { v: 1, via: "public", label: secret.rules.name, question, answer: reply.text, citations: reply.sources, refused: reply.refused };
      try {
        await this.reader.request("POST", `public/questions/${q.id}/answer`, {
          sealed: sealAskMessage(key, ids, "a", reply),
          note: sealJson(decodeBoxPublicKey(secret.boxPublic), note, askNoteContext(q.id, pub.id)),
          cited: reply.sources.length,
          wall: reply.refused === "error" ? null : { question, answer: reply.text, sources: reply.sources },
        });
        n++;
      } catch {
        // Expired or answered meanwhile.
      }
    }
    return n;
  }

  /** Serves links (and the public AI self, when it is this app's) until stopped. The owner's links show as online while this runs. */
  async run(opts: { everyMs?: number; signal?: AbortSignal; onError?: (err: Error) => void } = {}): Promise<void> {
    const every = opts.everyMs ?? 3000;
    while (!opts.signal?.aborted) {
      try {
        await this.serveOnce();
        await this.servePublicOnce();
      } catch (err) {
        opts.onError?.(err as Error);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
}
