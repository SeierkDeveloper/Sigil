import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { ImportDrop } from "@/components/ImportDrop";
import { ChatGptIcon, ClaudeIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Import",
  description: "Bring your ChatGPT and Claude history, notes, mail, calendar and code into your Sigil vault. Every file is opened, sorted and encrypted in your browser.",
};

const sources = [
  {
    name: "ChatGPT",
    Icon: ChatGptIcon,
    steps: [
      "Open ChatGPT, then Settings, Data controls, Export data.",
      "Confirm the export. An email arrives with a link to a zip file.",
      "Download the zip. You do not need to unpack it.",
      "Drop it on this page, or on Import inside your vault.",
    ],
    becomes: [
      "Every conversation becomes one memory, dated when it happened.",
      "Edited conversations follow the branch you last saw.",
      "Everything lands in a folder called ChatGPT, unless you pick another.",
    ],
  },
  {
    name: "Claude",
    Icon: ClaudeIcon,
    steps: [
      "Open Claude, then Settings, Privacy, Export data.",
      "Confirm the export. An email arrives with a link to a zip file.",
      "Download the zip. You do not need to unpack it.",
      "Drop it on this page, or on Import inside your vault.",
    ],
    becomes: [
      "Every conversation becomes one memory, dated when it happened.",
      "Projects come along with their instructions and documents.",
      "What Claude remembered about you is imported too, when the export holds it.",
    ],
  },
];

const facts = [
  { title: "Opened in your browser", text: "The file is unpacked and read on this device. The export itself is never uploaded." },
  { title: "Encrypted before it is stored", text: "Each memory is encrypted with its folder's key. The server receives ciphertext only." },
  { title: "No doubles", text: "Import the same export twice and the conversations already in your vault are skipped." },
  { title: "You see it first", text: "A preview shows how many items were found and where they will go before anything is saved." },
  { title: "Long conversations", text: "A conversation longer than 500,000 characters is shortened, and the memory says so." },
  { title: "Yours to sort", text: "After the import, move memories between folders and decide which app may read which folder." },
];

const more = [
  { title: "Obsidian", text: "Every note in a vault, with its tags. The connector can watch the folder and suggest changed notes to your inbox." },
  { title: "Apple Notes", text: "Notes from your iCloud data copy, or notes exported as text, Markdown or HTML files." },
  { title: "Gmail", text: "From Google Takeout: one memory per thread, with senders, dates and text, within size limits. Spam and trash are left out." },
  { title: "Google Calendar", text: "From Google Takeout: one memory per event, with its time, place and description." },
  { title: "Notion", text: "Every page of a workspace from its Markdown export, with the pages it sits under." },
  { title: "GitHub", text: "A repository's commits or your recent activity, one memory per day, asked from your browser with a token that is never saved." },
];

export default function ImportPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Import"
          title="Bring your history with you"
          lead="Years of conversations sit inside ChatGPT and Claude. Download your export, drop it here, and it becomes memories in your own vault, encrypted on this device before anything is stored."
        />

        <section className="page-section" aria-labelledby="drop-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Start here</p>
              <h2 id="drop-title" className="section-title">
                Drop the export, your vault does the rest
              </h2>
              <p className="section-lead">
                The file is handed to your vault in this browser tab. If the vault is locked you unlock it first, or create one, and the import
                continues from there.
              </p>
              <ul className="checklist">
                <li>
                  <span>Takes the zip from the export email, or the conversations.json inside it.</span>
                </li>
                <li>
                  <span>Nothing is saved until you have seen the preview and pressed Import.</span>
                </li>
                <li>
                  <span>
                    No export yet? <Link href="/vault">Open your vault</Link> and write your first memories by hand.
                  </span>
                </li>
              </ul>
            </div>
            <ImportDrop />
          </div>
        </section>

        <section className="page-section" aria-labelledby="sources-title">
          <h2 id="sources-title" className="section-title">
            Where to find your export
          </h2>
          <div className="grid grid-2">
            {sources.map(({ name, Icon, steps, becomes }) => (
              <article key={name} className="card guide-card">
                <h3 className="guide-card-title">
                  <Icon /> From {name}
                </h3>
                <ol className="guide-steps">
                  {steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p className="guide-card-sub">What it becomes</p>
                <ul className="plain-list">
                  {becomes.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="page-section" aria-labelledby="more-title">
          <div className="section-header">
            <h2 id="more-title" className="section-title">
              The rest of your life, from the Import tab
            </h2>
            <p className="section-lead">
              In your vault, under Import, choose where from. Each is read and encrypted in your browser, with a preview, a folder choice and no
              doubles. None needs an app&apos;s approval.
            </p>
          </div>
          <div className="grid grid-3">
            {more.map((m) => (
              <article key={m.title} className="card">
                <h3 className="card-title">{m.title}</h3>
                <p className="card-text">{m.text}</p>
              </article>
            ))}
          </div>
          <p className="card-link">
            <Link href="/vault#import">Open Import in your vault</Link>
          </p>
        </section>

        <section className="page-section" aria-labelledby="facts-title">
          <h2 id="facts-title" className="section-title">
            What happens to the file
          </h2>
          <div className="fact-grid">
            {facts.map((f) => (
              <div key={f.title} className="pillar">
                <h3 className="pillar-title">{f.title}</h3>
                <p className="pillar-text">{f.text}</p>
              </div>
            ))}
          </div>
        </section>

        <PageLinks hrefs={["/apps", "/how-it-works", "/security"]} />
      </div>
    </div>
  );
}
