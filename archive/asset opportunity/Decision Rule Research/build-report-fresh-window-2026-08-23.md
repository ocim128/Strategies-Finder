# Fresh-Window Research Infrastructure Build Report

Date: 2026-08-23
Repository: `Strategies-Finder`
Status: Phases 0–5 implemented and fixture-validated; Phase 6 real-data execution was not run.

## Executive result

The requested additive infrastructure is implemented in six phase commits. The
legacy Asset Opportunity path remains the default when `researchProgram` is
absent, while fresh-window artifacts resolve to `archive/fresh-window`.

No fresh-window archive existed during this build, so this report makes no
claim about a trading rule. The analyzer correctly refuses to issue a verdict
when the archive is absent or fails S0.

There is one material pre-Phase-6 protocol gap: the production batch request
accepts one `foldEnd` for the whole holdout sweep, while the Phase 5 S0 gate
requires 25 distinct point-in-time fold ends and disjoint forward intervals.
A normal one-request `12..300` sweep will therefore be archived but fail S0
until the operator supplies an orchestration that produces those distinct
folds. This is recorded as a deviation rather than hidden in the analyzer.

## Phase summaries and commits

| Phase | Commit | Result |
|---|---|---|
| 0 | `59ff42ab` | Added the persisted Finder checkbox, allowlisted `fresh-window` request field, legacy/fresh archive resolver, status/config program identity, and validation tests. |
| 1 | `003348ce` | Added validated timestamp fold bounds, inclusive search slicing, strictly-later forward slicing, leakage guards, fold metadata, and tests. |
| 2 | `6978b7f1` | Captured every evaluated TypeScript candidate before top-K reduction, emitted ordered scalar worker chunks, wrote fold identity artifacts, disabled Rust for fresh capture, and added collision/round-trip tests. |
| 3 | `e6f51442` | Added the execution-unit forward contract, TP/SL/horizon outcomes on full-pool rows, risk-target resolution, and hand-computed/parity fixtures. |
| 4 | `1e68754a` | Added full identity digests, provider/engine/config metadata, INVALID judgment markers, and full-pool pair context. |
| 5 | `93799658` | Added the S0-first analyzer, time-to-TP/recurrence/strategy-gate judgments, golden fixtures, and Windows launchers. |

The implementation did not modify the closed-window analyzers or
`lib/strategies/trend-confirmation-*`. The supplied planning document and the
pre-existing `scripts/scratch-audit-2026-08-23.py` remain uncommitted user
files.

## Required entry checks

### Phase 2 compact executor path

The original server search call requests `compact: true` and `trades: false`.
That compact result does not provide the trade path needed for TP counts or
time-to-TP. Fresh-window mode therefore sets `trades: true` in the TypeScript
candidate call, immediately reduces the returned trades to scalar fields, and
then lets the ranker retain only its bounded top-K result set. Failed candidate
evaluations also produce a scalar identity row.

No trade arrays cross the worker callback or are written to the archive.

### Rust decision

Fresh-window capture preregisters the TypeScript path by bypassing the Rust
batch branch and recording an effective TypeScript engine in the identity.
This avoids claiming parity for full-pool path scalars that Rust does not yet
emit. Legacy runs retain their existing engine selection.

### Execution-rule extraction decision

The execution contract is a new Node-safe leaf,
`lib/finder/finder-asset-opportunity-forward-contract.ts`. It implements the
locked first-touch rules and was checked against the TypeScript engine on a
fixed percentage TP/SL fixture. It does not call the full executor in a
one-trade fallback, and the exit-handler implementation was not extracted into
one shared function. This is an explicit deviation from the preferred
“shared seam or one-trade fallback” wording: parity is fixture-verified, but
not structurally guaranteed by one implementation. A real judged run should
not be authorized if additional engine semantics beyond the covered contract
are enabled.

## Benchmarks

Command:

```text
..\..\..\node_modules\.bin\esno scripts\scratch-fresh-window-research-benchmark.ts
```

The benchmark uses the full scalar row shape, including all three forward
outcome objects, and 256-row chunks.

| Evaluated rows | JSON bytes for one fold | Chunks | Structured-clone time for all chunks | Forward calls | Forward compute time |
|---:|---:|---:|---:|---:|---:|
| 5,800 | 4,175,154 | 23 | 25.98 ms | 17,400 | 7.96 ms |
| 8,600 | 6,191,331 | 34 | 31.80 ms | 25,800 | 4.64 ms |

The measured forward microbenchmark was approximately 0.46 and 0.18 μs per
call respectively; this is a JIT-sensitive synthetic measurement, not a
production latency guarantee. The rows are accumulated per in-flight task and
flushed after completion, not retained as one run-wide array. At the measured
size, 289 holdout artifacts imply roughly 1.21–1.79 GB of append-only text on
disk if every holdout is captured at that density; this is disk volume, not
simultaneous heap retention.

