# 2. Keys, envelopes and sealed boxes

## Derivation

Every derived key is HKDF-SHA256 with the fixed salt `sigil/hkdf/v1` (UTF-8), the given info string, and 32 bytes of output unless said otherwise. The `hkdf` vector lists the outputs for six info strings from the app secret of `input`.

## The key hierarchy

| Key | Made | Wrapped by |
| --- | --- | --- |
| Vault key, 32 random bytes | On the owner's device at sign-up | Each sign-in method in a key slot (below) |
| Folder key, 32 random bytes | On the owner's device | The vault key, and for each app granted the folder, the app's wrap key |
| Vault box key, X25519 | On the owner's device at sign-up | The private half: the vault key, AAD `sigil:box-secret`. The public half is in the clear |
| App secret, 32 random bytes | On the owner's device; shown to the owner once as the app key | The vault key, AAD `sigil:app-secret:<app id>` |
| Signing key, Ed25519 | Derived: seed = HKDF(vault key, `sigil:sign:presence:v1`) | Never stored |

### Key slots

A key slot is the vault key in an envelope under a key-encryption key (KEK), AAD `sigil:keyslot:<kind>`.

- **Passkey**: the WebAuthn PRF extension evaluated with the salt SHA-256(`sigil/passkey-prf/v1`); KEK = HKDF(PRF output, `sigil:kek:passkey`).
- **Wallet**: the wallet signs a fixed message (the lines `Sigil vault key`, a blank line, three lines of explanation, a blank line, `Wallet: <lowercase address>`, `Version: 1`). KEK = HKDF(signature, `sigil:kek:wallet:<address>`); the sign-in token = base64url(HKDF(signature, `sigil:auth:wallet:<address>`)). The `wallet` vector shows both.
- **Recovery phrase**: 24 BIP-39 words (256 bits of entropy). KEK = HKDF(entropy, `sigil:kek:phrase`); token = base64url(HKDF(entropy, `sigil:auth:phrase`)); lookup id = hex(HKDF(entropy, `sigil:lookup:phrase`, 16 bytes)). The `phrase` vector shows them.

A server keeps only SHA-256 of any token, in hex.

### App keys

An app key is the text `sigil_app.<app id>.<base64url secret>`. From the secret:

| Key | Derivation |
| --- | --- |
| Bearer token | base64url(HKDF(secret, `sigil:auth:app`)); the server keeps SHA-256 of it |
| Wrap key | HKDF(secret, `sigil:wrap:app`): unwraps the folder keys granted to the app, AAD `sigil:app-folder-key:<app id>:<folder id>` |
| Self key | HKDF(secret, `sigil:wrap:self`): opens the AI self's rules and model key, ask links and the public self given to the app |
| Sync key | HKDF(secret, `sigil:wrap:sync`): opens live sync sources the owner lets the app sync in the background |
| Tag key | HKDF(secret, `sigil:tag:app-box`): checks the vault public key (below) |

The `appKey` vector shows all of them for the secret of `input`.

## Envelopes

An envelope is AES-256-GCM with a fresh 96-bit IV and a 128-bit tag, the AAD naming the exact record:

```
v1.<base64url IV>.<base64url ciphertext and tag>
```

An envelope moved to another record fails to open. The AAD strings in use, with `<...>` filled in:

| Record | AAD |
| --- | --- |
| Key slot | `sigil:keyslot:<passkey|wallet|phrase|device>` |
| Folder key, folder meta | `sigil:folder-key:<id>`, `sigil:folder-meta:<id>` |
| Memory head, body | `sigil:memory-head:<id>`, `sigil:memory-body:<id>` |
| Granted folder key | `sigil:app-folder-key:<app id>:<folder id>` |
| App name, app secret | `sigil:app-meta:<id>`, `sigil:app-secret:<id>` |
| A vault setting | `sigil:setting:<self|model|thinking>` |
| A live sync source | `sigil:sync:<source id>` under the vault key; `sigil:sync-app:<app id>:<source id>` under an app's sync key |
| The public AI self | `sigil:public-self:<id>` under the vault key; `sigil:public-self-app:<app id>:<id>` under an app's self key |
| One side's record of a meet | `sigil:meet:<meet id>` under the vault key |

