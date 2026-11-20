import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "API reference",
  description: "Every public, ask link and connector endpoint of the Sigil server: requests, responses, errors and limits.",
};

interface Endpoint {
  id: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  params?: [string, string][];
  response: string;
  notes?: string;
}

const publicEndpoints: Endpoint[] = [
  {
    id: "status",
    method: "GET",
    path: "/api/status",
    summary: "Health of the server and the seal job. Running it also seals any finished hour that is still open.",
    response: `{
  "ok": true,
  "time": "2026-11-20T10:00:04.512Z",
  "upSeconds": 86400,
  "database": "ok",
  "seals": {
    "enabled": true,
    "periodSeconds": 3600,
    "mode": "local",
    "job": "ok",
    "currentHour": 496234,
    "open": 2,
    "overdue": 0,
    "lastSealedAt": "2026-11-20T10:00:01.220Z",
    "seals": 41,
    "leaves": 318,
    "latestHour": 496233
  }
}`,
    notes: "job is ok, off or failed. open counts reads waiting for the running hour to end; overdue counts reads from finished hours that are not sealed.",
  },
  {
    id: "stats",
    method: "GET",
    path: "/api/stats",
    summary: "The public counters. Counts only.",
    response: `{ "vaults": 12, "memories": 4310, "apps": 19, "reads": 320, "seals": 41 }`,
    notes: "reads is every read ever sealed plus those waiting for a seal, so it does not drop when a vault is deleted.",
  },
  {
    id: "seals",
    method: "GET",
    path: "/api/seals",
    summary: "The newest seals, newest first.",
    params: [["limit", "1 to 200. Default 24."]],
    response: `{
  "mode": "local",
  "periodSeconds": 3600,
  "seals": [
    {
      "hour": 496233,
      "root": "0x...",
      "leaves": 7,
      "sealedAt": "2026-11-20T10:00:01.220Z",
      "anchorTx": null,
      "anchoredAt": null
    }
  ]
}`,
    notes: "hour is the seal number: the Unix time divided by the period. mode is local, or anchored when roots are also published on chain.",
  },
  {
    id: "seal",
    method: "GET",
    path: "/api/seals/:hour",
    summary: "One seal by its number.",
    response: `{
  "mode": "local",
  "periodSeconds": 3600,
  "seal": { "hour": 496233, "root": "0x...", "leaves": 7, "sealedAt": "...", "anchorTx": null, "anchoredAt": null }
}`,
    notes: "404 with code no_seal when that hour has no seal.",
  },
  {
    id: "proof",
    method: "GET",
    path: "/api/seals/:hour/proof",
    summary: "The Merkle proof for one fingerprint in one seal.",
    params: [["leaf", "The fingerprint: 0x and 64 hex characters."]],
    response: `{
  "hour": 496233,
  "root": "0x...",
  "leaf": "0x...",
  "index": 3,
  "proof": ["0x...", "0x...", "0x..."]
}`,
    notes: "404 with code not_in_seal when the fingerprint is not part of that seal. A fingerprint is a salted hash and reveals nothing about the read behind it.",
  },
  {
    id: "semantic",
    method: "GET",
    path: "/api/semantic",
    summary: "Whether search by meaning is on, and which sentence model the vault page loads. The model runs in the browser.",
    response: `{ "enabled": true, "model": "Xenova/all-MiniLM-L6-v2" }`,
  },
  {
    id: "models",
    method: "GET",
    path: "/models/<model>/<file>",
    summary: "The files of that model: tokenizer.json, tokenizer_config.json and onnx/model_quantized.onnx. Public weights, the same for everyone.",
    response: "The file itself, JSON or binary.",
    notes: "Any other model or file is 404. Missing files are fetched once from the public model hub unless SIGIL_MODEL_FETCH is off.",
  },
];

const askEndpoints: Endpoint[] = [
  {
    id: "ask-link",
    method: "GET",
    path: "/api/ask/:link",
    summary: "What the ask page needs before a question: the link's public key, its encrypted greeting, whether it is active and whether the owner's AI self is online.",
    response: `{
  "id": "...",
  "publicKey": "<32-byte X25519 key, base64url>",
  "intro": "v1...",
  "state": "active",
  "online": true,
  "expiresAt": "2026-11-27T10:00:00.000Z",
  "remaining": 19
}`,
    notes:
      "state is active, expired, revoked or used_up. online means the owner's open vault or connector checked in during the last 30 seconds. The page compares publicKey with the key in its own address (after #) and sends nothing if they differ.",
  },
  {
    id: "ask-question",
    method: "POST",
    path: "/api/ask/:link/questions",
    summary: "One question, sealed in the asker's browser for the owner's agent.",
    params: [
      ["id", "A new random id for the question."],
      ["sessionId", "The conversation's random id."],
      ["askerKey", "The asker's X25519 public key for this conversation, base64url."],
      ["sealed", "The relay box, r1.<nonce>.<ciphertext>: XChaCha20-Poly1305 under the conversation key."],
    ],
    response: `{ "id": "..." }`,
    notes:
      "503 offline when no one is there to answer, 410 expired, revoked or used_up, 429 link_busy over the link's hourly limit, 429 waiting while the last question of the conversation has no answer yet. 8 a minute and 60 an hour per address.",
  },
  {
    id: "ask-answer",
    method: "GET",
    path: "/api/ask/:link/questions/:id",
    summary: "The answer, once there is one, as a relay box only the asker opens.",
    response: `{ "status": "answered", "answer": "r1..." }`,
    notes: "status is waiting, answered, or gone (no answer within two minutes, or the question expired). Questions are deleted a day after they were asked.",
  },
];

