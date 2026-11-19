import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, formatResults, type Reader } from "../src/server";
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
  it("offers three read-only tools", async () => {
    const client = await connect(stub());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_folders", "read_memory", "search_memories"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toContain("read log");
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
