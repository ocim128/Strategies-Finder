# Technical design

Status: proposed. [README.md](README.md) defines product scope. This file owns
the implementation rules; [validation.md](validation.md) owns test examples.

## 1. Reuse and file boundaries

Use the existing engine, Batch runner, loader, renderer, worker utilities,
authorization, polling, settings, and time helpers. Add five feature files
under `lib/monte-carlo/universe/`; their responsibilities are in the checklist.
No generic job framework, repository interface, dependency-injection container,
second simulation engine, or new dependency is needed.

Relevant existing source:

| Source | Reuse |
| --- | --- |
| `lib/monte-carlo-service.ts`, `lib/monte-carlo-renderer.ts`, `lib/monte-carlo-dom.ts` | Compose scopes; reuse details; update table and required DOM IDs. |
| `html-partials/tab-monte-carlo.html`, `styles/features/12-monte-carlo.css` | Matching lazy-tab markup and layout. |
| `lib/strategies/monte-carlo/monte-carlo-engine.ts`, `lib/strategies/monte-carlo/types.ts` | Existing simulation API, sizing, bootstrap, percentiles, detail payload. |
| `lib/batch-backtest/batch-backtest-runner.ts` | One strategy across symbols; awaited completion callback; artifact pruning. |
| `lib/batch-backtest/server-batch-data-loader.ts`, `lib/batch-backtest/batch-dataset-loader-core.ts` | Node-safe ordinary/pair loading and bounded caches. |
| `lib/batch-backtest/batch-run-contract.ts`, `lib/synthetic-pair-token.ts`, `lib/synthetic-pair-parser.ts`, `lib/synthetic-pair-mode.ts`, `lib/synthetic-leg-identity.ts` | Existing syntax, provider/alias resolution, safety, and execution modes. |
| `lib/backtest-executor.ts`, `lib/strategies/backtest/position-builder.ts`, `lib/strategies/backtest/pair-execution.ts` | Execution, allocation, fills, and pair fees. |
| `lib/server-worker-entry.ts`, `lib/finder/server/finder-task-worker.ts` | Worker bundling and single-task worker lifecycle. |
| `lib/batch-backtest/batch-backtest-vite-plugin.ts`, `lib/batch-backtest/sp500-top-mean-vite-routes.ts` | Shared owner adapter and token types. |
| `lib/local-route-authorization.ts`, `lib/vite-http-utils.ts`, `lib/server-run-poll-loop.ts` | Authorized routes and browser polling. |
| `lib/persisted-json.ts`, `lib/settings-manager.ts`, `vite.config.ts` | Compatible JSON, settings capture, plugin registration. |

Browser modules import only the model and existing browser utilities. Server
imports must not reach settings-manager, chart-manager, or runtime
`lightweight-charts` imports. Type-only strategy/time imports are allowed.

## 2. Captured request and symbol identity

Capture one request after the selected strategy has finished loading:

```ts
interface UniverseRunRequestV1 {
  schemaVersion: 1;
  runId: string;
  strategyKey: string;
  strategyParams: StrategyParams;
  backtestSettings: BacktestSettings;
  capitalSettings: Omit<CapitalSettings, "initialCapital">;
  interval: string;
  sourceContext: CapturedDataSource;
  blockRange: { from: number; to: number } | null;
  symbols: string[];
  simulation: {
    simulations: number;
    seed: number;
    initialCapital: number;
    ruinThresholdPercent: number;
  };
  criteria: {
    minimumTradeRecords: number;
    minimumProfitablePathPercent: number;
    maximumP95DrawdownPercent: number;
  };
}
```

Reuse existing provider/market types for `CapturedDataSource`; do not introduce
a parallel provider model. Construct internal backtest capital settings from
the request's capital fields plus `simulation.initialCapital`. Reject a second
nested initial-capital value. Resolve strategy keys through the trusted server
registry; never accept strategy functions or code.

