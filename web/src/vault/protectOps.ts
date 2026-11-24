// Protected folders on the owner's device: marking a folder protected (its
// kind and redaction rules go into the folder's encrypted meta, the server
// learns only that it is protected), the requests waiting for the owner's yes,
// and the gate the AI self passes before it reads a protected folder.
//
// The browser holds every key, so here the gate is the vault's own code: the
// AI self that answers a link, the public page or another self leaves
// protected folders out unless the owner said yes for that read, asks the same
// way an app does, and marks the yes used when it reads, so the read log shows
// the same record either way.

import { cleanGuard, clearedHash, guardFolder, randomId, redactMemory, type FolderGuard, type OpenFolder, type SelfMemory, type SelfRules } from "@sigil/core";
import { retrieve } from "@sigil/core";
import type { Api } from "./api";
import type { VaultData } from "./ops";

export type RequesterKind = "app" | "link" | "public" | "meet" | "self";

export interface AccessRequestView {
  id: string;
  requester: string;
  requesterKind: RequesterKind;
  folderId: string;
  memoryIds: string[];
  scope: "read" | "index";
  state: "pending" | "approved" | "denied" | "used";
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  usedAt: string | null;
}

export async function setFolderGuard(api: Api, folder: OpenFolder, guard: FolderGuard): Promise<OpenFolder> {
  const clean = cleanGuard(guard);
  const meta = await guardFolder(folder, clean);
  await api.put(`folders/${folder.id}/protect`, { protected: !!clean.protect, meta });
  const { protect: _p, redact: _r, ...rest } = folder;
  return { ...rest, ...clean };
}

export function protectedFolderIds(data: Pick<VaultData, "folders">): Set<string> {
  return new Set(data.folders.filter((f) => f.protect).map((f) => f.id));
}

export async function loadRequests(api: Api): Promise<AccessRequestView[]> {
  return (await api.get<{ requests: AccessRequestView[] }>("access")).requests;
}

export async function approveRequest(api: Api, id: string): Promise<AccessRequestView> {
  return (await api.post<{ request: AccessRequestView }>(`access/${id}/approve`)).request;
}

export async function denyRequest(api: Api, id: string): Promise<AccessRequestView> {
  return (await api.post<{ request: AccessRequestView }>(`access/${id}/deny`)).request;
}

/**
 * The memories the AI self may see on this device: live, not the Self card or a
 * brief, protected folders left out unless named in `open`, each masked with
 * its folder's redaction rules before any model sees it.
 */
export function guardedMemories(data: Pick<VaultData, "memories" | "folders">, open: Set<string> = new Set(), now = Date.now()): SelfMemory[] {
  const folders = new Map(data.folders.map((f) => [f.id, f]));
  return data.memories
    .filter((m) => (!m.expiresAt || Date.parse(m.expiresAt) > now) && m.source.kind !== "profile" && m.source.kind !== "brief")
    .filter((m) => !folders.get(m.folderId)?.protect || open.has(m.folderId))
    .map((m) => {
      const f = folders.get(m.folderId);
      const r = redactMemory({ title: m.title, body: m.body, tags: m.tags }, f?.redact);
      // An approval holds for the text the owner approved; redacting it does not undo the approval.
      const cleared = m.cleared && m.cleared === clearedHash(m.body) ? clearedHash(r.body) : undefined;
      return {
        id: m.id,
        folderId: m.folderId,
        folder: f?.name ?? "",
        title: r.title,
        tags: r.tags ?? [],
        body: r.body,
        editedAt: m.editedAt,
        createdAt: m.createdAt,
        ...(m.when ? { when: m.when } : {}),
        expiresAt: m.expiresAt,
        source: { kind: m.source.kind },
        ...(cleared ? { cleared } : {}),
      };
    });
}

export interface Gate {
  /** Memories from protected folders the owner said yes to for this read. */
  extra: SelfMemory[];
  /** Protected folders it wanted and could not read yet: a request waits in the inbox. */
  asked: string[];
  /** Marks the yes used, logging each protected memory read. Call it once the answer went out. */
  use(ids: string[]): Promise<void>;
}

/**
 * Before the AI self answers a question for someone (a link, another self):
 * which memories in protected folders its rules allow would help. With a yes
 * for exactly that read, they are let in; without one, a request goes to the
 * owner's inbox and the answer is made without them.
 */
export async function protectedGate(
  api: Api,
  data: Pick<VaultData, "memories" | "folders">,
  rules: SelfRules,
  question: string,
  requester: { id: string; kind: Exclude<RequesterKind, "app"> },
): Promise<Gate> {
  const guarded = data.folders.filter((f) => f.protect && rules.folderIds.includes(f.id));
  const none: Gate = { extra: [], asked: [], use: async () => undefined };
  if (guarded.length === 0) return none;
  const pool = guardedMemories(data, new Set(guarded.map((f) => f.id)));
  const hits = retrieve({ ...rules, folderIds: guarded.map((f) => f.id) }, pool, question);
  if (hits.length === 0) return none;
  const requests = await loadRequests(api);
  const extra: SelfMemory[] = [];
  const asked: string[] = [];
  const approvals: { id: string; memoryIds: string[] }[] = [];
  for (const f of guarded) {
    const ids = hits.filter((h) => pool.find((m) => m.id === h.id)?.folderId === f.id).map((h) => h.id);
    if (ids.length === 0) continue;
    const yes = requests.find(
      (r) => r.requester === requester.id && r.folderId === f.id && r.state === "approved" && Date.parse(r.expiresAt) > Date.now() && ids.every((id) => r.memoryIds.length === 0 || r.memoryIds.includes(id)),
    );
    if (yes) {
      extra.push(...pool.filter((m) => ids.includes(m.id)));
      approvals.push({ id: yes.id, memoryIds: ids });
      continue;
    }
    await api.post("access", { id: randomId(), requester: requester.id, requesterKind: requester.kind, folderId: f.id, memoryIds: ids });
    asked.push(f.name);
  }
  return {
    extra,
    asked,
    use: async (used) => {
      for (const a of approvals) {
        const ids = a.memoryIds.filter((id) => used.includes(id));
        await api.post(`access/${a.id}/use`, { memoryIds: ids.length ? ids : a.memoryIds });
      }
    },
  };
}

/** For the owner's own test chat: the yes is given on the vault screen, for one answer. */
export async function approveHere(api: Api, folderId: string, memoryIds: string[]): Promise<AccessRequestView> {
  return (await api.post<{ request: AccessRequestView }>("access", { id: randomId(), requester: "self", requesterKind: "self", folderId, memoryIds, approve: true })).request;
}

export const ASKED_TEXT = "Part of the answer is in a folder my owner keeps protected. They have been asked; try again in a few minutes.";
