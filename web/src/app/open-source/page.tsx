import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { ArrowIcon, GitHubIcon } from "@/components/icons";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Open source",
  description: "Sigil is open source under the MIT licence. What is in the repository, how to run it yourself and how to test it.",
};

const parts = [
  {
    path: "packages/core",
    title: "The cryptography",
    text: "AES-256-GCM envelopes, HKDF key derivation, key slots, app keys, sealed boxes to a vault's public key, folder sharing and key rotation, Merkle seals, search by words and by meaning, and the ChatGPT and Claude export parsers. Every other part uses this one package.",
  },
  {
    path: "web",
    title: "The site and the server",
    text: "The pages you are reading, the vault dashboard, and the API in web/src/server, backed by SQLite. The server only ever handles ciphertext.",
  },
  {
    path: "connector",
    title: "The connector",
    text: "sigil-connector, the MCP server people run on their own machine. Stdio for apps that start it, HTTP for apps that need a URL. Searches by meaning and seals suggestions there.",
  },
  {
    path: "extension",
    title: "The browser extension",
    text: "A Chrome extension that saves a selection, a page or a ChatGPT or Claude conversation to the inbox, sealed in the browser. Built as an unpacked extension; not in a store.",
  },
  {
    path: "packages/sdk",
    title: "Sign in with Sigil",
    text: "The SDK web apps use to ask for read access to chosen folders, with a small example app in examples/hello-sigil.",
  },
  {
    path: "contracts",
    title: "The seal contract",
    text: "SigilSeal.sol records hourly seal roots on chain and checks proofs with the same rules as the browser. Written and tested; not deployed.",
  },
  {
    path: "e2e",
    title: "End-to-end tests",
    text: "Playwright runs the whole product in Chrome against the built server: sign-up, import, connecting an app, reads, seals, revoke, the inbox, search by meaning, sharing and Sign in with Sigil.",
  },
  {
    path: "docs",
    title: "Design brief and screenshots",
    text: "How the site is styled and a screenshot of every page and every vault state, at desktop and phone sizes.",
  },
];

const settings: [string, string, string][] = [
  ["NEXT_PUBLIC_SITE_URL", "http://localhost:3000", "The public address, used in links and connector snippets. Set at build time."],
  ["SIGIL_ORIGIN", "the request's own origin", "The origin trusted for passkeys and same-origin checks in production."],
  ["SIGIL_DATA_DIR", "web/.data", "Where the SQLite database lives."],
  ["SIGIL_SEALS", "on", "Seal the read log at the end of every hour."],
  ["SIGIL_ANCHOR", "off", "Publish seal roots to the SigilSeal contract. Needs an RPC address, the contract address and a sealer key."],
  ["SIGIL_SEMANTIC", "on", "Search by meaning in the vault. The model runs in the browser; the server only hands out its files."],
  ["SIGIL_EMBED_MODEL", "Xenova/all-MiniLM-L6-v2", "The sentence model for search by meaning."],
  ["SIGIL_MODEL_DIR", "web/.data/models", "Where the model files are kept."],
  ["SIGIL_MODEL_FETCH", "on", "Fetch missing model files once from the public model hub. Off serves only files already on disk."],
];

export default function OpenSource() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Open source"
          title="Read the code, run it yourself"
          lead="A vault you cannot inspect asks for blind trust. Every line of Sigil is public under the MIT licence: the encryption, the server, the connector, the browser extension, the SDK and the contract."
        />

        <section className="page-section" aria-labelledby="repo-title">
          <div className="repo-card">
            <span className="repo-icon">
              <GitHubIcon />
            </span>
            <div className="repo-main">
              <h2 id="repo-title" className="repo-title">
                {site.githubUrl.replace("https://github.com/", "")}
              </h2>
              <p className="repo-text">One repository, seven packages, MIT licence. TypeScript throughout, Solidity for the contract.</p>
            </div>
            <a className="button button-primary" href={site.githubUrl} target="_blank" rel="noopener noreferrer">
              Open the repository <ArrowIcon />
            </a>
          </div>
        </section>

        <section className="page-section" aria-labelledby="parts-title">
          <h2 id="parts-title" className="section-title">
            What is in it
          </h2>
          <div className="fact-grid">
            {parts.map((p) => (
              <div key={p.path} className="pillar" data-plain="true">
                <p className="pillar-path">{p.path}</p>
                <h3 className="pillar-title">{p.title}</h3>
                <p className="pillar-text">{p.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="page-section" aria-labelledby="run-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Run it</p>
              <h2 id="run-title" className="section-title">
                Your own Sigil in four commands
              </h2>
              <p className="section-lead">
                Needs Node.js 22.13 or newer, for the built-in SQLite. It serves on http://localhost:3000 and keeps its data in web/.data/sigil.db.
                Nothing else is required: no account, no external database, no third-party service.
              </p>
              <ul className="checklist">
                <li>
                  <span>Your vault then lives on your own machine, and your connector points at your own address.</span>
                </li>
                <li>
                  <span>Passkeys work on localhost. For a public address, serve it over HTTPS and set SIGIL_ORIGIN.</span>
                </li>
                <li>
                  <span>For development, npm run dev starts the site with live reload.</span>
                </li>
              </ul>
            </div>
            <div className="stack">
              <CodeBlock code={`git clone ${site.githubUrl}.git\ncd Sigil\nnpm install\nnpm run build\nnpm start`} label="Terminal" />
              <CodeBlock code={"npm run test:unit       # core, server and connector\nnpm run test:contracts  # the seal contract, with Foundry\nnpm run test:e2e        # the whole product in Chrome\nnpm test                # all three"} label="Tests" />
            </div>
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
                  <th>Variable</th>
                  <th>Default</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {settings.map(([name, def, text]) => (
                  <tr key={name}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>{def}</td>
                    <td>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="page-section" aria-labelledby="licence-title">
          <div className="grid grid-2">
            <article className="card">
              <span className="card-number">Licence</span>
              <h3 id="licence-title" className="card-title">
                MIT
              </h3>
              <p className="card-text">
                Use it, change it, host it, build on it, for any purpose. The licence asks only that the copyright notice stays with the code, and
                it comes without warranty.
              </p>
            </article>
            <article className="card">
              <span className="card-number">Taking part</span>
              <h3 className="card-title">Issues, changes and security reports</h3>
              <p className="card-text">
                Open an issue or a pull request on the repository. Security problems go through the repository&apos;s private security advisories
                instead of a public issue, so they can be fixed before they are known.
              </p>
            </article>
          </div>
        </section>

        <PageLinks hrefs={["/docs", "/docs/api", "/changelog"]} />
      </div>
    </div>
  );
}