Use existing parsers to resolve aliases before deduplication. Identity includes
provider/Spot/Futures, resolved symbol or ordered pair legs, execution mode, and
interval. Preserve IBKR marker inference. `@` and `@50/50` collapse; ratio and
50/50 do not. Reversed pairs stay distinct. Reject malformed suffixes,
self-pairs, conflicting providers, and unsafe tokens before reserving work.
Keep raw/duplicate counts separately from canonical requested count.

Validate schema, finite numbers, positive capital, supported interval/source,
inclusive Unix date bounds (`from <= to`), and existing parameter/settings
contracts. Seeds accept zero. UI and server use the same field units and limits
from section 8. Do not silently replace unsupported settings with defaults.

## 3. Execution and detail replay

Run `runBatchBacktest` inside one Node worker with
`pruneResultArtifacts: true`. Use its shared loader and executor. Universe v1
uses TypeScript execution for every instrument. Preserve confirmation/exit
overrides, directions, costs, stop/target behavior, and existing 50/50 fences.

Add `asOfTimeSec?: number` to `BatchBacktestRunInput`, using
`input.asOfTimeSec ?? Math.floor(Date.now() / 1000)` for its execution clock.
Pass the accepted server time to every symbol. Explicitly propagate captured
provider/market context through the loader; never accept and ignore it.
Apply the captured date window after the existing loaded-history completeness
check. Preserve execution-aware closed-candle/next-open preparation.

For each completed symbol: validate its trades, save the replay input in memory,
call `runMonteCarloSimulation`, validate outputs, create a scalar row, and await
journal commit before moving on. Release candles, signals, trades, and
simulation arrays after that callback; keep only bounded loader caches and
scalar rows.

**Keep the existing Monte Carlo API.** It currently reads only five backtest
fields. Narrow its input type structurally to:

```ts
type MonteCarloBacktestInput = Pick<BacktestResult,
  "trades" | "netProfit" | "maxDrawdownPercent" | "sharpeRatio" | "winRate">;
```

Full existing chart results still satisfy this type. Do not extract a new
prepared-sample API or duplicate the simulation loop. Add an optional
`inputSource` option defaulting to chart, and extend its existing result union
to include universe. Preserve chart random draws, timestamps, and smart sizing.

Store a versioned replay record containing that five-field input (using the
existing `Trade` shape, including pair legs), MC settings with effective count
and row seed, fixed/percent sizing config, execution mode, and algorithm version.
No candles, signals, backtest equity curve, or MC metric arrays are stored.
Allowlist the serialized fields; do not spread an entire backtest result.

Fixed/percent sizing does not require candle arrays in
`resolveAllocatedCapital`. Thus detail replay calls the **same** API with the
saved trades/settings and no candles. Do not refetch prices or rerun strategy
execution. Keep existing bounded display paths during summary computation too;
a separate summary-only engine option is unnecessary.

Hash the allowlisted replay payload with SHA-256 for its input digest. Store
and check the digest and algorithm version on replay. Reject incompatible
artifacts with a rerun message. The digest proves replay-input identity; it is
not a hash of the full market dataset.

### Callback failures

Batch catches completion-callback rejections inside its backtest error handler,
which can notify the same index twice. The Universe callback must never reject.
Wrap its entire body, including failure-row commit, in an outer try/catch.
Expected MC errors commit one simulation-failed row. Write/transport failures
set a run-level fatal error and the runner's cancellation flag, then return.

After Batch settles, check that fatal error before interpreting its generic
Done/Idle callbacks. Finalize failed, not cancelled or completed. Do not change
shared Batch callback semantics or notify a second backtest-failed row.

## 4. Numerical rules

### Allocation and partial exits

Let `E = abs(trade.size * trade.entryPrice)` and
`c = commissionPercent / 100`.

| Execution | Allocation denominator | Normalized net outcome |
| --- | --- | --- |
| Ordinary / ratio | `E * (1 + c)` | `trade.pnl / denominator` |
| 50/50 | `E` | `trade.pnl / E` |

Ordinary entry sizing includes entry commission in its allocation. Pair entry
sizing allocates gross notional and charges fees on top. For 50/50, verify E
agrees with the sum of absolute leg entry notionals within relative tolerance
`1e-9 * max(1, E, summedLegNotional)`. Reject inconsistent/missing pair records.
Net P&L already includes costs; do not deduct fees again or use total leg fees
as an entry-fee field. Never substitute ratio returns for two-leg outcomes or
apply Finder's pair-neutral ranking transformation.

