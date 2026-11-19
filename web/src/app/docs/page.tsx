import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CodeBlock } from "@/components/CodeBlock";
import { buildFromSource, configLocations, mcpConfig, shellCommand } from "@/lib/connector";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description: "Set up the Sigil connector for Claude Desktop, Cursor and ChatGPT, import your history, use the API, and read the encryption model.",
};

const KEY = "sigil_app.<app id>.<secret>";

const toc = [
  ["quick-start", "Quick start"],
  ["connector", "The connector"],
  ["claude-desktop", "Claude Desktop"],
  ["cursor", "Cursor"],
  ["chatgpt", "ChatGPT"],
  ["other-clients", "Other MCP clients"],
  ["tools", "Tools"],
  ["import", "Importing"],
  ["api", "API"],
  ["encryption", "Encryption model"],
  ["run-locally", "Run Sigil yourself"],
] as const;

export default function Docs() {
  return (
    <div className="page">
      <div className="container container-narrow">
        <PageHeader
          eyebrow="Docs"
          title="Connect every AI you use"
          lead="Everything you need to give Claude, Cursor, ChatGPT and other MCP apps read access to the parts of your vault you choose."
        />

        <nav aria-label="On this page">
          <ul className="toc">
            {toc.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="prose">
          <section id="quick-start" className="doc-section">
            <h2>Quick start</h2>
            <ol>
              <li>
                <Link href="/vault">Open your vault</Link> and create it with a passkey or a wallet. Save the recovery phrase.
              </li>
              <li>Add a few memories, or import your ChatGPT or Claude export under Import.</li>
              <li>
                Go to <strong>Apps</strong>, choose <strong>Connect an app</strong>, pick the folders it may read and copy the app key. It is shown
                once.
              </li>
              <li>Add the connector to your AI app with the snippet the vault shows you (also below), and restart the app.</li>
              <li>
                Ask something like <em>&quot;What do my notes say about the launch plan?&quot;</em>. Then open <strong>Read log</strong> in your
                vault to see what was read.
              </li>
            </ol>
          </section>

          <section id="connector" className="doc-section">
            <h2>The connector</h2>
            <p>
              The Sigil connector is a small MCP server that runs on your own computer. It holds your app key, fetches the encrypted folders that app
              may read, and decrypts them locally. It needs Node.js 20 or newer.
            </p>
            {site.connectorPublished ? (
              <p>
                Your AI app starts it for you with <code>npx -y {site.connectorPackage}</code>; there is nothing to install by hand.
              </p>
            ) : (
              <>
                <p>Build it once from the source repository:</p>
                <CodeBlock code={buildFromSource} label="Terminal" />
                <p>
                  This makes <code>connector/dist/index.js</code>. In the snippets below, replace <code>/path/to/Sigil</code> with the folder you
                  cloned into.
                </p>
              </>
            )}
            <p>It reads two settings from its environment:</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>SIGIL_APP_KEY</code>
                    </td>
                    <td>The app key from your vault. It starts with sigil_app. Keep it private: it can read the folders you granted.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>SIGIL_URL</code>
                    </td>
                    <td>The address of the Sigil site your vault lives on, for example {site.url}.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="claude-desktop" className="doc-section">
            <h2>Claude Desktop</h2>
            <ul>
              {configLocations["claude-desktop"].where.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p>Add Sigil under mcpServers (merge it with any servers already there), save, and restart Claude Desktop.</p>
            <CodeBlock code={mcpConfig(KEY)} label="claude_desktop_config.json" language="json" />
            <p>Sigil then appears in the tools menu of a new chat. Claude asks before it uses a tool for the first time.</p>
          </section>

          <section id="cursor" className="doc-section">
            <h2>Cursor</h2>
            <ul>
              {configLocations.cursor.where.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p>The file takes the same shape. After saving, check that Sigil shows as enabled under Cursor&apos;s MCP settings.</p>
            <CodeBlock code={mcpConfig(KEY)} label="~/.cursor/mcp.json" language="json" />
          </section>

          <section id="chatgpt" className="doc-section">
            <h2>ChatGPT</h2>
            <p>
              ChatGPT connects to MCP servers over the internet rather than starting a program on your computer, so the connector runs in HTTP mode
              and ChatGPT reaches it through a secure tunnel that you control.
            </p>
            <ol>
              <li>Start the connector in HTTP mode with a long random token of your own:</li>
            </ol>
            <CodeBlock code={shellCommand(KEY, site.url, true)} label="Terminal" />
            <ol start={2}>
              <li>
                It listens on <code>http://127.0.0.1:8787/mcp/&lt;token&gt;</code>. Expose that port with an HTTPS tunnel service of your choice.
              </li>
              <li>
                In ChatGPT, turn on developer mode for connectors and add a custom connector with the tunnel address, ending in{" "}
                <code>/mcp/&lt;token&gt;</code>, and no authentication. Which plans offer custom connectors is up to ChatGPT.
              </li>
            </ol>
            <p>
              <strong>Keep the address private.</strong> The token in the path is what keeps others out: anyone who has the full address can read
              what that app key can read. Stop the connector or revoke the app key in your vault whenever you want access to end. Text that ChatGPT
              reads is processed on its servers under its own terms.
            </p>
          </section>

          <section id="other-clients" className="doc-section">
            <h2>Other MCP clients</h2>
            <p>
              Any app that can start a local MCP server over stdio can use Sigil with the same command and environment. Apps that only take a URL can
              use HTTP mode as described for ChatGPT.
            </p>
            <CodeBlock code={shellCommand(KEY)} label="Terminal" />
          </section>

          <section id="tools" className="doc-section">
            <h2>Tools</h2>
            <p>The connector gives AI apps three read-only tools.</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>What it does</th>
                    <th>What goes in your log</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>list_folders</code>
                    </td>
                    <td>Names of the folders this app may read, with how many memories each holds.</td>
                    <td>The app listed its folders.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>search_memories</code>
                    </td>
                    <td>
                      Searches titles, tags and the first lines of memories, on your computer. Takes <code>query</code>, and optionally{" "}
                      <code>folder</code> and <code>limit</code>. An empty query lists the most recent.
                    </td>
                    <td>The app read the index (titles, tags, first lines) of N memories. The search words are not sent.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>read_memory</code>
                    </td>
                    <td>
                      The full text of one memory, by <code>id</code>.
                    </td>
                    <td>The app read that memory.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="import" className="doc-section">
            <h2>Importing</h2>
            <h3>From ChatGPT</h3>
            <p>
              In ChatGPT, open Settings, Data controls, Export data. You receive an email with a link to a zip file. Drop that zip (or the{" "}
              <code>conversations.json</code> inside it) into Import in your vault. Each conversation becomes one memory in a folder called ChatGPT,
              following the branch you last saw when a conversation was edited.
            </p>
            <h3>From Claude</h3>
            <p>
              In Claude, open Settings, Privacy, Export data. Drop the zip you receive into Import. Conversations, projects with their instructions
              and documents, and Claude&apos;s saved memory (when present) become memories in a folder called Claude.
            </p>
            <p>
              Files are read and encrypted in your browser. Very long conversations are shortened to 500,000 characters, and the memory says so.
            </p>
          </section>

          <section id="api" className="doc-section">
            <h2>API</h2>
            <p>
              The connector API is what the connector uses, and what you can use to build your own reader. It is read only. Send the app token in{" "}
              <code>Authorization: Bearer &lt;token&gt;</code>, where the token is derived from the app key&apos;s secret (see the encryption model
              below). Everything returned is encrypted; decrypt it with the app key.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Returns</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>GET /api/connector/v1/folders</code>
                    </td>
                    <td>
                      <code>{"{ appId, folders: [{ id, meta, wrappedKey, count }] }"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /api/connector/v1/index</code>
                    </td>
                    <td>
                      <code>{"{ appId, folders, memories: [{ id, folderId, head }] }"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /api/connector/v1/read</code> with <code>{"{ ids: [...] }"}</code> (1 to 20)
                    </td>
                    <td>
                      <code>{"{ appId, folders, memories: [{ id, folderId, head, body }], missing }"}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              A revoked or unknown key gets <code>401</code> with code <code>app_revoked</code>. Too many requests get <code>429</code>.
            </p>
            <p>Two public endpoints need no key:</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Returns</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>GET /api/seals?limit=24</code>
                    </td>
                    <td>
                      <code>{"{ mode, periodSeconds, seals: [{ hour, root, leaves, sealedAt, anchorTx }] }"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /api/status</code>
                    </td>
                    <td>Whether sealing is on, and whether seals are local or anchored.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The vault page itself uses a session API (<code>/api/vault</code>, <code>/api/memories</code>, <code>/api/folders</code>,{" "}
              <code>/api/apps</code>, <code>/api/log</code> and the sign-in routes under <code>/api/auth</code>). It accepts only encrypted payloads
              and only requests from the site itself. It is described in the source in <code>web/src/server/api.ts</code>.
            </p>
          </section>

          <section id="encryption" className="doc-section">
            <h2>Encryption model</h2>
            <h3>Envelopes</h3>
            <p>
              Every encrypted value is a string <code>v1.&lt;nonce&gt;.&lt;ciphertext&gt;</code> (both base64url): AES-256-GCM with a random 96-bit
              nonce and a 128-bit tag. The additional authenticated data names the record, so an envelope only opens in its own place:
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Value</th>
                    <th>Key</th>
                    <th>Bound to</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Vault key copy (one per sign-in method)</td>
                    <td>Key from passkey, wallet or phrase</td>
                    <td>
                      <code>sigil:keyslot:&lt;kind&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Folder key</td>
                    <td>Vault key</td>
                    <td>
                      <code>sigil:folder-key:&lt;folder&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Folder name</td>
                    <td>Folder key</td>
                    <td>
                      <code>sigil:folder-meta:&lt;folder&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Memory head (title, tags, source, first lines, dates)</td>
                    <td>Folder key</td>
                    <td>
                      <code>sigil:memory-head:&lt;memory&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Memory body</td>
                    <td>Folder key</td>
                    <td>
                      <code>sigil:memory-body:&lt;memory&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>App name and app secret</td>
                    <td>Vault key</td>
                    <td>
                      <code>sigil:app-meta:&lt;app&gt;</code>, <code>sigil:app-secret:&lt;app&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Folder key, for one app</td>
                    <td>App wrap key</td>
                    <td>
                      <code>sigil:app-folder-key:&lt;app&gt;:&lt;folder&gt;</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>Key derivation</h3>
            <p>
              All derivations use HKDF-SHA256 with the salt <code>sigil/hkdf/v1</code> and a label per purpose:
            </p>
            <ul>
              <li>
                Passkey: PRF evaluated on <code>SHA-256(&quot;sigil/passkey-prf/v1&quot;)</code>, then <code>sigil:kek:passkey</code>.
              </li>
              <li>
                Wallet: a personal_sign signature of a fixed message naming the wallet, then <code>sigil:kek:wallet:&lt;address&gt;</code> for the key
                and <code>sigil:auth:wallet:&lt;address&gt;</code> for the sign-in token.
              </li>
              <li>
                Recovery phrase: the 256-bit entropy of the 24 words, then <code>sigil:kek:phrase</code>, <code>sigil:auth:phrase</code> and{" "}
                <code>sigil:lookup:phrase</code> (which lets the server find the vault).
              </li>
              <li>
                App key <code>sigil_app.&lt;app id&gt;.&lt;secret&gt;</code>: the 32-byte secret, then <code>sigil:auth:app</code> (the bearer token,
                base64url) and <code>sigil:wrap:app</code> (the key that opens the app&apos;s folder keys).
              </li>
            </ul>
            <p>The server stores the SHA-256 of each sign-in token and app token, never the tokens.</p>
            <h3>Seals</h3>
            <p>
              A read-log leaf is <code>SHA-256(0x00 || data)</code>, where data is the lines <code>sigil-read-v1</code>, entry id, app id, kind,
              memory id, count, time and salt, joined with newlines. Inner nodes are <code>SHA-256(0x01 || min(a, b) || max(a, b))</code>, and an
              unpaired node moves up unchanged. The root of each hour is its seal. The on-chain contract, <code>contracts/src/SigilSeal.sol</code>,
              implements the same rules, so the same proof checks in the browser and on chain.
            </p>
          </section>

          <section id="run-locally" className="doc-section">
            <h2>Run Sigil yourself</h2>
            <p>Sigil is open source. To run the whole site and server on your own machine:</p>
            <CodeBlock code={`git clone ${site.githubUrl}.git\ncd Sigil\nnpm install\nnpm run build\nnpm start`} label="Terminal" />
            <p>
              It serves on <code>http://localhost:3000</code> and keeps its data in <code>web/.data/sigil.db</code>. See the repository README for
              settings and tests.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
