# Repository Maintenance Log

Newest entry first. Keep completed improvements concise; record the evidence,
focused checks, and any useful follow-up so future maintenance runs can avoid
repeating the same investigation.

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
- **Follow-up:** Triage the remaining full-suite failures in endpoint parity,
  Finder opportunity, pair-list pool, strategy manifest, and trade-ledger parity
  specs at the next maintenance run.

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
