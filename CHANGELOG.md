# Changelog

## [1.18.0] — 2026-09-05

### feat: minimal failure observability for sync and collaborative-collection crypto (#254)

75 `catch {}` blocks across the app degrade gracefully and silently — the right call for UX, but it meant the failures that matter most (this is a distributed, end-to-end-encrypted system where the server is deliberately blind) were completely unknowable: "is sync working for everyone?" had no better answer than "nobody's complained." This adds content-free failure *counters* — no user id, no collection id, no titles, just "this failure class happened" — for the sync/crypto paths named in the issue. Scoped deliberately narrow, per the issue's own "worth deciding first" list: the other ~70 catches are local-only (a `localStorage` write failing under Safari private mode, etc.) and aren't worth a network call.

Counters live in the existing `SHARE_KV` namespace, one key per failure class per UTC day (`failure:<class>:<date>`, 90-day TTL), rather than a new Cloudflare Analytics Engine dataset as first attempted — that approach's `wrangler.toml` binding failed to deploy on this project's Cloudflare Pages build for reasons this environment couldn't diagnose (no dashboard/API access to see the actual rejection), and reusing infrastructure already proven to deploy here beat guessing at a fix blind. KV's read-modify-write isn't atomic, so a burst of simultaneous identical failures could undercount by a few — a non-issue at the volume these classes actually fire (occasional retry-loop exhaustion, not a high-frequency event).

Six failure classes, reported via a new `reportFailure()` helper (fire-and-forget, `keepalive: true`, never throws) to a new unauthenticated `POST /api/failure` endpoint (same-origin-checked, rate-limited, validated against a fixed allowlist — never an arbitrary-string sink):

- `sync_409_exhausted` / `collection_sync_409_exhausted` — personal or collection sync gave up after `MAX_RETRIES` straight version conflicts.
- `collection_key_rotated` — a collection PUT was refused because this client's wrapped key is behind the collection's current generation.
- `collection_dek_mismatch` — **new detection, not just new reporting**: the blob GET's `X-Collection-Dek-Version` header was compared against the caller's own `memberDekVersion` *before* attempting to decrypt. That header has existed since the collections work landed specifically to let a client distinguish "encrypted under a generation I don't hold" from "corrupt" — but nothing ever actually read it. `pullCollectionBlob` (and `fetchCollectionState`/`syncCollectionItems`/`syncCollectionBallots` above it) now take an optional `expectedDekVersion` and throw the existing `CollectionKeyRotatedError` proactively on a mismatch, before wasting a decrypt attempt that was always going to fail.
- `collection_decrypt_failed` — decrypt/gunzip/parse failed on a collection blob whose dek version *did* match what was expected: genuine corruption, not a key-generation lag.
- `backup_item_parse_rejected` — a synced item failed `parseBackupItem`'s validation despite arriving from a source (another of the account's own devices, or a collection) that should only ever produce well-formed payloads. `deserializeAppState` now returns a `rejectedItemCount` alongside `items`; only the sync caller in `sync.ts` acts on it; the plain backup-file-import path (`import-actions.ts`) ignores it, since a hand-edited or years-old export rejecting some items isn't a distributed-system health question.

## [1.17.0] — 2026-09-05

### a11y: audit the seven suppressed warnings on the primary interaction surfaces (#256)

Worked each of the suppressed `a11y_click_events_have_key_events`/`a11y_no_static_element_interactions` pairs in `QueueGridView.svelte`, `QueueListView.svelte`, and `DetailPanel.svelte` per the issue's own framework: is this element missing real keyboard reachability, or is the suppression correct and just undocumented?

- **6 of 8 suppressions already had solid explanatory comments** from earlier work — the drag handles and the card/row "click is a convenience only" wrappers. Nothing to change there.
- **DetailPanel's 2 suppressions (the scrim, the poster lightbox) had none** — both are legitimate (a proper Close button and Escape already cover keyboard dismissal), so they get the same comment treatment now.
- **Keyboard-reachability of drag-and-drop, checked empirically**: `svelte-dnd-action`'s built-in keyboard mode (Tab to the handle, Space to pick up, arrow keys to move, Space to drop) already works — confirmed with a real browser test, not just reading the docs. The existing move-up/move-down buttons are a second, independent path. No fix needed; this was already correct and already documented in the code comments.
- **Tab-order pass on the queue card**: poster → season toggles → drag handle/rank buttons → watched toggle → remove, in that order in the DOM — matches the visual top-to-bottom reading order. No fix needed.
- **Contrast audit found a real, systemic bug**: `text-gray-400` paired with `dark:text-gray-500`/`dark:text-gray-600` — the reverse of the correct pairing — was used for secondary text (section labels, item counts, cast names, instructional copy) across `app.css`'s shared `panel-label` utility (used by 6 components) plus several inline instances in the three audited files. `text-gray-400` on white is 2.54:1 (WCAG AA requires 4.5:1 for normal text); the dark-mode pairing was failing too (`gray-600` on `gray-900` is 2.35:1). Fixed by swapping to `text-gray-500 dark:text-gray-400` — the pairing already used correctly elsewhere in the same files (4.83:1 light, 6.99:1 dark) — everywhere the text conveys real information. Purely decorative fallback glyphs (the missing-poster 🎬 placeholder, the missing-photo 👤 placeholder) are left alone; contrast requirements are for text/icons that convey information, not backdrop decoration.
- **Related but out of scope**: `QueueDock.svelte`'s sort-direction toggle button has the same reversed-pairing bug. Left alone since it's outside the three files this issue names — worth its own small follow-up.

## [1.16.0] — 2026-09-05

### Chore: dependency maintenance — clears 6 of 9 audit findings (#250)

An audit pass found the dependency tree itself lean (nothing unused, nothing to discard) but the maintenance behind it stale. This lands the safe part of that pass:

- **`wrangler` 4.90.0 → 4.129.0** (38 minor versions), which also required bumping **`@cloudflare/workers-types` 4.x → 5.x** — wrangler's own peer dependency on it switched majors partway through that range (`4.107.0` was the last version still declaring a `^4.x` peer; `4.108.0`+ all want `^5.x`). Unlike this issue's other deferred major bumps (`vite`, `typescript`), this one is ambient TypeScript declarations only — no runtime behavior, no build-tool semantics — and `npm run check`/`npm run build` both pass clean against it, so it's landed alongside the wrangler bump rather than deferred with the rest.
- In-range minor bumps picked up via `npm update <pkg>` (package.json ranges unchanged, lockfile only): `svelte`, `svelte-check`, `svelte-eslint-parser`, `eslint`, `eslint-plugin-svelte`, `globals`, `tailwindcss`, `@tailwindcss/vite`, `typescript-eslint`, `@sveltejs/kit`, `@playwright/test`.

`npm audit` goes from 9 findings to 3 — all three are the same low-severity `cookie`/`@sveltejs/kit` advisory the issue flagged as upstream-blocked (current SvelteKit is already the latest release; the vulnerable version range extends through it). Left alone per the issue's own recommendation: wait for upstream, don't force an override, and specifically **do not** run `npm audit fix --force` — it resolves by installing `@sveltejs/kit@0.0.30`, a five-major-version downgrade to a 2021 release.

`vite` (6→8), `typescript` (5→7), `@sveltejs/vite-plugin-svelte` (6→7), `vitest`/`@vitest/coverage-v8` (4→5), and `jsdom` (29→30) are untouched, per the issue's own call to treat those as separate work.

## [1.15.0] — 2026-09-05

### Chore: remove four dead `storage.ts` exports, adopt the fifth (#249)

`readString`, `readArray`, and `readDate` had zero references anywhere in the codebase — not in production code, not in tests — and are deleted. `readDate` looked like a plausible fit for `sq:dismiss-cancel`'s per-provider dismissal dates, but that key stores a `Record<string, string>` of dates under one key, not a single date under its own key, so `readDate`'s shape doesn't actually apply there; the existing inline `new Date(d).getTime()` in `progress.ts`'s `cancelCandidates()` stays as is. `getLoadError` in `services.svelte.ts` is deleted the same way — no caller, ever.

`readBoolean` gets adopted instead of deleted: `app-state.ts`, `settings/+page.svelte`, and `app/+page.svelte` each had their own `localStorage.getItem('sq:cancel-alerts') === 'true'`/`readRaw(...) === 'true'` one-liner for the same key. All three now call `readBoolean('sq:cancel-alerts', false)`, which is behaviorally identical (`JSON.parse` accepts bare `"true"`/`"false"` as valid JSON) but goes through the same validated read path as every other typed preference. The issue also flagged `sq:hints-disabled` as a second overlap candidate, but that key and everything that read it were already removed in #242 — nothing to adopt there.

## [1.14.0] — 2026-09-05

### Perf: lazy-load posters everywhere else, and stop re-walking seasons inside runtime sort (#246)

Follow-up to the partial pass in #246/v1.12.0, which only covered the Add page. `loading="lazy" decoding="async"` is now on every remaining poster `<img>` — the Grid, List, and Gantt queue views, all three density levels of `SharedListSection`, and the public share page — so opening a large queue no longer fires every poster request at once, eagerly, before anything's scrolled into view. The detail panel's own poster and backdrop are deliberately left eager, since they're on-screen the moment the panel opens.

Separately, `remainingRuntime()` — which allocates a `Set` and walks the item's seasons — was being called twice per comparison inside the "sort by runtime" comparator in both `app/+page.svelte` and `SharedListSection.svelte`, for a value that doesn't change during the sort. Both now compute it once per item into a `Map` before sorting (the same decorate-sort-undecorate shape already used for the Group Ranking sort, #229), cutting roughly 2·N·log N calls down to N. Not a fix for a user-visible stall — the honest scale is single-digit milliseconds — just a couple of lines matching a pattern already established elsewhere.

## [1.13.0] — 2026-09-03

### Fix: invite path made you click "Create account" twice (follow-up to #265)

The invite CTA correctly said "Create account" and landed on the Sync section as of #265 — but Settings still opened on its default choose-account-vs-sign-in screen, which for this specific arrival has nothing left to disambiguate: the visitor already told the app what they want by clicking a button that said exactly that. Settings now peeks (not consumes) the pending-invite stash at mount and jumps straight to the signup form when one's found, skipping the redundant middle screen. The actual consuming read still happens later, unchanged, to drive the post-signup redirect back to the invite — peeking must never be what clears that stash, or the redirect would find nothing there. A "Back" link still reaches the normal choose screen for anyone who decides they actually want to sign in to an existing account instead.

### Feature: desktop-only hero backdrop in the detail panel (#133)

`backdrop_path` — TMDB's wide 16:9 image, distinct from the poster — is now fetched, stored, and threaded through sync/export alongside every other TMDB-derived field, and rendered as a banner above the poster+meta row in the detail panel's desktop drawer. Mobile's bottom sheet is untouched (this was tried once before, in v0.4.0, and reverted for eating the mobile layout's tight vertical space — the `sm:`-only gate here is specifically to not repeat that). Existing items pick up a backdrop the next time Settings → Refresh Data runs; no migration needed, same as every other optional field of this kind.