The archive writer performs one injected/default `appendFile` operation per
block and fails the research-primary identity append through the existing
batch archive-fatal path. It does not add an explicit `fsync` or transactional
rename, so crash-consistency stronger than the existing append precedent is
not claimed.

## Analyzer behavior

`scripts/analyze-fresh-window-research.ts` reads only the fresh identity
artifacts for fresh judgments. It:

- runs S0 before any judgment section;
- requires 25 stride-12 holdouts, distinct fold ends, non-overlapping forward
  intervals, tuple-hash integrity, full-pool rows, finite execution outcomes,
  all three exit classes, deterministic seed-42 controls, and the locked
  `evalLastBars=1000`, `oosIgnoreLastBars=26`, `[12,18,24]` settings;
- computes time-to-TP from the fixed ≥3-TP median field against a random
  eligible full-pool draw and kills on the registered mean/sign/verdict/
  chronological-half conditions;
- computes recurrence only from strictly earlier fold-end snapshots and
  reports `INSUFFICIENT DATA` below 5%;
- applies the fixed distinct-strategy-count ≥3 gate, the <10% coverage kill,
  and chronological-half ungated-increment kill;
- emits the old visible-pool count only as a labeled diagnostic.

The analyzer’s missing-data behavior is exclusion plus a reported S0 failure;
missing outcomes are never zero-filled. The archive’s latest parseable block
per holdout supersedes an earlier block by timestamp.

## Validation transcript

All commands were run from the repository root on Windows PowerShell with the
repository’s `esno` path.

```text
npm run typecheck
PASS — tsc --noEmit

..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
PASS — 48 tests

..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
PASS — 80 tests

..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts
PASS — 15 tests

..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts
PASS — 13 tests

..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-fold.spec.ts
PASS — 4 tests

..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-forward-contract.spec.ts
PASS — 7 tests

..\..\..\node_modules\.bin\esno tests\analyze-fresh-window-research.spec.ts
PASS — 4 golden tests
```

The analyzer fixture suite covers S0 success, both-halves time-to-TP kill,
strategy-coverage kill, recurrence insufficiency, and identity-hash rejection
with no later verdict output. Running the CLI against a missing archive also
fails before S0 with a nonzero exit code.

## Deviations and required amendments before Phase 6

1. **Distinct fold schedule is not wired into one batch request.** The
   request/payload and worker task carry one validated `foldEnd`. The holdout
   loop changes `oosIgnoreLastBars`, but does not derive a different calendar
   fold end for each holdout. The run-scoped dataset cache consequently reuses
   the same sliced dataset, which is correct for one declared fold but cannot
   produce 25 historical snapshots. Before a judged batch, either add an
   explicit holdout-to-fold-end schedule with a fold-aware cache key, or run a
   separately orchestrated set of valid fold snapshots and teach the collection
   layer/analyzer to combine them without weakening identity checks.

2. **The browser toggle does not select `foldEnd`.** It selects the fresh
   namespace only. A direct request or future operator orchestration must send
   a valid `foldEnd`; otherwise Phase 4 intentionally archives the run as
   `INVALID`. `FINDER_DATA_SYNC_SNAPSHOT` and `GIT_COMMIT` must also be set to
   real values rather than the `unknown` fallback for a valid judgment.

3. **Timestamp slicing is a new fold-boundary helper.** The existing
   `sliceFinderDataWindow` family is positional (`all`, fraction, or recent
   bars) and cannot express an inclusive timestamp cutoff. The implementation
   uses a separate timestamp-boundary helper with the same pure-slice/guard
   pattern and leaves the legacy positional behavior unchanged. This should be
   consolidated only if the fold schedule amendment provides a safe shared
   seam.

4. **Execution semantics are fixture-parity, not code-shared.** The pure
   contract covers the preregistered percentage TP/SL next-open path, stop-first
   same-bar handling, stop gap fill, horizon censoring, missing candles,
   slippage, commission, and long/short direction. It has not been proven for
   every optional engine feature. The fresh identity gate should remain
   restricted to the pinned settings until a shared exit seam or one-trade
   executor comparison is added.

5. **The random control is reproducible from archived full-pool rows rather
than stored as a separate control scalar.** This keeps the archive scalar
and append-only, and S0 recomputes it with seed 42. A later audit may add a
stored per-fold control summary, but it must remain a diagnostic of the same
full eligible pool rather than the old visible top-10 union.

## Operator checklist

Before any fresh data run:

1. Restart the Vite dev server after these server-side metric changes. Use the
   repository’s normal command with the documented heap budget, for example
   `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`.
2. Confirm the sync log, data-source/cache digest, exact 679-symbol list,
   exact 45 strategy keys, pinned commit, `FINDER_DATA_SYNC_SNAPSHOT`, and
   `GIT_COMMIT`.
3. Confirm the request carries the exact agenda settings, especially
   `evalLastBars=1000`, `oosIgnoreLastBars=26`, horizons `[12,18,24]`,
   next-open TP2/SL2, 10 bps slippage, and 0.1% commission.
