import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";

export const metadata: Metadata = {
  title: "Threat model",
  description: "What Sigil protects your vault against, what it does not, and what each party can see.",
};

const covered = [
  {
    threat: "Someone copies the server's database",
    answer:
      "They get ciphertext. Titles, bodies, tags, folder names and app names are encrypted on your device with keys the server never has. The database holds hashes of sign-in tokens, not the tokens.",
  },
  {
    threat: "Sigil itself wants to read your memories",
    answer:
      "It cannot. The vault key is made in your browser and only ever stored wrapped by a key from your passkey, your wallet or your recovery phrase.",
  },
  {
    threat: "Someone listens on the network",
    answer: "Everything that leaves your device is already encrypted, inside an encrypted connection. A listener sees sizes and timing at most.",
  },
  {
    threat: "A connected app reaches for folders it was not given",
    answer:
      "Folder keys are wrapped for an app only when you grant the folder. For any other folder the app holds no key, and the server refuses the request as well.",
  },
  {
    threat: "A connected app tries to write, change or delete",
    answer:
      "No request lets an app change or delete a memory. An app may only suggest one, and only if you turned that on for it; the suggestion waits in your inbox until you approve it, and each app may send 30 an hour.",
  },
  {
    threat: "The server hands an app a public key of its own, to read suggestions",
    answer:
      "The app checks the vault public key against a tag your vault made with the app's own secret, which the server never has. A swapped key fails the check and nothing is sealed.",
  },
  {
    threat: "Someone you shared a folder with keeps reading after you stop",
    answer:
      "Stopping gives the folder a new key on your device and encrypts every memory in it again. The old key opens nothing that is stored now. What they read before, they keep.",
  },
  {
    threat: "The server swaps the vault code when you share",
    answer:
      "The folder key is sealed to the public key in the code the other person gave you, and you can compare fingerprints with them. The server only passes the sealed key on.",
  },
  {
    threat: "A leaked or stolen app key",
    answer:
      "Revoke it in your vault. The server deletes its token hash and its wrapped folder keys, and the key fails on its very next request. Other apps keep working, because every app has its own key.",
  },
  {
    threat: "An encrypted record is moved or swapped",
    answer:
      "Every ciphertext is bound to the record it belongs to with authenticated data. A memory moved under another id, or a key moved to another folder, does not decrypt.",
  },
  {
    threat: "The read log is edited afterwards",
    answer:
      "Each hour of reads is sealed into one Merkle root. An entry that was changed no longer matches its fingerprint, and you can check any sealed entry against its seal in your browser.",
  },
  {
    threat: "The server reads or changes what is said through an ask link",
    answer:
      "Questions and answers are sealed between the asker's browser and your vault or connector, with a key derived from the link's key (which stays after the # and never reaches the server) and a fresh key for each conversation. A box that is changed or moved does not open. A server that hands out another link key is caught by the asker's page, which then sends nothing.",
  },
  {
    threat: "The server reads your model key or your AI self's rules",
    answer:
      "Both are encrypted with your vault key before they leave your browser, and for an app you allow, with a key from that app's own secret. Model calls go from your browser or connector straight to the provider.",
  },
  {
    threat: "Someone asks your AI self about things it should not discuss",
    answer:
      "It uses only the folders a link's rules allow. Denied topics are refused before the model is asked, an answer with a phrase it must never say is replaced on the device, and when nothing matches it says it does not know. Each link has an expiry, a total and an hourly limit, and you can turn it off at once.",
  },
  {
    threat: "Another site sends requests in your name",
    answer: "The session cookie cannot be read by scripts, and the vault API checks that every change comes from the Sigil site itself before it acts.",
  },
  {
    threat: "Guessing sign-ins or app keys",
    answer: "Secrets are 256 bits of randomness, and sign-in and connector requests are rate limited per address and per app.",
  },
  {
    threat: "Someone takes over the server and wants your legacy",
    answer:
      "It holds sealed shares and bundles it cannot open. The legacy key exists only in your browser and, after a release, in the browsers of your trusted people. Each bundle is sealed to one person's vault as well, so even the combined shares open only that person's part.",
  },
  {
    threat: "The server hands a new device its own key, or adds a member to a team space",
    answer:
      "A pairing code is a hash of the new device's key, so a swapped key fails the check before anything is sealed, and both screens show the same fingerprint. A space member carries a tag made with the space key; one the server added fails, and admins seal nothing until it is removed.",
  },
  {
    threat: "A lost or stolen phone",
    answer:
      "Revoke it under Devices: its key slot and every session it opened end at once, and it forgets its device key when it next reaches Sigil. Without the device key, its offline copy is ciphertext.",
  },
  {
    threat: "Your AI self sends something you did not approve",
    answer:
      "Drafts wait in the approval queue. A reply or a plan is only copied when you approve it; a held answer goes back only through the channel it came from, and only once you approve it. The server cannot read a draft.",
  },
  {
    threat: "Someone else registers your AI self's key, or uses its signature for another owner",
    answer:
      "The registry takes a self key only with that key's own signature over the owner's address, the metadata and a deadline. A signature for one owner fails for any other, and a revoked key can never be registered again.",
  },
  {
    threat: "The self key spends more than you allowed",
    answer:
      "The self wallet checks every call against your caps per payment and per day, the allowed recipients, contracts and functions, token caps and the end date, and refuses token moves it cannot cap. You can freeze it, change its rules or withdraw at any time. Tested with fuzzing; not deployed.",
  },
  {
    threat: "A proof shows more than its claim",
    answer: "Every field of a memory is committed with its own random salt, so revealing one field and its path to the commitment says nothing about the others, and an age proof keeps the date back.",
  },
  {
    threat: "The server reads your emergency card",
    answer: "It is encrypted with a key that is only in the code's link after the #, which browsers never send. The server stores and serves ciphertext, and keeps only a time, a device class and a language for each opening.",
  },
  {
    threat: "An agreement is changed after it was signed",
    answer:
      "Both vaults sign one SHA-256 fingerprint of the text and both parties; a changed word no longer matches either signature. The server checks each signature against the vault's own key, and the receiving vault refuses a document that does not name it with its own keys.",
  },
  {
    threat: "A server that swaps a knowledge pack",
    answer: "A follower pins the publisher's key at the first version and checks every later version against it and the version before. A version signed by any other key is not taken in.",
  },
];