## [1.12.0] — 2026-09-03

### Fix: invite CTA button overlapped its own label, and said the wrong thing (#264, #265)

Two compounding bugs on the exact screen a new user sees first when a friend invites them to a shared list. `Button.svelte`'s link branch rendered as `display: inline` by browser default, which silently drops `width`/vertical-margin and makes vertical padding overflow instead of expanding the line box — the button overlapped the label above it and ignored `w-full` (#264). Separately, the invite page's "Create an account" CTA linked to `/settings#sync`, but no such anchor existed, so visitors landed at the top of Settings — three sections above Sync — and were greeted by a button that said "Enable sync" instead of anything matching what they'd just been told (#265). Fixed the component's display mode (fixes all 4 affected buttons at once), added the missing anchor with an explicit scroll (this page is `ssr=false`, so the native anchor-scroll has nothing to jump to at first paint), and renamed the button to "Create account" to match the form it already leads into.

Also, from a scoped accessibility pass over the same two pages: fixed two `text-gray-400` instances missing their `dark:` pairing (too low contrast in light mode) — the sync-status email line and the invite-expiry line, both now `text-gray-500 dark:text-gray-400` like their neighbors.

### Perf: lazy-load posters on the Add page (#246)

`loading="lazy" decoding="async"` on the search-result grid and suggestions-dropdown posters — the first images a new user's own search populates. Part of the broader "nothing in the app lazy-loads images" finding in #246; the rest (queue views, runtime-sort comparator) is unscoped follow-up.

## [1.11.0] — 2026-09-02

### Fix: search suggestions dropdown had no keyboard navigation (#255)

The Add page's search suggestions declared full combobox/listbox ARIA semantics without implementing the keyboard behavior that comes with them — a screen reader would announce an expanded combobox with options, then leave a keyboard user with no way to reach any of them. `ArrowDown`/`ArrowUp` now move a highlight through the list (wrapping at either end), `Enter` picks the highlighted option and otherwise falls through to a normal search submit, and `Escape` closes the dropdown. `aria-activedescendant` and per-option `aria-selected` now track the real highlight instead of a hardcoded `false`. The existing mouse/click path (and its 150ms blur delay) is unchanged.

## [1.10.0] — 2026-09-02

### Fix: invite revocation was unreachable from the UI (#248)

Revoking an invite link was fully built server-side — endpoint, schema, resolution guard, rejection message — but nothing in the app ever called it, so a leaked or misdirected invite link had no kill switch. The Lists page now lists a shared list's outstanding invites (owner-only), each with a two-tap Revoke, using the same arm/confirm pattern as remove-member and delete-list. Added an E2E test (#253) covering the real path end to end: mint an invite through the UI, revoke it through the UI, then confirm the link is actually dead server-side, not just hidden from the owner's own screen.

## [1.9.0] — 2026-09-02

### Allow the same title queued under multiple lists (#221)

A title can now live in more than one list at once — queue it untagged and add it to as many named lists as you like, instead of the first placement blocking every other one. This is also what makes importing a shared list that overlaps one of your own lists actually add the title, instead of silently skipping it. Behind the scenes: the queue's uniqueness moved from global to per-list (an IndexedDB schema migration), and the sync engine's merge logic was reworked specifically so that an ordinary list move on one device never gets mistaken for a new duplicate on another.

### chore: E2E test infrastructure (#253, scoped)

Added Playwright and one test — two browser contexts on the same synced account, confirming an item added on one shows up on the other — as a regression tripwire for the sync-merge work above. Not part of the required PR checks yet; runs on demand via a manual GitHub Actions workflow until it's proven stable.

## [1.8.0] — 2026-09-02

### Invite-flow copy rewrite (#242, final piece)

Third and final piece of the onboarding redesign. Opening an invite link now leads with an outcome-specific reason to sign up ("Create your account to see {list}") instead of generic "set up sync" copy, with the encryption/privacy explanation tucked into a "Why do I need an account?" disclosure instead of always competing with the button for attention. Landing in an empty personal queue via an invite (or a read-only share link) now leads into the same setup screen the front door does, instead of a bare "search to get started" link.

This closes out #242 — all three pieces (setup screen, hint de-floating, invite-flow copy) have shipped.

## [1.7.0] — 2026-09-02

### Onboarding hints move in-flow (#242, fixes #239)

Second of three pieces from the onboarding redesign — the five floating "hint" pills (nav tabs, Lists, sharing, ranking, sync) are gone, replaced with permanent or state-driven copy living right where each one is relevant: a small dot on the Queue tab for tab-switching gestures, in-flow captions under the queue grid and above a shared list's ballot, a permanent line explaining Read-only vs. Share, and a permanent sync line at the foot of the queue. Nothing to dismiss or time out — most of them just stop being relevant once you've done the thing they were pointing at. Settings' "Show onboarding tips" toggle is gone with them.

## [1.6.0] — 2026-09-02

### Onboarding: combined setup screen (#242)

First of three pieces from the onboarding redesign — replaces the two-step Budget-then-Add first-run flow with a single screen: how much you watch (a slider with a live "~N hours, about N films" preview), what you're paying for (service chips), then the existing search to add your first title. Landing's CTA now reads "Start a queue — No account. Stays in your browser."

Subscribed-services data now actually does something: cancellation alerts only flag a service you've marked as subscribed (not just any thin queue), the Gantt view labels each lane Keep/Start/Cancel, and "What to Subscribe to Next" stops suggesting something you already pay for.

## [1.5.0] — 2026-09-02

### Fix: shared-list full-page view was a frozen duplicate, missing 8 features (#243)

Clicking into a shared list from the Lists page landed on `/lists/[id]`, a separately-maintained copy of the same UI that lives in `SharedListSection` — it had drifted out of sync with every shared-list feature shipped since it was written (notes, item detail view, remove item, ballot drag-reorder, filters, sort, grid/list/compact view modes, the ranking hint). It's now a thin host around `SharedListSection`'s existing `inline` mode, so it inherits everything automatically and can't drift again. Also ported the one feature the old page had and `SharedListSection` didn't — small avatars showing who's watched each item — so both surfaces have it.

### chore: collapse repeated logic scaffolding (#244)

Three independent cleanups, no behavior change: the five IndexedDB item-mutation functions in `db.ts` (mark watched, note, tag, progress, refreshed metadata) shared the same ~22 lines of get→mutate→put boilerplate, now a single helper; the three server routes that fetch a title's providers/runtime from TMDB and assemble the same ~11-field bundle now share one `hydrateMedia()` step instead of independently re-implementing it (each new TMDB field previously had to be added by hand in three places); and the `tmdb_id`+`media_type` identity key the collections/sync merge system runs on, previously defined six times across the codebase, now has one definition.

## [1.4.0] — 2026-09-01

### Drag-and-drop reordering for Rank sort and shared-list ballots (#231)

The personal queue's "Rank" sort and a shared list's ballot panel now support dragging a title into place via a small handle, alongside the existing move up/down buttons — those stay as the accessible fallback, since a screen reader or keyboard-only user shouldn't have to depend on how well a third-party drag library's own keyboard mode works.

### Shared list color synced across devices and members (#237)

A shared list's color used to live only in per-device localStorage — a color picked on one device, or by one member, never reached anyone else's view of the same list. It's now stored on the collection itself and read by everyone; changing it is owner-only, same as renaming a list.

### chore: extract repeated Tailwind class strings app-wide (#194)

Presentational patterns (section headings, body text, dividers, panel labels, input/textarea chrome) collapsed into shared Tailwind utility classes; the app-wide primary-action button became a real component. Purely internal — nothing here should look different.

### Remove redundant per-item "Added by" text on shared list cards (#240)

Follow-up to #236 — once a title's border color (and the ranking panel's legend) already show who added it, repeating that as text on every card was just noise. A hover tooltip on the card keeps it discoverable.

## [1.3.1] — 2026-08-31

### Notes on a title (#155)

Add a free-text note to any item from its detail panel — a small 📝 badge shows on the card wherever one's saved. On a shared list, it's one note for the whole list, editable by the list's owner only (enforced in the UI, not the server — the same trust boundary every other item-level edit on a shared list already has, since the blob is end-to-end encrypted).

### Shared list color: attribution border and bounding border (#236)

The per-item colored border in a shared list now shows who added the title, not which list it's in — every item previously got the same color, which was redundant with the list's own boxed border. Full attribution (email) moved to a legend near the ranking UI and the detail view instead of being spelled out on every row. Separately, the list's own color now colors its bounding border instead of a small dot next to the title.

### Cloudflare Web Analytics beacon allowed through CSP (#233)

The site's Content-Security-Policy was blocking Cloudflare's own Web Analytics beacon script — a pre-existing, unrelated account setting colliding with this app's deliberately strict script-src. Allowed explicitly rather than turned off.

### Gantt bars animate (#46)

Bar widths now transition when the monthly budget changes, plus a subtle draw-in on first render.

## [1.3.0] — 2026-08-30

### IMDb links for cast and director names (#180)

Follow-up to #142, which only linked the title itself. Cast members and a movie's director are now clickable, opening their IMDb person page in a new tab — resolved lazily per click through a new small proxy endpoint, not batch-fetched for every name on every result.

### Search finds titles filed under an alternate name (#200)

Searching "nausica" never returned *Nausicaä of the Valley of the Wind* — it's filed on TMDB under its disowned English dub title, "Warriors of the Wind," and the match only happens through an alternate title, which TMDB's own relevance ranking buried on page 2 despite far higher popularity than anything on page 1. Search now reaches into page 2 when page 1 doesn't already have enough results, ranking those extras by popularity.

### Onboarding hints for sync and ranked voting (#191)

