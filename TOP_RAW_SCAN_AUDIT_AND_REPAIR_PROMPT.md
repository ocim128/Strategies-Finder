# Fast TOP_RAW audit and repair prompt

Audit date: 2026-10-15. Baseline HEAD: `79cf5ca9` on
`chore/complexity-reduction`; the implementation is currently uncommitted.
Status: five confirmed problems; implementation fixes have not been applied.

## Audit result

The existing six TOP_RAW spec files passed. Four additional shared integration
specs passed. Targeted audit fixtures reproduced the five problems below; two
problems share the failed-vote fixture. These are P2 correctness/usability
issues worth fixing before treating Stop/recovery as complete. No P0/P1 finding
or scoring mismatch was established in the audited fixtures.

This audit inspected request validation, sampling/orientation, execution and
endpoint votes, preflight, shard reuse, server/browser persistence, routes,
ownership and the Batch UI integration. It did not repeat the previous agent's
full CI/E2E run or perform another large stock-universe benchmark. Passing tests
below do not establish exhaustive correctness or universal sampling accuracy.

### F1 — Stop is lost while the strategy module is loading

**Location:** `TopRawScanController.run` and `stop`, in
`lib/batch-backtest/browser/top-raw-scan-controller.ts` (approximately lines
151–175 and 204–211).

`run()` sets busy and enables Stop, then awaits
`ensureBuiltInStrategyLoaded(strategyKey)`. The run id is assigned later by
`adopt()`. During that asynchronous loading interval, `stop()` sees no
`activeId` and returns without recording cancellation. When loading finishes,
the controller still submits the expensive scan.

**Reproduction:** hold the built-in strategy loader promise unresolved; start
Run; verify Stop is enabled; press Stop; then resolve the loader. The audit
fixture observed a subsequent `/run` POST and no `/stop` request.

**Impact:** the UI accepts a cancellation action but starts the job anyway.
This is especially relevant to a delayed lazy module load. It is not a claim
that an ordinary second mouse event can interrupt an already-resolved promise's
microtask continuation.

### F2 — Large daily scans write manifests that restoration rejects

**Location:** `ScanStore.readManifest`,
`lib/batch-backtest/top-raw-scan-store.ts` (approximately line 34), and
`scanSourceIntervals` in `top-raw-scan-preflight.ts`.

Manifest reads cap `sources.length` at 10,001. Source planning can produce three
entries per asset: mandatory 30m, primary source, and target/fallback interval.
For a daily scan, the current intervals are `30m`, `4h`, and `1d`, plus one
catalog entry for the whole scan. Therefore a valid 3,334-asset manifest has
10,003 source entries; a 5,000-asset one has 15,001. The input contract accepts
these universe sizes, and `saveManifest` writes them, but `readManifest` rejects
the scan's own output as `Invalid scan manifest`.

**Reproduction:** verify the real `scanSourceIntervals("AAPL•", "1d")` produces
three intervals, build a manifest with 3,334 assets using those source slots,
save it and call `readManifest`. The audit fixture confirms rejection. This
is a persistence-contract reproduction, not a claimed real 3,334-stock daily
execution benchmark.

**Impact:** reload recovery after server restart and Resume fail for accepted
large universes at timeframes with three tracked source intervals. The 4h
two-source case does not exercise this boundary.

### F3 — Resume permanently reuses cached failed votes

**Location:** `TopRawScanEngine.run`'s `runPairs`,
`lib/batch-backtest/top-raw-scan-engine.ts` (approximately lines 154–167).

Any existing shard is reused wholesale. A shard containing `ScanVote.error`
records is treated as cached work, so Resume never schedules those relationships
again. The browser offers Resume after a failed/incomplete run. Even when the
pair executor is now healthy and the frozen data/configuration are unchanged,
Resume repeats the same incomplete result with zero fresh pair evaluations.

**Reproduction:** execute discovery with one injected transient pair error;
Resume the exact request with a healthy executor and identical revisions.
The audit fixture observed zero pair calls and another
`failed/incomplete_coverage` result.

**Impact:** recovery cannot recover transient pair failures. Repeated Resume
clicks cannot make progress. This is different from source/configuration changes,
which should continue to invalidate the frozen scan.

### F4 — Terminal status unlocks the browser before teardown/ownership settle

**Location:** terminal publication in `TopRawScanEngine.run`,
`top-raw-scan-engine.ts` (approximately lines 199–226), the route's terminal
stream/finally in `top-raw-scan-vite-routes.ts` (approximately lines 69–76), and
the browser's `accept`/`release` methods.

