import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Sigil stores, what it cannot read, how deletion and export work, and your rights under the GDPR.",
};

const LAST_UPDATED = "20 November 2026";

const stored: [string, string, string][] = [
  ["Account", "A random account id and when it was created.", "Readable"],
  ["Passkey sign-in", "The passkey's credential id, public key and signature counter.", "Readable"],
  ["Wallet sign-in", "Your wallet address, so your vault can be found when you sign in.", "Readable"],
  ["Sign-in tokens", "SHA-256 hashes of tokens made on your device. They cannot be turned back into the tokens or your keys.", "Hashed"],
  ["Vault key copies", "Your vault key, locked with your passkey, wallet or recovery phrase.", "Encrypted"],
  ["Sessions", "A hash of your session cookie and when it expires (30 days).", "Hashed"],
  ["Folders", "Folder ids, encrypted names, encrypted folder keys, created and changed times.", "Encrypted, with readable ids and times"],
  ["Memories", "Memory ids, which folder each is in, encrypted content, size, created and changed times, and for a memory you gave an expiry, the time it is to be deleted.", "Encrypted, with readable ids, sizes and times"],
  ["Connected apps", "App ids, encrypted names, encrypted app secrets, a hash of each app token, which folders each app may read, and when it was created, last used or revoked.", "Encrypted and hashed, with readable ids and times"],
  ["Vault public key", "Your vault's X25519 public key, so apps and other vaults can encrypt for it, and its private key locked with your vault key.", "Public key readable, private key encrypted"],
  ["App permissions", "Whether each app may suggest memories, and a tag your device made over your vault's public key for that app.", "Readable flag, keyed tag"],
  ["Suggestions", "Suggested memories waiting in your inbox: an id, which app sent it, when, and a sealed box only your vault can open. Removed once you decide.", "Encrypted, with readable ids and times"],
  ["Shared folders", "Which folder is shared with which vault, the folder key sealed to that vault, your encrypted note on who it is, and when it was accepted.", "Encrypted, with readable ids and times"],
  ["Vault settings", "Your AI self's rules, your model key and how your vault thinks (briefs, grace period), each under a name.", "Encrypted"],
  ["AI self for apps", "For each app you let answer as your AI self: the rules, your model key and your vault public key, encrypted for that app's key.", "Encrypted"],
  ["Ask links", "Each link's id, public key, encrypted greeting, its private key and rules locked with your vault key (and the app's key, if an app answers it), its expiry and limits, how often it was asked and answered, and when your AI self last checked in.", "Encrypted, with readable ids, counts and times"],
  ["Ask link questions", "Questions in flight and their answers, as boxes only the asker and your vault or connector can open, with the asker's public key for that conversation. Deleted a day after they were asked.", "Encrypted, with readable ids and times"],
  ["Read log", "For every request by a connected app, every suggestion, every time a vault opens a folder you share and every answer of your AI self: which app, share or link, what kind, which memory, suggestion or question id, how many items, when, and a random salt. For an answer, the question and answer sealed to your vault's public key.", "Readable to the server, answers encrypted"],
  ["Seals", "One Merkle root per hour and the salted leaves it is made of. They contain no readable personal data.", "Hashes"],
];

