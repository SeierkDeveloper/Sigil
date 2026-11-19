// sigil-connector: lets Claude Desktop, Cursor, ChatGPT and other MCP clients
// read the parts of a Sigil vault the user shared with them.
//
//   SIGIL_APP_KEY  the app key from the vault's Apps page (required)
//   SIGIL_URL      the Sigil site the vault lives on (required)
//
//   sigil-connector                 stdio, for Claude Desktop, Cursor and most clients
//   sigil-connector --http          a local HTTP endpoint, for clients that need a URL
//       --port 8787 --host 127.0.0.1
//       SIGIL_HTTP_TOKEN            secret path segment (a random one is made if unset)

import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VaultReader } from "./reader";
import { CONNECTOR_VERSION, createServer } from "./server";

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
      "Reads your Sigil vault for MCP clients. Decrypts on this machine.",
      "",
      "Environment:",
      "  SIGIL_APP_KEY   app key from your vault (Apps, Connect an app)",
      "  SIGIL_URL       address of the Sigil site your vault is on",
      "",
      "Usage:",
      "  sigil-connector                      run over stdio (Claude Desktop, Cursor)",
      "  sigil-connector --http [--port N]    serve http://127.0.0.1:N/mcp/<token>",
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

  let reader: VaultReader;
  try {
    reader = new VaultReader({ appKey, baseUrl, userAgent: `sigil-connector/${CONNECTOR_VERSION}` });
  } catch (err) {
    fail((err as Error).message);
  }

  if (!process.argv.includes("--http")) {
    const server = createServer(reader);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} ready (stdio)\n`);
    return;
  }

  const port = Number(arg("--port") ?? 8787);
  const host = arg("--host") ?? "127.0.0.1";
  const token = process.env.SIGIL_HTTP_TOKEN?.trim() || randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) fail("SIGIL_HTTP_TOKEN must be 16 to 128 letters, digits, - or _.");
  const path = `/mcp/${token}`;

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    try {
      // Stateless: a fresh server and transport per request, nothing kept in memory.
      const server = createServer(reader);
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
    process.stderr.write(`sigil-connector ${CONNECTOR_VERSION} listening on http://${host}:${port}${path}\n`);
    process.stderr.write("Keep this address private: anyone who has it can read what this app key can read.\n");
  });
}

main().catch((err) => fail((err as Error).message));