const connectorEndpoints: Endpoint[] = [
  {
    id: "folders",
    method: "GET",
    path: "/api/connector/v1/folders",
    summary: "The folders this app may read, with the folder keys wrapped for this app.",
    response: `{
  "appId": "...",
  "folders": [
    { "id": "...", "meta": "v1...", "wrappedKey": "v1...", "count": 12 }
  ]
}`,
    notes: "Logged as: the app listed its folders.",
  },
  {
    id: "index",
    method: "GET",
    path: "/api/connector/v1/index",
    summary: "The encrypted heads (title, tags, source, first lines, dates) of every memory in the granted folders. Search happens on the caller's side.",
    response: `{
  "appId": "...",
  "folders": [...],
  "memories": [
    { "id": "...", "folderId": "...", "head": "v1..." }
  ]
}`,
    notes: "Logged as: the app read the index of N memories. Search words are never sent.",
  },
  {
    id: "read",
    method: "POST",
    path: "/api/connector/v1/read",
    summary: "The full encrypted memories for 1 to 20 ids.",
    params: [["ids", "JSON body: { \"ids\": [\"...\"] }"]],
    response: `{
  "appId": "...",
  "folders": [...],
  "memories": [
    { "id": "...", "folderId": "...", "head": "v1...", "body": "v1..." }
  ],
  "missing": ["..."]
}`,
    notes: "Each memory found is logged as one read. Ids outside the granted folders come back under missing, without saying whether they exist.",
  },
  {
    id: "inbox",
    method: "GET",
    path: "/api/connector/v1/inbox",
    summary: "The vault's public key and the tag the owner's device made for this app. Check the tag with the app secret before sealing anything.",
    response: `{
  "appId": "...",
  "publicKey": "<32-byte X25519 key, base64url>",
  "tag": "<HMAC-SHA256, hex>"
}`,
    notes: "403 with code propose_off unless the owner let this app suggest memories. Not logged: it reads no memory.",
  },
  {
    id: "proposals",
    method: "POST",
    path: "/api/connector/v1/proposals",
    summary: "Puts one suggested memory, sealed to the vault's public key, in the owner's inbox.",
    params: [
      ["id", "A new random id, 8 to 64 letters, digits, - or _."],
      ["sealed", "The sealed box, s1.<ephemeral key>.<nonce>.<ciphertext>, sealed with the context proposal:<id>:<app id>."],
    ],
    response: `{ "appId": "...", "id": "...", "createdAt": "..." }`,
    notes:
      "Logged as: the app suggested a memory. 30 per app per hour (429, propose_limit), up to 500 waiting per vault (429, inbox_full). Anything that is not a sealed box is refused.",
  },
  {
    id: "self",
    method: "GET",
    path: "/api/connector/v1/self",
    summary: "What this app needs to answer as the owner's AI self: the rules, the owner's model key and the vault public key, and the ask links it answers, each encrypted for this app's key only.",
    response: `{
  "appId": "...",
  "config": "v1...",
  "links": [{ "id": "...", "publicKey": "...", "box": "v1..." }]
}`,
    notes: "403 with code self_off unless the owner let this app answer as their AI self. Not logged: it reads no memory.",
  },
  {
    id: "self-pending",
    method: "GET",
    path: "/api/connector/v1/self/pending",
    summary: "Questions waiting for the links this app answers. Calling it marks the app online for those links.",
    response: `{
  "appId": "...",
  "questions": [
    { "id": "...", "linkId": "...", "sessionId": "...", "askerKey": "...", "sealed": "r1...", "createdAt": "..." }
  ]
}`,
  },
  {
    id: "self-answer",
    method: "POST",
    path: "/api/connector/v1/self/questions/:id/answer",
    summary: "The answer for the asker, and the question and answer for the owner's log.",
    params: [
      ["sealed", "The answer as a relay box under the conversation key."],
      ["note", "The question and answer, sealed to the vault public key with the context ask-note:<question id>:<link id>."],
      ["cited", "How many memories the answer used."],
    ],
    response: `{ "ok": true }`,
    notes: "Logged as: your AI self answered a question, with the sealed note.",
  },
  {
    id: "self-asked",
    method: "POST",
    path: "/api/connector/v1/self/asked",
    summary: "The log line for an answer of the ask_self tool, which is made on the owner's machine.",
    params: [
      ["id", "A new random id."],
      ["note", "The question and answer, sealed to the vault public key with the context ask-note:<id>:<app id>."],
      ["cited", "How many memories the answer used."],
    ],
    response: `{ "ok": true }`,
    notes: "30 a minute per app.",
  },
];