4. Enable “Fresh-window research mode” in the Finder AO panel. Ensure the
   request/orchestration supplies `foldEnd`; the checkbox alone deliberately
   cannot make a run valid.
5. Run a tooling smoke check before data collection:

```text
npm run typecheck
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
```

6. Once a valid 25-fold archive exists, run the S0-first judge:

```text
..\..\..\node_modules\.bin\esno scripts\analyze-fresh-window-research.ts --archive-dir "archive\fresh-window" --stride-bars 12 --horizon 12 --seed 42
```

The launcher at
`archive/asset opportunity/Decision Rule Research/analyze-fresh-window-research.bat`
defaults to the same `archive\fresh-window` namespace. Do not read or act on
time-to-TP, recurrence, or strategy-gate lines unless the output says
`S0: PASS`. A tooling smoke run is not a research verdict.

## Final ruling

Phases 0–5 are buildable and validated as additive infrastructure, with the
explicit execution-contract and append-atomicity caveats above. The code is
not yet ready to declare the next real batch a judged experiment because the
current production batch has no one-request schedule for 25 distinct
point-in-time fold ends. Until that protocol is amended and verified, the
correct status is **tooling complete, Phase 6 blocked, no rule conclusion**.

## Rework report (R1–R6, 2026-08-23)

The audit rework is complete in six isolated item commits plus the narrow
long-direction/S0 hardening follow-ups `eafec5a1` and `8cfedb84`. No real batch was run; Phase 6
remains operator-blocked.

| Item | Change | Audit sections resolved |
|---|---|---|
| R1 `8c3190a4` | Fresh judgment now accepts only `next_open`, percentage TP/SL, and `allowSameBarExit=false`; validation rejects other models, first-touch uses the engine’s relative tolerance, and forward archives carry gross return, slippage, commission, and entry/exit timestamps as separate scalar fields. | B6, execution-contract item 4 |
| R2 `317764c1` | Fresh requests require the explicit 25-entry schedule. Each task receives its own `foldEnd`; raw symbol/interval data is cached and sliced per fold, including the forward loader. | B4, B10.1 |
| R3 `1f1e01fa` + `eafec5a1` + `8cfedb84` | Fresh provenance (`GIT_COMMIT`, `FINDER_DATA_SYNC_SNAPSHOT`) and configuration persistence fail closed. S0 rejects invalid fold judgments, validates the pinned long-direction settings and interval, requires complete fold bounds, and compares independent expected/archived/valid-outcome counts. Seed 42 and its draw digest are archived. | B3, B7 |
| R4 `735d502d` | Time-to-TP selects lowest `medianBarsToTP` with at least three TP hits and judges selected-minus-control execution net. Recurrence counts exact tuples across strictly earlier fold ends and has collection/judged/replication gates. Strategy coverage uses eligible rows and eligible-pair denominators with the fixed `>=3` and `<10%` rules. | B8, agenda items 1–3 |
| R5 `1fdffd6a` | Fresh summary retention is capped at 100,000 scalar rows per task; overflow is fatal. Research blocks are written in one write, synced, and terminated by `Record complete: true`; the analyzer rejects any block without that final marker. | B5, B9 |
| R6 `be5e3982` | Added legacy absent-fold copy and loader-parity regressions, plus timestamp/positional slicing coverage for mixed representations, duplicate timestamps, and irregular gaps. | B2, B10.3 |

### Acceptance fixtures

The auditor’s adversarial cases now fail closed or select the registered rule:

- The `next_close` mismatch is no longer judgeable: fresh request validation
  rejects it, while the pinned `next_open` engine-parity fixtures pass.
- An `INVALID` fold marker produces `S0: FAIL` and no downstream verdict.
- Missing forward outcomes below 95% coverage produce `S0: FAIL` with an
  explicit coverage error rather than silent exclusion.
- The PF-versus-median-bars fixture exercises the median-bars execution-net
  judge; the old bars/control wording is absent.
- A high-density recurrence fixture selects the prior-fold recurring tuple and
  emits the required collection → judged → replication budget line.
- Failed/ineligible strategy rows do not inflate distinct-strategy coverage;
  the fixed eligible-pair denominator yields the expected coverage kill.
- A trailing partial identity block is ignored by the parser, reducing the
  fold count and suppressing all verdict sections.
- The retention-cap test accepts exactly 100,000 rows and rejects the next
  append without growing the target.

### R2 cache decision and benchmark

The selected R2 design caches raw plain datasets by `symbol|interval` and
performs the timestamp slice separately for each fold. This preserves one
successful plain-dataset load per run while preventing the first fold’s slice
from leaking into later folds. The existing benchmark order of magnitude was
reproduced before the rework: 5,800 scalar rows serialized to 4,175,154 JSON
bytes in 23 chunks and 8,600 rows to 6,191,331 bytes in 34 chunks; the
corresponding forward-outcome call counts were 17,400 and 25,800. These are
serialization/leaf benchmarks, not a production 679-symbol batch.

