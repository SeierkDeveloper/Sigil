// The MCP server: four tools that read the parts of the vault this app was
// given, one that suggests a memory to the owner's inbox, and one that asks the
// owner's AI self (when the owner allowed this app to answer as it).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_MINUTES, type HeldRead, type ProposalDraft, type SelfAnswer } from "@sigil/core";
import type { FolderInfo, FullMemory, SearchResult } from "./reader";
import { ReaderError } from "./reader";
import type { AgentTools, PickedNote, RecallHit } from "./agent";

export const CONNECTOR_VERSION = "0.4.0";

/** What the server needs from a reader. VaultReader implements it; tests pass a stub. */
export interface Reader {
  listFolders(): Promise<FolderInfo[]>;
  search(query: string, opts?: { folder?: string; limit?: number }): Promise<SearchResult[]>;
  read(ids: string[]): Promise<{ memories: FullMemory[]; missing: string[]; held?: HeldRead[] }>;
  profile(): Promise<FullMemory | null>;
  propose(draft: ProposalDraft): Promise<{ id: string }>;
  /** Protected folders the last search left out, and reads it held back. */
  lastSkipped?: string[];
  lastHeld?: HeldRead[];
}

/** The AI self on this machine. SelfAgent implements it; tests pass a stub. */
export interface SelfAsker {
  ask(question: string): Promise<SelfAnswer>;
}

const INSTRUCTIONS = [
  "Sigil is the user's own encrypted memory vault. These tools read the parts of it the user chose to share with this app.",
  "Call get_profile first for who the user is and how they like answers.",
  "Use search_memories when the user's own notes, history, preferences or past conversations could help; it matches by meaning as well as by words. Then read_memory for the full text of what looks relevant.",
  "When the user shares something worth remembering, propose_memory suggests it to their Sigil inbox; it becomes a memory only if they approve it.",
  "ask_self answers a question the way the user would, from their memories and within rules they wrote, when they allowed this app to.",
  "Every read and every suggestion is shown to the user in their Sigil read log.",
  "Folders the user protected (health, money, legal) are never searched or read without the user's yes for that read: naming one asks the user in their Sigil inbox, and the same call works once they say yes.",
].join(" ");

const AGENT_INSTRUCTIONS = [
  "This key belongs to an agent with its own memory in the user's Sigil vault.",
  "At the start of a session call pick_up_handoffs for notes an earlier session or another agent left.",
  "Use recall before you start on something you may have worked on before, remember for what the next session should know, and leave_handoff before you stop.",
  "forget deletes memories for good, only in folders this agent may write.",
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
  const lines = folders.map((f) => `- ${f.name} (${f.memories} ${f.memories === 1 ? "memory" : "memories"}${f.protected ? ", protected: each read needs the user's yes" : ""})`);
  return `Folders this app can read:\n${lines.join("\n")}`;
}

/** What to tell the app about protected folders after a search or a read. */
export function formatProtected(skipped: string[] | undefined, held: HeldRead[] | undefined): string {
  const parts: string[] = [];
  for (const h of held ?? []) {
    parts.push(
      h.state === "denied"
        ? `The user said no to reading ${h.folder}.`
        : `${h.folder === "a protected folder" ? "A memory asked for is in a protected folder" : `${h.folder} is a protected folder`}. The user has been asked in their Sigil inbox to allow this read. Once they say yes, make the same call again within ${APPROVAL_MINUTES} minutes; the yes covers that one read.`,
    );
  }
  if (skipped?.length) parts.push(`Protected folders not searched: ${skipped.join(", ")}. To look in one, search again with folder set to its name; the user is asked first.`);
  return parts.join("\n");
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
    const how = r.match === "meaning" ? " | matched by meaning" : "";
    return `${i + 1}. ${r.title}\n   id: ${r.id} | folder: ${r.folder}${tags} | edited ${day(r.editedAt)}${how}\n   ${r.snippet}`;
  });
  return `${head}\n\n${items.join("\n\n")}\n\nThese are the first lines only. Call read_memory with an id for the full text.`;
}

