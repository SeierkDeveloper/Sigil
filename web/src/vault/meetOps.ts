// Selves meet selves, on the owner's device: inviting another vault (by the
// vault code its owner handed over), answering an invite, the turns the AI self
// takes while the vault is open, and the transcript, opened with the key only
// the two vaults can derive.

import {
  AAD,
  cleanRules,
  decryptJson,
  encryptJson,
  meetKey,
  meetTurn,
  openAnswer,
  openInvite,
  openMeetMessage,
  parseVaultCode,
  randomId,
  sealAnswer,
  sealInvite,
  sealMeetMessage,
  turnOf,
  type BoxKeyPair,
  type MeetPurpose,
  type ModelCaller,
  type SelfRules,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";
import { ASKED_TEXT, guardedMemories, protectedGate } from "./protectOps";

export interface ServerMeet {
  id: string;
  role: "inviter" | "invitee";
  myKey: string;
  peerKey: string;
  turnLimit: number;
  invite: string;
  answer: string | null;
  box: string | null;
  state: "invited" | "running" | "done" | "stopped" | "declined";
  turns: number;
  stoppedBy: "me" | "peer" | null;
  peerOnline: boolean;
  peerSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { turn: number; box: string; createdAt: string }[];
}

/** This side's own record of a meet, under its vault key. */
export interface MeetRecord {
  v: 1;
  /** What this owner calls the other. */
  label: string;
  /** The name this owner signs with. */
  me: string;
  /** Folders this side's AI self may use in this conversation. */
  folderIds: string[];
  /** May read calendar memories (from live sync or an import) wherever they are, protected folders aside. */
  calendar: boolean;
  /** The inviter keeps the purpose and note here: the invite itself is sealed to the other vault. */
  purpose?: MeetPurpose;
  note?: string;
}

export interface MeetLine {
  turn: number;
  mine: boolean;
  text: string;
  done: boolean;
  createdAt: string;
  /** False when the box did not open: it was not written by either vault. */
  ok: boolean;
}

export interface MeetView extends Omit<ServerMeet, "invite" | "answer" | "box" | "messages"> {
  purpose: MeetPurpose;
  note: string;
  /** The name the other side signed with. */
  peerName: string;
  record: MeetRecord | null;
  lines: MeetLine[];
  /** Whose turn is next while it runs. */
  next: "me" | "peer" | null;
}

function cleanRecord(v: unknown): MeetRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    v: 1,
    label: String(o.label ?? "").slice(0, 80) || "Another vault",
    me: String(o.me ?? "").slice(0, 80),
    folderIds: Array.isArray(o.folderIds) ? o.folderIds.map(String).slice(0, 200) : [],
    calendar: o.calendar === true,
    ...(o.purpose === "find_time" || o.purpose === "collab_fit" || o.purpose === "swap_intros" ? { purpose: o.purpose } : {}),
    ...(typeof o.note === "string" ? { note: o.note.slice(0, 400) } : {}),
  };
}

export async function openMeets(vault: Unlocked, box: BoxKeyPair | null, meets: ServerMeet[]): Promise<{ meets: MeetView[]; unreadable: number }> {
  let unreadable = 0;
  const out: MeetView[] = [];
  for (const m of meets) {
    let record: MeetRecord | null = null;
    if (m.box) {
      try {
        record = cleanRecord(await decryptJson(vault.key, m.box, AAD.meetOwner(m.id)));
      } catch {
        unreadable++;
      }
    }
    let purpose: MeetPurpose = "swap_intros";
    let note = "";
    let peerName = record?.label ?? "Another vault";
    const lines: MeetLine[] = [];
    if (box) {
      try {
        // The invite is sealed to the invitee; the inviter reads the purpose from its own record.
        if (m.role === "invitee") {
          const inv = openInvite(box, m.id, m.invite);
          purpose = inv.purpose;
          note = inv.note;
          peerName = inv.from;
        } else if (m.answer) {
          peerName = openAnswer(box, m.id, m.answer).from;
        }
      } catch {
        unreadable++;
      }
      const key = meetKey(box, m.peerKey, m.id);
      for (const msg of m.messages) {
        const mine = turnOf(msg.turn) === m.role;
        try {
          const opened = openMeetMessage(key, { meetId: m.id, turn: msg.turn, from: mine ? m.myKey : m.peerKey }, msg.box);
          lines.push({ turn: msg.turn, mine, text: opened.text, done: opened.done, createdAt: msg.createdAt, ok: true });
        } catch {
          lines.push({ turn: msg.turn, mine, text: "", done: false, createdAt: msg.createdAt, ok: false });
        }
      }
    }
    if (m.role === "inviter" && record?.purpose) purpose = record.purpose;
    if (m.role === "inviter" && record?.note) note = record.note;
    const { invite: _i, answer: _a, box: _b, messages: _m, ...rest } = m;
    out.push({
      ...rest,
      purpose,
      note,
      peerName,
      record,
      lines,
      next: m.state === "running" ? ((m.turns % 2 === 0 ? "inviter" : "invitee") === m.role ? "me" : "peer") : null,
    });
  }
  return { meets: out, unreadable };
}

// ---------------------------------------------------------------- invite, accept, stop

export interface InviteInput {
  code: string;
  purpose: MeetPurpose;
  note: string;
  label: string;
  me: string;
  folderIds: string[];
  calendar: boolean;
  turnLimit: number;
}

export async function inviteSelf(api: Api, vault: Unlocked, input: InviteInput): Promise<string> {
  const peerKey = parseVaultCode(input.code);
  const id = randomId();
  const record = cleanRecord({ ...input, note: input.note.trim() })!;
  await api.post("meets", {
    id,
    toKey: peerKey,
    invite: sealInvite(peerKey, id, { v: 1, purpose: input.purpose, note: input.note, from: input.me, turnLimit: input.turnLimit }),
    box: await encryptJson(vault.key, record, AAD.meetOwner(id)),
    turnLimit: input.turnLimit,
  });
  return id;
}

