import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "How it works",
  description: "How a Sigil vault is created, filled, shared with AI apps and kept under your control.",
};

const sections = [
  {
    id: "create",
    title: "1. Create your vault",
    body: (
      <>
        <p>
          Open the vault and choose how you want to sign in: a <strong>passkey</strong> (Face ID, Touch ID, Windows Hello, a phone or a security key)
          or a <strong>wallet</strong>. Your browser then makes a random vault key. That key never leaves your device in readable form.
        </p>
        <p>
          The vault key is locked with a key that only your passkey or wallet can produce, and a second copy is locked with a <strong>24-word recovery
          phrase</strong> that Sigil shows you once. Write it down. If you lose every passkey, every wallet and the phrase, nobody can open the vault,
          including Sigil.
        </p>
      </>
    ),
  },
  {
    id: "fill",
    title: "2. Fill it",
    body: (
      <>
        <p>
          A memory has a title, a body, tags and a folder. Write them yourself, or import the data export you can download from ChatGPT or Claude:
          every conversation becomes one memory, with the date it happened. Claude projects, their documents and what Claude remembered come along too.
        </p>
        <p>The export file is opened and encrypted in your browser. Sigil&apos;s server only ever receives the encrypted result.</p>
      </>
    ),
  },
  {
    id: "folders",
    title: "3. Sort it into folders",
    body: (
      <p>
        Folders are how you share. Each folder has its own key, so you can let a coding assistant read <em>Work</em> without it ever being able to open
        <em> Health</em>. Search runs in your browser across everything you can see.
      </p>
    ),
  },
  {
    id: "connect",
    title: "4. Connect an AI app",
    body: (
      <>
        <p>
          In the vault, go to <strong>Apps</strong>, name the app, and tick the folders it may read. Sigil makes an <strong>app key</strong> for it,
          shown once. You paste that key into the Sigil connector, a small program you run on your own computer, and add the connector to Claude
          Desktop, Cursor, ChatGPT or any other app that speaks MCP (the Model Context Protocol).
        </p>
        <p>
          The app key holds the secret that unlocks the folders you picked. The server keeps only a fingerprint of it, so it cannot use the key
          itself.
        </p>
      </>
    ),
  },
  {
    id: "read",
    title: "5. Your AI reads what it needs",
    body: (
      <>
        <p>The connector gives the AI three tools: list the folders it may read, search memories, and read one memory in full.</p>
        <p>
          When the AI searches, the connector downloads the encrypted titles, tags and first lines of the memories in its folders, decrypts them on
          your computer and searches there. Your search words never reach Sigil. When the AI wants a whole memory, the connector asks for that one
          memory, and the server writes the read to your log before it answers.
        </p>
      </>
    ),
  },
  {
    id: "log",
    title: "6. Every read goes on the record",
    body: (
      <p>
        The <strong>read log</strong> in your vault shows which app read what, and when. At the end of every hour, all reads from that hour are
        combined into one fingerprint (a Merkle root), the seal for that hour. Your vault can check any entry against its seal in your browser.
        Today seals are kept by Sigil; publishing them on chain, where nobody could change them, is a planned step and the contract for it is already
        written.
      </p>
    ),
  },
  {
    id: "control",
    title: "7. Change your mind at any time",
    body: (
      <>
        <p>
          <strong>Change permissions</strong> to add or remove folders for an app. <strong>Revoke</strong> an app and its key stops working on the
          very next request, and its copies of your folder keys are deleted from the server.
        </p>
        <p>
          <strong>Delete</strong> a memory, a folder or your whole account and it is removed from the database, not hidden. <strong>Export</strong>{" "}
          gives you everything, decrypted, as one file.
        </p>
        <p>
          One honest limit: once an AI app has read a memory, what that app does with it is governed by that app, not by Sigil. Share folders with
          apps you trust.
        </p>
      </>
    ),
  },
];

const serverSees = [
  "That an account exists, and when it was made",
  "Which sign-in methods it has (a passkey's public key, a wallet address)",
  "How many folders and memories there are, their sizes and when they changed",
  "Which app read which memory, and when (the read log)",
];

const onlyYouSee = [
  "Every title, body, tag and folder name",
  "The names of your connected apps",
  "Your search words",
  "Your vault key, folder keys, app keys and recovery phrase",
];

export default function HowItWorks() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="How it works"
          title="Your memory, your keys, your rules"
          lead="Sigil is a vault for what your AI apps should know about you. Here is everything that happens, from the first sign-in to deleting it all."
        />
        <div className="prose">
          {sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>

        <section className="section" aria-labelledby="who-sees">
          <div className="section-header">
            <h2 id="who-sees" className="section-title">
              Who can see what
            </h2>
          </div>
          <div className="grid grid-2">
            <article className="card">
              <h3 className="card-title">What Sigil&apos;s server can see</h3>
              <ul className="checklist small">
                {serverSees.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </article>
            <article className="card">
              <h3 className="card-title">What only you (and apps you allow) can see</h3>
              <ul className="checklist small">
                {onlyYouSee.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </article>
          </div>
          <p className="card-link">
            The details are on the <Link href="/security">security page</Link>.
          </p>
        </section>
      </div>
    </div>
  );
}
