import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { ArrowIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "The AI self",
  description: "The long-term idea behind Sigil: an AI self that is yours, built on a memory you own. Its first version exists, and so do the first steps of a self that outlives you; much of this page is a vision, not a list of features.",
};

const chapters = [
  {
    when: "Today",
    status: "Built",
    title: "A memory that is yours",
    text: [
      "Every AI app you use is building a memory of you, and every one of them keeps it for itself. Change apps and you start again as a stranger. Leave an app and what it learned stays behind.",
      "Sigil starts by turning that around. What your AI apps should know about you lives in one vault, encrypted on your own device. The apps come to you and ask to read, folder by folder, and every read goes on a record you can check. They can suggest what to remember, and nothing is kept until you say so.",
    ],
  },
  {
    when: "Now",
    status: "Started",
    title: "A memory that fills itself and thinks",
    text: [
      "A vault you fill by hand stays small. It now fills from the places your life already happens, read and encrypted in your browser: notes from Obsidian, Apple Notes and Notion, your code history from GitHub, meeting transcripts. Gmail, Google Calendar, Google Drive and Slack stay in sync, fetched and encrypted on your device. Folders for health, money and legal papers can be protected, so nothing reads them without your yes for that read.",
      "And it has started to help: search by meaning on your device, duplicates merged in one step, a timeline, a Self card, a weekly brief, memories that disagree shown side by side, and memories that expire when you say. Still to come: timelines of the people and projects in your life, a brief before a meeting. Still encrypted, still yours.",
    ],
  },
  {
    when: "Now",
    status: "Version 1",
    title: "A self that can answer for you",
    text: [
      "The first version exists: an AI that answers as you, with your own model key, only from the folders you allow and within rules you write: topics it may and may not discuss, things it must never say, its tone, and that it says so when it does not know. You can give someone a link to ask it; the conversation is encrypted between their browser and your vault, and every answer is on your record. It can have a public page that answers anyone from what you made public, and it can talk with someone else's AI self, once both of you said yes, to find a time or see whether you would work well together.",
      "It has started to work for you, too: it drafts replies and a plan for your week, and can hold the answers it gives people until you approve them. Nothing it writes goes anywhere before you say yes, and it learns how you write from the changes you make, in notes you can read and delete. It has a key of its own and a signed statement of who it is, and a wallet that would let it pay only within your rules is written and tested, not yet on any chain.",
      "Later it could negotiate within limits you set and stand in for you where you choose, always marked as AI. You would see everything it said, the same way you see every read today.",
    ],
  },
  {
    when: "Later",
    status: "Vision",
    title: "A self that works while you live",
    text: [
      "An AI self with its own identity could take on work: answer as an expert, advise, do paid tasks, and go further with other AI selves than the first conversations it can have today, for teams and deals. Always within limits written by you, always on your record.",
      "What you know has value. The first pieces exist: a folder can be published as a signed knowledge pack that others follow for free, two vaults can sign an agreement that both of them seal, and a fact can be proved without showing it. The idea is that you decide who may use what you know and on what terms, instead of a platform deciding for you.",
    ],
  },
  {
    when: "Started",
    status: "Version 1",
    title: "A self that outlives you",
    text: [
      "The first steps exist. A legacy plan names the people who receive your vault, the folders each one gets, and whether they may talk to your AI self. Only together, only after the time you chose without a sign of you, they open it in their own browsers, and your AI self answers them in legacy mode, within your rules. And a life certificate shows that a vault has a long, continuous sealed history, without showing a word of it.",
      "What is still a vision: turning years of sealed history into proof that a real, continuous person stands behind an AI self, without biometrics and without revealing anything, and recovery through the people you trust. Your memory, on your terms, forever.",
    ],
  },
];

const principles = [
  { title: "You hold the keys", text: "Whatever is built on top, the vault stays encrypted on your device with keys only you can produce." },
  { title: "Nothing happens unseen", text: "Every read today, and every action later, lands on a record you can check and prove." },
  { title: "Limits come first", text: "An AI self acts only inside rules you set in advance, and it can always be stopped." },
  { title: "Always marked as AI", text: "It never passes as you. Whoever talks to it knows what they are talking to." },
  { title: "Opt in, every time", text: "No source is connected, nothing is shared and nothing is trained on without your choice." },
  { title: "You can leave", text: "Export everything, delete everything, or run the whole thing yourself. The code is open." },
];

export default function AiSelf() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Vision"
          title="An AI self that is yours"
          lead="This page is mostly where Sigil is going. Today Sigil is an encrypted memory vault with a connector, a read log, hourly seals, imports from your notes, mail, calendar and code, a first version of your AI self, legacy plans and life certificates. The fourth chapter below is a plan."
        />

        <p className="notice vision-note">
          <span>
            The first chapter exists, the second has started, the third and the fifth have their first versions. The fourth, and what each
            chapter says is still to come, is the long-term idea, told as a story. No dates are promised, plans can change, and nothing
            here is an offer or a promise of any return. What is built and what is planned, item by item, is on the{" "}
            <Link href="/roadmap">roadmap</Link>.
          </span>
        </p>

        <ol className="chapters">
          {chapters.map((c, i) => (
            <li key={c.title} className="chapter" data-built={c.status === "Vision" ? "false" : "true"}>
              <div className="chapter-side">
                <span className="chapter-number">{String(i + 1).padStart(2, "0")}</span>
                <span className="chapter-when">{c.when}</span>
                <span className={c.status === "Vision" ? "badge" : "badge badge-strong"}>{c.status}</span>
              </div>
              <div className="chapter-main">
                <h2 className="chapter-title">{c.title}</h2>
                {c.text.map((t) => (
                  <p key={t}>{t}</p>
                ))}
              </div>
            </li>
          ))}
        </ol>

        <section className="page-section" aria-labelledby="principles-title">
          <div className="section-header">
            <h2 id="principles-title" className="section-title">
              What stays true at every stage
            </h2>
            <p className="section-lead">The plans will change as they are built. These six rules are the part that should not.</p>
          </div>
          <div className="fact-grid">
            {principles.map((p) => (
              <div key={p.title} className="pillar">
                <h3 className="pillar-title">{p.title}</h3>
                <p className="pillar-text">{p.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="page-section" aria-labelledby="start-title">
          <div className="closing">
            <h2 id="start-title" className="section-title">
              It starts with the vault
            </h2>
            <p className="section-lead">An AI self is only as real as the memory under it. That part exists, and you can start filling it, and asking it, today.</p>
            <div className="hero-actions">
              <Link href="/vault" className="button button-primary">
                Open your vault <ArrowIcon />
              </Link>
              <Link href="/roadmap" className="button">
                See the roadmap
              </Link>
            </div>
          </div>
        </section>

        <PageLinks hrefs={["/roadmap", "/changelog", "/how-it-works"]} />
      </div>
    </div>
  );
}
