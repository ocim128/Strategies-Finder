# Server-Owned Finder Jobs

Finder Symbol Universe is a **server-owned job**: the Vite server process owns
the complete lifecycle for every selected entry strategy — IS evaluation,
survivor merge, optional OOS validation, diagnostics combination, and the
authoritative terminal candidate slice. The browser is the control and
rendering layer and can reattach to an in-flight or completed job after a tab
reload. Current-chart Finder remains browser-side.

## Asset Opportunity

Asset Opportunity uses the same server owner, run id, Stop route, and reload
reattach path as Symbol Universe, but evaluates one symbol at a time. The
browser receives only scalar opportunity rows; the terminal slice is bounded
by the existing Finder `topN` control. With no fixed holdout, each asset
reserves its latest closed candle for fresh-entry detection and searches
historical candidates without that candle. With a fixed holdout, the visible
prefix is used for both candidate search and the boundary signal, while the
final N candles remain hidden for validation.

Asset Opportunity can reserve the last N historical bars as a fixed OOS
holdout. In that mode, candidate ranking and the Finder data slice use only
the visible prefix, the signal is generated on its last visible candle, and
the hidden bars validate that one boundary prediction. Its signed
close-to-entry forward PnL is reported at three horizons (default `1,3,5`),
with horizon 1 targeting the first hidden candle. The setting is disabled when
N is `0`, which retains the normal latest-closed-candle opportunity behavior.

The server caps a run at 1,000 symbols. It records an estimated candidate-work
count as a diagnostic, but does not reject a run based on that estimate. The
server requires random Finder mode and clamps the candidate pool to
1–50. The symbol and heap guards protect process stability; they do not
change the Current Chart or Symbol Universe limits.

Asset runs emit bounded debug events named
`finder.asset_opportunity.start`, `finder.asset_opportunity.asset.complete`,
`finder.asset_opportunity.run.complete`, `finder.asset_opportunity.run.cancelled`,
and `finder.asset_opportunity.run.failed`. Event payloads contain counts,
grades, symbols, timings, and errors only—never candles, signals, or trades.

## Browser-owned Finder modes

Current-chart Finder and Strategy Quality remain in the browser. Genetic and
Polymarket Finder use their dedicated in-tab runners. This document covers
only the server-owned Symbol Universe and Asset Opportunity routes; do not
infer server ownership for another Finder mode from the shared result types.

## Runtime contract

- Start with `npm run dev` for development. `vite preview` also registers the
  Finder Universe endpoint; a static-only deployment does not.
- **One request per run.** The browser submits all selected entry strategy
  keys in a single `POST /api/finder/universe-run` request with a
  browser-generated `runId`. The server sequences strategies, merges scalar
  survivors, runs OOS (when enabled), and publishes one terminal snapshot.
  The browser no longer sequences per-strategy requests or loads OHLCV for
  the OOS pass.
- Polymarket scoring remains unsupported in Symbol Universe scope.
- **Stop is scoped by `runId`** — `POST /api/finder/stop` carries the active
  run id so a stale tab cannot cancel a newer run. Stop aborts in-flight
  data loads, makes every strategy + OOS loop observe lost ownership, marks
  the snapshot cancelled, and clears the browser-side active-run record.
- **Tab reload reattach is supported.** The browser persists the active
  `runId` (`playground_finder_active_server_run`, schema
  `finder.active_server_run`, v1) before `fetch`. On Finder init, it polls
  `GET /api/finder/status?runId=...`; if the server still has the job, it
  restores progress + Stop state and polls summary-only status until
  terminal, then adopts the authoritative final candidates once. Reattach
  only survives a browser reload while the same Vite process remains alive
  — a Vite restart loses the in-memory job (the reattach clears its record).

- If the initiating NDJSON stream breaks without a reload, the same tab polls
  the scoped status endpoint to terminal. It never promotes provisional
  streamed candidates to the final result.

## Memory

