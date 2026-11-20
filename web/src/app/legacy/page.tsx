import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";

export const metadata: Metadata = {
  title: "Legacy",
  description:
    "Your AI self can outlive you. Name the people who receive your vault, which folders each gets and whether they may talk to your AI self. They open it together, in their own browsers, only after you have been away for the period you chose.",
};

const steps = [
  {
    title: "You name them",
    text: "By their vault code, with a fingerprint you compare, or by an invite link that only works for the person who opens it with their own vault. For each person: the folders they receive, and whether they may talk to your AI self.",
  },
  {
    title: "You choose when and how many",
    text: "Three, six or twelve months without a sign of you, and how many of them must act together. With two of three, no single person can open anything alone.",
  },
  {
    title: "Your browser seals it",
    text: "It makes a legacy key, splits it into shares with Shamir's secret sharing, and seals each share to one person's vault. What each person receives is sealed to that person too. Sigil stores sealed boxes and never holds a share.",
  },
  {
    title: "Every sign of life counts",
    text: "Any sign-in or vault action moves the next check-in on, and you can check in by hand. A first and a last warning are written to your read log and shown when you come back.",
  },
  {
    title: "After the period, they act together",
    text: "One asks for a release. The others pass their shares, sealed to the keys you named. The shares are combined in a browser, and each person opens exactly what you left them, nothing more.",
  },
  {
    title: "Your AI self, in legacy mode",
    text: "If you allowed it, they can talk to it. It follows your rules, reads only the folders that person received, says plainly that it is in legacy mode, and every question and answer is sealed into your log.",
  },
];

export default function LegacyPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Legacy"
          title="Your AI self can outlive you"
          lead="Name the people who should receive your vault if you stop using it. They can open it only together, only after the time you chose, and only in their own browsers. Until then, nobody can, Sigil included."
        />

        <section className="page-section" aria-labelledby="legacy-how">
          <h2 id="legacy-how" className="section-title">
            How it works
          </h2>
          <ol className="steps steps-3">
            {steps.map((s) => (
              <li key={s.title} className="step">
                <h3 className="step-title">{s.title}</h3>
                <p className="step-text">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="page-section" aria-labelledby="legacy-who">
          <h2 id="legacy-who" className="section-title">
            Who can do what
          </h2>
          <div className="grid grid-3">
            <article className="card">
              <span className="card-number">Sigil</span>
              <h3 className="card-title">Keeps the clock, relays boxes</h3>
              <p className="card-text">
                Stores the sealed shares and bundles, decides when the period is over, and passes shares between trusted people. It cannot open a share,
                a bundle or the legacy key.
              </p>
            </article>
            <article className="card">
              <span className="card-number">One trusted person</span>
              <h3 className="card-title">Sees that they are named</h3>
              <p className="card-text">
                Who named them, what they would receive and how many people it takes. With more than one needed, their share alone opens nothing.
              </p>
            </article>
            <article className="card">
              <span className="card-number">Enough of them, later</span>
              <h3 className="card-title">Open what is theirs</h3>
              <p className="card-text">
                Together, after the period, each opens their own bundle in their own vault: the folders you left them, read only, and your AI self if
                you allowed it. Not each other&apos;s.
              </p>
            </article>
          </div>
        </section>

        <section className="page-section" aria-labelledby="legacy-limits">
          <h2 id="legacy-limits" className="section-title">
            The honest limits
          </h2>
          <ul className="plain-list">
            <li>
              The server decides when the period has passed. It cannot open anything on its own, but a server working together with enough of your
              trusted people could hand out the shares early. Choose people you trust with what you leave them.
            </li>
            <li>Sigil has no email or other channel to warn you. Warnings show in your vault and your read log, so choose a period you will not miss.</li>
            <li>What a person opened during a release stays with them, even if you come back. Coming back closes the plan, and sealing it again makes a new key.</li>
            <li>Changing the plan makes a new legacy key and new shares for everyone. A folder that gets a new key is sealed into the plan again.</li>
          </ul>
          <p className="muted">
            Set it up under <Link href="/vault#legacy">Legacy</Link> in your vault. The details, step by step, are in the <Link href="/docs#legacy">docs</Link>.
          </p>
        </section>

        <PageLinks hrefs={["/ai-self", "/threat-model", "/roadmap"]} />
      </div>
    </div>
  );
}
