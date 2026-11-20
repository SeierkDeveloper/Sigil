import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { SealList } from "@/components/SealList";
import { LatestSeal } from "@/components/live/LatestSeal";
import { Verifier } from "@/components/live/Verifier";

export const metadata: Metadata = {
  title: "Seals",
  description: "The public list of Sigil's hourly seals, with a proof checker that runs in your browser.",
};

const how = [
  { title: "A read happens", text: "A connected app lists folders, reads the index or reads a memory. The request is written to that vault's read log." },
  { title: "It gets a fingerprint", text: "The entry is hashed together with a random 32-byte salt that only the vault's owner can see." },
  { title: "The hour closes", text: "All fingerprints of the hour, from every vault, are folded pair by pair into one Merkle root." },
  { title: "The root is the seal", text: "It is published on this page and never changed. Any entry can be proven to be part of it." },
];

export default function SealsPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Seals"
          title="Every hour of reads, sealed into one fingerprint"
          lead="A seal is the Merkle root of every read that connected apps made in one hour. It shows nothing about who read what, and it lets the owner of a vault prove that an entry in their log has not been changed or left out."
        />

        <section className="page-section" aria-labelledby="latest-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Live</p>
              <h2 id="latest-title" className="section-title">
                The latest seal on this server
              </h2>
              <p className="section-lead">
                Read straight from the server. When an hour with reads in it ends, a new seal appears here by itself.
              </p>
              <ol className="mini-steps">
                {how.map((h) => (
                  <li key={h.title}>
                    <strong>{h.title}.</strong> {h.text}
                  </li>
                ))}
              </ol>
            </div>
            <LatestSeal />
          </div>
        </section>

        <section className="page-section" aria-labelledby="check-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Proof checker</p>
              <h2 id="check-title" className="section-title">
                Check a fingerprint against its seal
              </h2>
              <p className="section-lead">
                Choose the seal and paste a fingerprint. The server answers with the list of sibling fingerprints; your browser does the hashing and
                compares the result with the published root.
              </p>
              <ul className="checklist">
                <li>
                  <span>The check runs on this page, with the same open-source code your vault uses.</span>
                </li>
                <li>
                  <span>A fingerprint is a salted hash. Asking about one reveals nothing about the read behind it.</span>
                </li>
                <li>
                  <span>
                    To check a whole log entry, or a proof with no server involved, use <Link href="/verify">Verify</Link>.
                  </span>
                </li>
              </ul>
            </div>
            <div className="panel">
              <Verifier modes={["fingerprint"]} />
            </div>
          </div>
        </section>

        <section className="page-section" aria-labelledby="list-title">
          <div className="section-header">
            <h2 id="list-title" className="section-title">
              The public list
            </h2>
            <p className="section-lead">
              The newest 48 seals. Local means the seal is kept by this server. Publishing seals on chain, so that not even Sigil could change one
              later, is written and tested but not switched on yet.
            </p>
          </div>
          <SealList limit={48} />
        </section>

        <PageLinks hrefs={["/verify", "/security", "/status"]} />
      </div>
    </div>
  );
}
