import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { buildFromSource, EXAMPLE_KEY, mcpConfig, shellCommand } from "@/lib/connector";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Connector",
  description:
    "The Sigil connector: a small MCP server that runs on your computer, decrypts there, searches by meaning there, and gives AI apps four tools that read, one that suggests memories to your inbox, one that asks your AI self, and four that let them ask before they act for you.",
};

const tools = [
  {
    name: "get_profile",
    title: "Read the Sigil Self card",
    text: "Your Self card: who you are, how you like answers and what you are working on. The app is told to call it first. Works only if it may read the Self card folder.",
    args: [] as [string, string][],
    logged: "The app read the index, then the card.",
    example: `# Self card
Edited: 2026-11-20

## Who I am

A designer who builds boats on weekends.

## How I like answers

Short, plain words, metric units.`,
  },
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
    text: "Searches by meaning and by the words in titles, tags and first lines, on your computer: a question about your car finds the note about the garage. An empty query lists the most recent. Returns ids for read_memory.",
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

2. Release checklist
   id: 4Qa8NcT1pZ0e | folder: Work | edited 2026-11-12 | matched by meaning
   Freeze the build two days before.

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
  {
    name: "propose_memory",
    title: "Suggest a memory to Sigil",
    text: "Suggests a memory to your inbox. It is sealed on your computer for your vault, and becomes a memory only when you approve it. Works only if you let this app suggest.",
    args: [
      ["title", "A short title, up to 300 characters."],
      ["body", "The memory, in plain words."],
      ["tags", "Optional. Up to 12 tags."],
      ["folder", "Optional. The folder the app suggests, by name. You decide."],
    ] as [string, string][],
    logged: "The app suggested a memory.",
    example: `Suggested "Prefers metric units" to the user's Sigil inbox. It becomes a memory only if they approve it.`,
  },
  {
    name: "ask_self",
    title: "Ask the user's AI self",
    text: "Asks your AI self: it answers as you, in the first person, only from the folders your rules allow that this app may also read, with your own model key, on your computer. Works only if you let this app answer as your AI self.",
    args: [["question", "The question, up to 2,000 characters."]] as [string, string][],
    logged: "The app read the memories it used, and your AI self answered a question (sealed for your vault).",
    example: `Short answers, plain words and metric units, please [1].

From: How I like answers (Self card)`,
  },
  {
    name: "get_thresholds",
    title: "Read the user's thresholds for acting",
    text: "Your thresholds for mail, invites and negotiation, in plain lines: whom, what about, how many a day, meeting lengths, free hours, ranges and what it never touches. Works only if you let this app act, under Limits.",
    args: [] as [string, string][],
    logged: "Nothing: the thresholds were wrapped for this app when you let it act.",
    example: `The user's thresholds:
- Mail: it may reply to sam lee and @team.example about times and meetings and questions, up to 10 a day. Everything else waits for the owner.
- Invites: off. Every invite waits for the owner.
- Price for Consulting day: opens at 1200 EUR, never below 800 EUR.`,
  },
  {
    name: "check_action",
    title: "Ask Sigil before acting",
    text: "Called before the app sends mail or answers an invite with access of its own. Decided on your computer against your thresholds: allowed, needs approval (it waits for you in Work with the thread and what the app would send) or refused. With an id, your answer to a step that waited.",
    args: [
      ["area, action, who", "mail with reply or send, or calendar with accept, decline or propose; and the other person."],
      ["subject, text, kinds", "Optional. What the message is about; Sigil reads the text too."],
      ["start, minutes, conflicts", "Optional, for an invite."],
      ["next, thread", "Optional. What the app would send, and the thread so far, for you to read in Work."],
      ["id", "Instead of the above: a step that waited, to learn your answer."],
    ] as [string, string][],
    logged: "A step of your AI self, allowed, waiting or refused, sealed for your vault.",
    example: `needs-approval: The other person is not one of the senders you listed.
It waits for the user in their Sigil vault, under Work, with the thread and what you would send. Do not act yet.
Step id: 8kQ2mV0xRr1sT3uW
Call check_action with this id later to see their answer.`,
  },
  {
    name: "report_action",
    title: "Report what was done",
    text: "Called after the app acted on an allowed or approved step. A receipt is signed on your computer with the app's own key, which your self key vouched for in your vault, and sealed with the hour.",
    args: [
      ["id", "The step."],
      ["what", "What it did, in plain words."],
    ] as [string, string][],
    logged: "A receipt, its fingerprint in the hourly seal.",
    example: `Kept a signed receipt (Zt4nB8cQ1wE6rY2u). Its fingerprint 0x5b1d9a2c7e4f8b03... joins this hour's seal.`,
  },
  {
    name: "negotiate",
    title: "Negotiate within the user's ranges",
    text: "One step of a negotiation over a price, a meeting time or terms. It accepts, counters with the exact offer and words to send, or stops at the edge of your range and waits for you in Work. The numbers and times come from your ranges.",
    args: [
      ["kind, topic, who", "price, time or terms; what it is about; the other side."],
      ["theirs, ours, round", "Optional. Their offer now, your last offer, and how many counters so far."],
    ] as [string, string][],
    logged: "A step of your AI self in negotiation, sealed for your vault.",
    example: `counter: Inside your range: it moves halfway toward their 900 EUR.
Offer: 1050 EUR
Say: I can do 1050 EUR.
Step id: Qm7cX2pL9vB4nK1d
After you sent it, call report_action with this id.`,
  },
];