Two features that shipped with no onboarding at all — sync and ranked-choice voting on shared lists (#210) — now get the same brief, dismiss-once nudge the app already uses for Lists and Sharing. A new global "Show onboarding tips" toggle in Settings turns all of them off at once.

## [1.2.0] — 2026-08-30

### Shared lists' Rank sort actually sorts by rank (#229)

Selecting Rank in a shared list's filter menu silently fell through to date-added order — the sort had no branch for it, despite the list's own Group Ranking sitting right above the same picker. Rank now orders by that tally's score, with unranked titles trailing in date-added order.

### Search by actor or director (#62)

The Add page only ever matched titles — searching a name like "Denzel Washington" or "Greta Gerwig" returned nothing. Search now also checks TMDB's person index alongside titles; a confident match surfaces their titles in their own "Titles with {name}" section, hydrated through the same provider/runtime pipeline as any other result.

### Live search suggestions (#63)

A debounced autocomplete dropdown now appears as you type in the Add page's search box, instead of waiting for Enter — a cheap, title/poster/year-only lookup, not the full hydrated search.

## [1.1.0] — 2026-08-30

### Detail panel showed date-added instead of release year (#224)

`WatchlistItem` never carried a release year — only the Add/search page's result type computed one, and it was dropped when a title was added to the queue. The detail panel's year fallback then reached for `added_at`, which read as "everything's from 2026" for older titles in shared lists. Items now carry a real `year`, threaded through at add-time and validated for sync/collection round-trips; the `added_at` fallback is gone. Items already in a queue won't show a year until re-added or (in a future pass) backfilled via "Refresh provider data."

### Shared-list links show the actual list in previews (#219)

Pasting an invite link or a shared-list link into a chat app showed generic "Queuest" branding instead of the list itself. Invite links (`/lists/join/[token]`) now preview the real list name and who sent it; `/lists/[id]` shows a generic-but-relevant "Shared list on Queuest" preview instead, since its contents are end-to-end encrypted and there's no way to resolve a name for an arbitrary id without an account.

### Subscribed services get their own onboarding moment (#227)

Subscribed Services already sat before "Add titles" in the onboarding sequence but read as an incidental section rather than a deliberate step. It now explains why it's worth setting up first — so Suggest and the "not subscribed" indicators are useful from the very first title added, instead of being a surprise later.

## [1.0.0] — 2026-08-28

### Ranked-choice voting on shared lists (#210)

Members can rank up to 5 titles per shared list — a "Rankings" panel shows your own ballot (add, remove, reorder) alongside the group's combined pick order, aggregated by Borda count (5 points for a 1st choice down to 1 for 5th, summed across everyone who's ranked). A rank toggle sits on every shared-item card, in the detail panel, and on the `/lists/[id]` page. Ranking is independent of watched status, and a title removed from the list just drops quietly out of the tally rather than needing anyone to clean up their ballot.

## [0.9.9] — 2026-08-28

### Shared-import duplicates say where they already are (#212)

Importing a shared list silently skipped titles already queued under a different list, reporting only a bare count. Skips now name the list — "2 in Horror October, 1 in your Queue" instead of "3 already in queue."

### Custom "Rank" sort for the main queue (#216)

A new sort mode alongside Recent/A–Z/Runtime: drag-free move up/down controls for arranging your queue in whatever order you want. Persists locally and syncs across devices like everything else in the queue. Suppressed when grouped by collection, since reordering across alphabetical sections isn't a defined operation.

## [0.9.8] — 2026-08-28

### Shared-list posters load again (#213)

`/lists/[id]` and the Queue shared-list section were building poster URLs without a size segment — `${TMDB_IMG}${poster_path}` instead of `${TMDB_IMG}/w92${poster_path}` — so every thumbnail 404'd. Fixed in both places.

### Owners can remove titles from a shared list (#214)

Queue's shared-list section had no way to remove a title short of leaving the whole list. Owners now get a remove control (two-tap arm/confirm, matching the pattern used elsewhere) in every view — grid, list, compact, and the detail panel. This is UI-only gating: the server can't see inside an encrypted blob to tell a removal from any other write, so real enforcement would need the blob itself to be readable server-side, which would defeat the point of encrypting it.

### Invite links survive the "set up sync first" detour (#215)

A logged-out visitor opening an invite link got sent to Settings to turn on sync, which lost the invite token and DEK entirely — neither survives that trip since the fragment never reaches the server to begin with. The invite is now stashed in sessionStorage before the redirect and picked back up once sync finishes, so accepting the invite continues automatically instead of leaving the visitor to find the original link again.

## [0.9.7] — 2026-08-20

### Renaming or deleting a list no longer leaves a phantom behind (#207)

Both actions wrote the color change to localStorage, then refreshed component state by re-spreading the *already-stale* in-memory copy instead of re-reading it — so the old name lingered as an empty phantom list until a reload forced a fresh read. Fixed to read back from `getQueueColors()` after the write, same as everywhere else in the file already does.

### Promoting a list to shared keeps its color (#209)