The added synthetic 679-symbol/45-strategy scalar-retention benchmark used
30,555 rows with the complete three-horizon outcome shape: 36,540,581 JSON
bytes and a 44,465,352-byte (42.41 MiB) V8 heap delta. It is a retention
ceiling check for the scalar identity path, not an OHLCV-memory measurement;
the R2 raw cache retains one successful dataset per symbol and never 25 fold
copies. A production run must still be observed with the documented heap
budget before Phase 6 is opened.

### Final validation

`npm run typecheck` passed. The complete fresh-window suite passed after each
rework commit and after the S0 hardening follow-up: feature-DOM contracts, Finder server plugin,
parallel batch, archive, fold, forward-contract, and fresh-window analyzer.
The final focused counts were 48, 82, 17, 13, 7, 8, and 10 passing tests,
respectively. Existing untracked audit scratch files and the user’s plan
document were preserved. No closed-window analyzer/archive, trend-confirmation
module, or real batch was modified/run.

### Updated operator checklist

Before Phase 6, the operator must:

1. Start a fresh Vite process with the documented heap budget and verify the
   server is running the final rework commits.
2. Confirm the exact 679-symbol universe, 45 strategy keys, data-sync snapshot,
   git commit, provider map, and pinned `next_open` TP2/SL2 settings.
3. Supply all 25 explicit fold schedule entries in the fresh request; the UI
   mode alone is not sufficient. Verify each task’s archived fold end is
   distinct and its search/forward bounds satisfy `search <= fold < oos`.
4. Confirm config and identity writes succeed. Treat any missing completion
   marker, expected-count line, outcome coverage below 95%, or `INVALID`
   judgment as a fatal archive, not a partial research result.
5. Run the full fresh-window suite and inspect the S0 control trace before the
   first data batch. Do not run a real batch until the operator explicitly
   opens Phase 6.
6. Judge only archives whose analyzer output says `S0: PASS`; require the
   registered verdict bars, chronological-half signs, recurrence budget, and
   the later untouched replication before any promotion.

## Final rework report (F1–F4, 2026-08-24)

The final re-audit identified four remaining flaws. Each was fixed in its own
commit and converted into a permanent regression case. No real batch was run,
and the closed-window analyzers, archives, backtest engine, and
`trend-confirmation-*` modules were not modified.

### F1 — end-of-data parity

Audit mapping: re-audit issue 1 / C1.

Before the fix, the exact re-audit case disagreed at an uncensored forced
close: the engine produced `exitPrice=100` and
`pnlPercent=-1.1891089108910853`, while the forward contract applied exit
slippage and produced `exitPrice=99` and
`netReturnPercent=-2.178217821782178`. The contract now uses the raw final
close and no exit slippage for the end-of-data path, matching the current
engine policy. The engine itself was left unchanged. The exact pinned
`next_open`, 100-bps-slippage, 0.1%-commission case and a no-slippage variant
now pass in `finder-asset-opportunity-forward-contract.spec.ts`.

The semantic values match the engine. The parity assertion allows only the
sub-1e-14 IEEE-754 operation-order residue caused by the engine multiplying
per-share P&L by allocated share count before division while the contract
computes the equivalent per-unit return; exit reason and exit price remain
exact. Whether live forced closes should charge slippage remains an open
engine-policy question and was intentionally not changed here.

Commit: `1ea21abd fix(fresh-window): F1 align end-of-data close semantics`.

### F2 — producer-archived control trace

Audit mapping: re-audit issue 2 / C3.

Before the fix, the archive stored seed 42 but not the producer’s actual
per-fold draw. The analyzer could therefore recompute a draw from the
archived rows without proving that it was the draw used during production.
The producer now archives, inside each fold identity block, the selected
control tuple identities and a digest of the draw sequence. S0 independently
recomputes the seed-42 draw from the archived row order and requires both the
identity list and digest to match; missing or mismatched trace data fails S0
before any verdict is emitted. The permanent archive/analyzer regression
reorders rows after the trace was recorded and confirms that the trace check
fails.

Commit: `0ab0b4fd fix(fresh-window): F2 archive producer control traces`.

### F3 — recurrence budget as enforced state

Audit mapping: re-audit issue 3 / C4.

Before the fix, a one-run high-density archive could print
`collection=PASS, judged=PASS` even though no earlier valid collection
archive existed; recurrence authorization was advisory text. The archive
identity now carries a validated operator-supplied role:
`collection`, `judged`, or `replication`. S0 blocks a judged run without a
strictly earlier valid collection archive and blocks replication without the
required earlier judged archive. Collection-only output cannot claim
`judged=PASS`, and unauthorized recurrence produces no recurrence verdict.
The permanent exact high-density one-run fixture now fails S0 and emits no
judged pass.

