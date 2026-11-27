// A self that acts, on the owner's device.
//
// Apps: an app the owner lets act gets the thresholds, the vault's public key
// and the self key's word for the app's own receipt key, in an envelope only
// that app's key opens. Saving the limits wraps them again for every such app.
//
// Steps: everything the self does with mail, invites and offers is a step on
// the server, sealed to the vault's public key: taken alone within the
// thresholds (with a receipt), waiting in Work for the owner, or refused by a
// never-touch rule. The owner's answer to an app's step goes back under that
// app's key; the vault's own approved steps are carried out here.
//
// The inbox and the calendar: with a Google source the owner lets act (which
// needs this site's Google client and the send and events scopes), every pass
// of live sync also reads the mail and invites that wait for an answer and
// checks each against the thresholds and ranges: within them it replies or
// answers with the owner's own token, from this device, and signs a receipt;
// otherwise the step waits in Work with the thread and what it would send.

import {
  AAD,
  ACT_SCOPES,
  actRequestContext,
  appReceiptKey,
  appSelfKey,
  answerInvite,
  answerInviteById,
  authorizeUrl,
  canAct as scopesCanAct,
  checkAction,
  cleanActRequest,
  cleanRules,
  decodeBoxPublicKey,
  encryptJson,
  eventTimes,
  exchangeCode,
  formatSlot,
  actStepId,
  importKey,
  inboxToAnswer,
  invitesToAnswer,
  negotiate,
  negotiationFromMessage,
  newPkce,
  nextFreeSlot,
  openAppSecret,
  openSealedJson,
  plainReply,
  randomId,
  refreshTokens,
  replyPrompt,
  retrieve,
  sealJson,
  selfIdentityKey,
  sendReply,
  signDelegation,
  startOfDay,
  styledReply,
  tokenExpired,
  type ActAnswer,
  type ActArea,
  type ActRequest,
  type ActVerdict,
  type ActingConfig,
  type BoxKeyPair,
  type InboxMessage,
  type Invite,
  type ModelCaller,
  type NegotiationStep,
  type ReceiptKind,
  type SelfLimits,
  type SyncFetch,
  type SyncState,
} from "@sigil/core";
import { ApiError, type Api } from "./api";
import type { AppView, Unlocked, VaultData } from "./ops";
import { signedReceipt } from "./receiptOps";
import { selfMemories } from "./selfOps";
import { CONNECT_PATH, saveState, signInWindow, type ConnectResult, type SyncSourceView } from "./syncOps";
import { hintsFor } from "./workOps";

export type ActState = "allowed" | "waiting" | "approved" | "declined" | "refused" | "done";