Promotion deletes the personal color entry (needed so the old name doesn't linger the same way #207 did), but never carried the color to the shared side — the new shared list always got a fresh color hashed from its id. Now captured before deletion and seeded into the shared list's color instead.

### Shared-list links say "lists", not "collections" (#208)

The Collections → Lists rename (v0.9.4) skipped API routes and internal types on purpose — nobody sees those. It should have caught invite links, which people actually paste and send to each other: `/collections/join/[token]` is now `/lists/join/[token]`, and `/collections/[id]` is `/lists/[id]`. Old links still work — both are 301 redirects, not deletions, so anything already shared keeps resolving.

## [0.9.6] — 2026-08-20

### Shared lists get grid/list view parity with the personal queue

A shared list's section in Queue always rendered as its own compact-card style, regardless of whether the personal queue was in Grid or List mode — a visibly different UI bolted onto the side of the real one. Grid mode now renders shared items as poster cards and List mode as rows, mirroring `QueueGridView`/`QueueListView`'s markup directly (duplicated rather than reused: those components key busy-state, selection, and flip animation off `WatchlistItem`'s numeric local `id`, and a `CollectionItem`'s identity is `tmdb_id`+`media_type` — retrofitting a second identity scheme into them was the riskier path). Clicking a shared item now opens the same detail panel personal items use, given a synthetic negative id (never persisted) so the panel's internal id-keyed state can't collide with real queue items. Season-level toggling and select-mode still aren't offered for shared items — neither is wired up yet. Lanes/Gantt view, which has no shared-list analog, keeps the original compact-card fallback.

### Shared lists reachable from the filter picker (#205)

Shared lists lived only in a collapsed section below the *entire* personal queue — reaching one meant scrolling past everything you own first, with no way to say "just show me this shared list" the way you already could for a personal one. The filter picker's List section now lists shared lists as peers of personal ones (`shared:<id>` form, the same convention the detail panel and bulk-assign pickers already use). Picking one fills the main view — the same slot the personal queue occupies — with its own title-count/remaining-time summary, instead of appearing as a section you have to visit separately. The below-queue browse section is unchanged for the "All" state and now quietly excludes whichever list is already filling the main view, so it doesn't show up twice on screen.

Three non-obvious pieces this needed: the stale-filter-clearing effect only ever validated a filter against personal collection names, so a `shared:` filter would have been wiped the instant it was set — it now skips shared filters entirely rather than trying to validate them against a list that loads asynchronously after mount. Select mode has no shared-list analog (bulk actions operate on personal `WatchlistItem`s by local id), so it force-exits and the Select button hides under a shared filter. And switching between two different shared filters reuses the same component instance unless keyed, which would otherwise keep silently serving the previous list's already-loaded items — wrapped in `{#key}` to force a remount per collection id.

### "+ Add to Queue" gets a direct-to-list caret

Adding a title to a specific list meant adding it untagged first, then opening the detail panel or bulk-select just to assign it — an extra round trip for something the list-assignment picker already made a one-step action everywhere else. A small caret next to "+ Add to Queue" opens a popover — Queue, then personal Lists, then Shared — so a search result can land directly in a list without the detour, while the single-tap default stays exactly as fast as it was. Landing an item in a shared list from here does the local add, then immediately hands it to the same shared-collection push `promoteCollection` and the Queue picker use, so a failure partway through leaves the title sitting in the personal queue rather than losing it.

The split button and its popover are their own component (`AddToListButton.svelte`, self-contained — owns its open/closed state and document-click dismissal) so the same interaction could be dropped into the Import panel's three flows too, not just single-item search adds, without quadruplicating the markup.

### Import panel: instructions paired with the input that handles them

The Letterboxd and IMDb instructions lived in their own section, separated by a divider from a generic "Upload CSV" section below that actually handled both — reading how to export and finding the matching input meant scrolling past unrelated content. File upload now sits directly under the Letterboxd instructions and link-paste directly under IMDb's, each with its own "Found N titles" readout and its own Add button (two buttons where there used to be one shared button, deliberately — each import source is a self-contained flow now, not two entry points feeding one shared result). All three import flows (Letterboxd, IMDb, paste-a-list) get the same "Add To" caret as search results, including bulk pushes to a shared list: every newly-added row from an import is collected and pushed to the shared collection in one call at the end, not one round trip per title. The heading changed from "Import from Letterboxd, IMDb, or a backup" to **"Import from list or Queuest Backup"**, and the paste-a-list copy now says plainly that Markdown/Obsidian syntax (bullets, numbers, checkboxes, wiki-links) is stripped automatically — the parser already did this, the copy just never said so.

## [0.9.5] — 2026-08-20

### Nav-switching hint moved to the Add page

The one-time "Alt+←→ / swipe to switch tabs" nudge showed on the Queue page once it had items — but by then, the user had already navigated there by tapping the nav link once, with no idea the gesture existed. Moved to the Add page, triggered right after the first successful add: the moment right before someone would naturally want to go check their Queue, which is exactly when telling them they can swipe there actually lands.

### README brought current

Hadn't caught up with anything from #145 onward — the entire collaborative Lists feature (shared lists, per-member wrapped keys, invite links, QR codes, activity badges, key rotation on member removal) was undocumented, "Collections" was renamed to "Lists" nowhere in the doc, and the "Encrypted share links" feature description was for the old filtered-multi-provider `/share` page that no longer exists. Rewrote the relevant sections: a new "Watch something together" step in How It Works, corrected Features bullets (Shared lists, Read-only links, bulk-assign, list colors throughout), a Known Limitations note that shared lists need accounts on both sides, and the Crypto stack row now mentions RSA-OAEP alongside AES-GCM/PBKDF2. Screenshots weren't regenerated — `docs/screenshots/landing-hero.png` still shows the old "Collections" copy.

### Logo click reaches the landing page again (#196)

The landing page redirected to `/app` whenever a `sq:welcomed` flag was set — correct for a typed URL or bookmark, but the logo link shares that same `/` target and inherited the redirect, so clicking it just bounced straight back out. Fixed with SvelteKit's `afterNavigate`, which reports *how* a navigation happened: `'enter'` is a genuine cold load, an in-app link click is `'link'`. Only a cold load redirects now. The redirect condition itself moved into a small tested function (`lib/landing.ts`) — the bug was exactly the kind that's easy to reintroduce silently in a `.svelte` lifecycle hook, and this repo has no component-testing harness to catch that at the markup layer otherwise.

The old `?preview` escape hatch is renamed **`?landing`** — clearer about what it does now that it has a real purpose again (previewing the page while welcomed) rather than being the only way in at all.

### Landing-page CTAs adapt to returning visitors

Now that the landing page is reachable again, a welcomed visitor saw "Start your queue" / "Get started" everywhere — onboarding language aimed at someone with no queue yet. All three CTAs (hero, bottom section, footer) now swap to **"Back to Queue"**, linking straight to `/app`, when the same welcomed flag is set.

### Two more onboarding nudges

- **Group into a list** — once someone has a handful of titles queued and hasn't made a list yet, a one-time tip on the Queue page points at Select-to-assign or the Lists page. Deliberately not shown alongside the nav-switching hint above — two unrelated tips stacked on the same moment defeats the point of either.
- **Read-only vs. Share** — the first time someone has a personal list with sync on, a tip on the Lists page spells out the distinction the two adjacently-labeled buttons don't make obvious on their own: *"Read-only sends the list as-is — Share lets others collaborate on it with you."* Only shown with sync on, since Share isn't an available option without it.

Both follow the same one-time, auto-dismissing, localStorage-gated pattern as the existing nav-switching hint, and their dismiss keys are registered in `app-state.ts`'s synced/local key partition (now 17 keys, guarded by an existing test that scans the source tree for any `sq:` key not accounted for).

### QR code for read-only links

The **QR code** option that invite links already had — generated on demand, same toggle-to-show/hide button — is now available on read-only links too, right next to Copy. Same underlying `toQrSvg`, same "only load the encoder if someone actually asks for a code" behavior.

### Read-only link for your whole queue

Sharing without an account required a list first — real friction for the most natural first share, "check out my queue," which happens before anyone's bothered organizing anything. A new **"Or share your whole queue as a read-only link"** action on the Lists page generates one unfiltered snapshot of everything, same mechanism (Copy, QR code, 30-day expiry) as the per-list links, titled with the account's own queue name since no single list is selected. Deliberately no filter UI — the old standalone `/share` page's status/type/provider filters are gone on purpose; one unfiltered snapshot is a much smaller surface than that page was.

Moved below the list rows, right before the divider into Shared Lists, and styled as a distinct dashed-border box rather than a thin underlined text link — both to stop it competing with Create for first attention and to put real distance between it and the nearest list row's own tap targets on mobile.

### List rows breathe: two lines instead of one

Each list's name, count, color swatch, and four action buttons (Share, Read-only link, Rename, Delete) were packed into a single horizontal line — the reason names were truncating to "Trilogy …" in a 375px-wide row, and exactly the kind of cramped adjacent-button spacing that causes mis-taps on mobile. Split into two lines within the same card: color + full name + count on top, actions on their own row below with `flex-wrap` so they drop to a third line rather than overflow on narrow screens. The color control itself moved from a plain decorative dot into the actual color-picker swatch — one interactive control living with the name, instead of a redundant static dot up top and a separate bigger clickable swatch buried in the actions row.

Shared Lists got the same two-line treatment: name (+ activity badge) with the ownership label ("You own this" / "Member") right-justified on the same line, actions on their own row below.

### Color and rename for shared lists

Shared lists previously had no color at all, and no way to change the name an owner picked at creation. Both now work the same way personal lists do:

- **Color** — auto-assigned per list on first view (same hashing scheme as personal lists) and changeable from the same swatch-on-the-name-line control. Deliberately its own local, per-device storage bucket, not the personal-list color map keyed by name — reusing that one keyed by a shared list's `id` briefly leaked ids in as phantom empty personal lists (the *first* version of this shipped that bug; fixed before it left this branch). Not synced across devices yet, and not visible to other collaborators — it's your own view, like the personal-list palette used to be before sync existed for it.
- **Rename** — owner-only, enforced server-side (`PATCH /api/collections/[id]`) since the name is plaintext every member and an invite's unauthenticated preview can see, not a personal preference. Same inline edit-in-place UX as personal lists.

## [0.9.4] — 2026-08-20

### Bulk assign to a collection (#113)

Selection mode for the queue: a **Select** toggle in Grid and List views turns each card/row into a checkbox, and a bulk action bar appears with Assign to collection, Clear collection, Mark watched/unwatched, and Remove (with the same confirm-before-destructive pattern as other delete actions in the app). Filing fifty titles into a collection one at a time was real friction — this is that gone. Not wired into the Gantt/timeline view, which doesn't have an obvious multi-select affordance; switching to it exits selection mode.

### QR code for invite links (#147)

Collection invite links in Settings now have a **QR code** option alongside Copy — generated entirely client-side from the same URL, DEK-in-fragment included, so scanning lands on the identical confirm-before-joining screen as the copied link. Useful for the "we're both here right now" case. First runtime dependency the app has ever taken on (`qrcode`, MIT, zero transitive deps of its own).

### "What's new" activity badges on shared collections (#148)

Reopening Settings now shows a small **"N new"** badge on any shared collection with activity since you last opened it — titles added or watch marks flipped by other members. Opening the collection shows the same signal per-item, then clears the badge for next time. Purely client-side: a per-account, per-device "last viewed" watermark compared against timestamps the sync engine already carries, no server changes.

### Read-only links replace the standalone Share page

The old **`/share`** page — a full nav-level route with its own filter UI (status, type, per-collection, per-provider) — was easy to mistake for the new collaborative Collections "Share" action, and disproportionately large for what it does: mint a disposable, no-account-needed snapshot link. It's now a **"Read-only link"** action on each personal list, right next to "Share": one click, no filters (the list is the filter), with copy text explicit about the difference — *"no account needed... their view won't update... for an ongoing, two-way list instead, use Share."* The recipient-facing `/share/[token]` page, the underlying `/api/share` endpoint, and the encrypted-snapshot mechanism are all unchanged — only the creation surface moved.

### Collections move out of Settings, and become Lists

Decided mid-sprint, after the above landed and it became clear Settings had quietly grown into two different things: account/app preferences, and the app's most interactive surface (create/rename/color/share/invite/QR/remove-member, two live decrypt-and-diff badges) buried three sections down. Personal collections and Shared Collections both move to a new **`/lists`** route, with its own **Lists** nav item — same interactive footing as Queue, not a Settings subsection. Also renamed **Collections → Lists** everywhere it's user-visible (headings, buttons, tooltips, the detail panel's list picker, the Gantt grouping toggle, the landing page card) to stop it colliding with the "Share" language Collections itself uses. This is presentation-only — `collection` stays the name for the underlying data model, API routes, and types (`CollectionItem`, `/api/collections/*`, the D1 schema); renaming those would touch the crypto/sync layer for no user-facing benefit. Nav is now Budget · Add · Queue · Lists · Settings.

### "My Queue" name moves into Export Watchlist

Its only remaining real use was the exported backup file's embedded queue name — the other use, naming a multi-list share bundle, went away when read-only links became single-list-scoped above, and nothing else in the app ever displayed it. Rather than keep a whole Settings section open for one field with a now-inaccurate description ("appears when you share your list with others" — it doesn't, sharing is per-list now), the name field moved into Export Watchlist, editable right before Download. That section's copy also now says plainly that shared lists aren't included in the export — they live only in the cloud, via sync, and never touch local IndexedDB.

## [0.9.3] — 2026-08-20

### Shared collections are viewable and usable (#145)

v0.9.2 let a collection be promoted to shared, but nothing could see what was in it afterward — Settings said "Members coming soon in queue view," and promoting a collection meant its titles vanished from the only place that rendered them. This closes that gap:

- **New `/collections/[id]` view.** Poster, title, runtime, who added it, and a per-account "Mark watched" toggle with small avatar badges showing who's watched it — reading and writing the same `watch` map the collection blob already stores.
- **`Open` on every shared collection in Settings** links straight there.
- **The Info panel now actually lists members**, with email and role. It previously rendered a remove-confirmation dialog with no way to trigger it — `removingMember` was set nowhere in the component, so member removal was unreachable dead code since v0.9.0. Owners can now remove a member from the list directly, which drives the existing key-rotation flow.

### Fixed

- Watching-status round-trips correctly through the version-precondition PUT/409 cycle (`toggleCollectionWatched`), touching only the toggling account's own entry in the per-member watch map — verified in dev that marking watched, then unwatched, doesn't disturb another member's mark.

## [0.9.2] — 2026-08-20

### Shared collections start by promoting a personal one (#145)

v0.9.0 shipped shared collections with their own "New shared collection…" form, which left Settings with two unrelated sections both called Collections — the naming collision #145 flagged and asked to resolve. Promotion is now the only way a shared collection comes into existence:

- **`Share` on any personal collection** promotes it. A confirmation names the collection, counts the titles, and says plainly what the move costs: the titles leave this queue, live online from then on, and are **gone for good if you lose both your passphrase and your recovery code**. Shared collections are server-held and reachable only through this account's keys, so that is worth saying out loud rather than burying.
- **The titles genuinely move.** They are seeded into the collection blob and then tombstoned locally, so the shared copy is the single source of truth and each member's progress lives in the per-account `watch` map instead of a personal `watched_at`. A watched title carries across as the promoter's own watch mark, and every item records who added it.
- **The blob is written before anything is deleted.** A failure at any step — network, auth, a rejected push — leaves the personal collection exactly as it was; the tests cover that path specifically.
- **The standalone create form is gone**, and the promoted name no longer lingers in the personal list: an empty collection exists only as a palette entry, so promotion clears that too. Without it the same name showed in both sections, which is the duplication this change exists to end.

### Fixed

- **Invite-link errors surface next to the invite.** They were being written into the create form's error state, so a failed invite rendered its message in a different section of the page — and became invisible entirely once that form was removed.

## [0.9.1] — 2026-08-20

### Fixed

- **`npm run lint` is green again on main.** The v0.9.0 Settings markup (#197) was assembled with scripted edits whose output did not match Prettier, and the PR was merged over the resulting red CI check by mistake. Formatting only — no behavior change.

## [0.9.0] — 2026-08-20

### Shared Collections: complete Settings UI (#189)

The full settings management for end-to-end encrypted collaborative collections:
- **Create collections:** New form in Settings, server generates collection ID
- **Generate invite links:** Secure design with DEK in URL fragment, never in request body
- **Invite members:** Single-use tokens with preview (unauthenticated), expiry, and revocation
- **List members:** Shows role (owner/member) and public keys (required for key rotation)
- **Remove members:** Atomic rotation on removal — new DEK generation, blob re-encryption, per-member key wrapping, invite revocation in one batch
- **Role-based access:** Reads ungated (read-only fallback), creates gated on entitlement

All operations backed by server-side authorization (membership-based, indistinguishable 404 for non-members), collection blob versioning with jittered exponential backoff on conflicts, and per-account watch merge to prevent one member's mark from clobbering another's.

Verified end-to-end: create → invite → join → remove/rotate flow works locally. All 488 tests passing.
## [0.8.5] — 2026-08-20

### Corrected inaccurate privacy claims

Encrypted sync (#79) shipped in v0.8.0, but the landing page and README still described a product with no accounts and no server. Four places said so outright and were plainly wrong for anyone who had turned sync on:

- The landing page's "Private by design" card claimed *"No account, no login… Nothing personal ever touches our servers."*
- The README's Data & Privacy section led with *"No user accounts"* and *"never leaves your device unless you export it."*
- The README's "Your data, your device" step said *"no account, no server, no tracking."*
- The Stack table described storage as *"IndexedDB (client-side, no server DB)"*.

All four now describe what actually happens: no account is required and the app works fully signed-out, but sync is an opt-in account whose data is encrypted client-side before it is sent, leaving the server holding ciphertext it cannot read. That property is a stronger claim than the one it replaces, and it has the advantage of being true. (#192)

### Landing page and README refresh

- **The landing page now mentions sync and Collections at all** — both shipped features were entirely absent, and sync in particular is the app's clearest differentiator. Two new feature cards ("Group it into Collections", "Sync, without us reading it"), and the hero's trust line gains *End-to-end encrypted*. Collaborative Collections (#145) is deliberately not advertised — it hasn't shipped. (#192)
- **README Features restructured** from a flat 19-item list into five groups, so the things that distinguish this app lead instead of sitting level with dark mode. Adds end-to-end encrypted sync, recovery codes, Collections, Gantt group-by-collection, and IMDb links. (#192)

### Landing page maintenance

Scoped down from the original #131 after establishing that `.design-sync/design-reference.md` was one-time scaffolding rather than a governing spec — the current visual style is the approved one, so the "drift from the reference" findings were dropped and only genuine maintenance issues were fixed. All changes below are visually identical except where noted.

- **The product mock is data-driven.** Its three tabs hand-wrote their own near-identical lanes, rows, and cards — two list rows and two cards were near-copies *within the mock itself*, and had already drifted from each other. All three tabs now render from two shared arrays, so List and Grid can't disagree about the same title. (Using the real `QueueGridView`/`QueueListView`/`QueueGanttView` components was considered and rejected: they need real `WatchlistItem`s, live handlers, and TMDB image loads, none of which belong on a marketing page.) (#131)
- **The mock no longer hardcodes the monthly budget.** `40h / mo` appeared twice in the landing markup and again as a literal default in two route files. New shared `DEFAULT_BUDGET_HOURS` constant, so the marketing copy can't silently disagree with the app. (#131)
- **`.mock-float` no longer warns on every build** — it was applied through a ternary the compiler couldn't see statically, so Svelte reported it as an unused selector. Now a `class:` directive. (#131)
- **The two file inputs in the import panel share one class string** instead of a 274-character string copied verbatim in two places. (#131)
- **The Budget page's number inputs match the ones in the queue's budget callout** — the two were near-copies differing in three utilities, giving the same control two looks. The queue page's geometry wins (`w-14`, `px-2 py-1.5`, `bg-white`); the Budget page keeps its neutral resting ring, since the orange ring belongs to the callout's theming rather than to the control. This one is a deliberate visual change. (#131)

### UI cleanup

- **Removed the redundant "About Queuest" button from Settings** — clicking the logo already takes you to the landing page, making the About button unnecessary. GitHub link and feedback button remain.

### Bug fixes

- **The landing page returned 500 in local development.** `adapter-cloudflare` installs a throwing getter on every `platform.env` key for prerenderable routes, and `/` is prerendered — so *reading* `SHARE_KV` threw rather than returning undefined. The existing guard covered the build's static-generation pass (`building`) but not `vite dev`, where `building` is false and the same getters are installed. Production was unaffected, which is why it went unnoticed. Found while trying to view the landing page work above.

---

## [0.8.4] — 2026-08-20

### Features

- **Gantt lanes can group by collection, not just provider** — a new "Group lanes by" control in the queue dock (Timeline view) switches the Gantt view's axis between provider (the default — what the budget feature is built around) and collection. Collection lanes take their color from the user's chosen collection color rather than a provider brand hue, via a new `hexToHue()` conversion, and render a color swatch dot in place of a provider logo in the lane header. An "Uncategorized" terminal lane, pinned last, mirrors the existing "Not Streaming" lane in provider mode. Closes out the `#59` Collections epic. (#112)

### UI cleanup

- **Removed the redundant per-card Collection chip from Grid and List** — every card already carries a colored left-border strip indicating its collection; the colored text chip next to the media-type icon said the same thing a second time, crowding the row. The border stays as the sole per-card indicator. (#185)

---

## [0.8.3] — 2026-08-20

### Bug fixes

- **GitHub repo rename cleanup** — the feedback button's `REPO` constant and the Settings → About link still pointed at the old `zenfinity/streamq` slug after the repo was renamed to `queuest`; a fresh fine-grained PAT scoped to the new repo could fail against the stale path. Updated both, plus two stale issue links in the README. `src/lib/db.ts`'s `DB_NAME` (the client-side IndexedDB database name already live in every user's browser) was deliberately left alone. (#39)
- **Inline queue dock (lg+) overflowed the nav bar** — the dock's outer wrapper carried a `pt-2` meant for its floating (mobile) placement, but was applied to the inline nav placement too, on top of a parent that already vertically centers it (`self-center`). Pushed the dock to 49px tall inside a fixed 40px nav. Only apply the padding in the floating case. (#183)

### UI cleanup

- **Removed the redundant Collection chip in the detail panel** — the colored chip duplicated what the dropdown right next to it already showed. Dropdown alone remains. (#182)
- **Filtering the queue to one collection now names it** — the summary line above the queue now reads e.g. "Weekend Watch · 2 titles · ~2h 40m remaining" instead of just the count, matching the level of detail already shown per-section when grouping by collection. (#182)

---

## [0.8.2] — 2026-08-19

### Bug fixes

- **Duplicate service chips on Apple TV+ titles** (e.g. Ted Lasso showing both Amazon Prime Video and Apple TV) — JustWatch/TMDB sometimes lists Apple TV+ native content under a plain, non-"Channel"-suffixed "Amazon Prime Video" entry that the existing bundle-name filter can't catch by name alone. `augmentProviders()` now strips it (and its tier variants, e.g. "with Ads") using the same network-id disambiguation already used for the Disney+/Hulu pair. Also fixed a bug in the same function where the final fallback branch used the raw, unfiltered provider list instead of the one with bundle-name filtering already applied. (#179)

### Features

- **IMDb link on the detail panel** — a title's TMDB `external_ids` (fetched alongside the existing per-title request, no extra API call) now surfaces a "View on IMDb ↗" link. Cast/crew person-level linking is a larger follow-up (new endpoint, lazy resolution, caching) tracked separately. (#142)

### Testing & tooling

- **Vitest now supports component and rune-store tests** — added `jsdom`, the Svelte plugin (via the shared Vite config), and `@vitest/coverage-v8`; widened `include` to pick up `.svelte.test.ts`; added a `test:coverage` script. `.svelte` files can now actually be imported and mounted in a test for the first time. (#128)
- **Test-quality pass** across the suite: fixed a test whose name claimed prototype-pollution safety but never exercised it (added real `__proto__`/`constructor`/`prototype`-key tests to both `share-schema.test.ts` and `app-state.test.ts`); fixed two `toggleSeasonProgress` tests that asserted "and reloads" without checking anything reloaded; replaced a couple of wall-clock-dependent, loosely-`toContain`-asserted date tests in `progress.test.ts` with `vi.setSystemTime` and exact string matches; added missing edge-case coverage (movie theatrical/streaming-estimate branches, the `cancelCandidates` malformed-dismissed-date fail-open path, `patchProviders` persistence, truncated-buffer rejection in `crypto.ts`, share-schema clamping/validation edge cases); deduplicated three copy-pasted `makeItem` test fixtures into `src/lib/test-fixtures.ts`. (#129)

### Docs

- **README** — added Import, Collections (renamed from "Named queues" to match current terminology), the queue dock, cancellation alerts, and guided onboarding to the Features list; corrected the stale "importing watchlists is planned" line (import shipped in v0.5.2). **CHANGELOG** — backfilled the missing 0.4.2 entry; corrected the v0.5.3 entry's claim that the extracted `*-actions.ts` modules were wired in and tested at that point (they weren't — #92/#94 did that separately). Removed the stale `docs/screenshots/README.md` placeholder now that the real screenshots have long since been added. (#132)

---

## [0.8.1] — 2026-08-19

### Bug fixes

- **Sync sign-up failed on first attempt** — production D1 never had the `0001_sync_schema.sql`/`0002_recovery_auth.sql` migrations applied, so the `users` table (and everything else sync needs) didn't exist server-side. Applied both migrations to production. Also hardened `signUp()`: if account creation succeeds but the follow-up recovery-code request fails, the error now says so explicitly and points at signing in, instead of a generic message that invited a retry into a confusing 409 against the account that was just created. (#175)
- **`Alt+←/→` tab-nav shortcut didn't work on the Add tab** — the search input there had `autofocus`, and the shortcut deliberately skips firing while focus is in a text field (so it doesn't fight the OS/Firefox's own Option+Arrow word-jump). Removing `autofocus` was enough — Queue and Share never had this problem because neither auto-focuses a field. (#174)

### Collections UX

- **"Change…" in the detail panel replaced with a dropdown** — select an existing collection, "None", or "Manage collections…" (jumps to Settings). The old free-text "type a new name" flow was also the last place in the app that could create a new collection, and separately had a bug where clicking Change… would just close the whole panel; both are gone with this rework rather than debugged, since the dropdown has no open/close picker state left to interact badly with the panel's outside-click handling. (#176)
- **Collections can now be created from Settings** — a "+ New collection" field creates an empty collection (0 items) that immediately shows up in the detail panel dropdown, restoring the creation path removed above. Collections aren't a stored entity of their own; an empty one exists via a color-palette entry until an item is tagged with it. The Collections section also has a stable anchor (`/settings#collections`) so the dropdown's "Manage collections…" lands in the right place. (#177)

---

## [0.8.0] — 2026-08-13

### Sync epic — key custody, recovery, and settings UI (#79 milestone complete)

- **Key custody and recovery** — a printed high-entropy recovery code (120 bits, Crockford base32, grouped for readability) stands in for a forgotten passphrase. It's a second wrapped copy of the same DEK (`wrapped_dek`, `method='recovery'`), generated and shown once immediately after signup, before the DEK is ever imported as a non-extractable CryptoKey. New `recovery_auth` table (migration `0002`, additive only — passphrase signin is untouched) plus four routes: `POST /api/auth/recovery-code` (store it), `POST /api/auth/recover` (the actual recovery signin — a fully independent credential check, same constant-time-compare/dummy-hash pattern as normal signin), `PUT /api/auth/passphrase` (required to finish recovery — the old passphrase no longer works once a code has been used), and `DELETE /api/account` (removes the sync blob, both wrapped-DEK rows, the recovery credential, and the user row; never touches local IndexedDB). (#102)
- **Sync settings UI** — a new Sync section in Settings, next to Export Watchlist: enable/sign-in/recover/sign-out flows, the mandatory "save your recovery code" screen, a status indicator (synced/syncing/offline/error) with last-synced time and a manual "Sync now", and account deletion in the Danger Zone using the same arm/confirm pattern as "Reset everything." Ships labeled "Free during beta" from day one. This is the point sync goes from built-but-inert to actually usable — #100/#101 (server API and client engine) had no UI to enable them until now. (#103)

---

## [0.7.2] — 2026-08-13

### Accessibility

- **Cards and rows no longer nest interactive elements inside `role="button"`** — the Grid/List queue-item wrappers were `role="button"` divs containing four more real `<button>`s, which meant a screen reader announced the whole card as one button and swallowed the title, runtime, providers, and release chip inside it. Each card/row already has a real focusable trigger (the poster/title button) doing the same "open detail" action, so the wrapper just needed its role/tabindex/aria-label/keydown handling removed. (#130)
- **Keyboard-closable overlays** — new `use:trapFocus` action (`src/lib/focus-trap.ts`) provides Escape-to-close, a Tab focus trap, and focus return to whatever triggered the overlay. Wired into the detail panel, its poster lightbox, and the Settings feedback modal — the only three overlay components left after #119's earlier DetailPanel consolidation. (#130)
- **Toggles no longer convey state by color alone** — `aria-pressed` on subscribed-service and Share filter pills, `role="switch" aria-checked` on the Watched toggle, `aria-expanded`/`aria-controls` on the filter popover button. (#130)
- **17 unlabeled form controls** now have `aria-label` — Settings' queue name/rename/color/passphrase/feedback fields, the import panel's restore/CSV/URL/paste-list fields, and the Budget hrs/weeks number inputs, which previously had no placeholder either. (#130)
- **A real `h1` on every route** — added as visually-hidden (`sr-only`) so there's no visual change; most routes previously started at `h2`, and `/app` had no heading at all. (#130)
- **Gantt bars now show a focus ring** — `focus:outline-none` had no replacement; keyboard users tabbing through the timeline saw nothing. (#130)

### Bug fixes

- **Collection "Change…" did nothing** — the detail panel's per-item reset effect tracked `item.id`, but Svelte reruns an effect whenever a *prop* it reads is reassigned, including to a new object with an unchanged id — exactly what happens after every successful collection change. Fixed by tracking the last-seen id explicitly. Also hardened all three collection-change call sites with try/finally, so a failed request can no longer leave every collection button in the panel permanently disabled. (#171)
- **Anchor-scroll to `#suggest` didn't work** — `/budget` is `ssr = false`, so the section didn't exist in the DOM yet when the browser's native fragment-scroll fired at initial load. New reusable `scrollToHashTarget()` (`src/lib/scroll-to-hash.ts`) is called once the section's data has actually loaded. (#161)

### Feature polish

- **Budget-aware framing for Suggest** — each ranked provider now shows "≈N months of your budget" alongside the existing runtime total. (#160)
- **`Alt+←/→` keyboard shortcut** — the desktop equivalent of #162's swipe navigation, same order and boundary behavior, sharing one `stepTab()` helper with the swipe handler. (#168)
- **One-time onboarding hint** pointing at swipe/keyboard tab navigation, shown once the queue actually has something in it; text adapts to touch vs. desktop and persists its own dismissal. (#169)
- **Collection group headers show a remaining-time total** — e.g. "Sci-Fi 3 · 4h 12m" — next to the existing item count, in both Grid and List. (#170)

---

## [0.7.1] — 2026-08-12

### UI polish

- **Swipe navigation** — a horizontal swipe on the page body now moves between Budget/Add/Queue/Share, in nav order. Guarded against false positives (minimum travel distance, vertical-drag rejection, a time limit, and explicit ignores for the detail panel's horizontally-scrolling cast list and the floating filter dock) and inert on `/settings`, `/search`, and the landing page. The existing folder-tab curve now animates (`transition: d`) between tabs on every navigation, click or swipe, to sell "the tab is moving." (#162)
- **Favicon Q centered** — was positioned by text baseline (`y='60'` in a 100-height viewBox), which sat visibly low in the browser tab; now uses `dominant-baseline='central'`. (#166)

---

## [0.7] — 2026-08-12

### Sync epic — server & client (#100, #101)

- **Encrypted blob API** (`GET`/`PUT /api/sync/blob`), following `api/share`'s opaque-bytes precedent but adding what a share link doesn't need: ownership, an update path, and concurrency control. A single `INSERT ... ON CONFLICT DO UPDATE ... WHERE version = ? RETURNING version` does the whole compare-and-swap in one round trip — a version mismatch returns no row, which is the 409 signal for the client to re-fetch, re-merge, and retry. 2 MB cap, per-user KV-backed rate limiting, and an entitlement seam on `PUT` only (`GET` always stays open — a lapsed subscription must never look indistinguishable from data loss).
- **Client sync engine** (`src/lib/sync.ts`) — the DEK is held as a non-extractable `CryptoKey` (structured-cloned into IndexedDB, raw bytes never touch JS after import). Merge is keyed by `[tmdb_id, media_type]`, field-group rather than whole-item last-write-wins: whichever side has the newer `updated_at` wins every field except `watched_seasons`, which unions — so device A marking something watched and device B updating its own copy of the same title don't clobber each other. Push/pull cycle re-GETs, re-merges, and re-PUTs on a 409, bounded to 5 attempts; clock skew is corrected from the PUT response's `Date` header. Triggers (app load, `visibilitychange`, debounced-after-mutation) are wired but inert until a passphrase-derived DEK actually exists — there's no user-facing toggle yet (that's the still-open Sync settings UI issue).

### UI

- **Clear (×) button** on the `/add` search box and the IMDb-export-link field in the import panel; Chrome's native `type="search"` cancel button is suppressed so the two don't visually stack. (#163)

---

## [0.6.1] — 2026-08-12

### Sync epic — client track (#97, #99, #98)

- **Soft-delete tombstones** — `removeItem` now writes a `deleted_at` timestamp instead of hard-deleting, so deletions can propagate through sync instead of being silently undone by a device that hasn't seen them yet. `getAll()` filters tombstones automatically; `getAllIncludingDeleted()` and a 90-day `gcTombstones()` horizon were added for the sync engine. Found and fixed a real bug along the way: Settings' collection rename/delete flows did `getAll()` → mutate → `replaceAll()`, which — now that `getAll()` excludes tombstones — would have silently wiped them on every rename.
- **Canonical app-state snapshot module** (`src/lib/app-state.ts`) — collapses the "full app state" payload shape, previously defined separately for export and restore, into one module owning both. `SYNCED_KEYS`/`LOCAL_KEYS` make the sync-vs-device-local `localStorage` key partition explicit and tested (a new test greps the whole source tree for `sq:` literals and fails if one exists in neither set). Payload version bumped to 2 with an actual version check.
- **Auth: email + passphrase-derived session** — one passphrase splits into an `authKey` (sent to the server, which stores only a hash) and a DEK-wrapping key, reusing the app's existing PBKDF2+AES-GCM primitives; the server never holds anything that can decrypt user data. New `/api/auth/{signup,signin,signout}` routes and KV-backed sessions.

### Navigation

- **Folder-tab nav restyle** — the top nav's active-tab indicator is now a smooth, continuous curve rising into a short "hill" under the active tab (rather than a straight underline that got erased/faked behind a filled box), with the tab's own background merging into the page canvas below it. Went through three follow-up polish passes: air above the peak, tighter hug to the tab text, wider tab padding, and a rounder bezel. (#143)

---

## [0.6] — 2026-08-12

### Sync epic groundwork (#93, #95)

- **IndexedDB v3** — a real `oldVersion`-based upgrade ladder, `updated_at` stamped on user-driven mutations (deliberately *not* the background provider-refresh path, which would otherwise let the most-recently-refreshed device win every future conflict), and a new `meta` store.
- **D1 binding + sync schema** — `wrangler.toml` D1 binding and `migrations/0001_sync_schema.sql` (`users`, `sync_blobs` with an optimistic-concurrency `version` column, `wrapped_dek`). Infrastructure only at this point — nothing reads or writes D1 yet.

### Collections (#110, #111)

- **Filter by collection** — a new Collection section in the queue dock's filter popover: All / each collection with its color dot / Uncategorized.
- **Group by collection** — Grid and List can show section headers (name, color, count) instead of a flat list, toggled from the same popover.

### Maintenance

- **Dependency vulnerabilities** — patch-bumped `@sveltejs/kit`, `svelte`, `vite`, `postcss` within existing semver ranges (13 → 9 known vulnerabilities). (#141)
- **Lint cleanup** — `svelte/no-navigation-without-resolve`, `svelte/prefer-svelte-reactivity`, and `@typescript-eslint/no-explicit-any` all driven to zero project-wide. (#137, #138, #139, #140)
- Found and fixed two real bugs along the way: `setSubscribedIds()` silently no-op'd on in-place `Set` mutations after the SvelteSet migration, and three pages (`/`, `/settings`, `/share`) had page-option exports sitting after `</script>` instead of inside `<script module>`, which Svelte silently renders as visible page text instead of applying.

---

## [0.5.5] — 2026-08-11

### Collections

- **Named collections for grouping queue items** — assign items to a collection from the detail panel, with autocomplete from existing names; collections get an auto-assigned or user-picked color shown as a chip on Grid and List cards. Settings gained a full lifecycle: rename, recolor, and delete (with an armed confirmation, matching the reset-everything pattern) a collection across every item that carries it. (#106, #107, #108, #109)

### Bug fixes

- **`db.ts` writes hung forever when the id didn't exist** — `setWatched`, `updateShowProgress`, and `patchProviders` all read `get.result` without checking it existed first; a missing id left the IndexedDB transaction promise unresolved rather than rejecting. All three now guard and reject. (#114)
- **Silent failures in export, reset, and add-all-to-queue** — export and reset both swallowed errors with no UI feedback; add-all-to-queue stopped at the first failed item instead of reporting all of them. Export/reset now surface an error message; add-all collects every failure and reports them together, `title: error` per line. Services-loading failures (subscribed-provider fetch) are now exposed via `getLoadError()` and shown on the Share page's provider filter. (#115)
- **API routes returning 500 instead of 400 on bad input** — the feedback route checked `.trim()` before confirming `title` was a string; four routes (`feedback`, `import-fetch`, `import-search`, `refresh-providers`) didn't guard against malformed JSON bodies throwing past their validation. All four now validate ordering correctly and catch JSON parse errors as 400s. `refresh-providers` also no longer overwrites good provider data with blanks when a single item's refresh fails — it omits that item instead of returning an empty record for it. (#116)
- **Corrupted localStorage silently broke state** — budget prefs, queue colors, and dismissed-cancellation dates all trusted `JSON.parse` output without checking its shape; a hand-edited or partially-written value could hand `NaN`, `undefined`, or the wrong type to code that assumed a valid one. New typed-read helpers (`readString`, `readNumber`, `readBoolean`, `readRecord`, `readArray`, `readDate` in `lib/storage.ts`) validate the parsed shape and fall back cleanly; budget prefs load all-or-nothing rather than mixing a valid and a corrupt field. (#117)
- **Import parser bugs** — `parseTextList` stripped the trailing year off titles that were entirely a year (e.g. "1917"), leaving nothing; `parseImdbCSV` silently treated every row as a movie when the `Title Type` column was missing rather than skipping detection. Both fixed, with 31 new parser tests covering the edge cases. Text-list parsing is now debounced (300ms) instead of reparsing on every keystroke, and both file and pasted-text imports are capped at 100 KB to prevent the UI from freezing on oversized input. (#118)

### Production readiness

- **Missing production assets** — added a favicon (SVG data-URI), `manifest.json` (PWA metadata), and `robots.txt`; `PUBLIC_ORIGIN` is now read for Open Graph tag construction. A custom `+error.svelte` replaces SvelteKit's default error page with one that matches the app's theme. `/settings` and `/share` are now `ssr = false` (client-only, matching their localStorage/IndexedDB dependence); `/` (landing) is now prerendered. `hooks.server.ts` adds a CSP fallback for routes the Cloudflare `_headers` file doesn't reach, and the CSP itself now includes `form-action` and allows `https://api.themoviedb.org`. (#125)

### Code quality

- **Silent `catch {}` blocks documented** — all 18 empty catch blocks (mostly best-effort localStorage/clipboard writes where failure is genuinely fine) now carry a one-line comment explaining why swallowing the error is safe, rather than reading as an oversight. (#136)
- **Lint and type-check cleanup** — the sprint's own new code (four API test files, `+error.svelte`, `settings-actions.ts`) initially shipped with `any`-typed mocks and a couple of type mismatches that failed `svelte-check` in CI; replaced with real `Request` objects and the actual `ReleaseInfo`/`CastMember`/`SeasonSummary` types, cutting `no-explicit-any` lint warnings from 87 to 29 project-wide.

### Testing

- **58 new tests**: 27 for the four hardened API routes, 31 for the import-parser edge cases (year-only titles, missing CSV columns). 198 tests total, all passing.

---

## [0.5.4] — 2026-07-25

### Documentation & licensing

- **README corrected**: license section said MIT — the repo is AGPL-3.0. Added the `license` field to `package.json`, fixed the `preview`/`.dev.vars` setup instructions (previously pointed at `.env.local`, which `wrangler pages dev` never reads), corrected the budget-is-configurable-in-Settings claim (it's at `/budget`) in both the README and the in-app copy, and updated stale repo-slug links. (#126)

### Infrastructure & repo hygiene

- **ESLint + Prettier + `lint`/`format` scripts**, wired to match the existing hand-formatted style (tabs, single quotes, no trailing commas, 100-char width). `tsconfig.json` gained `noUnusedLocals`/`noUnusedParameters`. `.gitignore` cleaned up; `.claude/launch.json`'s hardcoded path removed from tracking. (#124)
- **Deleted dead code**: the orphaned `/services` and `/import` routes (both superseded by earlier work), the fully-unwired `welcome.svelte.ts` module, the unrendered `backdrop_path` field, the always-null `current_season`/`current_episode` fields, and several smaller unused exports/params surfaced by the new strict TS flags. (#123)

### Bug fixes

- **Backup restore, reset, and view-whitelist defects**: restoring a backup could silently drop data on certain shapes, "Reset everything" left stale entries in a couple of lists, and a filter's allowed-view whitelist didn't match its actual options. (#96)

### Testing & maintainability

- **Wired the remaining actions modules** into their components — `settings`, `add`, `share-create`, `share-token`, and `import` now all follow the same dependency-injected, unit-tested pattern as `queue-actions.ts`, closing the gap left by v0.5.3's initial extraction pass. Along the way, fixed a real bug where CSV-import-from-URL was fetching and then discarding the response body, always returning an empty result. (#92, #94)
- **`app/+page.svelte` decomposed** from 1102 to 505 lines: extracted `QueueGanttView`, `QueueListView`, and `QueueGridView` into `$lib/components/`, each landed as its own commit. `resolvedHue` centralized into `$lib/colors.ts`. (#119, #120)
- **`tmdb.ts` test coverage** added (17 tests): Disney+/Hulu provider disambiguation, tier/bundle filtering, and movie/TV release-date branching via mocked `fetch` + `vi.setSystemTime`. `add/page-server.test.ts` no longer mocks the pure `augmentProviders`. (#127)
- **Duplicated helpers consolidated**: `hms()` (5 copies) and a provider-aggregation loop (4 copies, inconsistently keyed by name vs. id — now uniformly by `provider_id`) moved into `lib/progress.ts`; the budget-prefs triple-write, the `res.ok`-throw pattern, `ConstraintError`-as-success checks, and base64url encoding each consolidated into shared helpers. (#121)
- **API routes**: the same-origin guard and error-response shape were inconsistent across all six routes (a mix of thrown SvelteKit error pages, bare-string responses, and a success-shaped body on failure) — settled on one `{ error: string }` JSON contract everywhere, added the guard to the one route that lacked it, and replaced `refresh-providers`' silent truncation of over-limit batches with a rejection, matching `import-search`. (#122)

---

## [0.5.3] — 2026-07-22

### Security

- **Share payload validation** — runtime schema validators for all untrusted input (share links, `.queuest` backup files). Payloads are rebuilt field-by-field from an allowlist, clamping strings (title ≤500, overview ≤5000, paths validated), numbers (runtime ≤100k), and array lengths (items ≤500, seasons ≤100 per title). Prevents oversized payloads from breaking queue views or budget math, and closes off prototype-pollution vectors. (#70)

### Bug fixes & cleanup

- **CORS console spam eliminated** — removed the doomed `extractLogoHue()` call that tried to extract logo colors from TMDB's CDN (which never sends CORS headers). Lane colors now rely entirely on the existing `providerHue()` brand-hue table + hash fallback, which was already working as the extraction always failed. (#81)

### Onboarding & UX

- **Guided new-user flow** — "Get Started" from the landing page now routes through `/budget?onboarding=1` (with introductory copy and a curated list of major streaming services fetched from TMDB) → `/add?onboarding=1` (with a callout to the Import section for users who already have a watchlist elsewhere). Returning users navigating directly to `/budget` or `/add` see the normal UI without onboarding scaffolding. (#80)

### Testing & maintainability

- **Extracted testable business logic** — refactored 5 route/component files (`settings`, `add`, `ImportPanel`, `share`, `share/[token]`) to follow the `queue-actions.ts` pattern: plain, dependency-injected async functions in `$lib/*-actions.ts`. At the time of this release the new modules were not yet wired into their components and the test suite predated them — that wiring landed separately in #92 and #94.

---

## [0.5.2] — 2026-07-22

### Bug fixes

- **Card/List click opens detail panel**: root cause finally found — a global click-outside-closes-popups listener was resetting `detailItem` back to null on the very same click that opened it, for any click except directly on the poster image. Fixed with `stopPropagation`; List view rows are now fully clickable too (previously only the title text was wired up). (#64)
- **Subscribed filter** no longer includes titles with no streaming provider at all — it now only shows items actually on a subscribed service. The option grays out when zero services are selected. (#83)
- **iOS zoom-on-focus**: the Add page search input was under the 16px font-size threshold that triggers Safari's auto-zoom on focus, hiding the right side of the app. (#82)

### Navigation & UI

- **Responsive filter dock**: inline in the nav (right-justified) at `lg:` and above, floating pill at the bottom below that — same component and state either way. (#84)
- **Sort direction + Clear**: an ascending/descending arrow next to the active sort option, and a Clear action that resets sort back to Recent. (#85)
- **Add page**: "Search" is now a subheading matching the Budget page's style; Import (CSV/URL/text-list/backup restore) is now a collapsible section on the same page instead of a separate link, sharing its logic with the standalone `/import` route via a new `ImportPanel` component. (#86)
- **Redundant page headers removed** — "Budget" and "Settings" duplicated what the nav already showed. "What to Subscribe to Next" and "Share Your Queue" are now subheadings instead of large titles. (#87, #88)

### Security

- **`/api/share` hardening**: same-origin guard on POST, a minimum-payload-size check (anything under 28 bytes can't be a valid encrypted blob), and `nosniff`/`Content-Disposition: attachment` on GET responses. (#68)

### Resilience

- **Add page**: a TMDB outage no longer crashes the whole page — shows an inline error with Retry instead, and a loading skeleton distinguishes "searching" from "no results found." (#48)
- **Queue page**: IndexedDB failures on toggle/remove/season-progress now show a dismissable error instead of failing silently — and no longer leave the button stuck in a disabled "busy" state forever. (#48)

### Infrastructure

- **Vitest test harness**: 41 initial tests covering `progress.ts`, `crypto.ts` (including the PBKDF2 legacy-iteration fallback), and `db.ts` (watchlist CRUD + subscribed services). (#47)

---

## [0.5.1] — 2026-07-02

### Security

- **SSRF fix** on the import-fetch proxy: allowlist limited to Criterion, Letterboxd, and IMDb; 2 MB response cap; 10 s timeout. (#65)
- **Same-origin enforcement** on all POST API routes via `Sec-Fetch-Site` header; cross-origin requests are rejected with 403. (#66)
- **Feedback endpoint hardening**: 200-char title cap, 5 000-char body cap, generic error message returned to client. (#67)
- **Security headers** via `_headers`: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS (1 year + subdomains), `Permissions-Policy` (camera/mic/geo off). (#69)
- **PBKDF2 strengthened** to 600 000 iterations; existing `.queuest` exports encrypted at 200 000 iterations are transparently migrated on next import. (#74)

### Bug fixes

- **Clipped dropdown** on queue grid cards: removed `overflow-hidden` from the card wrapper so season/release popups are no longer cut off. (#52)
- Attempted fixes for the green subscribed-service chip stroke (#51) and card-tap-opens-detail-panel (#64) — **neither actually resolved on review; both remain open.**

### Onboarding & UX

- **Budget callout**: shown once on first visit when no monthly budget is set; inputs for hrs/week × weeks/month with Save and Skip options. (#54)
- **Save before leaving**: browser-native "leave site?" dialog appears when the queue has items and the user tries to close or navigate away. (#55)
- **Landing page always accessible**: `/?preview` bypasses the returning-visitor redirect so the landing page can be revisited; Settings → About links there. (#56)

### Navigation

- **Search renamed to Add**: nav link, route (`/add`), and page title updated; `/search` issues a 301 redirect to `/add` preserving the `?q=` param. (#57)
- **Floating filter dock**: a pill dock fixed at the bottom of the Queue page replaces the old toolbar dropdowns — Card/List/Timeline view switcher, an inclusive Watched toggle (mixes watched items in with a teal badge instead of an exclusive tab), and a Filter button opening a Sort-by/Services popover. A summary line above content reads "N titles · ~Xh remaining." Reworked from an initial inline-nav-controls attempt after design review. (#58)
- **Add Titles / Import / Share row removed** from the Queue page toolbar — Share is now its own nav page (`/share`); an Import link was added to the Add page header.
- Service filter labels corrected to **All / Subscribed / Not Subscribed**.

### Accessibility & motion

- **`prefers-reduced-motion` support**: new `motion.svelte.ts` store gates scroll-reveal and float animations on the landing page and zeroes the `animate:flip` duration on queue grid cards when reduced motion is active. (#45)

### Infrastructure

- **Build fix**: upgraded `@sveltejs/kit` `0.0.30` → `2.69.0` and `@sveltejs/adapter-cloudflare` `0.0.1` → `7.2.9`; both were ancient stubs that caused `svelte-kit sync` to fail on Cloudflare Pages. Moved `_headers` to the project root as required by adapter 7.x.

---

## [0.5.0] — 2026-06-21

### Services & subscription awareness

- **Subscribed services** — new Services page lets users mark which streaming services they currently subscribe to. State is stored in IndexedDB alongside queue data and shared reactively across the app via a singleton Svelte store. (#36)
- **Service-aware queue filter** — Filter dropdown gains "Subscribed only" and "Not Subscribed" toggles that filter all three views (Grid, List, Gantt) by whether each title is available on a subscribed service. (#37)
- **Share pre-filtering by subscribed services** — the Share modal pre-selects the user's subscribed providers as the default filter when generating a share link.

### Landing page

- **Standalone landing page at `/`** — welcome content moved from a modal to a full marketing page at the root route. Returning visitors are redirected directly to `/app`. (#38)
- **Landing page redesign** — hero with interactive product mock (Grid / List / Gantt tab switcher), ambient parallax glow, scroll-reveal animations, Features 4-up, "How it works" 3-step section, and bottom CTA card. App nav links hidden on the landing page.

### Navigation

- **Search in top nav** — "Search" added as the leftmost nav link, surfacing the add-titles flow as a first-class destination. (#53)

### Design

- **Design reference** — `.design-sync/design-reference.md` added as a canonical record of the app's visual language: semantic color roles, typography scale, border radius, component class patterns, layout conventions, z-index stack, and transitions.

---

## [0.4.2] — 2026-05-31

### Bug fixes

- **Release popup clipped inside card** — the season-release date popup was cut off by its container's `overflow-hidden`. Removed it from the grid card wrapper (the poster already clips independently via its own `overflow-hidden`) and replaced it on the list container with `first:`/`last:` rounded corners per row, so the popup can escape without losing the rounded-rect visual.

---

## [0.4.1] — 2026-05-31

### Bug fixes

- **Episode count for upcoming/current seasons** — the orange chip row in the detail panel now shows episode count (e.g. "8 eps") alongside the release date, consistent with watchable season rows. Only shown when TMDB has the count.

### Docs

- **Welcome modal** — added "Share your queue" as a fourth feature point covering encrypted share links and pre-share filtering.
- **README** — added previously undocumented features: Rent/Buy indicator, Kanopy/Hoopla library fallback links, named queues with per-queue color coding, and 30-day share link expiration.

---

## [0.4.0] — 2026-05-31

### Detail panel

- **Detail panel on search page** — tapping a poster in search now opens the same detail panel as the queue page, with an "Add to Queue" footer instead of watched/remove actions.
- **Compact title bar** — replaced the tall blurred backdrop header with a slim title bar + close button, recovering significant vertical space on mobile.
- **Runtime lollipop in detail panel** — the same provider-colored sparkline shown in grid/list cards now appears in the detail panel's runtime row.
- **Tap-to-expand poster lightbox** — tapping the poster in the detail panel zooms it to a full-screen overlay (`w500` resolution); tap anywhere to close.
- **Episode count per season** — the seasons section in the detail panel now shows episode count alongside each season chip (e.g. "S1 · 8 eps").

### Release chip fixes

- **Mid-season vs. premiere distinction** — shows actively releasing new episodes (where `last_episode_to_air` and `next_episode_to_air` share the same season number) now show "S1 new episode Jun 5" or "S1 airing now" instead of "S1 premieres". (#28)

### Mobile sizing

- **xs breakpoint (375px)** — added a custom Tailwind breakpoint at 375px for a proper three-tier responsive system: base / `xs:` iPhone mini+ / `sm:` tablet+. (#28)
- **`overflow-x: clip` replaces `overflow-x: hidden`** — `hidden` creates a scroll container that iOS Safari can still pan into; `clip` is a true hard clip with no scroll container. Combined with `max-width: 100vw` on `html`/`body`. (#28)
- **Viewport meta reset on resize** — iOS Safari misreports viewport width during keyboard and file-picker animations, causing `sm:` breakpoints to fire on narrow screens. A global resize listener re-stamps the viewport meta to correct it. (#28)
- **Tighter nav and spacing** — nav height, logo/link text, main padding, footer, and empty-state sizes all reduce at the base tier and expand at `xs:`/`sm:`. (#28)

### Export / Import

- **Complete state capture** — export now includes `weeklyHours`, `weeksPerMonth`, `queueColors`, `sort`, and `view` preferences in addition to theme and queue name. A fresh import is now a full restore. (#28)
- **Queue name restored on import** — was missing from the export payload. (#28)
- **"Shared Queues" rename** — the section formerly called "Imported Queues" in Settings is renamed to avoid confusion with the file import feature. (#28)

---

## [0.3.0] — 2026-05-29

### Sharing

- **Encrypted share links** — share a filtered subset of your queue as a short URL. The decryption key lives only in the URL fragment; the server stores only the encrypted blob and can never read plaintext. Links expire after 30 days. (#13, #14)
- **Share filters** — choose what to include before generating a link: To Watch / Watched / Both, Movies / TV / All, per-provider toggles, and (when 2+ named queues exist) a queue picker. (#14, #25)
- **Queue tags preserved on import** — each shared item now carries its original queue tag. Recipients' items land in the correct queue rather than all being lumped into "Shared List". Old share links without per-item tags fall back gracefully. (#25)
- **Queue name in share header** — when sharing a single named queue, its name becomes the share title. (#25)

### Season chips

- **Orange upcoming-season chip** — unreleased seasons appear as an outlined orange chip in the same row as watchable season chips. Clicking the chip opens a popup with the full premiere date. (#20, #21)
- **Unreleased seasons are not checkable** — seasons at or beyond `next_season`, and seasons TMDB lists with zero episodes (announced but not yet airing), are hidden from the regular chip row and replaced by the orange chip. Fixes Severance, Dune: Prophecy, and similar shows. (#22, #24)
- **✓ replaces S on watched seasons** — `S2` becomes `✓2` when marked watched. Same character count keeps chip width stable; unambiguous for colorblind users. (#22)
- **Consistent chip height** — all three chip states (watched/teal, unwatched/gray, upcoming/orange) now use `inline-flex items-center` so height is driven by padding rather than per-character font metrics. The orange chip's wrapper div is also removed as a flex item. (#23, #24)
- **Backfill seasons on Refresh Providers** — items added before per-season data was stored had `seasons: []`. Settings → Refresh Providers now writes seasons and runtime back to IndexedDB, fixing missing chips without requiring titles to be re-added. (#21)

### Bug fixes

- **Share page "Add to my queue"** — Svelte 5 `$state` wraps array elements in Proxy objects that IndexedDB's structured clone algorithm cannot serialize (`DataCloneError`). Fixed by mapping providers to plain objects before storing. (#15, #16, #17, #21)
- **Runtime sort accuracy** — list view was sorting by total `runtime_minutes` while displaying remaining runtime after watched seasons. Sort now uses `effectiveRuntime` so order matches what's shown. (#19)
- **Disney+/Hulu provider disambiguation** — FX originals (e.g. The Bear) no longer show Disney+ instead of Hulu. Provider resolution now uses TMDB network/company metadata to determine which of the pair is the canonical home. (#12)
- **Season chips clipped in grid view** — `overflow-hidden` on the outer card div was clipping the chip row when a neighboring card was shorter. Moved to just the poster container. (#21)

### Polish

- **Flat SVG cog icon** — the mobile nav gear was a 3D emoji (renders as colored on iOS/Android); replaced with a monochrome Heroicons-style SVG consistent with the rest of the app. (#18)
- **Settings → Danger Zone** — two-step "Reset everything" clears the IndexedDB queue and all preferences, then redirects to `/` with the welcome screen. First click arms a confirmation banner; Cancel disarms safely. (#25)
- **IDB connection caching** — the `IDBDatabase` promise is cached at module level so all `addItem` calls reuse one connection. (#16)

---

## [0.2.0] — 2026-05-12

### Features

- **Provider polish** — Disney+ inferred from TMDB-native metadata (networks/production companies) since JustWatch removed their catalogue; bundle deduplication removes tier variants (Peacock Premium Plus) and bundle-only entries (Apple TV Amazon Channel). (#9, #12)
- **Release dates** — surfaces theatrical windows, estimated streaming dates, and next-season premieres on every card across Grid, List, Gantt, and Search. (#9)
- **Gantt improvements** — bar widths and labels use remaining runtime (accounting for watched seasons); lanes sort by the active filter (Recent, A–Z, Runtime). (#9)
- **Settings** — compound budget input (hrs/week × weeks/month); Refresh provider data button; in-app feedback (files GitHub issues); version badge. (#9)
- **Suggest** — ranked by total remaining runtime instead of title count. (#9)

---

## [0.1.0] — 2026-05-11

### Features

- **Grid, List, and Gantt views** — runtime sparklines, provider swimlanes, and draggable lane ordering. (#3, #6)
- **Local-only storage** — watchlist lives in IndexedDB; encrypted `.queuest` backup/restore via AES-GCM + PBKDF2. (#2)
- **Season tracking** — per-season chip toggles with progress tracking. (#6)
- **Light/dark mode** — full theme system with flash-prevention; persisted in localStorage. (#6)
- **Welcome modal** — first-visit onboarding; re-accessible from Settings. (#6)
- **Runtime estimates** — fetches movie runtime and TV total hours from TMDB on add. (#1)
