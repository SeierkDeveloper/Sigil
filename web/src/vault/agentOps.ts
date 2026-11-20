// Agents and team spaces on the owner's device. Agent keys, grants, space keys,
// member tags and every memory are made here; the Api only carries envelopes,
// sealed boxes, public keys and roles.

import {
  agentHandoffKey,
  agentPublicKey,
  buildMemory,
  canWrite,
  cleanAgentRules,
  createFolder as encryptFolder,
  createApp as encryptApp,
  createSpace as sealNewSpace,
  decryptJson,
  decryptMemory,
  encryptJson,
  encryptMemory,
  importKey,
  memberTag,
  openAppSecret,
  openHandoff,
  openSpaceKey,
  openSpaceWithRaw,
  parseAppKey,
  parseVaultCode,
  randomId,
  rotateSpace,
  sealForMember,
  spaceHandoffKey,
  untrustedMembers,
  wrapGrants,
  AAD,
  type AgentRules,
  type AppKind,
  type BoxKeyPair,
  type HandoffNote,
  type Memory,
  type MemoryDraft,
  type OpenFolder,
  type OpenSpace,
  type SpaceMember,
  type SpaceRole,
} from "@sigil/core";
import type { Api } from "./api";
import type { AppView, Unlocked, VaultData } from "./ops";

// ---------------------------------------------------------------- agents

export interface ServerAgent {
  appId: string;
  homeFolderId: string;
  rules: AgentRules;
  publicKey: string;
  createdAt: string;
}

export type AgentView = ServerAgent;

export interface AgentInput {
  name: string;
  kind: AppKind;
  /** Folders it may read, besides its own. */
  read: OpenFolder[];
  /** Folders it may also write. Its own folder is always writable. */
  write: OpenFolder[];
  rules: AgentRules;
}

/**
 * Makes an agent: its own folder (marked as an agent's, inside the encrypted
 * name), an app key, grants for every folder it may use, and the public half of
 * the key pair derived from its secret.
 */
export async function createAgent(api: Api, vault: Unlocked, input: AgentInput): Promise<{ appKey: string; appId: string; folder: OpenFolder }> {
  const name = input.name.trim().slice(0, 80) || "Agent";
  const home = await encryptFolder(vault.key, `${name} memory`, undefined, "agent");
  const folders = [home.folder, ...input.read.filter((f) => f.id !== home.folder.id)];
  const writable = new Set([home.folder.id, ...input.write.map((f) => f.id)]);
  for (const f of input.write) if (!folders.some((x) => x.id === f.id)) folders.push(f);
  const app = await encryptApp(vault.key, { name, kind: input.kind }, folders);
  const { secret } = parseAppKey(app.appKey);
  await api.post("agents", {
    app: { ...app.stored, grants: app.stored.grants.map((g) => ({ ...g, mode: writable.has(g.folderId) ? "write" : "read" })) },
    folder: home.stored,
    rules: cleanAgentRules(input.rules),
    publicKey: agentPublicKey(secret),
  });
  return { appKey: app.appKey, appId: app.stored.id, folder: home.folder };
}

export async function updateAgent(api: Api, vault: Unlocked, app: Pick<AppView, "id" | "secret">, agent: AgentView, folders: OpenFolder[], write: Set<string>, rules: AgentRules): Promise<void> {
  const secret = await openAppSecret(vault.key, app);
  const grants = await wrapGrants(app.id, secret, folders);
  await api.put(`agents/${app.id}`, {
    rules: cleanAgentRules(rules),
    grants: grants.map((g) => ({ ...g, mode: g.folderId === agent.homeFolderId || write.has(g.folderId) ? "write" : "read" })),
  });
}

/** Which folders an agent may write, from the grants the server holds. */
export function writableFolders(app: Pick<AppView, "id">, data: Pick<VaultData, "apps">): Set<string> {
  const a = data.apps.find((x) => x.id === app.id);
  return new Set(a?.writeIds ?? []);
}

export interface OwnerHandoff {
  id: string;
  spaceId: string | null;
  createdAt: string;
  pickedAt: string | null;
  note: HandoffNote | null;
}

