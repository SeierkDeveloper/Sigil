import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { SealList } from "@/components/SealList";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description: "How Sigil encrypts your vault on your device, what the server can and cannot see, and how hourly seals work.",
};

export default function Security() {
  return (
    <div className="page">
      <div className="container container-narrow">
        <PageHeader
          eyebrow="Security and privacy"
          title="Built so that we cannot read your vault"
          lead="Sigil encrypts everything you write on your own device, with keys that only your passkey, your wallet or your recovery phrase can unlock. This page explains how, and where the limits are."
        />

        <ul className="toc">
          <li>
            <a href="#keys">Keys</a>
          </li>
          <li>
            <a href="#encryption">Encryption</a>
          </li>
          <li>
            <a href="#server">What the server sees</a>
          </li>
          <li>
            <a href="#apps">Connected apps</a>
          </li>
          <li>
            <a href="#ai-self">Your AI self</a>
          </li>
          <li>
            <a href="#delete">Deleting</a>
          </li>
          <li>
            <a href="#seals">Seals</a>
          </li>
          <li>
            <a href="#legacy-devices-agents">Legacy, devices and agents</a>
          </li>
          <li>
            <a href="#round-five">Sync, protection, public and meeting selves</a>
          </li>
          <li>
            <a href="#round-six">Identity, work, proofs, emergency, agreements, packs</a>
          </li>
          <li>
            <a href="#round-seven">Bundles, nodes, voice, capture, sessions, shared memory</a>
          </li>
          <li>
            <a href="#limits">Limits</a>
          </li>
          <li>
            <a href="#report">Reporting a problem</a>
          </li>
        </ul>

        <div className="prose">
          <section id="keys">
            <h2>Your keys</h2>
            <p>
              When you create a vault, your browser makes a random 256-bit <strong>vault key</strong>. It is never sent anywhere in readable form.
              Instead, it is locked (wrapped) once for each way you can sign in:
            </p>
            <ul>
              <li>
                <strong>Passkey.</strong> Sigil asks your passkey for its PRF output, a secret that the passkey derives on your device and gives only
                to this site. That secret unlocks your copy of the vault key. Passkeys without PRF support cannot hold a vault key; Sigil tells you when
                that happens.
              </li>
              <li>
                <strong>Wallet.</strong> Your wallet signs one fixed message. The signature stays in your browser and is turned into a key. Sigil checks
                at sign-up that your wallet signs the same way every time, because a wallet that does not could never open the vault again.
              </li>
              <li>
                <strong>Recovery phrase.</strong> 24 words (256 bits) shown to you once at sign-up. They unlock a third copy of the vault key. You can
                replace the phrase in Settings; the old one stops working.
              </li>
            </ul>
            <p>
              Signing in also proves to the server who you are, without giving it anything that unlocks the vault: passkeys use standard WebAuthn
              signatures, and wallets and phrases send a separate token derived from the same secret, of which the server stores only a SHA-256 hash.
            </p>
          </section>

          <section id="encryption">
            <h2>Encryption</h2>
            <p>
              Every folder has its own random key, wrapped by your vault key. Every memory is encrypted with its folder&apos;s key using{" "}
              <strong>AES-256-GCM</strong> with a fresh random nonce, through the WebCrypto built into your browser. Keys are derived with{" "}
              <strong>HKDF-SHA256</strong>, with a separate label for every purpose.
            </p>
            <p>
              Each piece of ciphertext is bound to the exact record it belongs to. A memory copied into another record, another folder or another
              account fails to decrypt instead of showing the wrong content. The full format is in the <Link href="/docs#encryption">docs</Link>.
            </p>
            <p>
              The site is served with a content security policy that only lets the page talk to Sigil&apos;s own server, and there are no analytics,
              advertising or third-party scripts on it.
            </p>
          </section>

          <section id="server">
            <h2>What the server can and cannot see</h2>
            <p>
              <strong>It cannot see</strong> the title, body or tags of any memory, the names of your folders, the names of your connected apps, your
              search words, any of your keys, your model key, your AI self&apos;s rules, or the questions and answers of your ask links.
            </p>
            <p>
              <strong>It can see</strong> that your account exists; your passkey&apos;s public key or your wallet address (needed to find your vault
              when you sign in); how many folders and memories you have, their sizes and when they changed; which app is allowed to read which folder;
              the read log: which app read which memory, and when; that an ask link exists, how often it is used and when your AI self last checked
              in; and, for a memory you gave an expiry, the time it is to be deleted. This metadata is needed to run the service, and it is covered by
              the{" "}
              <Link href="/privacy">privacy notice</Link>.
            </p>
          </section>

          <section id="apps">
            <h2>Connected apps</h2>
            <p>
              Each connected app gets its own secret, made in your browser and shown to you once as the app key. From it come two things: a token the
              connector uses to talk to the server (the server keeps only its hash) and a key that unwraps the folder keys you granted to that app.
              Folders you did not grant are never wrapped for the app, so its key cannot open them.
            </p>
            <p>
              The connector runs on your computer and decrypts there. It keeps nothing between requests, so revoking an app takes effect on its next
              request. On revoke the server also deletes that app&apos;s wrapped folder keys.
            </p>
            <p>
              Connected apps cannot change or delete memories. An app you allow may suggest one: the connector, the extension or the web app seals it
              to your vault&apos;s public key on the user&apos;s side, and it becomes a memory only when you approve it in your inbox. The public key
              comes with a tag your vault made with that app&apos;s own secret, so a server that swapped in a key of its own would be caught before
              anything is sealed.
            </p>
            <p>
              Sharing a folder with another vault seals the folder key to that vault&apos;s public key, taken from the code its owner gave you, never
              from the server. Stopping a share gives the folder a new key on your device and encrypts the folder again, so the removed vault holds
              only a key that opens nothing stored now. Search by meaning runs on your device; its vectors never reach the server and are kept in
              your browser only encrypted.
            </p>
          </section>

          <section id="ai-self">
            <h2>Your AI self</h2>
            <p>
              Your AI self runs where your keys are: in your open vault, or in the connector on your machine for an app you allow. It calls your own
              model provider with your own key, straight from there. The key and the rules are saved only as envelopes under your vault key; for an
              app you allow they are wrapped again under a key derived from that app&apos;s secret, which never reaches the server. Only the folders
              your rules allow are given to the model, and the rules are checked on the device before and after the model answers.
            </p>
            <p>
              An ask link carries the link&apos;s public key after the <code>#</code>, which browsers never send to a server. The asker&apos;s browser
              checks the key the server holds against it and refuses a different one, makes a fresh X25519 key pair for the conversation, and seals
              each question with a key derived from both sides (HKDF-SHA256, then XChaCha20-Poly1305 bound to the link, the conversation, the message
              and its direction). The server stores and forwards these boxes and cannot open them. Each question and answer is also sealed to your
              vault&apos;s public key for your read log, where the entry is part of the hourly seal.
            </p>
            <p>
              The model provider you choose does see the question and the memories given to it for that answer: that is how a model answers. Its own
              terms apply to what it receives. Imports from GitHub are asked from your browser in the same way, with a token that is never saved.
            </p>
          </section>

          <section id="delete">
            <h2>Deleting means deleted</h2>
            <p>
              Deleting a memory, a folder or your account removes the rows from the database, and the database is set to overwrite deleted content on
              disk rather than just unlinking it. Deleting your account removes your sign-in methods, sessions, folders, memories, apps and read log in
              one step. A memory you gave an expiry is deleted by the server when its grace period is over, whether or not your vault is open. Export
              everything first if you want to keep a copy: the export is decrypted on your device.
            </p>
          </section>

          <section id="seals">
            <h2>Hourly seals</h2>
            <p>
              Every read by a connected app is written to your read log with a random 32-byte salt. The log entry and its salt are hashed into a leaf.
              When an hour is over, all leaves from that hour (from every vault) are combined into one <strong>Merkle root</strong>: the seal for that
              hour. A seal is never changed after it is made.
            </p>
            <p>
              In your vault, <strong>Verify</strong> on any log entry recomputes its leaf from the entry itself, fetches the proof, and checks in your
              browser that it leads to the published root. Because every leaf is salted and the salt is only shown to the vault&apos;s owner, the
              roots reveal nothing about who read what. When you delete your account, your salts are deleted with it, so the leaves left in old seals
              point to nothing.
            </p>
            <p>
              Today seals are kept by Sigil and marked <strong>Local</strong>. The contract that will publish them on chain, so that not even Sigil
              could change one later, is written and tested but not yet deployed. When that is switched on, seals will be marked{" "}
              <strong>On chain</strong>.
            </p>
            <h3>Latest seals</h3>
            <SealList />
          </section>

          <section id="legacy-devices-agents">
            <h2>Legacy, devices and agents</h2>
            <ul>
              <li>
                <strong>Legacy.</strong> The legacy key is made and split in your browser with Shamir&apos;s secret sharing (the independently audited{" "}
                <code>shamir-secret-sharing</code> library). Each share and each bundle is sealed to one trusted person&apos;s vault public key; a bundle
                is also encrypted under a key from the legacy key, so it takes the shares and that person&apos;s vault to open. Shares are passed
                between trusted people sealed to the keys you named, which they take from their own copy of the plan. Every change makes a new key.
              </li>
              <li>
                <strong>Devices.</strong> A new device makes a one-time X25519 key pair. Its pairing code is a hash of the public key, so the vault
                that sends the keys can tell a key the server swapped in. The vault key and a fresh device secret travel sealed to that one-time key;
                the device keeps its secret as a non-extractable WebCrypto key. A captured note or photo is sealed on the phone to your vault&apos;s
                public key, checked against the key the device saw when the vault was last open.
              </li>
              <li>
                <strong>Agents and spaces.</strong> An agent&apos;s X25519 key pair is derived from its secret on your device and in the connector. Team
                space keys are sealed to every member; member tags are MACs under the space key, checked before anything is sealed. Removing a member
                encrypts the space again under a new key.
              </li>
              <li>
                <strong>Presence.</strong> A signing key (Ed25519) is derived from your vault key. One statement per hour you have the vault open is
                signed in your browser and sealed with that hour, which is what a life certificate is built from.
              </li>
            </ul>
          </section>

          <section id="round-five">
            <h2>Sync, protection, public and meeting selves</h2>
            <ul>
              <li>
                <strong>Live sync.</strong> OAuth 2.0 with PKCE (S256) from your browser as a public client; no client secret is sent from a browser or kept on the
                server. The tokens and the cursor are one document encrypted with your vault key, and, for a connector you let sync in the background, under a key
                derived from that app&apos;s secret. Fetching and encrypting happen on the device. The content security policy allows exactly the Google and Slack
                addresses live sync calls.
              </li>
              <li>
                <strong>Protected folders.</strong> The server holds a protected folder&apos;s ciphertext back from apps, agents and links until you approve that read;
                an approval is single use and lasts ten minutes. Protected reads and your answers have their own kinds in the log, and the kind is part of each sealed
                leaf. Redaction runs on the device before text leaves the vault.
              </li>
              <li>
                <strong>The public AI self.</strong> Its X25519 key pair is made on your device; the private half and its rules are encrypted with your vault key.
                Visitors&apos; questions use the same relay as ask links, and it answers only from the public copy you publish.
              </li>
              <li>
                <strong>Selves meet.</strong> The invite and the answer are sealed boxes to the other vault. Turns are XChaCha20-Poly1305 under a key from X25519 between
                the two vaults&apos; own keys, bound to the meet, the turn and the sender, so only those two vaults can write a turn that opens.
              </li>
              <li>
                <strong>The open standard.</strong> All of this is written down in the <Link href="/spec">open standard</Link>, with test vectors the code is
                checked against on every test run.
              </li>
            </ul>
          </section>

          <section id="round-six">
            <h2>Identity, work, proofs, emergency, agreements and packs</h2>
            <ul>
              <li>
                <strong>The self key.</strong> A secp256k1 key derived with HKDF from your vault key on your device, never stored and never sent; the server keeps
                its address only. The identity statement is signed by both your vault&apos;s Ed25519 key and the self key, and the server checks both signatures before
                it serves one. The wallet rules are an encrypted setting.
              </li>
              <li>
                <strong>The contracts.</strong> <code>SigilSelfRegistry</code> registers a self key only with an EIP-712 signature by that key naming its owner, and
                refuses high-s signatures; a revoked key stays revoked. <code>SigilSelfWallet</code> checks, for every call by the self key, freeze, expiry, the
                allowed target, the allowed function, token caps with allowed recipients, and native caps per call and per UTC day; it refuses token moves it cannot
                cap. The owner can always freeze, change the rules and withdraw. Both are tested with Foundry, with fuzzing of the caps and the freeze, and are not
                deployed.
              </li>
              <li>
                <strong>Drafts.</strong> Each draft of your AI self is an envelope under your vault key; the server knows its kind and state. Nothing is sent on its
                own: held answers go out only when you approve them, through their own encrypted channel.
              </li>
              <li>
                <strong>Proofs of a fact.</strong> Each field of a memory is committed with its own 32 random bytes of salt, so the commitment says nothing without
                them. Only the hash of the signed statement reaches the server before you share a proof; it is sealed with the hour.
              </li>
              <li>
                <strong>The emergency card.</strong> AES-256-GCM under a fresh key that is only in the link after the <code>#</code>, bound to the card&apos;s id. The
                server stores ciphertext it cannot open and records each opening with a time, a device class and a language only.
              </li>
              <li>
                <strong>Agreements.</strong> The text goes to the other vault as a sealed box; each side keeps its copy under its own vault key. Both sign one SHA-256
                fingerprint with Ed25519; the server checks each signature against the key that vault registered, and the receiving vault checks that the document
                names it with its own keys before it signs.
              </li>
              <li>
                <strong>Knowledge packs.</strong> Public by design and signed by the publisher&apos;s vault key. A follower pins that key and checks every version, in
                order, against it and the hash of the version before.
              </li>
            </ul>
          </section>

          <section id="round-seven">
            <h2>Bundles, nodes, voice, capture, sessions and shared memory</h2>
            <ul>
              <li>
                <strong>The bundle.</strong> Every part of the vault as the node holds it (envelopes, sealed boxes, wrapped keys, hashes and public keys), with a
                SHA-256 hash over all of it and an Ed25519 signature by your vault&apos;s key, made on your device. A restore unwraps the vault key from the bundle&apos;s
                own key slot on your device and opens every folder, memory and setting under the record it claims before the node is asked to take it in, with a
                statement your key signed for that node and that is at most ten minutes old.
              </li>
              <li>
                <strong>Storage tokens.</strong> The vault&apos;s <code>backup</code> setting, an envelope under your vault key; for a connector you allow, an envelope
                under a key from that app&apos;s secret. S3 requests are signed with AWS Signature Version 4 on the device; an Arweave upload is a data item signed
                with your key file on the device, whose id the device checks. Where each copy went is sealed to your vault&apos;s key. The content security policy
                lists the storage addresses the page may upload to.
              </li>
              <li>
                <strong>Moving.</strong> A move statement and an arrival, both Ed25519 by your vault&apos;s key; the new node fetches the bundle only with a 32-byte
                secret from the code you carry, of which the old node keeps the hash. Node to node requests use HTTPS only, follow no redirect, are limited in time
                and size, and never reach a private network unless the operator allows it.
              </li>
              <li>
                <strong>Capture keys.</strong> 32 random bytes per key; the node keeps the SHA-256 of the derived token. Captures are sealed boxes to the vault public
                key, checked against a tag only the key and your vault can make, and bound to the key&apos;s id. Plain text is taken only for a key you allowed, and
                sealed at once.
              </li>
              <li>
                <strong>Voice.</strong> The speech model runs in a worker of the page with the same WebAssembly runtime as search by meaning; it is fetched from this
                site, only when someone turns voice on. The microphone is allowed for this site only.
              </li>
              <li>
                <strong>Sessions.</strong> A session link&apos;s 32-byte secret gives the bearer token (the node keeps its hash) and the visitor&apos;s X25519 key for the
                relay. The intake is a sealed box to the public self&apos;s key; each turn&apos;s transcript a sealed box to your vault&apos;s key.
              </li>
              <li>
                <strong>Shared memory.</strong> The space key, roles and member tags of team spaces. The node keeps who wrote each entry and enforces that writers
                change only their own. Heirs are sealed and tagged by an admin&apos;s device and sealed again with every new key.
              </li>
            </ul>
          </section>

          <section id="limits">
            <h2>Limits, plainly</h2>
            <ul>
              <li>
                <strong>Lost keys are lost.</strong> If you lose every passkey, every wallet and your recovery phrase, the vault cannot be opened by
                anyone, including Sigil.
              </li>
              <li>
                <strong>What an AI has read, it has.</strong> Once an AI app reads a memory, that text is in the app&apos;s hands and its own policies
                apply. Revoking stops future reads, not past ones.
              </li>
              <li>
                <strong>Your device is part of the system.</strong> Encryption protects your vault on the server and on the network. It cannot protect
                it from malware on the device where you unlock it, or from someone using your unlocked computer.
              </li>
              <li>
                <strong>Metadata is visible to the server,</strong> as listed above.
              </li>
              <li>
                <strong>Your model provider sees what it answers from.</strong> Each answer of your AI self, each brief written by your model and each
                pair it checks sends that text to the provider you chose, under your key and its terms.
              </li>
              <li>
                <strong>The ask page is served by the server.</strong> Like any web page with end to end encryption, it is only as honest as the code
                the server sends. The code is open source, so it can be checked.
              </li>
              <li>
                <strong>The server keeps the legacy clock.</strong> It cannot open a share, but it decides when a plan may be released. A server
                working with enough of your trusted people could release early.
              </li>
              <li>
                <strong>A revoked device keeps what it showed.</strong> Revoking ends its access from then on; it cannot reach into the device.
              </li>
              <li>
                <strong>A proof of a field or an age is your own word.</strong> It is signed and sealed, not checked by anyone else: Sigil does not read a
                passport. Only sealed history and team spaces are checked in full.
              </li>
              <li>
                <strong>An emergency card is for anyone who sees the code.</strong> That is its purpose. A phone that opened it may keep its ciphertext, and the key
                is in that phone&apos;s history; issuing a new code makes both useless.
              </li>
              <li>
                <strong>Early software.</strong> The code is open source and has not had an independent audit yet.
              </li>
            </ul>
          </section>

          <section id="report">
            <h2>Reporting a problem</h2>
            <p>
              If you find a security issue, please report it privately through the security advisories of the{" "}
              <a href={site.githubUrl} target="_blank" rel="noopener noreferrer">
                Sigil repository
              </a>{" "}
              rather than in a public issue.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