Correct the existing chart pair denominator in the shared engine. Ordinary
normalization remains unchanged.

Before admission reject effective settings with either
`partialTakeProfitAtR > 0` or `partialTakeProfitPercent > 0`, including active
exit overrides: 400 `unsupported_partial_exits`. This conservative rule applies
even when a target would not be hit. An unexpected `exitReason === "partial"`
record fails MC preparation as `unsupported_partial_records`. Do not guess
position groups/fractions. Existing ordinary chart partial resizing stays
unchanged; fraction-preserving Universe sampling is deferred.

50/50 candles must retain `pairLegs` through loading, windowing, cloning, and
execution. Preserve cache separation and ratio-only disk-cache bypass. Missing
legs must fail instead of falling back to ratio execution.

### Bootstrap and verdict

For a symbol's N complete closed trade records, each path draws N records with
replacement. Include normal end-of-data closes; do not pool instruments or
resample pair legs separately. This retains independent-record assumptions;
loss clustering, overlapping positions, and shared legs are not portfolio risk
models. Show actual source dates and record count; this is not a forecast horizon.

Validate generated allocations, P&L, equity, drawdown, path metrics, and every
emitted aggregate for finiteness **before** statistics helpers can filter
samples, before serialization, and before any verdict. Overflow produces engine
error `non_finite_simulation` and a simulation-failed row with null simulated
metrics/verdict. Never drop invalid paths, shrink the denominator, or replace
non-finite values with zero or JSON null to manufacture success. Apply the same
check to detail replay and chart results.

Only after all paths and aggregates are valid:

```text
profitablePaths = count(netProfit[j] > 0)        # zero is not profitable
profitablePathPercent = 100 * profitablePaths / completedPaths
returnPercent[j] = 100 * netProfit[j] / initialCapital
medianReturnPercent = median(returnPercent[j])
observedReturnPercent = 100 * observedNetProfit / initialCapital
p95DrawdownPercent = existing engine drawdown percentile95
pass = profitablePathPercent >= minimumProfitablePathPercent
       AND p95DrawdownPercent <= maximumP95DrawdownPercent
passRatePercent = eligible > 0 ? 100 * passed / eligible : null
```

Use all scalar paths, not the <=48 displayed paths. Use existing percentile
interpolation. P95 is not the upper bound of a two-sided 95% interval (P97.5).
Trade win rate is not profitable-path percentage. Compare unrounded values.

Drawdown is peak-to-trough equity percentage after closed trades. Keep observed
bar-level drawdown separately labeled. Sharpe and ruin remain detail diagnostics.

New Universe percentage fields use percentage points. Returns/drawdown may
exceed 100 and must not be clamped. Legacy detail
`ruinProbabilityMetrics.ruinProbability` and `ruinRate` remain fractions in
0..1: the existing renderer converts 0.25 to 25% once. Do not convert the whole
legacy payload.

### Rows and coverage

Statuses: `evaluated`, `insufficient_trades`, `load_failed`,
`backtest_failed`, `simulation_failed`, `resource_limit`, `not_processed`.
Only evaluated rows have Pass/Fail. Invalid trade inputs fail preparation;
too few otherwise valid records are insufficient, not a load failure.

A row contains index/key/display token/mode, status/verdict/reason, bar/record
counts and actual dates, observed return/drawdown, profitable-path count/percent,
median return, P95 simulated drawdown, effective paths, row seed, input digest,
and detail availability. All non-applicable metrics are null. No arrays from
execution or simulation enter this DTO.

On termination every canonical symbol has one row:

```text
requested = evaluated + insufficient + loadFailed + backtestFailed
            + simulationFailed + resourceLimited + notProcessed
evaluated = passed + failed
processed = requested - notProcessed
```

Stop/fatal failures retain committed rows and synthesize not-processed tail
rows. A numerical row failure can continue to the next symbol. Infrastructure
failure ends the run. Zero eligible symbols has an unavailable pass rate.