/** The notes an agent left, opened with keys from its secret (own notes) or the space key (notes in a space). */
export async function agentHandoffs(api: Api, vault: Unlocked, app: Pick<AppView, "id" | "secret">, spaces: SpaceView[]): Promise<OwnerHandoff[]> {
  const r = await api.get<{ handoffs: { id: string; spaceId: string | null; sealed: string; createdAt: string; pickedAt: string | null }[] }>(`agents/${app.id}/handoffs`);
  const own = await agentHandoffKey(await openAppSecret(vault.key, app));
  const out: OwnerHandoff[] = [];
  for (const h of r.handoffs) {
    let note: HandoffNote | null = null;
    try {
      const space = h.spaceId ? spaces.find((s) => s.id === h.spaceId)?.folder : null;
      const key = h.spaceId ? (space ? await spaceHandoffKey(space.raw) : null) : own;
      if (key) note = await openHandoff(key, h.id, h.sealed);
    } catch {
      note = null;
    }
    out.push({ id: h.id, spaceId: h.spaceId, createdAt: h.createdAt, pickedAt: h.pickedAt, note });
  }
  return out;
}

// ---------------------------------------------------------------- team spaces

export interface ServerSpace {
  id: string;
  meta: string;
  epoch: number;
  me: { id: string; role: SpaceRole; sealedKey: string; acceptedAt: string | null };
  members: { id: string; kind: "vault" | "agent"; appId: string | null; publicKey: string; role: SpaceRole; tag: string; label: string; acceptedAt: string | null; owner: string | null }[];
  memories: { id: string; folderId: string; head: string; body: string; author: string | null; updatedAt: string }[];
}

export interface SpaceMemberView {
  id: string;
  kind: "vault" | "agent";
  /** For an agent of this vault: its app id. */
  appId: string | null;
  publicKey: string;
  role: SpaceRole;
  label: string;
  acceptedAt: string | null;
  /** For an agent: the member id of the vault it belongs to. */
  owner: string | null;
  /** False when the member's tag does not check out with the space key. */
  trusted: boolean;
}

export interface SpaceView {
  id: string;
  epoch: number;
  name: string;
  /** The space opened with its key, shaped like a folder. Null if the key would not open. */
  folder: OpenSpace | null;
  me: ServerSpace["me"];
  members: SpaceMemberView[];
  memories: (Memory & { author: string | null })[];
  untrusted: string[];
}

function labelAad(spaceId: string, memberId: string): string {
  return AAD.spaceNote(`${spaceId}:${memberId}`);
}

async function sealLabel(space: OpenSpace, memberId: string, label: string): Promise<string> {
  return encryptJson(space.key, { label: label.trim().slice(0, 80) || "Member" }, labelAad(space.id, memberId));
}

export async function openSpaces(box: BoxKeyPair | null, server: ServerSpace[]): Promise<{ spaces: SpaceView[]; unreadable: number }> {
  const spaces: SpaceView[] = [];
  let unreadable = 0;
  for (const s of server) {
    let folder: OpenSpace | null = null;
    try {
      if (!box) throw new Error("no box key");
      const { raw } = openSpaceKey(box, s.id, s.me.id, s.me.sealedKey);
      folder = await openSpaceWithRaw(s.id, s.meta, raw);
    } catch {
      unreadable++;
    }
    const members: SpaceMemberView[] = [];
    for (const m of s.members) {
      let label = m.kind === "agent" ? "An agent" : "A vault";
      if (folder) {
        try {
          label = (await decryptJson<{ label: string }>(folder.key, m.label, labelAad(s.id, m.id))).label;
        } catch {
          label = "Unreadable name";
        }
      }
      members.push({ id: m.id, kind: m.kind, appId: m.appId, publicKey: m.publicKey, role: m.role, label, acceptedAt: m.acceptedAt, owner: m.owner, trusted: false });
    }
    const untrusted = folder ? await untrustedMembers(folder.raw, s.id, s.members) : s.members.map((m) => m.id);
    for (const m of members) m.trusted = !untrusted.includes(m.id);
    const memories: SpaceView["memories"] = [];
    if (folder) {
      for (const m of s.memories) {
        try {
          memories.push({ ...(await decryptMemory(folder, m)), author: m.author });
        } catch {
          unreadable++;
        }
      }
    }
    memories.sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1));
    spaces.push({ id: s.id, epoch: s.epoch, name: folder?.name ?? "A space that would not open", folder, me: s.me, members, memories, untrusted });
  }
  return { spaces, unreadable };
}

function needTrusted(space: SpaceView): OpenSpace {
  if (!space.folder) throw new Error("This space did not open with your vault key.");
  if (space.untrusted.length) throw new Error("Some members of this space were not added by a member who holds its key. Nothing is sealed until an admin removes them.");
  return space.folder;
}