const notCovered = [
  {
    threat: "Redaction that misses a number",
    answer:
      "Redaction masks common shapes of card, IBAN, account, ID, passport and phone numbers and email addresses. A number written in an unusual way can slip through. For records that must never leave, protect the folder rather than rely on masking.",
  },
  {
    threat: "Your own device after you say yes",
    answer:
      "On your own device every key is at hand; the protected gate there is the vault's own code. A yes lets the app or AI self have that read, and what it does with the text afterwards is up to it.",
  },
  {
    threat: "A server that swaps the key of a public AI self",
    answer:
      "The public page takes its key from the server, so a server that swapped it could read a visitor's question. It could not read anything private: the public self only answers from what you published.",
  },
  {
    threat: "What another self is told",
    answer:
      "In a conversation between two selves, the other owner and their model provider read everything your self says. Your self follows your rules, but rules can be worked around by careful wording. Give it only the folders you would share with that person.",
  },
  {
    threat: "Live sync services",
    answer: "Google and Slack see your sign-in and serve your data to your device under their own terms. Revoke Sigil's access in your account there as well as disconnecting here, if you want it gone on both sides.",
  },
  {
    threat: "A server and your trusted people working together",
    answer:
      "The server decides when your legacy plan's period is over. It cannot open anything alone, but together with enough of your trusted people it could hand out the shares early. And what a person opened during a release stays with them.",
  },
  {
    threat: "Reading more into a life certificate than it says",
    answer:
      "A certificate proves that whoever could open a vault signed in each listed hour and that the site sealed it then. It does not prove who that is, that it is one person, or that a person rather than a program kept the vault open.",
  },
  {
    threat: "Malware on the device where you unlock the vault",
    answer: "Whatever can read your screen or your browser's memory can read what you can read. Encryption protects the vault on the server and on the network, not on a compromised device.",
  },
  {
    threat: "What an AI app does with what it has read",
    answer: "Once an app reads a memory, that text is in the app's hands and its own policies apply. Revoking stops future reads, not past ones. The read log tells you exactly what it got.",
  },
  {
    threat: "Losing every way in",
    answer: "If you lose every passkey, every wallet and the recovery phrase, nobody can open the vault, including Sigil. There is no reset.",
  },
  {
    threat: "Metadata",
    answer: "The server sees that an account exists, how many folders and memories it has, their sizes and times, which app may read which folder, and the read log. It needs these to run the service.",
  },
  {
    threat: "A changed web page",
    answer: "The encryption code is delivered by the site, as with any web app. Someone who controlled the site could serve different code. The code is open source so it can be compared, and you can run your own copy.",
  },
  {
    threat: "A server that hides a read from the log",
    answer: "Seals prove that entries in the log were not changed or removed later. They cannot prove that a dishonest server wrote every request down in the first place.",
  },
  {
    threat: "Seals rewritten by the server itself",
    answer: "Seals are local today: kept by Sigil. The contract that publishes them on chain, so that not even Sigil could change one, is written and tested but not deployed.",
  },
  {
    threat: "What your model provider sees",
    answer:
      "To answer, the provider you chose receives the question and the memories given to it for that answer, under your key and its own terms. Choose the folders your AI self may use with that in mind.",
  },
  {
    threat: "An AI self that says something you would not",
    answer:
      "Models make mistakes, and rules written as topics and phrases can be worked around by careful wording. Give an ask link only the folders you would be happy to see quoted, and read its answers in your log.",
  },
  {
    threat: "An app, agent or link reaching for your health, money or legal folder",
    answer:
      "Protect the folder. The server then holds its ciphertext back from every app, agent and link until you say yes for that read, and a yes covers one read for ten minutes. Each protected read is logged with its own kind and sealed, so it cannot later pass as an ordinary read.",
  },
  {
    threat: "The server reads your mail or your sync sign-in",
    answer:
      "Live sync signs in and fetches from your device. The tokens are encrypted with your vault key (and for a background connector, with a key from its secret) before they are saved; mail, events, files and messages are encrypted on the device like every memory.",
  },
  {
    threat: "The relay reads or fakes what two AI selves say",
    answer:
      "Every turn is encrypted under a key only the two vaults can derive from their own keys. The server passes the boxes and can neither read one nor write one that opens.",
  },
  {
    threat: "Bugs",
    answer: "This is early software. It is open source and tested, and it has not had an independent audit yet.",
  },
  {
    threat: "Taking a proof of a field or an age as checked fact",
    answer:
      "It is your vault's own statement, signed and sealed: nobody checked the passport. Only proofs of sealed history and of team spaces are checked in full. Zero-knowledge proofs of facts that someone else attested are on the roadmap.",
  },
  {
    threat: "Anyone who sees your lock screen",
    answer:
      "That is what the emergency card is for: whoever scans it reads it. A phone that opened it may keep its ciphertext, and the key is in that phone's history; issue a new code to make both useless.",
  },
  {
    threat: "A self key on chain before the contracts are reviewed",
    answer: "The registry and the wallet are tested, not audited, and not deployed. Put on chain only what you could lose until they have been reviewed.",
  },
];

