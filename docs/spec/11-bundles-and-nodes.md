# 11. Bundles, storage and nodes

Added in 1.2. A vault can be written out whole, as ciphertext, kept wherever its owner chooses, restored on any Sigil node, and moved from one node to another.

## The vault bundle

A bundle is the vault as a node stores it, in one document:

```json
{ "format": "sigil-vault-bundle", "version": 1,
  "body": {
    "origin": "https://node.example", "periodSeconds": 3600, "createdAt": "...", "madeBy": "vault | connector",
    "vault": { "boxPublicKey", "boxWrappedSecret", "signKey", "createdAt" },
    "keyslots": [{ "kind": "passkey | wallet | phrase", "ref", "authHash", "wrappedKey", "passkey"? }],
    "folders": [{ "id", "meta", "wrappedKey", "protected", "createdAt" }],
    "memories": [{ "id", "folderId", "head", "body", "deleteAfter", "updatedAt" }],
    "settings": { "<setting name>": "<envelope>" },
    "log": [{ "id", "appId", "kind", "memoryId", "count", "at", "salt", "leaf", "hour", "note", "seal" }],
    "parts": { "apps", "legacy", "spaces", "publicSelf", "askLinks", "packs", "emergency", "proposals", "drafts",
               "disclosures", "certificates", "sync", "identity", "nodes", "captureKeys", "sessions", "backups" } },
  "hash": "<hex32>", "signature": "<base64url> | null" }
```

Every value in it is one the node already held: envelopes (part 2), sealed boxes, wrapped keys, SHA-256 hashes of sign-in tokens, public keys and ids. Device key slots are left out, since a device's key lives on that device; a passkey slot is kept but works again only on a node with the same domain. Each `parts` entry is a list of rows as the node keeps them; a node takes in the rows it knows and reports the rest.

A log entry carries its `seal`: the node it was sealed on, that node's period, the hour's root, the leaf's index and its Merkle path (part 5), or null when its hour was not sealed yet. A node that takes the bundle in keeps these entries as carried: they are not sealed again, and their proof is the one they came with, checked against the roots of the node that sealed them.

```
hash       = hex32(SHA-256("sigil-vault-bundle-v1" \n canonical JSON of the body))
signature  = Ed25519 by the vault's signing key (part 5) over the same bytes
```

A bundle made on the owner's device is signed (`madeBy` is `vault`). A bundle a connector makes in the background has no signature (`madeBy` is `connector`), since a connector never holds the vault key. A bundle file is gzip of the bundle's JSON; plain JSON must be read too. The `vaultBundle` vector shows a canonical body, its hash and its signature.

### Checking a bundle

Anyone can check the form, that `hash` covers the body, and the signature against `body.vault.signKey`. The owner checks the rest on their device, with the vault key: the signing key derived from it (part 5) is `signKey`, the box key's private half opens and matches `boxPublicKey`, every folder key unwraps with the AAD of its folder, every head, body and setting decrypts with the AAD of its own record. An item that does not is reported, never taken in silently.

### Restoring

The owner restores with a sign-in method the bundle carries, on any node: the recovery phrase or a wallet. The device derives the method's key (part 2), unwraps the vault key from the bundle's own key slot, checks the bundle as above, and signs a restore statement for this node:

```
sigil-restore-v1
<the node's origin>
<the bundle's hash>
<issuedAt>
```

