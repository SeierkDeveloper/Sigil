import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CodeBlock } from "@/components/CodeBlock";
import { buildFromSource, configLocations, mcpConfig, shellCommand } from "@/lib/connector";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Set up the Sigil connector for Claude Desktop, Cursor and ChatGPT, your AI self and ask links, the memory inbox, search by meaning, memory that thinks, local imports, the browser extension, Sign in with Sigil, sharing, the API and the encryption model.",
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
  ["ai-self", "Your AI self"],
  ["ask-links", "Ask links"],
  ["inbox", "Memory inbox"],
  ["meaning", "Search by meaning"],
  ["self-card", "Self card"],
  ["thinking", "Memory that thinks"],
  ["extension", "Browser extension"],
  ["sign-in-with-sigil", "Sign in with Sigil"],
  ["sharing", "Sharing a folder"],
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
          lead="Everything you need to give Claude, Cursor, ChatGPT, other MCP apps and web apps access to the parts of your vault you choose, and to let them suggest what to remember."
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
            <p>It reads these settings from its environment:</p>
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
                  <tr>
                    <td>
                      <code>SIGIL_SEMANTIC</code>
                    </td>
                    <td>
                      Search by meaning on your computer. On unless set to <code>off</code>.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>SIGIL_EMBED_MODEL</code>
                    </td>
                    <td>
                      The sentence model it uses, <code>Xenova/all-MiniLM-L6-v2</code> by default (about 23 MB).
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>SIGIL_MODEL_DIR</code>
                    </td>
                    <td>
                      Where the model files are kept: <code>.data/models</code> in the repository, or <code>~/.sigil/models</code> elsewhere.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>SIGIL_MODEL_FETCH</code>
                    </td>
                    <td>
                      Fetch missing model files once from the public model hub. Set to <code>off</code> to use only files already on disk.
                    </td>
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
            <p>The connector gives AI apps four tools that read, one that only suggests, and one that asks your AI self.</p>
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
                      <code>get_profile</code>
                    </td>
                    <td>Your Self card: who you are, how you like answers, what you are working on. Only if the app may read the Self card folder.</td>
                    <td>The app read the index, then the card.</td>
                  </tr>
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
                      Searches by meaning and by the words in titles, tags and first lines, on your computer. Takes <code>query</code>, and
                      optionally <code>folder</code> and <code>limit</code>. An empty query lists the most recent.
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
                  <tr>
                    <td>
                      <code>propose_memory</code>
                    </td>
                    <td>
                      Suggests a memory to your inbox: <code>title</code>, <code>body</code>, and optionally <code>tags</code> and a{" "}
                      <code>folder</code> name. Sealed on your computer for your vault. Works only if you let this app suggest.
                    </td>
                    <td>The app suggested a memory.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>ask_self</code>
                    </td>
                    <td>
                      Asks your AI self a <code>question</code>. It answers as you, from the folders your rules allow that this app may also read, with your
                      own model key, on your computer. Works only if you let this app answer as your AI self.
                    </td>
                    <td>The app read the index and the memories it used, and your AI self answered a question (the question and answer, sealed for your vault).</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>No tool changes or deletes a memory. A suggestion becomes a memory only when you approve it.</p>
          </section>

          <section id="ai-self" className="doc-section">
            <h2>Your AI self</h2>
            <p>
              Under <strong>AI self</strong> in the vault you set up an AI that answers as you. It is built from your memories at the moment of each
              question: nothing is trained, and nothing leaves your device except the request to your own model provider.
            </p>
            <ol>
              <li>
                <strong>Model.</strong> Choose Anthropic (the default) or OpenAI, a model, and paste your own API key. The key is encrypted with your
                vault key in your browser before it is saved. Calls go from your browser straight to the provider and are billed to your key.
              </li>
              <li>
                <strong>Rules.</strong> The folders it may use (nothing else is ever given to the model), topics it may and may not discuss, things it
                must never say, its tone, what it says when it does not know, and how many memories it may read per answer. A question about a topic
                it never discusses is refused before the model is asked. An answer that contains something it must never say is replaced by a refusal
                on your device. When nothing in its folders matches, it says it does not know without calling the model.
              </li>
              <li>
                <strong>Test chat.</strong> Ask what others would ask. Each answer shows the memories it used; click one to open it.
              </li>
              <li>
                <strong>Apps that answer as you.</strong> Let a connected app use <code>ask_self</code> and answer links. Your vault wraps the rules,
                your model key and your vault public key for that app&apos;s key only. The app reads memories through its own folders, so a folder
                must be both in the rules and given to the app.
              </li>
            </ol>
            <p>The rules and the key are saved as encrypted settings. Changing them updates every app you allowed.</p>
          </section>

          <section id="ask-links" className="doc-section">
            <h2>Ask links</h2>
            <p>
              An ask link lets anyone who has it ask your AI self questions. Each link has its own rules (folders and topics), an expiry, a number
              of questions in all and an hourly limit, and you can turn it off at any time.
            </p>
            <ol>
              <li>
                Making a link creates a key pair on your device. The link looks like <code>/ask/&lt;id&gt;#&lt;public key&gt;.&lt;greeting key&gt;</code>
                . Browsers never send the part after <code>#</code>, so the server never has it.
              </li>
              <li>
                The asker&apos;s browser checks that the server holds the same public key as the link, makes its own key pair for the conversation, and
                seals each question with a key both sides derive (X25519, HKDF-SHA256, XChaCha20-Poly1305).
              </li>
              <li>
                The question is answered where your keys are: your open vault, or the connector of an app you chose, run with{" "}
                <code>sigil-connector --self</code>. The answer is sealed back the same way. The server only relays the boxes.
              </li>
              <li>
                When neither is running, the link says your AI self is offline and takes no question. A question not answered within two minutes is
                given up.
              </li>
              <li>
                Every question and its answer go into your read log, sealed to your vault&apos;s public key, and are part of the hourly seal like
                every read. Open them in the log with <strong>Show the question and answer</strong>.
              </li>
            </ol>
            <p>
              The asker sees the answer only, never which memories it came from. Limits: up to 1,000 questions per link, up to 120 an hour, 8 a
              minute from one address, and one question at a time per conversation.
            </p>
          </section>

          <section id="inbox" className="doc-section">
            <h2>Memory inbox</h2>
            <p>
              Apps can suggest memories, when you allow it. Each app has its own switch, <strong>May suggest memories to your inbox</strong>, off
              until you turn it on under Apps (when you connect the app, or later under Permissions).
            </p>
            <ol>
              <li>
                Your vault has a public key (X25519) whose private half is wrapped by your vault key. When you turn suggestions on for an app, your
                browser tags that public key with a key derived from the app&apos;s own secret.
              </li>
              <li>
                The app fetches the public key and the tag, checks the tag, and only then seals the suggestion to the key, on your computer. The
                server stores a sealed box it cannot open.
              </li>
              <li>
                In the vault, <strong>Inbox</strong> opens each suggestion with your key. Edit it, then approve it into a folder, merge it into an
                existing memory (its text is added under a dated line), or reject it. The vault points out a suggestion that is already there.
              </li>
            </ol>
            <p>
              Each suggestion is a line in your read log. One app may send 30 suggestions an hour, and an inbox holds up to 500 waiting ones.
              Revoking an app stops its suggestions at once; what already arrived stays for you to decide.
            </p>
          </section>

          <section id="meaning" className="doc-section">
            <h2>Search by meaning</h2>
            <p>
              Search finds a note about the garage when you ask about your car. A small sentence model (<code>all-MiniLM-L6-v2</code>, about 23
              MB) runs on your device: in the vault, in a background worker in your browser, and in the connector on your computer. It turns each
              memory and each query into a vector, and results that match by meaning are ranked together with results that match by words.
            </p>
            <ul>
              <li>Queries and vectors never go to the server. The server only hands out the model files, which are the same for everyone.</li>
              <li>
                The vault keeps vectors in your browser&apos;s storage, encrypted with a key derived from your vault key and filed under names that
                do not show the text. The connector keeps them in memory only.
              </li>
              <li>
                The same vectors find duplicates: the same text, nearly the same words, or the same thing said twice. Use{" "}
                <strong>Find duplicates</strong> under Memories to merge them.
              </li>
              <li>
                <strong>Timeline</strong> shows every memory by the day it was written or last changed, filtered by where it came from.
              </li>
            </ul>
            <p>
              The server fetches the model files once from the public model hub and keeps them in its data folder; set{" "}
              <code>SIGIL_MODEL_FETCH=off</code> and put the files in <code>SIGIL_MODEL_DIR</code> yourself to keep it offline, or{" "}
              <code>SIGIL_SEMANTIC=off</code> to search by words only.
            </p>
          </section>

          <section id="self-card" className="doc-section">
            <h2>Self card</h2>
            <p>
              The Self card is a short profile in three parts: who you are, how you like answers, and your current projects. Write it under{" "}
              <strong>Self card</strong> in your vault. It is a memory like any other, encrypted the same way, in a folder of its own, so an app reads
              it only if you give it that folder. Apps read it with <code>get_profile</code>, and the connector tells them to read it first.
            </p>
          </section>

          <section id="thinking" className="doc-section">
            <h2>Memory that thinks</h2>
            <p>
              The <strong>Review</strong> tab looks over your vault on your device.
            </p>
            <ul>
              <li>
                <strong>Weekly brief.</strong> What is new, what changed and what you may have forgotten (untouched for 120 days), saved as a memory in
                a folder called Briefs. It is made when you open your vault and the last one is a week old (you can turn that off), or when you ask.
                With your model key and your permission, your model writes it; otherwise it is three plain lists.
              </li>
              <li>
                <strong>Memories that disagree.</strong> Pairs that are about the same thing (close in meaning, or sharing many words) and show a sign
                of disagreement: one says no where the other says yes, opposite words, or different numbers and dates. Keep one, or mark both as
                true. With your permission your model can check a pair.
              </li>
              <li>
                <strong>Merge every group.</strong> Under Find duplicates, all duplicate groups are merged after one approval: each into its newest
                memory, with what the others add and all their tags.
              </li>
              <li>
                <strong>Expiry.</strong> Give a memory an expiry date in its editor. After that day it leaves the list, apps no longer see it, and it
                waits under Expired. When the grace period you set (30 days unless you change it) is over, the server deletes it for real, even while
                your vault is closed. For that the server keeps one time in the clear per expiring memory: when to delete it.
              </li>
            </ul>
          </section>

          <section id="extension" className="doc-section">
            <h2>Browser extension</h2>
            <p>
              The Sigil extension for Chrome saves the selected text, the current page, or a whole ChatGPT or Claude conversation to your inbox.
              Everything is sealed in the browser for your vault, the same way as the connector&apos;s suggestions.
            </p>
            <ol>
              <li>
                Build it: <code>npm run build -w sigil-extension</code>. Then open <code>chrome://extensions</code>, turn on Developer mode, choose
                Load unpacked and pick <code>extension/dist</code>.
              </li>
              <li>
                In your vault, under Apps, connect a <strong>Browser extension</strong> with <strong>May suggest memories</strong> on. It needs no
                folders.
              </li>
              <li>Open the extension&apos;s options, enter the address of your Sigil site and paste the app key. It checks the key against your vault.</li>
              <li>
                Right-click a selection or a page and choose <strong>Save to Sigil</strong>, or use the toolbar button. On chatgpt.com and claude.ai a
                small <strong>Save conversation to Sigil</strong> button appears.
              </li>
            </ol>
            <p>
              The extension reads only the two chat sites, and other pages only when you ask it to save them. It keeps the app key in its own
              storage in this browser profile.
            </p>
          </section>

          <section id="sign-in-with-sigil" className="doc-section">
            <h2>Sign in with Sigil</h2>
            <p>
              A web app can ask for read access to folders of your choice with the <code>@sigil/sdk</code> package. A window from your vault opens;
              you unlock it, pick folders (and, if the app asks, whether it may suggest memories) and allow it. Your vault makes an app key for that
              app alone and hands it to the page that asked, and only to that page&apos;s origin. The app then decrypts what you allowed in your
              browser, on its page.
            </p>
            <CodeBlock
              code={`import { requestAccess, SigilClient } from "@sigil/sdk";\n\nconst access = await requestAccess({ vault: "${site.url}", appName: "My app" });\nconst sigil = new SigilClient(access);\n\nawait sigil.folders();\nawait sigil.search("trip to Rome");\nawait sigil.read([id]);`}
              label="JavaScript"
              language="js"
            />
            <p>
              The app appears under Apps as a web app with its origin in its name; change its folders or revoke it there, and its reads are in your
              read log. A complete example is in <code>examples/hello-sigil</code> in the repository.
            </p>
          </section>

          <section id="sharing" className="doc-section">
            <h2>Sharing a folder</h2>
            <p>Share a folder with another Sigil vault, read only.</p>
            <ol>
              <li>
                The other person copies their <strong>vault code</strong> from Folders in their vault and gives it to you. It holds only their
                vault&apos;s public key. Read each other the fingerprint shown next to it to be sure it is theirs.
              </li>
              <li>
                Choose <strong>Share</strong> on a folder and paste the code. Your browser seals the folder key to their public key; the server only
                passes the sealed key on.
              </li>
              <li>
                They accept it under <strong>Shared with you</strong>, and the folder shows in their Memories, read only. Each time their vault
                opens it, a line goes into your read log.
              </li>
              <li>
                <strong>Stop sharing</strong> gives the folder a new key on your device: every memory in it is encrypted again, and the new key is
                wrapped for you, for each app that may read the folder and for everyone else you share it with. The vault you removed keeps only the
                old key, which opens nothing that is stored now.
              </li>
            </ol>
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
            <h3>From Obsidian</h3>
            <p>
              Choose the folder of your Obsidian vault. Each Markdown note becomes a memory with its front matter and inline tags; the settings
              folder and attachments are left out. To keep it in sync, run the connector with <code>--watch</code>:
            </p>
            <CodeBlock label="Terminal" code={`SIGIL_APP_KEY=${KEY} \\\nSIGIL_URL=${site.url} \\\nnode connector/dist/index.js --watch "/path/to/your/Obsidian vault"`} />
            <p>
              Use an app key that may suggest memories and read the folder you imported into. New and changed notes are sealed on your computer and
              wait in your inbox, where a change offers to update the memory imported from the same note. Up to 8 notes go in one pass; the rest
              follow a minute later.
            </p>
            <h3>From Apple Notes</h3>
            <p>
              Ask Apple for a copy of your iCloud data, choose iCloud Notes, and pick the zip or the unpacked Notes folder. Notes exported as text,
              Markdown or HTML files work too. The first line of a note is its title.
            </p>
            <h3>From Gmail and Google Calendar</h3>
            <p>
              In Google Takeout, choose Mail and Calendar. Pick the zip, or the <code>.mbox</code> and <code>.ics</code> files inside it. Each mail
              thread becomes one memory with the sender, recipient, date and text of each message (quoted replies left out), up to 4,000 characters
              a message and 20,000 a thread, and the newest 5,000 threads at most. Spam and trash are left out. Each calendar event becomes one
              memory with its time, place and description.
            </p>
            <h3>From Notion</h3>
            <p>
              In Notion, export all workspace content as Markdown and CSV, and pick the zip (a zip inside the zip is opened too). Each page becomes a
              memory titled without Notion&apos;s page id, with its parent pages named at the top. Databases are left out.
            </p>
            <h3>From GitHub</h3>
            <p>
              Write a repository (owner/name) for its commit history, up to the newest 1,000 commits, or your user name for your recent activity
              (GitHub keeps about 90 days). Your browser asks GitHub directly. A token is needed only for private repositories or more requests; it
              is used for that import only and never saved or sent to Sigil. Commits and activity are grouped into one memory per day.
            </p>
            <p>
              Files are read and encrypted in your browser, up to 1 GB at once. Every import shows a preview first, lets you choose the folder, and
              leaves out what is already in your vault: the same source (a note path, a mail thread, an event) or the same title and text. Very
              long items are shortened to 500,000 characters, and the memory says so.
            </p>
          </section>

          <section id="api" className="doc-section">
            <h2>API</h2>
            <p>
              The connector API is what the connector, the extension and the SDK use, and what you can use to build your own reader. It reads, and
              takes suggestions when the owner allows them. Send the app token in <code>Authorization: Bearer &lt;token&gt;</code>, where the token
              is derived from the app key&apos;s secret (see the encryption model below). Everything returned is encrypted; decrypt it with the app
              key. These routes answer any origin (they take no cookie), so web apps can call them.
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
                  <tr>
                    <td>
                      <code>GET /api/connector/v1/inbox</code>
                    </td>
                    <td>
                      <code>{"{ appId, publicKey, tag }"}</code>, or <code>403</code> when the app may not suggest
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /api/connector/v1/proposals</code> with <code>{"{ id, sealed }"}</code>
                    </td>
                    <td>
                      <code>{"{ appId, id, createdAt }"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /api/connector/v1/self</code>
                    </td>
                    <td>
                      <code>{"{ appId, config, links: [{ id, publicKey, box }] }"}</code>, or <code>403</code> when the app may not answer as the AI self
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /api/connector/v1/self/pending</code>
                    </td>
                    <td>
                      <code>{"{ appId, questions: [{ id, linkId, sessionId, askerKey, sealed, createdAt }] }"}</code>; marks the app online for its links
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /api/connector/v1/self/questions/&lt;id&gt;/answer</code> with <code>{"{ sealed, note, cited }"}</code>
                    </td>
                    <td>
                      <code>{"{ ok }"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /api/connector/v1/self/asked</code> with <code>{"{ id, note, cited }"}</code>
                    </td>
                    <td>
                      <code>{"{ ok }"}</code>; the log line for an <code>ask_self</code> answer
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              A revoked or unknown key gets <code>401</code> with code <code>app_revoked</code>. Too many requests get <code>429</code>. Every
              endpoint, with its full response and limits, is in the <Link href="/docs/api">API reference</Link>.
            </p>
            <p>Public endpoints need no key. The two used most:</p>
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
                  <tr>
                    <td>
                      <code>GET /api/ask/&lt;link id&gt;</code>
                    </td>
                    <td>
                      <code>{"{ id, publicKey, intro, state, online, expiresAt, remaining }"}</code> for an ask link; the greeting is encrypted
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The vault page itself uses a session API (<code>/api/vault</code>, <code>/api/memories</code>, <code>/api/folders</code>,{" "}
              <code>/api/apps</code>, <code>/api/proposals</code>, <code>/api/shares</code>, <code>/api/settings</code>, <code>/api/self</code>,{" "}
              <code>/api/log</code> and the sign-in routes under{" "}
              <code>/api/auth</code>). It accepts only encrypted payloads
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
                  <tr>
                    <td>The vault&apos;s private box key</td>
                    <td>Vault key</td>
                    <td>
                      <code>sigil:box-secret</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Your note on a share (who it is for, their public key)</td>
                    <td>Vault key</td>
                    <td>
                      <code>sigil:share-note:&lt;share&gt;</code>
                    </td>
                  </tr>
                  <tr>
                    <td>A search vector kept in the browser</td>
                    <td>Key derived from the vault key</td>
                    <td>
                      <code>sigil:embedding:&lt;model&gt;:&lt;name&gt;</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>Sealed boxes</h3>
            <p>
              Data for a vault that is not open (a suggestion, a shared folder key) is sealed to the vault&apos;s X25519 public key:{" "}
              <code>s1.&lt;ephemeral key&gt;.&lt;nonce&gt;.&lt;ciphertext&gt;</code>. A fresh ephemeral key pair is made per message; the shared
              secret goes through HKDF-SHA256 with the ephemeral and recipient public keys as salt and{" "}
              <code>sigil:box:v1:&lt;context&gt;</code> as info, and the result keys XChaCha20-Poly1305 with a random 192-bit nonce and the context as
              associated data. Contexts are <code>proposal:&lt;id&gt;:&lt;app&gt;</code> and <code>share:&lt;id&gt;:&lt;folder&gt;</code>, so a
              box moved to another record does not open. The primitives come from the audited @noble libraries.
            </p>
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
                base64url), <code>sigil:wrap:app</code> (the key that opens the app&apos;s folder keys) and <code>sigil:tag:app-box</code> (the key
                of the HMAC-SHA256 tag that vouches for the vault public key to this app).
              </li>
              <li>
                Vectors kept in the browser: the vault key, then <code>sigil:embed-cache:names</code> (HMAC names) and{" "}
                <code>sigil:embed-cache:values</code> (AES-256-GCM).
              </li>
            </ul>
            <p>The server stores the SHA-256 of each sign-in token and app token, never the tokens.</p>
            <h3>Seals</h3>
            <p>
              A read-log leaf is <code>SHA-256(0x00 || data)</code>, where data is the lines <code>sigil-read-v1</code>, entry id, app id, kind,
              memory id, count, time and salt, joined with newlines. The kind is <code>folders</code>, <code>index</code>, <code>read</code>,{" "}
              <code>propose</code> (a suggestion, with its id) or <code>shared</code> (another vault opened a shared folder; the app id is the
              share). Inner nodes are <code>SHA-256(0x01 || min(a, b) || max(a, b))</code>, and an
              unpaired node moves up unchanged. The root of each hour is its seal. The on-chain contract, <code>contracts/src/SigilSeal.sol</code>,
              implements the same rules, so the same proof checks in the browser and on chain.
            </p>
          </section>

          <section id="run-locally" className="doc-section">
            <h2>Run Sigil yourself</h2>
            <p>Sigil is open source. To run the whole site and server on your own machine:</p>
            <CodeBlock code={`git clone ${site.githubUrl}.git\ncd Sigil\nnpm install\nnpm run build\nnpm start`} label="Terminal" />
            <p>
              It serves on <code>http://localhost:3000</code> and keeps its data in <code>web/.data/sigil.db</code>, with the search model&apos;s
              files in <code>web/.data/models</code>. See the repository README for settings and tests.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
