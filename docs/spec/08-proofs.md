# 8. Proofs of a fact

A vault can prove one claim without showing anything else. Version 1 is selective disclosure: a statement signed by the vault's Ed25519 signing key (part 5), with its evidence, and the statement's hash sealed in the hour it was made. It is not a zero-knowledge proof: where a claim is the owner's own statement, it says so.

## Fields of a memory

The fields of a memory are its title (`Title`), every body line of the form `Name: value` (a name of up to 40 characters starting with a letter, a value of up to 500, the first line of each name only), and the day it was written (`Written`). Each field is committed with its own 32 random bytes of salt:

```
leaf       = SHA-256(0x00 || "sigil-field-v1" \n name \n value \n salt hex)
commitment = Merkle root of the leaves in field order (part 5)
```

Without the salts the commitment says nothing about the fields. The `fieldCommitment` vector shows three fields, their salts, leaves, root and the proof of the third.

## Claims

| Kind | What it holds | Who stands behind it |
| --- | --- | --- |
| `field` | One field revealed with its salt, its index and its proof to the `commitment` | The owner's vault: the value is what the owner's memory says |
| `before` | A date field's name, a day, optionally a number of years, and the `commitment`. The date itself stays hidden | The owner's vault alone. The device refuses to sign a claim the field does not support; nobody else computes the comparison |
| `history` | The first and a latest sealed presence hour (part 6), each with its entry, proof and root, and a number of months | The site's seals: a checker confirms both presence signatures, both proofs and the roots, and that the hours lie at least that many 30-day months apart |
| `member` | A space id, the owner's own label for it, and the sealed `space` entry with memoryId `joined-<space id>` (part 4) with its proof | The site's seals for the time of joining; the label is the owner's |

## The statement and its seal

```json
{ "format": "sigil-disclosure", "version": 1,
  "statement": { "origin": "...", "periodSeconds": 3600, "signingKey": "...", "issuedAt": "...", "claim": { "kind": "...", ... } },
  "signature": "<base64url>",
  "anchor": { "id", "appId": "vault", "kind": "disclose", "memoryId": "<statement hash>", "count": 1, "at", "salt", "hour", "index", "proof", "root" } }
```

The signature is Ed25519 over `sigil-disclosure-v1`, a newline and the statement as canonical JSON. The statement hash is hex32 of SHA-256 over the same bytes. When the owner makes a proof, the device sends only that hash; the site writes it into the log as a `disclose` entry. Once its hour is sealed, the proof is completed with that entry and its proof. The `disclosure` vector shows a canonical statement, its hash and signature.

A checker must confirm, on its own:

1. the statement is signed by the key it names;
2. the claim's evidence holds, as in the table above;
3. the anchor is a `disclose` entry by `vault` with count 1, whose memoryId is the statement's hash, made no earlier than the statement, in the hour it names, and its proof leads to the listed root;
4. every root (of the anchor and of the evidence) is one the site publishes, and the one on chain when the seals are anchored.

## Limits

A proof says nothing about who holds the vault. A `field` or `before` claim is only as true as what the owner wrote in their own vault: Sigil does not check a passport. Zero-knowledge proofs, in which a checker computes an age from a hidden date that someone else attested, are not part of this version.
