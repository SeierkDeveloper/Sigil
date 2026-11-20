import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "The thirteen stages from an encrypted memory vault to an AI self that works, earns and outlives you on your terms.",
};

type Status = "built" | "core" | "started" | "planned";

interface Stage {
  title: string;
  summary: string;
  status: Status;
  items: { text: string; built?: boolean }[];
}

const STATUS_LABEL: Record<Status, string> = {
  built: "Built",
  core: "Core built",
  started: "Started",
  planned: "Planned",
};

const stages: Stage[] = [
  {
    title: "The vault",
    status: "built",
    summary: "A place for what your AI apps should know about you, encrypted on your device before it is stored.",
    items: [
      { text: "Sign in with a passkey or a wallet, with a recovery phrase", built: true },
      { text: "Encryption on your device; the server stores ciphertext only", built: true },
      { text: "Memories with titles, tags, folders, sources and dates", built: true },
      { text: "One-step import of ChatGPT and Claude exports", built: true },
      { text: "Dashboard: memories, folders, apps, read log, export, real delete", built: true },
    ],
  },
  {
    title: "Every AI, one memory",
    status: "built",
    summary: "Every assistant you use reads the same vault, only where you allow it, and every read is on the record.",
    items: [
      { text: "One connector for Claude, Cursor, ChatGPT and any MCP client", built: true },
      { text: "Permissions per app and per folder, revoke at any time", built: true },
      { text: "A read log you can see, sealed every hour", built: true },
      { text: "Seal publishing on chain, written and tested, switched on once the contract is deployed", built: true },
      { text: "A memory inbox: apps suggest, you approve", built: true },
      { text: "A browser extension for selections, pages and ChatGPT and Claude conversations", built: true },
      { text: "Sign in with Sigil, for web apps", built: true },
      { text: "Folders shared with other vaults, read only, revoked by a new key", built: true },
    ],
  },
  {
    title: "Your whole digital life",
    status: "planned",
    summary: "The vault fills itself from the places your life already happens, with your permission.",
    items: [
      { text: "Sync from email, calendar, team chat, notes, code and cloud files" },
      { text: "Meetings turned into memories" },
      { text: "Ask your life: questions answered from everything at once" },
      { text: "Separate vaults for health, money and legal papers" },
    ],
  },
  {
    title: "Memory that thinks",
    status: "started",
    summary: "The vault stops being a filing cabinet and starts helping.",
    items: [
      { text: "Search by meaning, run on your device", built: true },
      { text: "Duplicates found and merged", built: true },
      { text: "A timeline of every memory, by date and source", built: true },
      { text: "A Self card that apps read first", built: true },
      { text: "Stale facts flagged" },
      { text: "Timelines of people, projects and places" },
      { text: "Briefs before meetings and decisions" },
      { text: "A fully local mode" },
    ],
  },
  {
    title: "Your AI self",
    status: "planned",
    summary: "A model of you that answers from your vault, within your rules, and says so when it does not know.",
    items: [
      { text: "A personal model trained only on what you allow" },
      { text: "Answers only from the vault, clearly marked as AI" },
      { text: "Negotiates and replies within limits you set" },
      { text: "Public selves for creators and experts" },
    ],
  },
  {
    title: "Agents get memory",
    status: "planned",
    summary: "The same vault, for the AI agents that work for you and your team.",
    items: [
      { text: "Vaults for AI agents" },
      { text: "Shared spaces for teams" },
      { text: "Clean handoff from one agent to the next" },
      { text: "A memory for a whole company" },
    ],
  },
  {
    title: "The memory economy",
    status: "planned",
    summary: "What you know has value. You decide who may use it, and on what terms.",
    items: [
      { text: "Knowledge packs you can license" },
      { text: "Your data, at your price" },
      { text: "Provable facts: prove something is true without showing the data" },
    ],
  },
  {
    title: "Trust",
    status: "planned",
    summary: "Make it easy to see which AI apps treat your memory well.",
    items: [
      { text: "A privacy score for every connected app, from what it reads" },
      { text: "An open standard for permissioned memory access" },
    ],
  },
  {
    title: "Everywhere",
    status: "planned",
    summary: "Your vault on every device, and safe for the long run.",
    items: [
      { text: "A phone app" },
      { text: "Recovery through people you trust" },
      { text: "Legacy: what happens to your vault, decided in advance" },
      { text: "A network of nodes that store sealed data" },
    ],
  },
  {
    title: "Devices",
    status: "planned",
    summary: "Memory that comes with you, in the things around you.",
    items: [
      { text: "Wearables and glasses" },
      { text: "Car and home" },
      { text: "Emergency medical access you set up in advance" },
    ],
  },
  {
    title: "Your AI self in the world",
    status: "planned",
    summary: "Your AI self can work, meet others and keep learning, within your limits.",
    items: [
      { text: "Hire the AI selves of experts" },
      { text: "Introductions between AI selves" },
      { text: "AI selves that take on paid work" },
      { text: "An AI self that keeps learning from your vault" },
    ],
  },
  {
    title: "Proof of a real life",
    status: "planned",
    summary: "Years of sealed history become a way to prove you are a real, continuous person, without biometrics.",
    items: [
      { text: "Proof of human from sealed history, with zero-knowledge proofs" },
      { text: "Sealed agreements" },
      { text: "A learning record you own" },
    ],
  },
  {
    title: "Collective memory",
    status: "planned",
    summary: "What people choose to share becomes a memory larger than any one of us, run by the people in it.",
    items: [
      { text: "Shared lived experience, opt in only" },
      { text: "A collective brain anyone can ask" },
      { text: "Sigil's own memory model" },
      { text: "Permanent storage" },
      { text: "Nodes and governance of the protocol" },
      { text: "$SIGIL, the network token for network fees, node staking and verification" },
    ],
  },
];