Commit: `d9b186d2 fix(fresh-window): F3 enforce recurrence batch roles`.

### F4 — timestamp validation

Audit mapping: re-audit issue 4 / C1/C3 timestamp integrity.

Before the fix, malformed or out-of-order entry/exit timestamps could pass S0.
S0 now parses both timestamps, rejects non-timestamp values, rejects
`entry > exit`, and rejects timestamps outside the fold’s declared OOS bounds.
Permanent invalid-timestamp and out-of-order fixtures both fail S0 before
downstream time-to-TP or recurrence judgments.

Commit: `ff2d5c2d fix(fresh-window): F4 validate outcome timestamps`.

### Final verification evidence

The final transcript completed with zero failures:

```text
feature-dom-contracts                         48 passed
finder-server-plugin                          83 passed
finder-asset-opportunity-batch-parallel       17 passed
finder-asset-opportunity-archive              13 passed
finder-asset-opportunity-fold                  7 passed
finder-asset-opportunity-forward-contract     15 passed
analyze-fresh-window-research                 14 passed
vite-config-bundle                             1 passed
npm run typecheck                              PASS
git diff --check                               PASS
```

### Updated operator checklist

1. Run the full fresh-window suite, the Vite-config bundle check, and
   `npm run typecheck` before collecting data. Do not open a real batch on a
   failing S0/control-trace test.
2. Supply a valid `batchRole` on every fresh request. Use `collection` for
   collection-only work; use `judged` only when a strictly earlier valid
   collection archive exists; use `replication` only after the required
   judged archive exists.
3. After each archive, verify every fold identity contains the seed-42 draw
   identities and digest, and require S0 to report PASS. A missing trace,
   reordered rows, malformed timestamp, out-of-order timestamp, or
   out-of-bounds timestamp is a fatal archive condition.
4. Treat collection output as collection evidence only. It must never be
   promoted or described as a judged PASS. Recurrence and downstream rule
   verdicts are read only after S0 authorization.
5. Keep the current engine’s forced-close behavior as the parity baseline.
   The question of changing live slippage policy requires a separate,
   explicitly registered engine-policy decision.
6. Record the four fix commits with the archive and preserve the re-audit
   fixtures. No real batch or push was performed during this rework.

### Coverage closure

The final audit C2 scratch cases are now permanent:

- C2-1: `rejects a missing producer control trace in S0`.
- C2-2: `rejects a forward entry timestamp outside the declared fold bounds`.
- C2-3: `passes S0 and keeps legacy rows diagnostic-only` now asserts collection
  output is `Recurrence: NOT AUTHORIZED` and never contains `judged=PASS`.
- C2-4: `blocks a replication archive without a prior valid judged archive`.
- C2-5: `rejects each one-field frozen-settings drift in S0` covers the five
  required single-field mutations.
- C2-6: `matches the engine on a TP touch at the final available bar`.
- C2-7: `re-slices a cached raw dataset for each fold` locks the two-fold
  raw-cache counts and fold-specific slices.

Validation after promotion: feature-DOM 48, Finder server 83, batch parallel
18, archive 13, fold 7, forward contract 16, fresh-window analyzer 18, and
Vite-config bundle 1; 204 tests passed, with `npm run typecheck` also passing.

### Smoke defect fixes

The live six-symbol smoke archive was invalid research data and was not used
as evidence. Its three S0 failures mapped to these fixes:

- **S1 - forward-window geometry** (`602403d8`): fresh mode now caps each
  forward slice at `FINDER_ASSET_FRESH_FOLD_STRIDE_BARS` (12 bars). The shared
  builder places the 25 fold ends from `dataEnd - 25 * 12 bars` through
  `dataEnd - 12 bars`, so each recorded OOS interval is disjoint and the last
  fold still has a complete forward window. This is the selected geometry
  because the analyzer's locked schedule requires 12-bar spacing and the
  12-bar forward target; the declared 18/24-bar horizons remain recorded but
  are censored at the fresh fold boundary. Legacy calls without `foldEnd`
  retain uncapped behavior.
- **S2 - expected row count** (`a02d124d`): the worker event and worker-pool
  reconstruction now preserve `expectedCandidateSummaryRows`, so real fold
  identity headers carry the independent evaluated count instead of
  `unknown`.
- **S3 - candidate identity** (`2d2a3626`): zero-parameter candidates now
  receive the stable non-empty fingerprint `default`; this satisfies the
  tuple identity contract without changing the candidate parameters or
  ranking.
- **S4 - real pipeline coverage** (`03c0c1ca`):
  `tests/finder-fresh-window-integration.spec.ts` generates temporary archives
  through `processFinderAssetOpportunityBatchRun`, runs the actual analyzer,
  and covers both sequential and real `worker_threads` execution. Both
  cases passed with:

  ```text
  S0: PASS
  S0 windows=25, fullPoolRows=150, eligibleRows=150, finiteExecutionRows=150, randomControls=25
  S0 hand checks: TP=50, SL=50, horizon=50
  Recurrence: NOT AUTHORIZED (collection archive; judged role requires a prior collection)
  ```

