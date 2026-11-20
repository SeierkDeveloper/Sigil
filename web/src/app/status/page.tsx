import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { StatusBoard } from "@/components/live/StatusBoard";
import { CodeBlock } from "@/components/CodeBlock";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Status",
  description: "Live health of the Sigil service and its hourly seal job, read from the server.",
};

export default function StatusPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Status"
          title="Is Sigil working right now"
          lead="This page asks the server directly, from your browser, every half minute. Nothing here is written by hand."
        />

        <StatusBoard />

        <section className="page-section" aria-labelledby="means-title">
          <h2 id="means-title" className="section-title">
            What each line means
          </h2>
          <div className="fact-grid">
            <div className="pillar">
              <h3 className="pillar-title">Site and API</h3>
              <p className="pillar-text">The server that stores vaults and answers the vault page and the connector. If it does not answer, this page says so.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Vault database</h3>
              <p className="pillar-text">Where the encrypted vaults live. The status request reads from it, so an answer means it is reachable.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Seal job</h3>
              <p className="pillar-text">Folds every finished hour of reads into one seal. A fault means reads from a finished hour are still unsealed.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Seals on chain</h3>
              <p className="pillar-text">Whether seal roots are also published to the SigilSeal contract. Today they are not: seals are local.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">Waiting reads</h3>
              <p className="pillar-text">Reads made in the running hour. They are sealed when the hour is over, never earlier.</p>
            </div>
            <div className="pillar">
              <h3 className="pillar-title">The counts</h3>
              <p className="pillar-text">Totals only. Nothing in them names a person, a vault, an app or a memory.</p>
            </div>
          </div>
        </section>

        <section className="page-section page-section-narrow" aria-labelledby="self-title">
          <h2 id="self-title" className="section-title">
            Ask it yourself
          </h2>
          <p className="section-lead">The same two public endpoints this page uses. No key is needed.</p>
          <CodeBlock code={`curl ${site.url}/api/status\ncurl ${site.url}/api/stats`} label="Terminal" />
        </section>

        <PageLinks hrefs={["/seals", "/docs/api", "/security"]} />
      </div>
    </div>
  );
}