On success, the engine sets terminal status and emits it before the `finally`
that awaits `pool.dispose()`. `getStatus()` also exposes that terminal phase
while disposal is pending. The browser releases its UI ownership on terminal
status, while the route retains `active` and the shared owner token until the
engine promise settles. Its `done` event is also written before the route's
ownership-release `finally`.

**Reproduction:** block `pool.dispose()` on a promise. Before releasing it,
the audit fixture observes the emitted `completed` status and
`engine.getStatus().phase === "completed"`.

**Impact:** another operation is enabled locally while the server still rejects
it as busy. Starting it can return 409 and clear the prior displayed result.
On error paths, status also needs scrutiny: `this.status.phase` becomes terminal
before asynchronous terminal persistence has settled, even though workers have
already been drained there. Stream and polling must obey the same release rule.

### F5 — Pair failure explanations disappear from the result and export

**Location:** `ScanVote.error` in `top-raw-scan-worker.ts`, the result contract in
`top-raw-scan-contract.ts`, and result assembly in `top-raw-scan-engine.ts`.

Workers preserve a pair's error text in vote shards, but a normal per-pair
failure does not throw at coordinator level. Result assembly only sets failure
counts, `incomplete_coverage`, and per-asset failed degree; it does not retain
pair identities/reasons. `result.error` is populated only by the outer exception
handler. Browser Copy/Download serialize this result, so they also lose the
underlying explanation.

**Reproduction:** inject `Transient backend error` into a discovery vote. The
audit fixture confirms that the result has no `error` and its serialized JSON
contains none of that explanation; it survives only in the on-disk vote shard.

**Impact:** a scan can fail after substantial work without telling the user which
relationships failed or why. The maintained guide already records a large-list
attempt with thousands of reconstructed-endpoint failures; that failure class
needs actionable diagnostics as well as a withheld ranking.

## Evidence and checks performed

These commands were run through RTK 0.51.0:

```powershell
rtk proxy npm.cmd run validate:changes
rtk proxy npm.cmd run test -- top-raw-scan- --jobs=2
rtk proxy npm.cmd run test -- top-raw-scan-audit-regressions.browser.spec.ts --jobs=1
rtk proxy npm.cmd run test -- batch-balanced-pair-list-generator.spec.ts batch-backtest-service-lifecycle.browser.spec.ts sp500-top-mean-server-plugin.spec.ts feature-dom-contracts.spec.ts --jobs=2
```

- Existing TOP_RAW suite: six spec files passed, zero failures/skips.
- Shared integration checks: four spec files passed, zero failures/skips.
- Audit wrapper: four reproduction cases passed by asserting the current faulty
  behavior. **These are demonstrations, not passing fix/regression tests.**
- No production source, existing specs, dependencies, or template membership
  were changed during the audit. The temporary wrapper was removed after use.
- Audit reproduction source is machine-local:
  `artifacts/top-raw-scan-audit/reproduce.browser.ts`. Its saved log is
  `artifacts/top-raw-scan-audit/reproduction.log`, and summary is
  `artifacts/top-raw-scan-audit/reproduction-summary.json`.
- To rerun that local reproduction, create a temporary
  `tests/top-raw-scan-audit-regressions.browser.spec.ts` containing only
  `import "../artifacts/top-raw-scan-audit/reproduce.browser";`, run the command
  above, then remove the wrapper. The artifacts may not exist in another checkout;
  the scenarios above are sufficient to recreate proper regression tests there.

## Ready-to-use prompt for the repair agent

Repair the five audited Fast TOP_RAW defects F1–F5 described above. Implement
the fixes and their regression tests; do not stop at another plan or a proposed
patch. Preserve the existing uncommitted implementation and unrelated work.

First read `AGENTS.md`, this file, `docs/top-raw-scan.md`, the owning Batch and
synthetic-pair guide sections, and `docs/testing.md`. Run `rtk --version`,
`rtk git status --short` and `rtk proxy npm.cmd run validate:changes`. Use
CodeGraph before targeted source reads. Reconfirm the findings against current
files because this audit's line numbers and baseline can drift. Create/update
a task-specific handoff for implementation continuity.

Use the following acceptance criteria:

