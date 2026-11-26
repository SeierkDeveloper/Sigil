import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PageLinks } from "@/components/PageLinks";
import { CodeBlock } from "@/components/CodeBlock";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "API reference",
  description: "Every public, ask link, node, capture key, session and connector endpoint of the Sigil server: requests, responses, errors and limits.",
};

interface Endpoint {
  id: string;
  method: "GET" | "POST" | "PUT";
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
  {
    id: "seal-roots",
    method: "POST",
    path: "/api/seals/roots",
    summary: "The published roots of many hours at once, for checking a life certificate.",
    params: [["hours", "Up to 20,000 seal numbers."]],
    response: `{ "roots": { "496233": "0x...", "496234": "0x..." } }`,
    notes: "Hours without a seal are left out.",
  },
  {
    id: "certificate",
    method: "GET",
    path: "/api/certificates/:id",
    summary: "A life certificate its owner published by link, exactly as it was signed. It holds no content of the vault.",
    response: `{
  "format": "sigil-life-certificate",
  "version": 1,
  "body": {
    "origin": "https://<your Sigil site>",
    "periodSeconds": 3600,
    "signingKey": "<Ed25519 public key, base64url>",
    "issuedAt": "2026-11-20T10:00:00.000Z",
    "summary": { "firstHour": 490000, "lastHour": 496233, "activeHours": 812, "activeDays": 203, "longestGapHours": 70, "continuousMonths": 8, "...": "..." },
    "hours": [{ "hour": 490000, "entry": { "id": "...", "at": "...", "salt": "...", "sig": "..." }, "index": 3, "proof": ["0x..."], "root": "0x..." }]
  },
  "signature": "<Ed25519 signature, base64url>"
}`,
    notes: "404 no_certificate once the owner takes it down. How to check one is on the verify page.",
  },
  {
    id: "identity-config",
    method: "GET",
    path: "/api/identity/config",
    summary: "Where the registry of AI selves is, once the site has one. Null until a chain id and an address are set.",
    response: `{ "chain": { "chainId": "8453", "registry": "0x...", "rpcUrl": "https://<public read address>" } }`,
    notes: "With chain null, the Identity tab works off chain. The read address is public and read-only; the vault reads a self wallet's spends through it.",
  },
  {
    id: "identity",
    method: "GET",
    path: "/api/identity/at/:address",
    summary: "The identity statement of a self key, signed by the owner's vault key and the self key. This is what the registry's metadata address points to.",
    response: `{
  "format": "sigil-self-identity",
  "version": 1,
  "body": { "selfKey": "0x...", "signingKey": "...", "name": "Sam's AI self", "about": "...", "owner": null, "wallet": null, "chain": null, "origin": "https://...", "issuedAt": "..." },
  "vaultSignature": "<Ed25519, base64url>",
  "selfSignature": "0x<EIP-191 signature>"
}`,
    notes: "404 no_identity when the owner has not signed one or withdrew it. The site checks both signatures before it keeps a statement.",
  },
  {
    id: "proof-of-fact",
    method: "GET",
    path: "/api/proofs/:id",
    summary: "A proof of a fact its owner shared by link: one claim, its evidence, the signature and the sealed entry of the statement.",
    response: `{ "format": "sigil-disclosure", "version": 1, "statement": { "claim": { "kind": "field", "opening": { "name": "Nationality", "value": "...", "salt": "...", "index": 2, "proof": ["0x..."] }, "commitment": "0x..." }, "...": "..." }, "signature": "...", "anchor": { "kind": "disclose", "memoryId": "0x...", "hour": 496233, "proof": ["0x..."], "root": "0x..." } }`,
    notes: "404 no_proof once the owner takes it down. How to check one is on the verify page.",
  },
  {
    id: "emergency-card",
    method: "GET",
    path: "/api/e/:id",
    summary: "An emergency card's ciphertext. The key is only in the link after #, so the server cannot open what it serves. Each call is recorded for the owner with the time, a device class and a language.",
    response: `{ "card": "v1.<iv>.<ciphertext>", "updatedAt": "2026-11-20T10:00:00.000Z" }`,
    notes: "404 no_card when the owner took it down or issued a new code. 60 a minute per address.",
  },
  {
    id: "pack",
    method: "GET",
    path: "/api/packs/at/:id",
    summary: "A knowledge pack, as its publisher signed it: the newest version, or one by number with ?version=n.",
    response: `{ "format": "sigil-knowledge-pack", "version": 1, "body": { "id": "...", "title": "Bread", "version": 2, "previous": "0x...", "publisher": { "name": "Sam", "signingKey": "..." }, "items": [], "...": "..." }, "hash": "0x...", "signature": "..." }`,
    notes: "GET /api/packs/at/:id/versions lists every version with its hash. 404 no_pack once the publisher takes it down.",
  },
  {
    id: "pairing-open",
    method: "POST",
    path: "/api/devices/pairings",
    summary: "A new device opens a pairing: its one-time X25519 public key, the ten-character code made from that key, and a secret only it holds.",
    params: [
      ["id", "A new random id."],
      ["publicKey", "The one-time public key, base64url."],
      ["code", "XXXXX-XXXXX, the hash of the key in Crockford base32. Refused when it does not match the key."],
      ["pollSecret", "32 random bytes, base64url. The server keeps its hash."],
    ],
    response: `{ "expiresAt": "2026-11-20T10:10:00.000Z" }`,
    notes: "A pairing lasts ten minutes. 20 a minute per address.",
  },
  {
    id: "pairing-poll",
    method: "POST",
    path: "/api/devices/pairings/:id/poll",
    summary: "The new device asks for its sealed box with its poll secret. It is handed out once and then deleted.",
    params: [["pollSecret", "The secret from opening the pairing."]],
    response: `{ "state": "ready", "sealed": "s1..." }`,
    notes: "state is waiting, ready or gone. The box is sealed to the one-time key; only the new device opens it.",
  },
];