export async function acceptMeet(api: Api, vault: Unlocked, meet: MeetView, input: { label: string; me: string; folderIds: string[]; calendar: boolean }): Promise<void> {
  const record = cleanRecord(input)!;
  await api.post(`meets/${meet.id}/accept`, {
    answer: sealAnswer(meet.peerKey, meet.id, { v: 1, from: input.me }),
    box: await encryptJson(vault.key, record, AAD.meetOwner(meet.id)),
  });
}

export async function declineMeet(api: Api, id: string): Promise<void> {
  await api.post(`meets/${id}/decline`);
}

export async function stopMeet(api: Api, id: string): Promise<void> {
  await api.post(`meets/${id}/stop`);
}

export async function removeMeet(api: Api, id: string): Promise<void> {
  await api.del(`meets/${id}`);
}

// ---------------------------------------------------------------- taking a turn

/**
 * The memories this side's self may use in one meet: the chosen folders, and
 * calendar memories wherever they are when the owner allowed it (shown to the
 * model as one Calendar folder). Protected folders only with the owner's yes.
 */
export function meetMemories(data: Pick<VaultData, "memories" | "folders">, record: MeetRecord, open: Set<string> = new Set()) {
  const calendarIds = new Set(data.memories.filter((m) => m.source.kind === "calendar").map((m) => m.id));
  return guardedMemories(data, open).flatMap((m) =>
    record.folderIds.includes(m.folderId) ? [m] : record.calendar && calendarIds.has(m.id) ? [{ ...m, folderId: CALENDAR, folder: "Calendar" }] : [],
  );
}

const CALENDAR = "calendar";

export function meetRules(data: Pick<VaultData, "self">, record: MeetRecord): SelfRules {
  // The AI self's own rules (tone, topics, what it never says) with the folders chosen for this meet.
  return cleanRules({ ...(data.self ?? {}), folderIds: [...record.folderIds, ...(record.calendar ? [CALENDAR] : [])] });
}

export interface ComposedTurn {
  turn: number;
  text: string;
  done: boolean;
  cited: number;
}

/** Writes this side's turn with the owner's own model, without sending it. Null when it is not this side's turn. */
export async function composeTurn(api: Api, data: VaultData, meet: MeetView, deps: { model: ModelCaller }): Promise<ComposedTurn | null> {
  if (meet.state !== "running" || meet.next !== "me" || !meet.record) return null;
  const rules = meetRules(data, meet.record);
  const last = [...meet.lines].reverse().find((l) => !l.mine)?.text ?? meet.note;
  const gate = await protectedGate(api, data, { ...rules, folderIds: meet.record.folderIds }, last, { id: meet.id, kind: "meet" });
  const memories = [...meetMemories(data, meet.record), ...gate.extra];
  const turn = meet.turns + 1;
  const out = await meetTurn({
    rules,
    purpose: meet.purpose,
    note: meet.note,
    me: meet.record.me || "my owner",
    peer: meet.peerName,
    transcript: meet.lines.filter((l) => l.ok).map((l) => ({ mine: l.mine, text: l.text })),
    memories,
    model: deps.model,
    turn,
    turnLimit: meet.turnLimit,
  });
  if (gate.extra.length) await gate.use(gate.extra.map((m) => m.id));
  return { turn, text: gate.asked.length ? `${out.text}\n\n${ASKED_TEXT}` : out.text, done: out.done, cited: out.citations.length };
}

/** Seals a turn under the meet key, which only the two vaults can derive, and sends it. */
export async function sendTurn(api: Api, meet: Pick<MeetView, "id" | "peerKey" | "myKey">, box: BoxKeyPair, t: ComposedTurn): Promise<void> {
  const key = meetKey(box, meet.peerKey, meet.id);
  await api.post(`meets/${meet.id}/turns`, {
    turn: t.turn,
    box: sealMeetMessage(key, { meetId: meet.id, turn: t.turn, from: meet.myKey }, { v: 1, text: t.text, done: t.done }),
    done: t.done,
    cited: t.cited,
  });
}

/** Takes this side's turn: written by the owner's own model on this device, sealed under the meet key. */
export async function takeTurn(api: Api, data: VaultData, meet: MeetView, deps: { model: ModelCaller; box: BoxKeyPair }): Promise<void> {
  const t = await composeTurn(api, data, meet, deps);
  if (t) await sendTurn(api, meet, deps.box, t);
}

/** The conversations waiting for this vault's turn, opened here. Also tells the server this vault is here. */
export async function waitingMeets(api: Api, vault: Unlocked, box: BoxKeyPair): Promise<MeetView[]> {
  const { meets } = await api.get<{ meets: ServerMeet[] }>("meets/waiting");
  if (!meets.length) return [];
  return (await openMeets(vault, box, meets)).meets;
}

/** One round: says this vault is here, and takes every turn that waits for it. */
export async function meetOnce(api: Api, vault: Unlocked, data: VaultData, deps: { model: ModelCaller | null }): Promise<number> {
  const { meets } = await api.get<{ meets: ServerMeet[] }>("meets/waiting");
  if (!meets.length || !deps.model || !data.box) return 0;
  const { meets: views } = await openMeets(vault, data.box, meets);
  let n = 0;
  for (const m of views) {
    try {
      await takeTurn(api, data, m, { model: deps.model, box: data.box });
      n++;
    } catch {
      // The other side stopped it, or the turn was taken meanwhile. The next round looks again.
    }
  }
  return n;
}
