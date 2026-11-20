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
    status: "started",
    summary: "The vault fills itself from the places your life already happens, with your permission.",
    items: [
      { text: "Local imports, parsed and encrypted in the browser: Obsidian, Apple Notes, Gmail and Google Calendar from Takeout, Notion, GitHub", built: true },
      { text: "An Obsidian folder kept in sync through the inbox by the connector", built: true },
      { text: "Live sync from Gmail, Google Calendar, Google Drive and Slack, fetched and encrypted on your device, in the background through the connector", built: true },
      { text: "Meeting transcripts from Zoom, Meet and Teams turned into meeting memories: who was there, decisions, promises", built: true },
      { text: "Protected folders for health, money and legal papers: every read needs your yes, with redaction on the device", built: true },
      { text: "Ask your life: questions answered from everything at once" },
      { text: "More sources: other mail and calendar providers, other team chats and file stores" },
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
      { text: "A weekly brief: what is new, what changed, what was forgotten", built: true },
      { text: "Memories that disagree, shown for you to resolve", built: true },
      { text: "Every duplicate group merged after one approval", built: true },
      { text: "Expiry dates, with real deletion after a grace period", built: true },
      { text: "Timelines of people, projects and places" },
      { text: "Briefs before meetings and decisions" },
      { text: "A fully local mode" },
    ],
  },
  {
    title: "Your AI self",
    status: "started",
    summary: "A model of you that answers from your vault, within your rules, and says so when it does not know.",
    items: [
      { text: "Version 1: answers as you from chosen folders, within your rules, with your own model key", built: true },
      { text: "Ask links: end to end encrypted, with their own rules and limits, every answer in your log", built: true },
      { text: "ask_self for apps you allow, answered on your machine", built: true },
      { text: "A personal model trained only on what you allow" },
      { text: "A public AI self at /@you, answering anyone from the folders you made public, every answer in your log", built: true },
      { text: "Works for you into an approval queue: replies, a plan for the week and answers to people, nothing sent on its own", built: true },
      { text: "Learns how you write from the edits you make to its drafts, in notes you can read, change and delete", built: true },
      { text: "Its own identity: a key made from your vault key, a statement signed by both, and a registry contract", built: true },
      { text: "Its own wallet, used only within your caps, recipients, functions and end date; you can freeze it at any time (contract written and tested, not deployed)", built: true },
      { text: "Talk to it by voice: speech to text on your device, and answers read aloud by a voice on your device, in the test chat, on ask links and on the public page", built: true },
      { text: "Negotiates and replies within limits you set" },
    ],
  },
  {
    title: "Agents get memory",
    status: "core",
    summary: "The same vault, for the AI agents that work for you and your team.",
    items: [
      { text: "Vaults for AI agents: their own folder and key, read and write rules, remember, recall, forget", built: true },
      { text: "Team spaces shared by vaults and agents, with roles and a new key when someone is removed", built: true },
      { text: "Sealed handoff notes from one agent session, or one agent, to the next", built: true },
      { text: "Shared memory for families and teams: a timeline of stories with people and photos, who added what, heirs, and a copy to print", built: true },
      { text: "A memory for a whole company" },
    ],
  },
  {
    title: "The memory economy",
    status: "started",
    summary: "What you know has value. You decide who may use it, and on what terms.",
    items: [
      { text: "Knowledge packs: a folder published as a signed pack that other vaults and AI selves follow, version by version, free", built: true },
      { text: "Provable facts, version 1: one field, an age, sealed history or a team space, signed and sealed, showing nothing else", built: true },
      { text: "Provable facts with zero-knowledge proofs, so a checker computes an age from a date nobody sees" },
      { text: "Packs you can license, and paid work, once the network has its own means of payment" },
      { text: "Your data, at your price" },
    ],
  },
  {
    title: "Trust",
    status: "core",
    summary: "Make it easy to see which AI apps treat your memory well.",
    items: [
      { text: "A privacy score for every connected app and agent, from your own read log", built: true },
      { text: "An open standard for permissioned memory access, version 1.2, with test vectors from the code", built: true },
      { text: "Scores shared between owners, without sharing their logs" },
    ],
  },
  {
    title: "Everywhere",
    status: "started",
    summary: "Your vault on every device, and safe for the long run.",
    items: [
      { text: "An installable app for phones and computers: offline, a share target, quick capture with photos", built: true },
      { text: "Add a device by QR code, with keys sealed to that device only, and revoke it", built: true },
      { text: "Capture from anywhere: a write-only key for each phone, watch or shortcut, sealed on the device that sends", built: true },
      { text: "Your whole vault as one encrypted bundle, kept where you choose (a file, your bucket, IPFS or Arweave) and restored on any node", built: true },
      { text: "Run your own node with one command, and move your vault between nodes with a statement your key signs", built: true },
      { text: "Legacy: trusted people, split keys, an inactivity period and a release they open together", built: true },
      { text: "Recovery through people you trust" },
      { text: "Native apps in the app stores" },
      { text: "Nodes that keep copies of each other's sealed data" },
    ],
  },
  {
    title: "Devices",
    status: "started",
    summary: "Memory that comes with you, in the things around you.",
    items: [
      { text: "Wearables and glasses" },
      { text: "Car and home" },
      { text: "Emergency medical access you set up in advance: a card behind a code on your lock screen that only its link opens", built: true },
    ],
  },
  {
    title: "Your AI self in the world",
    status: "started",
    summary: "Your AI self can work, meet others and keep learning, within your limits.",
    items: [
      { text: "Selves meet selves, version 1: two AI selves talk after both owners said yes, end to end encrypted, to find a time, check a collab or swap intros", built: true },
      { text: "Sessions with the AI selves of experts: booked, free, under house rules, every answer marked as AI", built: true },
      { text: "AI selves that take on paid work" },
      { text: "An AI self that keeps learning from your vault" },
    ],
  },
  {
    title: "Proof of a real life",
    status: "started",
    summary: "Years of sealed history become a way to prove you are a real, continuous person, without biometrics.",
    items: [
      { text: "Version 1: a signed certificate of continuous sealed history, checked in any browser against the seals", built: true },
      { text: "Proof of human from sealed history, with zero-knowledge proofs" },
      { text: "Sealed agreements: one text, two vault signatures over one fingerprint, sealed in both logs, amendments as new versions", built: true },
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
      { text: "Storage spread across the network's nodes" },
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
