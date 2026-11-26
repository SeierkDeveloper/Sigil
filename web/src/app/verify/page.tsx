import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { Verifier } from "@/components/live/Verifier";
import { CertificateChecker } from "@/components/live/CertificateChecker";
import { DocumentChecker } from "@/components/live/DocumentChecker";

export const metadata: Metadata = {
  title: "Verify",
  description: "Check a Sigil seal, a read-log entry, a life certificate, a proof of a fact, a sealed agreement, an identity statement, a knowledge pack or a receipt of an AI self: in your browser, or with a few lines of your own code.",
};

const rules = `leaf  = SHA-256( 0x00 || data )
node  = SHA-256( 0x01 || min(a, b) || max(a, b) )

data  = "sigil-read-v1" \\n id \\n appId \\n kind \\n memoryId
        \\n count \\n at \\n salt        (joined with newlines)

An unpaired node at the end of a level moves up unchanged.
The root of an hour is its seal.`;

const script = `import { createHash } from "node:crypto";

const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (h) => Buffer.from(h.slice(2), "hex");

// 1. The fingerprint, from the entry you copied out of your read log.
const e = { id: "", appId: "", kind: "read", memoryId: "", count: 1, at: "", salt: "", hour: 0 };
const data = ["sigil-read-v1", e.id, e.appId, e.kind, e.memoryId ?? "", String(e.count), e.at, e.salt].join("\\n");
let node = sha(Buffer.from([0]), Buffer.from(data, "utf8"));
const leaf = "0x" + node.toString("hex");

// 2. The proof and the published seal, from the public API.
const site = "https://<your Sigil site>";
const { proof } = await (await fetch(\`\${site}/api/seals/\${e.hour}/proof?leaf=\${leaf}\`)).json();
const { seal } = await (await fetch(\`\${site}/api/seals/\${e.hour}\`)).json();

// 3. Walk up: pairs are sorted before hashing, so no left or right flags are needed.
for (const sibling of proof.map(hex)) {
  const [lo, hi] = Buffer.compare(node, sibling) <= 0 ? [node, sibling] : [sibling, node];
  node = sha(Buffer.from([1]), lo, hi);
}
console.log("0x" + node.toString("hex") === seal.root ? "verified" : "NOT verified");`;