const pillars = [
  { title: "An AI self with its own identity", text: "It has its own record and can sign and act, always within limits you set." },
  { title: "It works while you live", text: "It can answer, advise and take on work for you, on your terms." },
  { title: "It outlives you", text: "The people you choose can talk to it later, by rules you write in advance." },
  { title: "Proof of a real life", text: "Years of sealed history show that a real person stands behind it." },
  { title: "Selves meet selves", text: "AI selves can find each other for work, teams and deals." },
  { title: "A network run by its users", text: "Storage, verification and decisions spread across the people who use it." },
];

export default function Roadmap() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Roadmap"
          title="From a vault to an AI self"
          lead="Sigil starts as an encrypted memory every AI can read with your permission. Step by step it becomes an AI self that is yours: it can act, work and outlive you, on terms you set. No dates are promised; each stage ships when it is ready."
        />

        <section className="pillars" aria-labelledby="pillars-title">
          <h2 id="pillars-title" className="section-title">
            Six ideas behind every stage
          </h2>
          <div className="grid grid-3">
            {pillars.map((p) => (
              <div key={p.title} className="pillar">
                <h3 className="pillar-title">{p.title}</h3>
                <p className="pillar-text">{p.text}</p>
              </div>
            ))}
          </div>
        </section>

        <h2 className="section-title">Thirteen stages</h2>
        <ol className="stages">
          {stages.map((s, i) => (
            <li key={s.title} className="stage" data-status={s.status}>
              <span className="stage-number">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="stage-head">
                  <h3 className="stage-title">{s.title}</h3>
                  <span className={s.status === "planned" ? "badge" : "badge badge-strong"}>{STATUS_LABEL[s.status]}</span>
                </div>
                <p className="stage-summary">{s.summary}</p>
                <ul className="stage-items">
                  {s.items.map((it) => (
                    <li key={it.text} className="stage-item" data-built={it.built ? "true" : "false"}>
                      {it.text}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
        <p className="faint small">
          Plans can change. Nothing on this page is an offer, a promise of any return, or advice. Details of the network token will be published before
          that stage begins.
        </p>
      </div>
    </div>
  );
}