The `aad` vector lists several of these for the ids of `input`, and the `envelope` vector is a folder key wrapped under the vault key of `input`.

## Sealed boxes

Data for a vault that is not open is sealed to its public key R:

```
ephemeral pair (e, E)
shared = X25519(e, R)
key    = HKDF-SHA256(ikm = shared, salt = E || R, info = "sigil:box:v1:" + context)
sealed = XChaCha20-Poly1305(key, 24 random bytes, plaintext, aad = context)
format   s1.<E>.<nonce>.<ciphertext and tag>
```

This HKDF uses its own salt (E || R), not the fixed one. The context names the record (`proposal:<id>:<app id>`, `share:<id>:<folder id>`, `meet-invite:<meet id>`, `meet-answer:<meet id>`, `ask-note:<entry ref>:<by>`), so a box moved elsewhere fails to open. Low-order points must be refused. The `sealedBox` vector is a suggestion sealed to the box key of `input`.

### Vault codes

A vault code is `sigil_vault.<public key>.<check>`, the check being the first 4 bytes of SHA-256(`sigil-vault-code:<public key>`) in base64url. Its fingerprint, for two people to read to each other, is the first 20 hex characters of SHA-256(`sigil-vault-fingerprint:<public key>`), uppercase, in groups of four. The `vaultCode` vector shows both.

### Vouching for the public key to an app

The vault tags its public key for an app with HMAC-SHA256(tag key, `sigil-box-v1:<public key>`), in hex. An app must check the tag before it seals anything to a key a server handed it.

## Ask links and the public AI self

A link's X25519 key pair is made on the owner's device; its public half travels in the link after `#`. For the public AI self at `/@handle`, the public half is published by the server instead. The asker makes a fresh key pair A per conversation, and both sides derive

```
key = HKDF-SHA256(ikm = X25519(a, L) = X25519(l, A), salt = A || L, info = "sigil:ask:v1:" + link id + ":" + session id)
```

Every question and answer is XChaCha20-Poly1305 under that key with a fresh 24-byte nonce and the AAD `sigil:ask-msg:v1:<link id>:<session id>:<message id>:<q|a>`, written `r1.<nonce>.<ciphertext>`. The `askKey` vector shows the key for the link secret of `input`. An answer of the public AI self is `{ v: 1, text, refused, sources: [{ id, title }] }`, the sources being items of the public copy.

## Selves meet selves

Two vaults whose owners both said yes derive one key from their static box keys:

```
key = HKDF-SHA256(ikm = X25519(my secret, their public), salt = the two public keys in byte order, info = "sigil:meet:v1:" + meet id)
```

Only those two vaults can make it, so a message that opens was written by one of them. Each turn is `{ v: 1, text, done }` under XChaCha20-Poly1305 with a fresh nonce and the AAD `sigil:meet-msg:v1:<meet id>:<turn>:<sender public key>`, written `m1.<nonce>.<ciphertext>`. The inviter writes the odd turns, the invitee the even ones. The invite (`{ v, purpose, note, from, turnLimit }`) is a sealed box to the invitee and the answer (`{ v, from }`) a sealed box to the inviter. Purposes are `find_time`, `collab_fit` and `swap_intros`. The `meetKey` vector shows the key for the two box secrets of `input`; the `meetMessage` vector is one turn.

## Live sync sign-in

Live sync signs in with OAuth 2.0, the authorization code flow with PKCE, from the owner's device as a public client. The verifier is 32 random bytes in base64url; the challenge is base64url(SHA-256(verifier)) with the method S256. No client secret is sent from a browser or kept on a server. The `pkce` vector shows a challenge. A source's state (service, folder, tokens, cursor, a revision number) is one JSON document in an envelope under the vault key, and for a connector the owner lets sync in the background, a second envelope under that app's sync key. The copy with the higher revision wins.
