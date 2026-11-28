# 7. The AI self's identity and wallet

An AI self has a key of its own and a wallet it may use only within rules its owner sets. Everything in this part works without a chain; the contracts are used once a site deploys them.

## The self key

The self key is a secp256k1 key derived from the vault key on the owner's device: the secret is HKDF(vault key, `sigil:self:identity:v1`); in the very rare case that is not a valid secp256k1 secret, the info gains `:1`, `:2` and so on until it is. The key is never stored or sent. Its EVM address (Keccak-256 of the uncompressed public key without its first byte, last 20 bytes, EIP-55 case) is the self's identity. The `selfKey` vector shows the address for the vault key of `input`.

A site keeps only the address, once per vault: the same vault always derives the same key.

## The identity statement

```json
{ "format": "sigil-self-identity", "version": 1, "body": { ... }, "vaultSignature": "<base64url>", "selfSignature": "0x<65 bytes>" }
```

The body holds `selfKey` (the address), `signingKey` (the vault's Ed25519 signing key, part 5), `name`, `about`, `owner` and `wallet` (EVM addresses or null), `chain` (`chainId` as a decimal string and `registry`, or null), `origin` and `issuedAt`. The message is the UTF-8 of `sigil-self-identity-v1`, a newline, and the body as canonical JSON (part 6). The vault signs it with Ed25519; the self key signs it as an EIP-191 personal message (r, s with a low s, v of 27 or 28). A checker must confirm both signatures over the same body, each by the key the body names; then each key vouches for the other. The `identityStatement` vector shows a message and both signatures.

A site serves the latest statement of a self key at `GET /api/identity/at/<address>`. That address is what the registry's metadata URI points to.

## The registry

`contracts/src/SigilSelfRegistry.sol` records, per self key: the owner address, the wallet, when it was registered, when it was revoked, and the metadata URI. Registering needs both sides: the owner sends the transaction, and the self key signs the EIP-712 message

```
domain  EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
        name "SigilSelfRegistry", version "1"
type    Register(address owner,address selfKey,string metadataURI,uint256 deadline)
```

so the signature names the owner and cannot be used by anyone else. The owner may change the metadata URI and the wallet. Handing the identity to another owner takes two steps, so both sides agree here too: the owner proposes a new owner (`transferIdentity`, which records `pendingOwner`), and that owner accepts with a call of its own (`acceptIdentity(selfKey, expectedMetadataHash)`, where the hash is keccak256 of the metadata URI it saw, so an accept fails if the URI changed after the offer); the owner may cancel a proposal before it is accepted (`cancelTransfer`). On acceptance the wallet entry is cleared, so the new owner never inherits the old owner's wallet claim. The owner, or the self key itself, may revoke it; a revoked self key can never be registered or accepted again. Signatures with a high s are refused. The `registerDigest` vector shows a digest and the self key's signature over it; the contract's tests check the same digest and register with that signature.

## The wallet

`contracts/src/SigilSelfWallet.sol` has an owner and a self key. The owner can do anything at any time: set rules, freeze and unfreeze, withdraw, call any contract, move the wallet to a new self key. The wallet keeps two lists: recipients, who may be paid, and contracts (tokens included), which may be called. No address is on both. The self key may freeze it, and may make a call only when all of these hold, in this order:

1. the wallet is not frozen, and the rules have not expired (`expiresAt` of zero means no end);
2. the target is not the wallet itself; a call with no data goes to a recipient; a call with data goes to a listed contract;
3. a call with data uses a function selector allowed for that contract;
4. for `transfer(address,uint256)` and `approve(address,uint256)`: the token has caps, the recipient or spender is a recipient (never a contract or token), and the amount is within the token's cap per call and its cap per UTC day; `transferFrom`, `increaseAllowance` and `permit` are always refused, and on a token with caps no other function goes through;
5. native value is within the cap per call and the cap per UTC day.

A listed contract's function arguments are not read: a function that pays out (a router's swap, for example) can send what the self gives it, within the caps, to any address its arguments name. An allowance the owner gives a contract with `ownerExecute` is the owner's own and is not counted against the caps.

The wallet records every allowance the self key gives (at most `MAX_OPEN_APPROVALS`, 16, open at once; an approve of zero takes one off) and lists them in `openApprovals()`. `freeze()` sets each of them back to zero, and so does `revokeApprovals()` without a freeze; each token gets a bounded amount of gas for it, so no token can stop a freeze, and one that refuses stays listed.

The self key sends a call itself, or signs it for anyone to submit:

