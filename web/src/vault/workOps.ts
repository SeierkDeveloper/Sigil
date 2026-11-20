// The AI self at work, on the owner's device: drafts of replies, a plan for
// the week, and answers held for approval, each kept under the vault key in an
// approval queue. Nothing leaves on its own: approving a reply or a plan copies
// it, and approving an answer sends it through the channel it came from, the
// same way the open vault answers when nothing is held. An edit made before
// approving becomes a note in "How I write", which later drafts read.

import {
  AAD,
  cleanLesson,
  cleanRules,
  cleanWork,
  decryptJson,
  editLessons,
  encryptJson,
  lessonPrompt,
  lessonTitle,
  newDraft,
  openSetting,
  plainPlan,
  plainReply,
  planPrompt,
  randomId,
  replyPrompt,
  retrieve,
  sealSetting,
  STYLE_FOLDER,
  styleHints,
  weekAgenda,
  type AnswerChannel,
  type DraftKind,
  type DraftRecord,
  type DraftState,
  type Memory,
  type ModelCaller,
  type OpenFolder,
  type StyleHints,
  type WorkSettings,
} from "@sigil/core";
import type { Api } from "./api";
import { addFolder, createMemory, deleteMemories, updateMemory, type Unlocked, type VaultData } from "./ops";
import { composeLinkAnswer, selfMemories, sendLinkAnswer, type PendingQuestion } from "./selfOps";
import { composePublicAnswer, pendingPublic, sendPublicAnswer } from "./publicOps";
import { composeTurn, sendTurn, waitingMeets } from "./meetOps";

export interface ServerDraft {
  id: string;
  kind: DraftKind;
  ref: string | null;
  box: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
}

export interface DraftView extends Omit<ServerDraft, "box"> {
  record: DraftRecord | null;
}

export async function openDrafts(vault: Unlocked, rows: ServerDraft[]): Promise<{ drafts: DraftView[]; unreadable: number }> {
  let unreadable = 0;
  const drafts: DraftView[] = [];
  for (const { box, ...r } of rows) {
    let record: DraftRecord | null = null;
    try {
      record = await decryptJson<DraftRecord>(vault.key, box, AAD.draft(r.id));
    } catch {
      unreadable++;
    }
    drafts.push({ ...r, record });
  }
  return { drafts, unreadable };
}

export async function openWork(vault: Unlocked, envelope: string | undefined): Promise<WorkSettings> {
  return cleanWork(envelope ? await openSetting<unknown>(vault.key, "work", envelope) : null);
}

export async function saveWork(api: Api, vault: Unlocked, settings: WorkSettings): Promise<WorkSettings> {
  const clean = cleanWork(settings);
  await api.put("settings/work", { value: await sealSetting(vault.key, "work", clean) });
  return clean;
}

export async function loadDrafts(api: Api, vault: Unlocked): Promise<DraftView[]> {
  return (await openDrafts(vault, (await api.get<{ drafts: ServerDraft[] }>("drafts")).drafts)).drafts;
}

async function saveDraft(api: Api, vault: Unlocked, ref: string | null, record: DraftRecord): Promise<DraftView> {
  const id = randomId();
  const r = await api.post<{ draft: ServerDraft }>("drafts", { id, kind: record.kind, ref, box: await encryptJson(vault.key, record, AAD.draft(id)) });
  const { box: _b, ...rest } = r.draft;
  return { ...rest, record };
}

// ---------------------------------------------------------------- what it learned

export function styleFolder(data: Pick<VaultData, "folders">): OpenFolder | null {
  return data.folders.find((f) => f.name.toLowerCase() === STYLE_FOLDER.toLowerCase()) ?? null;
}

/** The notes in "How I write", newest first. */
export function lessons(data: Pick<VaultData, "folders" | "memories">): Memory[] {
  const folder = styleFolder(data);
  if (!folder) return [];
  return data.memories.filter((m) => m.folderId === folder.id).sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1));
}

export function hintsFor(data: Pick<VaultData, "folders" | "memories">): StyleHints {
  return styleHints(lessons(data));
}

export async function editLesson(api: Api, data: VaultData, memory: Memory, body: string): Promise<Memory> {
  const m = await updateMemory(api, data.folders, memory, { body });
  await api.post("work/lessons", { step: "lesson-edited" });
  return m;
}

