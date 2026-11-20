import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { ArrowIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "The AI self",
  description: "The long-term idea behind Sigil: an AI self that is yours, built on a memory you own. A vision, not a list of features that exist.",
};

const chapters = [
  {
    when: "Today",
    status: "Built",
    title: "A memory that is yours",
    text: [
      "Every AI app you use is building a memory of you, and every one of them keeps it for itself. Change apps and you start again as a stranger. Leave an app and what it learned stays behind.",
      "Sigil starts by turning that around. What your AI apps should know about you lives in one vault, encrypted on your own device. The apps come to you and ask to read, folder by folder, and every read goes on a record you can check.",
    ],
  },
  {
    when: "Next",
    status: "Vision",
    title: "A memory that fills itself and thinks",
    text: [
      "A vault you fill by hand stays small. The plan is for it to fill from the places your life already happens, with your permission each time: mail, calendar, notes, code, meetings.",
      "Then it starts to help: search by meaning that runs on your device, stale facts flagged, timelines of the people and projects in your life, a brief before a meeting. Still encrypted, still yours.",
    ],
  },
  {
    when: "Later",
    status: "Vision",
    title: "A self that can answer for you",
    text: [
      "With enough memory, a model can answer the way you would. Not a chatbot with your name on it: a model trained only on what you allow, that answers only from your vault, says so when it does not know, and is always marked as AI.",
      "It could reply to the questions you get every week, negotiate within limits you set, and stand in for you where you choose. You would see everything it said, the same way you see every read today.",
    ],
  },
  {
    when: "Later",
    status: "Vision",
    title: "A self that works while you live",
    text: [
      "An AI self with its own identity could take on work: answer as an expert, advise, do paid tasks, meet other AI selves for teams and deals. Always within limits written by you, always on your record.",
      "What you know has value. The idea is that you decide who may use it and on what terms, instead of a platform deciding for you.",
    ],
  },
  {
    when: "Far",
    status: "Vision",
    title: "A self that outlives you",
    text: [
      "Years of sealed history are something no one can fake in an afternoon. They could become a way to prove that a real, continuous person stands behind an AI self, without biometrics.",
      "And they could let the people you choose talk to it after you are gone, by rules you wrote in advance: who, what, and for how long. Your memory, on your terms, forever.",
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
          lead="This page is where Sigil is going, not what it does today. Today Sigil is an encrypted memory vault with a connector, a read log and hourly seals. Everything past the first chapter below is a plan."
        />

        <p className="notice vision-note">
          <span>
            Only the first chapter exists. The rest is the long-term idea, told as a story. No dates are promised, plans can change, and nothing
            here is an offer or a promise of any return. What is built and what is planned, item by item, is on the{" "}
            <Link href="/roadmap">roadmap</Link>.
          </span>
        </p>

        <ol className="chapters">
          {chapters.map((c, i) => (
            <li key={c.title} className="chapter" data-built={c.status === "Built" ? "true" : "false"}>
              <div className="chapter-side">
                <span className="chapter-number">{String(i + 1).padStart(2, "0")}</span>
                <span className="chapter-when">{c.when}</span>
                <span className={c.status === "Built" ? "badge badge-strong" : "badge"}>{c.status}</span>
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
            <p className="section-lead">An AI self is only as real as the memory under it. That part exists, and you can start filling it today.</p>
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
