# 5. Seals and presence

## Merkle trees

```
leaf = SHA-256(0x00 || data)
node = SHA-256(0x01 || min(a, b) || max(a, b))
```

Pairs are sorted (as unsigned big-endian numbers) before hashing, so a proof is the list of siblings and needs no left or right flags. An odd node at the end of a level moves up as it is. The root of no leaves is 32 zero bytes. The `merkle` vector shows five leaves, their root and the proof of the fourth.

## The hourly seal

Time is cut into periods of 3600 seconds; period n runs from n times 3600 seconds after the Unix epoch. When a period ends, every log entry of that period, of every vault on the site, becomes a leaf, ordered by entry time and then entry id, and the root is the seal of that period. A site publishes every seal (`GET /api/seals`, `GET /api/seals/<period>`) and the proof of any leaf (`GET /api/seals/<period>/proof?leaf=<hex32>`), and keeps the leaves of past seals after an account is deleted, so old proofs keep working. A leaf says nothing without its entry and salt.

When anchoring is on, each root is also written to the SigilSeal contract (`contracts/src/SigilSeal.sol`), which computes trees by the same rules; a shared test vector in its tests proves it.

## Presence

While a vault is open, the owner's device signs one statement per period with the vault's Ed25519 signing key:

```
sigil-presence-v1
<origin>
<period seconds>
<period>
```

The site checks the signature and writes a log entry of kind `presence` with `appId` `vault` and the base64url signature as `memoryId`; it is sealed with its period like any entry. The `presence` vector shows the signing key derived from the vault key of `input`, a message and its signature (Ed25519 signatures are deterministic).
