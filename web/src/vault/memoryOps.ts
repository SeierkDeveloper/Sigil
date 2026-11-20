// Shared memory on the owner's device: a family's or a team's history on top of
// team spaces. Stories, people and photos are encrypted with the space key
// here; heirs are sealed and tagged here as the members they will become; the
// readable copy of the whole history is made here from what was decrypted.

import {
  historyHtml,
  parseVaultCode,
  peopleOf,
  personDraft,
  randomId,
  sealHeir,
  storyDraft,
  type PersonDraft,
  type SpaceKind,
  type SpaceRole,
  type StoryDraft,
} from "@sigil/core";
import type { Api } from "./api";
import type { VaultData } from "./ops";
import { createSpace, saveSpaceMemory, sealLabel, type SpaceView } from "./agentOps";

export function memorySpaces(data: Pick<VaultData, "spaces">): SpaceView[] {
  return data.spaces.filter((s) => s.kind === "family" || s.kind === "history");
}

export function teamSpaces(data: Pick<VaultData, "spaces">): SpaceView[] {
  return data.spaces.filter((s) => s.kind === "team");
}

export async function createMemorySpace(api: Api, data: Pick<VaultData, "boxPublic">, input: { name: string; kind: Exclude<SpaceKind, "team">; about: string; myName: string }): Promise<string> {
  return createSpace(api, data, input.name, input.myName, { kind: input.kind, about: input.about });
}

export async function addStory(api: Api, space: SpaceView, story: StoryDraft, id?: string) {
  return saveSpaceMemory(api, space, storyDraft(story), id);
}

export async function addPerson(api: Api, space: SpaceView, person: PersonDraft, id?: string) {
  return saveSpaceMemory(api, space, personDraft(person), id);
}

/** Names an heir by vault code: sealed and tagged now with the space key, made a member by the node when the plan of the member it is named for releases. */
export async function nameHeir(api: Api, space: SpaceView, input: { code: string; label: string; role: SpaceRole; forMember: string | null }): Promise<void> {
  if (!space.folder) throw new Error("This space did not open with your vault key.");
  if (space.untrusted.length) throw new Error("Some members of this space were not added by a member who holds its key. Nothing is sealed until an admin removes them.");
  const publicKey = parseVaultCode(input.code);
  const id = randomId();
  const role: SpaceRole = input.role === "admin" ? "write" : input.role;
  const sealed = await sealHeir(space.folder.raw, space.id, space.epoch, { id, publicKey, role });
  await api.post(`spaces/${space.id}/heirs`, { id, publicKey, role, sealedKey: sealed.sealedKey, tag: sealed.tag, label: await sealLabel(space.folder, id, input.label), forMember: input.forMember });
}

export async function removeHeir(api: Api, spaceId: string, heirId: string): Promise<void> {
  await api.del(`spaces/${spaceId}/heirs/${heirId}`);
}

export async function leaveSpace(api: Api, spaceId: string): Promise<void> {
  await api.post(`spaces/${spaceId}/leave`);
}

/** The whole history as one HTML document, decrypted on this device, ready to read or print to PDF. */
export function historyDocument(space: SpaceView, at = new Date()): string {
  const members = Object.fromEntries(space.members.filter((m) => m.kind === "vault").map((m) => [m.id, m.label]));
  return historyHtml({
    name: space.name,
    about: space.about,
    kind: space.kind,
    members,
    people: peopleOf(space.memories),
    memories: space.memories,
    madeAt: at.toISOString(),
  });
}