export function formatMemory(m: FullMemory): string {
  const tags = m.tags.length ? `Tags: ${m.tags.join(", ")}\n` : "";
  return `# ${m.title}\nFolder: ${m.folder}\n${tags}Source: ${m.source}\nCreated: ${day(m.createdAt)} | Edited: ${day(m.editedAt)}\n\n${m.body}`;
}

export function formatProfile(m: FullMemory | null): string {
  if (!m) {
    return "This app cannot read a Self card. The user can write one in their Sigil vault and give this app the Self card folder under Apps.";
  }
  return `# Self card\nEdited: ${day(m.editedAt)}\n\n${m.body}`;
}

export function formatSelfAnswer(a: SelfAnswer): string {
  const sources = a.citations.length ? `\n\nFrom: ${a.citations.map((c) => `${c.title} (${c.folder})`).join("; ")}` : "";
  const why =
    a.refused === "denied_topic" || a.refused === "off_topic"
      ? "\n\n(The user's rules for their AI self do not allow this topic.)"
      : a.refused === "never_say"
        ? "\n\n(The answer was withheld by the user's rules.)"
        : a.refused === "unknown"
          ? "\n\n(Nothing in the memories it may use answers this.)"
          : "";
  return `${a.text}${sources}${why}`;
}

export function formatRecall(query: string, hits: RecallHit[]): string {
  if (hits.length === 0) return query.trim() ? `Nothing this agent may read matches "${query.trim()}".` : "There is nothing in this agent's memory yet.";
  return hits
    .map((h, i) => {
      const tags = h.tags.length ? ` | tags: ${h.tags.join(", ")}` : "";
      return `${i + 1}. ${h.title}\n   id: ${h.id} | in ${h.where}${tags} | edited ${day(h.editedAt)}\n\n${h.body}`;
    })
    .join("\n\n---\n\n");
}

export function formatHandoffs(notes: PickedNote[]): string {
  if (notes.length === 0) return "No handoff notes are waiting.";
  return notes
    .map((n) => {
      const where = n.space ? ` in the space ${n.space}` : "";
      const to = n.to ? `, for ${n.to}` : "";
      return `From ${n.from}${where}${to}, ${day(n.createdAt)}:\n${n.text}`;
    })
    .join("\n\n---\n\n");
}

