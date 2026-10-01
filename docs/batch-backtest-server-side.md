# Server-Side Batch Backtest

The Batch Backtest tab runs its heavy per-symbol workload in the Vite
dev-server (Node) process. This single path exists because 1000+ IBKR 4H
synthetic-pair runs hold
~5–10 GB of per-row artifacts (`data` + `signals` + `result.trades`) for the
OPEN_SCORE USD Replay step, which OOMs a browser tab. Node can use main RAM
directly; the browser tab keeps only rendered scalars and DOM rows.

## Module map and ownership

Batch is split so each behavior has one owner. Paths are relative to
`lib/batch-backtest/`. Dependency direction: `browser/*` and
`open-score-replay/*` modules import leaf contracts directly
(`open-score-replay/types.ts`, the store, the views); they never import
through the engine entry point, and the facade never reaches into a child's
internals. Public entry points are stable:
`runOpenScoreUsdReplay` (engine) and `BatchBacktestService` /
`createBatchBacktestService` / `batchBacktestService` (facade), which
re-export every historical symbol.

### Replay engine (`batch-open-score-usd-replay-engine.ts`, ~470 lines)

`runOpenScoreUsdReplay` stays the orchestrator: phase sequencing, bounded
yields, cancellation checks, archive-sink awaiting, and the explicit
large-data release points (`events`/`returnsByView` drops) remain in the
engine. Stage implementations live in `open-score-replay/`:

| Stage module | Owns | Focused specs |
| --- | --- | --- |
| `types.ts` | Public result/option/selector contracts, archive records, shared-cache contract (type-only) | (consumed everywhere) |
| `internal-types.ts` | `ScoreDelta`, `DecisionEvent`, candidate views, stage result/early-exit contracts | — |
| `statistics.ts` | median/finite guards, block bootstrap, degree summaries, per-asset breakdown + exclusion helpers | `batch-open-score-usd-replay-engine.spec.ts` |
| `pnl.ts` | `computeSelectorPnl`, `simulateTopMeanPortfolio` | `batch-open-score-usd-selector-pnl.spec.ts` |
| `report.ts` | `buildReportLines` (opaque `reportLines` text is frozen) | replay specs |
| `artifact-scan.ts` | Phase 1 artifact streaming, per-pair delta reconstruction, causal vote flags, cap-tilt coverage | replay specs |
| `event-sweep.ts` | Phase 2 time-bucketed merge, ordinary/profit/causal accumulators, event snapshots | `batch-open-score-usd-max-active.spec.ts`, `open-score-replay-event-sweep.spec.ts`, replay specs |
| `candidate-selection.ts` | Candidate pools + FNV tie-breaks, strict-past TOP_Z history, outcome request grouping, gap-filtered reranking, BOT_* picks, latest selections | replay specs |
| `target-outcomes.ts` | Lazy dataset resolution + caller-owned shared cache, per-horizon outcomes, gap/censoring/no-data accounting, Phase 0b diagnostics | replay specs, `sp500-top-mean-research-archive-writers.spec.ts`, `sp500-top-mean-causal-features.spec.ts` |
| `aggregation.ts` | Per-horizon series/controls/breakdowns/exclusions, ONGOING picks, P&L experiments | replay specs |
| `runtime.ts` | `yieldLoop` bounded-yield helper | — |

Deterministic parity gate: `scripts/bench-finder-arm-replay.ts` prints a
full-result SHA-256 fingerprint (ordinary/`--ties`/`--gaps`/
`--missing-targets`/`--interleave`/`--sparse` fixtures). Any refactor that
changes a fingerprint is a behavior change — investigate, don't re-bless.

### Browser modules (`browser/`)

`BatchBacktestService` remains the composition root and public facade: it
wires the DOM contract, owns cross-workflow coordination (`isBatchUiBusy`,
balanced-generator lock, pending-Stop sequencing —
deliberately uncoalesced — and `clearStaleResults` across owners), composes
disposal, and exposes typed accessors rather than letting children see its
internals. Do not pass the whole service into a child module.

