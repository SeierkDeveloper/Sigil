// Legacy on the device: the owner's plan, invites, and the trusted person's
// side of a release. Keys are made, split, sealed, combined and opened here;
// the Api only carries sealed boxes, envelopes, ids and times.

import {
  answerAsSelf,
  combineLegacyShares,
  decryptMemory,
  formatLegacyInvite,
  fromBase64Url,
  inviteTag,
  legacyAskContext,
  newInviteSecret,
  openFolderWithRaw,
  openInviteIntro,
  openKept,
  openLegacyBundle,
  openLegacyNote,
  openLegacyShare,
  openOwnerRecord,
  openPassedShare,
  parseLegacyInvite,
  passShare,
  randomId,
  sealInviteIntro,
  sealJson,
  openSealedJson,
  sealKept,
  sealLegacyPlan,
  toBase64Url,
  decodeBoxPublicKey,
  verifyInviteTag,
  type AskNote,
  type BoxKeyPair,
  type LegacyBundle,
  type LegacyKept,
  type LegacyNote,
  type LegacyOwnerRecord,
  type LegacyPersonPlan,
  type LegacySharePayload,
  type Memory,
  type ModelCaller,
  type OpenFolder,
  type SelfAnswer,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

// ---------------------------------------------------------------- what the server sends

export interface ServerPerson {
  id: string;
  publicKey: string | null;
  hasVault: boolean;
  folderIds: string[];
  self: boolean;
  sealed: boolean;
  invite: { answered: boolean; publicKey: string | null; tag: string | null } | null;
  openedAt: string | null;
}

export interface ServerPlan {
  id: string;
  epoch: number;
  threshold: number;
  periodDays: number;
  ownerBox: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  firstWarningAt: string;
  lastWarningAt: string;
  stage: 0 | 1 | 2 | 3;
  missed: { stage: number; at: string | null } | null;
  releasedAt: string | null;
  people: ServerPerson[];
  requests: { personId: string; at: string }[];
}

export interface ServerLegacy {
  lastActiveAt: string | null;
  plan: ServerPlan | null;
}

export interface ServerTrusted {
  planId: string;
  personId: string;
  epoch: number;
  note: string;
  state: "waiting" | "incomplete" | "open";
  share: string | null;
  passes: { from: string; sealed: string }[];
  passedTo: string[];
  requests: { personId: string; at: string }[];
  kept: string | null;
  openedAt: string | null;
  releasedAt: string | null;
}

// ---------------------------------------------------------------- the owner's view

export interface InviteAnswer {
  publicKey: string;
  /** True when the tag was made with the secret in the invite link: the key really came from whoever opened it. */
  verified: boolean;
}

export interface LegacyState {
  lastActiveAt: string | null;
  plan: ServerPlan | null;
  record: LegacyOwnerRecord | null;
  answers: Record<string, InviteAnswer>;
  unreadable: boolean;
}

export async function openLegacyState(vault: Unlocked, server: ServerLegacy): Promise<LegacyState> {
  const out: LegacyState = { lastActiveAt: server.lastActiveAt, plan: server.plan, record: null, answers: {}, unreadable: false };
  if (!server.plan) return out;
  try {
    out.record = await openOwnerRecord(vault.key, server.plan.id, server.plan.ownerBox);
  } catch {
    out.unreadable = true;
    return out;
  }
  for (const p of out.record.people) {
    const s = server.plan.people.find((x) => x.id === p.id);
    if (!p.publicKey && p.invite && s?.invite?.answered && s.invite.publicKey && s.invite.tag) {
      out.answers[p.id] = { publicKey: s.invite.publicKey, verified: await verifyInviteTag(fromBase64Url(p.invite), p.id, s.invite.publicKey, s.invite.tag) };
    }
  }
  return out;
}

export interface LegacyDraft {
  owner: string;
  periodDays: number;
  threshold: number;
  includeModel: boolean;
  people: LegacyPersonPlan[];
}

/** A new person to add by invite link: an id and the one-time secret that rides in the link. */
export function newInvitePerson(label: string, folderIds: string[], self: boolean): LegacyPersonPlan {
  return { id: randomId(), label: label.trim().slice(0, 80) || "Trusted person", publicKey: null, invite: toBase64Url(newInviteSecret()), folderIds, self };
}

export function inviteLink(origin: string, person: LegacyPersonPlan): string | null {
  return person.invite ? formatLegacyInvite(origin, person.id, fromBase64Url(person.invite)) : null;
}

/**
 * Seals the plan again from scratch: a new legacy key, new shares, new bundles,
 * and the record under the vault key. Every save is a new epoch, so shares from
 * before no longer fit.
 */
export async function saveLegacy(api: Api, vault: Unlocked, data: VaultData, draft: LegacyDraft): Promise<LegacyState> {
  const planId = data.legacy.plan?.id ?? randomId();
  const epoch = (data.legacy.plan?.epoch ?? 0) + 1;
  const live = new Set(data.folders.map((f) => f.id));
  const people = draft.people.map((p) => ({ ...p, folderIds: p.folderIds.filter((id) => live.has(id)) }));
  const sealed = await sealLegacyPlan(vault.key, {
    planId,
    epoch,
    owner: draft.owner,
    periodDays: draft.periodDays,
    threshold: draft.threshold,
    includeModel: draft.includeModel,
    people,
    folders: data.folders,
    rules: data.self,
    model: data.model,
    ownerKey: data.boxPublic,
  });
  const body = {
    id: planId,
    epoch,
    threshold: sealed.threshold,
    periodDays: sealed.periodDays,
    check: sealed.check,
    ownerBox: sealed.ownerBox,
    people: await Promise.all(
      sealed.people.map(async (p, i) => ({
        ...p,
        inviteIntro: !p.publicKey && people[i].invite ? await sealInviteIntro(fromBase64Url(people[i].invite!), p.id, { owner: draft.owner, label: people[i].label }) : null,
      })),
    ),
  };
  const r = await api.put<ServerLegacy>("legacy", body);
  return openLegacyState(vault, r);
}

/** Seals the plan again as it stands: after a folder got a new key, or the AI self's rules changed. */
export async function resealLegacy(api: Api, vault: Unlocked, data: VaultData): Promise<LegacyState | null> {
  const r = data.legacy.record;
  if (!r) return null;
  return saveLegacy(api, vault, data, { owner: r.owner, periodDays: r.periodDays, threshold: r.threshold, includeModel: r.includeModel, people: r.people });
}

/** True when the plan holds a key for this folder, so a new folder key means sealing the plan again. */
export function legacyCovers(data: Pick<VaultData, "legacy">, folderId: string): boolean {
  return !!data.legacy.record?.people.some((p) => p.folderIds.includes(folderId));
}

export async function checkIn(api: Api, vault: Unlocked): Promise<LegacyState> {
  return openLegacyState(vault, await api.post<ServerLegacy>("legacy/check-in"));
}

export async function cancelLegacy(api: Api): Promise<void> {
  await api.del("legacy");
}

export async function dismissMissed(api: Api): Promise<void> {
  await api.post("legacy/dismiss");
}

// ---------------------------------------------------------------- invites, from the invited side

export interface InviteView {
  personId: string;
  secret: Uint8Array;
  owner: string;
  label: string;
  answered: boolean;
}

export async function readInvite(api: Api, fragment: string): Promise<InviteView> {
  const { trusteeId, secret } = parseLegacyInvite(fragment);
  const r = await api.get<{ intro: string; answered: boolean }>(`legacy/invites/${trusteeId}`);
  const intro = await openInviteIntro(secret, trusteeId, r.intro);
  return { personId: trusteeId, secret, owner: intro.owner, label: intro.label, answered: r.answered };
}

/** Answers with this vault's public key and a tag made with the invite's secret. */
export async function acceptInvite(api: Api, data: Pick<VaultData, "boxPublic">, invite: InviteView): Promise<void> {
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  await api.post(`legacy/invites/${invite.personId}`, { publicKey: data.boxPublic, tag: await inviteTag(invite.secret, invite.personId, data.boxPublic) });
}

// ---------------------------------------------------------------- the trusted person's side

export interface TrustedView {
  planId: string;
  personId: string;
  epoch: number;
  note: LegacyNote | null;
  state: ServerTrusted["state"];
  /** Opened here, only once the plan may be released. */
  mine: { payload: LegacySharePayload; share: Uint8Array } | null;
  /** Shares other trusted people passed to this vault, opened here. */
  received: { from: string; share: Uint8Array }[];
  passedTo: string[];
  requests: { personId: string; at: string }[];
  kept: LegacyKept | null;
  openedAt: string | null;
  releasedAt: string | null;
}

export async function openTrusted(vault: Unlocked, box: BoxKeyPair | null, server: ServerTrusted[]): Promise<TrustedView[]> {
  const out: TrustedView[] = [];
  for (const t of server) {
    const ref = { planId: t.planId, epoch: t.epoch, trusteeId: t.personId };
    let note: LegacyNote | null = null;
    let mine: TrustedView["mine"] = null;
    const received: TrustedView["received"] = [];
    let kept: LegacyKept | null = null;
    if (box) {
      try {
        note = openLegacyNote(box, { ...ref, sealed: t.note });
      } catch {
        note = null;
      }
      if (t.share) {
        try {
          mine = openLegacyShare(box, { ...ref, sealed: t.share });
        } catch {
          mine = null;
        }
      }
      if (mine) {
        for (const p of t.passes) {
          try {
            received.push({ from: p.from, share: openPassedShare(box, mine.payload, p.from, p.sealed) });
          } catch {
            // A share that does not open is left out; the person can ask again.
          }
        }
      }
    }
    if (t.kept) {
      try {
        kept = await openKept(vault.key, t.planId, t.kept);
      } catch {
        kept = null;
      }
    }
    out.push({ planId: t.planId, personId: t.personId, epoch: t.epoch, note, state: t.state, mine, received, passedTo: t.passedTo, requests: t.requests, kept, openedAt: t.openedAt, releasedAt: t.releasedAt });
  }
  return out;
}

export async function requestRelease(api: Api, planId: string): Promise<void> {
  await api.post(`legacy/plans/${planId}/request`);
}

/** Passes this vault's share to each trusted person who asked for a release and does not have it yet. */
export async function passToRequesters(api: Api, t: TrustedView): Promise<number> {
  if (!t.mine) throw new Error("Your share is not available yet.");
  let n = 0;
  for (const r of t.requests) {
    if (r.personId === t.personId || t.passedTo.includes(r.personId)) continue;
    await api.post(`legacy/plans/${t.planId}/pass`, { to: r.personId, sealed: passShare(t.mine.payload, t.mine.share, r.personId) });
    n++;
  }
  return n;
}

export function sharesInHand(t: TrustedView): number {
  return (t.mine ? 1 : 0) + t.received.length;
}

/**
 * Combines the shares in this browser, opens this person's bundle, and keeps a
 * copy under this vault's own key. The server learns only that it was opened.
 */
export async function openRelease(api: Api, vault: Unlocked, box: BoxKeyPair, t: TrustedView): Promise<LegacyKept> {
  if (!t.mine) throw new Error("Your share is not available yet.");
  const key = await combineLegacyShares([t.mine.share, ...t.received.map((r) => r.share)], t.mine.payload.threshold, {
    planId: t.planId,
    epoch: t.epoch,
    check: t.mine.payload.check,
  });
  const r = await api.get<{ personId: string; epoch: number; bundle: string }>(`legacy/plans/${t.planId}/bundle`);
  const bundle = await openLegacyBundle(key, box, { planId: t.planId, epoch: r.epoch, trusteeId: t.personId, sealed: r.bundle });
  key.fill(0);
  const kept: LegacyKept = { v: 1, planId: t.planId, epoch: r.epoch, bundle };
  await api.post(`legacy/plans/${t.planId}/opened`, { kept: await sealKept(vault.key, kept) });
  return kept;
}

export interface ReleasedVault {
  folders: OpenFolder[];
  memories: Memory[];
}

/** The folders the owner left this person, decrypted here with the keys from the bundle. */
export async function loadReleased(api: Api, bundle: LegacyBundle): Promise<ReleasedVault> {
  const r = await api.get<{ folders: { id: string; meta: string }[]; memories: { id: string; folderId: string; head: string; body: string }[] }>(`legacy/plans/${bundle.planId}/folders`);
  const keys = new Map(bundle.folders.map((f) => [f.id, fromBase64Url(f.key)]));
  const folders: OpenFolder[] = [];
  for (const f of r.folders) {
    const raw = keys.get(f.id);
    if (!raw) continue;
    try {
      folders.push(await openFolderWithRaw(f, raw));
    } catch {
      // A folder whose key changed after the plan was sealed stays closed.
    }
  }
  const byId = new Map(folders.map((f) => [f.id, f]));
  const memories: Memory[] = [];
  for (const m of r.memories) {
    const f = byId.get(m.folderId);
    if (!f) continue;
    try {
      memories.push(await decryptMemory(f, m));
    } catch {
      // Left out: it was written under a key this bundle does not hold.
    }
  }
  memories.sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1));
  return { folders, memories };
}

