# Sigil design brief

Everything the visual design pass has to style. The product works and every page has its final copy; the styling is deliberately plain so it can be replaced without touching logic.

## Ground rules

- **Look:** black, with silver and white details. Near-black backgrounds, white type, silver as the only accent (fine lines, subtle metallic gradients on the few surfaces that matter). No colour accents beyond black, silver, white and greys, including for errors and success.
- **Hero piece:** calm, specific to what Sigil does, never a badge. No coins, medallions, stars, rim lettering, woven bands, glowing orbs or node webs. It lives in `web/src/components/hero/`. Respect `prefers-reduced-motion` with a still frame, cap frame work and stop off screen.
- **Chrome stays:** full-width header with the logo top left, four grouped menus (Product, Trust, Developers, Vision), GitHub and X icons top right and the Open vault button; a footer with the same four groups. No left sidebar. The menus, the phone menu and the footer all read `navGroups` in `web/src/lib/site.ts`: add a page there and it appears in all three.
- **Copy stays:** do not add em dashes, emoji, or labels such as "demo" or "sample". `web/test/content.test.ts` checks this.
- **Logo:** `web/src/components/Logo.tsx` renders the text wordmark. When the logo file exists, set `logoSrc` in `web/src/lib/site.ts`; nothing else changes.
- **Phone first-class:** 390 px wide with a 16 px gutter, no horizontal scroll, 44 px touch targets, inputs at 16 px or more (no iOS zoom).

## Where styling lives

- One stylesheet: `web/src/app/globals.css`. Tokens are on `:root` (colour, type, space, radius, container, header height, shadow). Restyle tokens first.
- Fonts are self-hosted and exposed as `--font-sans`, `--font-display`, `--font-mono`. Self-host any new font (the content security policy blocks third-party font hosts) via `next/font/local` or files in `web/public`.
- The CSP in `web/next.config.ts` allows only same-origin scripts, styles, images and fonts. Inline styles are allowed.
- Icons are inline SVG in `web/src/components/icons.tsx` and use `currentColor`. Brand marks (Claude, ChatGPT, Cursor, MCP, GitHub, X) are their official monochrome shapes.
- Screenshots of the current state: `docs/screenshots/` (`<page>-<desktop|phone>-<top|middle|bottom>.png`, `vault-<state>-<desktop|phone>-*.png`, `hero-<a|b|c>-*.png`). The screenshots in the folder are from before the full site was built; the spec now also covers the new pages, the open menus (`menu-desktop-<group>.png`) and the page ground in motion (`backdrop-frame-<n>.png`). Regenerate with `npx playwright test -c playwright.shots.config.ts` in `e2e/` after `npm run build`.

## Site chrome

| Component | File | Classes | States |
| --- | --- | --- | --- |
| Header | `components/Header.tsx` | `.site-header`, `.site-header-inner`, `.site-brand`, `.site-nav`, `.site-nav-group[data-open]`, `.site-nav-link` (a button, `[data-current]` when one of its pages is open), `.site-nav-chevron`, `.nav-panel` (`.nav-panel-head`, `.nav-panel-label`, `.nav-panel-lead`, `.nav-panel-list`, `.nav-panel-link`, `.nav-panel-title`, `.nav-panel-text`), `.site-actions`, `.icon-link`, `.site-cta`, `.site-menu-button` | sticky; a menu opens on hover, click or keyboard and closes on Escape, outside click or navigation; phone (at 820 px and below) hides the menus, shows the menu button |
| Phone menu | same | `.site-menu`, `.site-menu-group`, `.site-menu-label`, `.site-menu-list`, `.site-menu-link`, `.site-menu-cta`; `.site-header[data-open="true"]` | open and closed; scrolls inside itself |
| Logo | `components/Logo.tsx` | `.logo`, `.logo-word`, `.logo-image` | wordmark now, image later |
| Footer | `components/Footer.tsx` | `.site-footer`, `.site-footer-inner`, `.site-footer-brand`, `.site-footer-tagline`, `.site-footer-social`, `.site-footer-nav`, `.site-footer-group`, `.site-footer-label`, `.site-footer-legal`, `.site-footer-legal-links` | desktop brand plus four columns, phone two by two |
| Page ground | `components/backdrop/Backdrop.tsx` | `.backdrop`, `.backdrop-canvas`, `.backdrop-rules`, `.backdrop-grain` | moving, and one still frame with reduced motion |
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
| Page blocks | new pages | `.page-section`, `.page-section-narrow`, `.split-top`, `.panel`, `.fact-grid`, `.card-number`, `.mini-steps`, `.plain-list` | |
| Read next | `components/PageLinks.tsx` | `.page-links`, `.page-link`, `.page-link-group`, `.page-link-title`, `.page-link-text` | three links at the foot of every new page |

