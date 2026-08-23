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
