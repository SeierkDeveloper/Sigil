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
  ["Last activity", "When you last signed in or did something in your vault, for your legacy plan's heartbeat.", "Readable time"],
  ["Legacy plan", "Its period, how many people are needed, which folder ids each person receives and whether they may talk to your AI self, each person's share, bundle and note sealed to their vault, the plan under your vault key, the warning stages reached, who asked for a release, shares passed between them (sealed), and when it was released or opened.", "Encrypted and sealed, with readable ids, counts and times"],
  ["Paired devices", "A key slot per device: a hash of its token, your vault key locked with its device key, its name under your vault key, and when it was last used. A pairing in progress keeps the new device's one-time public key, the code made from it and one sealed box, for ten minutes at most.", "Encrypted and hashed, with readable ids and times"],
  ["Agents", "For each agent: its own folder id, which tools it may use, whether it may write each folder, and the public half of the key pair made from its secret. Its handoff notes, encrypted.", "Readable rules and ids, notes encrypted"],
  ["Team spaces", "Each space's encrypted name and memories, and per member: which vault or agent, its public key, its role, the space key sealed to it, a tag made with the space key and its name in the space, encrypted.", "Encrypted and sealed, with readable ids, roles and times"],
  ["Protected folders", "Which folder ids you protected (not what kind of folder: that stays in its encrypted name), and each request to read one: which app, link or AI self asked, which folder and memory ids, when, your answer, and when it was used. Answered requests are deleted after seven days.", "Readable ids and times"],
  ["Live sync sources", "For each source: the folder id it writes to, whether it is paused, when it last synced, which app syncs it in the background, and the source itself (which service, your sign-in tokens, the account, where it got to) encrypted with your vault key, and for that app, with a key from its secret. Disconnecting deletes it.", "Encrypted, with readable ids and times"],
  ["Public AI self", "If you make one: its handle, name and greeting, its public key, its private key and rules locked with your vault key, your limits, counts of questions, and the public copy of the folders you made public, in readable form because you publish it. Visitors' questions in flight are boxes only your device opens, kept a day. If you choose to show answers on the page, those questions and answers in readable form, until you hide them or turn it off.", "Readable by choice, keys and rules encrypted"],
  ["Selves meet", "For each conversation: the two vaults' public keys, the turn limit, how many turns were taken, whether it runs, ended or was stopped and by whom, when each side last checked in, the invite and the answer sealed to the other vault, each side's own record under its vault key, and every turn encrypted under a key only the two vaults can make.", "Encrypted and sealed, with readable ids, counts and times"],
  ["Presence and certificates", "Your vault's signing public key, one read-log entry per hour your vault was open with its signature, and the certificates you publish by link (which hold seal roots, proofs and signatures, and nothing from your vault).", "Readable signatures and hashes"],
  ["AI self identity", "The address of your AI self's key (the key itself is never sent), and the identity statement you sign, which anyone may read at its address. What you chose to say about it and the rules of its wallet are vault settings, encrypted.", "Address and statement readable by choice, rest encrypted"],
  ["AI self drafts", "Each draft in the approval queue: an id, whether it is a reply, a plan or an answer, whether it waits or was approved or discarded, for an answer the id of the question or turn it answers, and the draft itself encrypted with your vault key. Kept until you remove it. The notes it learns from your edits are memories in your How I write folder.", "Encrypted, with readable ids, kinds and times"],
  ["Proofs of a fact", "For each proof: an id, the read-log entry with the hash of its signed statement, and the proof itself encrypted with your vault key. The whole proof in readable form only if you share it by link, until you take it down.", "Encrypted, readable by choice"],
  ["Emergency card", "The card encrypted with a key that is only in its link (the server never receives it), and the card and key again under your vault key. For each opening: the time, whether it was a phone, a tablet or a computer, and the browser's first language; up to 200 openings, kept after you take the card down until you delete your account.", "Encrypted, with readable openings"],
  ["Agreements", "For each agreement: the two vaults' public keys, its fingerprint, version and the fingerprint it amends, both signatures, whether it waits, was signed, declined or withdrawn, the document sealed to the other vault, and each side's copy under its own vault key.", "Encrypted and sealed, with readable fingerprints, signatures and times"],
  ["Knowledge packs", "The packs you publish, every version in readable form because you publish them, with the folder id each comes from. The packs you follow are a vault setting, encrypted; the server sees a pack being fetched and the line your log gets when your vault takes in a version.", "Readable by choice, follows encrypted"],
  ["Backups", "For each copy of your vault that your device or connector stored: an id, when, its hash and size, which connector made it, and where it went (object names, content ids) sealed to your vault's key. Your storage settings and tokens are a vault setting, encrypted; for a connector you allow, encrypted for its key. The bundle itself is never kept here.", "Encrypted, with readable hashes, sizes and times"],
  ["Nodes and moves", "The nodes your vault came from or went to, with the time each sends links on until. For a move out of this node: the move statement your key signed, the bundle (ciphertext) until the new node fetched it, and a hash of the move's secret. After a move, the addresses that point on and until when, kept apart from the account, which is deleted when the period ends.", "Readable addresses and times, bundle encrypted"],
  ["Capture keys", "For each key: an id, a hash of its token, the tag your vault made over its public key, its name under your vault key, whether it may send plain text, how many captures it sent and when, and when it was revoked. What it sends is a suggestion in your inbox, sealed to your vault's key.", "Encrypted and hashed, with readable counts and times"],
  ["Sessions", "Your session offer in readable form, because visitors see it. For each booking: the topic, the time, how many questions were asked, the consent text the visitor agreed to, their intake sealed to your public self's key, a hash of the session token and of the visitor's network address with your page, and each turn sealed to your vault's key. Visitors you blocked, as that hash.", "Readable offer and times, intake and turns encrypted"],
  ["Shared memory", "As team spaces, with the kind of space (family or history) readable, which member wrote each entry, and the heirs named: their public key, role, the space key sealed to them, a tag and their name under the space key.", "Encrypted and sealed, with readable ids, kinds and times"],
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
            your ask links, the GitHub token you use for an import, legacy keys and the shares made from them, device secrets, space keys, the photos you capture, your
            storage tokens, the contents of your bundles, what you say by voice (it is turned into text on your device), session intakes and conversations, and
            the stories of a shared memory.
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

          <h2>Live sync, public pages and other selves</h2>
          <p>
            When you connect a source under Sync, your browser (or your connector, for background sync) talks to Google or Slack directly with your own sign-in and
            fetches your mail, events, files or messages there. Those services process that under your account and their own terms. Sigil receives only what was
            encrypted on your device, and never a readable token.
          </p>
          <p>
            Your public AI self answers anyone, from the public copy you publish; that copy is readable by everyone, by your choice. A visitor&apos;s network
            address is used for rate limits and, as a hash together with your page, to count their questions per hour; the address itself is not stored.
          </p>
          <p>
            When your AI self talks with another vault&apos;s, the other owner reads everything your self says in that conversation, and their model provider
            processes it. Choose the folders it may use with that in mind.
          </p>

          <p>
            Backups go from your device to the storage you choose, under your own account there and its terms; what it receives is ciphertext. When you move to
            another node, that node receives your vault as ciphertext and runs under its operator&apos;s own notice. Voice runs on your device: no audio is sent
            anywhere. Visitors who book a session agree to a text you write; you read their intake and the conversation in your vault.
          </p>

          <h2>How long it is kept</h2>
          <ul>
            <li>Your vault, apps and read log: until you delete them, or your account.</li>
            <li>Sessions: 30 days, or until you sign out. Sign-in challenges: 5 minutes.</li>
            <li>Memories you gave an expiry: until the grace period after it is over (30 days unless you change it), then deleted for real.</li>
            <li>Ask link questions and answers in flight: one day. Ask links: until you delete them.</li>
            <li>A vault that moved to another node: until the period its owner chose ends (at most 90 days), then deleted; the addresses that point on, until then.</li>
            <li>Backup records: the last 200 per vault. Session bookings: until you delete the public AI self or your account.</li>
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
