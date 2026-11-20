# The Sigil open standard

Version 1.0.0

This is the format a Sigil vault keeps memories in, how its keys work, what a connector may do and how it asks, what the access log records, and how the log is sealed and proved. Anyone may build a vault, a connector or a checker from it. The reference code is in this repository (`packages/core`), and the test vectors in [`vectors.json`](vectors.json) are generated from that code; `packages/core/test/spec.test.ts` checks on every test run that the code still produces them.

## Parts

| Part | What it covers |
| --- | --- |
| [1. Memories and folders](01-memories.md) | The memory format, folders, protected folders and their meta |
| [2. Keys, envelopes and sealed boxes](02-keys.md) | The key hierarchy, every derivation, the envelope, sealed box, relay and meet formats |
| [3. The connector](03-connector.md) | The MCP tools, their permissions, the HTTP routes an app key may call, protected reads, redaction |
| [4. The access log](04-access-log.md) | The fields of an entry, its kinds, the leaf it is sealed as, and the privacy score |
| [5. Seals and presence](05-seals.md) | The Merkle rules, the hourly seal, the contract, presence statements |
| [6. Certificates](06-certificates.md) | The life certificate and how it is checked |

## Conventions

- **Must** and **must not** are requirements; **should** is a strong recommendation.
- Bytes in text are base64url without padding, unless a field says hex. Hex is lowercase; a 32-byte hash written with `0x` is called hex32.
- Strings are UTF-8. JSON inside an envelope is compact, as `JSON.stringify` writes it.
- Times are ISO 8601 in UTC with milliseconds (`2026-11-20T10:15:00.000Z`).
- Ids are 8 to 64 characters of `A-Z a-z 0-9 _ -`. New ids are 16 random bytes in base64url.
- All primitives are standard: AES-256-GCM, HKDF-SHA256, SHA-256, HMAC-SHA256, X25519, Ed25519 and XChaCha20-Poly1305.

## Test vectors

`vectors.json` has three parts. `input` holds the fixed keys and ids every vector starts from. `deterministic` holds values that follow from their inputs alone: an implementation must produce them byte for byte. `sealed` holds values made with a fresh random nonce, which cannot be made again: an implementation must open each with the key it names and get the plaintext listed. Each vector is named in the part of this standard that defines it, in backquotes, for example `hkdf`.

## Versioning

The version follows semantic versioning. A change that makes data written by an older version unreadable, or makes a vector change, is a new major version, and the vectors are written again (`npm run vectors -w @sigil/core`). Every format string carries its own version (`v1.`, `s1.`, `r1.`, `m1.`, `sigil-read-v1`), so old and new data can be told apart.