Per-row seed: FNV-1a uint32 over UTF-8 `baseSeed + "\n" + canonicalKey`,
offset basis 2166136261, XOR each byte, then `Math.imul(hash, 16777619) >>> 0`.
Version this rule. List position and wall clock never affect it. The saved
row seed is used unchanged for details.

## 5. Routes, workers, and ownership

Register four authorized local routes using existing route helpers:

| Route | Behavior |
| --- | --- |
| POST `/api/monte-carlo/universe/run` | Validate, atomically reserve, save accepted manifest, return 202 run ID, then start worker. Retry of the same run ID and identical captured request is idempotent; changed request is 409. |
| GET `/api/monte-carlo/universe/status?runId=...` | Full scalar snapshot: configuration summary, state/progress/counts, all committed rows; terminal snapshots include the unprocessed tail. No server paging. |
| POST `/api/monte-carlo/universe/stop` | Body run ID; idempotent and scoped to that owner. |
| POST `/api/monte-carlo/universe/detail` | Body run ID and row index; terminal replay only, one detail at a time; returns existing MC detail plus digest. |

Use a fixed serialization of the captured request for retry comparison, using
existing hashing utilities. Do not treat an edited request as a retry.
All routes, including reads, use existing local authorization. Validate opaque
run IDs, body sizes, token lengths, numeric fields, and known versions before
work. Accept no file paths. Return 400 invalid, 409 busy/conflict, 404
`run_unavailable` for missing/replaced artifacts, shared authorization errors,
and structured 5xx infrastructure errors.

Resolve run/detail worker entries through `resolveWorkerEntryPath` with the
existing memo pattern, then use `createFinderTaskWorker`. One task is the
whole universe run or one terminal detail replay. Do not extract another worker
framework. The resolver can fall back to raw TS after a bundle failure; reject
that path for this feature, fail startup cleanly, and release admission.
Use runnable compiled JS/CJS. Reset the memo on relevant HMR/restart.

Extend existing `BatchOwnerLocks`, `BatchOwnerToken`, and internal owner union
with `monte_carlo_universe` and a checked
`acquireExclusive(runId, "monte_carlo_universe")`. Check Batch/analysis/TOP_MEAN
occupancy and assign both owner generations synchronously; busy throws 409.
Reuse token-checked release and audit Finder admission to honor that reservation.
Do not add another busy flag, use unchecked acquire, impersonate Finder, or
cancel a competing job.

States: accepted -> running -> completed/cancelled/failed. Startup converts
nonterminal saved runs to interrupted. Terminal state never changes.

Hold ownership until worker termination and writes settle. Every callback checks
run ID/owner generation; old cleanup cannot release new ownership. Use the
existing small pending-stop pattern for Stop during admission. Stop terminates
compute, waits for journal writes, retains complete commits, and discards
uncommitted work. Worker crash/exit mid-task fails the run. Browser disconnect
does not cancel it. Dispose worker/polling resources on shutdown and HMR.

## 6. Storage and browser state

Each run has two files under
`artifacts/monte-carlo-universe/<server-owned-safe-id>/`:

- `manifest.json`: version, captured configuration/inventory, state/counts;
  replace through temp + rename on state changes.
- `replay-inputs.jsonl`: one record per committed row containing row plus
  replay input, settings, digest, and algorithm version. Excluded/failed rows
  have no replay input.

The parent owns one serialized append writer. The worker awaits append/flush
acknowledgment before publishing a row. Maintain scalar rows and byte offsets
in memory. Detail reads one indexed record. Restart rebuilds the index by a
bounded streaming scan. Ignore an incomplete final line; internal corruption
is an explicit recovery error. Rebuild unprocessed tails from the manifest.
No per-symbol files, extra row log, database, or tombstones.

