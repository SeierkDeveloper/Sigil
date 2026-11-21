import Link from "next/link";
import { AppMakers } from "@/components/AppMakers";
import { CodeBlock } from "@/components/CodeBlock";
import { Engraving } from "@/components/art/Engraving";
import { HeroTree } from "@/components/hero/HeroTree";
import { HeroVisual } from "@/components/hero/HeroVisual";
import { LatestSeal } from "@/components/live/LatestSeal";
import { LiveStats } from "@/components/live/LiveStats";
import {
  ArrowIcon,
  BookIcon,
  CheckIcon,
  ClaudeIcon,
  CodeIcon,
  ExtensionIcon,
  EyeIcon,
  FolderIcon,
  GitHubIcon,
  GlobeIcon,
  LockIcon,
  SealIcon,
  ShareIcon,
  AgentIcon,
  CertificateIcon,
  HourglassIcon,
  PhoneIcon,
} from "@/components/icons";
import { cipherText } from "@/lib/cipher";
import { EXAMPLE_KEY, mcpConfig } from "@/lib/connector";

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

const further = [
  {
    icon: HourglassIcon,
    title: "Your AI self outlives you",
    text: "Name the people who receive your vault, the folders each gets and whether they may talk to your AI self. They open it only together, only after the time you chose without a sign of you.",
    href: "/legacy",
    link: "How legacy works",
  },
  {
    icon: PhoneIcon,
    title: "On your phone and every device",
    text: "Install it like an app, add a device by scanning a code, and share text, links and photos into your inbox, sealed on the phone.",
    href: "/docs#devices",
    link: "Phone and devices",
  },
  {
    icon: AgentIcon,
    title: "Agents get their own memory",
    text: "Cursor, Claude Code and other agents remember, recall and leave notes for their next session, in folders and team spaces you set the rules for.",
    href: "/docs#agents",
    link: "Agent vaults",
  },
  {
    icon: CertificateIcon,
    title: "Proof of a real life",
    text: "A certificate that your vault has months of continuous sealed history, checked in anyone's browser, without showing a word of it.",
    href: "/verify#certificate",
    link: "Check a certificate",
  },
];

const steps = [
  { title: "Create your vault", text: "Sign in with a passkey or a wallet. You get a 24-word recovery phrase; nobody else holds a copy." },
  { title: "Fill it", text: "Write memories, sort them into folders, or import your ChatGPT and Claude history in one step." },
  { title: "Connect your AI apps", text: "Make an app key, pick the folders that app may read, and add the connector to Claude, Cursor or ChatGPT." },
  { title: "Stay in charge", text: "Watch the read log, change permissions, revoke an app or delete everything, at any time." },
];

const importSteps = [
  { label: "Opened", text: "The export is unpacked in this browser. The file itself is never uploaded." },
  { label: "Sorted", text: "Every conversation becomes one memory, dated, in a folder of its own." },
  { label: "Encrypted", text: "Each memory is locked with its folder's key before anything is stored." },
  { label: "Yours", text: "Search it, edit it, and decide which app may read which folder." },
];

const smart = [
  { title: "An inbox you approve", text: "Apps you allow suggest memories. Each waits, sealed for your vault, until you keep it, merge it or reject it." },
  { title: "Search by meaning", text: "Ask for your car and find the note about the automobile. The model runs in your browser; the question never leaves it." },
  { title: "A timeline and no doubles", text: "Every memory by the day it was written and where it came from, and duplicates found for you to merge." },
  { title: "A Self card", text: "A short card on who you are and how you like answers, which connected apps are asked to read first." },
];