export async function deleteLesson(api: Api, memory: Memory): Promise<void> {
  await deleteMemories(api, [memory.id]);
  await api.post("work/lessons", { step: "lesson-deleted" });
}

// ---------------------------------------------------------------- drafts the owner asks for

export interface WorkDeps {
  model: ModelCaller | null;
  embedQuery?: (q: string) => Promise<Float32Array | null>;
  vectors?: Map<string, Float32Array>;
}

/** Synced or imported mail threads, newest first, to reply to. */
export function mailThreads(data: Pick<VaultData, "memories">): Memory[] {
  return data.memories.filter((m) => m.source.kind === "gmail").sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1));
}

/** The last message of a thread, as imports and live sync write it ("### sender", then the text). */
export function lastMessage(thread: Pick<Memory, "title" | "body">): { from: string; message: string } {
  const blocks = thread.body.split(/^### /m).filter((b) => b.trim());
  const last = blocks[blocks.length - 1] ?? thread.body;
  const [first, ...rest] = last.split("\n");
  const text = rest.filter((l) => !/^(To|Date):/.test(l)).join("\n").trim();
  return { from: blocks.length ? first.trim() : "", message: `Subject: ${thread.title}\n\n${text || thread.body}`.slice(0, 12_000) };
}

/** Drafts a reply to a pasted message or a mail thread, from the AI self's folders and the owner's style notes. */
export async function draftReply(api: Api, vault: Unlocked, data: VaultData, input: { message: string; from: string; threadId?: string | null }, deps: WorkDeps): Promise<DraftView> {
  const message = input.message.trim();
  if (!message) throw new Error("Paste the message to reply to, or pick a thread.");
  const rules = data.self ?? cleanRules({});
  const hints = hintsFor(data);
  const subject = /^\s*subject\s*:\s*(.+)$/im.exec(message)?.[1]?.trim() ?? "";
  let draft: string;
  let sources: { id: string; title: string }[] = [];
  if (deps.model) {
    const queryVector = deps.embedQuery ? await deps.embedQuery(message.slice(0, 2000)) : null;
    const found = rules.folderIds.length ? retrieve(rules, selfMemories(data), message.slice(0, 2000), { queryVector, vectors: deps.vectors }) : [];
    sources = found.map((s) => ({ id: s.id, title: s.title }));
    draft = (await deps.model.complete({ ...replyPrompt({ name: rules.name, tone: rules.tone, message, from: input.from, hints, sources: found }), maxTokens: 1500 })).trim();
  } else {
    draft = plainReply({ message, from: input.from, subject }, hints);
  }
  const who = input.from.replace(/<[^>]*>/g, "").trim();
  return saveDraft(
    api,
    vault,
    null,
    newDraft({ kind: "reply", title: `Reply to ${who || subject || "a message"}`, input: message, from: input.from, threadId: input.threadId ?? null, draft, sources, usedModel: !!deps.model }),
  );
}

/** Plans the next seven days from the calendar memories in the vault, wherever they are. */
export async function draftPlan(api: Api, vault: Unlocked, data: VaultData, focus: string, deps: WorkDeps, now = new Date()): Promise<DraftView> {
  const calendar = data.memories.filter((m) => m.source.kind === "calendar");
  const agenda = weekAgenda(calendar, now);
  const rules = data.self ?? cleanRules({});
  const draft = deps.model
    ? (await deps.model.complete({ ...planPrompt({ name: rules.name, tone: rules.tone, agenda, hints: hintsFor(data), focus: focus.trim() }), maxTokens: 2000 })).trim()
    : plainPlan(agenda);
  const ids = new Set(agenda.flatMap((d) => d.events.map((e) => e.id)));
  return saveDraft(
    api,
    vault,
    null,
    newDraft({
      kind: "plan",
      title: `Your week from ${agenda[0].day}`,
      input: focus.trim(),
      draft,
      sources: calendar.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, title: m.title })),
      usedModel: !!deps.model,
    }),
  );
}

// ---------------------------------------------------------------- answers held for approval

/** The links this open vault answers itself (the same test as the agent's). */
function vaultLinks(data: Pick<VaultData, "askLinks">, now = Date.now()) {
  return data.askLinks.filter((l) => !l.revokedAt && !l.appId && l.secret && new Date(l.expiresAt).getTime() > now && l.uses < l.maxUses);
}

