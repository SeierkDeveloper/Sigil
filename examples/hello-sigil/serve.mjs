// Serves the example on 127.0.0.1, with the SDK from packages/sdk/dist:
//   npm run build -w @sigil/sdk && node examples/hello-sigil/serve.mjs
// then open http://127.0.0.1:5180 (PORT changes the port).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = {
  "/": [path.join(here, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(here, "app.js"), "text/javascript; charset=utf-8"],
  "/sigil.js": [path.resolve(here, "../../packages/sdk/dist/sigil.js"), "text/javascript; charset=utf-8"],
};

export function startExample(port = 5180) {
  const server = createServer(async (req, res) => {
    const file = files[new URL(req.url ?? "/", "http://x").pathname];
    if (!file) return res.writeHead(404).end("Not found");
    try {
      res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" }).end(await readFile(file[0]));
    } catch {
      res.writeHead(500).end("Build the SDK first: npm run build -w @sigil/sdk");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5180;
  await startExample(port);
  console.log(`Hello Sigil on http://127.0.0.1:${port}`);
}