const parties = [
  { who: "You", sees: "Everything in your vault, your read log with its salts, and every app's permissions.", not: "Other people's vaults." },
  {
    who: "Sigil's server",
    sees: "Ciphertext, ids, sizes, times, which app may read which folder, the read log, your passkey's public key or wallet address, how often an ask link is used, and when an expiring memory is to be deleted.",
    not: "Titles, bodies, tags, folder names, app names, search words, any key, your model key, your rules, ask link questions and answers, what kind a protected folder is, your sync sign-ins, mail, events, files and messages, what two selves say to each other, drafts of your AI self, your wallet rules, your emergency card, the text of an agreement.",
  },
  {
    who: "A connected app",
    sees: "The folders you granted it, decrypted on your computer by the connector.",
    not: "Any other folder, your other apps, your keys, and anything at all once revoked.",
  },
  {
    who: "Someone with your ask link",
    sees: "The link's name and greeting, and the answers of your AI self to their own questions.",
    not: "Which memories an answer came from, anything outside the link's folders, other people's questions.",
  },
  {
    who: "A visitor to your public AI self",
    sees: "Its name and greeting, the titles and text of the public copy you published, its answers, and the answers you show on the page.",
    not: "Anything you did not make public, your protected folders, other visitors.",
  },
  {
    who: "Another vault your AI self meets",
    sees: "What your self says in that conversation, and your self's name for it.",
    not: "Your memories themselves, the folders you chose, anything after either of you stops.",
  },
  {
    who: "Your model provider",
    sees: "For each answer, brief or check: the question and the memories given to it, under your own key.",
    not: "Anything else in your vault, or anything at all until you add a key.",
  },
  {
    who: "Someone who scans your emergency code",
    sees: "The card you published: what you chose to put on it.",
    not: "Anything else in your vault, or the card once you take it down or issue a new code.",
  },
  {
    who: "Whoever you share a proof, an agreement or a pack with",
    sees: "The one claim and its evidence; the agreement both of you signed; the pack you published.",
    not: "Any other field of the memory, the date behind an age, anything else in your vault.",
  },
  {
    who: "Anyone on the internet",
    sees: "The public seals: one root per hour and how many reads it covers. The public counts.",
    not: "Who read what, which vault a read belongs to, or anything inside a vault.",
  },
];