const ways = [
  {
    icon: ExtensionIcon,
    title: "Save from the browser",
    text: "The extension sends a selection, a page, or a ChatGPT or Claude conversation to your inbox. It is encrypted in the browser, for your vault only.",
    href: "/docs#extension",
    link: "The browser extension",
  },
  {
    icon: GlobeIcon,
    title: "Sign in with Sigil",
    text: "A web app asks, you tick the folders it may read in a window on this site, and it gets a key of its own. Revoke it like any other app.",
    href: "/docs#sign-in-with-sigil",
    link: "For web apps",
  },
  {
    icon: ShareIcon,
    title: "Share a folder with another vault",
    text: "Swap a vault code, compare its fingerprint, and they can read that one folder. Stop sharing and the folder gets a new key.",
    href: "/docs#sharing",
    link: "How sharing works",
  },
];

// One record, as its owner sees it and as the server holds it.
const record: { field: string; you: string; seed: number; length: number }[] = [
  { field: "Title", you: "How I like answers", seed: 11, length: 28 },
  { field: "Body", you: "Short first, details after. Metric units.", seed: 12, length: 56 },
  { field: "Tags", you: "preferences, writing", seed: 13, length: 24 },
  { field: "Folder", you: "Writing", seed: 14, length: 16 },
  { field: "Shared with", you: "Claude Desktop", seed: 15, length: 20 },
];

const guarantees = [
  {
    title: "Apps cannot change your memories",
    text: "No connected app can change or delete a memory. An app you allow may suggest one; it waits in your inbox, sealed for your vault, until you approve it.",
  },
  { title: "Revoke takes one click", text: "A revoked app key fails on its very next request, and the server deletes the folder keys that were wrapped for it." },
  { title: "Delete means deleted", text: "Deleting removes the rows, and the database overwrites deleted content on disk instead of just unlinking it." },
  { title: "No reset, no back door", text: "Lose every passkey, every wallet and the recovery phrase and nobody can open the vault, including Sigil." },
  { title: "Nothing from third parties", text: "The site loads no outside scripts, fonts or trackers. Its content security policy allows the site itself and nothing else." },
  { title: "Open source", text: "The encryption, the server, the connector and the contract are public under the MIT licence. You can run all of it yourself." },
];

