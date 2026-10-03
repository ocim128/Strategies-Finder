# Repository Maintenance Log

Newest entry first. Keep completed improvements concise; record the evidence,
focused checks, and any useful follow-up so future maintenance runs can avoid
repeating the same investigation.

## 2026-10-03 - Repair the preflight quote-overlap window and a spread-limit crash

- **Evidence:** Running `npm run data:preflight` over the IBKR 30m tree
  (verdict=BLOCK: 88 symbols, 2,378 WARN of 3,827) prompted a review of
  `lib/market-data/data-integrity-scan.ts`. Its quote-overlap coverage
  subtracted 180 days as `180 * 24 * 3600 * 1000` (milliseconds) from unix
  SECONDS timestamps, so the documented "recent 180-day window" started
  ~180,000 days back and coverage silently measured full history —
  contradicting the function's own comment. The same block computed the quote
  leg's last bar with `Math.max(...quoteTimestamps)`; NVDA's quote set is
  already 75,822 rows and grows every sync, and Vite/Node engines throw
  RangeError around ~125k call arguments, so the CLI would eventually crash.
  No runtime consumer exists for the overlap numbers (CLI JSON only), which
  bounded the impact but made both defects safe to fix.
- **Change:** Expressed the window offset in seconds (`180 * 86_400`) and
  replaced the spread with an explicit max loop. Added two regression tests:
  deep-history bars outside the window must not dilute coverage (failed at 50%
  vs the expected 100% pre-fix), and a 250k-timestamp quote set must score
  correctly (RangeError pre-fix). Both confirmed red against the buggy code
  and green after. The existing all-recent overlap test is unaffected.
- **Checks:** `npm run test -- data-integrity-scan.spec.ts` (new tests verified
  failing against the pre-fix module), `npm run typecheck`,
  `npm run typecheck:tests`, `git diff --check`, full suite 257/257.
- **Follow-up:** The BLOCK verdict has no runtime consumer: Finder Symbol
  Universe, Scanner, and Batch research the same tree without excluding the 88
  blocked symbols (empty files, non-monotonic timestamps, unparsable rows,
  stale tails) — surfacing or excluding those at universe-build time is a
  worthwhile but design-heavy improvement needing per-run cost handling
  (full-tree parse is minutes; would need cached verdicts with mtime
  invalidation). Also noted: `price-data/ibkr/csv/30m/` holds 3,264
  `*.csv.bak` backups alongside the 3,827 live CSVs; the scanner ignores them,
  but a cleanup/archive step could keep the tree lean.

## 2026-10-03 - Repair perf-commit fallout: doubled solver-failure diagnostic and stale cancellation pin

- **Evidence:** A ground-truth full-suite run found 1 of 257 specs failing:
  `open-score-additional-arms.spec.ts` expected `scoreGraphStrength` to reject
  when a Stop flag tripped on its third observation, but the perf commit
  `07fc95b6` deliberately reduced the solver to a single Stop check at solve
  entry (documented in its message and code comment; the sweep owns the
  per-bucket checks), leaving the test pinning the retired inner-check
  pattern. The same commit also left a duplicated
  `diagnostics.graphSolverFailures++` in `event-sweep.ts` (blame-confirmed),
  double-counting the "Graph solver failures" diagnostic shown in the Batch
  TOP_MEAN results view and the Finder arm metrics. The new equivalence spec
  could not catch the doubling: its reference fixture produces zero solver
  failures (`graphSolverFailures: 0` pinned).
- **Change:** Removed the duplicated increment; updated the cancellation
  assertion to the current entry-check contract and added a sweep-level
  regression test (one-pair fixture with a non-finite entry delta) asserting
  `graphSolverFailures` counts each failed solve exactly once and the event
  still forms — verified to fail with the duplicate re-introduced. Documented
  the graph-solve Stop contract in `docs/batch-backtest-server-side.md` and
  repaired a mangled sentence in the `graph-strength.ts` performance-contract
  comment left by the same commit.
- **Checks:** Focused: `open-score-additional-arms.spec.ts`,
  `open-score-replay-event-sweep.spec.ts`,
  `sp500-top-mean-causal-sweep.spec.ts` pass; regression test confirmed red
  with the bug present. `npm run typecheck`, `npm run typecheck:tests`,
  `git diff --check` pass. Full suite: 257/257 (was 256/257).
