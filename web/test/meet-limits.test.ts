// Meetings as a limit for acting: a time agreed with another self is sent on
// its own, with a receipt, only when it falls in the owner's free hours; any
// other agreement waits in Work, even when the owner does not hold turns.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanRules, formatVaultCode, type ModelCaller } from "@sigil/core";
import { harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import * as meet from "../src/vault/meetOps";
import * as work from "../src/vault/workOps";
import * as limits from "../src/vault/limitsOps";
import * as receipts from "../src/vault/receiptOps";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const say = (text: string): ModelCaller => ({ provider: "anthropic", model: "claude-opus-5-5", complete: async () => text });

async function owner(name: string) {
  const s = await signedUp(h);
  await self.saveRules(s.b.api, s.vault, cleanRules({ name: `${name}'s AI self` }));
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, name, data, code: formatVaultCode(data.boxPublic!) };
}

/** Sam invites Robin to find a time; Robin's self answers the first turn with `robinSays`, under Robin's limits. */
async function meeting(robinSays: string) {
  const sam = await owner("Sam");
  const robin = await owner("Robin");
  await meet.inviteSelf(sam.b.api, sam.vault, { code: robin.code, purpose: "find_time", note: "30 minutes", label: "Robin", me: "Sam", folderIds: [], calendar: false, turnLimit: 4 });
  let r = await ops.loadVault(robin.b.api, robin.vault);
  await meet.acceptMeet(robin.b.api, robin.vault, r.meets[0], { label: "Sam", me: "Robin", folderIds: [], calendar: false });
  const s = await ops.loadVault(sam.b.api, sam.vault);
  expect(await meet.meetOnce(sam.b.api, sam.vault, s, { model: say("Does Monday morning work?") })).toBe(1);
  await limits.saveLimits(robin.b.api, robin.vault, { v: 1, payments: { on: false, maxPerPayment: "" }, replies: { on: false, contacts: [] }, meetings: { on: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timeZone: "UTC" } });
  r = await ops.loadVault(robin.b.api, robin.vault);
  expect(r.work.holdMeets).toBe(false);
  const made = await work.holdMeetsOnce(robin.b.api, robin.vault, r, r.drafts, { model: say(robinSays) });
  return { robin, made, after: await ops.loadVault(robin.b.api, robin.vault) };
}

describe("meetings within limits", () => {
  it("are agreed and sent on their own in free hours, with a receipt", async () => {
    // Monday 6 January 2031, 10:00 UTC.
    const { robin, made, after } = await meeting("Monday 2031-01-06 10:00 works for Robin. [done]");
    expect(made).toHaveLength(1);
    expect(made[0].state).toBe("approved");
    expect(made[0].record?.auto?.limit).toBe("Meetings in free hours (Mondays 09:00 to 17:00, UTC)");
    expect(after.meets[0].turns).toBe(2);
    const list = await receipts.loadReceipts(robin.b.api, robin.vault);
    expect(list[0].receipt?.body).toMatchObject({ kind: "agreement", what: "Agreed a meeting with Sam on 2031-01-06 10:00 UTC" });
  });

  it("wait for the owner outside free hours, even when turns are not held", async () => {
    const { robin, made, after } = await meeting("Saturday 2031-01-04 10:00 works for Robin. [done]");
    expect(made).toHaveLength(1);
    expect(made[0].state).toBe("waiting");
    expect(made[0].record?.title).toContain("That day is not one of your free days.");
    expect(after.meets[0].turns).toBe(1);
    expect(await receipts.loadReceipts(robin.b.api, robin.vault)).toEqual([]);
  });

  it("go on as before while nothing is agreed yet", async () => {
    const { made, after } = await meeting("Which day suits you?");
    expect(made).toEqual([]);
    expect(after.meets[0].turns).toBe(2);
  });
});
