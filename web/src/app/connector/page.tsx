import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { buildFromSource, EXAMPLE_KEY, mcpConfig, shellCommand } from "@/lib/connector";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Connector",
  description: "The Sigil connector: a small MCP server that runs on your computer, decrypts there and gives AI apps three read-only tools.",
};

const tools = [
  {
    name: "list_folders",
    title: "List Sigil folders",
    text: "The folders this app may read, with how many memories each holds.",
    args: [] as [string, string][],
    logged: "The app listed its folders.",
    example: `Folders this app can read:
- Work (42 memories)
- Writing (17 memories)`,
  },
  {
    name: "search_memories",
    title: "Search Sigil memories",
    text: "Searches titles, tags and first lines, on your computer. An empty query lists the most recent. Returns ids for read_memory.",
    args: [
      ["query", "Words to look for, up to 500 characters. Empty for the most recent."],
      ["folder", "Optional. Only search this folder, by name."],
      ["limit", "Optional. 1 to 50 results, 10 by default."],
    ] as [string, string][],
    logged: "The app read the index of N memories. The search words are not sent.",
    example: `2 memories match "launch":

1. Launch plan
   id: 9fK2mQx7Lw3d | folder: Work | tags: work | edited 2026-11-19
   Ship on a Tuesday.

These are the first lines only. Call read_memory with an id for the full text.`,
  },
  {
    name: "read_memory",
    title: "Read a Sigil memory",
    text: "The full text of one memory, by the id from search_memories.",
    args: [["id", "The memory id."]] as [string, string][],
    logged: "The app read that memory.",
    example: `# Launch plan
Folder: Work
Tags: work
Source: Written in Sigil
Created: 2026-11-19 | Edited: 2026-11-19

Ship on a Tuesday.`,
  },
];

const settings: [string, string][] = [
  ["SIGIL_APP_KEY", "Required. The app key from your vault. It starts with sigil_app. Keep it private: it can read the folders you granted."],
  ["SIGIL_URL", `Required. The address of the Sigil site your vault lives on, for example ${site.url}.`],
  ["SIGIL_HTTP_TOKEN", "HTTP mode only. The secret last part of the address, 16 to 128 letters, digits, - or _. A random one is made when unset."],
  ["--http", "Serve over HTTP instead of stdio."],
  ["--port, --host", "HTTP mode only. Default 8787 on 127.0.0.1."],
  ["--help, --version", "Print the usage, or the version."],
];