Large universes require a larger Node heap:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` applies this default unless a heap value is already set.
The server rejects 400-799 symbols below 8192 MB and 800+ below 12288 MB.

Within one server-owned run, successful sliced datasets are cached by
`symbol|interval` and reused by every selected strategy. The cache does not
increase the runner's peak dataset count because one strategy already loads
the full universe; it extends that dataset lifetime until Done, Stop, or Fatal,
when the job cache is cleared. Failed and empty loads are not retained, so a
later strategy can retry them.

## Wire contract

`FinderUniverseCandidate` is scalar-only. `toScalarCandidate(...)` and
`assertCandidateIsScalar(...)` reject `data`, `signals`, `trades`, and
`equityCurve` before streaming and on the terminal status snapshot.

| Event | Purpose |
| --- | --- |
| `start` | Echoes the `runId`, declares symbol/candidate counts, ordered strategy keys + count. |
| `progress` | Updates bounded progress, status, phase (`loading`/`evaluating`/`oos`), and current strategy index/count. |
| `candidate` | Streams a scalar survivor (merged job-level survivors, deduped by identity). |
| `symbol_failed` | Reports one dataset failure. |
| `done` | Authoritative final slice, combined diagnostics, totals (incl. `oosRemoved`), and the matching `runId`. |
| `fatal` | Terminates the run with an error and the matching `runId`. |

The terminal `done.candidates` slice is authoritative. `/status` in-progress
snapshots are summary-only (candidate counts, never the per-symbol payload);
the terminal snapshot is the one place that carries the final candidate slice.

Copied diagnostics report job-cache requests, hits, misses, unique bars,
candidate plans versus symbol evaluations, and actual Rust/TypeScript executor
usage. When Rust was requested but a run remains on TypeScript, diagnostics
include the deterministic eligibility reason; current execution semantics
disable same-bar exits, which the Rust backend does not support. Timing phases
are marked `overlapping` because yielding and nested
signal/backtest work must not be added together as independent wall time.

## `GET /api/finder/status?runId=...`

Returns a typed `FinderRunStatusSnapshot`: `running`, `terminal`, `phase`,
`progressPercent`, `statusText`, candidate `candidateCount` (count only while
running), loaded/failed totals, and — when terminal — the authoritative
`terminalCandidates` slice + summary + diagnostics. A mismatched `runId`
returns 404 and must never be adopted. A request without `runId` returns the
legacy ad-hoc introspection object for `curl` debugging; the browser reattach
path must pass a `runId`.

## Data flow

The server loader reuses `createBatchDatasetLoaderCore`, preserving Batch
synthetic-pair construction, cache limits, gap filling, and data slicing. The
server evaluates IS candidates, merges survivors across strategies, runs the
OOS pass (loads complementary datasets through the same loader, sliced at the
caller), and releases datasets when the job ends. There is no Mine artifact
directory or TTL. The browser loads **no** Universe OHLCV for IS or OOS.

Diagnostics are combined server-side by the leaf
`buildCombinedUniverseDiagnostics(...)` (the prior `FinderManager` combiners,
extracted verbatim). The OOS pass is the leaf `runUniverseOosPass(...)`
(`lib/finder/finder-universe-oos.ts`), a faithful lift of the prior
`FinderManager.applyUniverseOosValidationIfNeeded` body with all runtime
dependencies injected — it reads no browser DOM, `state`, `backtestService`,
or `dataManager`.

When local data is synchronized, the browser also calls
`POST /api/finder/invalidate-cache` so the server loader does not retain stale
datasets across later Universe runs.

Server-side modules imported by `vite.config.ts` must not import browser-bound
managers or anything that transitively imports `lightweight-charts`. The
server plugin reaches only leaf modules: `finder-runner-universe`,
`finder-universe-metrics`, `finder-universe-diagnostics-combine`,
`finder-universe-oos`, `finder-param-space`, `finder-manager-logic`,
`server-finder-data-loader`, and the synthetic-pair disk cache.

## Stop-before-ownership race

`POST /api/finder/stop` with a `runId` that has not yet acquired ownership is
recorded in a module-scope `pendingStopRunId` (single slot — not an
unbounded set). The matching run request consumes the marker and finishes
cancelled instead of starting heavy work. A newer run with a different
`runId` is unaffected.

## Validation

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-metrics.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-oos.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

Manual smoke: run one and multiple strategies over 50 symbols, then 400
symbols with the larger heap. Confirm progress scaling, server-side OOS
filtering, Stop (scoped by run id), diagnostics merging, reload reattach
during IS and OOS phases, and Apply.
