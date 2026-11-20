# Sigil design brief

Everything the visual design pass has to style. The product works and every page has its final copy; the styling is deliberately plain so it can be replaced without touching logic.

## Ground rules

- **Look:** black, with silver and white details. Near-black backgrounds, white type, silver as the only accent (fine lines, subtle metallic gradients on the few surfaces that matter). No colour accents beyond black, silver, white and greys, including for errors and success.
- **Hero piece:** calm, specific to what Sigil does, never a badge. No coins, medallions, stars, rim lettering, woven bands, glowing orbs or node webs. It lives in `web/src/components/hero/`. Respect `prefers-reduced-motion` with a still frame, cap frame work and stop off screen.
- **Chrome stays:** full-width header with the logo top left, section nav, GitHub and X icons top right and the Open vault button; a footer. No left sidebar.
- **Copy stays:** do not add em dashes, emoji, or labels such as "demo" or "sample". `web/test/content.test.ts` checks this.
- **Logo:** `web/src/components/Logo.tsx` renders the text wordmark. When the logo file exists, set `logoSrc` in `web/src/lib/site.ts`; nothing else changes.
- **Phone first-class:** 390 px wide with a 16 px gutter, no horizontal scroll, 44 px touch targets, inputs at 16 px or more (no iOS zoom).

## Where styling lives

- One stylesheet: `web/src/app/globals.css`. Tokens are on `:root` (colour, type, space, radius, container, header height, shadow). Restyle tokens first.
- Fonts are self-hosted and exposed as `--font-sans`, `--font-display`, `--font-mono`. Self-host any new font (the content security policy blocks third-party font hosts) via `next/font/local` or files in `web/public`.
- The CSP in `web/next.config.ts` allows only same-origin scripts, styles, images and fonts. Inline styles are allowed.
- Icons are inline SVG in `web/src/components/icons.tsx` and use `currentColor`. Brand marks (Claude, ChatGPT, Cursor, MCP, GitHub, X) are their official monochrome shapes.
- Screenshots of the current state: `docs/screenshots/` (`<page>-<desktop|phone>-<top|middle|bottom>.png`, `vault-<state>-<desktop|phone>-*.png`, `hero-<a|b|c>-*.png`). Regenerate with `npx playwright test -c playwright.shots.config.ts` in `e2e/` after `npm run build`.

## Site chrome

| Component | File | Classes | States |
| --- | --- | --- | --- |
| Header | `components/Header.tsx` | `.site-header`, `.site-header-inner`, `.site-brand`, `.site-nav`, `.site-nav-link`, `.site-actions`, `.icon-link`, `.site-cta`, `.site-menu-button` | sticky; active link `[aria-current="page"]`; phone (at 820 px and below) hides nav and CTA, shows menu button |
| Phone menu | same | `.site-menu`, `.site-menu-link`, `.site-menu-cta`; `.site-header[data-open="true"]` | open and closed |
| Logo | `components/Logo.tsx` | `.logo`, `.logo-word`, `.logo-image` | wordmark now, image later |
| Footer | `components/Footer.tsx` | `.site-footer`, `.site-footer-inner`, `.site-footer-brand`, `.site-footer-tagline`, `.site-footer-nav`, `.site-footer-social`, `.site-footer-legal` | desktop three columns, phone stacked |
| Skip link | `app/layout.tsx` | `.skip-link` | hidden until focused |

## Shared components

| Component | File | Classes | States |
| --- | --- | --- | --- |
| Buttons | everywhere | `.button`, `.button-primary`, `.button-ghost`, `.button-danger`, `.button-small`, `.button-block`, `.text-button` | hover, focus-visible, disabled, busy text ("Saving", "Checking") |
| Cards | pages | `.card`, `.card-icon`, `.card-title`, `.card-text`, `.card-link` | equal heights in a row |
| Badge and chip | pages, vault | `.badge`, `.badge-strong`, `.chip`, `.chips` | Built / Core built / Planned; Active / Revoked; Sealed / Waiting for seal; Local / On chain |
| Page header | `components/PageHeader.tsx` | `.page-header`, `.eyebrow`, `.page-title`, `.page-lead` | |
| Prose (legal, how it works, security, docs) | pages | `.prose`, `.prose h2`, `.meta`, `.toc`, `.doc-section` | long reading on phone |
| Tables | docs, privacy | `.table-wrap`, `.table` | horizontal scroll inside the wrapper on phone |
| Code block with copy | `components/CodeBlock.tsx` | `.code-block`, `.code-block-label`, `.code-block-pre`, `.code-block-copy` | Copy and Copied |
| Notices | `vault/ui.tsx`, pages | `.notice`, `.notice-error`, `.notice-success` | info, error, success |
| Empty state | `vault/ui.tsx`, `SealList` | `.empty-state`, `.empty-state-icon`, `.empty-state-title`, `.empty-state-text` | with and without an action |
| Loading | `vault/ui.tsx` | `.loading`, `.spinner` | |
| Progress | Import | `.progress`, `.progress-bar` | 0 to 100 percent |
| Forms | vault | `.field`, `.field-label`, `.field-hint`, `.input`, `.textarea`, `.select`, `.checkbox`, `.checkbox-list`, `.form-actions` | focus, disabled, required |
| AI apps row | `components/AppMakers.tsx` | `.app-makers`, `.app-maker`, `.app-maker-icon`, `.app-maker-name` | wraps on phone |
| Public seal list | `components/SealList.tsx` | `.seal-list`, `.seal-row`, `.seal-hour`, `.seal-root` | loading, error, empty ("No seals yet"), list |

