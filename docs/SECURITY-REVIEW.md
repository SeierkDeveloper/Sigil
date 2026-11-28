# Security review, round eight

This is the review made before Sigil is opened to people: what was looked at, how, every finding with its severity, what was done about it and the test that shows it, what was left out, and what still needs someone from outside. It was made by the project itself. It is not an audit, and it does not replace one.

## Scope

- **Cryptography** in `packages/core`: envelopes and folder keys, sealed boxes, key derivation, the passkey PRF, wallet and phrase key slots, Shamir splitting for legacy plans, device pairing, capture keys, ask links and the public AI self, meets, vault bundles, proofs of a fact, agreements, knowledge packs, the emergency card, sessions, the Merkle seals.
- **The server** in `web/src/server`: every route of the API (sign-in, session, ownership of every row, protected folders, rate limits, size limits), the bundle restore, moving between nodes, the seal job, the model file route, the database schema and its migrations.
- **The connector** (`connector/`), **the browser extension** (`extension/`) and **the contracts** (`contracts/src`).
- **The web layer**: content security policy and headers, cross-site requests, XSS, SSRF, path traversal, SQL injection, replay, timing.
- **Dependencies**: `npm audit`, and the versions in use.
- Added during the round at the owner's request: **prompt injection** through memories, which led to the memory immune system (finding F-30).

## Method

1. Read every server module and route by hand, with the questions: who may call this, whose rows can it touch, what is the largest input it accepts, can a one-time thing be used twice, does a GET change anything.
2. Three independent read-throughs of the crypto, the server's permission checks, and the contracts, connector and extension, each looking for exploitable problems, each claim then checked against the code before it was accepted here.
3. Fuzz and property tests for every parser of outside input (`packages/core/test/fuzz.test.ts`, seeded, replayable with `SIGIL_FUZZ_SEED`): exports and imports, mail, calendars, notes, transcripts, keys and links, every signed document, sealed boxes, settings cleaners. They require that each parser returns or throws a plain error, never crashes, stays linear on input built to make it backtrack, and never accepts a changed signed document.
4. An API fuzz test (`web/test/fuzz.test.ts`): every route, called signed in, with an app key and anonymously, with bodies of every odd shape. No answer may be a server error, and every refusal carries a message.
5. Foundry fuzz and invariant tests for the contracts (`contracts/test`), including an invariant run that drives the self wallet with random payments, signed calls, waiting and tighter rules.
6. Every fix comes with a test that fails without it.

## Findings

Severity: **high** means content or control of a vault could be lost to someone without the owner's keys; **medium** means a real attack with limits, or a weakness a malicious server or storage could use; **low** means hardening, denial of service, or a wrong result in a corner.

### High

**F-01. A restored bundle could hang rows off another vault.** `POST /api/restore` needs no account; the attacker makes a vault elsewhere, signs its own bundle, and adds rows that point at a victim's shared memory, public page, pack or legacy plan (or name a victim's account id). Those rows went in as they were: for example a membership that made the attacker an accepted admin of the victim's shared memory. *Fix:* a restored row may only point at rows the same restore put in, and every account column must be the restored vault's own (`web/src/server/bundles.ts`). *Test:* `web/test/security.test.ts`, "restoring a bundle".