export interface ServerAct {
  id: string;
  appId: string | null;
  area: ActArea;
  state: ActState;
  alone: boolean;
  box: string;
  answer: string | null;
  receiptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActView extends Omit<ServerAct, "box" | "answer"> {
  /** The request, opened with the vault's key here. Null when it would not open. */
  request: ActRequest | null;
}

const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

export function openActs(box: BoxKeyPair | null, rows: ServerAct[]): { acts: ActView[]; unreadable: number } {
  let unreadable = 0;
  const acts: ActView[] = [];
  for (const { box: sealed, answer: _a, ...r } of rows) {
    let request: ActRequest | null = null;
    try {
      if (box) request = cleanActRequest(openSealedJson<unknown>(box, sealed, actRequestContext(r.id, r.appId ?? "vault")));
    } catch {
      unreadable++;
    }
    acts.push({ ...r, request });
  }
  return { acts, unreadable };
}

export async function loadActs(api: Api, box: BoxKeyPair | null): Promise<ActView[]> {
  return openActs(box, (await api.get<{ acts: ServerAct[] }>("acting")).acts).acts;
}

// ---------------------------------------------------------------- apps that may act

/** What an app needs to act within the thresholds, wrapped for its key only. */
export async function actingEnvelope(vault: Unlocked, data: Pick<VaultData, "limits" | "boxPublic">, app: Pick<AppView, "id" | "secret">, site = origin()): Promise<string> {
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload it and try again.");
  const secret = await openAppSecret(vault.key, app);
  const delegate = await appReceiptKey(secret);
  const delegation = signDelegation(await selfIdentityKey(vault.raw), { delegate: delegate.address, app: app.id, origin: site });
  const config: ActingConfig = { v: 1, limits: data.limits, boxPublic: data.boxPublic, delegation };
  return encryptJson(await importKey(await appSelfKey(secret)), config, AAD.appActing(app.id));
}

/** Lets an app act within the thresholds, or stops it. */
export async function setAppActing(api: Api, vault: Unlocked, data: Pick<VaultData, "limits" | "boxPublic">, app: Pick<AppView, "id" | "secret">, enabled: boolean, site = origin()): Promise<void> {
  if (!enabled) {
    await api.del(`apps/${app.id}/acting`);
    return;
  }
  await api.put(`apps/${app.id}/acting`, { config: await actingEnvelope(vault, data, app, site) });
}

/** After the limits change, every app that acts gets the new ones. */
export async function refreshAppActing(api: Api, vault: Unlocked, data: Pick<VaultData, "limits" | "boxPublic" | "apps">, site = origin()): Promise<number> {
  const apps = data.apps.filter((a) => a.canAct && !a.revokedAt);
  for (const a of apps) await setAppActing(api, vault, data, a, true, site);
  return apps.length;
}

// ---------------------------------------------------------------- the vault's own steps

/** Steps taken alone today in each area, by the vault and every app, from midnight in the free hours' time zone. */
export async function aloneToday(api: Api, limits: SelfLimits, now = Date.now()): Promise<Record<ActArea, number>> {
  const since = startOfDay(new Date(now), limits.meetings.timeZone).toISOString();
  const r = await api.get<{ today: Record<ActArea, number> | null }>(`acting?since=${encodeURIComponent(since)}`);
  return r.today ?? { mail: 0, calendar: 0, negotiation: 0 };
}

/** The id of the vault's own step for one message or invite: the same on every device, so the server refuses a second step for it. */
export async function stepId(vault: Unlocked, sourceId: string, ref: string): Promise<string> {
  return actStepId(vault.raw, sourceId, ref);
}

/** Keeps one of the vault's own steps, sealed to its own public key. */
export async function recordAct(api: Api, data: Pick<VaultData, "boxPublic">, state: "allowed" | "waiting" | "refused", request: Omit<ActRequest, "v" | "at"> & { at?: string }, fixedId?: string): Promise<ActView> {
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload it and try again.");
  const id = fixedId ?? randomId();
  const clean = cleanActRequest({ ...request, v: 1, at: request.at ?? new Date().toISOString() });
  const r = await api.post<{ act: ServerAct }>("acting", { id, area: clean.area, state, box: sealJson(decodeBoxPublicKey(data.boxPublic), clean, actRequestContext(id, "vault")) });
  const { box: _b, answer: _a, ...rest } = r.act;
  return { ...rest, request: clean };
}

/** The vault's own step was carried out: a receipt signed by the self key, sealed with the hour, and the step is done. */
export async function finishOwnAct(api: Api, vault: Unlocked, act: Pick<ActView, "id">, input: { kind: ReceiptKind; what: string; limit: string; ref?: Record<string, string> }): Promise<{ act: ActView; receiptId: string }> {
  const r = await signedReceipt(vault, { ...input, ref: { step: act.id, ...(input.ref ?? {}) } });
  const out = await api.post<{ act: ServerAct; receipt: { id: string } }>(`acting/${act.id}/done`, { receipt: { id: r.id, leaf: r.leaf, box: r.box } });
  const { box: _b, answer: _a, ...rest } = out.act;
  return { act: { ...rest, request: (act as ActView).request ?? null }, receiptId: out.receipt.id };
}

// ---------------------------------------------------------------- the owner's answer

/** Carries out one of the vault's own steps after the owner's yes: sends the reply, answers the invite. */
export type CarryOut = (act: ActView, next: string) => Promise<{ kind: ReceiptKind; what: string; ref: Record<string, string> }>;

/**
 * The owner says yes. An app's step: the answer goes back under the app's
 * key, and the app acts and reports. The vault's own step: it is carried out
 * here first (nothing changes if that fails), then kept with its receipt.
 */
export async function approveAct(api: Api, vault: Unlocked, data: Pick<VaultData, "apps">, act: ActView, next: string, deps: { carryOut?: CarryOut } = {}): Promise<ActView> {
  if (act.state !== "waiting" || !act.request) throw new Error("This step is not waiting for you.");
  const text = next.trim();
  if (act.appId) {
    const app = data.apps.find((a) => a.id === act.appId);
    if (!app) throw new Error("The app that asked is no longer connected.");
    const answer: ActAnswer = { v: 1, id: act.id, verdict: "approved", next: text && text !== act.request.next.trim() ? text : null, at: new Date().toISOString() };
    const envelope = await encryptJson(await importKey(await appSelfKey(await openAppSecret(vault.key, app))), answer, AAD.actAnswer(app.id, act.id));
    const r = await api.post<{ act: ServerAct }>(`acting/${act.id}/decide`, { state: "approved", answer: envelope });
    return { ...act, state: r.act.state, updatedAt: r.act.updatedAt };
  }
  if (!deps.carryOut) throw new Error("This step cannot be carried out from here.");
  const done = await deps.carryOut(act, text || act.request.next);
  await api.post<{ act: ServerAct }>(`acting/${act.id}/decide`, { state: "approved", answer: null });
  return (await finishOwnAct(api, vault, act, { ...done, limit: "Approved by you in Work" })).act;
}

/** The owner says no: the app is told under its key; the vault's own step is simply not taken. */
export async function declineAct(api: Api, vault: Unlocked, data: Pick<VaultData, "apps">, act: ActView): Promise<ActView> {
  if (act.state !== "waiting") throw new Error("This step is not waiting for you.");
  let envelope: string | null = null;
  if (act.appId) {
    const app = data.apps.find((a) => a.id === act.appId);
    if (!app) throw new Error("The app that asked is no longer connected.");
    const answer: ActAnswer = { v: 1, id: act.id, verdict: "declined", next: null, at: new Date().toISOString() };
    envelope = await encryptJson(await importKey(await appSelfKey(await openAppSecret(vault.key, app))), answer, AAD.actAnswer(app.id, act.id));
  }
  const r = await api.post<{ act: ServerAct }>(`acting/${act.id}/decide`, { state: "declined", answer: envelope });
  return { ...act, state: r.act.state, updatedAt: r.act.updatedAt };
}

export async function removeAct(api: Api, id: string): Promise<void> {
  await api.del(`acting/${id}`);
}

/** Hands an agreed result to the Agreements tab, which opens a draft with it. Kept for this browser tab only. */
export const AGREEMENT_HANDOFF = "sigil-agreement-draft";

export function handAgreement(draft: { title: string; text: string }): void {
  try {
    sessionStorage.setItem(AGREEMENT_HANDOFF, JSON.stringify(draft));
  } catch {
    // Without storage the owner copies the text by hand.
  }
}

/** The agreed result handed over, if any. It stays until clearAgreement, so a second render reads it too. */
export function peekAgreement(): { title: string; text: string } | null {
  try {
    const v = sessionStorage.getItem(AGREEMENT_HANDOFF);
    const d = v ? (JSON.parse(v) as { title?: unknown; text?: unknown }) : null;
    return d && typeof d.title === "string" && typeof d.text === "string" ? { title: d.title, text: d.text } : null;
  } catch {
    return null;
  }
}

export function clearAgreement(): void {
  try {
    sessionStorage.removeItem(AGREEMENT_HANDOFF);
  } catch {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------- acting in the owner's Google account

/** Whether a source may act: Gmail or Calendar, acting on, and tokens that carry the scopes. */
export function sourceActs(s: Pick<SyncSourceView, "state" | "paused" | "appId">): boolean {
  const st = s.state;
  return !!st && !s.paused && !s.appId && !st.via && st.act?.on === true && !!ACT_SCOPES[st.kind] && scopesCanAct(st.kind, st.tokens.scope);
}

/**
 * Turns acting on for a Gmail or Calendar source. When its tokens lack the
 * scopes to send or answer, it signs in again on this device asking for them.
 */
export async function enableActing(
  api: Api,
  vault: Unlocked,
  data: VaultData,
  source: SyncSourceView,
  input: { clientId: string | null; origin: string; authorize?: (url: string, state: string) => Promise<ConnectResult>; fetch?: SyncFetch; now?: number },
): Promise<SyncSourceView> {
  const st = source.state;
  if (!st) throw new Error("This source could not be opened with your vault key.");
  if (!ACT_SCOPES[st.kind]) throw new Error("Your self acts in Gmail and Google Calendar only.");
  if (st.via === "connector") throw new Error("This source signs in on your computer. Your self acts only in a source connected in this vault.");
  let tokens = st.tokens;
  let account = st.account;
  if (!scopesCanAct(st.kind, tokens.scope)) {
    if (!input.clientId) throw new Error("This site has no Google client set (SIGIL_GOOGLE_CLIENT_ID), so it cannot ask Google for more.");
    const pkce = newPkce();
    const redirectUri = `${input.origin.replace(/\/$/, "")}${CONNECT_PATH}`;
    const url = authorizeUrl({ kind: st.kind, clientId: input.clientId, redirectUri, pkce, act: true });
    const { code } = await (input.authorize ?? signInWindow)(url, pkce.state);
    const got = await exchangeCode({ kind: st.kind, clientId: input.clientId, redirectUri, code, verifier: pkce.verifier, fetch: input.fetch });
    if (!scopesCanAct(st.kind, got.tokens.scope)) throw new Error("Google did not grant sending and answering. Try again and allow both.");
    tokens = got.tokens;
    account = got.account || account;
  }
  const now = new Date(input.now ?? Date.now()).toISOString();
  const next: SyncState = { ...st, tokens, account, act: { on: true, since: st.act?.on ? st.act.since : now, handled: st.act?.handled ?? [], last: st.act?.last ?? null } };
  return saveState(api, vault, data, source, next);
}

export async function disableActing(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView): Promise<SyncSourceView> {
  if (!source.state) throw new Error("This source could not be opened with your vault key.");
  return saveState(api, vault, data, source, { ...source.state, act: { on: false, since: source.state.act?.since ?? new Date().toISOString(), handled: source.state.act?.handled ?? [], last: source.state.act?.last ?? null } });
}

async function freshToken(state: SyncState, fetcher: SyncFetch | undefined, now: number): Promise<SyncState> {
  if (!tokenExpired(state.tokens, now)) return state;
  return { ...state, tokens: await refreshTokens({ kind: state.kind, clientId: state.clientId, tokens: state.tokens, fetch: fetcher, now }) };
}

/** Times already taken in the calendar memories, an event's own memory left out. */
export function busyTimes(data: Pick<VaultData, "memories">, leaveOut = ""): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const m of data.memories) {
    if (m.source.kind !== "calendar" || (leaveOut && (m.source.ref ?? "").startsWith(leaveOut)) || /^cancelled$/im.test(m.body)) continue;
    const t = eventTimes(m);
    if (!t || t.allDay) continue;
    out.push({ start: t.start.toISOString(), end: (t.end ?? new Date(t.start.getTime() + 3600_000)).toISOString() });
  }
  return out;
}

/** The reply text: by the owner's model from the folders the AI self may use, or a plain start in the owner's own greeting and sign-off. */
async function replyText(data: VaultData, m: InboxMessage, model: ModelCaller | null): Promise<string> {
  const hints = hintsFor(data);
  const message = `Subject: ${m.subject}\n\n${m.text}`.slice(0, 12_000);
  if (!model) return plainReply({ message, from: m.from, subject: m.subject }, hints);
  const rules = data.self ?? cleanRules({});
  const found = rules.folderIds.length ? retrieve(rules, selfMemories(data), message.slice(0, 2000)) : [];
  return (await model.complete({ ...replyPrompt({ name: rules.name, tone: rules.tone, message, from: m.from, hints, sources: found }), maxTokens: 1500 })).trim();
}

/** Keeps a step unless one for the same message or invite is already kept (by another tab or device): then null. */
async function keepOnce(fn: () => Promise<ActView>): Promise<ActView | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return null;
    throw err;
  }
}