export default function VerifyPage() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Verify"
          title="Check it yourself, by hand"
          lead="Your vault checks a log entry against its seal with one button. This page is the long way round: the same check, with every step in the open, with code you can run without trusting ours, and checkers for life certificates, proofs of a fact, agreements, identity statements, knowledge packs and receipts."
        />

        <section className="page-section" aria-labelledby="tool-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">In this browser</p>
              <h2 id="tool-title" className="section-title">
                Three ways to check
              </h2>
              <ol className="mini-steps">
                <li>
                  <strong>A fingerprint.</strong> Paste the salted hash of one read and choose its hour. The server sends the sibling fingerprints,
                  this page hashes its way up and compares with the published seal.
                </li>
                <li>
                  <strong>A log entry.</strong> In your vault, open Read log, press Verify on a sealed row and then Copy entry. Paste it here. The
                  fingerprint is computed on this page from the entry and its salt; only the fingerprint leaves your browser.
                </li>
                <li>
                  <strong>A proof by hand.</strong> Paste a root, a fingerprint and the proof lines. Nothing is sent anywhere; the page only does
                  the arithmetic.
                </li>
              </ol>
              <p className="muted">
                Every step of the walk is shown under the result, so you can compare the numbers with your own run of the script below.
              </p>
            </div>
            <div className="panel">
              <Verifier />
            </div>
          </div>
        </section>

        <section className="page-section" id="certificate" aria-labelledby="cert-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Proof of a real life</p>
              <h2 id="cert-title" className="section-title">
                A life certificate
              </h2>
              <p className="section-lead">
                A vault can show that it has a long, continuous sealed history without showing anything in it. Open a certificate from its link, or drop the file here.
              </p>
              <ol className="mini-steps">
                <li>
                  <strong>The signature.</strong> The whole certificate is signed by the vault&apos;s own signing key, which is made from its vault key.
                </li>
                <li>
                  <strong>Each hour.</strong> Every listed hour carries a statement, signed by the same key, that the vault was open in that hour.
                </li>
                <li>
                  <strong>Each proof.</strong> Each statement hashes to a leaf, and its proof leads to the root listed for that hour.
                </li>
                <li>
                  <strong>The summary.</strong> First and last seal, hours and days with activity and the longest gap are counted again here.
                </li>
                <li>
                  <strong>The roots.</strong> Each root is compared with the seal this site publishes, and with SigilSeal on chain when the seals are anchored.
                </li>
              </ol>
              <p className="muted">
                What it proves: whoever could open that vault signed in each of those hours, and the site sealed it then. It does not prove who that is, that they are one person,
                or anything about what is in the vault. While seals are not anchored, the site holds the list of roots.
              </p>
            </div>
            <div className="panel">
              <CertificateChecker />
            </div>
          </div>
        </section>

        <section className="page-section" id="proof" aria-labelledby="proof-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">Signed by a vault</p>
              <h2 id="proof-title" className="section-title">
                A proof, an agreement, an identity, a pack or a receipt
              </h2>
              <p className="section-lead">
                Open a proof from its link, or drop any of these files here. The page tells them apart by their first line and checks each in this browser.
              </p>
              <ol className="mini-steps">
                <li>
                  <strong>A proof of a fact.</strong> One claim, signed by the vault&apos;s key, with its evidence, and the statement sealed in the hour it was made.
                  Sealed history and team spaces are checked in full here. A single field or an age is the owner&apos;s own statement: signed and committed, not checked by anyone
                  else.
                </li>
                <li>
                  <strong>A sealed agreement.</strong> The text and both parties hash to the fingerprint both vaults signed, and the fingerprint is in the seal of the hour it was
                  signed.
                </li>
                <li>
                  <strong>An identity statement.</strong> What an owner says about their AI self, signed by the vault and by the self&apos;s own key.
                </li>
                <li>
                  <strong>A knowledge pack.</strong> A public folder signed by its publisher&apos;s vault, version by version.
                </li>
                <li>
                  <strong>A receipt of the AI self.</strong> Something the self did on its own within its owner&apos;s limits, signed by the self&apos;s key. Its fingerprint
                  is in the seal of the hour it was made, and the root is compared with the one this site published.
                </li>
              </ol>
              <p className="muted">
                None of these says who a person is. A proof of an age rests on what the owner wrote in their own vault; zero-knowledge proofs, where nobody sees the date and a
                checker still computes the age, are on the <Link href="/roadmap">roadmap</Link>.
              </p>
            </div>
            <div className="panel">
              <DocumentChecker />
            </div>
          </div>
        </section>

        <section className="page-section" aria-labelledby="rules-title">
          <div className="split split-top">
            <div>
              <p className="eyebrow">The rules</p>
              <h2 id="rules-title" className="section-title">
                What a seal is made of
              </h2>
              <p className="section-lead">
                Two hash rules and one line format. The same rules are implemented in the browser, on the server and in the SigilSeal contract, so
                one proof checks in all three.
              </p>
              <ul className="checklist">
                <li>
                  <span>The salt is 32 random bytes per entry. Without it a fingerprint cannot be linked to a read.</span>
                </li>
                <li>
                  <span>Pairs are sorted before hashing, so a proof is just a list of siblings.</span>
                </li>
                <li>
                  <span>Leaves and inner nodes use different prefixes, so one can never pass for the other.</span>
                </li>
              </ul>
            </div>
            <CodeBlock code={rules} label="Seal rules" />
          </div>
        </section>

        <section className="page-section" aria-labelledby="own-title">
          <div className="section-header">
            <h2 id="own-title" className="section-title">
              With your own code
            </h2>
            <p className="section-lead">
              A complete check in plain Node.js, with no Sigil code in it. Paste your entry into <code>e</code>, set the address, and run it with{" "}
              <code>node verify.mjs</code>.
            </p>
          </div>
          <CodeBlock code={script} label="verify.mjs" language="js" />
        </section>

        <section className="page-section" aria-labelledby="proves-title">
          <h2 id="proves-title" className="section-title">
            What a passed check proves
          </h2>
          <div className="grid grid-2">
            <article className="card">
              <span className="card-number">It proves</span>
              <h3 className="card-title">The entry is in the seal, unchanged</h3>
              <p className="card-text">
                Exactly this entry, with this app, this memory, this count and this time, was part of the hour&apos;s seal when it was made. Change
                one character and the fingerprint no longer leads to the root.
              </p>
            </article>
            <article className="card">
              <span className="card-number">It does not prove</span>
              <h3 className="card-title">That nothing else happened</h3>
              <p className="card-text">
                A seal cannot show that a server wrote every request down, and while seals are local, Sigil holds the list of roots. Publishing
                roots on chain closes the second gap and is on the <Link href="/roadmap">roadmap</Link>. Both limits are in the{" "}
                <Link href="/threat-model">threat model</Link>.
              </p>
            </article>
          </div>
        </section>

        <PageLinks hrefs={["/seals", "/docs/api", "/threat-model"]} />
      </div>
    </div>
  );
}
