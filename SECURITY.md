# Security

## Reporting a vulnerability

Please report anything you find privately through this repository on GitHub: open the Security tab and choose Report a vulnerability. Only the maintainers can see it. Do not open a public issue for a security problem.

Please include what you found, how to reproduce it, and what someone could do with it. Do not test against vaults that are not yours, and do not read, change or delete anyone's data. Give us a reasonable time to fix it before you publish; we will tell you when it is fixed and, if you want, credit you in the changelog.

There is no bounty at present.

## What is in scope

The code in this repository: the site and its API (`web/`), the core package (`packages/core/`), the connector (`connector/`), the browser extension (`extension/`), the SDK (`packages/sdk/`) and the contracts (`contracts/`). A node someone else runs is that person's.

## What we have checked

The review made before launch, every finding, its fix and its test, and what still needs an outside audit: [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md). How the encryption works and what the server can and cannot see: the site's `/security` and `/threat-model` pages.
