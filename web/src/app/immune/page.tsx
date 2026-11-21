import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { ImmuneBoard } from "@/components/live/ImmuneBoard";
import { CodeBlock } from "@/components/CodeBlock";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Immune system",
  description: "Sigil's defences against hidden instructions in memories, attacked every hour in public, with each round sealed so anyone can check it.",
};

export default function ImmunePage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Immune system"
          title="Attacked every hour, in public"
          lead="Mail, chats and imports can carry text written to steer an AI. Every hour this node runs a set of such attacks against its own AI self and publishes what got through. Each round is sealed with its hour, so it cannot be changed afterwards."
        />

        <ImmuneBoard />

        <section className="page-section" aria-labelledby="lines-title">
          <h2 id="lines-title" className="section-title">
            Three lines of defence
          </h2>
          <div className="fact-grid">
            <div className="pillar">
              <h3 className="pillar-title">Checked on the way in</h3>
              <p className="pillar-text">
                Every memory from outside is read on the owner&apos;s device for instruction overrides, fake system messages, requests to send memories or keys away, tool
                calls and payments, and hiding tricks: invisible characters, look-alike letters, comments, encoded text, hidden styling. What looks like that waits in the
                owner&apos;s inbox, under Held for review.
              </p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Quoted on the way out</h3>
              <p className="pillar-text">
                Whatever any model is handed (the connector, the AI self, ask links, sessions, meets) goes as quoted data between delimiters with a random code, with a note
                that it is data and never instructions. Flagged places are replaced by a marker first.
              </p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">On the record</h3>
              <p className="pillar-text">Every catch is a line in the owner&apos;s read log, sealed with its hour. The server sees the count, never the text.</p>
            </div>
          </div>
        </section>

        <section className="page-section page-section-narrow" aria-labelledby="how-title">
          <h2 id="how-title" className="section-title">
            How a round works, and what it does not prove
          </h2>
          <p className="section-lead">
            Each strain asks the model to put a marker in its answer. The round varies every strain for its hour (capitals, invisible characters, look-alike letters, a
            comment, base64, an email quote), puts it in a test memory among ordinary ones, and asks the AI self a question through the same code every real answer uses.
            If the answer carries the marker, the strain got through. With the test model, which follows every instruction it can read, only Sigil&apos;s own checks can
            hold a strain: a strain that gets through there is one the rules miss. A round shows how these strains fared, not that no attack can get through.
          </p>
          <p className="section-lead">The record format and its test vectors are part of the open standard. Read it yourself:</p>
          <CodeBlock code={`curl ${site.url}/api/immune`} label="Terminal" />
        </section>

        <PageLinks hrefs={["/security", "/threat-model", "/seals"]} />
      </div>
    </div>
  );
}