## Pages

| Route | File | Sections and notes |
| --- | --- | --- |
| `/` | `app/page.tsx` | `.hero` with the hero piece; `.works-with` row of AI apps; live counters (`.section-stats`, `.stats`, `.stat`, `.stat-number`); three promises (`.grid-3` of `.card`); four steps (`.steps`, `.step`); permissions split (`.split`, `.permission-card`, `.checklist`); import (`.import-flow`, `.import-flow-step`); smart memory (`.smart-list` and the `.inbox-preview` card, which is stamped Approved now and then); three more ways in (`.grid-3` of `.card`: extension, Sign in with Sigil, sharing); seals with the live latest seal (`.seal-card`); two views of one memory (`.compare`, `.compare-row`, `.compare-plain`, `.compare-cipher`); six promises (`.fact-grid` of `.pillar`); developers (`.link-list` and a code block); roadmap teaser; questions (`.faq-layout`, `.faq`, `.faq-item`, built on `details`); final `.cta-band` |
| `/import` | `app/import/page.tsx` | drop zone that hands the file to the vault (`components/ImportDrop.tsx`, `.import-drop`, `.dropzone`); two guide cards (`.guide-card`, `.guide-steps`, `.plain-list`); six facts |
| `/apps` | `app/apps/page.tsx` | index of seven apps (`.app-index`, `.app-index-link`); two things to do first; one guide per app (`.guides`, `.guide`, `.guide-head`, `.guide-icon`, `.guide-tags`, `.guide-body`, `.guide-steps`, `.guide-code`, `.guide-after`) |
| `/seals` | `app/seals/page.tsx` | live latest seal (`.seal-card`, with and without a seal); proof checker in a `.panel`; the public list (`SealList`, all four states) |
| `/how-it-works` | `app/how-it-works/page.tsx` | seven numbered prose sections; "Who can see what" two cards |
| `/security` | `app/security/page.tsx` | table of contents chips; prose sections; live "Latest seals" list |
| `/threat-model` | `app/threat-model/page.tsx` | who can see what (`.table-wide`); protected against and not protected against (`.threats[data-kind]`, `.threat`); what you can do |
| `/privacy` | `app/privacy/page.tsx` | prose with the "What is stored" table |
| `/status` | `app/status/page.tsx` | `components/live/StatusBoard.tsx`: `.status-banner[data-level]`, `.status-list`, `.status-row[data-level="ok|off|fault"]`, `.status-mark`, `.status-numbers`; loading, working, fault and "server did not answer" |
| `/docs` | `app/docs/page.tsx` | table of contents; eleven doc sections with code blocks and tables |
| `/docs/api` | `app/docs/api/page.tsx` | sticky index (`.doc-layout`, `.doc-aside`); `.doc-block` sections; one `.endpoint` per endpoint (`.endpoint-head`, `.endpoint-method[data-method]`, `.endpoint-path`, `.endpoint-params`, `.endpoint-notes`) |
| `/connector` | `app/connector/page.tsx` | the path of one read (`.flow`, `.flow-step`, `.flow-where`); install split; three tools (`.tools`, `.tool`, `.tool-name`, `.tool-logged`); two modes; settings table; three facts |
| `/verify` | `app/verify/page.tsx` | the checker with three modes (`components/live/Verifier.tsx`: `.verifier`, `.segmented`, `.verifier-form`, `.verifier-result[data-ok]`, `.proof-steps`); the rules; a script; what a check proves |
| `/open-source` | `app/open-source/page.tsx` | `.repo-card`; six parts (`.pillar[data-plain]`, `.pillar-path`); run it; settings; licence |
| `/ai-self` | `app/ai-self/page.tsx` | vision notice (`.vision-note`); five chapters (`.chapters`, `.chapter[data-built]`, `.chapter-number`); six principles; `.closing` |
| `/roadmap` | `app/roadmap/page.tsx` | six pillars; thirteen stages (`.stages`, `.stage[data-status]`); closing disclaimer |
| `/changelog` | `app/changelog/page.tsx` | entries from `lib/changelog.ts` (`.releases`, `.release`, `.release-date`, `.release-title`) |
| `/terms` | `app/terms/page.tsx` | prose |
| `/vault` | `app/vault/page.tsx` | the app below |
| `/ask/<id>` | `app/ask/[id]/page.tsx`, `ask/AskApp.tsx` | the public page of an ask link: `.ask-page`, `.ask-card` with `.eyebrow`, `.page-title` (the AI self's name), `.page-lead` (greeting), `.ask-status[data-online]`, the `.chat` conversation (`.chat-turn[data-status="waiting|answered|failed"]`), `.chat-form`, `.ask-fine`; states: opening, link cannot be used (no key, wrong key, deleted), offline, turned off, expired, used up |
| `/vault/authorize` | `app/vault/authorize/page.tsx`, `vault/Consent.tsx` | Sign in with Sigil. The wrapper carries `.vault[data-consent]`, which hides the menus and the footer so only the name stays. The vault gate, then `.vault-gate.consent[data-state="asking|allowed|denied|stopped"]`: `.consent-link` (the app, the wire and your vault; `[data-active]` once something is ticked), `.consent-who` with `.consent-origin`, `.consent-folders` of `.consent-folder[data-on]` with a memory count, the suggestions switch `.suggest-toggle`, `.consent-terms` (two `.consent-list`, can and never can), `.consent-actions`, `.consent-foot`; states: incomplete request, opened without an app, done (`.consent-stamp`, `data-testid="consent-done"`) |
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

`Dashboard.tsx`: `.dashboard-bar` (title, `.dashboard-stats`, Lock vault), an error notice when items could not be decrypted, `.tabs` with `.tab[aria-selected]` (the Inbox tab carries a `.tab-count`), and the panel. Tabs are reachable by URL hash (`#memories`, `#inbox`, `#self`, `#review`, `#timeline`, `#profile`, `#folders`, `#apps`, `#log`, `#import`, `#settings`).

| Tab | File | States |
| --- | --- | --- |
| Memories | `tabs/Memories.tsx` | empty vault (two actions); `.toolbar` with `.search`, folder `.select` (shared folders as "Shared: name") and Find duplicates (which shows `.merge-all`: Merge every group, then a confirmation); expired memories leave the list for Review; `.search-mode[data-state="off|loading|indexing|ready|failed"]` (a device icon, the line and `.search-mode-bar` while it reads); with a query each result shows why it matched: matched words in `mark`, and `.memory-item-why` with `.why-words` (where the words were found) and `.why-meaning` (a `.why-meter` and the closeness); `.memory-layout` with `.memory-list` / `.memory-item[aria-current][data-match="words|meaning|both"]` (`.memory-item-title`, `.memory-item-meta` with a "By meaning" `.chip-strong` and "Shared by" chip, `.memory-item-snippet`) and the `.editor` (idle hint, new, existing, delete confirmation in `.subpanel`, saving, error, the Self card notice, an Expires date in `.expiry-row` with No expiry, and an expired notice) or `.editor-readonly` for a shared memory (`.editor-title`, `.editor-body`); no results; Show more |
| Duplicates | `tabs/Duplicates.tsx` | `.subpanel.duplicates`; none found; `.duplicate-list` of `.duplicate[data-kind="same|near|meaning"]` with Merge, Delete the older (same text only) and Not the same |
| Inbox | `tabs/Inbox.tsx` | empty (`.inbox-empty`: the empty state, with or without apps allowed to suggest, over the three `.inbox-how-step`); `.inbox-summary`; `.proposal-list` of `.proposal[data-state="idle|busy|approved|merged|updated|rejected"]`, `[data-close="same|meaning|synced"]` (`.proposal-fold`, `.proposal-card`, `.proposal-head` with the app `.mark`, `.proposal-from`, `.proposal-url` and the Sealed for you badge), `.proposal-facts` (suggested folder; in your vault `[data-kind="new|same|meaning|synced"]`; for a synced note the first fact names the memory it updates), the Obsidian notices (a change to a synced note, or a note from the Obsidian folder), a "close to" notice (not for a synced note), title, body and tags fields, `.segmented.proposal-mode[data-options="2|3"]` (update for a synced Obsidian note on its own row, new or merge), folder select with "New folder: name", merge search and `.merge-targets`, Update, Approve or Merge and Reject with busy text and a light along the top edge; once decided the `.proposal-stamp[data-outcome]` is pressed on and the card folds away (only with motion on); an unreadable suggestion |
| Timeline | `tabs/Timeline.tsx` | empty; `.timeline-sources` of `.timeline-source[aria-pressed]` switches with source marks and counts, the date select, `.timeline-span`; `.timeline-months` of `.timeline-month` (`.timeline-month-title`, `.timeline-month-count`), `.timeline-day` (`.timeline-day-number`, `.timeline-day-week`, a diamond on the line), `.timeline-group[data-source]` (`.timeline-group-head` with the source mark) and `.timeline-item[data-source]` (`.timeline-item-title`, `.timeline-item-meta` with folder and time) |
| Self card | `tabs/Profile.tsx` | `.profile` form; `.self-layout` of the card and the aside; `.self-card[data-state="new|changed|saved"]` (`.self-card-top`, three `.self-field[data-part]` with number, label, count, textarea and hint, `.self-card-foot` with the vault fingerprint); `.self-aside` with `.profile-access` (no folder yet, no app, readable by, `.self-readers`), `.self-notes`, last saved; saved notice |
| Folders | `tabs/Folders.tsx` | `.list` of `.list-row` (title with folder icon, count, which apps can read it); rename inline; Share opens `.share-form[data-code="empty|bad|ok"]` (`.share-form-head`, `.handshake-steps` with `[data-state="now|done|next"]`, vault code with fingerprint hint, the `.handshake` panel with the `.fingerprint` in groups once the code is good, what you call them, your name, notice); `.folder-shares` with `.share-row[data-accepted][data-verified]` and its `.share-row-mark` and Stop sharing confirmation (busy "Making a new key"); delete confirmation; the last folder cannot be deleted; add folder form; "Shared with you" `.shared-row[data-accepted]` with `.shared-row-mark`, Accept, Decline or Remove; "Your vault code" `.vault-code` as `.vault-code-plate`: the code in `.app-key` with copy on one side, the `.fingerprint` to read out on the other |
| Apps | `tabs/Apps.tsx` | empty; Connect form (`.connect-form`: app type including Browser extension, name, folder `.checkbox-list`, the `.suggest-toggle`, plain-words summary, trust notice); extension instructions in the key panel; a "May suggest memories" `.chip-strong` on the row and the toggle in Permissions; the one-time key panel (`.app-key-panel`, `.app-key`, per-app instructions with code blocks, confirmation checkbox); list of `.app-row[data-status="active|revoked"]` with folder chips, Permissions editor, Revoke confirmation, Remove for revoked apps; "Revoked" sub-heading `.settings-heading` |
| Read log | `tabs/Log.tsx` | loading; error; empty; explanation notice (seals local or on chain); app filter (only when more than one app); `.log-row[data-kind="folders|index|read|propose|shared|ask"][data-sealed]` (an ask row opens `.ask-note` with the question and answer) with Verify button, "Checking", `.log-verified` and `.log-unverified` results |
| AI self | `tabs/Self.tsx` | `.self`; `.self-status[data-state="off|no-model|serving|failed"]`; Model `.subpanel` (form, or `.self-model` with the masked key, Change and Remove); Rules form (`.self-rules`, folder `.checkbox-list`); Test chat (`.self-chat`, `.chat` of `.chat-turn` with `.chat-question`, `.chat-answer`, refusal `.chip`, `.chat-sources`; `.chat-form`; notice when no key or no rules); Apps that answer as you (`.list-row` with a `.suggest-toggle`); Ask links (`.self-links`, `.self-links-head`, `.new-link` form with `.link-limits`, the made link in `.app-key-panel.link-made`, `.link-list` of `.link-row[data-state="active|inactive"]` with a status `.badge`, Online or Offline `.chip`, Copy, Turn off and Delete with confirmation) |
| Review | `tabs/Review.tsx` | `.review`; Weekly brief (`.brief`, `.brief-latest`, `.brief-body`, two checkboxes, Make a brief now, busy "Writing"); Memories that disagree (`.contradictions`, `.contradiction-list` of `.contradiction` with `.contradiction-pair` / `.contradiction-side`, Keep, Ask my model, Both are true); Expired (`.expired`, `.grace-form`, rows with Keep it and Delete now) |
| Import | `tabs/Import.tsx` | `.import-sources` of `.import-source[data-selected]` (six sources); `.dropzone[data-dragging]` idle and reading with Choose files and Choose a folder; the GitHub form (`.github-form`, `.segmented`); preview (counts, notes, `.import-sample` of the first five, duplicates skipped, target folder); progress; done (with the --watch hint after Obsidian); error |
| Settings | `tabs/Settings.tsx` | sign-in methods list with Remove confirmation and Replace for the phrase; Add a passkey / Add a wallet (busy text); new phrase confirmation and the phrase screen; Export; This device (Lock, Sign out); `.danger-zone` with typed confirmation |

## The design as built

- **Direction:** black, silver and white. Hairlines, a double ring around icons and numbers, a small diamond as the mark between things, and brushed metal only on the primary button, the selected tab or switch and the built stages of the roadmap.
- **Fonts (self-hosted in `web/src/fonts`, loaded with `next/font/local` in `app/layout.tsx`):** Bodoni Moda for display (`--font-display`, with `--display-cut` setting a sturdier optical size), Instrument Sans for text (`--font-sans`), DM Mono for labels, numbers and code (`--font-mono`). All three are under the SIL Open Font License; the licence texts sit next to the files.
- **Hero piece:** `components/hero/`. Three directions are kept side by side for review; `HeroVisual.tsx` picks one from the address (`/?hero=a`, `/?hero=b`, `/?hero=c`) and `DEFAULT_HERO` there sets the one shown without it (now B). Once one is chosen, delete the other two files and their block in `globals.css`.
  - **A, the vault at work** (`HeroFilm.tsx`, `.film-*`): the vault's own interface as a short film in five captioned steps. An app is given two of four folders, lists them, reads one memory (ciphertext turns to plain text), both reads land in the log, and the hour closes into one fingerprint. A timer moves the step; every movement is a CSS transition.
  - **B, one vault, five readers** (`HeroViews.tsx`, `.views-*`): six lines of a vault set large in the display face, shown as you, Sigil's server, Claude, ChatGPT and Cursor get them. Lines lock into ciphertext and open again only where that reader was given the folder. It cycles on its own and the five names are buttons.
  - **C, the block** (`HeroSlab.tsx`, `.slab-*`): one block of polished black marble with a single silver inlay on a dark mirror, lit by soft studio lights that drift and follow the pointer (the page scroll on touch screens). One small WebGL fragment shader, 30 frames a second at most, with a still drawing when WebGL is missing.
  - All three stop while off screen or in a hidden tab (`hero/clock.ts`) and hold one finished frame with reduced motion. On a phone A and B sit below the headline and buttons; C sits above the headline.
- **The page ground** (`components/backdrop/Backdrop.tsx`, behind every page): layered dark tones from charcoal to near-black, film grain, a vignette and two etched vertical rules at the edges of the content on wide screens. On top of that one 2D canvas draws rows of ciphertext engraved in the mono face. A soft light drifts slowly across the page and a second one follows the pointer; the engraving shows only where the light falls, and now and then a few characters resolve into a plain word and lock again. The engraving moves a little slower than the page when scrolling. 30 frames a second at most, stopped in a hidden tab, one finished frame with reduced motion.
- **Other motion** (`components/backdrop/Motion.tsx` and the last blocks of `globals.css`): sections, cards and rows rise in as they enter the screen, neighbours one after another; section hairlines draw in from the middle and carry a travelling highlight; small mono labels decode from ciphertext into their words; panels carry a soft light under the pointer; the rings of the seal turn slowly as brushed metal; the apps in "Reads into" light up in turn; the footer's outlined name carries a slow sheen; counters count up; the latest seal shows the time left in the running hour. All of it hangs on `html[data-motion="on"]`, set before first paint by a small inline script only when the visitor has not asked for less motion. Without it nothing is hidden and nothing moves.
- **Marks:** `vault/marks.tsx` gives every app kind and every memory source a round `.mark` with its icon (`AppMark`, `SourceMark`); the inbox, the timeline and the Self card use them.
- **Vault motion:** a suggestion is stamped and folds away when it is decided, timeline days rise one after another, the fingerprint groups set in turn, the wire in the consent window runs until something is ticked. All of it hangs on `html[data-motion="on"]` like the rest.
- **Live data:** `components/live/` reads the public endpoints (`/api/stats`, `/api/status`, `/api/seals`). Numbers are real; zero is shown as zero.
- **Share image:** `app/opengraph-image.png` and `app/twitter-image.png` (1200 by 630), the default hero at rest. Regenerate with the `share image` test in `e2e/shots/screens.spec.ts`.
- **States without colour:** errors and confirmations are white on a lighter plate with an icon and a plain label ("Error", "Done"); waiting and revoked states use dashed outlines; allowed and sealed states use a filled mark.

## The extension

`extension/static/`: `popup.html`, `options.html` and one stylesheet, `extension.css`, with its own copy of the tokens. The build copies the three typefaces from `web/src/fonts` into `dist/fonts`, so nothing is fetched at run time.

| Page | Classes | States |
| --- | --- | --- |
| Popup (340 px) | `.cipher` rows behind the name, `.head` with `.pair`, `#status`, `.actions` of two `.act` buttons (the first is the silver plate), `.note`, `.foot` with `.sealed` and the Options `.link` | `body[data-paired="checking|yes|no"]`; `body[data-state="working|sent|failed"]`; buttons disabled until paired |
| Options | `.box`, `.eyebrow`, `.paired`, the form, `.row` of buttons, `.note`, `.fine` | `body[data-paired]`; Forget this vault only when paired |

## Not yet designed

- A logo mark for the favicon (`app/icon.svg` is unchanged; set `logoSrc` when the logo file exists).
