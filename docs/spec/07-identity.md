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

so the signature names the owner and cannot be used by anyone else. The owner may change the metadata URI and the wallet and hand the identity to another owner. The owner, or the self key itself, may revoke it; a revoked self key can never be registered again. Signatures with a high s are refused. The `registerDigest` vector shows a digest and the self key's signature over it; the contract's tests check the same digest and register with that signature.

## The wallet

`contracts/src/SigilSelfWallet.sol` has an owner and a self key. The owner can do anything at any time: set rules, freeze and unfreeze, withdraw, call any contract, move the wallet to a new self key. The self key may freeze it, and may make a call only when all of these hold, in this order:

1. the wallet is not frozen, and the rules have not expired (`expiresAt` of zero means no end);
2. the target is on the allowed list and is not the wallet itself;
3. a call with data uses a function selector allowed for that target;
4. for `transfer(address,uint256)` and `approve(address,uint256)`: the token has caps, the recipient or spender is on the allowed list, and the amount is within the token's cap per call and its cap per UTC day; `transferFrom`, `increaseAllowance` and `permit` are always refused;
5. native value is within the cap per call and the cap per UTC day.

The self key sends a call itself, or signs it for anyone to submit:

```
domain  name "SigilSelfWallet", version "1"
type    Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)
```

The nonce goes up with every call by the self key. `configure` replaces every rule at once; what was allowed before no longer counts, and spending per day is not reset by it. Every call by the self key emits `Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes4 selector, address tokenTo, uint256 tokenAmount)`; the vault reads these as the wallet's spends. The `executeDigest` vector shows a digest and its signature.

## Wallet rules

The owner drafts the rules in the vault, where they are an encrypted setting named `wallet`:

```json
{ "perTx": "0.05", "perDay": "0.2", "expiresAt": "2027-06-01T00:00:00.000Z",
  "recipients": [{ "address": "0x...", "label": "..." }],
  "contracts":  [{ "address": "0x...", "label": "...", "functions": ["order(uint256)"] }],
  "tokens":     [{ "address": "0x...", "label": "...", "decimals": 6, "perTx": "100", "perDay": "250" }] }
```

Amounts are decimals in whole units. Addresses are EIP-55; no address appears twice; a cap per call is never above its cap per day. The fingerprint of a draft is hex32(SHA-256(`sigil-wallet-rules-v1` newline canonical JSON)). The arguments of `configure` follow from the rules: the caps in base units, the expiry in Unix seconds, the targets (recipients, then contracts, then tokens), the selectors of each contract's functions and `transfer` and `approve` for each token, and each token's caps. The `walletRules` vector shows a draft, its fingerprint, these arguments and the encoded call.