export default function ThreatModel() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="Threat model"
          title="What Sigil protects against, and what it does not"
          lead="A security claim is only useful with its limits next to it. This page lists both, in the same plain words, so you can decide what to put in your vault."
        />

        <section className="page-section" aria-labelledby="parties-title">
          <h2 id="parties-title" className="section-title">
            Who can see what
          </h2>
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Can see</th>
                  <th>Cannot see</th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.who}>
                    <th scope="row">{p.who}</th>
                    <td>{p.sees}</td>
                    <td>{p.not}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="page-section" aria-labelledby="covered-title">
          <div className="section-header">
            <h2 id="covered-title" className="section-title">
              Protected against
            </h2>
            <p className="section-lead">Each line is something the code does today, with tests behind it.</p>
          </div>
          <ol className="threats" data-kind="covered">
            {covered.map((t) => (
              <li key={t.threat} className="threat">
                <h3 className="threat-title">{t.threat}</h3>
                <p className="threat-text">{t.answer}</p>
                <span className="badge badge-strong">Covered</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="page-section" aria-labelledby="not-title">
          <div className="section-header">
            <h2 id="not-title" className="section-title">
              Not protected against
            </h2>
            <p className="section-lead">Said as plainly. Some of these are limits of any web app, some are on the roadmap.</p>
          </div>
          <ol className="threats" data-kind="open">
            {notCovered.map((t) => (
              <li key={t.threat} className="threat">
                <h3 className="threat-title">{t.threat}</h3>
                <p className="threat-text">{t.answer}</p>
                <span className="badge">Not covered</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="page-section page-section-narrow" aria-labelledby="do-title">
          <h2 id="do-title" className="section-title">
            What you can do yourself
          </h2>
          <ul className="checklist">
            <li>
              <span>Keep the recovery phrase on paper, somewhere safe, and add a second passkey or wallet under Settings.</span>
            </li>
            <li>
              <span>Give each app only the folders it needs, and look at the read log now and then.</span>
            </li>
            <li>
              <span>Revoke an app the moment you stop using it, or if its key may have been seen by someone else.</span>
            </li>
            <li>
              <span>
                Found a security problem? Report it privately through the security advisories of the repository, as described under{" "}
                <Link href="/security#report">Security</Link>.
              </span>
            </li>
          </ul>
        </section>

        <PageLinks hrefs={["/security", "/privacy", "/verify"]} />
      </div>
    </div>
  );
}