| Module | Owns | Focused specs |
| --- | --- | --- |
| `batch-results-view.ts` | Result rows, sort header, coalesced live-render queue (run-token check injected), summary/progress presentation | `batch-backtest-service-lifecycle.browser.spec.ts`, `feature-dom-contracts.spec.ts` |
| `batch-run-controller.ts` | Batch Run/Stop lifecycle, NDJSON stream consumption, status pagination/reconciliation/recovery, benchmark snapshot, result persistence, server reattach poll + timers/backoff | `batch-backtest-service-lifecycle.browser.spec.ts`, `batch-backtest-server-plugin.spec.ts` |
| `top-mean-controller.ts` | TOP_MEAN run/stop/reattach, diagnostic ring + debounces + durable log, latest result/arm, copy/download | lifecycle spec, `sp500-top-mean-*.spec.ts` |
| `open-score-controller.ts` | Standalone replay request/stream, analysis lock + stale-cancel, copy | lifecycle spec |
| `top-mean-results-view.ts` | Current-snapshot banner, latest-arm card, display tie-breaks, copy text | lifecycle spec |
| `top-mean-event-details-view.ts` | Details sections, year filter, ONGOING rows, truncation notices | lifecycle spec |
| `batch-browser-store.ts` | Storage keys/versions/migrations for settings, active-run markers, compact snapshots (data only; no DOM) | `batch-backtest-snapshot.spec.ts` |
| `balanced-pair-list-controls.ts` | Generate-and-apply, copy, applied-list provenance | `batch-balanced-pair-list-generator.spec.ts` |

Memory ownership: the replay engine's per-window arrays are released only at
the engine's explicit points; stage results must not embed (and closures must
not retain) large arrays. The render queue belongs to the results view;
timers/backoff belong to their controllers and are released by each
controller's `dispose()` (TOP_MEAN clears its run id before resolving poll
delays so the loop cannot reschedule).

## Runtime requirement

Batch Run and OPEN_SCORE USD Replay require
the Vite server runtime. Both `vite dev` and `vite preview` register these
endpoints; a static-only deployment does not.

The shared browser stream reader (`lib/ndjson-stream.ts`) processes a final
non-empty JSON record at clean EOF even when it has no trailing newline.
Batch still requires a terminal event (`done`/`fatal`, or the caller's configured
types); EOF without one triggers recovery. Malformed records, including an
unterminated final record, fail with their 1-based line number. A stream read
error propagates without admitting a buffered final record. The transport
contract is covered by `ndjson-stream.spec.ts` and `batch-ndjson-post.spec.ts`.

## Starting the dev server with extra heap

A 1000-pair run plus retained analysis artifacts holds several GB of OHLCV /
signals / trades arrays on the dev server. The default V8 heap is too small.
Start the dev server with:

```bash
# macOS / Linux
NODE_OPTIONS=--max-old-space-size=16384 npm run dev

# Windows (cmd)
set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev

# Windows (PowerShell)
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` sets `NODE_OPTIONS=--max-old-space-size=16384`
automatically unless you already supplied a `--max-old-space-size` value. If
you start Vite manually with the default heap, large server-side Batch runs are
rejected before they begin instead of crashing the dev server.

If the dev server crashes with `JavaScript heap out of memory`, raise the
value. `12288` is the floor for a full 1000-pair IBKR 4H run; `16384` leaves
headroom for an IBKR sync running concurrently.

The heap requirement scales with pair count. For 200–400 pair runs,
`--max-old-space-size=8192` is usually enough.

## Server-only execution

The browser streams scalar results from the server and never retains per-row
OHLCV, signals, or trades. Use Stop to cancel an in-flight run.

OPEN_SCORE USD checks Stop while forming candidate selections in both replay
modes. The candidate stage checks at event boundaries, yields about every
1,000 events, and exits before loading target datasets when cancellation is
requested; partial candidate results are discarded.

The event sweep also checks Stop and yields every 2,000 deltas while indexing
decision times, counting bucket sizes, placing deltas, and applying the final
time-ordered merge. Its distinct-bucket indexing pass yields every 2,000 bucket
times. Sorting the timestamps uses the native synchronous array sort, so Stop
is checked immediately before and after that sort.