- **S5 - shared schedule builder** (`f6941310`):
  `scripts/fresh-window-batch-request.ts` now uses
  `buildFreshFoldScheduleFromDataEnd(...)` rather than maintaining separate
  fold arithmetic.
- **S6 - smoke cleanup**: the 76 files under `archive/fresh-window/` were
  deleted locally because they were produced before these fixes. The empty
  directory is not research evidence and no deletion was committed to a
  tracked archive path.

Validation for this rework: feature-DOM 48, Finder server 84, batch parallel
18, archive 13, fold 9, forward contract 16, analyzer 18, and the real
producer integration 2; Vite-config bundle 1; `npm run typecheck` PASS. No
real batch or push was performed.

### Round-3 smoke fixes

The second live smoke exposed two remaining S0 failures that the dense S4
fixture could not expose: real fold intervals were 43 bars wide despite being
spaced 12 bars apart, and only about 47% of evaluated candidates could have a
forward outcome because most had no fresh signal at the fold boundary.

#### T1 - exact stride-window geometry

Fresh mode now records and slices the declared calendar interval
`(foldEnd, foldEnd + 12 * barSeconds]`. The OOS start and end in every identity
block come from that declared interval, not from the minimum and maximum
timestamps observed across asset-specific forward slices. With the shared
25-entry schedule, adjacent intervals are therefore disjoint by construction.
Missing calendar bars remain missing; they are not synthesized or compressed
into positional bars. Legacy calls without `foldEnd` retain their previous
uncapped forward behavior.

The locked decision for the configured 18- and 24-bar horizons is
exclude-by-missingness: fresh forward capture emits only the 12-bar horizon,
because the declared judged window is one stride wide. The config remains the
frozen `[12,18,24]` record, but S0 judges horizon 12 only and makes no claim
from absent 18/24 outcomes. A wider-horizon experiment would require a new
schedule and a separate preregistration.

#### T2 - eligible-outcome denominator

Each fresh candidate summary now carries `forwardOutcomeEligible` only when a
fresh boundary signal exists and its entry can be placed in the forward slice.
The producer counts those rows as `Expected eligible outcome row count` and
threads the count through both worker paths into the archive identity block.
`Forward outcome row count` remains the number with a valid 12-bar outcome.

S0's 95% gate is now `outcomeRowCount / expectedOutcomeRowCount`. The old
all-evaluated denominator is retained as a diagnostic only, so a real sparse
signal population is not incorrectly treated as a producer failure.

#### T3 - realistic producer-to-analyzer integration

`tests/finder-fresh-window-integration.spec.ts` now creates six 4-hour fixture
assets with weekend calendar gaps, one continuous-calendar asset, additional
per-asset missing bars, different forward-slice widths, and sparse boundary
signals. It produces the archive through the real batch request path, runs the
actual analyzer, and exercises both the sequential and worker-thread paths.
Both paths produce this locked result:

```text
S0: PASS
S0 windows=25, fullPoolRows=150, eligibleRows=150, finiteExecutionRows=52, randomControls=25
S0 coverage: eligible-outcomes=52/52, all-evaluated=34.67%
S0 hand checks: TP=47, SL=1, horizon=4
Recurrence: NOT AUTHORIZED (collection archive; judged role requires a prior collection)
```

The 52/52 eligible coverage proves the eligible denominator is wired
correctly; the independent 52/150 (34.67%) all-evaluated diagnostic proves
the integration no longer relies on every evaluated candidate having a
forward outcome. The fixture also fails its own preflight if calendar gaps or
different forward widths disappear.

#### T4 - operator schedule path

The operator script already uses the shared
`buildFreshFoldScheduleFromDataEnd(...)` helper, so no separate schedule math
was left to drift in this round.

#### T5 - smoke artifact cleanup

The 76 invalid files under `archive/fresh-window/` from the round-2 smoke were
cleared locally. The directory is empty, and no tracked archive deletion was
made. No real batch was run during this round.

#### Validation and live rerun

Validated with:

```text
..\..\..\node_modules\.bin\esno tests\analyze-fresh-window-research.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-fold.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-forward-contract.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-fresh-window-integration.spec.ts
..\..\..\node_modules\.bin\esno tests\vite-config-bundle.spec.ts
npm run typecheck
```

All passed: analyzer 18, fold 10, archive 13, forward contract 16,
batch-parallel 18, server 84, integration 2, Vite bundle 1, and TypeScript
typecheck.

