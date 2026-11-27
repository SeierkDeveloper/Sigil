// A self that acts, through an AI app that has mail or calendar access of its
// own: before the app sends a message, answers an invite or makes an offer, it
// asks here. The owner's thresholds and ranges arrive wrapped for this app's
// key only and are opened on this machine; the answer (allowed, needs-approval
// or refused) is decided here, the same way the vault decides it. A step that
// needs the owner is sealed to the vault's public key and waits in Work; the
// owner's yes or no comes back under this app's key, so the server can
// neither read it nor forge it. When the app reports that it acted, a receipt
// is signed here with this app's own receipt key, which the self key vouched
// for in the vault, and sealed to the vault: the self key never leaves the
// owner's device.

import {
  AAD,
  actRequestContext,
  appReceiptKey,
  appSelfKey,
  checkAction,
  cleanLimits,
  decodeBoxPublicKey,
  decryptJson,
  importKey,
  negotiate as negotiateStep,
  neverTouchHit,
  randomId,
  receiptLeaf,
  receiptSealContext,
  sealJson,
  signDelegatedReceipt,
  startOfDay,
  thresholdsSummary,
  type ActAnswer,
  type ActArea,
  type ActRequest,
  type ActingConfig,
  type ActionAsk,
  type MessageKind,
  type NegotiationInput,
  type NegotiationStep,
  type ReceiptKind,
  type SelfLimits,
} from "@sigil/core";
import type { VaultReader } from "./reader";

export interface CheckInput {
  area: "mail" | "calendar";
  action: ActionAsk["action"];
  who: string;
  subject?: string;
  text?: string;
  kinds?: MessageKind[];
  start?: string;
  minutes?: number;
  conflicts?: boolean;
  /** What the app means to send or do, for the owner to read and change. */
  next?: string;
  /** The thread so far, oldest first. */
  thread?: { from: string; text: string }[];
  /** Where it lives in the app's world: a thread id, a message id, an event id. */
  ref?: Record<string, string>;
}

export type CheckResult =
  | { verdict: "allowed"; id: string; limit: string }
  | { verdict: "needs-approval"; id: string; reason: string }
  | { verdict: "refused"; id: string; reason: string };

export type StatusResult = { state: "waiting" } | { state: "approved"; next: string | null } | { state: "declined" } | { state: "allowed" | "done" | "refused" };

export interface ReportInput {
  id: string;
  /** What the app did, in plain words. */
  what: string;
  ref?: Record<string, string>;
}

export interface NegotiateInput extends Omit<NegotiationInput, "now" | "busy"> {
  thread?: { from: string; text: string }[];
  busy?: { start: string; end: string }[];
  ref?: Record<string, string>;
}

export type NegotiateResult = { step: NegotiationStep; id: string; state: "allowed" | "waiting" | "refused" };

/** What the MCP server needs. ActingClient implements it; tests pass a stub. */
export interface ActingTools {
  summary(): Promise<string[]>;
  check(input: CheckInput): Promise<CheckResult>;
  status(id: string): Promise<StatusResult>;
  report(input: ReportInput): Promise<{ receiptId: string; leaf: string }>;
  negotiate(input: NegotiateInput): Promise<NegotiateResult>;
}

interface WireActing {
  config: string;
  recent: { area: ActArea; at: string }[];
}

interface WireAct {
  id: string;
  area: ActArea;
  state: "allowed" | "waiting" | "approved" | "declined" | "refused" | "done";
  answer: string | null;
}

const KIND: Record<ActArea, ReceiptKind> = { mail: "mail", calendar: "calendar", negotiation: "negotiation" };

export class ActingClient implements ActingTools {
  /** The limit each step taken alone was allowed under, for its receipt, while this process runs. */
  private readonly limits = new Map<string, string>();

  constructor(
    private readonly reader: VaultReader,
    private readonly now: () => number = Date.now,
  ) {}

  /** The thresholds, opened here, and the steps taken alone today in each area. Fetched every time, so a change in the vault applies at once. */
  private async open(): Promise<{ config: ActingConfig & { limits: SelfLimits }; today: Record<ActArea, number> }> {
    const r = await this.reader.request<WireActing>("GET", "acting");
    const key = await importKey(await appSelfKey(this.reader.appSecret));
    const raw = await decryptJson<ActingConfig>(key, r.config, AAD.appActing(this.reader.appId));
    const limits = cleanLimits(raw.limits);
    const since = startOfDay(new Date(this.now()), limits.meetings.timeZone).getTime();
    const today: Record<ActArea, number> = { mail: 0, calendar: 0, negotiation: 0 };
    for (const x of r.recent) if (Date.parse(x.at) >= since) today[x.area]++;
    return { config: { ...raw, limits }, today };
  }

  private async record(config: ActingConfig, state: "allowed" | "waiting" | "refused", request: Omit<ActRequest, "v" | "at">): Promise<string> {
    const id = randomId();
    const box = sealJson(decodeBoxPublicKey(config.boxPublic), { ...request, v: 1, at: new Date(this.now()).toISOString() }, actRequestContext(id, this.reader.appId));
    await this.reader.request("POST", "acting", { id, area: request.area, state, box });
    return id;
  }

