import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { ChatGptIcon, ClaudeIcon, CursorIcon, EditorIcon, McpIcon, TerminalIcon } from "@/components/icons";
import { buildFromSource, claudeCodeCommand, EXAMPLE_KEY, mcpConfig, shellCommand, vscodeConfig } from "@/lib/connector";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Apps",
  description: "Step-by-step setup of the Sigil connector for Claude Desktop, Claude Code, Cursor, ChatGPT, Windsurf, VS Code and any MCP client.",
};

type Guide = {
  id: string;
  name: string;
  Icon: (p: { className?: string }) => React.ReactNode;
  how: string;
  pick: string;
  steps: React.ReactNode[];
  code?: { code: string; label: string; language?: string };
  after: string;
};

const guides: Guide[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    Icon: ClaudeIcon,
    how: "Starts the connector itself",
    pick: "Claude Desktop",
    steps: [
      "In Claude Desktop open Settings, Developer, Edit Config.",
      <>
        That opens <code>claude_desktop_config.json</code>. On macOS it lives in <code>~/Library/Application Support/Claude</code>, on Windows in{" "}
        <code>%APPDATA%\Claude</code>.
      </>,
      "Add Sigil under mcpServers, next to any servers already there, and save.",
      "Quit Claude Desktop fully and open it again.",
    ],
    code: { code: mcpConfig(EXAMPLE_KEY), label: "claude_desktop_config.json", language: "json" },
    after: "Sigil appears in the tools menu of a new chat. Claude asks before it uses a tool for the first time.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    Icon: TerminalIcon,
    how: "Starts the connector itself",
    pick: "Other",
    steps: [
      "Run the command below once in a terminal. It adds Sigil for every project of yours.",
      <>
        To share it with one project only, put the same <code>mcpServers</code> block as for Claude Desktop in a file called <code>.mcp.json</code>{" "}
        in the project folder instead. Keep that file out of version control: it holds your app key.
      </>,
      <>
        Start Claude Code and type <code>/mcp</code> to see that sigil is connected.
      </>,
    ],
    code: { code: claudeCodeCommand(EXAMPLE_KEY), label: "Terminal" },
    after: "Claude Code can now search and read the folders you shared, in any session.",
  },
  {
    id: "cursor",
    name: "Cursor",
    Icon: CursorIcon,
    how: "Starts the connector itself",
    pick: "Cursor",
    steps: [
      <>
        For every project, open or create <code>~/.cursor/mcp.json</code>. For one project only, use <code>.cursor/mcp.json</code> in the project
        folder.
      </>,
      "Add Sigil under mcpServers and save.",
      "Open Cursor Settings, MCP, and check that sigil shows as enabled.",
    ],
    code: { code: mcpConfig(EXAMPLE_KEY), label: "~/.cursor/mcp.json", language: "json" },
    after: "Ask the agent something your notes can answer. It calls search_memories, then read_memory.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    Icon: EditorIcon,
    how: "Starts the connector itself",
    pick: "Other",
    steps: [
      <>
        Open <code>~/.codeium/windsurf/mcp_config.json</code>, or reach it from the MCP section of Windsurf&apos;s settings.
      </>,
      "Add Sigil under mcpServers and save.",
      "Refresh the MCP servers in Windsurf's settings so it picks up the change.",
    ],
    code: { code: mcpConfig(EXAMPLE_KEY), label: "mcp_config.json", language: "json" },
    after: "Cascade lists the three Sigil tools and uses them when your own notes can help.",
  },
  {
    id: "vs-code",
    name: "VS Code",
    Icon: EditorIcon,
    how: "Starts the connector itself",
    pick: "Other",
    steps: [
      <>
        Create <code>.vscode/mcp.json</code> in your project. VS Code lists servers under <code>servers</code>, not mcpServers.
      </>,
      "Save, then press Start above the server in that file.",
      "Open chat in agent mode and check that the Sigil tools are ticked in the tools list.",
      <>
        Extensions that bring their own MCP settings, such as Cline, take the <code>mcpServers</code> block shown for Claude Desktop in their own
        settings file.
      </>,
    ],
    code: { code: vscodeConfig(EXAMPLE_KEY), label: ".vscode/mcp.json", language: "json" },
    after: "Keep the file out of version control, or move the key to an input variable: it holds your app key.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    Icon: ChatGptIcon,
    how: "Connects to an address you run",
    pick: "ChatGPT",
    steps: [
      "ChatGPT reaches MCP servers over the internet, so the connector runs in HTTP mode on your computer. Start it with a long random token of your own.",
      <>
        It listens on <code>http://127.0.0.1:8787/mcp/&lt;token&gt;</code>. Expose that port with an HTTPS tunnel service of your choice.
      </>,
      <>
        In ChatGPT, turn on developer mode for connectors and add a custom connector with the tunnel address ending in{" "}
        <code>/mcp/&lt;token&gt;</code>, with no authentication. Which plans offer custom connectors is up to ChatGPT.
      </>,
      "Keep the address private. The token in the path is what keeps others out. Stop the connector, or revoke the app key, whenever access should end.",
    ],
    code: { code: shellCommand(EXAMPLE_KEY, site.url, true), label: "Terminal" },
    after: "Text that ChatGPT reads is processed on its servers under its own terms.",
  },
  {
    id: "any-mcp-client",
    name: "Any MCP client",
    Icon: McpIcon,
    how: "Stdio or HTTP",
    pick: "Other",
    steps: [
      "Any app that can start a local MCP server over stdio uses the command below with the two environment variables.",
      "Apps that only take a URL use HTTP mode, as described for ChatGPT.",
      "The connector offers four tools that read (get_profile, list_folders, search_memories and read_memory), propose_memory, which suggests a memory to your inbox when you allow it, ask_self, and get_thresholds, check_action, report_action and negotiate, with which an app asks before it acts for you.",
    ],
    code: { code: shellCommand(EXAMPLE_KEY), label: "Terminal" },
    after: "If the client speaks MCP, it can read your vault, and every read lands in your log.",
  },
];

