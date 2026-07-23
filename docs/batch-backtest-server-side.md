# Server-Side Batch Backtest

The Batch Backtest tab runs its heavy per-symbol workload in the Vite
dev-server (Node) process. This single path exists because 1000+ IBKR 4H
synthetic-pair runs hold
~5–10 GB of per-row artifacts (`data` + `signals` + `result.trades`) for the
OPEN_SCORE USD Replay step, which OOMs a browser tab. Node can use main RAM
directly; the browser tab keeps only rendered scalars and DOM rows.

## Runtime requirement

Batch Run and OPEN_SCORE USD Replay require
the Vite server runtime. Both `vite dev` and `vite preview` register these
endpoints; a static-only deployment does not.

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

The OPEN_SCORE USD replay (POST `/api/batch-backtest/open-score-usd`) produces
a `reportLines` text array that the engine builds. Both the dedicated
`Copy OPEN_SCORE USD` button and the main `Copy Results` button render that
array verbatim, so new selector arms — including the short-side
`MAX_ACTIVE_REVERSION` line — ride both copy paths automatically without UI
or service changes.

The browser tab still avoids heavy per-row arrays, while copied summaries match
the browser-side Batch path for these sections.

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
contract that keeps the browser tab bounded regardless of pair count.

## S&P 500 TOP_MEAN UI Coordinator

The S&P 500 TOP_MEAN UI Coordinator runs a long-running batch evaluation over the canonical pair universe formed from S&P 500 IBKR assets.

### Architecture

1. **Preflight & Enumeration**: Intersection of `sp500_company_info.csv`, `price-data/ibkr/catalog.json`, and 30m seed CSV files.
2. **Worker Pool Execution**: Node worker threads (`sp500-top-mean-worker.ts`) execute built-in strategy across pair shards and write atomic `CompactPairArtifact` files under `artifacts/sp500-top-mean/<runId>/shards/`.
3. **Replay & Asset Ranking**: Invokes `runOpenScoreUsdReplay` using target asset price series and compact pair artifacts, yielding TOP_MEAN asset ranking summaries.

### API Endpoints

- `POST /api/batch-backtest/sp500-top-mean/run`
- `POST /api/batch-backtest/sp500-top-mean/stop`
- `GET /api/batch-backtest/sp500-top-mean/status`
- `GET /api/batch-backtest/sp500-top-mean/result`

### Validation Commands

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\sp500-pair-enumerator.spec.ts
..\..\..\node_modules\.bin\esno tests\compact-pair-artifact.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker-pool.spec.ts
..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```