For the final live collection smoke, use two PowerShell windows. In the first,
set real provenance from the sync just completed and start the server:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=16384"
$env:FINDER_ASSET_BATCH_WORKERS = "2"
$env:FINDER_DATA_SYNC_SNAPSHOT = "<actual sync-log timestamp>"
$env:GIT_COMMIT = (git rev-parse HEAD).Trim()
npm run dev
```

In the second, use the copied Finder configuration and a synced reference CSV
whose last timestamp is the data end used for the universe:

```powershell
$configPath = (Resolve-Path "<path to Copy Configuration JSON>").Path
$csvPath = (Resolve-Path "<synced reference 4h CSV>").Path
..\..\..\node_modules\.bin\esno scripts\fresh-window-batch-request.ts `
  --config $configPath `
  --csv $csvPath `
  --role collection `
  --interval 4h `
  --base-url http://127.0.0.1:5173
```

After the stream closes, judge only with:

```powershell
..\..\..\node_modules\.bin\esno scripts\analyze-fresh-window-research.ts `
  --archive-dir "archive\fresh-window" `
  --stride-bars 12 `
  --horizon 12 `
  --seed 42
```

The collection smoke must show `S0: PASS`, disjoint 12-bar OOS bounds,
eligible-outcome coverage at least 95%, and
`Recurrence: NOT AUTHORIZED`. Do not read any downstream verdict from a
collection archive.

### Round-4 fix

#### U1 - bar-index fold anchoring

`buildFreshFoldScheduleFromDataEnd(...)` now accepts the strictly ascending
timestamps of an actual reference candle series. It selects 25 fold ends at
12-reference-bar intervals, and each `foldEnd` is therefore a timestamp that
exists in that series. The final fold leaves 36 real reference bars after its
boundary: the 12-bar judged stride plus the widest recorded 24-bar horizon.
Each entry records `oosStart` as the next reference bar and `oosEnd` as the
12th following reference bar. A reference series shorter than 325 bars throws
instead of silently compressing the schedule.

Fresh forward slicing and archive metadata use those declared timestamp
bounds. They no longer derive a fold's OOS window from wall-clock arithmetic
or from the min/max forward slice observed across assets. Legacy paths without
`foldEnd` retain their previous slicing behavior. The operator script now
parses every timestamp in its reference CSV and passes that series to the
shared builder.

#### U2 - weekend-realistic proof

The real producer-to-analyzer integration fixture now starts with 720 nominal
4-hour slots, removes UTC weekend bars and one irregular holiday bar, keeps
one asset on the continuous calendar, and removes additional bars at
per-asset 17/23/31-slot patterns. Its sparse boundary signals and differing
asset widths are otherwise processed by the production batch paths.

Both sequential and `worker_threads` runs produced the same valid result:

```text
S0: PASS
S0 windows=25, fullPoolRows=150, eligibleRows=150, finiteExecutionRows=49, randomControls=25
S0 coverage: eligible-outcomes=49/49, all-evaluated=32.67%
S0 hand checks: TP=32, SL=3, horizon=14
Recurrence: NOT AUTHORIZED (collection archive; judged role requires a prior collection)
```

The test additionally reads every one of the 25 identity files and requires a
positive forward-outcome count. Running the old wall-clock schedule against
the same gapped datasets fails with
`S0 ERROR: full-pool random control is missing in one or more windows` and a
zero-outcome fold. That paired failure demonstrates that the fixture can
detect the original live bug rather than merely accepting the corrected code.

#### U3 - analyzer sanity

S0 now compares archive OOS bounds with the declared schedule markers, checks
each outcome against those recorded bounds, and checks interval overlap using
the actual timestamps. The removed check that reconstructed
`foldEnd + intervalSeconds` and `foldEnd + stride * intervalSeconds` was the
remaining wall-clock assumption; no uniform-calendar arithmetic is used for
fresh fold validation.

#### Round-4 validation and live rerun

Passed from the repository root:

```text
..\..\..\node_modules\.bin\esno tests\analyze-fresh-window-research.spec.ts  (18)
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts  (13)
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts  (18)
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-fold.spec.ts  (11)
..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-forward-contract.spec.ts  (16)
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts  (84)
..\..\..\node_modules\.bin\esno tests\finder-fresh-window-integration.spec.ts  (3)
..\..\..\node_modules\.bin\esno tests\vite-config-bundle.spec.ts  (1)
npm run typecheck
```

The invalid local `archive/fresh-window` smoke artifacts were cleared again;
no tracked archive deletion was made. No real batch or push was performed.
For the operator's next live acceptance, use the existing Round-3 commands
with the current provenance values: start with
`NODE_OPTIONS=--max-old-space-size=16384`, `FINDER_ASSET_BATCH_WORKERS=2`,
`FINDER_DATA_SYNC_SNAPSHOT=<actual sync-log timestamp>`, and
`GIT_COMMIT=(git rev-parse HEAD).Trim()`, then run
`scripts/fresh-window-batch-request.ts --config <copied config JSON> --csv <synced reference 4h CSV> --role collection --interval 4h --base-url http://127.0.0.1:5173`.
After it completes, run
`scripts/analyze-fresh-window-research.ts --archive-dir archive\fresh-window --stride-bars 12 --horizon 12 --seed 42`.