## Pages

| Route | File | Sections and notes |
| --- | --- | --- |
| `/` | `app/page.tsx` | `.hero` (`.hero-inner`, `.hero-title`, `.hero-lead`, `.hero-actions`, `.hero-visual[data-hero]` for the hero piece); `.works-with` row of AI apps; three promises (`.grid-3` of `.card`); four steps (`.steps`, `.step`); permissions split with the app permission illustration (`.split`, `.permission-card`, `.permission-item[data-allowed]`, `.checklist`); import and seal cards (`.grid-2`); roadmap teaser; final `.cta-band` |
| `/how-it-works` | `app/how-it-works/page.tsx` | seven numbered prose sections; "Who can see what" two cards |
| `/security` | `app/security/page.tsx` | table of contents chips; prose sections; live "Latest seals" list (all four states of `SealList`) |
| `/docs` | `app/docs/page.tsx` | table of contents; eleven doc sections with code blocks and tables; the connector section switches between "build from source" and `npx` with `site.connectorPublished` |
| `/roadmap` | `app/roadmap/page.tsx` | six pillars (`.pillars`, `.pillar`); thirteen stages (`.stages`, `.stage[data-status]`, `.stage-number`, `.stage-head`, `.stage-items`, `.stage-item[data-built]`); closing disclaimer |
| `/terms` | `app/terms/page.tsx` | prose |
| `/privacy` | `app/privacy/page.tsx` | prose with the "What is stored" table |
| `/vault` | `app/vault/page.tsx` | the app below |
| 404 | `app/not-found.tsx` | |
| favicon | `app/icon.svg` | replace with the logo mark later |

## The vault (`/vault`)

All files in `web/src/vault/`. The wrapper is `.vault[data-phase]` with phases `checking`, `offline`, `gate`, `phrase`, `open`.

### Before the vault is open

| State | Component | What to style |
| --- | --- | --- |
| Checking session | `VaultApp.tsx` | `.loading` |
| Server unreachable | `VaultApp.tsx` | error notice and Try again |
| Create (signed out) | `Gate.tsx`, `.vault-gate[data-mode="create"]` | `.segmented` switch (Create a vault / Sign in), title, lead, `.method-list` with `.method` buttons (`.method-icon`, `.method-title`, `.method-text`), terms line `.gate-terms` |
| Sign in | same, `data-mode="signin"` | adds the recovery phrase method; phrase form in `.subpanel` |
| Unlock (signed in, page reloaded) | same, `data-mode="unlock"` | no switch; "Not your vault? Sign out" `.gate-signout` |
| Working | same | the pressed method shows `.spinner`; step text in a `.notice` ("Approve the signature in your wallet", "Create the passkey, then confirm it once more") |
| Error | same | `.notice-error` (wallet declined, passkey cancelled, no wallet, passkey without PRF, unknown wallet, invalid phrase) |
| Phone without a wallet | same | the wallet button navigates to the wallet app; a notice says so |
| Recovery phrase | `PhraseScreen.tsx` | `.phrase-grid` of 24 `.phrase-word` (numbered by CSS counter), copy and download buttons, `.phrase-confirm` checkbox, disabled primary button until checked |

### The open vault

`Dashboard.tsx`: `.dashboard-bar` (title, `.dashboard-stats`, Lock vault), an error notice when items could not be decrypted, `.tabs` with `.tab[aria-selected]`, and the panel. Tabs are reachable by URL hash (`#memories`, `#folders`, `#apps`, `#log`, `#import`, `#settings`).