const settings: [string, string][] = [
  ["SIGIL_APP_KEY", "Required. The app key from your vault. It starts with sigil_app. Keep it private: it can read the folders you granted."],
  ["SIGIL_URL", `Required. The address of the Sigil site your vault lives on, for example ${site.url}.`],
  ["SIGIL_HTTP_TOKEN", "HTTP mode only. The secret last part of the address, 16 to 128 letters, digits, - or _. A random one is made when unset."],
  ["SIGIL_SEMANTIC", "Search by meaning on your computer. On unless set to off."],
  ["SIGIL_EMBED_MODEL", "The sentence model for search by meaning. Xenova/all-MiniLM-L6-v2 by default, about 23 MB."],
  ["SIGIL_MODEL_DIR", "Where the model files are kept. .data/models in the repository, or ~/.sigil/models elsewhere."],
  ["SIGIL_MODEL_FETCH", "Fetch missing model files once from the public model hub. Set to off to use only files already on disk."],
  ["--http", "Serve over HTTP instead of stdio."],
  ["--port, --host", "HTTP mode only. Default 8787 on 127.0.0.1."],
  ["--help, --version", "Print the usage, or the version."],
];

const agentTools = [
  {
    name: "remember",
    text: "Writes a memory to the agent's own folder, or to a folder or team space it may write. Encrypted on your computer.",
    logged: "The agent remembered that memory.",
    example: `Remembered "Parser state" in Cursor memory (id 7Rk2pWq9Lm4c).`,
  },
  {
    name: "recall",
    text: "Finds what the agent may read, its team spaces included, by meaning and words on your computer, and returns the best matches in full.",
    logged: "The index, and each memory read.",
    example: `1. Parser state
   id: 7Rk2pWq9Lm4c | in Cursor memory | edited 2026-11-20

Half done: tokens work, the tree does not yet.`,
  },
  {
    name: "forget",
    text: "Deletes memories by id, for good, only where the agent may write. Off until the owner allows it.",
    logged: "The agent forgot that memory.",
    example: "Forgot 1 memory.",
  },
  {
    name: "leave_handoff",
    text: "Leaves an encrypted note for the agent's next session, or for the other agents in a team space.",
    logged: "The agent left a handoff note.",
    example: "Left a note for this agent's next session.",
  },
  {
    name: "pick_up_handoffs",
    text: "Returns the notes waiting for the agent and marks them picked up. Agents are told to call it first.",
    logged: "The agent picked up a handoff note.",
    example: `From cursor, 2026-11-20:
Next: wire the parser into the CLI.`,
  },
];