const nodeEndpoints: Endpoint[] = [
  {
    id: "health",
    method: "GET",
    path: "/api/health",
    summary: "The node's health, for a container's health check, a load balancer or another node. It touches no vault.",
    response: `{ "ok": true, "node": { "origin": "https://node.example", "version": "0.1.0", "spec": "1.5.0" }, "time": "2026-11-20T10:00:00.000Z" }`,
    notes: "Any origin may call it.",
  },
  {
    id: "restore-fetch",
    method: "POST",
    path: "/api/restore/fetch",
    summary: "Fetches a bundle for a restore from a public address (an IPFS or Arweave gateway, a bucket address presigned on the owner's device) and passes its bytes on. Nothing is kept.",
    params: [["url", "An https address. A private network address is refused unless the node allows it (SIGIL_NODE_ALLOW_PRIVATE)."]],
    response: "The bundle file's bytes, application/octet-stream.",
    notes: "From the site itself only. 10 a minute per address. Redirects are not followed.",
  },
  {
    id: "restore",
    method: "POST",
    path: "/api/restore",
    summary: "Takes a bundle in as a new vault on this node, with the owner's sign-in and a statement the vault key signed for this node. Opens a session.",
    params: [
      ["bundle", "The vault bundle (open standard, part 11)."],
      ["signIn", "{ kind: wallet or phrase, ref, authToken }: the SHA-256 of authToken must be the bundle key slot's authHash."],
      ["statement", "{ issuedAt, signature }: Ed25519 by the vault's signing key over sigil-restore-v1, this node's origin, the bundle hash and issuedAt; at most ten minutes old."],
      ["arrival", "For a move: { code, at, signature, redirectDays }. The node fetches the move from the old node again and tells it once the vault is in."],
    ],
    response: `{ "report": { "userId": "...", "hash": "0x...", "folders": 4, "memories": 120, "logEntries": 310, "taken": { "apps": 2 }, "left": {} }, "confirmed": true }`,
    notes: "409 vault_exists when the vault, or one of its sign-in methods, is already on this node. 403 bad_restore or bad_sign_in. 400 bad_bundle.",
  },
  {
    id: "move-fetch",
    method: "GET",
    path: "/api/nodes/moves/:id",
    summary: "Node to node: the move statement, its signature and the bundle, for the holder of the move's secret.",
    params: [["Authorization", "Bearer <the secret from the move code>. The old node keeps only its hash."]],
    response: `{ "move": { "statement": { "format": "sigil-move", "v": 1, "id": "...", "vault": "...", "from": "...", "to": "...", "bundle": "0x...", "redirectDays": 30, "issuedAt": "..." }, "signature": "..." }, "bundle": { "...": "..." } }`,
    notes: "410 move_closed once cancelled or done. The first fetch is logged as bundle-sent.",
  },
  {
    id: "move-done",
    method: "POST",
    path: "/api/nodes/moves/:id/done",
    summary: "Node to node: the arrival the owner's device signed on the new node. Once it holds under the vault's key, the old node sends the vault's addresses on and deletes it when the period ends.",
    params: [
      ["Authorization", "Bearer <the move's secret>."],
      ["at, signature", "Ed25519 by the vault's signing key over sigil-arrived-v1, the move id, the new origin, the bundle hash and at."],
    ],
    response: `{ "until": "2026-12-20T10:00:00.000Z" }`,
    notes: "403 bad_arrival. Afterwards sign-ins, app keys and the vault's public addresses answer 410 moved with { to }.",
  },
  {
    id: "capture-key",
    method: "GET",
    path: "/api/capture/v1/key",
    summary: "For a capture key: the vault public key and the tag the owner's vault made over it for this key. Check the tag before sealing anything.",
    params: [["Authorization", "Bearer <base64url HKDF(secret, sigil:auth:capture)>."]],
    response: `{ "captureId": "...", "publicKey": "...", "tag": "<hex>" }`,
    notes: "401 capture_revoked for a revoked key.",
  },
  {
    id: "capture",
    method: "POST",
    path: "/api/capture/v1",
    summary: "One capture into the inbox, sealed on the sending device to the vault public key, as a proposal whose app id is the capture key's id.",
    params: [
      ["id", "The proposal id."],
      ["sealed", "The sealed proposal, context proposal:<id>:<capture key id>."],
    ],
    response: `{ "id": "...", "createdAt": "2026-11-20T10:00:00.000Z" }`,
    notes: "20 a minute and 300 a day per key; an inbox holds 500. POST /api/capture/v1/text with { text, title } is for a key the owner allowed plain text: sealed by the node on arrival, 403 plain_off otherwise.",
  },
  {
    id: "sessions-offer",
    method: "GET",
    path: "/api/public/at/:handle/sessions",
    summary: "A public AI self's sessions: the offer (topics, questions, length, house rules, intake, consent) and the free times of the next two weeks.",
    response: `{ "selfId": "...", "handle": "gardener", "name": "...", "publicKey": "...", "offer": { "turns": 8, "slotMinutes": 30, "houseRules": "...", "...": "..." }, "slots": [{ "start": "...", "end": "..." }] }`,
    notes: "offer is null when the owner takes no bookings.",
  },
  {
    id: "sessions-book",
    method: "POST",
    path: "/api/public/at/:handle/sessions",
    summary: "Books a free time. The intake is sealed in the visitor's browser to the public self's key.",
    params: [
      ["id, slotStart, topic", "The booking."],
      ["intake", "Sealed to the public self's key, context session-intake:<self id>:<booking id>."],
      ["tokenHash", "SHA-256 of the session token from the link's secret."],
      ["askerKey", "The visitor's X25519 key for the session, made from the link's secret."],
    ],
    response: `{ "id": "...", "slotStart": "...", "slotEnd": "..." }`,
    notes: "409 slot_taken; 403 blocked; 429 visitor_limit (two upcoming sessions per visitor). 6 a minute per address.",
  },
  {
    id: "session",
    method: "GET",
    path: "/api/sessions/:id",
    summary: "A session, for the bearer of its link: its topic, time, questions used, house rules, whether the host's AI self is answering, and why a question cannot be asked now, if so.",
    params: [["Authorization", "Bearer <session token>."]],
    response: `{ "topic": "Soil", "slotStart": "...", "slotEnd": "...", "turns": 8, "used": 1, "state": "booked", "houseRules": "...", "online": true, "problem": null, "...": "..." }`,
    notes: "POST /api/sessions/:id/questions with { id, sealed } asks (409 session_closed outside its time or questions, 503 offline); GET /api/sessions/:id/questions/:qid gives the sealed answer.",
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
  {
    id: "public-page",
    method: "GET",
    path: "/api/public/at/:handle",
    summary: "A public AI self: its name, greeting and published key, whether it is on and online, the titles of its public notes, and the answers its owner shows.",
    response: `{
  "id": "...",
  "handle": "sam",
  "name": "Sam's AI self",
  "greeting": "Ask me about my talks.",
  "publicKey": "<32-byte X25519 key, base64url>",
  "enabled": true,
  "online": true,
  "perVisitorHour": 10,
  "showAnswers": true,
  "items": [{ "id": "...", "title": "Talks", "tags": [], "editedAt": "..." }],
  "wall": [{ "id": "...", "question": "...", "answer": "...", "sources": [{ "id": "...", "title": "Talks" }], "createdAt": "..." }]
}`,
    notes: "GET /api/public/at/:handle/items/:id gives one public note in full. 404 no_public when there is no such page.",
  },
  {
    id: "public-question",
    method: "POST",
    path: "/api/public/at/:handle/questions",
    summary: "One question to a public AI self, sealed in the visitor's browser like an ask link question, with the conversation key made from the published key.",
    params: [
      ["id", "A new random id for the question."],
      ["sessionId", "The conversation's random id."],
      ["askerKey", "The visitor's X25519 public key for this conversation."],
      ["sealed", "The relay box, r1.<nonce>.<ciphertext>."],
    ],
    response: `{ "id": "..." }`,
    notes:
      "Poll GET /api/public/at/:handle/questions/:id for the answer, a relay box holding { text, refused, sources }. 503 offline, 410 off, 429 visitor_limit over the owner's limit per visitor an hour (counted by a hash of the address and the page), 429 waiting.",
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
  {
    id: "agent",
    method: "GET",
    path: "/api/connector/v1/agent",
    summary: "For an agent key: its own folder, its tool rules and the folders it may write.",
    response: `{ "appId": "...", "homeFolderId": "...", "rules": { "remember": true, "recall": true, "forget": false, "handoff": true }, "writable": ["..."], "publicKey": "..." }`,
    notes: "403 not_agent for an ordinary app key. The tools of an agent with recall off still get the folders they may write from /folders, so they can encrypt for them.",
  },
  {
    id: "remember",
    method: "POST",
    path: "/api/connector/v1/remember",
    summary: "Memories an agent encrypted on its machine with the key of a folder it may write.",
    params: [["memories", "1 to 20 of { id, folderId, head, body }, each an envelope."]],
    response: `{ "appId": "...", "saved": 1 }`,
    notes: "403 remember_off, or read_only for a folder it may not write. 300 an hour per agent. Each is logged as remember.",
  },
  {
    id: "forget",
    method: "POST",
    path: "/api/connector/v1/forget",
    summary: "Deletes memories for good, only in folders the agent may write.",
    params: [["ids", "1 to 50 memory ids."]],
    response: `{ "appId": "...", "deleted": ["..."], "refused": ["..."] }`,
    notes: "403 forget_off unless the owner allowed it. Each deletion is logged as forget.",
  },
  {
    id: "handoffs",
    method: "GET",
    path: "/api/connector/v1/handoffs",
    summary: "Handoff notes waiting for this agent: its own from earlier sessions, and notes other agents left in its spaces.",
    response: `{ "appId": "...", "handoffs": [{ "id": "...", "fromApp": "...", "spaceId": null, "sealed": "v1...", "createdAt": "..." }] }`,
    notes: "POST the same path with { id, sealed, spaceId } to leave one, and POST /handoffs/picked with { ids } to mark them picked up. 403 handoff_off when the owner turned the tool off.",
  },
  {
    id: "agent-spaces",
    method: "GET",
    path: "/api/connector/v1/spaces",
    summary: "The team spaces this agent is in: the space key sealed to the agent's own key, the members and the memories.",
    response: `{ "appId": "...", "spaces": [{ "id": "...", "meta": "v1...", "epoch": 2, "me": { "id": "...", "role": "write", "sealedKey": "s1..." }, "members": [], "memories": [] }] }`,
    notes: "POST /spaces/:id/memories with { memories } writes, POST /spaces/:id/forget with { ids } deletes, with a write role. Every call is logged as space.",
  },
  {
    id: "protected-reads",
    method: "POST",
    path: "/api/connector/v1/read",
    summary: "With protected folders: memories in a protected folder come back in held until the owner says yes for that read.",
    response: `{ "appId": "...", "folders": [], "memories": [], "missing": [], "held": [{ "folderId": "...", "memoryIds": ["..."], "requestId": "...", "state": "pending" }] }`,
    notes:
      "The request waits in the owner's inbox for 30 minutes. A yes lasts 10 minutes and is used up by the next read that it covers, logged as protected. GET /index leaves protected folders out; GET /index?protected=<folder id> asks to look through one, with the same flow.",
  },
  {
    id: "sync",
    method: "GET",
    path: "/api/connector/v1/sync",
    summary: "The live sync sources the owner lets this app sync while the vault is closed: each wrapped for this app's sync key, with its folder and whether it is paused.",
    response: `{ "appId": "...", "sources": [{ "id": "...", "folderId": "...", "box": "v1...", "rev": 4, "ownerRev": 3, "paused": false }] }`,
    notes:
      "PUT /sync/:id with { box, rev } saves a newer copy (409 stale for an older one). POST /sync/:id/memories with { memories } writes encrypted memories, only into the source's folder; POST /sync/:id/delete with { ids } removes them. Each is logged as sync.",
  },
  {
    id: "public-self",
    method: "GET",
    path: "/api/connector/v1/public",
    summary: "The public AI self, when the owner picked this app to answer it: its key and rules wrapped for this app, and the public copy it answers from.",
    response: `{ "appId": "...", "self": { "id": "...", "handle": "sam", "publicKey": "...", "box": "v1...", "enabled": true, "items": [] } }`,
    notes: "GET /public/pending marks it online and gives waiting questions; POST /public/questions/:id/answer with { sealed, note, cited, wall } answers. 403 public_off for any other app. A question in a booked session comes with its booking (topic, the sealed intake, house rules, which turn); its note is the turn sealed for the owner's transcript, and it never goes on the page.",
  },
  {
    id: "backup",
    method: "GET",
    path: "/api/connector/v1/backup",
    summary: "For a connector the owner lets back the vault up: the storage targets wrapped for this app's key (HKDF(secret, sigil:wrap:backup)), and when the vault was last backed up.",
    response: `{ "appId": "...", "box": "v1...", "lastAt": "2026-11-19T10:00:00.000Z" }`,
    notes: "GET /backup/bundle gives the vault's bundle body as ciphertext; POST /backup/done with { id, hash, size, record, places } logs a backup, record sealed to the vault public key. 403 backup_off for any other app.",
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
  ["410", "moved", "The vault moved to another node; to names it. Sign-ins, app keys and its public addresses answer this until the old node deletes it."],
  ["401", "capture_revoked", "The capture key was revoked or never existed."],
  ["403", "plain_off", "This capture key seals on the device; the owner has not allowed plain text for it."],
  ["409", "session_closed", "A question outside its session's time or number of questions, or in an ended session."],
  ["409", "vault_exists", "A restore of a vault, or of a sign-in method, that is already on this node."],
  ["409", "stale", "A folder changed while its new key was being made. Reload and try again."],
  ["429", "rate_limited", "Too many requests. Wait a little and try again."],
  ["429", "propose_limit", "The app sent 30 suggestions in the last hour."],
  ["429", "link_busy", "The ask link had as many questions as it takes in an hour."],
  ["403", "not_releasable", "A legacy plan was asked for a share or a bundle while its owner is still active."],
  ["403", "not_agent", "An agent route was called with an ordinary app key."],
  ["403", "remember_off", "The owner turned this agent's tool off. Also recall_off, forget_off and handoff_off."],
  ["403", "read_only", "An agent tried to write a folder it may only read."],
  ["403", "role", "A space member tried something their role does not allow."],
  ["404", "no_pairing", "No device is waiting with that code, or it expired or was used."],
  ["404", "unknown_device", "A device that was revoked tried to sign in."],
  ["400", "bad_signature", "A signature (presence, an identity statement, an agreement) does not check out against the key the server holds."],
  ["409", "decided", "A draft of the AI self was already approved or discarded."],
  ["409", "drafted", "There is already a draft for this question or turn."],
  ["409", "closed", "The agreement is no longer open for signing."],
  ["404", "no_card", "No emergency card at this address. Also no_proof, no_pack and no_identity."],
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
            <p className="doc-aside-label">Nodes, capture and sessions</p>
            <ul>
              {nodeEndpoints.map((e) => (
                <li key={e.id}>
                  <a href={`#${e.id}`}>{e.path.replace("/api", "")}</a>
                </li>
              ))}
            </ul>
            <p className="doc-aside-label">Ask links and public pages</p>
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

            <section className="doc-block" aria-labelledby="nodes-title">
              <h2 id="nodes-title" className="section-title">
                Nodes, capture keys and sessions
              </h2>
              <p className="section-lead">
                A node&apos;s health, restoring and moving a vault (the formats are in the <Link href="/spec">open standard</Link>, part 11), the write-only capture
                keys and booked sessions with a public AI self (part 12).
              </p>
              {nodeEndpoints.map((e) => (
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
                <code>/api/keyslots</code>, <code>/api/access</code> (requests to read a protected folder, and the owner&apos;s yes or no),{" "}
                <code>/api/sync</code> (live sync sources), <code>/api/public/self</code> (the public AI self and its public copy), <code>/api/meets</code>{" "}
                (selves meet), <code>/api/self/identity</code> (the self key&apos;s address and its signed statement), <code>/api/drafts</code> (the AI self&apos;s approval
                queue), <code>/api/disclosures</code> (proofs of a fact), <code>/api/emergency</code> (the emergency card and its openings),{" "}
                <code>/api/agreements</code> (sealed agreements), <code>/api/packs</code> (knowledge packs), <code>/api/bundle</code> and{" "}
                <code>/api/backups</code> (the vault&apos;s bundle and the record of each backup), <code>/api/nodes</code> (where the vault lives, and moves),{" "}
                <code>/api/capture-keys</code>, <code>/api/sessions</code> and <code>/api/public/self/sessions</code> (bookings and the offer),{" "}
                <code>/api/spaces/:id/heirs</code> and <code>/leave</code> (shared memory) and the sign-in routes under{" "}
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
