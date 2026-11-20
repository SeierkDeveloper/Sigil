// Slack, read incrementally on the device: one memory per channel and day.
//
// The cursor keeps, per channel, the time of the newest message seen. Each pass
// asks every channel for messages after that time; for every day that got
// something new, the whole day is fetched again and its memory rebuilt, so a
// memory is always the full day in order, whichever device wrote it last.
//
// Calls are form posts with the token in the body: a simple request a browser
// may send to Slack's API without a preflight.

import type { MemoryDraft } from "../vault";
import { SyncError, type SyncFetch } from "./oauth";
import type { ProviderCtx, SyncBatch, SyncItem } from "./google";

const API = "https://slack.com/api";
export const SLACK_WINDOW_DAYS = 30;
export const CHANNELS_PER_PASS = 20;
export const DAY_CHARS = 30_000;

interface SlackChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
  is_archived?: boolean;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
}

async function call<T extends { ok: boolean; error?: string }>(fetcher: SyncFetch, token: string, method: string, params: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, ...params }).toString(),
    });
  } catch {
    throw new SyncError("Slack could not be reached.", "network");
  }
  const data = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T;
  if (!data.ok) {
    const e = data.error ?? "unknown_error";
    if (e === "invalid_auth" || e === "token_revoked" || e === "token_expired" || e === "not_authed" || e === "account_inactive") throw new SyncError("Slack no longer accepts this connection.", "auth");
    if (e === "channel_not_found") throw new SyncError("That channel is gone.", "gone");
    throw new SyncError(`Slack answered ${e}.`, "provider", res.status);
  }
  return data;
}

/** Slack's markup as plain text: mentions by name, links by their label and address. */
export function slackText(text: string, users: Map<string, string>, channels: Map<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${users.get(id) ?? "someone"}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `#${label || channels.get(id) || "a channel"}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const dayOf = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

export function channelName(c: SlackChannel, users: Map<string, string>): string {
  if (c.is_im) return `Direct message with ${users.get(c.user ?? "") ?? "someone"}`;
  if (c.is_mpim) return `Group message ${c.name ?? ""}`.trim();
  return `#${c.name ?? c.id}`;
}

export function slackDayDraft(channel: SlackChannel, day: string, messages: SlackMessage[], users: Map<string, string>, channels: Map<string, string>): SyncItem | null {
  const kept = messages.filter((m) => m.text && (!m.subtype || m.subtype === "thread_broadcast" || m.subtype === "bot_message")).sort((a, b) => Number(a.ts) - Number(b.ts));
  if (kept.length === 0) return null;
  const name = channelName(channel, users);
  const lines: string[] = [];
  let size = 0;
  for (const m of kept) {
    const who = users.get(m.user ?? "") ?? m.username ?? "Someone";
    const at = new Date(Number(m.ts) * 1000).toISOString().slice(11, 16);
    const line = `### ${who}, ${at}\n${slackText(m.text ?? "", users, channels)}`;
    if (size + line.length > DAY_CHARS) {
      lines.push(`[${kept.length - lines.length} more messages that day were left out.]`);
      break;
    }
    lines.push(line);
    size += line.length;
  }
  const ref = `${channel.id}:${day}`;
  const draft: MemoryDraft = {
    title: `${name}, ${day}`,
    body: lines.join("\n\n"),
    tags: ["slack"],
    source: { kind: "slack", ref },
    createdAt: new Date(Number(kept[0].ts) * 1000).toISOString(),
    editedAt: new Date(Number(kept[kept.length - 1].ts) * 1000).toISOString(),
  };
  return { ref, draft };
}

interface SlackCursor {
  /** The newest message time seen, per channel. */
  latest: Record<string, string>;
  /** Channels still to visit in this round, when one pass could not reach them all. */
  queue: string[];
}

async function history(ctx: ProviderCtx, channel: string, oldest: string, latest?: string): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = { channel, oldest, limit: "200" };
    if (latest) {
      params.latest = latest;
      params.inclusive = "true";
    }
    if (cursor) params.cursor = cursor;
    const r = await call<{ ok: boolean; error?: string; messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(ctx.fetch, ctx.token, "conversations.history", params);
    out.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!r.has_more || !cursor) break;
  }
  return out;
}

export async function syncSlack(ctx: ProviderCtx): Promise<SyncBatch> {
  const c = { latest: {}, queue: [], ...(ctx.cursor ? (JSON.parse(ctx.cursor) as Partial<SlackCursor>) : {}) } as SlackCursor;
  const auth = await call<{ ok: boolean; team?: string; user?: string }>(ctx.fetch, ctx.token, "auth.test", {});
  const users = new Map<string, string>();
  let ucursor = "";
  for (let page = 0; page < 10; page++) {
    const r = await call<{ ok: boolean; members?: { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }[]; response_metadata?: { next_cursor?: string } }>(
      ctx.fetch,
      ctx.token,
      "users.list",
      ucursor ? { limit: "200", cursor: ucursor } : { limit: "200" },
    );
    for (const m of r.members ?? []) users.set(m.id, m.profile?.display_name || m.real_name || m.profile?.real_name || m.name || "Someone");
    ucursor = r.response_metadata?.next_cursor ?? "";
    if (!ucursor) break;
  }
  const all: SlackChannel[] = [];
  let ccursor = "";
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "200" };
    if (ccursor) params.cursor = ccursor;
    const r = await call<{ ok: boolean; channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(ctx.fetch, ctx.token, "users.conversations", params);
    all.push(...(r.channels ?? []));
    ccursor = r.response_metadata?.next_cursor ?? "";
    if (!ccursor) break;
  }
  const channelNames = new Map(all.map((ch) => [ch.id, ch.name ?? ch.id]));
  const byId = new Map(all.map((ch) => [ch.id, ch]));
  const queue = c.queue.filter((id) => byId.has(id));
  const round = queue.length ? queue : all.map((ch) => ch.id);
  const visit = round.slice(0, CHANNELS_PER_PASS);
  const rest = round.slice(CHANNELS_PER_PASS);
  const items: SyncItem[] = [];
  const windowStart = String(Math.floor(ctx.now / 1000) - SLACK_WINDOW_DAYS * 86_400);
  for (const id of visit) {
    const ch = byId.get(id)!;
    const since = c.latest[id] ?? windowStart;
    let fresh: SlackMessage[];
    try {
      fresh = await history(ctx, id, since);
    } catch (err) {
      if (err instanceof SyncError && err.code === "gone") continue;
      throw err;
    }
    fresh = fresh.filter((m) => Number(m.ts) > Number(since));
    if (fresh.length === 0) continue;
    const days = [...new Set(fresh.map((m) => dayOf(m.ts)))].sort();
    for (const day of days) {
      const start = String(Date.parse(`${day}T00:00:00.000Z`) / 1000);
      const end = String(Date.parse(`${day}T00:00:00.000Z`) / 1000 + 86_399.999999);
      const whole = await history(ctx, id, start, end);
      const item = slackDayDraft(ch, day, whole, users, channelNames);
      if (item) items.push(item);
    }
    c.latest[id] = fresh.reduce((max, m) => (Number(m.ts) > Number(max) ? m.ts : max), since);
  }
  const next: SlackCursor = { latest: c.latest, queue: rest };
  return { items, removed: [], cursor: JSON.stringify(next), more: rest.length > 0, account: auth.team };
}
