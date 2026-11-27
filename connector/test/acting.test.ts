import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_VERSION, createServer, formatCheck, formatNegotiation, formatStatus, type Reader } from "../src/server";
import { ReaderError } from "../src/reader";
import type { ActingTools, CheckInput, NegotiateInput } from "../src/acting";

const reader: Reader = {
  listFolders: async () => [],
  search: async () => [],
  read: async (ids) => ({ memories: [], missing: ids }),
  profile: async () => null,
  propose: async () => ({ id: "prop12345678" }),
};

function stub(overrides: Partial<ActingTools> = {}): ActingTools & { checked: CheckInput[]; negotiated: NegotiateInput[]; reported: string[] } {
  const checked: CheckInput[] = [];
  const negotiated: NegotiateInput[] = [];
  const reported: string[] = [];
  return {
    checked,
    negotiated,
    reported,
    summary: async () => ["Mail: it may reply to sam lee about questions, up to 3 a day. Everything else waits for the owner."],
    check: async (i) => (checked.push(i), i.who.includes("stranger") ? { verdict: "needs-approval", id: "step-000000002", reason: "The other person is not one of the senders you listed." } : { verdict: "allowed", id: "step-000000001", limit: "Mail on its own" }),
    status: async (id) => (id === "step-000000002" ? { state: "approved", next: "Owner's own words." } : { state: "waiting" }),
    report: async (i) => (reported.push(`${i.id}:${i.what}`), { receiptId: "rcpt-00000001", leaf: `0x${"ab".repeat(32)}` }),
    negotiate: async (i) => (negotiated.push(i), { id: "step-000000003", state: "allowed", step: { move: "counter", offer: { kind: "price", price: "1050", unit: "EUR" }, say: "I can do 1050 EUR.", reason: "Inside your range.", range: "Consulting day" } }),
    ...overrides,
  };
}

async function connect(acting: ActingTools) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(reader, undefined, undefined, acting).connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("the tools for acting", () => {
  it("are four, marked as what they are, and the instructions say to ask first", async () => {
    const client = await connect(stub());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["get_thresholds", "check_action", "report_action", "negotiate"]) expect(names).toContain(n);
    expect(tools.find((t) => t.name === "get_thresholds")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "check_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(client.getInstructions()).toContain("call check_action");
    expect(CONNECTOR_VERSION).toBe("0.6.0");
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(CONNECTOR_VERSION);
  });

  it("read the thresholds, check before acting, and report afterwards", async () => {
    const tools = stub();
    const client = await connect(tools);
    expect(textOf(await client.callTool({ name: "get_thresholds", arguments: {} }))).toContain("- Mail: it may reply to sam lee");
    const ok = textOf(await client.callTool({ name: "check_action", arguments: { area: "mail", action: "reply", who: "Sam <sam@example.org>", subject: "Lunch", text: "Free?", kinds: ["question"] } }));
    expect(ok).toContain("allowed: you may go ahead");
    expect(ok).toContain("Step id: step-000000001");
    expect(tools.checked[0]).toMatchObject({ area: "mail", action: "reply", kinds: ["question"] });
    const held = textOf(await client.callTool({ name: "check_action", arguments: { area: "mail", action: "reply", who: "stranger@else.example" } }));
    expect(held).toContain("needs-approval: The other person is not one of the senders you listed.");
    expect(held).toContain("Do not act yet.");
    expect(textOf(await client.callTool({ name: "check_action", arguments: { id: "step-000000002" } }))).toContain("Send exactly this:\n\nOwner's own words.");
    expect(textOf(await client.callTool({ name: "check_action", arguments: { id: "step-000000009" } }))).toContain("still waits");
    const done = textOf(await client.callTool({ name: "report_action", arguments: { id: "step-000000001", what: "Replied to Sam" } }));
    expect(done).toContain("Kept a signed receipt (rcpt-00000001)");
    expect(tools.reported).toEqual(["step-000000001:Replied to Sam"]);
  });

  it("refuse a check that does not say what it is, and a mail action on an invite", async () => {
    const client = await connect(stub());
    const r = await client.callTool({ name: "check_action", arguments: { area: "mail", who: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Give area, action and who");
    const mixed = await client.callTool({ name: "check_action", arguments: { area: "calendar", action: "reply", who: "x" } });
    expect(textOf(mixed)).toContain("calendar takes accept, decline or propose");
  });

  it("take a step of a negotiation", async () => {
    const tools = stub();
    const client = await connect(tools);
    const t = textOf(await client.callTool({ name: "negotiate", arguments: { kind: "price", topic: "Consulting day", who: "Kim", theirs: { price: "900" }, round: 0 } }));
    expect(t).toContain("counter: Inside your range.");
    expect(t).toContain("Offer: 1050 EUR");
    expect(t).toContain("Say: I can do 1050 EUR.");
    expect(tools.negotiated[0]).toMatchObject({ kind: "price", theirs: { price: "900" } });
  });

  it("say in fixed words when the user has not let this app act", async () => {
    const client = await connect(stub({ summary: async () => Promise.reject(new ReaderError("forbidden", 403, "acting_off", true)) }));
    const r = await client.callTool({ name: "get_thresholds", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("The user has not let this app act for them. They can allow it in their Sigil vault, under Limits.");
  });

  it("word every answer so an app knows what to do", () => {
    expect(formatCheck({ verdict: "refused", id: "s1", reason: "It names a word you never touch." })).toContain("Do not act on this, and do not ask again.");
    expect(formatStatus("s1", { state: "declined" })).toBe("declined: the user said no. Do not act on this.");
    expect(formatStatus("s1", { state: "approved", next: null })).toContain("Go ahead as you asked");
    expect(
      formatNegotiation({ id: "s2", state: "waiting", step: { move: "ask", offer: { kind: "price", price: "800", unit: "EUR" }, say: "I can do 800 EUR.", reason: "At the edge of your range.", range: "Consulting day" } }),
    ).toContain('What it would say next: "I can do 800 EUR."');
  });
});
