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
    threat: "Someone who only knows an ask link's address starts a conversation",
    answer:
      "The conversation key takes in a key that is only in the link's fragment (after the #) and with you. The server knows the link's id and public key, but a conversation it starts itself does not open on your side, so nobody without the whole link is answered.",
  },
  {
    threat: "An email, chat or import carries instructions written for your AI",
    answer:
      "Every memory from outside is checked on your device as it arrives, for instruction overrides, fake system messages, requests to send memories or keys away, tool calls, payments and hiding tricks. What looks like that waits in your inbox, under Held for review, and reaches no app, AI self, link or public page until you let it through. Every memory any model sees is quoted as data, with flagged places removed, and every catch is in your read log. The rules catch common shapes, not every attack: the public test at /immune shows which strains get through.",
  },
  {
    threat: "A bundle is changed where it is stored",
    answer:
      "Restoring checks, on your device, the vault's signature over the whole bundle, or for a connector's bundle an HMAC with a key only that app and your vault have. A memory left out, or an app or capture key slipped in, fails the check, and nothing is restored.",
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
      "The registry takes a self key only with that key's own signature over the owner's address, the metadata and a deadline. A signature for one owner fails for any other, a revoked key can never be registered again, and a key moves to a new owner only when that owner accepts it.",
  },
  {
    threat: "The self key spends more than you allowed",
    answer:
      "The self wallet checks every call against your caps per payment and per day, your recipients (the only addresses it can pay), the contracts and functions it may call, token caps in each token's own decimals as read from the token, and the end date, and refuses token moves it cannot cap. Freezing it also sets the allowances it gave back to zero, and the vault tells you if any are still open. You can freeze it, change its rules or withdraw at any time. Tested with fuzzing, and each owner deploys their own from the vault.",
  },
  {
    threat: "The server forges your yes for an app that acts",
    answer:
      "Your answer to a step an app asked about is encrypted under a key from that app's secret, which the server never holds, and names the step it answers. A forged answer, or one moved to another step, does not open in the connector, so the app is never told yes.",
  },
  {
    threat: "The server reads your thresholds, ranges or the mail a step is about",
    answer:
      "Thresholds and ranges are a setting under your vault key, and reach an app only wrapped for its key. A step waiting for you is sealed to your vault's public key. The server sees which area it is in (mail, invites or negotiation), its state and when, which it needs to count the most per day.",
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
  {
    threat: "The node your vault lives on shuts down or loses its data",
    answer:
      "Keep a bundle of your vault where you choose: a file, your own bucket, IPFS or Arweave. It holds everything as ciphertext, and any Sigil node restores it with your recovery phrase or wallet. Your tokens for that storage are kept only under your vault key, and uploads go from your own device.",
  },
  {
    threat: "A changed bundle, or a bundle from someone else",
    answer:
      "A bundle carries a hash over every part and your vault key's signature. Before a node takes it in, your device unwraps the vault key from the bundle's own key slot and opens every folder, memory and setting under the record it claims; anything that does not open stops the restore. The node accepts it only with a statement your vault key signed for that node, minutes before.",
  },
  {
    threat: "Someone moves your vault away, or a node lies about a move",
    answer:
      "A move needs a statement your vault key signs, naming both nodes and the bundle; the new node fetches the bundle only with the secret in the code you carry; the old node starts sending your links on only once an arrival signed by the same key confirms it. Every step is in the log of the node it happened on.",
  },
  {
    threat: "A node used to reach a private network",
    answer:
      "A node fetches another node or a restore address over HTTPS only, follows no redirect, and refuses addresses written as private (localhost, 10.x, 192.168.x and the like) unless its operator allows them for nodes on one machine or one network. A public name that resolves to a private address is not caught by that check: an operator who runs other services on its network should also limit the node's outgoing traffic.",
  },
  {
    threat: "A leaked capture key",
    answer:
      "It can only add to your inbox, at most 20 a minute and 300 a day, and nothing it adds becomes a memory until you approve it. It reads nothing. Revoke it under Devices and it fails on its next request; your other keys keep working.",
  },
  {
    threat: "A server that swaps your vault key for a capture",
    answer:
      "The sending device checks the vault public key against a tag your vault made with that capture key's own secret, and seals nothing when it does not match.",
  },
  {
    threat: "Your voice reaching a cloud service",
    answer:
      "Speech to text runs in a worker on your device with a model this site serves; the browser's own speech recognition, which sends audio to a cloud in most browsers, is never used. Answers are read aloud only by a voice that runs on the device.",
  },
  {
    threat: "The server reads a session's intake or its conversation",
    answer:
      "The intake is sealed in the visitor's browser to your public self's key, and questions and answers are sealed between the visitor's browser and your device with a key from the session link, which stays after the #. The transcript is sealed to your vault's key.",
  },
  {
    threat: "Leaving a shared memory, or dying, erases what others wrote",
    answer:
      "It does not. An entry keeps the member who added it; a writer changes and deletes only their own, leaving or deleting an account leaves every entry in place, and the history is deleted only by its last member. Heirs you name are sealed now and become members when the legacy plan of the member they are named for releases.",
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
    answer: "Every hourly seal root is published on chain in the SigilSeal contract, so not even Sigil could change one later. Seals from before 26 November 2026 were published together that day.",
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
    answer: "The registry is deployed and each owner deploys their own wallet from the vault. Both are tested with fuzzing. Put in the wallet only what you could afford to lose.",
  },
  {
    threat: "An app you let act ignores the answer",
    answer:
      "The thresholds are checked by the connector on the app's own machine, and the app sends mail with access of its own, so an app that ignores a needs-approval or refused answer can still act. What Sigil keeps: such a step has no yes it can show and no receipt, and the most per day is counted on the server. Let only apps you trust act, and turn one off under Limits at any time.",
  },
  {
    threat: "An app's receipt key",
    answer:
      "An app that acts signs its receipts with a key made from its own app key, which your self key vouched for in your vault. Whoever holds that app key can sign receipts in your self's name for that app, never a payment: the self key itself never leaves your device. A receipt names the app key that signed it.",
  },
  {
    threat: "Your self answering mail or invites in your own Google account",
    answer:
      "Only while your vault is open, from your device, with your own token, within the thresholds you set; everything else waits for you. It needs Google's permission to send mail or answer invites, which you grant once per account, and this site's Google client. Thresholds read words, not intent: a message can be about money without saying so, so list only senders you trust.",
  },
  {
    threat: "Storage that does not last",
    answer:
      "How long a bundle lasts depends on where you keep it: a bucket while your account and the object exist, a pin while the pinning service keeps it, Arweave while its network keeps what was paid for. Sigil does not pay for, renew or check any of these. Keep more than one copy.",
  },
  {
    threat: "Plain text from a watch",
    answer:
      "A shortcut that cannot run code sends plain text over HTTPS, for a capture key you allowed that. The node seals it to your vault's key the moment it arrives and keeps only the sealed box, but it handles the text in the clear for that moment. Leave plain text off for keys whose shortcut can open the capture page.",
  },
  {
    threat: "The old node during a move",
    answer:
      "Until the period you chose ends, the old node still holds your vault as ciphertext, sends your links on and turns sign-ins away. It cannot read anything, but it decides when it deletes. Move only from a node you trust to do so, and restore from your own bundle if it does not.",
  },
  {
    threat: "Taking a session's answers as the expert's own",
    answer:
      "Every answer is marked as written by an AI from what the expert made public, under house rules the expert wrote. It can still be wrong, and rules written as words can be worked around.",
  },
  {
    threat: "An heir named too early",
    answer:
      "An heir becomes a member when the legacy plan of the member they are named for releases, which the server decides as for the plan itself. An admin can remove an heir until then, and remove a member afterwards with a new key.",
  },
];

