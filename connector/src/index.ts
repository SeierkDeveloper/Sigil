// sigil-connector: lets Claude Desktop, Cursor, ChatGPT and other MCP clients
// read the parts of a Sigil vault the user shared with them.
//
//   SIGIL_APP_KEY  the app key from the vault's Apps page (required)
//   SIGIL_URL      the Sigil site the vault lives on (required)
//   SIGIL_SEMANTIC        search by meaning on this machine (on by default)
//   SIGIL_EMBED_MODEL     the sentence model (default Xenova/all-MiniLM-L6-v2)
//   SIGIL_MODEL_DIR       where its files are kept
//   SIGIL_MODEL_FETCH     fetch missing model files once (on by default)
//
//   sigil-connector                 stdio, for Claude Desktop, Cursor and most clients
//   sigil-connector --http          a local HTTP endpoint, for clients that need a URL
//       --port 8787 --host 127.0.0.1
//       SIGIL_HTTP_TOKEN            secret path segment (a random one is made if unset)
//   sigil-connector --self          answer the ask links the owner gave this app,
//                                   on this machine, while it runs
//   sigil-connector --watch [dir]   keep live sync sources (Gmail, Calendar, Drive,
//                                   Slack) the owner gave this app in sync, back the
//                                   vault up when the owner allowed it, and an
//                                   Obsidian vault through the inbox when a folder is named

import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { isLoopbackHost, isSafeBaseUrl, samePath } from "./net";
import { connectOnThisComputer } from "./connect";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VaultReader } from "./reader";
import { embedSettings, loadEmbedder } from "./embed";
import { CONNECTOR_VERSION, createServer } from "./server";
import { SelfAgent } from "./self";
import { ObsidianWatcher } from "./watch";
import { BackupWorker } from "./backup";
import { AgentMemory } from "./agent";
import { SyncWorker } from "./sync";
import { ActingClient } from "./acting";