### UI completion

Fresh-window collection can now be started from the Finder Asset Opportunity
panel without the operator request script or provenance environment variables.
The browser sends `researchProgram: "fresh-window"`, the persisted
`batchRole`, and `scheduleMode: "auto"`; it does not calculate timestamps.
The operator must enable Batch OOS, set the frozen fresh-window range to
12..300, enable Fresh-window research mode, choose the role, and start the
batch from the UI.

The server uses this fail-closed provenance precedence:

1. A non-empty, non-`unknown` `FINDER_DATA_SYNC_SNAPSHOT` environment value
   wins; otherwise the newest valid candle timestamp from the first normalized
   request symbol's reference dataset is recorded.
2. A non-empty, non-`unknown` `GIT_COMMIT` environment value wins; otherwise
   `git rev-parse --short HEAD` is derived once and cached for the server
   process.
3. If either value cannot be provided or derived, the request is rejected with
   the existing 400 provenance error. The resolved values and the composed
   25-entry bar-anchored schedule are written into the fresh identity block.

The explicit `foldSchedule` contract remains unchanged for the operator
script and other callers. `scheduleMode: "auto"` selects the shared builder,
which anchors folds to real reference-candle timestamps and applies the same
36-bar reserve and short-data guard as the existing schedule builder.

#### Pure-UI operator checklist

1. Start the normal Vite development server (`npm run dev`); no
   `FINDER_DATA_SYNC_SNAPSHOT` or `GIT_COMMIT` export is required. Use the
   existing Node heap setting only when the selected universe needs it.
2. Sync the intended reference data and open Finder → Asset Opportunity.
3. Enable **Batch OOS**, set Start `12` and End `300`, then enable
   **Fresh-window research mode**.
4. Choose `Collection` for a new data window. Use `Judged` or `Replication`
   only after the analyzer's prior-archive gate permits that role.
5. Start the batch. Confirm the archive identity contains the derived or
   explicitly overridden provenance and the 25 composed fold entries.
6. Run the S0-first analyzer after the batch closes; do not read any verdict
   below `S0: PASS`, and never judge a collection archive.

`start-fresh-server.bat` and `run-fresh-collection.bat` remain optional
compatibility launchers. They still exercise the explicit-schedule contract;
the browser path no longer depends on either launcher.

#### UI-completion validation

The fresh-window eight-suite transcript passed with 213 tests:

```text
feature-dom-contracts.spec.ts                     48
finder-server-plugin.spec.ts                      88
finder-asset-opportunity-batch-parallel.spec.ts   18
finder-asset-opportunity-archive.spec.ts          13
finder-asset-opportunity-fold.spec.ts             11
finder-asset-opportunity-forward-contract.spec.ts 16
analyze-fresh-window-research.spec.ts              18
vite-config-bundle.spec.ts                          1
```

Additional UI and real-pipeline checks passed with 11 browser lifecycle tests
and 4 fresh-window integration tests (sequential auto schedule, worker auto
schedule, invalid judged role gating, and the old wall-clock negative case).
`npm run typecheck` also passed. No real batch or push was performed.

## Fresh-window removal (2026-08-25)

The operator permanently cancelled the fresh-window research program. Removed:

- Fresh-only fold scheduling/slicing, forward execution-contract simulation,
  candidate-summary/control-trace capture, identity/provenance/schedule
  plumbing, fresh archive namespace, fold metadata, and worker summary
  retention/chunk transport.
- The Finder Fresh-window toggle and batch-role selector, their DOM contract,
  persistence, request fields, analyzer/operator scripts, fresh-only specs,
  integration fixtures, scratch audit fixtures, docs, README index entry, and
  AGENTS contract section.
- The fresh-window analyzer launchers; `archive/fresh-window` remains absent.

Kept unchanged: legacy AO/Finder execution and archives, auto `config.txt`
capture, pair summaries, the `captureTradeFilter` fix, normal fresh-entry
behavior (including its Rust batch seam), `analyze-asset-opportunity-stability.ts`,
`start-fresh-server.bat`, the Decision Rule Research journal, and legacy
archives.

Final working-tree line-count delta from HEAD: **124 added, 6,868 removed,
net -6,744 lines**.

Validation transcript:

```text
npm run typecheck                              PASS
npm run typecheck:tests                        PASS
feature-dom-contracts                         48 passed
finder-server-plugin                          73 passed
finder-asset-opportunity-batch-parallel       14 passed
finder-asset-opportunity-archive              12 passed
vite-config-bundle                             1 passed
finder-asset-opportunity-runner               35 passed
finder-asset-opportunity-oos                  10 passed
finder-asset-opportunity-metadata              6 passed
finder-asset-opportunity-stream                2 passed
finder-asset-opportunity-rust-batch           22 passed
npm test -- --runInBand                       240 passed, 0 failed
git diff --check                               PASS
```

No real batch or push was performed during removal.