/** The refs of everything already drafted, so nothing is drafted twice. */
function drafted(drafts: DraftView[]): Set<string> {
  return new Set(drafts.map((d) => d.ref).filter((r): r is string => !!r));
}

/** Drafts answers to waiting ask link questions instead of sending them. Returns the drafts it made. */
export async function holdLinksOnce(api: Api, vault: Unlocked, data: VaultData, known: DraftView[], deps: WorkDeps & { model: ModelCaller }): Promise<DraftView[]> {
  if (!vaultLinks(data).length) return [];
  const { questions } = await api.get<{ questions: PendingQuestion[] }>("self/pending");
  const seen = drafted(known);
  const made: DraftView[] = [];
  for (const q of questions) {
    const ref = `q:${q.id}`;
    if (seen.has(ref)) continue;
    const c = await composeLinkAnswer(api, data, q, deps);
    if (!c) continue;
    const link = data.askLinks.find((l) => l.id === q.linkId);
    const channel: AnswerChannel = { kind: "link", questionId: q.id, linkId: q.linkId, sessionId: q.sessionId, askerKey: q.askerKey };
    try {
      made.push(await saveDraft(api, vault, ref, newDraft({ kind: "answer", title: `Answer on "${link?.label ?? "an ask link"}"`, input: c.question, from: link?.label ?? "", channel, draft: c.reply.text, sources: c.citations, usedModel: true, refused: c.reply.refused })));
    } catch {
      // Drafted on another device meanwhile.
    }
  }
  return made;
}

/** Drafts answers for visitors of the public AI self instead of sending them. */
export async function holdPublicOnce(api: Api, vault: Unlocked, data: VaultData, known: DraftView[], deps: { model: ModelCaller }): Promise<DraftView[]> {
  const self = data.publicSelf;
  if (!self?.secret || !self.enabled) return [];
  const { questions, items } = await pendingPublic(api);
  const seen = drafted(known);
  const made: DraftView[] = [];
  for (const q of questions) {
    const ref = `p:${q.id}`;
    if (seen.has(ref) || q.booking) continue;
    const c = await composePublicAnswer(data, items, q, deps.model);
    if (!c) continue;
    const channel: AnswerChannel = { kind: "public", questionId: q.id, selfId: self.id, sessionId: q.sessionId, askerKey: q.askerKey };
    try {
      made.push(await saveDraft(api, vault, ref, newDraft({ kind: "answer", title: `Answer to a visitor of @${self.handle}`, input: c.question, from: `@${self.handle}`, channel, draft: c.reply.text, sources: c.reply.sources, usedModel: true, refused: c.reply.refused })));
    } catch {
      // Drafted on another device meanwhile.
    }
  }
  return made;
}

/** Drafts this side's turns in meetings of selves instead of sending them. */
export async function holdMeetsOnce(api: Api, vault: Unlocked, data: VaultData, known: DraftView[], deps: { model: ModelCaller }): Promise<DraftView[]> {
  if (!data.box) return [];
  const seen = drafted(known);
  const made: DraftView[] = [];
  for (const m of await waitingMeets(api, vault, data.box)) {
    const ref = `m:${m.id}:${m.turns + 1}`;
    if (seen.has(ref)) continue;
    const t = await composeTurn(api, data, m, deps);
    if (!t) continue;
    const channel: AnswerChannel = { kind: "meet", meetId: m.id, turn: t.turn, done: t.done };
    try {
      made.push(await saveDraft(api, vault, ref, newDraft({ kind: "answer", title: `Turn ${t.turn} with ${m.record?.label ?? m.peerName}`, input: m.lines.filter((l) => !l.mine).at(-1)?.text ?? m.note, from: m.peerName, channel, draft: t.text, sources: [], usedModel: true })));
    } catch {
      // Drafted on another device meanwhile.
    }
  }
  return made;
}

