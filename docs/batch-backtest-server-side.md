# Server-Side Batch Backtest

The Batch Backtest tab can run its heavy per-symbol workload either in the
browser tab (the original path) or in the Vite dev-server (Node) process. The
server-side path exists because 1000+ IBKR 4H synthetic-pair runs hold
~5–10 GB of per-row artifacts (`data` + `signals` + `result.trades`) for the
Mine Timing step, which OOMs a browser tab. Node can use main RAM directly;
the browser tab keeps only rendered scalars and DOM rows.

## When to use server-side mode

Use **Server-Side** when:

- You run large pair lists (≥200 synthetic pairs, especially IBKR 4H).
- You Mine Timing on those lists (Mine needs the per-row artifacts in memory).
- You reattach to a long run after a tab reload.

Use **Browser-Tab** when:

- You are on `vite preview` (no dev server) or a built bundle.
- You are running small lists and want to skip the dev-server round-trip.

## Starting the dev server with extra heap

A 1000-pair run plus Mine Timing holds several GB of OHLCV / signals / trades
arrays on the dev server. The default V8 heap is too small. Start the dev
server with:

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

## The settings toggle

`Settings → Backend Engine → Batch Execution Mode` selects `Server-Side` or
`Browser-Tab`. The default is **Server-Side**. The toggle is a UI-only setting
(it is not consumed by Rust or worker surfaces).

If you change the toggle while a server-side run is in flight, the run keeps
running on the server. Use Stop to cancel it.

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

## Mine Timing on the server

In server-side mode, the per-row artifacts (`data` / `signals` /
`result.trades`) are written to a temporary server-side artifact directory.
The Mine Timing button is enabled when the run's `done` event reports
`serverHasArtifacts: true` (i.e. at least one completed synthetic-pair row was
stored).

Mine does not load all stored pairs into memory at once. It derives the target
assets from artifact metadata, then for each target loads only the synthetic
pairs linked to that target, computes that target's verdict, and releases the
linked artifact objects before moving to the next target. This keeps 6700-pair
Mine runs bounded by the largest single target's linked pair set rather than
the full pair universe.

Clicking Mine streams verdicts back via `POST /api/batch-backtest/mine`.
Clicking Stability Mine streams randomized subset progress via
`POST /api/batch-backtest/stability-mine`. After either miner completes, the
server releases its artifact copy. Re-mining the same run requires a fresh Run
— the same fingerprint guard the browser path uses.

## Artifact retention and TTL

When artifacts are retained, the server keeps the temporary artifact directory
until one of:

1. Successful Mine or Stability Mine completion (after streaming `done`).
2. A new Run starting (`POST /run` removes the prior artifact directory first).
3. **A bounded TTL of 10 minutes** after the Run's `done` event with no Mine
   click.

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

The browser tab still avoids heavy per-row arrays, while copied summaries match
the browser-side Batch path for these sections.

## Reload persistence

The Batch tab persists the latest completed output through
`playground_batch_backtest_latest_results`, using the same envelope helper as
Finder result snapshots. Persisted rows are scalar-only: `data`, `signals`,
`result.trades`, and `result.equityCurve` are stripped before writing to
localStorage. Reloading restores the rendered rows, Copy Results output, and
the latest Stability Mine output when one exists.

Mine Timing is not restored from localStorage because it needs heavy per-row
artifacts. In server-side mode, the reattach status endpoint can still re-enable
Mine while the server artifact TTL is valid and the fingerprint matches. Before
server-side Stability Mine starts, the browser refreshes artifact status from
the server so a stale local flag cannot call the endpoint after artifacts were
released or expired. Stability Mine does not release artifacts, so it can be
rerun with different subset/rerun/seed values until TTL expiry, a new Batch Run,
or Mine Timing releases them.

## Single in-flight run per dev server

The plugin uses the same owner-lock model as IBKR sync. A second `POST /run`
while a run is in flight returns `409 Conflict`. A second `POST /mine` while
Mine is running also returns `409`. Mine and Run share the lock: a new Run
cannot start while Mine is in flight, and vice versa.

This is the single-user dev server model. Multi-tenant / concurrent runs are
out of scope.

## Rust engine parity

Server-side mode preserves Rust engine parity. The user's `useRustEngine`
toggle is forwarded to the server as `useRustEnginePreference` in the run
request body, and `shouldAttemptRust` consults it when running in Node
(where there is no DOM toggle to read). See the "Rust-engine trap" doc in
`docs/batch-backtest-server-side-plan.md` for the full rationale.

Without this fix, server-side mode would silently use the TypeScript engine
even when the user has Rust enabled — a perf regression vs browser mode.

## HTTP API

All endpoints live under `/api/batch-backtest/*`:

- `POST /run` — NDJSON stream. Body: `{ symbols, interval, strategyKey,
  strategyParams, backtestSettings, capitalSettings, useRustEnginePreference }`.
  Streams `start`, `progress`, `symbol`, `symbol_failed`, `done`, `fatal`
  events.
- `POST /stop` — force-bumps the owner lock and aborts in-flight loads. Safe
  to call when no run is active.
- `POST /mine` — NDJSON stream. Body: `{ fingerprint, interval }`. Streams
  `start`, `verdict`, `done`, `fatal` events.
- `GET /status` — JSON snapshot for reattach. Returns `{ running, run, lastRun,
  miner }`.

The `row` sent in `symbol` events contains ONLY scalars — never `data`,
`signals`, or `result.trades`. Those arrays stay server-side. This is the
contract that keeps the browser tab bounded regardless of pair count.
