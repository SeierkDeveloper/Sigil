# 6. Certificates

A life certificate shows that a vault has a long, continuous sealed history, without a word of what is in it:

```json
{ "format": "sigil-life-certificate", "version": 1, "body": { ... }, "signature": "<base64url>" }
```

The body holds `origin`, `periodSeconds`, `signingKey`, `issuedAt`, a `summary` and `hours`. Each hour lists its period, the presence entry (`id`, `at`, `salt`, `sig`), the leaf's index in its seal, the proof and the root. The summary holds the first and last period, `from` and `to`, the number of active periods and days, the longest gap in hours, the span in days, and the days and months since the start of the latest run with no gap longer than 30 days.

The signature is Ed25519 by the signing key over the UTF-8 of `sigil-life-certificate-v1`, a newline, and the body as canonical JSON: object keys sorted, no white space, keys with undefined values left out. The `certificate` vector shows a canonical body and its signature.

A checker must confirm, on its own:

1. the body is signed by the key it names;
2. every presence statement is signed by that key, for that period and origin, and its time falls in that period;
3. every entry hashes to its leaf (part 4, kind `presence`, appId `vault`, count 1) and the proof leads to the listed root;
4. the summary follows from the periods listed;
5. the roots are those the site publishes, and those on chain when the seals are anchored.

It proves that whoever held the vault's signing key signed in each of those periods and that the site sealed it then. It does not prove who that is, that it is one person, or anything about what is in the vault.
