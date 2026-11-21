// The connector against a live node, as an MCP client sees it: list folders,
// search, read one memory, quoted as data. Needs an app key made in the vault.
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ask, bad, baseUrl, done, ok } from "./lib";

const base = baseUrl(await ask("SIGIL_URL", "Address of the node (https://...)"));
const key = await ask("SIGIL_APP_KEY", "App key from the vault (Apps)", { secret: true });
const query = (await ask("SIGIL_CHECK_QUERY", "A word to search for", { optional: true })) || "the";
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("connector/dist/index.js")], env: { ...(process.env as Record<string, string>), SIGIL_APP_KEY: key, SIGIL_URL: base }, stderr: "pipe" });
const client = new Client({ name: "sigil-live-check", version: "1.0.0" });
await client.connect(transport);
const text = (r: unknown) => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  tools.includes("search_memories") ? ok("tools", tools.join(", ")) : bad("tools", tools.join(", "));
  ok("list_folders", text(await client.callTool({ name: "list_folders", arguments: {} })).split("\n")[0]);
  const found = text(await client.callTool({ name: "search_memories", arguments: { query } }));
  ok("search_memories", found.split("\n")[0]);
  const id = /\b([A-Za-z0-9_-]{16,64})\b/.exec(found)?.[1];
  if (id) {
    const read = text(await client.callTool({ name: "read_memory", arguments: { id } }));
    read.includes("BEGIN UNTRUSTED") || read.includes("held back") ? ok("read_memory, quoted as data") : bad("read_memory", "the text is not quoted");
  }
} catch (err) {
  bad("connector", (err as Error).message);
} finally {
  await client.close();
}
done();