const parties = [
  { who: "You", sees: "Everything in your vault, your read log with its salts, and every app's permissions.", not: "Other people's vaults." },
  {
    who: "Sigil's server",
    sees: "Ciphertext, ids, sizes, times, which app may read which folder, the read log, your passkey's public key or wallet address, how often an ask link is used, when an expiring memory is to be deleted, and for each step your self takes or asks about, its area, its state and when.",
    not: "Titles, bodies, tags, folder names, app names, search words, any key, your model key, your rules, ask link questions and answers, what kind a protected folder is, your sync sign-ins, mail, events, files and messages, what two selves say to each other, drafts of your AI self, your thresholds and ranges, what a step of your self is about and your answer to it, your wallet rules, your emergency card, the text of an agreement, your storage tokens and where your bundles are, what a capture key sends (unless you allowed it plain text), a session's intake and conversation, shared memory, anything you say by voice.",
  },
  {
    who: "A connected app",
    sees: "The folders you granted it, decrypted on your computer by the connector, and, when you let it act, your thresholds and ranges and your answers to its steps.",
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
    who: "Another node",
    sees: "When you move to it or from it: your vault's bundle, as ciphertext, and the move statement your key signed.",
    not: "Anything inside the bundle, your keys, your sign-in.",
  },
  {
    who: "Your storage service",
    sees: "The bundle file, as ciphertext, its size and when it arrived, and your account there.",
    not: "Anything inside it. It opens only with your recovery phrase or wallet.",
  },
  {
    who: "A visitor in a booked session",
    sees: "Your public AI self's answers within the session's topic, questions and house rules.",
    not: "Anything you did not make public, other sessions, other visitors.",
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