- **Follow-up:** None open for this area. The graphEdgePool slice per entry
  bucket (when edgeCount < pool length) remains a minor allocation the sweep
  could avoid by passing an explicit count, only worth revisiting with
  profiling evidence.

## 2026-10-03 - Remove dead UI orphaned by removed and refactored features

- **Evidence:** A scripted cross-check of all 693 structural ids in
  `html-partials/*` against every reference site (contracts, handlers, tests,
  selector and template-concatenation patterns) surfaced three genuinely dead
  controls after eliminating the live false positives: (1) the More-menu item
  `data-tab="executionlab"` — its `#executionlabTab` panel was removed with the
  Execution Lab in `d654d295`, and `switchTab` returns false, so the menu item
  silently does nothing; (2) the `crosshairTool` toolbar button — no handler,
  contract, or CSS since the initial commit, while every sibling tool button is
  wired through `ui-event-handlers-dom.ts`; (3) four `section-changed-dot`
  spans (direction/risk/sizing/realism) — orphaned by the settings workspace
  refactor in `00a8854e`; their `.visible` CSS class is never applied, so the
  dots are permanently invisible dead markup. Candidates such as `mc-summary-grid`,
  `timeframeTabs`, `backtestToolsMenu`, and the `*Tab` panels were verified live
  (child ids, class delegation, or `#${tabId}Tab` construction) and left alone.
- **Change:** Removed the Execution Lab More-menu item, the crosshair toolbar
  button, and the four changed-dot spans, plus the now-dead "Section changed
  indicator" CSS block in `styles/settings-ux.css`; dropped two stale
  "Execution Lab" mentions from comments in `lib/local-route-authorization.ts`
  and `lib/dataProviders/fetch-helpers.ts`.
- **Checks:** No remaining references to the removed ids anywhere in lib,
  tests, scripts, styles, partials, or `index.ts`. `feature-dom-contracts.spec.ts`,
  `npm run typecheck`, and `npm run test:e2e` (including layout verification)
  pass; full suite 256/256; `git diff --check` clean.
- **Follow-up:** The dead-id scan technique (partials vs reference corpus with
  construction-pattern elimination) is worth rerunning periodically; it also
  flags harmless-but-unused wrapper ids (`alertSubscriptionsList`,
  `lastTradeModalBody`) that need no action.

## 2026-10-03 - Repair broken documentation links and reconcile the docs index

- **Evidence:** A scripted scan of every relative `.md` link across the
  maintained tree (2,714 files) found six broken references: the docs index
  pointed at three deleted plans (`top-mean-event-sweep-plan.md`,
  `top-mean-shard-overhead-plan.md`, `polymarket-removal-plan.md`), the
  server guide linked the retired `finder-arm-performance-ranking-consistency-plan.md`,
  the allocation plan linked the deleted aggregation plan, and the root README
  still linked `docs/cross-symbol.md` twice although the cross-symbol runtime
  was retired. Seven existing docs (time-filter audit, cap-tilt record, five
  arm-performance plans, market-cap download) were absent from the index.