const faq = [
  {
    q: "Can Sigil read my memories?",
    a: "No. They are encrypted in your browser with a key that is only ever stored wrapped by your passkey, your wallet or your recovery phrase. The server holds ciphertext, ids, sizes and times.",
  },
  {
    q: "What happens if I lose my passkey?",
    a: "Sign in with your wallet or your 24-word recovery phrase, then add a new passkey under Settings. If you lose every way in, the vault cannot be opened by anyone. There is no reset.",
  },
  {
    q: "Which AI apps work with it?",
    a: "Any app that speaks MCP, the Model Context Protocol: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code and others start the connector themselves. ChatGPT reaches it over a private address that you run.",
  },
  {
    q: "Can an AI app change or delete what is in my vault?",
    a: "No. Connected apps can list the folders you gave them, search them and read memories. If you allow it, an app can also suggest a new memory, which waits in your inbox until you approve, merge or reject it. Nothing exists for an app to change or delete.",
  },
  {
    q: "What does an app see when I connect it?",
    a: "Only the folders you ticked for it, decrypted on your own computer by the connector. Folders you did not grant are never wrapped for that app, so its key cannot open them.",
  },
  {
    q: "What is my AI self?",
    a: "An AI that answers as you, from the folders you choose and within rules you write, using your own Anthropic or OpenAI key. It runs in your browser or in the connector on your machine, so Sigil never sees your memories, your rules or your key. You can let someone ask it through a link; every question and answer goes into your read log.",
  },
  {
    q: "What is a seal, and why should I care?",
    a: "At the end of every hour, all reads from that hour are folded into one fingerprint, a Merkle root. It lets you prove that an entry in your read log has not been changed or removed since, without showing anyone what was read.",
  },
  {
    q: "Is anything stored on a blockchain?",
    a: "Not by Sigil. Seals are kept by the Sigil server and marked Local; a contract that publishes seal roots on chain is written and tested but not deployed. If you choose Arweave as a place for your backups, your own device uploads your bundle there, encrypted, with your own key file. Nothing else of yours goes on a chain.",
  },
  {
    q: "What does it cost?",
    a: "The code is open source and free to run yourself. Creating a vault on this site costs nothing today.",
  },
  {
    q: "Can I leave?",
    a: "Yes. Export everything from Settings, decrypted on your device, and delete your account in one step. Or move your vault to another Sigil node, your own included, with a move your vault key signs.",
  },
  {
    q: "What if this site shuts down?",
    a: "Keep a copy of your vault: under Storage, download it as one encrypted bundle, or let it go to your own bucket, IPFS or Arweave every day or week. Any Sigil node, including one you run yourself with one command, restores it with your recovery phrase or wallet. How long a copy lasts depends on where you keep it.",
  },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <HeroTree />
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
        </div>
      </section>

      <section className="works-with">
        <div className="container">
          <p className="works-with-label">Reads into</p>
          <AppMakers />
        </div>
      </section>

      <section className="section section-views">
        <div className="container split">
          <div>
            <p className="eyebrow">One vault, five readers</p>
            <h2 className="section-title">The same six lines, as each reader gets them</h2>
            <p className="section-lead">
              You read all of it. Sigil&apos;s server holds ciphertext. Each app opens only the folders you gave it, and the rest stays locked.
            </p>
          </div>
          <HeroVisual />
        </div>
      </section>

      <section className="section section-stats">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Live from the server</p>
            <h2 className="section-title">What Sigil is holding right now</h2>
            <p className="section-lead">
              Counted by the server as you load this page. It can count what it holds. It cannot read it.
            </p>
          </div>
          <LiveStats />
          <p className="stats-foot">
            <Link href="/status" className="arrow-link">
              Service status <ArrowIcon />
            </Link>
          </p>
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
                <span>Read, and suggest only if you allow it. Connected apps never change or delete a memory.</span>
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
            <Link href="/apps" className="arrow-link split-link">
              Set up your app <ArrowIcon />
            </Link>
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
        <div className="container split">
          <ol className="import-flow" aria-label="What happens to an export">
            {importSteps.map((s, i) => (
              <li key={s.label} className="import-flow-step">
                <span className="import-flow-number">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="import-flow-label">{s.label}</p>
                  <p className="import-flow-text">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <p className="eyebrow">Import</p>
            <h2 className="section-title">Years of history, in your vault in a minute</h2>
            <p className="section-lead">
              Download your data export from ChatGPT or Claude and drop it into Sigil. Every conversation becomes a memory you can search, edit
              and share with another app. Claude projects, their documents and what Claude remembered come along too.
            </p>
            <div className="hero-actions">
              <Link href="/import" className="button button-primary">
                Import your history <ArrowIcon />
              </Link>
              <Link href="/docs#import" className="button">
                Where to find the export
              </Link>
            </div>
          </div>
        </div>
        <div className="container">
          <Engraving name="roots" grow="down" className="section-art section-art-roots" />
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">Smart memory</p>
            <h2 className="section-title">A memory that grows, with you at the door</h2>
            <p className="section-lead">
              Your apps can add to what they know about you, but only through your inbox. Everything that sorts and searches the vault runs on your
              own device, on text the server never sees.
            </p>
            <ul className="smart-list">
              {smart.map((f) => (
                <li key={f.title}>
                  <strong>{f.title}</strong>
                  <span>{f.text}</span>
                </li>
              ))}
            </ul>
            <Link href="/docs#inbox" className="arrow-link split-link">
              How the inbox works <ArrowIcon />
            </Link>
          </div>
          <div className="inbox-preview" aria-label="Example of a suggestion waiting in the inbox">
            <div className="inbox-preview-card">
              <div className="inbox-preview-head">
                <span className="mark" aria-hidden="true">
                  <ClaudeIcon />
                </span>
                <p>
                  <strong>Claude Desktop</strong>
                  <span>through the connector</span>
                </p>
                <span className="badge">
                  <LockIcon /> Sealed for you
                </span>
              </div>
              <p className="inbox-preview-title">Prefers metric units</p>
              <p className="inbox-preview-body">Asked twice for kilometres and Celsius instead of miles and Fahrenheit. Wants this in every answer.</p>
              <ul className="inbox-preview-facts">
                <li>
                  <FolderIcon />
                  <span>Suggested folder</span>
                  <strong>Writing</strong>
                </li>
                <li>
                  <i aria-hidden="true" />
                  <span>In your vault</span>
                  <strong>Something close</strong>
                </li>
              </ul>
              <div className="inbox-preview-actions" aria-hidden="true">
                <span data-kind="approve">Approve</span>
                <span>Merge</span>
                <span>Reject</span>
              </div>
              <div className="inbox-preview-stamp" aria-hidden="true">
                <span>
                  <CheckIcon />
                </span>
                Approved
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Ways in and out</p>
            <h2 className="section-title">Beyond the connector</h2>
            <p className="section-lead">
              Three more ways to reach a vault. Each one is granted by you, shows in your read log where it reads, and can be taken back.
            </p>
          </div>
          <div className="grid grid-3">
            {ways.map(({ icon: Icon, title, text, href, link }) => (
              <article key={title} className="card">
                <span className="card-icon">
                  <Icon />
                </span>
                <h3 className="card-title">{title}</h3>
                <p className="card-text">{text}</p>
                <p className="card-link">
                  <Link href={href} className="arrow-link">
                    {link} <ArrowIcon />
                  </Link>
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Further</p>
            <h2 className="section-title">After you, beside you, everywhere</h2>
            <p className="section-lead">
              The same keys and the same sealed record, carried further: to the people who come after you, to every device you own, to the agents
              that work for you, and into a proof that a real life stands behind a vault.
            </p>
          </div>
          <div className="grid grid-2">
            {further.map(({ icon: Icon, title, text, href, link }) => (
              <article key={title} className="card">
                <span className="card-icon">
                  <Icon />
                </span>
                <h3 className="card-title">{title}</h3>
                <p className="card-text">{text}</p>
                <p className="card-link">
                  <Link href={href} className="arrow-link">
                    {link} <ArrowIcon />
                  </Link>
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">Seals</p>
            <h2 className="section-title">A seal every hour, and you can check it</h2>
            <p className="section-lead">
              At the end of each hour, every read from that hour is folded into a single fingerprint, a Merkle root. Your vault can prove that any
              entry in your log is part of its seal, without showing anyone else what was read.
            </p>
            <ul className="checklist">
              <li>
                <CheckIcon />
                <span>A changed or removed log entry no longer matches its seal.</span>
              </li>
              <li>
                <CheckIcon />
                <span>Every fingerprint is salted, so a seal shows nothing about who read what.</span>
              </li>
              <li>
                <CheckIcon />
                <span>The check runs in your browser, with code you can read.</span>
              </li>
            </ul>
            <Link href="/verify" className="arrow-link split-link">
              Verify by hand <ArrowIcon />
            </Link>
          </div>
          <LatestSeal />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Two views of one memory</p>
            <h2 className="section-title">What you see, and what the server holds</h2>
            <p className="section-lead">
              The same record, on your screen and in Sigil&apos;s database. The left side exists only on your device, after you unlock the vault.
            </p>
          </div>
          <div className="compare" role="table" aria-label="One memory as you see it and as the server stores it">
            <div className="compare-head" role="row">
              <span role="columnheader" className="compare-field" />
              <span role="columnheader">On your device</span>
              <span role="columnheader">On Sigil&apos;s server</span>
            </div>
            {record.map((r) => (
              <div key={r.field} className="compare-row" role="row">
                <span role="rowheader" className="compare-field">
                  {r.field}
                </span>
                <span role="cell" className="compare-plain">
                  {r.you}
                </span>
                <span role="cell" className="compare-cipher" aria-label="Ciphertext">
                  v1.{cipherText(r.seed, r.length, 0)}
                </span>
              </div>
            ))}
            <div className="compare-row" role="row" data-shared="true">
              <span role="rowheader" className="compare-field">
                Size, dates, ids
              </span>
              <span role="cell" className="compare-plain">
                Visible
              </span>
              <span role="cell" className="compare-plain">
                Visible. The server needs them to store, sort and count.
              </span>
            </div>
          </div>
          <p className="stats-foot">
            <Link href="/threat-model" className="arrow-link">
              The full list of who can see what <ArrowIcon />
            </Link>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <p className="eyebrow">Security</p>
            <h2 className="section-title">Promises the code keeps</h2>
            <p className="section-lead">
              Each of these is something the software does today. The limits are written down just as plainly in the threat model.
            </p>
          </div>
          <div className="fact-grid">
            {guarantees.map((g) => (
              <div key={g.title} className="pillar">
                <h3 className="pillar-title">{g.title}</h3>
                <p className="pillar-text">{g.text}</p>
              </div>
            ))}
          </div>
          <div className="hero-actions section-actions">
            <Link href="/security" className="button">
              How the encryption works
            </Link>
            <Link href="/threat-model" className="button">
              The threat model
            </Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split split-top">
          <div>
            <p className="eyebrow">For developers</p>
            <h2 className="section-title">One connector, a few lines of configuration</h2>
            <p className="section-lead">
              The connector is a small MCP server that runs on your own machine and gives an AI app four tools that read, one that suggests
              memories to your inbox, and one that asks your AI self. Web apps use Sign in with Sigil. Everything is open source, and the API is small enough to read in one sitting.
            </p>
            <ul className="link-list">
              <li>
                <Link href="/connector">
                  <CodeIcon />
                  <span>
                    <strong>Connector</strong>
                    <span>The tools, the two modes and every setting</span>
                  </span>
                  <ArrowIcon />
                </Link>
              </li>
              <li>
                <Link href="/docs/api">
                  <BookIcon />
                  <span>
                    <strong>API reference</strong>
                    <span>Five public endpoints, three for connected apps</span>
                  </span>
                  <ArrowIcon />
                </Link>
              </li>
              <li>
                <Link href="/open-source">
                  <GitHubIcon />
                  <span>
                    <strong>Open source</strong>
                    <span>MIT licence. Run the whole thing yourself</span>
                  </span>
                  <ArrowIcon />
                </Link>
              </li>
            </ul>
          </div>
          <CodeBlock code={mcpConfig(EXAMPLE_KEY)} label="MCP configuration" language="json" />
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">Where this goes</p>
            <h2 className="section-title">From a vault to an AI self</h2>
            <p className="section-lead">
              Your AI self already answers as you, within your rules, and can outlive you on terms you set in advance. Next it learns to know
              your whole life, think like you and act for you.
            </p>
            <div className="hero-actions">
              <Link href="/ai-self" className="button">
                Read the vision
              </Link>
              <Link href="/roadmap" className="button">
                See the roadmap
              </Link>
            </div>
          </div>
          <ul className="checklist">
            <li>
              <CheckIcon />
              <span>
                <strong>Built:</strong> the vault, one connector for every AI app, sealed logs, your AI self with ask links, voice and a public page,
                live sync, agents and team spaces, legacy, proofs, emergency access, your own node and a full security review.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <strong>Next:</strong> ask your whole life in one question, a personal model of you trained on your device, and a self that acts
                within limits you set.
              </span>
            </li>
            <li>
              <CheckIcon />
              <span>
                <strong>Later:</strong> proofs that show nothing, a network of selves, recovery through people you trust, and a network nobody can
                switch off.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className="section">
        <div className="container faq-layout">
          <div>
            <p className="eyebrow">Questions</p>
            <h2 className="section-title">Asked before trusting a vault</h2>
            <p className="section-lead">Short answers. The long ones are under Trust in the menu.</p>
          </div>
          <div className="faq">
            {faq.map((f) => (
              <details key={f.q} className="faq-item">
                <summary>
                  <span>{f.q}</span>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section cta-band">
        <Engraving name="range" className="cta-band-art" />
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