```
domain  name "SigilSelfWallet", version "2"
type    Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline,uint256 gas)
```

`gas` is the gas the signed call gets; zero means all that is left. With a nonzero amount, a submitter who sends too little for it makes the whole call revert, so a target that catches an inner failure cannot be made to "succeed" with less than the self key agreed to. The nonce goes up with every call by the self key. `configure` replaces every rule at once; what was allowed before no longer counts, and spending per day is not reset by it. Every call by the self key emits `Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes4 selector, address tokenTo, uint256 tokenAmount)`; the vault reads these as the wallet's spends, newest first in spans of 100,000 blocks, back to 00:00 UTC of the current day (the day the caps count) and further on request, with `tokenLimit` and `tokenRemainingToday` for each token. The `executeDigest` vector shows a digest and its signature.

## Wallet rules

The owner drafts the rules in the vault, where they are an encrypted setting named `wallet`:

```json
{ "perTx": "0.05", "perDay": "0.2", "expiresAt": "2027-06-01T00:00:00.000Z",
  "recipients": [{ "address": "0x...", "label": "..." }],
  "contracts":  [{ "address": "0x...", "label": "...", "functions": ["order(uint256)"] }],
  "tokens":     [{ "address": "0x...", "label": "...", "decimals": 6, "perTx": "100", "perDay": "250" }] }
```

Amounts are decimals in whole units. A token's `decimals` is what the token answers to `decimals()` on chain: a vault reads it when the token is added and checks it again before the rules are kept or set on chain, and never fills in a default (a wrong value moves every cap by powers of ten). Addresses are EIP-55; no address appears twice, in one list or across them; a cap per call is never above its cap per day. The fingerprint of a draft is hex32(SHA-256(`sigil-wallet-rules-v1` newline canonical JSON)). The arguments of `configure` follow from the rules: the caps in base units, the expiry in Unix seconds, the recipients, the targets (contracts, then tokens), the selectors of each contract's functions and `transfer` and `approve` for each token, and each token's caps. The `walletRules` vector shows a draft, its fingerprint, these arguments and the encoded call.

## Limits for acting

What the AI self may do on its own is an encrypted setting named `limits`:

```json
{ "v": 1,
  "payments": { "on": true, "maxPerPayment": "0.02" },
  "replies":  { "on": true, "contacts": ["sam lee", "robin lee"] },
  "meetings": { "on": true, "days": [1, 2, 3, 4, 5], "from": "09:00", "to": "17:00", "timeZone": "Europe/Paris" } }
```

Since 1.6 the same setting also holds the thresholds for running mail and invites, the never-touch list and the ranges for negotiating:

```json
{ "mail":     { "on": true, "senders": ["sam lee", "@team.example"], "kinds": ["scheduling", "question", "thanks"], "perDay": 10, "mayStart": false },
  "calendar": { "on": true, "people": ["@team.example"], "maxMinutes": 60, "perDay": 5, "mayDecline": false },
  "neverTouch": ["lawyer", "@bank.example"],
  "ranges": { "on": true, "times": { "on": true, "minNoticeHours": 24, "maxDaysAhead": 21 },
              "prices": [{ "label": "Consulting day", "side": "selling", "min": "800", "max": "1200", "unit": "EUR" }],
              "terms": { "allowed": ["net 30"], "forbidden": ["exclusivity"] }, "maxRounds": 3 } }
```

An action with mail or an invite gets one of three answers. `refused` when the person, the subject or the text names a `neverTouch` entry (an address, an `@domain` against the people's addresses, otherwise a word or phrase). `needs-approval` when the area is off; when the person is not in `senders` or `people` (by address, by name, or by the `@domain` of the address, in lower case); for mail, when a kind the message is about is not in `kinds` (the kinds an app names and the kinds read from the subject and text: `scheduling`, `question`, `thanks`, `money`, `legal`, else `other`), or when the action is a new message and `mayStart` is off; for an invite, when its start or length is unclear, it is in the past, longer than `maxMinutes`, not wholly inside the free hours of `meetings`, or overlaps the calendar; a decline needs `mayDecline`; and in both areas when the steps taken alone today (from midnight in the free hours' time zone, counted by the node across the vault and every app) reached `perDay`. Otherwise `allowed`, with the limit in plain words for the receipt.

