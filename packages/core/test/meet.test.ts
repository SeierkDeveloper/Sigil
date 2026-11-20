import { describe, expect, it } from "vitest";
import {
  cleanRules,
  DecryptError,
  encodeBoxPublicKey,
  meetKey,
  meetTurn,
  newBoxKeyPair,
  openAnswer,
  openInvite,
  openMeetMessage,
  sealAnswer,
  sealInvite,
  sealMeetMessage,
  turnOf,
  type ModelCaller,
  type ModelRequest,
} from "../src";

const A = newBoxKeyPair();
const B = newBoxKeyPair();
const C = newBoxKeyPair();
const pub = (p: typeof A) => encodeBoxPublicKey(p.publicKey);

describe("selves meet: sealing", () => {
  it("seals the invite and the answer so only the other vault opens them", () => {
    const sealed = sealInvite(pub(B), "meet-0001", { v: 1, purpose: "find_time", note: "CANARY-30 minutes next week", from: "Sam", turnLimit: 6 });
    expect(sealed).not.toContain("CANARY");
    expect(openInvite(B, "meet-0001", sealed)).toMatchObject({ purpose: "find_time", note: "CANARY-30 minutes next week", from: "Sam", turnLimit: 6 });
    expect(() => openInvite(C, "meet-0001", sealed)).toThrow(DecryptError);
    expect(() => openInvite(B, "meet-0002", sealed)).toThrow(DecryptError);
    const answer = sealAnswer(pub(A), "meet-0001", { v: 1, from: "Robin" });
    expect(openAnswer(A, "meet-0001", answer).from).toBe("Robin");
  });

  it("gives both vaults the same conversation key, and no one else", () => {
    const ka = meetKey(A, pub(B), "meet-0001");
    const kb = meetKey(B, pub(A), "meet-0001");
    expect(ka).toEqual(kb);
    expect(meetKey(C, pub(A), "meet-0001")).not.toEqual(ka);
    expect(meetKey(A, pub(B), "meet-0002")).not.toEqual(ka);
  });

  it("binds each message to its meet, turn and sender", () => {
    const key = meetKey(A, pub(B), "meet-0001");
    const box = sealMeetMessage(key, { meetId: "meet-0001", turn: 1, from: pub(A) }, { v: 1, text: "CANARY-hello", done: false });
    expect(box).not.toContain("CANARY");
    const theirs = meetKey(B, pub(A), "meet-0001");
    expect(openMeetMessage(theirs, { meetId: "meet-0001", turn: 1, from: pub(A) }, box)).toEqual({ v: 1, text: "CANARY-hello", done: false });
    expect(() => openMeetMessage(theirs, { meetId: "meet-0001", turn: 3, from: pub(A) }, box)).toThrow(DecryptError);
    expect(() => openMeetMessage(theirs, { meetId: "meet-0001", turn: 1, from: pub(B) }, box)).toThrow(DecryptError);
    // A third key (what a relaying server could make) cannot write a message that opens.
    const forged = sealMeetMessage(meetKey(C, pub(B), "meet-0001"), { meetId: "meet-0001", turn: 1, from: pub(A) }, { v: 1, text: "forged", done: false });
    expect(() => openMeetMessage(theirs, { meetId: "meet-0001", turn: 1, from: pub(A) }, forged)).toThrow(DecryptError);
    expect(turnOf(1)).toBe("inviter");
    expect(turnOf(2)).toBe("invitee");
  });
});

function stub(answer: string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), answer) };
  return { model, calls };
}

describe("selves meet: a turn", () => {
  const rules = cleanRules({ name: "Sam's AI self", folderIds: ["cal"], denyTopics: ["salary"], neverSay: ["CANARY-secret"] });
  const memories = [
    { id: "m1", folderId: "cal", folder: "Calendar", title: "Dentist", tags: ["calendar"], body: "When: 2026-11-24 10:00 to 11:00", editedAt: "2026-11-01T00:00:00.000Z" },
    { id: "m2", folderId: "health", folder: "Health", title: "Blood test", tags: [], body: "CANARY-health", editedAt: "2026-11-01T00:00:00.000Z" },
  ];

  it("writes from the meet's folders only, follows the purpose and marks done", async () => {
    const { model, calls } = stub("Tuesday at 14:00 works for Sam. [done]");
    const out = await meetTurn({ rules, purpose: "find_time", note: "30 minutes", me: "Sam", peer: "Robin", transcript: [{ mine: false, text: "When are you free for a calendar slot?" }], memories, model, turn: 2, turnLimit: 6 });
    expect(out).toMatchObject({ text: "Tuesday at 14:00 works for Sam.", done: true, refused: null });
    expect(calls[0].system).toContain("Find a time to meet");
    expect(calls[0].system).not.toContain("CANARY-health");
    expect(calls[0].messages[0]).toEqual({ role: "user", content: "When are you free for a calendar slot?" });
  });

  it("refuses a denied topic without the model, and withholds what it must never say", async () => {
    const a = stub("unused");
    const refused = await meetTurn({ rules, purpose: "collab_fit", note: "", me: "Sam", peer: "Robin", transcript: [{ mine: false, text: "What is your salary?" }], memories, model: a.model, turn: 2, turnLimit: 6 });
    expect(refused.refused).toBe("denied_topic");
    expect(a.calls).toHaveLength(0);
    const b = stub("Sure, CANARY-secret.");
    const blocked = await meetTurn({ rules, purpose: "collab_fit", note: "", me: "Sam", peer: "Robin", transcript: [], memories, model: b.model, turn: 1, turnLimit: 6 });
    expect(blocked.refused).toBe("never_say");
    expect(blocked.text).not.toContain("CANARY");
    expect(b.calls[0].messages).toEqual([{ role: "user", content: "Start the conversation." }]);
  });

  it("ends at the turn limit", async () => {
    const { model } = stub("Still talking.");
    const out = await meetTurn({ rules, purpose: "swap_intros", note: "", me: "Sam", peer: "Robin", transcript: [{ mine: false, text: "Hi" }], memories, model, turn: 4, turnLimit: 4 });
    expect(out.done).toBe(true);
  });
});