export function createServer(reader: Reader, self?: SelfAsker, agent?: AgentTools): McpServer {
  const server = new McpServer({ name: "sigil", title: "Sigil", version: CONNECTOR_VERSION }, { instructions: agent ? `${INSTRUCTIONS} ${AGENT_INSTRUCTIONS}` : INSTRUCTIONS });

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
        "Searches the user's Sigil memories this app may read, by meaning and by words in titles, tags and first lines. An empty query lists the most recent. Returns ids for read_memory.",
      inputSchema: {
        query: z.string().max(500).describe("Words to look for. Leave empty for the most recent memories."),
        folder: z.string().max(120).optional().describe("Only search this folder (by name)."),
        limit: z.number().int().min(1).max(50).optional().describe("How many results to return (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, folder, limit }) => {
      try {
        const results = await reader.search(query, { folder, limit });
        const note = formatProtected(reader.lastSkipped, reader.lastHeld);
        if (results.length === 0 && reader.lastHeld?.length) return text(note);
        return text(note ? `${formatResults(query, results)}\n\n${note}` : formatResults(query, results));
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
        const { memories, held } = await reader.read([id]);
        if (memories.length === 0 && held?.length) return text(formatProtected([], held));
        if (memories.length === 0) {
          return { ...text("That memory does not exist or this app is not allowed to read it."), isError: true };
        }
        return text(formatMemory(memories[0]));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Read the Sigil Self card",
      description:
        "Reads the user's Self card: who they are, how they like answers and what they are working on. Call it first. Works only when the user gave this app the Self card folder.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(formatProfile(await reader.profile()));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "propose_memory",
    {
      title: "Suggest a memory to Sigil",
      description:
        "Suggests a new memory to the user's Sigil inbox: a fact, a preference or a decision worth keeping. It is encrypted on this machine for the user's vault only, and becomes a memory only if the user approves it. Needs the user to allow suggestions for this app.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("A short title, for example 'Prefers metric units'."),
        body: z.string().min(1).max(20_000).describe("The memory itself, in plain words."),
        tags: z.array(z.string().max(48)).max(12).optional().describe("A few tags."),
        folder: z.string().max(120).optional().describe("The folder you suggest, by name. The user decides."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, body, tags, folder }) => {
      try {
        await reader.propose({ title, body, tags, folder });
        return text(`Suggested "${title}" to the user's Sigil inbox. It becomes a memory only if they approve it.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "ask_self",
    {
      title: "Ask the user's AI self",
      description:
        "Asks the user's AI self: it answers as the user would, in the first person, only from the memories and within the rules the user set, using the user's own model key on this machine. Use it to find out what the user thinks, prefers or knows. Works only when the user allowed this app to answer as their AI self. The question and answer are recorded, sealed, in the user's read log.",
      inputSchema: {
        question: z.string().min(1).max(2000).describe("The question, as you would ask the user."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question }) => {
      if (!self) return { ...text("The AI self is not available in this connector."), isError: true };
      try {
        return text(formatSelfAnswer(await self.ask(question)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  if (agent) registerAgentTools(server, agent);

  return server;
}

function registerAgentTools(server: McpServer, agent: AgentTools): void {
  server.registerTool(
    "remember",
    {
      title: "Remember in Sigil",
      description:
        "Writes a memory to this agent's own folder in the user's Sigil vault, or to another folder or team space it may write (by name). Encrypted on this machine; the user sees it in their vault and the write in their read log.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("A short title."),
        body: z.string().min(1).max(50_000).describe("What to remember, in plain words."),
        tags: z.array(z.string().max(48)).max(12).optional().describe("A few tags."),
        folder: z.string().max(120).optional().describe("A folder or team space this agent may write, by name. Leave out for its own folder."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, body, tags, folder }) => {
      try {
        const r = await agent.remember({ title, body, tags, folder });
        return text(`Remembered "${title}" in ${r.where} (id ${r.id}).`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall from Sigil",
      description:
        "Finds what this agent remembered, and what it may read in the user's vault and its team spaces, by meaning and by words, and returns the best matches in full. Every read is in the user's read log.",
      inputSchema: {
        query: z.string().max(500).describe("What to look for. Leave empty for the most recent."),
        limit: z.number().int().min(1).max(20).optional().describe("How many to return (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        return text(formatRecall(query, await agent.recall(query, { limit })));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget in Sigil",
      description: "Deletes memories by id, for good, only in folders and spaces this agent may write, and only if the user allowed this agent to forget.",
      inputSchema: { ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)).min(1).max(50).describe("Memory ids from recall.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }) => {
      try {
        const r = await agent.forget(ids);
        const parts = [`Forgot ${r.deleted.length} ${r.deleted.length === 1 ? "memory" : "memories"}.`];
        if (r.refused.length) parts.push(`Not allowed or not found: ${r.refused.join(", ")}.`);
        return text(parts.join(" "));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "leave_handoff",
    {
      title: "Leave a handoff note",
      description:
        "Leaves an encrypted note for this agent's next session, or for the other agents in a team space. Use it before you stop: what you did, what is left, what to watch out for.",
      inputSchema: {
        text: z.string().min(1).max(20_000).describe("The note."),
        space: z.string().max(120).optional().describe("A team space, by name, to leave it for the agents there. Leave out for this agent's next session."),
        to: z.string().max(80).optional().describe("In a space, the agent it is meant for, by name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text: note, space, to }) => {
      try {
        const r = await agent.leaveHandoff({ text: note, space, to });
        return text(`Left a note for ${r.where}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "pick_up_handoffs",
    {
      title: "Pick up handoff notes",
      description: "Returns the notes an earlier session of this agent, or another agent in its team spaces, left for it, and marks them picked up.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        return text(formatHandoffs(await agent.pickUpHandoffs()));
      } catch (err) {
        return failure(err);
      }
    },
  );
}
