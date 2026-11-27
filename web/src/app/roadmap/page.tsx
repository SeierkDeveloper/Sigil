import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { releases } from "@/lib/changelog";
import { HORIZON_LABEL, stages } from "@/lib/roadmap";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "What Sigil builds next: an AI self that knows your whole life, learns to act like you, proves things without showing them, meets other selves and lives on a network nobody can switch off.",
};

/** An engraved seal for a completed stage: a square set on its point with a check cut into it. */
function DoneMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="m5.4 8.1 1.8 1.8 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  );
}

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
          lead="What Sigil builds next. A filled mark is already live; everything else is still to be built. Each stage ships when it is ready; no dates are promised."
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
          Built so far, in {releases.length} releases: the vault, every AI app through one connector, sealed logs, your AI self and a self that acts, agents, legacy, proofs,
          emergency access, your own node and a security review.{" "}
          <Link href="/changelog">See everything that is built</Link>.
        </p>

        <h2 className="section-title">Ten stages ahead</h2>
        <ol className="stages">
          {stages.map((s, i) => (
            <li key={s.title} className="stage" data-status={s.horizon} data-done={s.done ? "true" : undefined}>
              <span className="stage-number">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="stage-head">
                  <h3 className="stage-title">{s.title}</h3>
                  <span className={s.horizon === "built" || s.horizon === "now" || s.horizon === "next" ? "badge badge-strong" : "badge"}>{HORIZON_LABEL[s.horizon]}</span>
                  {s.done ? (
                    <span className="stage-done" data-testid="stage-done">
                      <DoneMark /> Done, every part live since {s.done}
                    </span>
                  ) : null}
                </div>
                <p className="stage-summary">{s.summary}</p>
                <ul className="stage-items">
                  {(s.built ?? []).map((it) => (
                    <li key={it} className="stage-item" data-built="true">
                      {it}
                    </li>
                  ))}
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
