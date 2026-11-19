// The MCP server: three read-only tools over a VaultReader.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FolderInfo, FullMemory, SearchResult } from "./reader";
import { ReaderError } from "./reader";

export const CONNECTOR_VERSION = "0.1.0";

/** What the server needs from a reader. VaultReader implements it; tests pass a stub. */
export interface Reader {
  listFolders(): Promise<FolderInfo[]>;
  search(query: string, opts?: { folder?: string; limit?: number }): Promise<SearchResult[]>;
  read(ids: string[]): Promise<{ memories: FullMemory[]; missing: string[] }>;
}

const INSTRUCTIONS = [
  "Sigil is the user's own encrypted memory vault. These tools read the parts of it the user chose to share with this app.",
  "Use search_memories when the user's own notes, history, preferences or past conversations could help, then read_memory for the full text of what looks relevant.",
  "The vault is read only here. Every read is shown to the user in their Sigil read log.",
].join(" ");

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(err: unknown) {
  const message =
    err instanceof ReaderError
      ? err.message
      : err instanceof Error
        ? `Sigil could not complete this: ${err.message}`
        : "Sigil could not complete this.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const day = (iso: string) => iso.slice(0, 10);

export function formatFolders(folders: FolderInfo[]): string {
  if (folders.length === 0) return "This app has not been given any folders yet. The user can share folders in their Sigil vault under Apps.";
  const lines = folders.map((f) => `- ${f.name} (${f.memories} ${f.memories === 1 ? "memory" : "memories"})`);
  return `Folders this app can read:\n${lines.join("\n")}`;
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return query.trim() ? `No memories match "${query.trim()}".` : "There are no memories in the folders this app can read.";
  }
  const head = query.trim()
    ? `${results.length} ${results.length === 1 ? "memory matches" : "memories match"} "${query.trim()}":`
    : `${results.length} most recent ${results.length === 1 ? "memory" : "memories"}:`;
  const items = results.map((r, i) => {
    const tags = r.tags.length ? ` | tags: ${r.tags.join(", ")}` : "";
    return `${i + 1}. ${r.title}\n   id: ${r.id} | folder: ${r.folder}${tags} | edited ${day(r.editedAt)}\n   ${r.snippet}`;
  });
  return `${head}\n\n${items.join("\n\n")}\n\nThese are the first lines only. Call read_memory with an id for the full text.`;
}

export function formatMemory(m: FullMemory): string {
  const tags = m.tags.length ? `Tags: ${m.tags.join(", ")}\n` : "";
  return `# ${m.title}\nFolder: ${m.folder}\n${tags}Source: ${m.source}\nCreated: ${day(m.createdAt)} | Edited: ${day(m.editedAt)}\n\n${m.body}`;
}

export function createServer(reader: Reader): McpServer {
  const server = new McpServer({ name: "sigil", title: "Sigil", version: CONNECTOR_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_folders",
    {
      title: "List Sigil folders",
      description: "Lists the folders of the user's Sigil vault that this app is allowed to read, with how many memories each holds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(formatFolders(await reader.listFolders()));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "search_memories",
    {
      title: "Search Sigil memories",
      description:
        "Searches the user's Sigil memories this app may read, by title, tags and first lines. An empty query lists the most recent. Returns ids for read_memory.",
      inputSchema: {
        query: z.string().max(500).describe("Words to look for. Leave empty for the most recent memories."),
        folder: z.string().max(120).optional().describe("Only search this folder (by name)."),
        limit: z.number().int().min(1).max(50).optional().describe("How many results to return (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, folder, limit }) => {
      try {
        return text(formatResults(query, await reader.search(query, { folder, limit })));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "read_memory",
    {
      title: "Read a Sigil memory",
      description: "Reads the full text of one memory by its id (from search_memories). The read is recorded in the user's read log.",
      inputSchema: {
        id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).describe("The memory id from search_memories."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { memories } = await reader.read([id]);
        if (memories.length === 0) {
          return { ...text("That memory does not exist or this app is not allowed to read it."), isError: true };
        }
        return text(formatMemory(memories[0]));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