**F-02. Anyone who knew an ask link's id could have the owner's AI self answer them, the server included.** The conversation key came from the link's public key, which the server keeps; the greeting key in the link's fragment only opened the greeting. A server (or anyone who saw the link's path in a log) could start its own session, and the owner's open vault or connector answered from the link's folders. *Fix:* ask links now mix the fragment's greeting key into the conversation key (v2, open standard 1.3.0, vector `askKeyV2`); the public AI self and sessions, open to anyone by design, keep v1. *Tests:* `packages/core/test/relay.test.ts`, `web/test/self.test.ts` "answers no one who lacks the whole link".

### Medium

**F-03. A bundle could be changed on its way, and still be restored.** Whether a signature was needed was decided by a field inside the bundle; relabelled as "made by a connector", a signed bundle passed without a signature, and restoring only checked that memories decrypt. A storage host could leave memories out or slip in an app or capture key with a known token. *Fix:* a connector's bundle carries an HMAC from its app's own secret; restoring checks the vault's signature or that HMAC over the whole body, with the app's secret opened under the vault key (`packages/core/src/bundle.ts`, `connector/src/backup.ts`). *Test:* `packages/core/test/bundle.test.ts`.

**F-04. One trusted person could mark a legacy plan released.** Marking it opened needed only one trustee holding a share after the owner's inactive period; that released heirs' keys to shared memory. *Fix:* the plan carries the hash of a release proof only the combined legacy key gives; opening needs the proof. *Tests:* `web/test/legacy.test.ts` "is never marked released by one trusted person alone", `packages/core/test/legacy.test.ts`.

**F-05. Removing a sign-in method did not end its sessions.** Passkey, wallet and phrase sign-ins made sessions not tied to their key slot, so removing a wallet or replacing a leaked recovery phrase left the other browser signed in for up to 30 days. *Fix:* every session belongs to the key slot that opened it and ends with it; replacing the phrase ends its sessions. *Test:* `web/test/security.test.ts` "sessions".

**F-06. The node could be made to fetch from its own network.** The check on addresses a node fetches (moves, restore from a public address) read the host name as text: IPv4-mapped IPv6, NAT64, carrier-grade NAT, `0.0.0.0` and any name resolving to a private address got through, and a response body was read without a size limit. *Fix:* `web/src/server/netguard.ts` checks every address a name resolves to when the connection is made (so a name that changes its answer is caught too), refuses private and special ranges in every form, and reads bodies only up to the limit. *Test:* `web/test/security.test.ts` "addresses this node fetches".

**F-07. Proofs whose roots were never compared counted as checked.** A proof of a fact, a certificate or an agreement carries the roots it claims; without published or on-chain roots to compare them with, a made-up root passed. The server published such proofs. *Fix:* the verifiers add a failing "roots" check when nothing was compared, and the server compares a proof with its own seals before publishing it. *Test:* `packages/core/test/disclose.test.ts`.

**F-08. Patterns that backtrack on outside text.** Turning mail HTML into text, reading calendar lines and mail headers, redacting email addresses, Slack links and transcript speakers used patterns that took seconds to minutes on a long run of `<`, quotes or letters; one email could stall every sync pass. *Fix:* linear scanners and bounded patterns. *Test:* `packages/core/test/fuzz.test.ts` "stay linear".

**F-09. A capped token could be moved around its caps.** The self wallet counted only `transfer` and `approve`; another function of the same token the owner allowed by mistake (`transferAndCall`, `send`, `safeTransferFrom`) moved it uncounted. *Fix:* on a token with caps, only those two calls go through. The NatSpec says plainly that allowances the owner gives to allowed contracts are the owner's decision and not counted. *Test:* `contracts/test/SigilSelfWallet.t.sol` "testOtherFunctionsOfACappedTokenAreRefusedEvenWhenAllowed".

**F-10. Rate limits counted an address the caller wrote.** The first address in `X-Forwarded-For` is whatever the caller sends; a new one per request got around every limit. *Fix:* the address the nearest trusted proxy saw (`SIGIL_PROXY_HOPS`, 1 by default). *Test:* `web/test/security.test.ts` "rate limits".

**F-11. Request bodies were read whole before their size was checked.** A body sent without a length was held in memory in full first; the restore route accepts up to 512 MB without an account. *Fix:* bodies are read as a stream and dropped as soon as they pass the limit; invalid UTF-8 is refused. *Test:* `web/test/security.test.ts` "request bodies".

### Low

**F-12. Another site could trigger reads with the owner's cookie.** Some cookie GETs set state (the AI self counts as online); a top-level link from another site carries the cookie. *Fix:* requests with the session cookie that a browser marks `Sec-Fetch-Site: cross-site` are refused. *Test:* `web/test/security.test.ts`.

**F-13. Signing out had no origin check.** *Fix:* it needs the site's own origin like every other change. *Test:* `web/test/api.test.ts`.

**F-14. An agent could mark another vault's handoff notes as picked.** *Fix:* only notes the agent may see. *Test:* `web/test/security.test.ts` "agents".

**F-15. An agent could be added as an admin of a shared memory.** *Fix:* agents read or write, never administer. *Test:* same.

**F-16. Stopping background sync left the connector's write right.** *Fix:* it goes back to read unless another source still syncs into the folder. *Test:* `web/test/security.test.ts` "background sync".

**F-17. A connector's backup carried protected folders without a record.** *Fix:* the protected memories it carries are a protected read in the log. *Test:* `web/test/security.test.ts` "a connector's backup".

**F-18. Deleting a vault erased the other side's signed agreements.** *Fix:* the row stays with the other party (the schema is migrated). *Tests:* `web/test/security.test.ts` "agreements", `web/test/models.test.ts`.

**F-19. Small files could unpack to gigabytes.** Bundles and zip imports were inflated without a ceiling. *Fix:* a ceiling checked before and while inflating. *Tests:* `packages/core/test/bundle.test.ts`, `packages/core/test/fuzz.test.ts`.

**F-20. One damaged conversation stopped a whole import, and ids named like built-in properties were followed.** *Fix:* each item is read defensively and skipped when damaged. *Test:* `packages/core/test/fuzz.test.ts` "importers".

**F-21. Storage addresses could be plain http.** S3 signatures and pinning tokens could travel in the clear. *Fix:* https only, except this machine. *Test:* `packages/core/test/fuzz.test.ts`.

**F-22. The connector's own transport.** It accepted an http server address for any host, served its HTTP mode on any interface, compared its secret path in variable time and printed a token the owner set. *Fix:* https only (http only to this machine), loopback unless `--allow-network`, a constant-time compare, the owner's token never printed. *Test:* `connector/test/net.test.ts`.

**F-23. A server's error text reached the AI model.** A malicious server could put instructions in an error message. *Fix:* the connector tells the model a fixed sentence per refusal code, never the server's words. *Test:* `connector/test/server.test.ts`.

**F-24. The extension.** Content scripts (which run inside chatgpt.com and claude.ai) could read the app key from storage, and could ask the worker to capture any tab. *Fix:* the storage is limited to the extension's own pages and worker (`setAccessLevel`, Chrome 102 and later), and only the popup may ask to read a tab. *Test:* `extension/test/messages.test.ts` (the storage level has no unit test: check it in Chrome, see GO-LIVE-CHECKS).

**F-25. The owner could not cancel a call the self key signed.** A signed call stays checked against the rules in force when it is sent, but the owner had no way to cancel one not yet sent. *Fix:* `cancelSignedCalls`, and unfreezing cancels them. *Tests:* `contracts/test/SigilSelfWallet.t.sol`, plus fuzz tests that a signature works once, not in its malleable form and not on another chain.

**F-26. `SigilSeal.verify` takes an already hashed leaf.** A caller that passes an inner node gets true. *Fix:* `verifyData` hashes the entry itself; the NatSpec of `verify` says what it expects. *Test:* `contracts/test/SigilSeal.t.sol` "testFuzzVerifyDataTakesEveryEntryAndNoInnerNode".

**F-27. A pack's envelope and id were not part of its check.** *Fix:* the format and version are checked, and a follower checks it is the pack it followed. *Test:* `packages/core/test/fuzz.test.ts`.

**F-28. Deep nesting in a signed document overflowed the stack.** *Fix:* a depth limit with a plain message. *Test:* same.

**F-29. Reading the presence proofs had no rate limit.** It rebuilds proofs over many hours. *Fix:* limited per vault.

**F-30. Prompt injection through memories (added this round).** Mail, chats and imports can carry text written for an AI. Sigil's prompts already told the model not to follow instructions in memories, which is not enough on its own. *Fix:* the memory immune system (open standard part 13): memories from outside are checked on the device and held for the owner's review; every memory any model sees is quoted between delimiters with a random code and flagged places replaced; catches go on the sealed record; an hourly public test runs a set of injection strains against the AI self's own pipeline and publishes its sealed record at `/immune`. *Tests:* `packages/core/test/immune.test.ts` (every rule, ordinary mail and notes left alone, the wrapper), `packages/core/test/immunerun.test.ts`, `web/test/immune.test.ts`, `e2e/tests/immune.spec.ts`. What it does not do: the rules catch common shapes; against the test model that follows every instruction it can read, the strains `override-note` and `polite-ps` (polite, indirect wording) get through in some hours. The record says so.

### Dependencies

`npm audit` reports no known vulnerabilities. Nothing was updated for security reasons. Shamir splitting uses `shamir-secret-sharing` 0.0.4, which its authors publish as audited; its pre-1.0 version is noted for the outside audit.

## HeyResearch security review of the contracts (November 2026)

HEY Research Lab (HeyResearch) reviewed `SigilSelfWallet`, `SigilSelfRegistry` and `SigilSeal` at commit `7ee22a6`, together with the vault code that builds their arguments (`packages/core/src/identity.ts`, `web/src/vault/identityOps.ts`, `web/src/vault/tabs/Identity.tsx`), and proved each finding on a local fork of Robinhood Chain. None of the contracts was deployed, so nothing was at stake. They found nothing high, one medium, two low and five notes. All are fixed. Their proofs are in `contracts/test/SigilReview.t.sol`, changed so that each now shows the fix; they run on local stand-ins by default and against the real USDG and Uniswap UniversalRouter when `SIGIL_REVIEW_FORK_RPC` is set to a Robinhood Chain RPC. The full review is public as advisory [GHSA-fqh9-xcrq-cgpg](https://github.com/SeierkDeveloper/Sigil/security/advisories/GHSA-fqh9-xcrq-cgpg). Every fix below landed in `e003ca3`, before the contracts went live on 26 Nov 2026.

**HR-M1 (medium). A token's decimals were typed by hand, with 18 as the default.** For USDG (6 decimals), a cap of "50" became 50e18 base units on chain, in effect no cap, and "Try a payment" used the same wrong decimals, so it still said 60 was refused. *Fix:* the vault reads `decimals()` from the token over the site's read address when a token is added; the field cannot be typed; a token that does not answer is refused, never guessed; `cleanWalletRules` has no default any more; the decimals are checked against the token again before the rules are saved and right before `configure` is sent; each token row shows its caps in base units; "Try a payment" can try a token with the same decimals; after `configure` the vault reads `tokenLimit` and `tokenRemainingToday` back and shows them in token units. Without a read address for the chain, tokens cannot be added. *Tests:* `packages/core/test/identity.test.ts` "never guess a token's decimals", `web/test/identity.test.ts` "read a token's decimals from the token", `contracts/test/SigilReview.t.sol` `test_M1_capsInTheTokensOwnDecimalsHold`.

**HR-L1 (low). Every listed contract and token was a recipient on chain.** Recipients, contracts and tokens went into one `targets` list, so the self key could pay a listed router, and anyone could sweep the router's balance; a token could be paid to its own contract. *Fix:* the wallet keeps recipients as a list of their own (`configure` takes `recipients` apart from `targets`, plus `setRecipient` and `isRecipient`); no address may be on both lists; a call with no data goes only to a recipient; token transfers and approvals name a recipient only. The vault sends its Recipients as that list and its Contracts and Tokens as targets, and its own checker follows the same rules. *On approvals:* a spender must be a recipient, never a listed contract. An approval lets the spender move tokens later, so it is treated like a payment. To let the self trade through a router, the owner gives the router an allowance with `ownerExecute`; spending through it is the owner's decision and is not counted against the caps, as the contract says. The vault also says, next to Contracts, that a listed function can send what it is given to any address its arguments name, as routers do, and that a self that should only pay listed people should list no router. *Tests:* `test_L1a_aListedRouterOrTokenIsNeverAPayee`, `test_L1_noAddressIsBothRecipientAndContract`, `test_L1b_aListedFunctionStaysWithinTheCap`, `testFuzz_tokensOnlyEverReachRecipients`, and "keep recipients and contracts apart" in `packages/core/test/identity.test.ts`.

**HR-L2 (low). `transferIdentity` named a new owner who never agreed.** *Fix:* the move is two steps. The owner proposes (`transferIdentity` records `pendingOwner`), the new owner accepts with its own call (`acceptIdentity`), and the owner can cancel first (`cancelTransfer`). On acceptance the wallet entry is cleared and `registeredBy` counts the new owner; a revoke clears a proposal. *Tests:* `test_L2_theNewOwnerMustAccept`, and in `contracts/test/SigilSelfRegistry.t.sol` the two-step, cancel, revoke and fuzz tests.

**HR-I1. Allowances outlived a freeze, an expiry and new rules.** *Fix:* the wallet records every allowance the self key gives (at most 16 open at once) and lists them in `openApprovals()`. `freeze()`, by the owner or the self key, sets each back to zero, and `revokeApprovals()` does the same without a freeze. Each token gets a bounded amount of gas and no more than one word of its answer is read, so a token that reverts, burns gas or returns a huge answer cannot stop a freeze; one that refuses stays listed. The vault shows the open allowances with what each spender may still take, and a button to set them all to zero. What stays true: an allowance survives an expiry or a new `configure` until the wallet is frozen or `revokeApprovals` is called, because neither can act by itself; allowances the owner gives with `ownerExecute` are not recorded. *Tests:* `test_info_freezeRevokesTheSelfsAllowances`, `test_info_revokeApprovalsWithoutAFreeze`, `test_openApprovalsAreKeptAndBounded`, `test_aBadTokenNeverStopsAFreeze`.

**HR-I2. A call with no data skipped the function list.** *Fix:* closed by HR-L1: a call with no data goes only to a recipient, so no listed contract's `receive` or `fallback` runs on an empty call. *Test:* `test_info_anEmptyCallNeverReachesAContract`.

**HR-I3. The vault's spend list covered about two hours.** It read the last 50,000 blocks. *Fix:* the vault reads the wallet's logs newest first in spans of 100,000 blocks (what the public Robinhood Chain node answers reliably; a span the node refuses as too big is halved), back to 00:00 UTC of the current day, the day the caps count, and further back on request. It reads `tokenRemainingToday` for every token. *Test:* `web/test/identity.test.ts` "read the wallet, its token caps, open allowances and today's spends".

**HR-I4. The submitter of a signed call picked its gas.** *Fix:* a signed call names the gas its inner call gets (`Execute` gained `gas`; the wallet's EIP-712 domain is version 2, and `packages/core` computes the same digest). With a nonzero amount, the wallet refuses to start the call unless the call is certain to get it, so a target that catches an inner failure cannot be made to "succeed" with less; the whole call reverts and the nonce is not spent. Zero keeps the old behaviour for calls that need no minimum. *Tests:* `test_info_aSubmitterCannotStarveASignedCall`, the `executeDigest` vector in `docs/spec/vectors.json` and `testVectorFromTypeScript`.

**HR-I5. A seal's `leaves` is only what the sealer says.** *Fix:* documented in the contract. The verify page and the proofs never use it; only a proof against the root counts.

These changes moved the open standard to 1.4.0: part 7's wallet formats changed before anything was deployed, and two vectors were written again.

## Known and not fixed in this round

- **Meet invites are not tied to the inviter's vault.** The invite is an anonymous sealed box, and the invitee takes the inviter's key from the server; a malicious node could pose as anyone. The inviter's side is safe. Compare the other vault's code out of band before accepting until the invite carries a fingerprint to compare.
- **Device pairing by short code.** The code is 50 bits for ten minutes; the QR code compares the whole key and is the recommended path.
- **Passed legacy shares are not authenticated between trustees.** A malicious node can pass a false share; the key check refuses the wrong key, so the effect is that a release fails, not that it opens.
- **Envelopes have no version.** A malicious server can serve an older copy of a setting, a link's box or a backup target. Revocations are enforced by the server, not by the envelopes.
- **The wallet's daily cap is per UTC calendar day**, not a rolling 24 hours: up to twice the cap can go out around midnight UTC. Documented in the contract.
- **A compromised sealer key can seal an hour that was never sealed.** Each seal records when it was written, so a late seal is visible; the owner can replace the sealer.
- **The registry's wallet entry is a claim.** Handing a self to a new owner in the registry takes two steps since the HeyResearch review; ownership of the wallet and of the seal contract still moves in one step, by the current owner.
- **The wallet unlock message has no domain in it**, so a site that phishes the same signature gets the key slot; changing the message would lock out existing wallet vaults.
- **The connector checks memories at the normal level**: it cannot read the owner's per-source settings.
- **Model files are not pinned by hash**; they run in the browser's WebAssembly sandbox.

## Out of scope

Calls to the real providers (Google, Slack, the model providers, storage services, chains): they are listed in docs/GO-LIVE-CHECKS.md with the checks to run. The hosting platform, the owner's devices and browsers, and denial of service beyond the per-address limits.

## What still needs an outside audit

1. The cryptographic protocols as a whole: the key hierarchy, the v2 ask link key, the bundle signature and HMAC, the legacy release proof, sealed boxes and their contexts.
2. The three contracts, before any deploy holds value.
3. The server's authorization model, especially restore and moving between nodes.
4. The immune system's rules, by someone whose job is to get around them.