Keep the latest terminal run and the active run only. After the active run
terminates, it becomes latest even if cancelled/failed; remove the prior result
after any reader releases it. A detail holds the shared reservation, so a new
run cannot race its read. Startup/admission removes orphaned older runs after
reconciliation. There is no time-based expiry, history UI, global quota ledger,
or reservation for future disk space. Enforce the per-file limits in section 8.
Never traverse junctions or leave the artifact root during cleanup.
Write/disk-limit failure marks the live run failed with its committed prefix.
Attempt to save the terminal manifest; if the disk cannot accept it, keep the
live failure visible and let startup classify the old manifest as interrupted.
Do not claim a successful durable write after an I/O error.

Persist version-1 feature preferences and one version-1 last-run marker
`{schemaVersion: 1, lastRunId: string | null}` through `lib/persisted-json.ts`.
Use feature-local keys `monteCarloUniverse.settings` and
`monteCarloUniverse.lastRun`. Missing settings use defaults, invalid/future schemas
recover safely, and debounced preferences flush on pagehide. Do not store rows,
trades, or metric arrays in localStorage.

Poll once per second with `ServerRunPollLoop`; one request at a time, bounded
error backoff, run-ID stale-reply guard, disposal on controller teardown.
Each reply replaces the local scalar inventory in one operation. Because the
limit is 1,000 symbols, full snapshots avoid cursor/reconciliation logic.
Sort the whole inventory; UI pagination only limits rendered rows. Running
snapshots are explicitly partial. Exports are available only after a terminal
snapshot, and include every row, not just the visible page.

Reload uses lastRunId to reattach. Missing/replaced results show a rerun message.
Edits affect the next run. Separate chart revision from Universe ownership.
Details are terminal-only, have their own selection generation/AbortController,
and retain at most one result in browser memory. Busy detail/new-run requests
return 409. Detail disconnect cancels that transient task without altering the
stored terminal run.

## 7. UI integration

Use one scope selector and shared Run/Stop/status controls. Add
`#mc-chart-scope-container` and `#mc-universe-scope-container` inside
`#montecarloTab`. Preserve the existing chart results/empty-state hierarchy.
Update the partial, required-ID contract, consumers, and lazy-layout tests
together. Resolve all required IDs before attaching listeners.

Extend the existing renderer for the Universe summary/table and explicit detail
source label. Keep chart and selected Universe detail state separate. Use real
table headers, labeled controls, keyboard sort/detail buttons, visible focus,
and horizontal scrolling within the table.

Copy CSV escapes fields and protects formula-like text using the existing
export convention. Download JSON contains schema/algorithm version, captured
configuration, counts, state, and all scalar rows; no replay trades or metric
arrays. Export requires a terminal snapshot. Do not add saved view preferences,
multi-column sort editing, or per-row cards.

## 8. Limits

Centralize these constants in the model; check boundaries in tests.

| Item | V1 limit |
| --- | --- |
| Instruments | 1..1,000 canonical; at most 2,000 raw tokens before deduplication. |
| Request body | 1 MiB; existing symbol safety/128-character token limit. |
| Run ID | Browser UUID; server accepts 1..128 ASCII letters/digits/underscore/hyphen, never a path. |
| Requested paths | Integer 250..10,000; default 1,000. |
| Minimum records | Integer 5..100,000; default 30. |
| Seed | Integer 0..4,294,967,295; default 1337. |
| Criteria | Profitable-path percent 0..100; finite P95 limit >=0. |
| Capital / ruin threshold | Finite capital >0; ruin threshold 0..100 with existing engine meaning. |
| Work per symbol | 8,000,000 record steps; effective paths = min(requested, 10000, floor(8000000/N)). Below 250 gives resource_limit. |
| Compute | One worker/task; existing bounded loader prefetch and caches. |
| Status | All <=1,000 scalar rows; <=2 MiB response, errors truncated to 256 characters. Project compact metadata; do not include requested symbol list twice or execution settings' large arrays. |
| Journal | <=256 MiB; one record <=16 MiB; oversized record gives resource_limit before MC. |
| Manifest | <=1 MiB; retain only two run directories plus a temporary manifest replacement. |
| Details | Existing <=48 display paths, <=512 points/path, <=10,000 samples/metric. |

If the full scalar status cannot fit its byte limit, report an infrastructure
error; never truncate inventory or silently switch to transport paging. The
maximum-size fixture must establish the DTO fits before delivery.
