// Moving a vault between two nodes, each with its own database, talking to
// each other through the test: the owner signs the move on the old node, the
// new node fetches the bundle with the move code, the owner opens it there and
// signs the arrival, and the old node sends the vault's links on and deletes
// it when the period ends. Every step is in the log of the node it happened on.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanRules, formatMoveCode, parseMoveCode, sha256Hex, signMove, vaultSigningKey } from "@sigil/core";
import { count, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as nodes from "../src/vault/nodeOps";
import * as storage from "../src/vault/storageOps";
import * as selfOps from "../src/vault/selfOps";
import { handleApi } from "../src/server/api";
import { moveTick, setNodeFetch } from "../src/server/nodes";

const OLD = "https://old.example";
const NEW = "https://new.example";
let oldNode: Harness;
let newNode: Harness;
let reachable = true;
/** The old node stops answering the "done" call, as if it were down at the moment of the move. */
let doneDown = false;

beforeEach(() => {
  oldNode = harness(OLD);
  newNode = harness(NEW);
  reachable = true;
  doneDown = false;
  // The two nodes reach each other through the test; nothing else is reachable.
  setNodeFetch(async (input, init) => {
    const url = new URL(input);
    const node = url.origin === OLD ? oldNode : url.origin === NEW ? newNode : null;
    if (!node || !reachable || (doneDown && url.pathname.endsWith("/done"))) throw new Error("unreachable");
    return handleApi(new Request(url, init as RequestInit), url.pathname.replace(/^\/api\//, "").split("/"), node.db);
  });
});

afterEach(() => setNodeFetch(null));

async function owner() {
  const o = await signedUp(oldNode);
  const notes = o.data.folders[0];
  await ops.createMemory(o.b.api, notes, { title: "Parking", body: "Level 3." });
  const data = await ops.loadVault(o.b.api, o.vault);
  const link = await selfOps.createLink(
    o.b.api,
    o.vault,
    data,
    { label: "Friends", name: "Sam", greeting: "Hi", rules: cleanRules({ folderIds: [notes.id] }), expiresInDays: 7, maxUses: 10, perHour: 5, appId: null },
    OLD,
  );
  // An app reads, so the vault has a log to carry.
  const app = await ops.connectApp(o.b.api, o.vault, { name: "Claude", kind: "claude-desktop" }, [notes]);
  await readerFor(oldNode, app.appKey, {}, OLD).search("parking");
  return { ...o, link, app };
}

describe("moving a vault", () => {
  it("goes from one node to another, and the old node sends links on, then deletes it", async () => {
    const o = await owner();
    const started = await nodes.startMove(o.b.api, o.vault, OLD, NEW, 7);
    expect(started.url).toBe(`${NEW}/vault/restore#move=${started.code}`);
    expect(parseMoveCode(started.code)).toMatchObject({ from: OLD, id: started.id });
    let data = await ops.loadVault(o.b.api, o.vault);
    expect(data.nodes.moves[0]).toMatchObject({ id: started.id, to: NEW, state: "signed" });

    // On the new node: the code fetches the move; the owner signs in with the bundle's own key slot.
    const b = newNode.browser();
    const got = await nodes.fetchArrival(b.api, started.code);
    expect(got.move.statement).toMatchObject({ from: OLD, to: NEW, redirectDays: 7 });
    const arrived = await nodes.arrive(b.api, started.code, got.move, got.bundle, { kind: "phrase", phrase: o.phrase }, NEW);
    expect(arrived.result.confirmed).toBe(true);
    const there = await ops.loadVault(b.api, arrived.opened.vault);
    expect(there.memories.map((m) => m.title)).toContain("Parking");
    expect(there.nodes.here).toBe(NEW);
    expect(there.nodes.nodes).toEqual([expect.objectContaining({ origin: OLD, role: "previous", state: "confirmed", moveId: started.id })]);
    const newLog = await ops.loadLog(b.api, 1000);
    expect(newLog.entries.filter((e) => e.kind === "node").map((e) => e.memoryId)).toEqual(expect.arrayContaining([`arrived-${started.id}`, `confirmed-${started.id}`, `restored-${got.bundle.hash}`]));
    // The log from before the move came along in the bundle, with its proofs.
    expect(newLog.entries.some((e) => e.carried)).toBe(true);

    // The old node: the move is done, sessions ended, sign-ins and app keys told where the vault went.
    const oldLog = (oldNode.db.prepare("SELECT memory_id FROM read_log WHERE kind = 'node' ORDER BY at").all() as { memory_id: string }[]).map((r) => r.memory_id);
    expect(oldLog).toEqual([`move-signed-${started.id}`, `bundle-sent-${started.id}`, `moved-${started.id}`]);
    await expect(o.b.api.get("vault")).rejects.toMatchObject({ status: 401 });
    await expect(ops.signInWithPhrase(oldNode.browser().api, o.phrase)).rejects.toMatchObject({ status: 410, code: "moved" });
    await expect(ops.signInWithWallet(oldNode.browser().api, o.w.address, o.w.signature)).rejects.toMatchObject({ status: 410, code: "moved" });
    const res = await oldNode.raw("GET", `ask/${o.link.link.id}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "moved", to: NEW });
    // On the new node the same link is there, with the same key in its fragment.
    expect((await newNode.raw("GET", `ask/${o.link.link.id}`)).status).toBe(200);

    // When the period is over, the old node deletes the vault and stops sending links on.
    expect(moveTick(oldNode.db, new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(moveTick(oldNode.db, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect(count(oldNode.db, "SELECT COUNT(*) AS n FROM users")).toBe(0);
    expect(count(oldNode.db, "SELECT COUNT(*) AS n FROM memories")).toBe(0);
    expect(count(oldNode.db, "SELECT COUNT(*) AS n FROM moved")).toBe(0);
    data = await ops.loadVault(b.api, arrived.opened.vault);
    expect(data.memories.map((m) => m.title)).toContain("Parking");
  });

  it("keeps the app keys working on the new node and tells them, on the old one, where the vault went", async () => {
    const o = await owner();
    const app = o.app;
    const started = await nodes.startMove(o.b.api, o.vault, OLD, NEW, 30);
    const b = newNode.browser();
    const got = await nodes.fetchArrival(b.api, started.code);
    await nodes.arrive(b.api, started.code, got.move, got.bundle, { kind: "wallet", address: o.w.address, signature: o.w.signature }, NEW);
    await expect(readerFor(oldNode, app.appKey, {}, OLD).search("parking")).rejects.toMatchObject({ code: "moved" });
    expect((await readerFor(newNode, app.appKey, {}, NEW).search("parking")).map((x) => x.title)).toEqual(["Parking"]);
  });

  it("is told to the old node again later when it could not be reached", async () => {
    const o = await owner();
    const started = await nodes.startMove(o.b.api, o.vault, OLD, NEW, 30);
    const b = newNode.browser();
    const got = await nodes.fetchArrival(b.api, started.code);
    doneDown = true;
    const arrived = await nodes.arrive(b.api, started.code, got.move, got.bundle, { kind: "phrase", phrase: o.phrase }, NEW);
    expect(arrived.result.confirmed).toBe(false);
    let data = await ops.loadVault(b.api, arrived.opened.vault);
    const row = data.nodes.nodes[0];
    expect(row).toMatchObject({ origin: OLD, state: "waiting" });
    // Until the old node is told, it still holds the vault as it was.
    expect(count(oldNode.db, "SELECT COUNT(*) AS n FROM moved")).toBe(0);
    doneDown = false;
    expect(await nodes.notifyOldNode(b.api, row.id)).toBe(true);
    data = await ops.loadVault(b.api, arrived.opened.vault);
    expect(data.nodes.nodes[0].state).toBe("confirmed");
    expect(count(oldNode.db, "SELECT COUNT(*) AS n FROM moved WHERE kind = 'vault'")).toBe(1);
  });

  it("refuses a move that is not the vault's, not for this node, cancelled, or fetched without its secret", async () => {
    const o = await owner();
    const key = await vaultSigningKey(o.vault.raw);
    const bundle = await storage.makeBundle(o.b.api, o.vault);
    const other = await vaultSigningKey(new Uint8Array(32).fill(7));
    const forged = signMove(other, { id: "move-0000001", from: OLD, to: NEW, bundle: bundle.hash, redirectDays: 30, issuedAt: new Date().toISOString() });
    await expect(o.b.api.post("nodes/moves", { move: forged, secretHash: sha256Hex("x"), bundle })).rejects.toMatchObject({ code: "bad_move" });
    const elsewhere = signMove(key, { id: "move-0000002", from: "https://third.example", to: NEW, bundle: bundle.hash, redirectDays: 30, issuedAt: new Date().toISOString() });
    await expect(o.b.api.post("nodes/moves", { move: elsewhere, secretHash: sha256Hex("x"), bundle })).rejects.toMatchObject({ code: "bad_move" });

    const started = await nodes.startMove(o.b.api, o.vault, OLD, NEW, 30);
    await expect(nodes.startMove(o.b.api, o.vault, OLD, NEW, 30)).rejects.toThrow(/already under way/);
    // Without the secret, or with the wrong one, the old node gives nothing.
    expect((await oldNode.raw("GET", `nodes/moves/${started.id}`)).status).toBe(401);
    expect((await oldNode.raw("GET", `nodes/moves/${started.id}`, { headers: { authorization: `Bearer ${"A".repeat(43)}` } })).status).toBe(404);
    // A code for this node does not move a vault here.
    await expect(nodes.fetchArrival(o.b.api, started.code)).rejects.toMatchObject({ code: "bad_code" });
    // A third node is not the one named.
    const third = harness("https://third.example");
    await expect(nodes.fetchArrival(third.browser().api, started.code)).rejects.toMatchObject({ code: "wrong_node" });
    // Cancelled: the code opens nothing.
    await nodes.cancelMove(o.b.api, started.id);
    await expect(nodes.fetchArrival(newNode.browser().api, started.code)).rejects.toMatchObject({ code: "move_unavailable" });
    const code = formatMoveCode({ from: "http://10.0.0.1", id: started.id, secret: "A".repeat(43) });
    await expect(nodes.fetchArrival(newNode.browser().api, code)).rejects.toThrow();
  });
});

describe("a node's health", () => {
  it("names the node, its version and the open standard it follows", async () => {
    const res = await newNode.raw("GET", "health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, node: { origin: NEW, spec: "1.2.0" } });
  });
});