export default function ConnectorPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Connector"
          title="One small program between your vault and every AI app"
          lead="The connector is an MCP server that runs on your own computer. It holds one app key, fetches the encrypted folders that key may read, and decrypts them locally. It keeps nothing between requests, and it cannot write."
        />

        <section className="page-section" aria-labelledby="path-title">
          <h2 id="path-title" className="section-title">
            The path of one read
          </h2>
          <ol className="flow">
            <li className="flow-step">
              <span className="flow-where">Your AI app</span>
              <p>Calls a tool, for example search_memories.</p>
            </li>
            <li className="flow-step">
              <span className="flow-where">Connector, on your computer</span>
              <p>Derives its token from the app key and asks the server for the folders this app may read.</p>
            </li>
            <li className="flow-step">
              <span className="flow-where">Sigil&apos;s server</span>
              <p>Checks the token, writes the request to your read log, and answers with ciphertext.</p>
            </li>
            <li className="flow-step">
              <span className="flow-where">Connector, on your computer</span>
              <p>Unwraps the folder keys, decrypts, searches locally and hands plain text to the app.</p>
            </li>
          </ol>
        </section>

        <section className="page-section" aria-labelledby="install-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Install</p>
              <h2 id="install-title" className="section-title">
                {site.connectorPublished ? "Nothing to install" : "Build it once from source"}
              </h2>
              <p className="section-lead">
                {site.connectorPublished
                  ? `Your AI app starts the connector with npx -y ${site.connectorPackage}. It needs Node.js 20 or newer.`
                  : "The connector is part of the Sigil repository. It needs Node.js 20 or newer. The build makes connector/dist/index.js; point your AI app at that file."}
              </p>
              <p className="muted">
                Then add it to your app. The block on the right is the form most MCP apps take; each app&apos;s exact file is on the{" "}
                <Link href="/apps">Apps</Link> page.
              </p>
            </div>
            <div className="stack">
              {site.connectorPublished ? null : <CodeBlock code={buildFromSource} label="Terminal" />}
              <CodeBlock code={mcpConfig(EXAMPLE_KEY)} label="MCP configuration" language="json" />
            </div>
          </div>
        </section>

        <section className="page-section" aria-labelledby="tools-title">
          <div className="section-header">
            <h2 id="tools-title" className="section-title">
              Three tools, all read only
            </h2>
            <p className="section-lead">
              Each is marked read only for the AI app. The answers below are the plain text an app receives, in the connector&apos;s own format.
            </p>
          </div>
          <div className="tools">
            {tools.map((t) => (
              <article key={t.name} className="tool">
                <div className="tool-main">
                  <h3 className="tool-name">
                    <code>{t.name}</code>
                  </h3>
                  <p className="tool-text">{t.text}</p>
                  {t.args.length ? (
                    <dl className="endpoint-params">
                      {t.args.map(([name, text]) => (
                        <div key={name}>
                          <dt>
                            <code>{name}</code>
                          </dt>
                          <dd>{text}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="tool-noargs">Takes no arguments.</p>
                  )}
                  <p className="tool-logged">
                    <span>In your read log</span> {t.logged}
                  </p>
                </div>
                <CodeBlock code={t.example} label="What the app receives" />
              </article>
            ))}
          </div>
        </section>

        <section className="page-section" aria-labelledby="modes-title">
          <h2 id="modes-title" className="section-title">
            Two ways to run it
          </h2>
          <div className="grid grid-2">
            <article className="card">
              <span className="card-number">Stdio</span>
              <h3 className="card-title">Started by the app</h3>
              <p className="card-text">
                Claude Desktop, Claude Code, Cursor, Windsurf, VS Code and most MCP apps start the connector themselves and talk to it over standard
                input and output. Nothing listens on the network.
              </p>
              <CodeBlock code={shellCommand(EXAMPLE_KEY)} label="Terminal" />
            </article>
            <article className="card">
              <span className="card-number">HTTP</span>
              <h3 className="card-title">Served at a private address</h3>
              <p className="card-text">
                For apps that only take a URL, such as ChatGPT. The connector serves <code>/mcp/&lt;token&gt;</code> on your machine. Anyone who has
                the full address can read what the app key can read, so keep it private.
              </p>
              <CodeBlock code={shellCommand(EXAMPLE_KEY, site.url, true)} label="Terminal" />
            </article>
          </div>
        </section>

        <section className="page-section" aria-labelledby="settings-title">
          <h2 id="settings-title" className="section-title">
            Settings
          </h2>
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {settings.map(([name, text]) => (
                  <tr key={name}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="page-section" aria-labelledby="keeps-title">
          <h2 id="keeps-title" className="section-title">
            What it does not do
          </h2>
          <div className="fact-grid">
            <div className="pillar">
              <h3 className="pillar-title">It does not write</h3>
              <p className="pillar-text">There is no tool and no server endpoint for adding, changing or deleting memories from an app.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">It does not remember</h3>
              <p className="pillar-text">Each request fetches and decrypts afresh, so a revoked key stops working on its very next request.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">It does not send your search</h3>
              <p className="pillar-text">Search runs on your computer over the decrypted index. The server only learns that the index was read.</p>
            </div>
          </div>
        </section>

        <PageLinks hrefs={["/apps", "/docs/api", "/threat-model"]} />
      </div>
    </div>
  );
}