  async summary(): Promise<string[]> {
    return thresholdsSummary((await this.open()).config.limits);
  }

  async check(input: CheckInput): Promise<CheckResult> {
    const { config, today } = await this.open();
    const ask: ActionAsk = { area: input.area, action: input.action, who: input.who, subject: input.subject, text: input.text, kinds: input.kinds, start: input.start, minutes: input.minutes, conflicts: input.conflicts };
    // Replies and negotiation by mail share the most per day for mail.
    const v = checkAction(config.limits, ask, { today: input.area === "mail" ? today.mail + today.negotiation : today.calendar, now: this.now() });
    const state = v.verdict === "allowed" ? "allowed" : v.verdict === "refused" ? "refused" : "waiting";
    const id = await this.record(config, state, {
      area: input.area,
      action: input.action,
      who: input.who,
      subject: input.subject ?? "",
      thread: input.thread ?? (input.text ? [{ from: input.who, text: input.text }] : []),
      next: input.next ?? "",
      reason: v.verdict === "allowed" ? v.limit : v.reason,
      when: input.start && input.minutes ? { start: input.start, minutes: input.minutes } : null,
      offer: null,
      ref: input.ref ?? {},
    });
    if (v.verdict === "allowed") {
      this.limits.set(id, v.limit);
      return { verdict: "allowed", id, limit: v.limit };
    }
    return { verdict: v.verdict, id, reason: v.reason };
  }

  async status(id: string): Promise<StatusResult> {
    const { act } = await this.reader.request<{ act: WireAct }>("GET", `acting/${encodeURIComponent(id)}`);
    if (act.state === "approved" || act.state === "declined") {
      if (!act.answer) throw new Error("The owner's answer is missing.");
      const key = await importKey(await appSelfKey(this.reader.appSecret));
      // Opened with this app's key: the server cannot have written it. It must name this very step.
      const answer = await decryptJson<ActAnswer>(key, act.answer, AAD.actAnswer(this.reader.appId, id));
      if (answer.id !== id || answer.verdict !== act.state) throw new Error("The owner's answer does not match this step.");
      return answer.verdict === "approved" ? { state: "approved", next: answer.next } : { state: "declined" };
    }
    return { state: act.state };
  }

  async report(input: ReportInput): Promise<{ receiptId: string; leaf: string }> {
    const { config } = await this.open();
    const { act } = await this.reader.request<{ act: WireAct }>("GET", `acting/${encodeURIComponent(input.id)}`);
    if (act.state === "done") throw new Error("This step already has its receipt.");
    if (act.state === "approved") await this.status(input.id);
    else if (act.state !== "allowed") throw new Error(act.state === "waiting" ? "This step still waits for the owner. Do not act on it yet." : "The owner did not allow this step.");
    const limit = act.state === "approved" ? "Approved by the owner in Work" : (this.limits.get(input.id) ?? "Within the owner's thresholds");
    const key = await appReceiptKey(this.reader.appSecret);
    const receipt = signDelegatedReceipt(key, config.delegation, { kind: KIND[act.area], what: input.what, limit, ref: { step: input.id, ...(input.ref ?? {}) }, origin: config.delegation.origin });
    const receiptId = randomId();
    const leaf = receiptLeaf(receipt);
    await this.reader.request("POST", `acting/${encodeURIComponent(input.id)}/receipt`, {
      receipt: { id: receiptId, leaf, box: sealJson(decodeBoxPublicKey(config.boxPublic), receipt, receiptSealContext(receiptId, this.reader.appId)) },
    });
    this.limits.delete(input.id);
    return { receiptId, leaf };
  }

  async negotiate(input: NegotiateInput): Promise<NegotiateResult> {
    const { config } = await this.open();
    const limits = config.limits;
    const hit = neverTouchHit(limits, [input.who], [input.topic, ...(input.theirs?.terms ?? [])]);
    const step = hit
      ? { move: "ask" as const, offer: null, say: "", reason: `It names "${hit}", which is on your never-touch list. It will not negotiate this.`, range: "" }
      : negotiateStep(limits, { ...input, busy: input.busy ?? [], now: this.now() });
    const state = hit ? "refused" : step.move === "ask" ? "waiting" : "allowed";
    const id = await this.record(config, state, {
      area: "negotiation",
      action: step.agree ? "agree" : "counter",
      who: input.who,
      subject: input.topic,
      thread: input.thread ?? [],
      next: step.say,
      reason: step.move === "ask" ? step.reason : `${step.range}. ${step.reason}`,
      when: step.offer?.time ? { start: step.offer.time, minutes: step.offer.minutes ?? 30 } : null,
      offer: step.offer,
      ref: input.ref ?? {},
    });
    if (state === "allowed") this.limits.set(id, step.range);
    return { step, id, state };
  }
}