export default function ConnectorPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Connector"
          title="One small program between your vault and every AI app"
          lead="The connector is an MCP server that runs on your own computer. It holds one app key, fetches the encrypted folders that key may read, decrypts and searches them locally, and seals any memory it suggests for your vault alone. It keeps nothing between requests, and it cannot change a memory."
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
              <p>Unwraps the folder keys, decrypts, searches by words and by meaning locally, and hands plain text to the app.</p>
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
              Four tools that read, one that suggests, one that answers as you, four that ask before acting
            </h2>
            <p className="section-lead">
              The tools that read, ask_self and get_thresholds are marked read only for the AI app. The four for acting work only for an app you let act, under
              Limits, and need no Google client on this site. The answers below are the plain text an app receives, in the connector&apos;s own format.
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

        <section className="page-section" aria-labelledby="agent-tools-title">
          <div className="section-header">
            <h2 id="agent-tools-title" className="section-title">
              Five more for an agent key
            </h2>
            <p className="section-lead">
              When the key belongs to an agent vault, the connector notices at start and adds tools for the agent&apos;s own memory. The owner sets a
              switch for each, and the server enforces it on every call.
            </p>
          </div>
          <div className="tools">
            {agentTools.map((t) => (
              <article key={t.name} className="tool">
                <div className="tool-main">
                  <h3 className="tool-name">
                    <code>{t.name}</code>
                  </h3>
                  <p className="tool-text">{t.text}</p>
                  <p className="tool-logged">
                    <span>In your read log</span> {t.logged}
                  </p>
                </div>
                <CodeBlock code={t.example} label="What the agent receives" />
              </article>
            ))}
          </div>
          <p className="muted">
            Setup for Claude Code, Cursor, VS Code and other clients is in the <Link href="/docs#agents">docs</Link>.
          </p>
        </section>

        <section className="page-section" aria-labelledby="modes-title">
          <h2 id="modes-title" className="section-title">
            Four ways to run it
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
            <article className="card">
              <span className="card-number">Self</span>
              <h3 className="card-title">Answering your ask links</h3>
              <p className="card-text">
                With <code>--self</code> it answers the ask links you gave this app, and your public AI self when you picked this app for it, while your
                vault is closed. Questions arrive sealed, are answered on your machine with your own model key, and go back sealed. They show as online
                while it runs.
              </p>
              <CodeBlock code={`${shellCommand(EXAMPLE_KEY)} --self`} label="Terminal" />
            </article>
            <article className="card">
              <span className="card-number">Watch</span>
              <h3 className="card-title">Live sync and Obsidian</h3>
              <p className="card-text">
                With <code>--watch</code> it keeps the live sync sources you gave this app (Gmail, Calendar, Drive, Slack) in sync while your vault is
                closed, every few minutes, encrypting on your machine. With a folder too, it watches an Obsidian vault and suggests new and changed notes
                to your inbox; a small file in your home folder remembers what was sent, as hashes only.
              </p>
              <CodeBlock code={`${shellCommand(EXAMPLE_KEY)} --watch ~/Obsidian`} label="Terminal" />
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
              <h3 className="pillar-title">It does not write your memories</h3>
              <p className="pillar-text">
                No tool or endpoint lets an app change or delete a memory. A suggestion, a synced note included, waits in your inbox, sealed, until you
                approve, merge or reject it.
              </p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">It does not remember</h3>
              <p className="pillar-text">Each request fetches and decrypts afresh, so a revoked key stops working on its very next request.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">It does not send your search</h3>
              <p className="pillar-text">
                Search, by words and by meaning, runs on your computer over the decrypted index. The server only learns that the index was read.
              </p>
            </div>
          </div>
        </section>

        <PageLinks hrefs={["/apps", "/docs/api", "/threat-model"]} />
      </div>
    </div>
  );
}
