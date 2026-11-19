import Link from "next/link";
import { AppMakers } from "@/components/AppMakers";
import { HeroVisual } from "@/components/hero/HeroVisual";
import { ArrowIcon, CheckIcon, ClaudeIcon, EyeIcon, ImportIcon, LockIcon, SealIcon } from "@/components/icons";

const promises = [
  {
    icon: LockIcon,
    title: "Encrypted before it leaves your device",
    text: "Your memories are encrypted in your browser with keys made from your passkey or wallet. Sigil's server stores ciphertext and cannot read a word of it.",
  },
  {
    icon: EyeIcon,
    title: "Every AI you use, one memory",
    text: "Claude, ChatGPT, Cursor and other assistants read your vault through one connector, and only the folders you allow each of them to see.",
  },
  {
    icon: SealIcon,
    title: "Every read on the record",
    text: "Each time an app reads your vault, it is written to a log you can see. Every hour the log is sealed with a fingerprint you can check yourself.",
  },
];

const steps = [
  { title: "Create your vault", text: "Sign in with a passkey or a wallet. You get a 24-word recovery phrase; nobody else holds a copy." },
  { title: "Fill it", text: "Write memories, sort them into folders, or import your ChatGPT and Claude history in one step." },
  { title: "Connect your AI apps", text: "Make an app key, pick the folders that app may read, and add the connector to Claude, Cursor or ChatGPT." },
  { title: "Stay in charge", text: "Watch the read log, change permissions, revoke an app or delete everything, at any time." },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <div>
            <p className="eyebrow">A memory vault for every AI you use</p>
            <h1 className="hero-title">
              Your AI self, owned by you, <em>forever.</em>
            </h1>
            <p className="hero-lead">
              Sigil keeps what your AI apps should know about you in one vault that is encrypted on your own device. You decide which app may read
              which part, and you can see every read.
            </p>
            <div className="hero-actions">
              <Link href="/vault" className="button button-primary">
                Open your vault <ArrowIcon />
              </Link>
              <Link href="/how-it-works" className="button">
                How it works
              </Link>
            </div>
          </div>
          <HeroVisual />
        </div>
      </section>

      <section className="works-with">
        <div className="container">
          <p className="works-with-label">Reads into</p>
          <AppMakers />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Why Sigil</p>
            <h2 className="section-title">One memory that belongs to you, not to an app</h2>
            <p className="section-lead">
              Every AI app keeps its own memory of you, locked inside that app. Sigil turns it around: you keep the memory, and the apps ask to read it.
            </p>
          </div>
          <div className="grid grid-3">
            {promises.map(({ icon: Icon, title, text }) => (
              <article key={title} className="card">
                <span className="card-icon">
                  <Icon />
                </span>
                <h3 className="card-title">{title}</h3>
                <p className="card-text">{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">How it works</p>
            <h2 className="section-title">Four steps, then it simply works in the background</h2>
            <p className="section-aside">
              <Link href="/how-it-works" className="arrow-link">
                The full walk-through <ArrowIcon />
              </Link>
            </p>
          </div>
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.title} className="step">
                <h3 className="step-title">{s.title}</h3>
                <p className="step-text">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">Permissions</p>
            <h2 className="section-title">Each app sees only what you choose</h2>
            <p className="section-lead">
              Permissions are set per app and per folder, in plain words. An app with no access to a folder never receives its keys, so it could not
              read that folder even if it tried.
            </p>
            <ul className="checklist">
              <li>
                <CheckIcon />
                <span>Read only. Connected apps can search and read, never write or delete.</span>
              </li>
              <li>
                <CheckIcon />
                <span>Revoke with one click. The app&apos;s key stops working on its very next request.</span>
              </li>
              <li>
                <CheckIcon />
                <span>Decryption happens on your own computer, inside the connector you run.</span>
              </li>
            </ul>
          </div>
          <div className="permission-card" aria-label="Example of an app's permissions">
            <div className="permission-app">
              <ClaudeIcon /> Claude Desktop
            </div>
            <ul className="permission-list">
              <li className="permission-item" data-allowed="true">
                <span>Work</span>
                <span className="badge">Can read</span>
              </li>
              <li className="permission-item" data-allowed="true">
                <span>Writing</span>
                <span className="badge">Can read</span>
              </li>
              <li className="permission-item" data-allowed="false">
                <span>Health</span>
                <span className="badge">No access</span>
              </li>
              <li className="permission-item" data-allowed="false">
                <span>Money</span>
                <span className="badge">No access</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container grid grid-2">
          <article className="card">
            <span className="card-icon">
              <ImportIcon />
            </span>
            <h3 className="card-title">Bring your history with you</h3>
            <p className="card-text">
              Download your data export from ChatGPT or Claude and drop it into Sigil. It is opened, sorted and encrypted in your browser; every
              conversation becomes a memory you can search, edit or share with another app.
            </p>
            <p className="card-link">
              <Link href="/docs#import" className="arrow-link">
                How to import <ArrowIcon />
              </Link>
            </p>
          </article>
          <article className="card">
            <span className="card-icon">
              <SealIcon />
            </span>
            <h3 className="card-title">A seal every hour</h3>
            <p className="card-text">
              At the end of each hour, every read from that hour is folded into a single fingerprint, a Merkle root. Your vault can prove that any
              entry in your log is part of its seal, without showing anyone else what was read.
            </p>
            <p className="card-link">
              <Link href="/security#seals" className="arrow-link">
                How seals work <ArrowIcon />
              </Link>
            </p>
          </article>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">Where this goes</p>
            <h2 className="section-title">From a vault to an AI self</h2>
            <p className="section-lead">
              The vault is the first stage. Over time Sigil grows into an AI self that answers in your voice within your rules, can work and earn for
              you, and can outlive you on terms you set in advance.
            </p>
            <Link href="/roadmap" className="button">
              See the roadmap
            </Link>
          </div>
          <ul className="checklist">
            <li>
              <CheckIcon />
              <span>
                <strong>Built:</strong> the encrypted vault, imports, folders and the dashboard.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <strong>Built:</strong> one connector for every MCP client, per-app permissions, revoke, the read log and hourly seals.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <strong>Next:</strong> a browser extension, seals published on chain, and the rest of your digital life in one place.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className="section cta-band">
        <div className="container container-narrow">
          <h2 className="section-title">Start with what you already told your AI apps</h2>
          <p className="section-lead">Create a vault, import your history, and connect your first app in a few minutes.</p>
          <div className="hero-actions">
            <Link href="/vault" className="button button-primary">
              Open your vault <ArrowIcon />
            </Link>
            <Link href="/docs" className="button">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