- **Change:** Removed the dead index entries and the README cross-symbol
  references (including a dangling "secondary dataset" clause describing
  retired behavior); reworded the two in-guide dead links; indexed all
  previously undiscoverable records; and corrected the stale
  `finder-arm-performance-optimization-plan.md` banner ("Proposed; not
  started") to "Absorbed" — its three items shipped per the worker-reuse plan
  and the server guide's enabled worker reuse.
- **Checks:** Link rescan reports 0 broken across the same 2,714 files;
  `git diff --check` clean. Docs-only change; no code or tests affected.
- **Follow-up:** Per the index's maintenance rules, the five arm-performance
  plan records could eventually be folded into `finder.md`/`finder-server-side.md`
  and deleted; deferred because they carry measured outcomes and a rejected
  phase that must not be re-litigated, and they cross-reference each other.

## 2026-10-03 - Verify and land the Batch TOP_MEAN causal arms feature

- **Evidence:** The worktree held a completed, uncommitted feature extending
  the five causal arms (landed for Finder in `f1a997c7`/`08c45d11`) to the
  Batch TOP_MEAN coordinator: engine replay options, latest-pick/details
  selectors, availability diagnostics, persisted snapshot and wire compaction,
  legacy `Rerun required` handling, docs, partial markup, unit specs, and a new
  e2e step. No maintenance entry referenced it and its checks had never run.
- **Change:** Verified the whole feature and committed it. Batch TOP_MEAN now
  computes all twenty arms in full-window and annual replays for both horizon
  and asset-switch modes, keeps causal picks frozen against later data gaps
  with the actual arm score shown separately, and reports warm-up/price/
  graph-exclusion diagnostics. Older saved results degrade to an explicit
  rerun notice. No new request fields or settings.
- **Checks:** `npm run typecheck`, `npm run typecheck:tests`, 35 focused
  top-mean/open-score/batch specs, `feature-dom-contracts.spec.ts`, and
  `npm run test:e2e` (including the new Batch causal-arm step) all pass;
  `git diff --check` clean.
- **Follow-up:** The full suite was not rerun after this patch; CI gates it on
  every push. The separate Batch Run OPEN_SCORE post-analysis intentionally
  keeps its legacy arm subset.

## 2026-10-03 - Sequence symbol-search initial fill against user queries

- **Evidence:** `initializeSearch` rendered its popular-assets response
  unconditionally, outside the `searchSequence` guard added for `performSearch`.
  Opening the dropdown and typing before the initial fetch resolved let the slow
  "Popular Assets" response overwrite fresh query results while the input showed
  the query. Symbol selection is step 1 of the README smoke check, and the
  multi-provider `searchAssets` fan-out has genuinely variable completion order.
- **Change:** The initial fill now participates in the same sequence counter:
  superseded popular-assets responses (and their errors) are dropped, and the
  newer query owns the dropdown view. Emptying the input still re-fetches
  popular assets through `performSearch('')`.
- **Checks:** `npm run typecheck`, `npm run typecheck:tests`, and
  `npm run test -- feature-dom-contracts.spec.ts` pass; `git diff --check` clean.
  Full suite verified 254/254 passing this run (see next entry).
- **Follow-up:** None known for the search dropdown; all three render paths
  (`performSearch`, `initializeSearch`, market-type switch) now share ordering.

## 2026-10-03 - Ground-truth suite verification and UI hardening commit

- **Evidence:** The log's standing follow-up asked for a suite rerun to confirm
  the status of documented failures (trade-ledger checker/parity, Finder Asset
  Opportunity metadata/export/server-plugin specs). Focused reruns passed, and a
  full `npm run test` run completed 254 passed, 0 failed, 0 skipped — every
  documented failure is resolved by intervening commits (CI-portability fixes
  and spec renames). Some spec names in older entries no longer exist.
- **Change:** Committed the completed UI reliability work from the prior
  maintenance session as `a7eadccd` (crosshair time-map sync on streamed bars,
  search response race guard, alert-modal HTML escaping, debounced backtest
  auto-refresh, cached `getOptionalElement`, shared `ProgressiveListRenderer`,
  entry bundle budget re-tightened to 650 KB against a measured 601 KB). No
  code changes in this entry beyond the commit itself.
- **Checks:** `npm run test` full suite: 254/254 pass in 29.8s.
  `node --experimental-strip-types scripts/check-bundle-budget.ts`: 600.8 KB /
  650 KB OK.
- **Follow-up:** CI (`npm run verify` on windows-latest) gates the full suite on
  every push, so suite health is now machine-enforced. The `vite` dev dependency
  is only installed at the npm-workspace root; local `build:check` runs there,
  not in this standalone directory (see AGENTS.md workspace-dependency note).

## 2026-10-01 - Finish Batch result invalidation when storage is denied

- **Evidence:** `clearPersistedLatestResults` acquired `localStorage` outside
  its error boundary. Denied accessor access interrupted `clearStaleRows` before
  clearing rows or disabling OPEN_SCORE USD/copy actions. The same helper runs
  before a new Batch server request. A new lifecycle regression reproduced the
  interrupted clear; the removal-method failure case already passed.
- **Change:** Acquire storage inside the cleanup error boundary, keeping removal
  best-effort and preserving its error log. Covered accessor and method denial
  through the real result-clear lifecycle, plus successful targeted deletion and
  absent storage. Documented that a snapshot can remain stored after failed
  removal while in-memory invalidation still completes.
- **Checks:** All four focused specs pass: `batch-backtest-service-lifecycle.browser.spec.ts`,
  `batch-backtest-snapshot.spec.ts`, `persisted-json.spec.ts`, and
  `settings-compat.spec.ts`. `npm run typecheck`, `npm run typecheck:tests`, and
  `git diff --check` pass. The baseline full suite passed all 246 current specs
  before this patch; it was not repeated after the focused checks.
- **Follow-up:** This resolves the Batch cleanup issue named in the prior
  denied-storage entry. No saved schema changed.

## 2026-10-01 - Protect ledger replay data from rule mutations

- **Evidence:** `createRuleRowProxy` guarded reads but forwarded mutations to the
  source row. A rule could replace the sealed `asIf` outcome before report
  statistics used it, or alter features shared by later prepared evaluations.
  Seven new regression cases failed before the fix, while the existing golden
  report still passed.
- **Change:** Made `TradeLedgerRuleRow` read-only and rejected assignment,
  property definition/deletion, prototype replacement, and preventing extensions
  on the rule proxy. The underlying loader-owned row remains writable for rank
  joining. Covered unchanged source rows and later evaluations, fresh/prepared
  paths, and rejection before the asynchronous control runner starts. Updated
  the Trade Ledger guide; archive schemas and legitimate report values are unchanged.
- **Checks:** `npm run test -- trade-ledger-checker.spec.ts
  trade-ledger-parity-golden.spec.ts`, `npm run typecheck`,
  `npm run typecheck:tests`, and `git diff --check` pass. The checker spec
  includes actual worker-control parity; the golden covers both preparation modes
  and the checker adapter. No full-suite run was performed for this change.
- **Follow-up:** The denied-storage cleanup review from the prior entry remains
  open; this run prioritized protection of replay report integrity.

## 2026-10-01 - Keep JSON persistence usable when storage access is denied

- **Evidence:** Both JSON helpers checked `typeof localStorage` outside their
  `try` blocks. A throwing storage accessor escaped before the caller's fallback
  or error callback could run. New read/write regressions reproduced both
  failures. Settings restoration and named-configuration loading call these
  helpers without another error boundary.
- **Change:** Acquire storage once inside each helper's error boundary. Denied
  access returns the read fallback or `false` for writes and reports the error
  through `onError`; unavailable storage skips writes before serialization.
  Added accessor-denial, absent-storage, method/quota-failure, and settings-manager
  coverage. Documented the fallback contract in README; saved schemas are unchanged.
- **Checks:** `persisted-json.spec.ts`, `settings-compat.spec.ts`,
  `finder-settings-persistence.spec.ts`, and `batch-backtest-snapshot.spec.ts`
  pass, along with `npm run typecheck`, `npm run typecheck:tests`, and
  `git diff --check`. The full suite passed all 250 specs before this patch;
  the previously logged four failures were resolved by the recent fixture commits.
- **Follow-up:** Direct storage-removal helpers still merit caller-level review
  for the same accessor issue, including `clearPersistedLatestResults` in
  `lib/batch-backtest/browser/batch-browser-store.ts`.

## 2026-10-01 - Preserve final streamed results at clean EOF

- **Evidence:** The shared browser NDJSON reader only dispatched newline-ended
  records and discarded its remaining buffer at EOF. Six new regression cases
  failed before the fix: terminal records without a newline appeared interrupted,
  final progress was lost, malformed final records were ignored, and final-event
  handler errors never reached callers. Finder, Batch, and data-download clients
  use this reader.
- **Change:** Reused one record dispatcher for newline-delimited records and the
  decoder's final buffer at clean EOF. Required terminal events, line-numbered
  parse errors, handler errors, and reader-lock cleanup retain their behavior.
  Added multibyte/chunk-boundary, custom-terminal, whitespace, read-error, and
  Batch transport coverage; documented the Finder and Batch stream contract.
- **Checks:** All five focused specs pass: `ndjson-stream.spec.ts`,
  `batch-ndjson-post.spec.ts`, `finder-manager-lifecycle.browser.spec.ts`,
  `finder-asset-opportunity-stream.spec.ts`, and
  `batch-backtest-service-lifecycle.browser.spec.ts`. `npm run typecheck`,
  `npm run typecheck:tests`, and `git diff --check` pass.
- **Follow-up:** Triage confirmed four existing failures in Finder Asset
  Opportunity metadata, Finder export diagnostics, Trade Ledger checker, and
  Trade Ledger parity golden. The checker expects retired regeneration advice;
  the golden fixture hash differs on this CRLF checkout. The Finder server-plugin
  spec now passes. No full-suite run was performed for this change.

## 2026-10-01 - Align Finder cache capacity checks with signal reserve

- **Evidence:** The full run failed the pair-cache capacity spec: it expected
  679 entries at 8 GiB and 341 at 4 GiB. The current sizing policy reserves
  64 MiB for the worker signal cache before dividing the remaining 75%-RAM
  budget by 10 MiB per symbol, yielding 608 and 300. The implementation and
  guide were updated for that reserve, but the older assertions were not.
- **Change:** Updated the capacity regression expectations and clarified that
  worker-local synthetic pair caches share the reserve-aware limit; partitions
  larger than the limit can incur reloads across holdout iterations.
- **Checks:** `npm run test -- finder-asset-opportunity-cache-capacity.spec.ts`,
  `npm run typecheck`, `npm run typecheck:tests`, and `git diff --check` pass.
  The preceding full run had 240 passes and 6 failures, including this stale
  capacity assertion.
- **Follow-up:** The other full-run failures were Finder Asset Opportunity
  metadata, Finder export diagnostics, Finder server plugin, Trade Ledger
  checker, and Trade Ledger parity golden. Rerun the suite to confirm their
  current status.

## 2026-10-01 - Make pair-list integrity checks line-ending portable

- **Evidence:** The broad suite failed `pairlist-pool-registry.spec.ts` because
  `core.autocrlf=true` checks out the committed LF text files as CRLF, while the
  expected generated list uses LF. The registry hash itself is computed from
  canonical LF-joined pair entries and still matched.
- **Change:** Normalize CRLF to LF only for text-export comparisons, including
  the optional local archive copies. The test still checks all pair tokens,
  order, markers, final newline, and the pinned registry hash. Documented the
  canonical hash and checkout contract in the pool guide.
- **Checks:** `npm run test -- pairlist-pool-registry.spec.ts`,
  `npm run typecheck:tests`, and `git diff --check` pass. The preceding full
  run had 242 passes and 7 failures, including this portability failure.
- **Follow-up:** The other failures were Finder Asset Opportunity cache
  capacity, metadata, export diagnostics, and server-plugin specs, plus the
  trade-ledger checker and parity golden specs. Cache capacity is corrected in
  the newer entry; rerun the full suite to verify the remaining status.

## 2026-10-01 - Sync the missing built-in strategy manifests

- **Evidence:** The full suite found all four generated-manifest checks out of
  sync. `directional_body_streak_exhaustion` existed in the source library but
  was absent from the eager registry, browser summary, lazy loaders, and key
  list, so users could not select or load it as a built-in. The full run had
  241 passes and 8 failures before this fix.
- **Change:** Ran the documented manifest generator to register the existing
  strategy in all four generated files; no strategy source changed.
- **Checks:** `npm run strategies:sync-manifest`,
  `npm run test -- strategy-manifest-sync.spec.ts`,
  `npm run test -- new-strategy-lib-smoke.spec.ts`, `npm run typecheck`, and
  `git diff --check` pass.
- **Follow-up:** The prior full run also failed Finder Asset Opportunity cache
  capacity, metadata, export diagnostics, and server-plugin specs; pair-list
  pool registry; and trade-ledger checker/parity. Pair-list line-ending drift
  is fixed in the newer entry; rerun the suite to confirm the other failures.

## 2026-10-01 - Repair endpoint parity confirmation fixture

- **Evidence:** The confirmation agreement test used 1m candle timestamps at
  seconds 1-5 with `nowSec: 10`. The executor filtered those still-open candles,
  leaving the strategy without the data its second-bar check reads. After
  fixing the timestamps, the final primary sell also passed confirmation, so
  the old expected signals did not describe the fixture.
- **Change:** Moved the fixture candles to 60-second boundaries, advanced the
  cutoff to keep all candles closed, and adjusted the final close so the final
  primary sell fails the intended confirmation check. The spec now exercises
  signal agreement instead of failing in setup.
- **Checks:** `npm run test -- backtest-endpoint-parity.spec.ts`,
  `npm run typecheck`, and `git diff --check` pass. `npm run typecheck:tests`
  still had 9 failures out of 249 selected specs.
- **Follow-up:** Triage the remaining full-suite failures in Finder asset
  opportunity cache/metadata, Finder export diagnostics, Finder server plugin,
  pair-list pool registry, strategy manifest sync, and trade-ledger
  checker/parity specs.

## 2026-10-01 - Keep pair-feature source pins portable across Windows

- **Evidence:** The full suite reported implementation digest mismatches for
  `lib/pair-features/families/spread.ts`. This checkout uses `core.autocrlf=true`;
  its CRLF bytes hashed differently from the release's pinned LF source hash,
  while normalizing the file to LF reproduced the committed digest. Feature
  pack generation therefore failed on this Windows checkout.
- **Change:** Added LF-normalized hashing for source implementation files and
  used it for release verification. Binary and other artifact hashes remain
  byte-exact. Added a line-ending regression check and documented the contract.
- **Checks:** All 9 `pair-feature` specs, `npm run typecheck`,
  `npm run typecheck:tests`, and `git diff --check` pass. The full suite improved
  from 239/254 passing to 246/254; 8 non-pair-feature specs still fail.
- **Follow-up:** Endpoint parity's stale fixture is corrected in the newer
  entry; other suite failures are listed there for continued triage.

## 2026-10-01 - Make replay event bucketing responsive to Stop

- **Evidence:** The event sweep checked Stop during its final delta application,
  but time indexing, bucket counting, and delta placement each traversed the
  full stream set without yielding. A Stop request arriving in those passes
  could not be handled until all three completed.
- **Change:** Added Stop checks and event-loop yields every 2,000 deltas (or
  bucket times for distinct-bucket indexing), plus checks around native
  timestamp sorting. Added a regression spec that cancels each delta pass
  independently and updated the Batch guide.
- **Checks:** `npm run test -- open-score-replay-event-sweep.spec.ts`,
  `npm run test -- batch-open-score-usd-replay-engine.spec.ts`,
  `npm run typecheck`, `npm run typecheck:tests`, and `git diff --check` pass.
- **Follow-up:** Native sorting remains synchronous; revisit only if replay
  profiling shows distinct-timestamp sorting materially delays Stop.

## 2026-10-01 - Restore test TypeScript check

- **Evidence:** `npm run typecheck:tests` failed with 134 diagnostics. 126 came
  from a stale smoke spec importing pruned strategies; the rest were confined
  to four specs with narrow type and import errors. Current strategy
  normalization and registration coverage is manifest-driven.
- **Change:** Removed the obsolete synthetic-ratio smoke spec and repaired the
  remaining fixtures/imports so test TypeScript checking covers the current
  library and compiles cleanly.
- **Checks:** `npm run typecheck`, `npm run typecheck:tests`, six focused specs,
  and `git diff --check` pass. The OPEN_SCORE replay specs also passed in the
  same maintenance run.
- **Follow-up:** The next full-suite integration run is recorded in the newer
  maintenance entry above.

## 2026-10-01 — Make OPEN_SCORE candidate selection cancellable

- **Evidence:** Artifact scanning, event sweeping, target evaluation, and the
  asset-switch simulator all observe Stop. Candidate construction in
  `candidate-selection.ts` did not, so both replay modes could continue through
  the full event set after a Stop request.
- **Change:** Candidate construction now checks Stop at event boundaries and
  after its bounded yields; cancellation discards partial selections and skips
  target-data loading.
- **Checks:** Both focused specs pass; `npm run typecheck` and `git diff --check`
  pass. `npm run typecheck:tests` reports errors in unrelated test files; a
  filtered compiler run reported no errors in the changed specs.
- **Follow-up:** The test typecheck failures recorded here were resolved in the
  maintenance entry above.