It sends the bundle, the method (`kind`, `ref` and its sign-in token, whose SHA-256 must be the slot's `authHash`) and the statement to `POST /api/restore`. The node accepts it only when the signature holds under `signKey`, the statement names its own origin and is at most ten minutes old, and no vault on it has the same box key, signing key or sign-in method. It then makes a new account holding every row of the bundle, opens a session, and writes a `node` entry `restored-<hash>`. The `restoreStatement` vector shows one statement and its signature.

A node may also fetch a bundle for the owner from a public address (`POST /api/restore/fetch`): an IPFS gateway, an Arweave gateway, or a presigned address of a bucket made on the owner's device. It fetches over HTTPS only, follows no redirect to a private address, and keeps nothing.

## Storage

Where a bundle is kept is the owner's choice, made in their vault, with their own account at each service. The settings, with the tokens, are a vault setting named `backup`, an envelope under the vault key; for a connector the owner lets back up in the background, the same targets are an envelope under HKDF(app secret, `sigil:wrap:backup`) with the AAD `sigil:backup-app:<app id>`. The `backupKey` vector shows that key. Uploads run on the owner's device or in the connector, never on the node.

| Backend | Upload | Read back |
| --- | --- | --- |
| A file | Downloaded on the device | Chosen on the device |
| An S3-compatible bucket | `PUT <endpoint>/<bucket>/<prefix><name>`, signed with AWS Signature Version 4 on the device | A signed `GET`, or a presigned address made on the device |
| IPFS, a pinning service | `POST <endpoint>/pinning/pinFileToIPFS` with the owner's bearer token | `<gateway>/ipfs/<cid>` |
| IPFS, the owner's own node | `POST <endpoint>/api/v0/add?pin=true&cid-version=1` | `<gateway>/ipfs/<cid>` |
| Arweave | A data item (ANS-104, signature type 1) signed on the device with the owner's Arweave key, `POST` to the owner's chosen bundler | `<gateway>/<id>` |

A data item's id is base64url(SHA-256(signature)); the device computes it and refuses a bundler that answers with another. Its tags are `Content-Type: application/octet-stream` and `App-Name: Sigil`, serialized as Avro and signed through Arweave's deep hash (SHA-384). The `arweaveItem` vector shows the serialized tags and two deep hashes.

How long a bundle lasts is the backend's matter, not Sigil's: a bucket keeps it while its account and the object exist, a pinning service while the pin is kept, Arweave while its network keeps what was paid for. Sigil does not pay for, renew or check any of it.

Each backup is a `backup` entry of the log (part 4), memoryId the bundle's hash, appId `vault` or the connector's app id. Where it went (the object key, content id or transaction id of each place) is a record sealed to the vault public key with the context `backup-run:<run id>`; the node keeps the record, the time, the hash and the size.

## Nodes

Every Sigil server is a node. It serves `GET /api/health`:

```json
{ "ok": true, "node": { "origin": "https://node.example", "version": "0.1.0", "spec": "1.4.0" }, "time": "..." }
```

A node's address is an https origin; plain http is allowed only for a node on the same machine.

### Moving a vault

1. On the old node, the owner's device builds and signs a bundle and a move statement:

   ```json
   { "format": "sigil-move", "v": 1, "id": "<move id>", "vault": "<signing key>", "from": "<old origin>", "to": "<new origin>",
     "bundle": "<hex32 bundle hash>", "redirectDays": 30, "issuedAt": "..." }
   ```

   signed with Ed25519 over `sigil-move-v1` newline canonical JSON. `redirectDays` is 1 to 90. The device makes a 32-byte secret and sends the statement, the signature, the bundle and SHA-256 of the secret to `POST /api/nodes/moves`. The old node checks the signature against the signing key the vault registered and that `from` is its own origin, keeps the bundle, and logs `node` entry `move-signed-<move id>`. The `moveStatement` vector shows a statement, its hash and its signature.

2. The owner carries the move code to the new node, in the address `<to>/vault/restore#move=<code>`:

   ```
   sigil_move.<base64url of the old origin>.<move id>.<secret>
   ```

3. The new node fetches the move from the old one, node to node, with the secret as a bearer token: `GET <from>/api/nodes/moves/<move id>`, answered with the statement, its signature and the bundle. It checks the signature, that `to` is its own origin, that `vault` is the bundle's signing key and that `bundle` is the bundle's hash. The old node logs `bundle-sent-<move id>`.

4. The owner signs in on the new node with the bundle's own key slot and restores it as above. The device also signs an arrival statement:

   ```
   sigil-arrived-v1
   <move id>
   <new origin>
   <bundle hash>
   <at>
   ```

   The new node logs `node` entry `arrived-<move id>` and sends the arrival to `POST <from>/api/nodes/moves/<move id>/done` with the secret. The `arrival` vector shows one.

5. The old node checks the arrival against the vault's signing key, logs `moved-<move id>`, and from then on answers for the vault only by pointing to the new address: the pages of its ask links, its public page at `/@handle`, its packs and its emergency card redirect there, and their API routes answer 410 with `{ "code": "moved", "to": "<address>" }`; sign-ins and app keys get the same answer. When `redirectDays` have passed it deletes the vault.

The vault's node list shows where it lives: the node it is on, the nodes it came from with the time each one keeps sending links on, and the places its bundles were stored. A move that was signed but never fetched can be cancelled on the old node.