export default function Privacy() {
  return (
    <div className="page">
      <div className="container container-narrow">
        <PageHeader
          eyebrow="Privacy"
          title="Privacy notice"
          lead="Sigil is built so that it cannot read what you keep in your vault. This notice lists exactly what it does store, why, and what you can do about it."
        />
        <div className="prose">
          <p className="meta">Last updated {LAST_UPDATED}</p>

          <h2>The short version</h2>
          <ul>
            <li>Everything you write, import or name in your vault is encrypted on your device before it is sent. Sigil stores ciphertext.</li>
            <li>Sigil does store some metadata in readable form, listed in full below, because the service cannot work without it.</li>
            <li>No analytics, no advertising, no tracking, no third-party scripts, and one cookie that keeps you signed in.</li>
            <li>You can export everything and delete everything at any time, from your vault.</li>
          </ul>

          <h2>What is stored</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>What</th>
                <th>Details</th>
                <th>Form</th>
              </tr>
            </thead>
            <tbody>
              {stored.map(([what, details, form]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td>{details}</td>
                  <td>{form}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="prose">
          <p>
            <strong>Never stored or seen by Sigil:</strong> your vault key, folder keys, app keys, recovery phrase, passkey PRF output, wallet
            signatures, the titles, bodies and tags of memories and suggestions, folder and app names, who you share with, what you or a connected
            app searched for, the search vectors made from your memories, your model key, your AI self&apos;s rules, the questions and answers of
            your ask links, and the GitHub token you use for an import.
          </p>

          <h2>Why, and on what legal basis</h2>
          <p>
            Sigil processes this data to provide the service you asked for: storing your vault, signing you in, letting the apps you choose read it,
            and showing you who read what (GDPR Article 6(1)(b), performance of a contract). Short-lived counters of request rates, kept in memory for
            about a minute and keyed by network address, protect the service from abuse (Article 6(1)(f), legitimate interest). Sigil does not use
            your data for anything else, does not sell it, and does not use it to train AI models.
          </p>
          <p>
            You may choose to keep sensitive information in your vault, such as health details. It is encrypted on your device like everything else,
            Sigil cannot read it, and you decide which apps may.
          </p>

          <h2>Cookies</h2>
          <p>
            One cookie, <code>sigil_session</code>, keeps you signed in for up to 30 days. It is strictly necessary, so no consent banner is needed.
            Your vault key is never stored in a cookie or in your browser&apos;s storage; it lives in the page&apos;s memory while the vault is open
            and is gone when you close or reload it. Search by meaning keeps vectors of your memories in your browser&apos;s own storage, encrypted
            with a key derived from your vault key; they never leave the browser and are removed when you delete your vault there.
          </p>

          <h2>Connected AI apps</h2>
          <p>
            When you connect an app, the Sigil connector on your computer decrypts the folders you granted and hands their text to that app. From that
            moment, the app and its provider process that text under their own privacy policies. Sigil records the read in your log but has no control
            over what the app does next.
          </p>

          <h2>Your AI self and your model provider</h2>
          <p>
            When you add a model key, your browser (or your connector, for an app you allow) sends the questions your AI self answers, and the
            memories it uses for them, to the provider you chose: Anthropic or OpenAI. The same goes for a brief or a check you let your model write.
            That provider processes the text under your account and its own terms. Sigil is not part of that exchange and sees none of it.
          </p>
          <p>
            Someone you give an ask link to sends their questions, encrypted, through Sigil to your AI self. Sigil cannot read them. You can read
            them, with the answers, in your read log. Their network address is used for rate limits only, held in memory for at most an hour.
          </p>

          <h2>How long it is kept</h2>
          <ul>
            <li>Your vault, apps and read log: until you delete them, or your account.</li>
            <li>Sessions: 30 days, or until you sign out. Sign-in challenges: 5 minutes.</li>
            <li>Memories you gave an expiry: until the grace period after it is over (30 days unless you change it), then deleted for real.</li>
            <li>Ask link questions and answers in flight: one day. Ask links: until you delete them.</li>
            <li>
              Seals: permanently, as they are a public record. They are built from salted hashes; your salts are deleted with your account, after
              which nothing in a seal can be linked to you.
            </li>
          </ul>

          <h2>Your rights</h2>
          <ul>
            <li>
              <strong>Access and portability:</strong> Export in your vault&apos;s Settings downloads everything, decrypted, as one JSON file.
            </li>
            <li>
              <strong>Correction:</strong> edit any memory, folder or app in your vault.
            </li>
            <li>
              <strong>Erasure:</strong> delete memories, folders, apps or your whole account in your vault. Deletion removes the data from the database
              and overwrites it on disk.
            </li>
            <li>
              <strong>Objection and restriction:</strong> revoke any app, or contact us.
            </li>
            <li>You can also complain to the data protection authority where you live.</li>
          </ul>

          <h2>Where the data is</h2>
          <p>
            The data is held by the server that runs Sigil and by its hosting provider, which may keep standard request logs of its own. Sigil itself
            does not write network addresses to its database. Seals are not published anywhere yet; when on-chain sealing is turned on, only the hourly
            Merkle roots will be published, never personal data.
          </p>

          <h2>Contact and changes</h2>
          <p>
            Questions or requests can be sent through the{" "}
            <a href={site.xUrl} target="_blank" rel="noopener noreferrer">
              Sigil account on X
            </a>{" "}
            or the{" "}
            <a href={site.githubUrl} target="_blank" rel="noopener noreferrer">
              repository
            </a>
            ; please do not post personal details publicly. If this notice changes, the date above changes with it. See also the{" "}
            <Link href="/security">security page</Link> and the <Link href="/terms">terms</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