/** Sends an approved answer through the channel it came from. */
async function sendAnswer(api: Api, data: VaultData, record: DraftRecord, text: string): Promise<void> {
  const ch = record.channel;
  if (!ch) throw new Error("This answer has no channel to go to.");
  const edited = text.trim() !== record.draft.trim();
  const refused = edited ? null : record.refused;
  if (ch.kind === "link") {
    if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload it.");
    await sendLinkAnswer(api, data, { id: ch.questionId, linkId: ch.linkId, sessionId: ch.sessionId, askerKey: ch.askerKey }, { reply: { v: 1, text, refused }, question: record.input, citations: record.sources }, data.boxPublic);
  } else if (ch.kind === "public") {
    await sendPublicAnswer(api, data, { id: ch.questionId, sessionId: ch.sessionId, askerKey: ch.askerKey }, { reply: { v: 1, text, refused, sources: record.sources }, question: record.input });
  } else {
    const meet = data.meets.find((m) => m.id === ch.meetId);
    if (!meet || !data.box) throw new Error("That conversation is gone.");
    if (meet.state !== "running" || meet.turns + 1 !== ch.turn) throw new Error("This turn can no longer be sent: the conversation moved on or ended.");
    await sendTurn(api, meet, data.box, { turn: ch.turn, text, done: ch.done, cited: 0 });
  }
}

// ---------------------------------------------------------------- deciding

/** What an edit taught, as plain lines: by the owner's model when allowed, otherwise from the change itself. */
export async function lessonFor(record: DraftRecord, text: string, settings: WorkSettings, model: ModelCaller | null): Promise<{ lines: string[]; usedModel: boolean }> {
  if (text.trim() === record.draft.trim()) return { lines: [], usedModel: false };
  if (model && settings.learnWithModel) {
    try {
      const lines = cleanLesson(await model.complete({ ...lessonPrompt(record.draft, text), maxTokens: 400 }));
      if (lines.length) return { lines, usedModel: true };
    } catch {
      // The plain summary below stands in.
    }
  }
  return { lines: editLessons(record.draft, text, record.from), usedModel: false };
}

export interface Approved {
  draft: DraftView;
  lesson: Memory | null;
  folder: OpenFolder | null;
  createdFolder: boolean;
}

/**
 * Approves a draft with the text the owner settled on. An answer is sent
 * through its channel first; a reply or a plan is only marked approved (the
 * page copies it). If the owner changed the text and learning is on, the change
 * becomes a note in "How I write".
 */
export async function approve(api: Api, vault: Unlocked, data: VaultData, view: DraftView, text: string, deps: { model: ModelCaller | null; settings: WorkSettings }): Promise<Approved> {
  const record = view.record;
  if (!record || view.state !== "waiting") throw new Error("This draft is not waiting for you.");
  const final = text.trim();
  if (!final) throw new Error("The text is empty.");
  if (record.kind === "answer") await sendAnswer(api, data, record, final);
  let lesson: Memory | null = null;
  let folder = styleFolder(data);
  let createdFolder = false;
  if (deps.settings.learn) {
    const { lines } = await lessonFor(record, final, deps.settings, deps.model);
    if (lines.length) {
      if (!folder) {
        folder = await addFolder(api, vault, STYLE_FOLDER);
        createdFolder = true;
      }
      lesson = await createMemory(api, folder, { title: lessonTitle(record.kind), body: lines.join("\n"), tags: ["style", record.kind], source: { kind: "style" } });
    }
  }
  const next: DraftRecord = { ...record, final, decidedAt: new Date().toISOString(), learned: lesson?.id ?? null };
  const r = await api.put<{ draft: ServerDraft }>(`drafts/${view.id}`, { box: await encryptJson(vault.key, next, AAD.draft(view.id)), state: "approved", learned: !!lesson });
  const { box: _b, ...rest } = r.draft;
  return { draft: { ...rest, record: next }, lesson, folder, createdFolder };
}

export async function discard(api: Api, vault: Unlocked, view: DraftView): Promise<DraftView> {
  if (!view.record) throw new Error("This draft could not be opened.");
  const next: DraftRecord = { ...view.record, decidedAt: new Date().toISOString() };
  const r = await api.put<{ draft: ServerDraft }>(`drafts/${view.id}`, { box: await encryptJson(vault.key, next, AAD.draft(view.id)), state: "discarded" });
  const { box: _b, ...rest } = r.draft;
  return { ...rest, record: next };
}

export async function removeDraft(api: Api, id: string): Promise<void> {
  await api.del(`drafts/${id}`);
}