export default function AppsPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Apps"
          title="One vault, every AI app you use"
          lead="Sigil reaches AI apps through one small connector that speaks MCP, the Model Context Protocol. Each app gets its own key and only the folders you tick. Pick your app below."
        />

        <nav aria-label="Apps on this page">
          <ul className="app-index">
            {guides.map(({ id, name, Icon, how }) => (
              <li key={id}>
                <a href={`#${id}`} className="app-index-link">
                  <Icon className="app-index-icon" />
                  <span className="app-index-name">{name}</span>
                  <span className="app-index-how">{how}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <section className="page-section" aria-labelledby="first-title">
          <h2 id="first-title" className="section-title">
            Before any app: two things, once
          </h2>
          <div className="grid grid-2">
            <article className="card">
              <span className="card-number">01</span>
              <h3 className="card-title">Make an app key in your vault</h3>
              <p className="card-text">
                <Link href="/vault#apps">Open your vault</Link>, go to Apps, choose Connect an app, name it and tick the folders it may read. The
                app key is shown once; copy it. Each app gets its own key, so you can revoke one without touching the others.
              </p>
              <CodeBlock code={EXAMPLE_KEY} label="An app key, shown once" />
            </article>
            <article className="card">
              <span className="card-number">02</span>
              <h3 className="card-title">Have the connector on your computer</h3>
              {site.connectorPublished ? (
                <p className="card-text">
                  Nothing to install: your AI app starts it with <code>npx -y {site.connectorPackage}</code>. It needs Node.js 20 or newer.
                </p>
              ) : (
                <>
                  <p className="card-text">
                    Build it once from the source. It needs Node.js 20 or newer. In the snippets below, replace <code>/path/to/Sigil</code> with the
                    folder you cloned into.
                  </p>
                  <CodeBlock code={buildFromSource} label="Terminal" />
                </>
              )}
            </article>
          </div>
        </section>

        <div className="guides">
          {guides.map(({ id, name, Icon, how, pick, steps, code, after }, i) => (
            <section key={id} id={id} className="guide" aria-labelledby={`${id}-title`}>
              <div className="guide-head">
                <span className="guide-icon">
                  <Icon />
                </span>
                <div>
                  <p className="guide-count">
                    {String(i + 1).padStart(2, "0")} / {String(guides.length).padStart(2, "0")}
                  </p>
                  <h2 id={`${id}-title`} className="guide-title">
                    {name}
                  </h2>
                </div>
                <div className="guide-tags">
                  <span className="badge">{how}</span>
                  <span className="badge">In the vault: {pick}</span>
                </div>
              </div>
              <div className="guide-body">
                <ol className="guide-steps">
                  {steps.map((s, n) => (
                    <li key={n}>{s}</li>
                  ))}
                </ol>
                <div className="guide-code">
                  {code ? <CodeBlock code={code.code} label={code.label} language={code.language} /> : null}
                  <p className="guide-after">{after}</p>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="page-section" aria-labelledby="then-title">
          <h2 id="then-title" className="section-title">
            After it is connected
          </h2>
          <div className="fact-grid">
            <div className="pillar">
              <h3 className="pillar-title">Ask as usual</h3>
              <p className="pillar-text">Ask something your notes can answer. The app searches titles, tags and first lines, then reads what looks relevant.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Watch the read log</h3>
              <p className="pillar-text">Every request shows up in your vault under Read log: which app, what it saw and when.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Change your mind</h3>
              <p className="pillar-text">Add or remove folders for an app at any time, or revoke it. A revoked key fails on its very next request.</p>
            </div>
          </div>
        </section>

        <PageLinks hrefs={["/connector", "/docs/api", "/seals"]} />
      </div>
    </div>
  );
}
