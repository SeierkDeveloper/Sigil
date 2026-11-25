// Holder tiers through the real router: a wallet links by signing once, the
// tier follows the balance on chain, included answers count per day and fall
// back to memories when used, public pages show the tier and never the wallet,
// short handles are for Wardens, Wardens' reads are anchored, limits follow the
// tier, and the read log can be saved with its proofs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ModelCaller, ModelRequest } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as holderOps from "../src/vault/holderOps";
import { setAnchorSender, setAnswerModel, setBalanceReader, holderTick, wardenAnchorTick, tierFor } from "../src/server/holders";

const CANARY = "CANARY-included-question-4m";
let h: Harness;
const balances = new Map<string, number>();
const asked: ModelRequest[] = [];

beforeEach(() => {
  h = harness();
  balances.clear();
  asked.length = 0;
  setBalanceReader(async (a) => balances.get(a.toLowerCase()) ?? 0);
  setAnswerModel(
    (): ModelCaller => ({
      provider: "anthropic",
      model: "stand-in",
      async complete(req) {
        asked.push(req);
        return "You walked the coast path with Ada in April [1].";
      },
    }),
  );
  setAnchorSender(undefined);
});
afterEach(() => {
  setBalanceReader(null);
  setAnswerModel(null);
  setAnchorSender(undefined);
});

async function holder(tokens: number) {
  const s = await signedUp(h);
  const account = privateKeyToAccount(generatePrivateKey());
  balances.set(account.address.toLowerCase(), tokens);
  const { challengeId, message } = await s.b.api.post<{ challengeId: string; message: string }>("holder/challenge", { address: account.address });
  const signature = await account.signMessage({ message });
  const status = await s.b.api.post<ops.HolderView>("holder/link", { challengeId, address: account.address, signature });
  const userId = String((h.db.prepare("SELECT user_id FROM holder_links WHERE address = ?").get(account.address.toLowerCase()) as { user_id: string }).user_id);
  return { ...s, account, status, userId };
}