## Stop vs Cancel vs Reload

- **Stop button**: cancels the in-flight server-side run. The owner-lock is
  force-bumped, in-flight dataset loads are aborted, and the runner bails at
  the next per-iteration check. Already-rendered rows stay on screen.
- **Tab reload mid-run**: the server keeps running. The browser polls
  `GET /api/batch-backtest/status` every 2s on init and reattaches — it
  re-renders the rows accumulated server-side so far and continues updating
  until the run ends. The poll granularity is 2s (not per-symbol), which is
  the same pattern IBKR sync uses for reattach.
- **Closing the tab**: the server keeps running. Reopening the tab triggers
  the same reattach poll. There is no stream-tap from a second connection —
  multi-subscriber writers are over-engineering for a single-user dev server.

## OPEN_SCORE USD Replay on the server

In server-side mode, the per-row artifacts (`data` / `signals` /
`result.trades`) are written to a temporary server-side artifact directory.
The OPEN_SCORE USD button is enabled when the run's `done` event reports
`serverHasArtifacts: true` (i.e. at least one completed synthetic-pair row was
stored).

OPEN_SCORE USD Replay does not load all stored pairs into memory at once. It
derives the target assets from artifact metadata, then for each target loads
only the synthetic pairs linked to that target, computes that target's selector
deltas, and releases the linked artifact objects before moving to the next
target. This keeps large-pair runs bounded by the largest single target's
linked pair set rather than the full pair universe.

Clicking OPEN_SCORE USD streams the replay report back via
`POST /api/batch-backtest/open-score-usd`.

The replay is a descriptive event-level study, not an order allocator. The
current engine includes the long-side raw/mean selectors, the
`TOP_MEAN_RAW_UNIQUE` tied-set refinement, the pnl-gated `TOP_RAW_PROFIT` /
`TOP_MEAN_PROFIT` variants (research-only look-ahead) and their causal
point-in-time `TOP_*_PROFIT_NOW` counterparts, plus per-asset breakdown and
dominant-asset exclusion diagnostics. `TOP_RAW_PROFIT_NOW_CONF` is an
additional causal arm: each qualifying pair vote is weighted at entry by
`n/(n+1) * realizedNetPnl/grossAbsPnl`, where `n` and both P&L totals use only
closed trades available before that entry. The weight is carried unchanged
until the position exits. It no longer includes the adjusted,
VS_RAW/RANK2 pairwise, MAX_ACTIVE/MAX_RETAINED, take/skip, trend, or
submitted-degree arms (removed). The profit gate reads the artifact's
`result.netProfit`: the standalone route loads full Batch mine artifacts
(always carry it), while the TOP_MEAN coordinator replays compact artifacts
that carry `netProfit` only when written by a worker from its introduction
onward — older archives show `n=0` on the gated lines. It also emits per-asset breakdown and dominant-asset exclusion
diagnostics where the selector supports them. The exact report text is
generated by the engine; keep the opaque `reportLines` copy contract intact
when adding an arm.

### Cap-tilt weighting (`capTiltWeight`)

The OPEN_SCORE USD rerun accepts `capTiltWeight: "off" | "smallBase2x" |
"largeBase2x" | "similarCap2x"` (default `"off"`, selectable next to the horizons input). When
active, the **base leg of a LONG trade** gets entry delta **+2** instead of
+1 — `smallBase2x` when the base's market cap at entry is **lower** than the
quote's, `largeBase2x` when **higher**, `similarCap2x` when both entry caps are
positive and within a factor of 3 (equal caps qualify; nonpositive/unknown
caps weight 1) (data source: the Download MarketCap
dataset, `price-data/ibkr/marketcap/`, looked up as-of the entry timestamp).

- The tilt is classified **once per trade at entry**, and the **same weight**
  is applied to the exit delta (−2), so `rawScore` returns exactly to its
  prior value after every round-trip.
- Quote legs stay −1, short pairs stay ±1, ties (equal caps) and any unknown
  cap (no file / no row yet) weight 1 — the weighting can change ranking,
  never candidacy (`rawScore > 0` pool untouched).