| Tab | File | States |
| --- | --- | --- |
| Memories | `tabs/Memories.tsx` | empty vault (two actions); `.toolbar` with `.search` and folder `.select`; `.memory-layout` with `.memory-list` / `.memory-item[aria-current]` (`.memory-item-title`, `.memory-item-meta`, `.memory-item-snippet`) and the `.editor` (idle hint, new, existing, delete confirmation in `.subpanel`, saving, error); no results; Show more |
| Folders | `tabs/Folders.tsx` | `.list` of `.list-row` (title with folder icon, count, which apps can read it); rename inline; delete confirmation; the last folder cannot be deleted; add folder form |
| Apps | `tabs/Apps.tsx` | empty; Connect form (`.connect-form`: app type, name, folder `.checkbox-list`, plain-words summary, trust notice); the one-time key panel (`.app-key-panel`, `.app-key`, per-app instructions with code blocks, confirmation checkbox); list of `.app-row[data-status="active|revoked"]` with folder chips, Permissions editor, Revoke confirmation, Remove for revoked apps; "Revoked" sub-heading `.settings-heading` |
| Read log | `tabs/Log.tsx` | loading; error; empty; explanation notice (seals local or on chain); app filter (only when more than one app); `.log-row[data-kind="folders|index|read"][data-sealed]` with Verify button, "Checking", `.log-verified` and `.log-unverified` results |
| Import | `tabs/Import.tsx` | `.dropzone[data-dragging]` idle and reading; two help cards (`.import-help`); preview (counts, duplicates skipped, target folder); progress; done; error |
| Settings | `tabs/Settings.tsx` | sign-in methods list with Remove confirmation and Replace for the phrase; Add a passkey / Add a wallet (busy text); new phrase confirmation and the phrase screen; Export; This device (Lock, Sign out); `.danger-zone` with typed confirmation |

## The design as built

- **Direction:** black, silver and white. Hairlines, a double ring around icons and numbers, a small diamond as the mark between things, and brushed metal only on the primary button, the selected tab or switch and the built stages of the roadmap.
- **Fonts (self-hosted in `web/src/fonts`, loaded with `next/font/local` in `app/layout.tsx`):** Bodoni Moda for display (`--font-display`, with `--display-cut` setting a sturdier optical size), Instrument Sans for text (`--font-sans`), DM Mono for labels, numbers and code (`--font-mono`). All three are under the SIL Open Font License; the licence texts sit next to the files.
- **Hero piece:** `components/hero/`. Three directions are kept side by side for review; `HeroVisual.tsx` picks one from the address (`/?hero=a`, `/?hero=b`, `/?hero=c`) and `DEFAULT_HERO` there sets the one shown without it (now B). Once one is chosen, delete the other two files and their block in `globals.css`.
  - **A, the vault at work** (`HeroFilm.tsx`, `.film-*`): the vault's own interface as a short film in five captioned steps. An app is given two of four folders, lists them, reads one memory (ciphertext turns to plain text), both reads land in the log, and the hour closes into one fingerprint. A timer moves the step; every movement is a CSS transition.
  - **B, one vault, five readers** (`HeroViews.tsx`, `.views-*`): six lines of a vault set large in the display face, shown as you, Sigil's server, Claude, ChatGPT and Cursor get them. Lines lock into ciphertext and open again only where that reader was given the folder. It cycles on its own and the five names are buttons.
  - **C, the block** (`HeroSlab.tsx`, `.slab-*`): one block of polished black marble with a single silver inlay on a dark mirror, lit by soft studio lights that drift and follow the pointer (the page scroll on touch screens). One small WebGL fragment shader, 30 frames a second at most, with a still drawing when WebGL is missing.
  - All three stop while off screen or in a hidden tab (`hero/clock.ts`) and hold one finished frame with reduced motion. On a phone A and B sit below the headline and buttons; C sits above the headline.
- **Other motion:** sections rise as they scroll in (only where scroll-driven animations exist), seal rows come in one after another, the Sealed badge stamps in, the primary button has a sheen on hover. All of it is off with reduced motion.
- **Share image:** `app/opengraph-image.png` and `app/twitter-image.png` (1200 by 630), the default hero at rest. Regenerate with the `share image` test in `e2e/shots/screens.spec.ts`.
- **States without colour:** errors and confirmations are white on a lighter plate with an icon and a plain label ("Error", "Done"); waiting and revoked states use dashed outlines; allowed and sealed states use a filled mark.

## Not yet designed

- A logo mark for the favicon (`app/icon.svg` is unchanged; set `logoSrc` when the logo file exists).
