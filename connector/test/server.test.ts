import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, formatProfile, formatResults, type Reader } from "../src/server";
import { ReaderError } from "../src/reader";

const memory = {
  id: "mem12345678",
  title: "Launch plan",
  folder: "Work",
  tags: ["work"],
  source: "Written in Sigil",
  createdAt: "2026-01-01T00:00:00.000Z",
  editedAt: "2026-01-02T00:00:00.000Z",
  body: "Ship on a Tuesday.",
};

function stub(overrides: Partial<Reader> = {}): Reader {
  return {
    listFolders: async () => [{ id: "f1", name: "Work", memories: 1 }],
    search: async () => [{ id: memory.id, title: memory.title, folder: "Work", tags: ["work"], snippet: "Ship on a Tuesday.", editedAt: memory.editedAt }],
    read: async (ids) => (ids.includes(memory.id) ? { memories: [memory], missing: [] } : { memories: [], missing: ids }),
    profile: async () => ({ ...memory, id: "card12345678", title: "Self card", body: "## Who I am\n\nA sailor." }),
    propose: async () => ({ id: "prop12345678" }),
    ...overrides,
  };
}

async function connect(reader: Reader) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(reader).connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("MCP server", () => {
  it("offers four read-only tools and one that only suggests", async () => {
    const client = await connect(stub());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_profile", "list_folders", "propose_memory", "read_memory", "search_memories"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort()).toEqual(["get_profile", "list_folders", "read_memory", "search_memories"]);
    const propose = tools.find((t) => t.name === "propose_memory")!;
    expect(propose.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(propose.description).toContain("only if the user approves");
    expect(client.getInstructions()).toContain("read log");
  });

  it("reads the Self card, and says how to share it when it cannot", async () => {
    const client = await connect(stub());
    expect(textOf(await client.callTool({ name: "get_profile", arguments: {} }))).toContain("A sailor.");
    const none = await connect(stub({ profile: async () => null }));
    expect(textOf(await none.callTool({ name: "get_profile", arguments: {} }))).toBe(formatProfile(null));
  });

  it("suggests a memory and passes the reason through when suggestions are off", async () => {
    const seen: unknown[] = [];
    const client = await connect(stub({ propose: async (d) => (seen.push(d), { id: "prop12345678" }) }));
    const ok = await client.callTool({ name: "propose_memory", arguments: { title: "Prefers tea", body: "Green, no sugar.", tags: ["food"], folder: "Notes" } });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain("only if they approve it");
    expect(seen).toEqual([{ title: "Prefers tea", body: "Green, no sugar.", tags: ["food"], folder: "Notes" }]);

    const off = new ReaderError("This app may not suggest memories.", 403, "propose_off");
    const blocked = await connect(stub({ propose: async () => Promise.reject(off) }));
    const r = await blocked.callTool({ name: "propose_memory", arguments: { title: "x", body: "y" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("may not suggest");
    expect((await client.callTool({ name: "propose_memory", arguments: { title: "", body: "y" } })).isError).toBe(true);
  });

  it("marks results found by meaning", () => {
    const out = formatResults("automobile", [{ id: "a1234567", title: "My car", folder: "Notes", tags: [], snippet: "garage", editedAt: memory.editedAt, match: "meaning" }]);
    expect(out).toContain("matched by meaning");
  });

  it("lists folders, searches and reads", async () => {
    const client = await connect(stub());
    expect(textOf(await client.callTool({ name: "list_folders", arguments: {} }))).toContain("- Work (1 memory)");
    const found = textOf(await client.callTool({ name: "search_memories", arguments: { query: "launch" } }));
    expect(found).toContain('1 memory matches "launch"');
    expect(found).toContain(`id: ${memory.id}`);
    const read = textOf(await client.callTool({ name: "read_memory", arguments: { id: memory.id } }));
    expect(read).toContain("# Launch plan");
    expect(read).toContain("Ship on a Tuesday.");
  });

  it("says so when a memory is not readable", async () => {
    const client = await connect(stub());
    const r = await client.callTool({ name: "read_memory", arguments: { id: "otherid12345" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not allowed");
  });

  it("passes the revoke message through as a tool error", async () => {
    const revoked = new ReaderError("This app key was revoked or does not exist.", 401, "app_revoked");
    const client = await connect(stub({ search: async () => Promise.reject(revoked) }));
    const r = await client.callTool({ name: "search_memories", arguments: { query: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("revoked");
  });

  it("rejects bad arguments", async () => {
    const client = await connect(stub());
    const r = await client.callTool({ name: "read_memory", arguments: { id: "../../etc" } });
    expect(r.isError).toBe(true);
  });

  it("formats empty results helpfully", () => {
    expect(formatResults("", [])).toContain("no memories");
    expect(formatResults("zebra", [])).toBe('No memories match "zebra".');
  });
});