A negotiation step answers `accept`, `counter` or `ask`, with the offer and what the self would say next. A price is matched to the range whose `label` the topic names. Selling, it opens at `max`, accepts an offer that meets its last counter (or `max`), counters halfway toward the other offer rounded to the range's own decimals and in the owner's favour, and asks when the offer is at or below `min`, when the counter would reach `min`, or after `maxRounds` counters; buying is the mirror. A time is accepted when it is in the free hours, at least `minNoticeHours` away, at most `maxDaysAhead` ahead, not longer than `calendar.maxMinutes` and clear of the calendar; otherwise the next such time on the half hour from the offered one is the counter, and it asks when there is none. Terms are accepted only when each names an `allowed` entry; a `forbidden` one, or one on neither list, asks. A never-touch entry, or `ranges.on` off, asks before anything.

What waits for the owner is a request sealed to the vault's public key (context `act-request:<id>:<app id or "vault">`): the area, the action, the person, the subject, the thread, what the self would send or do next, the reason, the time and the offer. An app's answer comes back as `{ "v": 1, "id", "verdict": "approved" | "declined", "next", "at" }` under the app's self key (part 2) with AAD `sigil:act-answer:<app id>:<act id>`, so a node can neither read nor forge it. The thresholds reach an app the owner lets act as `{ "v": 1, "limits", "boxPublic", "delegation" }` under the same key with AAD `sigil:app-acting:<app id>`.

A payment by the self key is made on its own only when payments are on, the recipient is one of the wallet rules' recipients, the wallet answers on chain that it would take the call (an `eth_call` of `execute` from the self key), and a payment of the chain's coin is within `maxPerPayment` when it is set. A reply is approved on its own only when replies are on and the sender's address, or the sender's name, is one of `contacts` (compared in lower case). A time agreed with another self is accepted on its own only when meetings are on and the agreed message names exactly one time written as a date and a time (`2026-12-03 14:00`, read in `timeZone` unless it carries `Z` or an offset), on one of `days` (0 is Sunday), from `from` up to but not including `to`. Anything else waits for the owner.

## Receipts

Everything the self does on its own gets a receipt, signed by the self key:

```json
{ "format": "sigil-self-receipt", "version": 1,
  "body": { "selfKey": "0x...", "kind": "payment", "what": "...", "at": "2026-11-26T12:00:00.000Z",
            "limit": "...", "ref": { "chainId": "1", "tx": "0x..." }, "origin": "https://vault.example", "salt": "<64 hex>" },
  "signature": "0x<65 bytes>" }
```

`kind` is `payment`, `approval`, `agreement`, `mail`, `calendar` or `negotiation`. `ref` holds at most ten short strings (a chain and transaction, a draft, a meeting). `salt` is 32 random bytes. The message is the UTF-8 of `sigil-self-receipt-v1`, a newline and the body as canonical JSON (part 6); the self key signs it as an EIP-191 personal message, as it signs the identity statement. The receipt's leaf is SHA-256(0x00 || UTF-8 of `sigil-receipt-v1`, a newline, the message, a newline, the signature in lower case), and it joins the hourly seal of the hour it is kept in, after that hour's read-log entries (part 5). The node keeps the leaf and the receipt as an envelope under the vault key (AAD `sigil:receipt:<id>`), so only the owner can read it. A shared receipt is `{ "receipt": ..., "seal": { "hour", "proof", "root", "periodSeconds" } }`; a checker confirms the signature, that the proof leads from the leaf to the root, that the root is the one published for that hour (and on chain when anchored), and that the hour is the one the receipt names or the next. The `selfReceipt` vector shows a message, its signature and its leaf.

### Receipts an app signs

An app the owner lets act signs its receipts with a key of its own: the secp256k1 key from HKDF(app secret, `sigil:self:receipts:v1`), made the way the self key is (the counter appended from 1 on in the rare case a value is not a valid key). The vault makes the same key from the app's secret and signs, with the self key, its word for it:

```json
{ "selfKey": "0x...", "delegate": "0x...", "app": "<app id>", "origin": "https://vault.example", "since": "2026-11-27T09:00:00.000Z", "signature": "0x<65 bytes>" }
```

The signature is EIP-191 by the self key over the UTF-8 of `sigil-self-receipt-delegate-v1`, a newline and the canonical JSON of the other five fields. A receipt the app signs carries it as `via` in its body, names the self key as `selfKey`, and is signed by `delegate`. A checker confirms that the delegation is the self key's, that the receipt's signature is the delegate's, and that `since` is not after `at`. The app keeps such a receipt on the node as a sealed box to the vault's public key (context `self-receipt:<id>:<app id>`); its leaf is formed and sealed exactly as above. The self key itself never leaves the owner's device. The `delegatedReceipt` vector shows a delegation, a receipt signed under it and its leaf.
