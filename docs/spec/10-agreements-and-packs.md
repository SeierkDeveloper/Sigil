# 10. Agreements and knowledge packs

## Agreements

An agreement is a document both vaults sign:

```json
{ "title": "...", "text": "...", "parties": [{ "name", "boxKey", "signingKey" }, { ... }],
  "version": 1, "previous": null, "nonce": "<16 random bytes>", "createdAt": "..." }
```

The parties are named by their vault box key (part 2) and their Ed25519 signing key (part 5); the first party drafted it. The nonce keeps a short text from being guessed from its hash.

```
hash       = hex32(SHA-256("sigil-agreement-v1" \n canonical JSON of the document))
signature  = Ed25519 by each party's signing key over "sigil-agreement-sign-v1" \n hash
```

The first party signs when it sends the document, sealed to the second party's box key with the context `agreement:<agreement id>`. The second party opens it on its device and must check before signing that the document names it with its own box key and signing key, that the first party's signing key is the one the site holds for the vault it came from, that the hash is the document's, and that the first signature holds. A site checks each signature against the signing key that vault registered, and keeps the hash, the keys and the signatures; never the text. Once both signed, the hash is an `agreement` entry with count 2 in both parties' logs (part 4).

Nothing signed is changed. An amendment is a new document whose `previous` is the hash of a signed agreement between the same two vaults and whose version is one higher; an agreement has at most one amendment open or signed.

A verifiable copy is `{ "format": "sigil-agreement", "version": 1, "doc", "hash", "signatures": [first, second], "seal" }`, where `seal` is the showing party's `agreement` entry with its proof and root, and `party` (0 or 1). A checker confirms the hash, both signatures, the entry (kind `agreement`, memoryId the hash, its proof) and that the root is published. The `agreement` vector shows a canonical document, its hash and both signatures.

## Knowledge packs

A pack is a folder made public, signed by the publisher's vault:

```json
{ "format": "sigil-knowledge-pack", "version": 1,
  "body": { "id", "title", "description", "version", "publisher": { "name", "signingKey" }, "previous", "items": [{ "id", "title", "body", "tags" }], "origin", "publishedAt" },
  "hash": "<hex32>", "signature": "<base64url>" }
```

`hash` is hex32(SHA-256(`sigil-knowledge-pack-v1` newline canonical JSON of the body)); the signature is Ed25519 by the publisher's signing key over the same bytes. Items are the folder's memories, masked with the folder's redaction rules; a protected folder is never published. Version 1 has `previous` null; every later version names the hash of the one before and is one higher. A site accepts a version only from the vault that published the first, signed by the same key, in order, and serves every version (`GET /api/packs/at/<id>`, `?version=<n>`). The `knowledgePack` vector shows a canonical body, its hash and its signature.

A vault that follows a pack pins the publisher's signing key from the version it first took in, and keeps the list of packs it follows in an encrypted setting named `packs`. Each time it opens it fetches the newest version and every version in between, checks each against the pinned key and the hash of the one before, and replaces the copy in its pack folder. A followed memory's id is base64url(HMAC-SHA256(HKDF(folder key, `sigil:pack-id`), pack id newline item id)), cut to 22 characters, so it is the same on every device of that vault and means nothing to the site. Packs are free.
