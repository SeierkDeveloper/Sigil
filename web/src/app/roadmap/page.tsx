import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { releases } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "What Sigil builds next: an AI self that knows your whole life, learns to act like you, proves things without showing them, meets other selves and lives on a network nobody can switch off.",
};

type Horizon = "next" | "later" | "vision";

interface Stage {
  title: string;
  summary: string;
  horizon: Horizon;
  items: string[];
}

const HORIZON_LABEL: Record<Horizon, string> = { next: "Next", later: "Later", vision: "Vision" };

// Only what is not built yet. Everything built is in the changelog.
const stages: Stage[] = [
  {
    title: "Ask your whole life",
    horizon: "next",
    summary: "Your whole life within reach of one question: the people, projects and places in it, a brief before every meeting, and all of it on your own machine.",
    items: [
      "Living timelines of the people, projects and places in your life, built and kept current by the vault",
      "A brief before every meeting and decision: what was promised, what changed, what was left open",
      "A fully local mode: a model on your own machine, so nothing leaves it, not even to a model provider",
      "Unlock in under two seconds with a vault of 100,000 memories: headers first, bodies decrypted as you read",
    ],
  },
  {
    title: "A model of you",
    horizon: "next",
    summary: "A personal model trained on your device, only on the folders you allow, that writes, ranks and decides the way you do.",
    items: [
      "Fine-tuning on your device from the folders you choose, with the weights encrypted in your vault and moved with it",
      "Every lesson it learns shown in plain words, with a way to undo one lesson or roll the whole model back to a date",
      "Your style, priorities and limits measured against your own past answers, with a score for how well it knows you",
      "One model for every app: Claude, ChatGPT and Cursor all talk to the same you, through the connector",
    ],
  },
  {
    title: "A self that acts",
    horizon: "next",
    summary: "Your AI self moves from drafts to actions, inside limits you set and can see at all times.",
    items: [
      "Negotiates times, prices and terms within ranges you set, and stops to ask at the edge of them",
      "Runs your inbox and calendar end to end, with thresholds for what it may send or accept on its own",
      "Its wallet goes live: payments under your caps and allow-list, every one signed, sealed and stoppable",
      "Every action carries a receipt anyone you show it to can verify against the seals",
    ],
  },
  {
    title: "Proofs that show nothing",
    horizon: "later",
    summary: "Zero-knowledge proofs, so you can prove a fact about your life to anyone without showing the life behind it.",
    items: [
      "Age, membership, history length and any field of a memory, proved without revealing the value",
      "Proof of a real, continuous human from years of sealed history, with no biometrics and no document scan",
      "Apps ask a question and receive a proof as the answer, never the data",
      "Privacy scores shared between owners as proofs, so you learn how an app behaves without anyone sharing a log",
    ],
  },
  {
    title: "The network of selves",
    horizon: "later",
    summary: "AI selves find each other for work, teams and deals, and nobody has to expose a vault to be found.",
    items: [
      "Private matching: two selves learn what they have in common, and nothing else, before either owner is asked",
      "A reputation built only from sealed agreements kept and broken, portable to any node",
      "Rooms where many selves meet at once, end to end encrypted, with every owner holding the transcript",
      "Introductions your self makes for you, ranked by fit, sent only with your yes",
    ],
  },
  {
    title: "Recovery and inheritance",
    horizon: "later",
    summary: "You never lose your vault, and the people you choose never lose you.",
    items: [
      "Recovery through people you trust: any three of five bring your vault back, none of them can open it alone",
      "Your legacy self speaks in your voice and style to the people you chose, from what you left for them",
      "Time capsules: memories and messages that open on a date, an age or an event you define",
      "A last instruction set: what is deleted, what is kept, what is passed on, carried out by the network",
    ],
  },
  {
    title: "Memory for organisations",
    horizon: "later",
    summary: "The same keys and seals for companies and their fleets of agents.",
    items: [
      "A company memory with roles, where every read by a person or an agent is sealed",
      "Agent fleets that share one memory, with handoffs, budgets and a full audit trail",
      "Requests to see or delete a person's data answered from the vault in one step, with a sealed receipt",
    ],
  },
  {
    title: "Everywhere you are",
    horizon: "vision",
    summary: "Sigil in every device you carry and every place you live, without a central server in the middle.",
    items: [
      "Native apps for phones, computers and watches, syncing directly between your own devices",
      "Glasses and wearables that capture hands-free into the inbox, sealed on the device",
      "Car and home: your self knows where you are going and what the house needs, within the rules you set",
    ],
  },
  {
    title: "A network nobody can switch off",
    horizon: "vision",
    summary: "Your sealed data kept by many independent nodes, so Sigil outlives any company, including ours.",
    items: [
      "Nodes keep encrypted, erasure-coded copies of each other's vaults, so losing any node loses nothing",
      "Proofs that every copy is still held, checked by the network every hour",
      "The protocol governed by the people who run nodes and the people who use them",
    ],
  },
  {
    title: "The memory economy",
    horizon: "vision",
    summary: "What you know and what your self can do become things you can offer, on your terms.",
    items: [
      "Licensed knowledge packs and paid sessions with expert selves, priced by their owners",
      "Your data offered at your price, for a purpose you approve, revoked when you say",
      "Sigil's own memory model, trained only on what people chose to share",
      "The network token, paid for network fees and burned on use",
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
          title="What comes next"
          lead="Everything on this page is still to be built. Each stage ships when it is ready; no dates are promised."
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

        <p className="small">
          Built so far, in {releases.length} releases: the vault, every AI app through one connector, sealed logs, your AI self, agents, legacy, proofs,
          emergency access, your own node and a security review.{" "}
          <Link href="/changelog">See everything that is built</Link>.
        </p>

        <h2 className="section-title">Ten stages ahead</h2>
        <ol className="stages">
          {stages.map((s, i) => (
            <li key={s.title} className="stage" data-status={s.horizon}>
              <span className="stage-number">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="stage-head">
                  <h3 className="stage-title">{s.title}</h3>
                  <span className={s.horizon === "next" ? "badge badge-strong" : "badge"}>{HORIZON_LABEL[s.horizon]}</span>
                </div>
                <p className="stage-summary">{s.summary}</p>
                <ul className="stage-items">
                  {s.items.map((it) => (
                    <li key={it} className="stage-item" data-built="false">
                      {it}
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