- Because every score-derived arm (TOP_RAW/TOP_ADJUSTED/TOP_MEAN, trend,
  HHI, freshness) accumulates the weighted deltas, **all of their numbers
  shift under a weighting**. That is the point
  of the experiment: run Off / smallBase2x / largeBase2x / similarCap2x and compare the
  TOP_MEAN delta-vs-random lines; each report's `config |` line names its
  `capTilt=` setting so outputs stay self-describing.
- `capTiltWeight ≠ "off"` with a missing/empty `price-data/ibkr/marketcap/`
  directory is a **fatal** stream event ("Download MarketCap in the IBKR Data
  tab first") — never a silent baseline run. An unknown enum value is a 400.
- The TOP_MEAN Coordinator ("Run TOP_MEAN") honors its **own** select
  (`batchBacktestSp500TopMeanCapTilt`, independent of the standalone
  section's) for both the full-range replay and every calendar-year pass,
  with the same weight-1 fallback and fail-loud rule. The weighting is
  recorded in the run's `manifest.json` (`capTiltWeight`) and mixed into the
  archive fingerprint so archived runs stay self-describing.

## Artifact retention and TTL

When artifacts are retained, the server keeps the temporary artifact directory
until one of:

1. A new Run starting (`POST /run` removes the prior artifact directory first).
2. **A bounded TTL of 10 minutes** after the Run's `done` event with no
   analysis click.
3. Explicit Stop / fatal handling.

The TTL is the defense-in-depth that the browser path got for free via tab
reload. Without it, a user who runs 1000 pairs and walks away would leave
~5 GB pinned on the dev server indefinitely.

The TTL value is `DEFAULT_ARTIFACT_RETENTION_MS = 10 * 60 * 1000` in
`lib/batch-backtest/batch-backtest-vite-plugin.ts`.

## Copy summary parity

In server-side mode, the `symbol` event still strips `data`, `signals`, and
`result.trades`, but it keeps tiny derived scalars for Copy Results:

- `buyHoldPct` preserves the B&H / alpha sections.
- `openTradeAssetScores` preserves the OPEN_SCORE sections.
- `yearlyPnl` preserves per-symbol exit-year PnL and trade counts as one compact
  string (for example, `2020:+120.5(14)|2021:-31.0(9)`). It contains no arrays;
  the browser parses it to build the portfolio yearly section.
- `openPosition` preserves whether the pair's position was still open at the
  end of its data (`{ side: "long" | "short" }`; the engine force-closes such
  positions with `exitReason: end_of_data` on the last trade — the same signal
  the OPEN_SCORE sections use). It feeds the **Copy Open Positions** button:
  it copies those pair symbols, one per line (paste-ready into the Pairs
  textarea). Rows without the scalar (runs made before it existed) cannot be
  recovered from the browser and are omitted from the list.

The OPEN_SCORE USD replay (POST `/api/batch-backtest/open-score-usd`) produces
a `reportLines` text array that the engine builds. Both the dedicated
`Copy OPEN_SCORE USD` button and the main `Copy Results` button render that
array verbatim, so new selector arms ride both copy paths automatically
without UI or service changes.

The browser tab still avoids heavy per-row arrays, while copied summaries match
the browser-side Batch path for these sections.

Copy Results starts with a `PORTFOLIO YEARLY` line that aggregates the compact
per-symbol values by exit year, followed by one `YEARLY | <symbol> | ...` line
per symbol. Years are sorted ascending; rows from older runs without
`yearlyPnl` are shown as `n/a`.

## Reload persistence

The Batch tab persists the latest completed output through
`playground_batch_backtest_latest_results`, using the same envelope helper as
Finder result snapshots. Persisted rows are scalar-only: `data`, `signals`,
`result.trades`, and `result.equityCurve` are stripped before writing to
localStorage. Reloading restores the rendered rows and Copy Results output.

OPEN_SCORE USD is not restored from localStorage because it needs heavy per-row
artifacts. In server-side mode, the reattach status endpoint can still
re-enable the OPEN_SCORE USD button while the server artifact TTL is valid and
the fingerprint matches.

## Single in-flight run per dev server

The plugin uses the same owner-lock model as IBKR sync. A second `POST /run`
while a run is in flight returns `409 Conflict`. A second analysis request
(`POST /open-score-usd`) while one is running also returns `409`. Analysis and
Run share the lock: a new Run cannot start while analysis is in flight, and
vice versa.

This is the single-user dev server model. Multi-tenant / concurrent runs are
out of scope.

## Rust engine parity

Server-side mode preserves Rust engine parity. The user's `useRustEngine`
toggle is forwarded to the server as `useRustEnginePreference` in the run
request body, and `shouldAttemptRust` consults it when running in Node
(where there is no DOM toggle to read).

Without this fix, server-side mode would silently use the TypeScript engine
even when the user has Rust enabled — a perf regression vs browser mode.

## HTTP API

All endpoints live under `/api/batch-backtest/*`:

- `POST /run` — NDJSON stream. Body: `{ symbols, interval, strategyKey,
  strategyParams, backtestSettings, capitalSettings, useRustEnginePreference }`.
  Streams `start`, `progress`, `symbol`, `done`, `fatal` events. Load/run
  failures are transported as ordinary `symbol` events with a `load_failed` /
  `run_failed` status on the row; there is no separate failure event.
- `POST /stop` — force-bumps the owner lock and aborts in-flight loads. Safe
  to call when no run is active.
- `POST /open-score-usd` — NDJSON stream. Reconstructs historical OPEN_SCORE
  decision events from retained artifacts and compares selector arms against
  the uniform-random control. Streams `start`, `phase`, `progress`, `done`,
  `fatal` events. Read-only on artifacts.
- `GET /status` — JSON snapshot for reattach. Returns `{ running, run, lastRun }`.

The `row` sent in `symbol` events contains ONLY scalars — never `data`,
`signals`, or `result.trades`. Those arrays stay server-side. This is the
contract that keeps the browser tab bounded regardless of pair count. The
optional scalar `yearlyPnl` field is the only per-trade-derived yearly payload
and is encoded as a string; old rows may omit it and render as `n/a`. The
optional `openPosition` scalar (`{ side }`) is the only per-trade-derived
open-position payload and feeds Copy Open Positions; old rows may omit it.

## S&P 500 TOP_MEAN UI Coordinator

The S&P 500 TOP_MEAN UI Coordinator runs a long-running batch evaluation over the canonical pair universe formed from S&P 500 IBKR assets.

### Architecture

1. **Preflight & Enumeration**: Intersection of `sp500_company_info.csv`, `price-data/ibkr/catalog.json`, and 30m seed CSV files.
2. **Worker Pool Execution**: Node worker threads (`sp500-top-mean-worker.ts`) execute built-in strategy across pair shards and write atomic `CompactPairArtifact` files under `artifacts/sp500-top-mean/<runId>/shards/`.
3. **Replay & Asset Ranking**: Invokes `runOpenScoreUsdReplay` using target asset price series and compact pair artifacts, yielding TOP_MEAN asset ranking summaries.

After worker artifacts are available, the coordinator also computes a current
TOP_MEAN snapshot from positions open at a common closed-candle endpoint. This
`currentSnapshot` is distinct from the historical `topAssets` leaderboard. It
reports ties and mixed/missing endpoints instead of silently selecting an
asset, and it is a research display rather than a live order decision.

The TOP_MEAN coordinator's **Block repeat selection** control applies a
per-selector asset cooldown to historical OPEN_SCORE replay. It is off by
default; the disabled input retains 5 bars, and the API accepts effective
`selectionCooldownBars` values from 0 (off) through 10,000. The boundary is the
selected target's last candle at or before the decision time, so cooldown bars
count actual target candles, including bars without decision events. With a
5-bar cooldown, an asset selected at candle index 100 stays blocked through
105 and becomes eligible at 106. A blocked rank falls through to the next
eligible asset, and cooldown state is isolated by arm and replay pass. A
selection starts cooldown even when its future horizon is incomplete. A sole
remaining candidate can be selected but cannot produce a paired comparison.

Each calendar-year replay starts with empty cooldown state and is an independent
experiment rather than a continuation of the full-window replay. The current
cross-sectional snapshot remains raw and is labeled as such when cooldown is
enabled. The effective bar count is saved in `result.json`, the TOP_MEAN run
manifest, result summary, and archive metadata; cooldown-enabled archives use a
distinct archive fingerprint while pair-backtest shards remain reusable.
Cooldown changes require a new replay run and do not affect pair execution.

**Replay mode** defaults to **Fixed horizon**. **Hold until switch** replaces
the horizon comparisons with a separate position replay for all 15 selector
arms. Each arm starts flat, holds one long target asset, and uses the existing
pair-entry decision clock. The first unique pick enters at the next target
open strictly after its decision. A unique pick of another asset schedules a
sale at the held asset's next open, then buys the replacement at its first open
at or after the sale; the positions never overlap. Repeating a pending destination does
not delay its order. A changed destination replaces an unfilled purchase while
preserving a scheduled sale. Selecting the held asset, a tie, or no pick
cancels the pending order; a tie or no pick holds the actual position, or
keeps the arm flat. Singleton pools are eligible. BOT arms remain long and use
their existing bottom-ranking rules. `TOP_RAW_PROFIT` and `TOP_MEAN_PROFIT`
remain labeled **LOOK-AHEAD RESEARCH**.

The simulation uses a fixed $1,000 notional at each entry, without
compounding. Arms are independent normalized research paths, not one shared
account. Slippage is included in entry and exit prices; commission and
slippage are reflected in P&L and are also shown as informational costs. The
full-window cards show total net USD P&L (realized P&L plus open-position mark),
realized P&L, open P&L, completed trades, costs, held asset, pending order, and
data coverage. The final position stays open. Its value uses the last fully
closed target candle at or before the effective window end and frozen run
cutoff; it includes entry cost but no hypothetical exit fee. A pending order
with no next target open before that boundary remains pending. Annual switch
reports each start flat and are independent replays, not a breakdown of the
continuous full-window path.

The `Copy OPEN_SCORE` report includes a performance line for every arm in the
full-window replay and each independent annual replay: status, total/realized/
open USD P&L, closed trades, entries, costs, and current holding or pending
order where present. In the Batch results UI, positive P&L is green and negative
P&L is red; zero and unavailable values stay neutral.

The effective window end is the earlier of the requested end and frozen
evaluation cutoff. No pre-window selection creates a position. Missing target
data, invalid prices or normalized timestamps, a gap over 30 days during an
order or actual holding, or a terminal mark older than 30 days makes the
affected arm incomplete and unavailable for ranking. Shorter gaps are allowed
without interpolation. The result keeps a bounded preview per arm and an exact
trade count. Completed trade records stream to the archive as they finalize,
so the archive keeps the full JSONL history without retaining every row in
memory. The 16-series price cache stays bounded while gap and validation
metadata can be reused after a price array is evicted. This path-dependent
output is stored under the distinct
`top_mean_asset_switch_archive.v1` schema. It does not populate the fixed-horizon
candidate-outcome diagnostics. The cross-sectional `currentSnapshot` remains
a raw view and is distinct from each arm's held position and pending order.

The latest TOP_MEAN result saved in browser storage keeps at most the 20 most
recent full-window trade rows per arm. Independent annual sections retain
their scalar summaries and exact trade counts, but no trade rows. This keeps a
multi-year result within browser storage budgets; the permanent archive still
contains the complete streamed JSONL history. If a selected year has no
retained independent annual trade preview, the details view filters the
full-window preview by UTC decision year and labels it as a filtered preview,
not an independent annual replay. Switch trade staging files live under their
owning run's artifact directory, so artifact retention also removes abandoned
staging files after a crashed process.

Changing replay mode requires a rerun and does not reinterpret a completed
result. Horizon and cooldown controls are disabled in switch mode while their
horizon values are retained. The switch replay does not use cooldown.

### Performance Diagnostics

The coordinator streams compact artifacts from disk for the current snapshot,
target discovery, and each replay window. The snapshot reopens the iterator
for its endpoint, latest-event, and vote passes; neither it nor the coordinator
retains a run-wide trade array. This trades repeated sequential reads for a
bounded heap even when artifact JSON totals several GB. Shard read-ahead stays
at four; the parsed-shard LRU is capped at 32 entries **and 32 MiB of source
JSON**, with oversized shards bypassing the cache. Parsed objects and active
read-ahead add overhead beyond that JSON budget.

Coordinator snapshot, target-discovery, and replay passes use strict artifact
reads: a missing, malformed, or unreadable shard listed as completed fails the
run with its run id, shard index, and failure category. The generic artifact
iterators retain their legacy best-effort default. Retention cleanup evicts
parsed shards belonging to each deleted run.

Snapshot and final result writes await the existing asynchronous atomic
writer, including nonblocking Windows rename retries. The snapshot is durable
before its event is emitted; Stop during either write wins over replay or
successful completion. JSON serialization still runs on the server thread.

Replay sorts one pair's temporary deltas at a time, then retains them in
columnar typed arrays (37 bytes per delta) rather than JS objects. Event
bucketing also uses typed arrays and releases each source stream after copying
it. Timestamp, score, P&L, and confidence columns remain Float64 so numeric
precision and selector semantics are preserved. Total RAM still scales with
trade deltas and event snapshots; these changes remove the full-corpus and
per-delta JS-object heap growth. Standalone runs terminate workers after shard
persistence and before the snapshot/replay; Finder sweeps retain their owned
pool for reuse across candidates.

`npm run test -- open-score-replay-memory.spec.ts` covers the snapshot and
delta scan/sweep with 600,000 trades in a separate 128 MiB-heap process.
An offline check of the 2026-10-01 failed run's 49,007 saved pairs (3.67 GB
of artifact JSON) completed the snapshot and scan/sweep of 135,325,636 deltas
under a 1 GiB heap limit: sampled peak heap 503 MiB, peak process RAM 10,288
MiB. This checks artifact reconstruction and event formation; it does not
include target loading or the final selector simulation.

Completed runs include `performance` (`sp500_top_mean_performance.v1`) in the
TOP_MEAN summary. The Batch panel renders the same compact lines included by
Copy Result and Copy Diagnostic:

- coordinator wall time by preflight, backtesting, snapshot, replay, and result write;
- worker throughput, shard distribution, worker startup/bundle time;
- summed worker time for dataset loading, candle preparation, backtest execution, and artifact creation;
- worker leg/pair/disk cache hit and miss counters;
- replay scan/event/candidate/outcome/aggregate time and target-dataset load time.

Worker cost is summed across parallel workers and can exceed coordinator wall
time. Use wall time for before/after latency and summed worker cost to identify
the bottleneck.

TOP_MEAN archive admission is controlled by the unchecked-by-default `Save full
research archive (~150 MB / 5k pairs)` checkbox. An enabled request writes the
permanent archive under `archive/batch-open-score/<runId>/`: the exact report,
run metadata, and mode-specific replay output. Older/direct API callers that
omit `saveArchiveLog` retain the legacy behavior and request the archive; a
present non-boolean value is rejected. `TOP_MEAN_ARCHIVE_LOG_DIR`
still overrides the location, and an empty value is an absolute server veto.
Only completed runs are archived. Fixed-horizon archives use
`top_mean_archive.v3` metadata with normalized run-manifest provenance and a
causal feature sidecar; frozen legacy archives remain readable as
`top_mean_archive.v2`. Switch archives use the separate
`top_mean_asset_switch_archive.v1` schema and preserve their mode-specific
summary and complete streamed trade history. Live browser summaries keep a
bounded preview of up to 1,000 detail rows per arm per replay window, while
localStorage persists only 20 full-window rows per arm and scalar-only annual
sections. The streamed result and terminal status expose
`archiveComplete`, `archiveRequested`, and, when
applicable, `archiveDir` or `archiveError`. Archive writes remain best-effort,
and saved archives have no TTL or cleanup sweep.

For cold runs, worker threads read synced IBKR and crypto CSVs directly from
disk rather than routing local files through the Vite HTTP server. Worker-thread
reads and synthetic-cache writes use their thread as the blocking boundary,
avoiding Node's shared filesystem thread-pool bottleneck. Hosts with at least 48 GiB of
RAM automatically raise each server loader's leg/pair LRUs from the 24/16
defaults to 128/32; lower-memory hosts retain the defaults. An empty Workers
field uses every available logical core up to the tuned 24-worker cap. Enter a lower
value only when the machine must reserve capacity for another workload.

### API Endpoints

- `POST /api/batch-backtest/sp500-top-mean/run`
- `POST /api/batch-backtest/sp500-top-mean/stop`
- `GET /api/batch-backtest/sp500-top-mean/status`
- `GET /api/batch-backtest/sp500-top-mean/result`

TOP_MEAN Run accepts JSON bodies up to 64 MiB so large custom pair lists
(including 173,166-pair universes) fit. Stop and other control routes retain
their smaller limits. Oversized uploads still return HTTP 413. A rejected
4xx Run request restores the Run button and preserves the server error without
polling for a run that never started; ambiguous connection failures still
reattach through status polling.

The coordinator stream includes a `current_snapshot` event. The final result
and status payloads carry the same optional `currentSnapshot` field.

### Wire-Safety Cap on OPEN_SCORE Event Details

The terminal `done` result and every `/status` reattach payload are wire-safe
summaries (`toWireSafeTopMeanResultSummary`): the full-window
`openScoreEventDetails` array is capped to the most recent
`TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS` (20,000) rows as a PER-PASS TOTAL, the
per-calendar-year `eventDetails` arrays do not ride the wire at all (only
`eventDetailCount` scalars), and the exact pre-cap totals ride along as
`openScoreEventDetailCount` / `eventDetailCount`. The archive-only
`poolSnapshots` / `candidateOutcomes` never cross the wire. Measured on a
20k-pair run (2026-09): the first cap attempt was per-selector and never
bound — the terminal event shipped 53,967 full-window rows plus every year's
rows again (30.7 MB; ~110k detail-row objects parsed and retained by the tab).
With the per-pass cap and per-year rows dropped, the terminal payload is a
few MB. `result.json` on disk and the research archive keep the FULL rows; the
OPEN_SCORE details panel shows a loud truncation notice when the in-memory
rows were capped, and falls back to the capped "Selected Window" section when
per-year rows are absent.

`result.json` retains the full raw replay contract (`eventDetails`,
`horizons[].bars`) and now also records run id, enumeration coverage counts,
target-data boundaries, target-load failures, and no-trade pair count.
`sp500-top-mean-persisted-result.ts` converts raw files, older summary-shaped
files, and snapshot-only checkpoints to the UI contract before the status
route applies the wire cap. Raw aliases never ride the status wire. Older
files without enumeration counts use the manifest pair count and zero for
unavailable coverage counters. The full-result download route still returns
the original disk payload.

### Durable TOP_MEAN Diagnostic Log

The Copy Diagnostic log survives a page reload. Entries are persisted to
localStorage incrementally (progress events on a short debounce; every
lifecycle event — run start, each NDJSON `done`/`fatal`, errors, Stop — is
written through immediately), so the evidence is intact after an OOM crash:
the event timeline, each NDJSON event's approximate byte size, and a
Chrome-only JS-heap sample per entry. After a reload the log is restored and
Copy Diagnostic is re-enabled without needing a new run; starting a new run
replaces the log. Payloads are compacted at record time
(`compactTopMeanDiagnosticData`): small payloads stay verbatim, oversized ones
become a two-level shape summary (array lengths, string lengths, previews), so
the ring, the copied diagnostic, and the persisted log all stay small. Full
payloads remain available through Copy Result / Copy OPEN_SCORE / the details
panel. The diagnostic-log contract lives in
`lib/batch-backtest/sp500-top-mean-diagnostic-log.ts`.

### Validation Commands

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\sp500-pair-enumerator.spec.ts
..\..\..\node_modules\.bin\esno tests\compact-pair-artifact.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker-pool.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-performance.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```
