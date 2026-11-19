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
      <div className="container">
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
            <a href="#delete">Deleting</a>
          </li>
          <li>
            <a href="#seals">Seals</a>
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
              search words, or any of your keys.
            </p>
            <p>
              <strong>It can see</strong> that your account exists; your passkey&apos;s public key or your wallet address (needed to find your vault
              when you sign in); how many folders and memories you have, their sizes and when they changed; which app is allowed to read which folder;
              and the read log: which app read which memory, and when. This metadata is needed to run the service, and it is covered by the{" "}
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
              Connected apps are read only: the connector has no way to add, change or delete memories. This also means an AI app cannot plant false
              memories in your vault.
            </p>
          </section>

          <section id="delete">
            <h2>Deleting means deleted</h2>
            <p>
              Deleting a memory, a folder or your account removes the rows from the database, and the database is set to overwrite deleted content on
              disk rather than just unlinking it. Deleting your account removes your sign-in methods, sessions, folders, memories, apps and read log in
              one step. Export everything first if you want to keep a copy: the export is decrypted on your device.
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
