# Repository Maintenance Log

Newest entry first. Keep completed improvements concise; record the evidence,
focused checks, and any useful follow-up so future maintenance runs can avoid
repeating the same investigation.

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
  pool registry; and trade-ledger checker/parity. Rerun the suite to confirm
  those failures' current status.

## 2026-10-01 - Restore Trade Gate batch integration test seam

- **Evidence:** `tests/trade-gate.spec.ts` failed 9 of 10 tests because its
  server-run case called `__testInternals.setTradeGateArchiveRootForTests`,
  which was missing after the ledger-root rename in the prior feature-removal
  commit. That prevented coverage of real Batch gate counters and provenance.
- **Change:** Restored the test-only setter for the current Trade Gate archive
  root and documented the server integration regression contract.
- **Checks:** `npm run test -- trade-gate.spec.ts`, `npm run typecheck`,
  `npm run typecheck:tests`, and `git diff --check` pass.
- **Follow-up:** The last broad run also failed Finder asset-opportunity cache
  capacity, metadata, export diagnostics, and server-plugin specs; pair-list
  pool registry; strategy manifest sync; and trade-ledger checker/parity. The
  strategy manifest drift is fixed in the newer entry; rerun the broad suite
  to confirm the other failures' current status.

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
  still fails on the unrelated missing `__testInternals.setTradeGateArchiveRootForTests`
  member in `tests/trade-gate.spec.ts`. The full suite reports 240 passed and
  9 failed out of 249 selected specs.
- **Follow-up:** Triage the remaining full-suite failures in Finder asset
  opportunity cache/metadata, Finder export diagnostics, Finder server plugin,
  pair-list pool registry, strategy manifest sync, and trade-ledger
  checker/parity specs. Trade Gate is corrected in the newer entry.

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