/**
 * Asks the AI self in legacy mode: the owner's rules, only the folders this
 * person received, and a model (the owner's, if included, or this person's
 * own). The question and answer are sealed to the owner's vault key and logged.
 */
export async function askLegacySelf(api: Api, bundle: LegacyBundle, released: ReleasedVault, model: ModelCaller, question: string, history: { question: string; answer: string }[] = []): Promise<SelfAnswer> {
  if (!bundle.self) throw new Error("The owner did not leave you their AI self.");
  const names = new Map(released.folders.map((f) => [f.id, f.name]));
  const answer = await answerAsSelf({
    question,
    rules: bundle.self.rules,
    memories: released.memories.map((m) => ({ id: m.id, folderId: m.folderId, folder: names.get(m.folderId) ?? "", title: m.title, tags: m.tags, body: m.body, editedAt: m.editedAt, expiresAt: m.expiresAt })),
    model,
    asker: "legacy",
    history,
  });
  if (bundle.ownerKey) {
    const noteId = randomId();
    const note: AskNote = {
      v: 1,
      via: "legacy",
      label: bundle.self.rules.name,
      question,
      answer: answer.text,
      citations: answer.citations.map((c) => ({ id: c.id, title: c.title })),
      refused: answer.refused,
    };
    await api.post(`legacy/plans/${bundle.planId}/asked`, {
      id: noteId,
      note: sealJson(decodeBoxPublicKey(bundle.ownerKey), note, legacyAskContext(bundle.planId, noteId)),
      cited: answer.citations.length,
    });
  }
  return answer;
}

/** Opens, for the owner, a question their AI self answered in legacy mode. */
export function openLegacyAskNote(box: BoxKeyPair, planId: string, entry: { memoryId: string | null; note?: string }): AskNote | null {
  const id = entry.memoryId?.startsWith("ask-") ? entry.memoryId.slice(4) : null;
  if (!id || !entry.note) return null;
  try {
    return openSealedJson<AskNote>(box, entry.note, legacyAskContext(planId, id));
  } catch {
    return null;
  }
}