function fail(message: string): never {
  process.stderr.write(`sigil-connector: ${message}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function help(): never {
  process.stdout.write(
    [
      `sigil-connector ${CONNECTOR_VERSION}`,
      "",
      "Reads your Sigil vault for MCP clients, suggests memories to its inbox, and lets an AI app ask before it acts for you. Decrypts and encrypts on this machine.",
      "",
      "Environment:",
      "  SIGIL_APP_KEY   app key from your vault (Apps, Connect an app)",
      "  SIGIL_URL       address of the Sigil site your vault is on",
      "  SIGIL_SEMANTIC  off to search by words only (default on)",
      "  SIGIL_MODEL_DIR where the search model is kept",
      "",
      "Usage:",
      "  sigil-connector                      run over stdio (Claude Desktop, Cursor)",
      "  sigil-connector --http [--port N]    serve http://127.0.0.1:N/mcp/<token>",
      "  sigil-connector --self               answer your ask links on this machine",
      "  sigil-connector --watch              keep the live sync sources you gave this app in sync, and back the vault up if you allowed it",
      "  sigil-connector --watch <folder>     also suggest new and changed Obsidian notes to the inbox",
      "  sigil-connector connect --source ID  sign a live sync source in on this computer (Slack, or Google when its",
      "                                       client needs a secret: set SIGIL_SLACK_CLIENT_ID and SIGIL_SLACK_CLIENT_SECRET",
      "                                       or SIGIL_GOOGLE_CLIENT_ID and SIGIL_GOOGLE_CLIENT_SECRET here; never sent to Sigil)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) help();
  if (process.argv.includes("--version")) {
    process.stdout.write(`${CONNECTOR_VERSION}\n`);
    process.exit(0);
  }

  const appKey = process.env.SIGIL_APP_KEY?.trim();
  const baseUrl = process.env.SIGIL_URL?.trim();
  if (!appKey) fail("SIGIL_APP_KEY is not set. Create an app key in your Sigil vault under Apps.");
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) fail("SIGIL_URL is not set. Use the address of the Sigil site your vault is on.");
  // The app key's token travels with every request: https only, plain http only to this machine.
  if (!isSafeBaseUrl(baseUrl)) fail("SIGIL_URL must start with https:// (plain http is allowed only for localhost).");

  let reader: VaultReader;
  try {
    const settings = embedSettings();
    reader = new VaultReader({
      appKey,
      baseUrl,
      userAgent: `sigil-connector/${CONNECTOR_VERSION}`,
      via: "mcp",
      embedder: settings ? () => loadEmbedder(settings) : undefined,
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const self = new SelfAgent(reader);

  // Signs a live sync source in on this computer, for a provider that wants a client secret.
  if (process.argv[2] === "connect") {
    const sourceId = arg("--source");
    if (!sourceId || !/^[A-Za-z0-9_-]{8,64}$/.test(sourceId)) fail("Name the source: sigil-connector connect --source <id> (the vault shows the whole command under Sync).");
    const port = Number(arg("--port") ?? 0);
    try {
      const r = await connectOnThisComputer(reader, {
        sourceId,
        port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0,
        show: (url) => process.stderr.write(`Open this address in your browser and sign in:\n\n  ${url}\n\nWaiting for the sign-in (stop with Ctrl+C)...\n`),
      });
      process.stderr.write(`Signed in${r.account ? ` to ${r.account}` : ""}. Run sigil-connector --watch to keep it in sync.\n`);
      process.exit(0);
    } catch (err) {
      fail((err as Error).message);
    }
  }

  if (process.argv.includes("--self")) {
    process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} answering ask links (stop with Ctrl+C)\n`);
    const stop = new AbortController();
    process.on("SIGINT", () => stop.abort());
    process.on("SIGTERM", () => stop.abort());
    let last = "";
    await self.run({
      signal: stop.signal,
      onError: (err) => {
        if (err.message !== last) process.stderr.write(`sigil-connector: ${err.message}\n`);
        last = err.message;
      },
    });
    return;
  }

  if (process.argv.includes("--watch")) {
    const next = arg("--watch");
    const watchDir = next && !next.startsWith("--") ? next : undefined;
    const log = (l: string) => process.stderr.write(`sigil-connector: ${l}\n`);
    const stop = new AbortController();
    let watcher: ObsidianWatcher | null = null;
    if (watchDir) {
      try {
        watcher = new ObsidianWatcher(reader, watchDir, { folder: arg("--folder") ?? "Obsidian", log });
      } catch (err) {
        fail((err as Error).message);
      }
      watcher.start();
      process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} watching ${watchDir} (stop with Ctrl+C)\n`);
    }
    const worker = new SyncWorker(reader);
    let sources = 0;
    try {
      sources = (await worker.sources()).length;
    } catch (err) {
      log(`live sync is not available for this key: ${(err as Error).message}`);
    }
    if (sources) {
      process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} keeping ${sources} live sync ${sources === 1 ? "source" : "sources"} in sync (stop with Ctrl+C)\n`);
      const minutes = Number(process.env.SIGIL_SYNC_MINUTES);
      void worker.run({
        everyMs: (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 5) * 60_000,
        signal: stop.signal,
        onReport: (reports) => {
          for (const r of reports) log(r.error ? `${r.kind}: ${r.error}` : `${r.kind}: ${r.added} new, ${r.updated} changed, ${r.removed} removed`);
        },
        onError: (err) => log(err.message),
      });
    }
    // Backups while it watches, when the owner let this app back the vault up.
    const backups = new BackupWorker(reader);
    const backingUp = await backups.allowed();
    if (backingUp) {
      process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} backing the vault up on the schedule set in the vault (stop with Ctrl+C)\n`);
      void backups.run({
        signal: stop.signal,
        onReport: (r) => log(`backup ${r.hash.slice(0, 18)}...: ${r.places.length} stored${r.failed.length ? `, ${r.failed.length} failed (${r.failed.map((f) => `${f.label}: ${f.reason}`).join("; ")})` : ""}`),
        onError: (err) => log(`backup: ${err.message}`),
      });
    }
    if (!sources && !watchDir && !backingUp) {
      fail("This app has no live sync sources, no backups and no folder was named. Allow background sync under Sync or backups under Storage in the vault, or name an Obsidian folder.");
    }
    const end = () => {
      watcher?.stop();
      stop.abort();
      process.exit(0);
    };
    process.on("SIGINT", end);
    process.on("SIGTERM", end);
    return;
  }

  // An agent key gets its own memory tools as well. A key that is not an agent's works as before.
  let isAgent = false;
  try {
    isAgent = !!(await AgentMemory.detect(reader));
  } catch (err) {
    process.stderr.write(`sigil-connector: could not check whether this key is an agent's: ${(err as Error).message}\n`);
  }
  // Acting within the owner's thresholds: the tools are always there; the server refuses them until the owner allows this app under Limits.
  const acting = new ActingClient(reader);
  const serve = () => {
    const agent = isAgent ? new AgentMemory(reader) : undefined;
    const server = createServer(reader, self, agent, acting);
    if (agent) agent.name = () => server.server.getClientVersion()?.name?.slice(0, 80) || "An agent";
    return server;
  };

  if (!process.argv.includes("--http")) {
    const server = serve();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} ready (stdio)\n`);
    return;
  }

  const port = Number(arg("--port") ?? 8787);
  const host = arg("--host") ?? "127.0.0.1";
  // Plain HTTP with the key's reads behind it: only on this machine unless the owner says otherwise.
  if (!isLoopbackHost(host) && !process.argv.includes("--allow-network")) {
    fail(`--host ${host} would serve plain HTTP to the network. Use 127.0.0.1, or add --allow-network and put TLS in front of it.`);
  }
  const given = process.env.SIGIL_HTTP_TOKEN?.trim();
  const token = given || randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) fail("SIGIL_HTTP_TOKEN must be 16 to 128 letters, digits, - or _.");
  const path = `/mcp/${token}`;

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!samePath(url.pathname, path)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    try {
      // Stateless: a fresh server and transport per request, nothing kept in memory.
      const server = serve();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: (err as Error).message }, id: null }));
    }
  });
  http.listen(port, host, () => {
    // A token the owner set is not printed again (logs of MCP clients keep what is written here).
    const shown = given ? `/mcp/<SIGIL_HTTP_TOKEN>` : path;
    process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} listening on http://${host}:${port}${shown}\n`);
    process.stderr.write("Keep this address private: anyone who has it can read what this app key can read.\n");
  });
}

main().catch((err) => fail((err as Error).message));