1. **F1: honor startup cancellation.** Track cancellation across the entire run
   attempt, including lazy strategy loading and request construction. If Stop
   arrives before dispatch, do not send Run after loading resolves. If admission
   may already be in flight, retain the run id/cancellation intent and use the
   existing scoped Stop/tombstone semantics to prevent a delayed start. Do not
   abort the client connection as a substitute for stopping server-owned work.
   A later deliberate Run must not inherit the previous attempt's cancellation.
   Add a delayed-loader browser test and a cancellation-during-admission test.

2. **F2: align source limits with real planning.** Derive restore bounds from
   shared universe/source limits or validate the per-asset source layout, rather
   than adding an unrelated magic cap. Restore manifests for all supported
   2..5,000-asset universes, including 3,334 and 5,000 daily assets and the 4h
   boundary. Preserve defensive limits and reject genuinely oversized/malformed
   manifests. Cover save/read and restart-status/Resume behavior without running
   thousands of real strategy backtests.

3. **F3: retry failed work within the same frozen snapshot.** Preserve successful
   pair votes but reschedule failed relationships on explicit Resume, validating
   the same configuration, implementation, data revisions, E and orientation.
   Atomically merge/persist recovered records in their deterministic shard slots;
   preserve key/order validation, Stop and crash-recovery safety. Do not count a
   failed vote as flat, silently replace the universe, or advance the evaluation
   candle. If a failure requires a new snapshot rather than a retry, say so
   clearly and offer the existing new Run workflow instead of a no-progress
   Resume. Test discovery and refinement transient failures, failures remaining
   after retry, and interruption during the retry write. Successful cached edges
   must not be needlessly re-executed.

4. **F4: make terminal observation an actual release boundary.** No streamed or
   polled terminal phase may unlock the browser while workers/writers/terminal
   persistence are pending or while shared server ownership still rejects the
   next admitted operation. Coordinate the engine's status publication and
   route-owned token release; cover success, failure, Stop and completed-scan
   reopen. Keep ownership throughout teardown and release only the correct
   generation. Use deferred teardown/persistence fixtures to prove status stays
   nonterminal until safe, then start the next scan or ordinary Batch request
   immediately after observing completion and verify no stale 409. Do not
   merely add an arbitrary browser delay or move a stream event while leaving
   `/status` able to publish early completion.

5. **F5: retain bounded failure diagnostics.** Add a backward-compatible result
   field for grouped failure counts/reasons and bounded pair examples (or an
   equivalently bounded diagnostic contract). Derive it from both fresh and
   cached failed votes. Include it in terminal status, reload restoration,
   browser display and Copy/Download. Explain endpoint/source problems without
   presenting incomplete rankings as completed. Escape rendered text and bound
   payloads; do not send all candle/trade/shard data or tens of thousands of
   duplicated messages to the browser. Test missing-endpoint and transient engine
   failures, cached failures on Resume, normalization of older saved results, and
   export/UI parity. Keep failure counts consistent with evaluated unique pairs.

Keep all other feature contracts intact: raw `TICKER•` input and existing
templates; the full requested universe and sync report; stable versioned
orientation and seed behavior; unweighted current open-position scoring;
ordinary execution/exit/Rust-fallback semantics; frozen discovery estimates;
exact finalist scores only with full coverage; approximate global labels unless
the whole universe is proved; authenticated local routes; and shared Batch,
TOP_MEAN and Finder-sweep single-flight ownership. Do not fix recovery by
silently dropping symbols or loosening missing-data checks.

Add the desired-behavior regressions to the owning focused specs. The audit
artifact assertions intentionally expect defects and must not be copied as
passing repair tests. Update the maintained guide for changed retry/publication
semantics and failure exports. Use versioned persisted-JSON migration/normalizers
where shapes change; keep old results readable.

Run focused TOP_RAW specs plus affected Batch lifecycle/router/persistence and
DOM checks, both typechecks, and the required validation router checks. Extend
browser E2E for startup Stop and immediate reuse after terminal completion if
those cases need real browser integration. Run the repository-required broad
JS/build and E2E gates before reporting delivery complete; follow Rust policy
if shared simulation/Rust behavior is touched. Preserve logs and distinguish
existing baseline failures from regressions.

Keep CPU work bounded (one or two test jobs initially, no repeat large-universe
benchmarks just to demonstrate these deterministic bugs). If performance evidence
requires worker execution, use an explicit small worker count and record it.
Finish with the fixed findings, changed files, exact checks/results, and any
remaining limitations. Do not claim a full revalidation from focused tests alone.