const errors: [string, string, string][] = [
  ["400", "invalid", "The request is malformed. The message names the field."],
  ["401", "signed_out", "A vault request without a session."],
  ["401", "app_revoked", "The app key was revoked or never existed."],
  ["403", "origin", "A change to a vault that did not come from the site itself."],
  ["403", "propose_off", "This app may not suggest memories; the owner turns it on under Apps."],
  ["403", "self_off", "This app may not answer as the owner's AI self; the owner turns it on under AI self."],
  ["410", "expired", "The ask link has expired. Also revoked and used_up."],
  ["503", "offline", "The owner's AI self is offline: their vault is not open and their connector is not answering."],
  ["404", "not_found", "No such endpoint. Also no_seal and not_in_seal on the seal endpoints."],
  ["405", "method", "The endpoint exists, the method does not."],
  ["409", "not_sealed", "A proof was asked for an entry whose hour has not been sealed yet."],
  ["409", "stale", "A folder changed while its new key was being made. Reload and try again."],
  ["429", "rate_limited", "Too many requests. Wait a little and try again."],
  ["429", "propose_limit", "The app sent 30 suggestions in the last hour."],
  ["429", "link_busy", "The ask link had as many questions as it takes in an hour."],
];

function EndpointBlock({ e }: { e: Endpoint }) {
  return (
    <section id={e.id} className="endpoint">
      <h3 className="endpoint-head">
        <span className="endpoint-method" data-method={e.method}>
          {e.method}
        </span>
        <code className="endpoint-path">{e.path}</code>
      </h3>
      <p className="endpoint-summary">{e.summary}</p>
      {e.params ? (
        <dl className="endpoint-params">
          {e.params.map(([name, text]) => (
            <div key={name}>
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <CodeBlock code={e.response} label="Response" language="json" />
      {e.notes ? <p className="endpoint-notes">{e.notes}</p> : null}
    </section>
  );
}

export default function ApiReference() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow="API reference"
          title="A small API, read only where it matters"
          lead="Public endpoints anyone can call, and connector endpoints an app key can call. Connected apps can read what they were given and, when allowed, suggest sealed memories; they cannot change one. Everything a connector endpoint returns is encrypted."
        />

        <div className="doc-layout">
          <aside className="doc-aside" aria-label="On this page">
            <p className="doc-aside-label">Public</p>
            <ul>
              {publicEndpoints.map((e) => (
                <li key={e.id}>
                  <a href={`#${e.id}`}>{e.path.replace("/api", "")}</a>
                </li>
              ))}
            </ul>
            <p className="doc-aside-label">Ask links</p>
            <ul>
              {askEndpoints.map((e) => (
                <li key={e.id}>
                  <a href={`#${e.id}`}>{e.path.replace("/api", "")}</a>
                </li>
              ))}
            </ul>
            <p className="doc-aside-label">Connector</p>
            <ul>
              {connectorEndpoints.map((e) => (
                <li key={e.id}>
                  <a href={`#${e.id}`}>{e.path.replace("/api/connector/v1", "")}</a>
                </li>
              ))}
            </ul>
            <p className="doc-aside-label">More</p>
            <ul>
              <li>
                <a href="#auth">Authentication</a>
              </li>
              <li>
                <a href="#errors">Errors and limits</a>
              </li>
              <li>
                <a href="#session">Vault session API</a>
              </li>
            </ul>
          </aside>

          <div className="doc-main">
            <section className="doc-block" aria-labelledby="base-title">
              <h2 id="base-title" className="section-title">
                Base address
              </h2>
              <p className="section-lead">
                Every path below is relative to the Sigil site your vault lives on. Responses are JSON. Errors are JSON too, as{" "}
                <code>{'{ "error": "...", "code": "..." }'}</code>.
              </p>
              <CodeBlock code={`curl ${site.url}/api/seals?limit=3`} label="Terminal" />
            </section>

            <section className="doc-block" aria-labelledby="public-title">
              <h2 id="public-title" className="section-title">
                Public endpoints
              </h2>
              <p className="section-lead">No key, no session. These power the Status, Seals and Verify pages.</p>
              {publicEndpoints.map((e) => (
                <EndpointBlock key={e.id} e={e} />
              ))}
            </section>

            <section className="doc-block" aria-labelledby="ask-title">
              <h2 id="ask-title" className="section-title">
                Ask link endpoints
              </h2>
              <p className="section-lead">
                Anyone holding an ask link can call these. The server relays sealed boxes between the asker&apos;s browser and the owner&apos;s agent
                and keeps the limits; it cannot open a question, an answer or the greeting. How the boxes are made is in the{" "}
                <Link href="/docs#ask-links">docs</Link>.
              </p>
              {askEndpoints.map((e) => (
                <EndpointBlock key={e.id} e={e} />
              ))}
            </section>

            <section className="doc-block" aria-labelledby="auth">
              <h2 id="auth" className="section-title">
                Authentication for connected apps
              </h2>
              <p className="section-lead">
                An app key looks like <code>sigil_app.&lt;app id&gt;.&lt;secret&gt;</code>. The secret is 32 random bytes. It is never sent to the
                server. Four things are derived from it with HKDF-SHA256 (salt <code>sigil/hkdf/v1</code>):
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Result</th>
                      <th>Used for</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <code>sigil:auth:app</code>
                      </td>
                      <td>The bearer token, base64url</td>
                      <td>
                        <code>Authorization: Bearer &lt;token&gt;</code>. The server stores only its SHA-256.
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <code>sigil:wrap:app</code>
                      </td>
                      <td>The app wrap key</td>
                      <td>Opens the folder keys that were wrapped for this app. Stays on the caller&apos;s machine.</td>
                    </tr>
                    <tr>
                      <td>
                        <code>sigil:tag:app-box</code>
                      </td>
                      <td>The tag key</td>
                      <td>
                        Checks the tag on the vault public key from <code>/inbox</code>: HMAC-SHA256 of <code>sigil-box-v1:&lt;public key&gt;</code>.
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <code>sigil:wrap:self</code>
                      </td>
                      <td>The AI self key</td>
                      <td>
                        Opens the AI self config and the ask links from <code>/self</code>, when the owner allowed this app. Stays on the caller&apos;s
                        machine.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="endpoint-notes">
                The connector, the browser extension and the Sign in with Sigil SDK do all of this for you. Use the endpoints directly only when you
                build your own reader; the envelope and sealed box formats and every label are in the{" "}
                <Link href="/docs#encryption">encryption model</Link>. The connector endpoints answer any origin (they take a bearer token, never a
                cookie), so a web app can call them from the browser.
              </p>
            </section>

            <section className="doc-block" aria-labelledby="connector-title">
              <h2 id="connector-title" className="section-title">
                Connector endpoints
              </h2>
              <p className="section-lead">
                One bearer token per app. Reads, suggestions and answers as the owner&apos;s AI self when the owner allows them; every read, every
                suggestion and every answer is written to the vault owner&apos;s read log.
              </p>
              {connectorEndpoints.map((e) => (
                <EndpointBlock key={e.id} e={e} />
              ))}
            </section>

            <section className="doc-block" aria-labelledby="errors">
              <h2 id="errors" className="section-title">
                Errors and limits
              </h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Code</th>
                      <th>Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map(([status, code, text]) => (
                      <tr key={code}>
                        <td>{status}</td>
                        <td>
                          <code>{code}</code>
                        </td>
                        <td>{text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="endpoint-notes">
                Limits per minute: 240 requests per app key, 600 connector requests per address, 240 public requests per address, 40 sign-in
                attempts per address.
              </p>
            </section>

            <section className="doc-block" aria-labelledby="session">
              <h2 id="session" className="section-title">
                The vault session API
              </h2>
              <p className="section-lead">
                The vault page itself talks to a session API: <code>/api/vault</code>, <code>/api/memories</code>, <code>/api/folders</code>{" "}
                (with <code>/rotate</code> for a new folder key), <code>/api/apps</code> (with <code>/inbox</code> for suggestions),{" "}
                <code>/api/proposals</code>, <code>/api/shares</code>, <code>/api/settings</code> (encrypted settings: the AI self&apos;s rules, the
                model key, how the vault thinks), <code>/api/self</code> (ask links, and the open vault answering them), <code>/api/log</code>,{" "}
                <code>/api/keyslots</code> and the sign-in routes under{" "}
                <code>/api/auth</code>. It
                accepts only encrypted payloads, only with a session cookie, and changes only from the site itself. It is not meant for other
                programs; the whole router is one readable file, <code>web/src/server/api.ts</code>.
              </p>
            </section>
          </div>
        </div>

        <PageLinks hrefs={["/connector", "/verify", "/open-source"]} />
      </div>
    </div>
  );
}
