# Repository Maintenance Log

Newest entry first. Keep completed improvements concise; record the evidence,
focused checks, and any useful follow-up so future maintenance runs can avoid
repeating the same investigation.

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
