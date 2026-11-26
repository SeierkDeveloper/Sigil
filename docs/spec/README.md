# The Sigil open standard

Version 1.5.0

This is the format a Sigil vault keeps memories in, how its keys work, what a connector may do and how it asks, what the access log records, how the log is sealed and proved, the signed documents a vault hands out: the AI self's identity, proofs of a fact, the emergency card, agreements and knowledge packs, and since 1.2 how a whole vault is written out as a bundle, kept, restored on any node and moved between nodes, capture keys, sessions with a public AI self and shared memory, since 1.3 the memory immune system against hidden instructions and its public hourly record, and since 1.5 the AI self's limits for acting and the receipts it signs for what it does on its own. Anyone may build a vault, a connector or a checker from it. The reference code is in this repository (`packages/core`), and the test vectors in [`vectors.json`](vectors.json) are generated from that code; `packages/core/test/spec.test.ts` checks on every test run that the code still produces them.

## Parts

| Part | What it covers |
| --- | --- |
| [1. Memories and folders](01-memories.md) | The memory format, folders, protected folders and their meta |
| [2. Keys, envelopes and sealed boxes](02-keys.md) | The key hierarchy, every derivation, the envelope, sealed box, relay and meet formats |
| [3. The connector](03-connector.md) | The MCP tools, their permissions, the HTTP routes an app key may call, protected reads, redaction |
| [4. The access log](04-access-log.md) | The fields of an entry, its kinds, the leaf it is sealed as, and the privacy score |
| [5. Seals and presence](05-seals.md) | The Merkle rules, the hourly seal, the contract, presence statements |
| [6. Certificates](06-certificates.md) | The life certificate and how it is checked |
| [7. The AI self's identity and wallet](07-identity.md) | The self key, the identity statement, the registry and wallet contracts, wallet rules |
| [8. Proofs of a fact](08-proofs.md) | Field commitments, the four claims, the signed statement and its sealed entry, what each claim rests on |
| [9. The emergency card](09-emergency.md) | The card, the key in the link, what an opening records |
| [10. Agreements and knowledge packs](10-agreements-and-packs.md) | Two signatures over one hash, amendments, signed packs and following them |
| [11. Bundles, storage and nodes](11-bundles-and-nodes.md) | The vault bundle, checking and restoring it, the storage backends, a node's health, moving a vault between nodes |
| [12. Capture keys, sessions and shared memory](12-capture-sessions-and-shared-memory.md) | Write-only capture keys, sessions with a public AI self, family and team history with heirs |
| [13. The memory immune system](13-immune.md) | Checking memories from outside for hidden instructions, holding and approving them, quoting memories for a model, the `injection` log kind, the hourly public record |

## Conventions

- **Must** and **must not** are requirements; **should** is a strong recommendation.
- Bytes in text are base64url without padding, unless a field says hex. Hex is lowercase; a 32-byte hash written with `0x` is called hex32.
- Strings are UTF-8. JSON inside an envelope is compact, as `JSON.stringify` writes it.
- Times are ISO 8601 in UTC with milliseconds (`2026-11-20T10:15:00.000Z`).
- Ids are 8 to 64 characters of `A-Z a-z 0-9 _ -`. New ids are 16 random bytes in base64url.
- All primitives are standard: AES-256-GCM, HKDF-SHA256, SHA-256, HMAC-SHA256, X25519, Ed25519 and XChaCha20-Poly1305; for the AI self's identity on EVM chains, also secp256k1 ECDSA, Keccak-256, EIP-55, EIP-191 and EIP-712.

## Test vectors

`vectors.json` has three parts. `input` holds the fixed keys and ids every vector starts from. `deterministic` holds values that follow from their inputs alone: an implementation must produce them byte for byte. `sealed` holds values made with a fresh random nonce, which cannot be made again: an implementation must open each with the key it names and get the plaintext listed. Each vector is named in the part of this standard that defines it, in backquotes, for example `hkdf`.

## Versioning

The version follows semantic versioning. A change that makes data written by an older version unreadable, or makes a vector change, is a new major version, and the vectors are written again (`npm run vectors -w @sigil/core`). Every format string carries its own version (`v1.`, `s1.`, `r1.`, `m1.`, `sigil-read-v1`), so old and new data can be told apart. A change that only adds formats is a new minor version: 1.1.0 added parts 7 to 10, new access log kinds and their vectors, and left every vector of 1.0.0 as it was; 1.2.0 added parts 11 and 12, the log kinds `backup`, `node`, `capture` and `session`, and their vectors, and left every earlier vector as it was; 1.3.0 added the v2 ask link key (`askKeyV2`), the connector bundle's HMAC, the legacy release proof, part 13 with the log kind `injection` and its vectors, and left every earlier vector as it was. 1.4.0 changed part 7's contract formats after the HeyResearch security review, before any of the contracts was deployed: the wallet keeps recipients apart from contracts (`configure` takes them as their own list), a signed call names the gas its call gets (`Execute` gained `gas`, the wallet's EIP-712 domain is version 2), a token's decimals are read from the token on chain, and a registry transfer needs the new owner to accept. The `executeDigest` and `walletRules` vectors were written again; every other vector is as it was. Because nothing on any chain used the 1.3.0 forms, this was kept a minor version. 1.5.0 added the AI self's limits for acting and its receipts to part 7, the receipt's leaf in the hourly seal and the `selfReceipt` vector, and left every earlier vector as it was. Sealed vectors carry a fresh nonce, so writing the vectors again keeps the published ones.