describe("holder tiers", () => {
  it("gives each tier from the balance", () => {
    expect(tierFor(999_999)).toBeNull();
    expect(tierFor(1_000_000)).toBe("bearer");
    expect(tierFor(5_000_000)).toBe("keeper");
    expect(tierFor(10_000_000)).toBe("warden");
  });

  it("links a wallet by one signature and reads its tier", async () => {
    const s = await holder(5_200_000);
    expect(s.status).toMatchObject({ linked: true, tier: "keeper", answersPerDay: 30, answersUsedToday: 0, includedOn: false });
    expect(s.status.address).toBe(s.account.address.toLowerCase());
    // The vault itself carries it.
    expect((await ops.loadVault(s.b.api, s.vault)).holder).toMatchObject({ tier: "keeper" });
  });

  it("refuses a signature from another wallet and a wallet linked to another vault", async () => {
    const s = await signedUp(h);
    const mine = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const { challengeId, message } = await s.b.api.post<{ challengeId: string; message: string }>("holder/challenge", { address: mine.address });
    await expect(s.b.api.post("holder/link", { challengeId, address: mine.address, signature: await other.signMessage({ message }) })).rejects.toMatchObject({ code: "bad_signature" });

    const first = await holder(2_000_000);
    const second = await signedUp(h);
    const c = await second.b.api.post<{ challengeId: string; message: string }>("holder/challenge", { address: first.account.address });
    await expect(second.b.api.post("holder/link", { challengeId: c.challengeId, address: first.account.address, signature: await first.account.signMessage({ message: c.message }) })).rejects.toMatchObject({
      code: "wallet_taken",
    });
  });

  it("follows the balance down and up on the daily read", async () => {
    const s = await holder(10_500_000);
    expect(s.status.tier).toBe("warden");
    balances.set(s.account.address.toLowerCase(), 400_000);
    expect(await holderTick(h.db, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    expect((await holderOps.loadHolder(s.b.api)).tier).toBeNull();
    balances.set(s.account.address.toLowerCase(), 1_100_000);
    expect((await holderOps.refreshHolder(s.b.api)).tier).toBe("bearer");
    expect((await holderOps.unlinkWallet(s.b.api)).linked).toBe(false);
  });
});

describe("included answers", () => {
  beforeEach(() => {
    process.env.SIGIL_ANSWERS_KEY = "sk-ant-test-included";
  });
  afterEach(() => {
    delete process.env.SIGIL_ANSWERS_KEY;
  });

  it("answer a holder without a key of their own, count per day, and keep nothing of the question", async () => {
    const s = await holder(1_000_000);
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.holder?.includedOn).toBe(true);
    expect(holderOps.includedAvailable(data)).toBe(true);
    const caller = holderOps.answerCaller(data, s.b.api)!;
    expect(caller.model).toBe(holderOps.INCLUDED_MODEL);
    const text = await caller.complete({ system: "Answer from the memories.", messages: [{ role: "user", content: `Where did we walk? ${CANARY}` }] });
    expect(text).toContain("coast path");
    expect(asked[0].messages[0].content).toContain(CANARY);
    expect((await holderOps.loadHolder(s.b.api)).answersUsedToday).toBe(1);
    // Nothing of the question is written anywhere on the node.
    expect(dumpDb(h.db)).not.toContain(CANARY);
  });

  it("say plainly when the day's answers are used, and never go past them", async () => {
    const s = await holder(1_500_000);
    const day = new Date().toISOString().slice(0, 10);
    h.db.prepare("INSERT INTO holder_answers (user_id, day, used) VALUES (?, ?, 10)").run(s.userId, day);
    const caller = holderOps.answerCaller(await ops.loadVault(s.b.api, s.vault), s.b.api)!;
    await expect(caller.complete({ system: "s", messages: [{ role: "user", content: "q" }] })).rejects.toBeInstanceOf(holderOps.AnswersUsed);
    expect(asked).toHaveLength(0);
  });

  it("are not for someone below the first tier, and an own key comes first", async () => {
    const s = await holder(10);
    await expect(s.b.api.post("holder/answer", { system: "s", messages: [{ role: "user", content: "q" }] })).rejects.toMatchObject({ code: "not_holder" });
    const withKey = { model: { provider: "anthropic" as const, model: "claude-opus-5-5", apiKey: "sk-ant-own-0123456789" }, holder: { ...s.status, tier: "warden" as const, includedOn: true } };
    expect(holderOps.answerCaller(withKey, s.b.api)!.model).toBe("claude-opus-5-5");
  });

  it("show nothing when the node offers no included answers", async () => {
    delete process.env.SIGIL_ANSWERS_KEY;
    const s = await holder(3_000_000);
    expect(holderOps.includedAvailable(await ops.loadVault(s.b.api, s.vault))).toBe(false);
  });
});

describe("what holders get beyond answers", () => {
  it("shows the tier on the public page, never the wallet or the balance", async () => {
    const s = await holder(6_000_000);
    h.db
      .prepare(
        "INSERT INTO public_selves (id, user_id, handle, name, greeting, public_key, owner_box, per_visitor_hour, show_answers, enabled, voice, created_at, updated_at) VALUES ('pubself1', ?, 'adaself', 'Ada', 'hi', 'pk', 'box', 5, 0, 1, 0, '', '')",
      )
      .run(s.userId);
    const page = await h.browser().api.get<Record<string, unknown>>("public/at/adaself");
    expect(page.holder).toBe("keeper");
    expect(JSON.stringify(page)).not.toContain(s.account.address.toLowerCase());
    expect(JSON.stringify(page)).not.toContain("6000000");
  });

  it("keeps 3 and 4 letter handles for Wardens", async () => {
    const { savePublicSelf } = await import("../src/server/public");
    const input = (handle: string, id: string) => ({ id, handle, name: "Max", greeting: "", publicKey: `pk-${id}`, ownerBox: "box", appId: null, appBox: null, perVisitorHour: 5, showAnswers: false, enabled: true, voice: false });
    const keeper = await holder(5_000_000);
    expect(() => savePublicSelf(h.db, keeper.userId, input("max", "selfkeep1"))).toThrow(/Warden/);
    savePublicSelf(h.db, keeper.userId, input("maxwell", "selfkeep1"));
    const warden = await holder(12_000_000);
    savePublicSelf(h.db, warden.userId, input("max", "selfward1"));
    expect((h.db.prepare("SELECT handle FROM public_selves WHERE user_id = ?").get(warden.userId) as { handle: string }).handle).toBe("max");
  });

  it("anchors each Warden's reads of the day before in one transaction", async () => {
    const w = await holder(11_000_000);
    const b = await holder(2_000_000);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const leaf = (n: number) => "0x" + n.toString(16).padStart(64, "0");
    for (const [u, n] of [
      [w.userId, 1],
      [w.userId, 2],
      [b.userId, 3],
    ] as const) {
      h.db.prepare("INSERT INTO read_log (id, user_id, app_id, kind, memory_id, count, at, salt, leaf, hour, sealed) VALUES (?, ?, 'app1', 'read', NULL, 1, ?, 's', ?, 0, 1)").run(`l${n}`, u, yesterday, leaf(n));
    }
    const sent: string[] = [];
    setAnchorSender(async (data) => {
      sent.push(data);
      return "0xabc123";
    });
    expect(await wardenAnchorTick(h.db)).toBe("0xabc123");
    expect(sent).toHaveLength(1);
    const status = await holderOps.loadHolder(w.b.api);
    expect(status.anchors).toEqual([expect.objectContaining({ leaves: 2, tx: "0xabc123" })]);
    expect(sent[0]).toContain(status.anchors[0].root.slice(2));
    // A Bearer's reads are not anchored, and the same day is never sent twice.
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM warden_anchors").get() as { n: number }).n)).toBe(1);
    expect(await wardenAnchorTick(h.db)).toBeNull();
  });

  it("lets apps check the tier by a pass code or, when allowed, the wallet, and nothing else", async () => {
    const s = await holder(6_000_000);
    const app = h.browser();
    // No pass yet: nothing can be checked, by code or by wallet.
    expect(await app.api.get(`pass/${s.account.address}`)).toEqual({ pass: "sigil", holder: false, tier: null, rank: 0, checkedAt: null });
    const { code, status } = await holderOps.makePass(s.b.api);
    expect(code).toMatch(/^sp_[A-Za-z0-9_-]{24}$/);
    expect(status.pass).toMatchObject({ byWallet: false, checks: 0 });
    const r = await app.api.get<Record<string, unknown>>(`pass/${code}`);
    expect(r).toMatchObject({ pass: "sigil", holder: true, tier: "keeper", rank: 2 });
    expect(JSON.stringify(r)).not.toContain(s.account.address.toLowerCase());
    // The code itself is never kept.
    expect(dumpDb(h.db)).not.toContain(code);
    // By wallet only once the holder turns it on.
    expect((await app.api.get<{ holder: boolean }>(`pass/${s.account.address}`)).holder).toBe(false);
    await holderOps.passByWallet(s.b.api, true);
    expect(await app.api.get(`pass/${s.account.address}`)).toMatchObject({ holder: true, tier: "keeper", rank: 2 });
    expect((await holderOps.loadHolder(s.b.api)).pass?.checks).toBe(2);
    // A new code ends the old one; ending the pass ends every check.
    const second = await holderOps.makePass(s.b.api);
    expect((await app.api.get<{ holder: boolean }>(`pass/${code}`)).holder).toBe(false);
    expect((await app.api.get<{ holder: boolean }>(`pass/${second.code}`)).holder).toBe(true);
    await holderOps.endPass(s.b.api);
    expect((await app.api.get<{ holder: boolean }>(`pass/${second.code}`)).holder).toBe(false);
    expect((await app.api.get<{ holder: boolean }>(`pass/${s.account.address}`)).holder).toBe(false);
  });

  it("answers holder false below the first tier and ends the pass with the wallet link", async () => {
    const s = await holder(300_000);
    const { code } = await holderOps.makePass(s.b.api);
    expect(await h.browser().api.get(`pass/${code}`)).toMatchObject({ holder: false, tier: null, rank: 0 });
    await holderOps.unlinkWallet(s.b.api);
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM holder_pass").get() as { n: number }).n)).toBe(0);
    const bare = await signedUp(h);
    await expect(holderOps.makePass(bare.b.api)).rejects.toMatchObject({ code: "not_linked" });
  });

  it("saves the whole read log with every seal proof", async () => {
    const s = await signedUp(h);
    const file = await s.b.api.get<{ kind: string; entries: { proof: unknown }[] }>("log/export");
    expect(file.kind).toBe("sigil-read-log");
    expect(Array.isArray(file.entries)).toBe(true);
  });
});