export async function createSpace(api: Api, data: Pick<VaultData, "boxPublic">, name: string, myName: string): Promise<string> {
  if (!data.boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  const id = randomId();
  const me: SpaceMember = { id: randomId(), kind: "vault", publicKey: data.boxPublic, role: "admin" };
  const made = await sealNewSpace(id, name, me);
  const space = await openSpaceWithRaw(id, made.meta, made.raw);
  await api.post("spaces", { id, meta: made.meta, member: { ...me, sealedKey: made.creator.sealedKey, tag: made.creator.tag, label: await sealLabel(space, me.id, myName || "Owner") } });
  return id;
}

export async function addVaultMember(api: Api, space: SpaceView, code: string, label: string, role: SpaceRole): Promise<void> {
  const folder = needTrusted(space);
  const m: SpaceMember = { id: randomId(), kind: "vault", publicKey: parseVaultCode(code), role };
  const sealed = await sealForMember(folder.raw, space.id, space.epoch, m);
  await api.post(`spaces/${space.id}/members`, { ...m, sealedKey: sealed.sealedKey, tag: sealed.tag, label: await sealLabel(folder, m.id, label) });
}

/** Adds one of this vault's agents. Its key comes from its secret, on this device. */
export async function addAgentMember(api: Api, vault: Unlocked, space: SpaceView, app: Pick<AppView, "id" | "secret" | "name">, role: "read" | "write"): Promise<void> {
  const folder = needTrusted(space);
  const secret = await openAppSecret(vault.key, app);
  const m: SpaceMember = { id: randomId(), kind: "agent", publicKey: agentPublicKey(secret), role };
  const sealed = await sealForMember(folder.raw, space.id, space.epoch, m);
  await api.post(`spaces/${space.id}/members`, { ...m, appId: app.id, sealedKey: sealed.sealedKey, tag: sealed.tag, label: await sealLabel(folder, m.id, app.name) });
}

export async function acceptSpace(api: Api, spaceId: string): Promise<void> {
  await api.post(`spaces/${spaceId}/accept`);
}

export async function setMemberRole(api: Api, space: SpaceView, member: SpaceMemberView, role: SpaceRole): Promise<void> {
  const folder = needTrusted(space);
  const tag = await memberTag(folder.raw, space.id, { id: member.id, kind: member.kind, publicKey: member.publicKey, role });
  await api.put(`spaces/${space.id}/members/${member.id}/role`, { role, tag });
}

/**
 * Removes members by giving the space a new key on this device: every memory
 * encrypted again, the key and names sealed again for those who stay. The
 * agents of a removed vault go with it.
 */
export async function removeMembers(api: Api, space: SpaceView, ids: string[]): Promise<void> {
  if (!space.folder) throw new Error("This space did not open with your vault key.");
  const gone = new Set(ids);
  for (const m of space.members) if (m.kind === "agent" && m.owner && gone.has(m.owner)) gone.add(m.id);
  // Members whose tag fails are removed too: nothing is sealed to a key no admin added.
  for (const id of space.untrusted) gone.add(id);
  const stay = space.members.filter((m) => !gone.has(m.id));
  const r = await rotateSpace(
    space.folder,
    space.epoch + 1,
    space.memories.map(({ author: _a, ...m }) => m),
    stay.map((m) => ({ id: m.id, kind: m.kind, publicKey: m.publicKey, role: m.role })),
  );
  const next: OpenSpace = { ...space.folder, raw: r.raw, key: await importKey(r.raw) };
  await api.post(`spaces/${space.id}/rotate`, {
    epoch: r.epoch,
    meta: r.meta,
    memories: r.memories,
    members: await Promise.all(r.members.map(async (m) => ({ ...m, label: await sealLabel(next, m.id, stay.find((x) => x.id === m.id)!.label) }))),
    remove: [...gone],
  });
}

export async function deleteSpace(api: Api, spaceId: string): Promise<void> {
  await api.del(`spaces/${spaceId}`);
}

export async function saveSpaceMemory(api: Api, space: SpaceView, draft: MemoryDraft, id?: string): Promise<Memory> {
  if (!space.folder) throw new Error("This space did not open with your vault key.");
  if (!canWrite(space.me.role)) throw new Error("Your role in this space is read only.");
  const memory = buildMemory(draft, space.id, id);
  await api.put(`spaces/${space.id}/memories`, { memories: [await encryptMemory(space.folder, memory)] });
  return memory;
}

export async function deleteSpaceMemory(api: Api, spaceId: string, id: string): Promise<void> {
  await api.post(`spaces/${spaceId}/memories/delete`, { ids: [id] });
}