/** Sources a pass is acting on in this tab right now: a second pass for the same source waits its turn. */
const running = new Set<string>();

export interface PassOutcome {
  acted: number;
  waiting: number;
  refused: number;
  acts: ActView[];
  receipts: string[];
}

const who = (from: string) => from.replace(/<[^<>]*>/g, "").replace(/"/g, "").trim() || from;

/** One message: negotiate within the ranges when it opens a negotiation, otherwise a reply within the mail thresholds. */
async function handleMessage(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView, ctx: { token: string; fetch: SyncFetch }, m: InboxMessage, today: Record<ActArea, number>, deps: { model: ModelCaller | null; now: number }, out: PassOutcome): Promise<void> {
  const limits = data.limits;
  const n = negotiationFromMessage(limits, { who: m.from, subject: m.subject, text: m.text });
  let step: NegotiationStep | null = null;
  // Replies and negotiation by mail share the most per day for mail.
  let verdict: ActVerdict = checkAction(limits, { area: "mail", action: "reply", who: m.from, subject: m.subject, text: m.text }, { today: today.mail + today.negotiation, now: deps.now });
  let next: string;
  let area: ActArea = "mail";
  if (n && verdict.verdict !== "refused") {
    area = "negotiation";
    step = negotiate(limits, { ...n, busy: busyTimes(data), now: deps.now });
    next = step.say ? styledReply(step.say, m.from, hintsFor(data)) : await replyText(data, m, deps.model);
    // A step of a negotiation is taken alone only within the ranges and the mail thresholds both.
    if (step.move === "ask") verdict = { verdict: "needs-approval", reason: step.reason };
    else if (verdict.verdict === "allowed") verdict = { verdict: "allowed", limit: `${step.range}; ${verdict.limit}` };
  } else {
    next = verdict.verdict === "refused" ? "" : await replyText(data, m, deps.model);
  }
  const request = {
    area,
    action: (step?.move === "accept" ? "agree" : step ? "counter" : "reply") as ActRequest["action"],
    who: m.from,
    subject: m.subject,
    thread: m.thread,
    next,
    reason: verdict.verdict === "allowed" ? verdict.limit : verdict.reason,
    when: null,
    offer: step?.offer ?? null,
    ref: { source: source.id, thread: m.threadId, message: m.messageId, ...(m.rfcId ? { rfc: m.rfcId } : {}) },
  };
  const id = await stepId(vault, source.id, `mail:${m.messageId}`);
  const kept = await keepOnce(() => recordAct(api, data, verdict.verdict === "allowed" ? "allowed" : verdict.verdict === "refused" ? "refused" : "waiting", request, id));
  // Another device or tab took this message first.
  if (!kept) return;
  if (verdict.verdict !== "allowed") {
    out.acts.push(kept);
    if (verdict.verdict === "refused") out.refused++;
    else out.waiting++;
    return;
  }
  const act = kept;
  let sent: string;
  try {
    sent = await sendReply(ctx, m, next);
  } catch (err) {
    await removeAct(api, act.id).catch(() => undefined);
    throw err;
  }
  const what = step ? `${step.move === "accept" ? "Agreed" : "Countered"} with ${who(m.from)} on "${m.subject}": ${step.say}` : `Replied to ${who(m.from)} about "${m.subject}"`;
  const done = await finishOwnAct(api, vault, act, { kind: step ? "negotiation" : "mail", what, limit: verdict.limit, ref: { thread: m.threadId, message: sent } });
  out.acts.push(done.act);
  out.receipts.push(done.receiptId);
  out.acted++;
  today[area]++;
}

/** One invite: accept within the thresholds, decline when the owner allows it, otherwise it waits with the next time that fits. */
async function handleInvite(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView, ctx: { token: string; fetch: SyncFetch }, inv: Invite, today: Record<ActArea, number>, now: number, out: PassOutcome): Promise<void> {
  const limits = data.limits;
  const busy = busyTimes(data, inv.uid);
  const conflicts = busy.some((b) => Date.parse(b.start) < Date.parse(inv.start) + inv.minutes * 60_000 && Date.parse(inv.start) < Date.parse(b.end));
  const base = { area: "calendar" as const, who: inv.organizer, subject: inv.title, text: inv.description, start: inv.start, minutes: inv.minutes, conflicts };
  const accept = checkAction(limits, { ...base, action: "accept" }, { today: today.calendar, now });
  const decline = accept.verdict === "needs-approval" ? checkAction(limits, { ...base, action: "decline" }, { today: today.calendar, now }) : null;
  const zone = limits.meetings.timeZone;
  const when = { start: inv.start, minutes: inv.minutes };
  const ref = { source: source.id, event: inv.eventId };
  const id = await stepId(vault, source.id, `invite:${inv.eventId}`);
  if (accept.verdict === "allowed" || decline?.verdict === "allowed") {
    const yes = accept.verdict === "allowed";
    const limit = yes ? (accept as { limit: string }).limit : `${(decline as { limit: string }).limit}. Not accepted: ${(accept as { reason: string }).reason}`;
    const act = await keepOnce(() => recordAct(api, data, "allowed", { area: "calendar", action: yes ? "accept" : "decline", who: inv.organizer, subject: inv.title, thread: [], next: yes ? "Accept" : "Decline", reason: limit, when, offer: null, ref }, id));
    if (!act) return;
    try {
      await answerInvite(ctx, inv, yes ? "accepted" : "declined");
    } catch (err) {
      await removeAct(api, act.id).catch(() => undefined);
      throw err;
    }
    const done = await finishOwnAct(api, vault, act, { kind: "calendar", what: `${yes ? "Accepted" : "Declined"} "${inv.title}" from ${who(inv.organizer)} on ${formatSlot(new Date(inv.start), zone)}`, limit, ref: { event: inv.eventId } });
    out.acts.push(done.act);
    out.receipts.push(done.receiptId);
    out.acted++;
    today.calendar++;
    return;
  }
  let reason = accept.reason;
  if (accept.verdict === "needs-approval" && limits.ranges.on && limits.ranges.times.on) {
    const slot = nextFreeSlot(limits, inv.minutes, busy, now, Date.parse(inv.start));
    if (slot) reason = `${reason} The next time that fits your ranges is ${formatSlot(slot, zone)}.`;
  }
  const kept = await keepOnce(() =>
    recordAct(api, data, accept.verdict === "refused" ? "refused" : "waiting", { area: "calendar", action: "accept", who: inv.organizer, subject: inv.title, thread: inv.description ? [{ from: inv.organizer, text: inv.description }] : [], next: "Accept", reason, when, offer: null, ref }, id),
  );
  if (!kept) return;
  out.acts.push(kept);
  if (accept.verdict === "refused") out.refused++;
  else out.waiting++;
}

/**
 * A pass of acting over one Gmail or Calendar source: what waits for an
 * answer is checked against the thresholds; within them the self acts and
 * signs a receipt, otherwise the step waits in Work. What it handled is kept
 * in the source's encrypted state, so nothing is handled twice.
 */
export async function actOnSource(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView, deps: { fetch?: SyncFetch; model?: ModelCaller | null; now?: number } = {}): Promise<{ source: SyncSourceView; outcome: PassOutcome }> {
  if (!sourceActs(source)) throw new Error("This source does not act.");
  if (running.has(source.id)) return { source, outcome: { acted: 0, waiting: 0, refused: 0, acts: [], receipts: [] } };
  running.add(source.id);
  try {
    return await actPass(api, vault, data, source, deps);
  } finally {
    running.delete(source.id);
  }
}

async function actPass(api: Api, vault: Unlocked, data: VaultData, source: SyncSourceView, deps: { fetch?: SyncFetch; model?: ModelCaller | null; now?: number }): Promise<{ source: SyncSourceView; outcome: PassOutcome }> {
  const now = deps.now ?? Date.now();
  const fetcher: SyncFetch = deps.fetch ?? ((i, init) => fetch(i, init));
  let state = await freshToken(source.state!, deps.fetch, now);
  const ctx = { token: state.tokens.access, fetch: fetcher };
  const act = state.act!;
  const handled = [...act.handled];
  const today = await aloneToday(api, data.limits, now);
  const out: PassOutcome = { acted: 0, waiting: 0, refused: 0, acts: [], receipts: [] };
  let error: string | null = null;
  try {
    if (state.kind === "gmail") {
      const since = Math.max(Date.parse(act.since), now - 2 * 86_400_000);
      for (const m of await inboxToAnswer(ctx, { account: state.account, since, handled })) {
        handled.push(m.messageId);
        await handleMessage(api, vault, data, source, ctx, m, today, { model: deps.model ?? null, now }, out);
      }
    } else if (state.kind === "calendar") {
      for (const inv of await invitesToAnswer(ctx, { now, handled })) {
        handled.push(inv.eventId);
        await handleInvite(api, vault, data, source, ctx, inv, today, now, out);
      }
    }
  } catch (err) {
    error = (err as Error).message;
  }
  state = { ...state, act: { ...act, handled: handled.slice(-500), last: { at: new Date(now).toISOString(), acted: out.acted, waiting: out.waiting, refused: out.refused, error } } };
  const saved = await saveState(api, vault, data, source, state);
  if (error) throw Object.assign(new Error(error), { outcome: out, source: saved });
  return { source: saved, outcome: out };
}

/** Carries out the vault's own approved step: the reply (with the owner's text) or the invite answer, from this device. */
export function carryOutWith(api: Api, vault: Unlocked, data: VaultData, deps: { fetch?: SyncFetch; now?: number } = {}): CarryOut {
  return async (act, next): Promise<{ kind: ReceiptKind; what: string; ref: Record<string, string> }> => {
    const r = act.request;
    if (!r) throw new Error("This step could not be opened with your key.");
    const source = data.sync.find((s) => s.id === r.ref.source);
    if (!source?.state) throw new Error("The account this step is for is no longer connected.");
    const now = deps.now ?? Date.now();
    const state = await freshToken(source.state, deps.fetch, now);
    if (state !== source.state) await saveState(api, vault, data, source, state);
    const ctx = { token: state.tokens.access, fetch: deps.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init)) };
    if (r.area === "calendar") {
      const yes = r.action !== "decline";
      await answerInviteById(ctx, r.ref.event, yes ? "accepted" : "declined");
      return { kind: "calendar", what: `${yes ? "Accepted" : "Declined"} "${r.subject}" from ${who(r.who)}${r.when ? ` on ${formatSlot(new Date(r.when.start), data.limits.meetings.timeZone)}` : ""}`, ref: { event: r.ref.event } };
    }
    const sent = await sendReply(ctx, { threadId: r.ref.thread, messageId: r.ref.message, rfcId: r.ref.rfc ?? "", references: "", from: r.who, subject: r.subject, text: "", at: r.at, thread: [] }, next);
    return { kind: r.area === "negotiation" ? "negotiation" : "mail", what: `Replied to ${who(r.who)} about "${r.subject}"`, ref: { thread: r.ref.thread, message: sent } };
  };
}
