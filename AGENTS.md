# AGENTS.md
1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them - don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.

2. Simplicity First
Minimum code that solves the problem. Nothing speculative.

No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:

Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
If you notice unrelated dead code, mention it - don't delete it.
When your changes create orphans:

Remove imports/variables/functions that YOUR changes made unused.
Don't remove pre-existing dead code unless asked.
The test: Every changed line should trace directly to the user's request.

4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

"Add validation" -> "Write tests for invalid inputs, then make them pass"
"Fix the bug" -> "Write a test that reproduces it, then make it pass"
"Refactor X" -> "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:


1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.


5. Use the model only for judgment calls
Use for: classification, drafting, summarization, extraction.
Do NOT use for: routing, retries, status-code handling, deterministic transforms.
If code can answer, code answers.

6. Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

7. Read before you write
Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

8. Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

9. Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

10. Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork it silently.

11. Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.



## Mission
This repository is a Vite + TypeScript trading strategy playground with a large UI surface, local market-data caching, optional Rust acceleration, and optional Cloudflare Worker alerts.

Use this file as the short operational handbook for making safe changes quickly.

## Start Here

Before editing anything important:
1. Read `README.md` for the repo-level map.
2. Read `lib/app-bootstrap.ts` for initialization order and `index.ts` for the thin entrypoint.
3. Check `git status --short` so you do not trample unrelated work.
4. Identify which contracts your change touches:
   - UI ids / partials
   - settings schema / localStorage
   - strategy registration
   - backtest engine semantics
   - Rust fallback compatibility
   - Worker compatibility

## Mental Model

This codebase is a collection of tightly-coupled subsystems:
- runtime-injected UI assembled from `html-partials/*`
- id-driven handlers and feature managers
- strategy execution and backtesting
- multi-source data loading and caching
- optional worker-side signal evaluation and subscriptions

Most breakages come from contract drift, not algorithm bugs.

Recent refactor seams worth preserving:
- app startup sequencing lives in `lib/app-bootstrap.ts` (explicit ordered `await runBootstrapStep(...)` calls — no declarative dependency graph)
- shared state still lives in `lib/state.ts`, but app writes should go through `lib/state-actions.ts`
- blob-style localStorage persistence now routes through `lib/persisted-json.ts`
- backtest progress/status presentation now lives in `lib/backtest-run-presenter.ts`

## The Contracts Most Likely To Break

### 1. UI DOM contracts
- Structural ids are defined in feature-local `*-dom.ts` modules next to the consuming handler, renderer, or service
- `lib/feature-dom-contracts.ts` is only a compatibility barrel that re-exports those contracts
- HTML source of truth is `html-partials/*`
- Consumers live in handlers and managers such as:
  - `lib/handlers/ui-event-handlers.ts`
  - `lib/renderers/resultsRenderer.ts`
  - `lib/finder-manager.ts`
  - `lib/walk-forward-service.ts`

If you rename or remove a structural id:
1. update the partial
2. update the matching feature-local `*-dom.ts` contract
3. update the feature code
4. run `feature-dom-contracts.spec.ts`

### 2. Strategy registration split
- Main UI/runtime registers built-ins through `strategyRegistry.ts`
- Built-in source of truth is `lib/strategies/lib/*`, with generated metadata, loader, key, and eager manifest files under `lib/strategies/manifest*.ts`
- Browser UI listing uses `manifest-summary.ts`; browser strategy execution loads code through `manifest-loaders.ts`
- `lib/strategies/library.ts` uses the eager manifest and is what worker-side evaluation imports

If a built-in strategy is added or renamed and the manifest is not re-synced, the strategy will not load consistently in the UI/worker path.

### 3. Settings compatibility
- Preserve localStorage/backward compatibility unless you add migration logic
- For JSON blob persistence, prefer `lib/persisted-json.ts` over open-coded `localStorage` + `JSON.parse/stringify`
- Removed settings may still appear in old saved payloads; ignore them unless you are explicitly writing a migration

If a new setting is unsupported by Rust, strip it in both:
- `lib/backtest-service.ts`
- `lib/finder-manager.ts`

### 4. Time normalization
This repo accepts multiple time shapes:
- unix seconds
- unix milliseconds
- ISO strings
- `BusinessDay`

Prefer existing helpers:
- `timeKey`
- `timeToNumber`
- existing parse/normalize helpers

Do not introduce new ad hoc time conversion paths unless there is no existing seam.

## Repo Map

See `README.md` under `Architecture Map` for the canonical subsystem and file map.

## Safe Change Checklist

### Any UI change
- Confirm whether the element is structural or optional
- If structural, add it to the matching feature-local `*-dom.ts` contract
- Update the relevant partial and manager/handler together
- Run:
  - `npm run typecheck`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

### Any backtest behavior change
- Validate:
  - long
  - short
  - both / combined if touched
  - `signal_close`
  - `next_open`
  - `next_close` if touched
- Recheck entry timing if signals/fills moved

### Any settings change
- Keep key names stable when possible
- Check UI load/save path in `lib/settings-manager.ts`
- If persisted JSON shape changes, add a migration in the relevant `readPersistedJson(...)` callsite instead of silently breaking old payloads
- Check any resolver/sanitizer path that mirrors those settings
- If you change the Polymarket bridge `external_signal` payload or `polymarketEntryOffset` contract, keep `scripts/export-latest-entry-signal.ts` and the bridge export code in `lib/polymarket-panel-service.ts` aligned
- If you change `polymarketExitMode`, keep `docs/polymarket.md`, endpoint fences, and Finder/Hunt apply-result behavior aligned

### Any worker-facing change
- Check `lib/alert-service.ts`
- Check `workers/entry-signal-worker.ts`
- If schema changes, add a migration

## Feature-Specific Workflows

### Add a built-in strategy
1. Pick the key first. Keep the file name and exported const aligned with that key when possible.
2. Create `lib/strategies/lib/<strategy-key>.ts`
3. Export `const <strategy_key>: Strategy = { ... }`
4. Always include:
   - `name`
   - `description`
   - `defaultParams`
   - `paramLabels`
   - `execute(data, params)`
   - `metadata` with `role`, `direction`, and `walkForwardParams` when applicable
5. Add `normalizeParams` if execution rounds, clamps, coerces sign, or otherwise sanitizes params
6. Run `npm run strategies:sync-manifest`
7. Do not manually wire `strategyRegistry.ts`; built-ins are loaded from the manifest
8. Verify dropdown + worker compatibility

Strategy-lib contract notes:
- If `execute(...)` changes parameter meaning, `normalizeParams` must expose the same canonical values to Finder and Walk Forward
- Keep `defaultParams` already valid after normalization
- If a param is optimized by WFA/Finder, it must exist in:
  - `defaultParams`
  - `paramLabels`
  - `metadata.walkForwardParams`
  - the execution logic
- If you add `prepareFinderData(...)`, keep `executePrepared(...)` behavior identical to `execute(...)`

Recommended strategy-lib skeleton:
Read `lib/strategies/lib/close_location_median_alignment.ts` for a simple implementation or `lib/strategies/lib/rolling_vwap_center.ts` for a Finder-prepared implementation.

Useful helper maps:
- `lib/strategies/strategy-helpers.ts`: Core signals (`createSignalLoop`, `createBuySignal`, `createSellSignal`) & base OHLCV array extractors (`getCloses`, `getHighs`, `getVolumes`, `ensureCleanData`).
- `lib/strategies/lib/price-action-frequency-core.ts`: For individual bar geometry (`computePriceActionBarMetrics`) extracting wicks, body, and range metrics seamlessly.
- `lib/strategies/lib/price-action-statistics-core.ts`: Essential for robustness constraints (`buildRollingEntropy`, `buildEfficiencyRatio`, `buildRollingMedian`, `buildRollingZScore`, `buildStreakCount`).
- If you edit `archive/prompt.txt`, only list helpers that already exist as exported strategy-layer utilities. Prefer low-complexity primitives such as price extractors (`getOpens`, `getTypicalPrices`), bar geometry series (`buildRangeSeries`, `buildBodyPctSeries`, `buildCloseLocationSeries`), crossover, pivot-flag, and timeframe-alignment helpers over prompt-only or speculative surfaces.

Important Type and Dependency Gotchas:
- Keep track of indicator outputs: some like `calculateADX` and `calculateATR` return pure generic arrays `(number | null)[]`, while `calculateKeltnerChannels` returns objects nested with arrays.
- Type coercion matters: pass `cleanData` (which is `OHLCVData[]`) to `buildEfficiencyRatio`, but pass `closes` (which is `number[]`) to standard mapping and extraction routines.
- Array indexing: ensure you loop against generic padding `if (i < lookback || indicator[i] === null) return null;` securely within closures.

Useful examples:
- `lib/strategies/lib/close_location_median_alignment.ts`
  - small strategy with explicit normalization and direct `execute(...)` use
- `lib/strategies/lib/rolling_vwap_center.ts`
  - Finder-safe prepared-data reuse with normalized params
- search `prepareFinderData` under `lib/strategies/lib/*`
  - only for strategies where dataset-derived precompute materially reduces Finder cost

Strategy-lib checklist before you stop:
- file exists in `lib/strategies/lib/*`
- exported const name is the strategy key
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are already valid after `normalizeParams`
- `normalizeParams` exists if execution sanitizes params
- `metadata.walkForwardParams` only references real params
- `execute(...)` uses normalized params if bounds or trigger semantics depend on them
- `npm run strategies:sync-manifest` run so `lib/strategies/manifest.ts` is up to date
- `npm run typecheck` passes
- add or update a focused strategy spec if normalization, Finder, or WFA behavior is non-trivial; run `tests/new-strategy-lib-smoke.spec.ts` as baseline sanity
- manually confirm the strategy appears in the dropdown if UI behavior changed

Strategy-lib failure modes seen repeatedly:
- sanitizing params inside `execute(...)` but forgetting `normalizeParams`, causing WFA/Finder/base-param drift
- letting WFA optimize a param that execution later snaps to a different grid without exposing that grid
- using negative values as shorthand for absolute thresholds, then showing impossible negative base params in the UI
- adding expensive per-bar allocations in Finder hot paths when a cheap reusable array precompute would do
- adding `prepareFinderData(...)` but not keeping `executePrepared(...)` aligned with `execute(...)`
- typing array outputs incorrectly resulting in `Type 'number' is not assignable to type 'OHLCVData'` compiler errors
- assigning undefined accessors to objects mapping structural output boundaries (e.g., calling `atrMinMax[i]!.min` instead of `atrMinMax.min[i]!`)

### Modify Finder
- Expect performance sensitivity
- Avoid expensive per-bar allocations in hot loops
- Preserve cache decisions and deterministic seeded behavior
- If touching robust mode, keep explicit `PASS`/`FAIL` decision semantics

### Memory budget (Finder Universe and Batch Backtest)
- Each OHLCV dataset is ~5–10 MB at the 100k-bar cap. The dominant retention is N symbols × full dataset held simultaneously, not per-run allocations.
- Finder Universe (`lib/finder/finder-runner-universe.ts`): `loadedSymbols[i].data` plus `closedDataBySymbol` hold every universe symbol's data for the whole evaluation. They are released after the candidate loop ends; do not add new consumers that extend their lifetime. The `universeDatasetCache` (`lib/finder-manager.ts`) is LRU-bounded and cleared only by `invalidateLocalDataCaches()`.
- Batch (`lib/batch-backtest/batch-backtest-runner.ts`): `BatchBacktestSymbolResult` carries `data`, `signals`, and `result.trades` per row. These are retained for OPEN_SCORE USD Replay on synthetic pair rows; non-synthetic rows omit `signals`. Don't add post-analysis reads of these arrays — use `tradeSummary` or scalars off `result` instead.
- Realistic browser heap limits: 1000+ synthetic pairs exceed a default 8 GB V8 heap. Recommend running with `--max-old-space-size=12288+` and/or splitting into chunks of 200–400 pairs per run.
- Cache caps to respect (lower only with cause; raise only after checking steady-state footprint):
  - `UNIVERSE_DATASET_CACHE_MAX_ENTRIES` in `lib/finder-manager.ts` (default 128)
  - `MAX_CACHE_ENTRIES` in `lib/data/data-cache.ts` (default 64)
  - `legCache` / `pairCache` in `lib/batch-backtest/batch-backtest-loader.ts` (default 24 / 16)
  - These are cleared at Batch run end and after analysis runs; Finder Universe relies on cross-strategy reuse, so do not clear mid-run.
- IBKR 4H synthetic pairs require the 30m seed CSVs at `price-data/ibkr/csv/30m/`. Do NOT try to "optimize" synthetic pairs by loading pre-aggregated 4H legs — the ratio must be computed at the seed interval (30m) and *then* aggregated, not the other way around. Computing `base.high/quote.high` from 4H bars conflates extremes from different moments within the bucket and inflates the bar range (see comment at `scripts/lib/synthetic-pair.ts` `buildSyntheticPairDataset`). `npm run ibkr:aggregate` exists to write `4h/*.csv` for **single-symbol IBKR 4H charts** (where no ratio is involved); it does not help and must not be used for synthetic-pair legs.

### Server-Side Batch Backtest
- Batch Backtest runs in the Vite server through `lib/batch-backtest/batch-backtest-vite-plugin.ts`, using the IBKR sync plugin's owner-lock + NDJSON stream + status-snapshot reattach pattern. See `docs/batch-backtest-server-side.md`.
- `BatchBacktestService.runBatch()` POSTs to `/api/batch-backtest/run`, consumes NDJSON via `consumeNdjsonStream` (`lib/ndjson-stream.ts`), and reconstructs scalar-only rows.
- **The `row` sent over the wire must NEVER contain array fields** (`data`, `signals`, `result.trades`). Use `toScalarRow(...)` (`lib/batch-backtest/batch-backtest-stream-types.ts`) before emitting a `symbol` event. The server writes per-row analysis artifacts to a temporary disk directory and loads linked pairs back per target during OPEN_SCORE USD Replay. This contract keeps the browser tab and Node heap bounded regardless of pair count.
- **OPEN_SCORE USD button gating**: gate on the `serverHasArtifacts` flag (set by the `done` event / `GET /status`), NOT on `row.data !== undefined`. The browser never holds `row.data`.
- **Engine selection**: `shouldAttemptRust` in `lib/backtest-executor.ts` consults `context.useRustEnginePreference` when running in Node (no DOM). The server-side runner threads `useRustEnginePreference` from the request body, which the browser-side service populates from `shouldUseRustEngine()`. Without this, server-side mode silently uses the TypeScript engine even when the user has Rust enabled (the "Rust-engine trap").
- **Portfolio Fit / Mine Prediction / Mine Timing / Stability Mine** — all removed. See `docs/mine-timing-validation-findings.md` for the negative research conclusions that drove the removals. Do not reintroduce allocation advice, prediction diagnostics, or timing-edge miners built on `oosLiftPct`/verdict inputs the validation proved carry no predictive information.
- **OPEN_SCORE USD Replay** (`POST /api/batch-backtest/open-score-usd`): an analysis route that reconstructs historical OPEN_SCORE decision events from retained artifacts and measures whether each selector arm (TOP_RAW / TOP_ADJUSTED / TOP_MEAN / MAX_ACTIVE / MAX_SUBMITTED / MAX_RETAINED on the long side, MAX_ACTIVE_REVERSION on the short side) beats a uniform-random control at fixed forward horizons. The engine lives in `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` (pure leaf — no `lightweight-charts`). Four load-bearing contracts:
  - **Opaque `reportLines` rendering**: the engine produces `reportLines: string[]`; the display div, the dedicated Copy button (`batch-backtest-service.ts:copyOpenScoreUsdResults`), and the main Copy Results button all render `reportLines.join("\n")` verbatim. New selector arms ride both copy paths automatically — do NOT add per-arm UI/service plumbing. To add a selector arm: extend the horizon interface, mirror the existing `pickMax` + `appendSelection` + `buildComparison` + `comparisonLine` pattern, and run the spec. Every asset-picking arm (TOP_RAW, TOP_MEAN, MAX_ACTIVE, MAX_ACTIVE_REVERSION) must ship with its parallel `<ARM> selected assets` breakdown AND `<PREFIX>_EX_<dominant>` exclusion line — they are the concentration-vs-broad-based diagnostics that make a positive delta interpretable. Skipping either on a new arm silently regresses the research surface.
  - **Direction-correct candidate pools**: long arms read from `positives[]` (rawScore > 0) and use the long return array `(exit − entry − fees) / entry`. `MAX_ACTIVE_REVERSION` reads from `negatives[]` (rawScore < 0) and uses the short return array `(entry − exit − fees) / entry` with flipped slippage sides. Both return arrays are precomputed per (asset, horizon) at the outcome phase. Do NOT mix directions in a pairwise arm — `appendPairwise` uses the long-side `retByAsset` map only; a long-vs-short pairwise would mix directions and is not interpretable.
  - **Independent eligibility gates**: long arms require `positives.length >= 2` AND every positive's long return finite; reversion requires `negatives.length >= 2` AND every negative's short return finite. The two gates are independent — an event can contribute to one arm and not the other. A long-only pair universe (every entry adds +1 to base) triggers the empty-reversion warning; do NOT silently zero-fill missing negative pools.
  - **Reversion dominant-asset exclusion**: `maxActiveReversionExDominant` mirrors `maxActiveExDominant` for the short side — drops events where `MAX_ACTIVE_REVERSION` picked its most-frequently-selected asset (ties by FNV-1a digest). Use this to distinguish concentration artifacts from broad-based reversion edges.
- **`fetchLocalApi` Node URL resolution**: `lib/local-api-transport.ts:resolveLocalApiUrl` resolves relative `/api/...` URLs against `http://127.0.0.1:5173` (override via `VITE_DEV_SERVER_ORIGIN`) when running in Node. Browser `fetch` does this automatically; Node's `fetch` does not. The server-side loader goes through `loadSqliteCandles` → `fetchLocalApi("/api/sqlite/...")`, so without this fix every local-data load would throw `TypeError: Invalid URL` server-side.
- **Node heap requirement**: recommend `NODE_OPTIONS=--max-old-space-size=16384` (or higher) when running server-side batches. Document this whenever you touch the plugin's memory budget.
- **Artifact TTL**: the plugin holds disk-backed analysis artifacts until a new Run starts OR a 10-minute TTL fires (`DEFAULT_ARTIFACT_RETENTION_MS` in `batch-backtest-vite-plugin.ts`). The TTL is the defense-in-depth the browser path got for free via tab reload. Do NOT remove it without a replacement.
- **Loader parity**: `lib/batch-backtest/server-batch-data-loader.ts` must mirror `lib/batch-backtest/batch-backtest-loader.ts` 1:1 (same synthetic-pair pipeline, same `SyntheticLegCache` cap, same stale-fragment thresholds, same DATA_CHART_TOTAL_LIMIT lookback). The browser loader goes through the `dataManager` singleton (browser-bound); the server loader constructs `DataFetcher` directly with empty UI callbacks (recipe at `lib/data/data-fetcher.ts:178-192`). Drift between the two causes silent wrong-data symptoms. `tests/batch-backtest-server-loader-parity.spec.ts` locks the structural invariants.
- **Server-side import hygiene (vite.config.ts bundle trap)**: anything imported by `lib/batch-backtest/batch-backtest-vite-plugin.ts` (transitively) ends up bundled by esbuild when Vite bundles `vite.config.ts` for the Node dev server. Do NOT import from `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`, `lib/ui-manager.ts`, or any module that transitively reaches `lib/constants.ts` or `lib/chart-manager.ts` — both import `lightweight-charts`, which is ESM-only and fails the cjs config bundle. The server-side loader imports `parseSyntheticPairToken` from the leaf `lib/synthetic-pair-token.ts` (not finder-manager) for exactly this reason. If a new server-side module needs a helper that currently lives in a browser-bound module, extract the helper to a leaf first. Symptom of breakage: dev server fails to start with `Failed to resolve "lightweight-charts". This package is ESM only but it was tried to load by require`.
- New settings ids belong in `BACKTEST_SETTINGS_DOM_CONTRACTS`; `BACKTEST_DOM_SETTING_IDS` is derived from that single source. `tests/feature-dom-contracts.spec.ts` verifies that every registered id exists in the HTML partials.
- Validation habit after Server-Side Batch changes:
  - `npm run typecheck`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-loader-parity.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-max-active.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
  - Manual smoke: start `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run a 50-pair batch and then a 1000-pair batch. Confirm progress, Stop, Copy, OPEN_SCORE USD, and reload reattach.

#### Audit Findings (2026-07) — Batch + Finder server-side hardening
Nine audit findings landed across the Batch and Finder server plugins. The contracts they introduced are load-bearing — do not regress them when touching these files. Each has a regression test; the test name carries the finding number.
- **F1 Loopback authorization on Finder routes**: every `/api/finder/*` route (`universe-run`, `stop`, `status`, `invalidate-cache`) gates on `isAllowedLocalRequest` (`lib/local-route-authorization.ts`), the same loopback/bearer policy the Batch, IBKR, and strategy-admin routes enforce. A `--host`ed / tunneled / reverse-proxied dev server must NOT allow a remote caller to launch a CPU-heavy run, cancel an active job, read results, or thrash caches. Route registration lives in `registerFinderRoutes` (exposed as `registerFinderRoutesForTests`); lock the gate via `tests/finder-server-plugin.spec.ts`'s "route-level authorization" suite.
- **F2 Artifact-write backpressure**: `BatchBacktestRunCallbacks.onSymbolComplete` is `void | Promise<void>` and the runner `await`s it; the server plugin's `storeMineArtifact` is `async` and awaits an `ArtifactSubmissionGate` slot (cap `ARTIFACT_SUBMISSION_CAPACITY`) before capturing the multi-MB artifact closure. Peak live captured artifacts are bounded by CAP × artifact size, not the run size. Don't make `onSymbolComplete` synchronous again or remove the gate — either re-introduces the unbounded queue that retained GBs on 1000-pair runs.
- **F3 Generation-safe artifact cleanup**: `releaseLastResults` detaches the current generation's store (`mineArtifactDir`, `lastMineArtifacts`, `parsedArtifactCache`, `pendingArtifactWrites`, `serializeGate`) SYNCHRONOUSLY before its first `await`. A concurrent new Run that installs its own dir during the flush window must NOT be clobbered by the old cleanup. Don't move the detach below an `await`.
- **F4 Disconnect-safe NDJSON streams**: all Batch streaming handlers wrap `beginNdjsonStream` in `createDisconnectSafeStream` (`lib/vite-http-utils.ts`). A disconnected Run keeps executing because `/status` can reattach and recover rows. OPEN_SCORE USD Replay cancels on disconnect because its streamed result is not recoverable; retained Batch artifacts remain available for retry. Do NOT pass `stream.write` directly to a long-running process function; use the wrapper's `.write`/`.end`.
- **F5 runId-scoped Stop**: Batch persists a browser `runId` (`playground_batch_backtest_active_server_run`, schema `batch_backtest.active_server_run`, v1), sends it on `/run` and `/stop`, and restores it on init before `/status` reattach. The server rejects missing or mismatched ids while a modern run owns a non-empty id. A `pendingStopRunId` single-slot closes the Stop-before-ownership race. Unscoped Stop is accepted only for legacy server state whose run id is empty.
- **F6 Terminal failures preserved in `/status`**: `BatchRunSnapshot` carries `phase` (`"running"|"done"|"cancelled"|"fatal"`), `finishedAt`, `summary`, `error`. `handleStatusRequest` exposes `lastRun` whenever `runState` is retained and `runOwner === NONE` — INDEPENDENTLY of `hasStoredMineArtifacts()` (which stays a separate `hasArtifacts` capability flag for the OPEN_SCORE USD button). A fatal/no-artifact run must NOT vanish from `/status` after a reload.
- **F7 PID-scoped orphan sweep**: artifact dirs are named `strategies-finder-batch-mine-<pid>-<createdAtMs>-<random>` and `sweepOrphanedMineArtifactDirs` reclaims a stamped dir when its PID is provably dead. A live PID always wins over age; age is only a fallback for indeterminate/legacy ownership. Do NOT revert to the bare-prefix sweep — it deleted a concurrently-running sibling Vite process's multi-GB active artifacts.
- **F9 Unique failed Finder symbols**: the multi-strategy Finder job tracks `failedSymbolSet` (a `Set<string>`) for the user-facing `failedSymbols` total; `failedLoadAttempts` (the per-strategy sum) stays in `debugLogger.event("finder.server.run.complete")` for diagnostics. A symbol that fails to load fails for every selected strategy — summing per-strategy double-counts. Don't revert to `failedSymbolsTotal += output.failedSymbols.length` in `lib/finder/server/finder-vite-plugin.ts`.

### Server-Owned Finder Symbol Universe
- Finder **Symbol Universe** is a server-owned job: the Vite dev server via `lib/finder/server/finder-vite-plugin.ts` owns all selected strategies, IS evaluation, survivor merge, OOS validation, diagnostics combination, and the authoritative terminal candidate slice. Current-chart Finder remains in-tab. See `docs/finder-server-side.md`.
- **One request per run**: the browser submits all selected entry strategy keys + a browser-generated `runId` in a single `POST /api/finder/universe-run`. `FinderManager.runUniverseFinder` no longer sequences per-strategy requests. Polymarket scoring remains unsupported in Universe mode.
- **The streamed `candidate` must NEVER contain array fields** (`data`, `signals`, `trades`, `equityCurve`). `FinderUniverseCandidate` is already scalar by design; `toScalarCandidate(...)` + `assertCandidateIsScalar(...)` (`lib/finder/server/finder-stream-types.ts`) enforce this at the source. The forbidden-field contract is locked by `tests/finder-server-plugin.spec.ts`.
- **Loader parity**: `lib/finder/server/server-finder-data-loader.ts` reuses `createBatchDatasetLoaderCore` from `lib/batch-backtest/batch-dataset-loader-core.ts` (the SAME core the Batch server loader uses), so the synthetic-pair pipeline, `SyntheticLegCache` caps, and offline-first gap-fill are identical by construction. Do NOT fork a second synthetic-pair pipeline. Locked by `tests/finder-server-loader-parity.spec.ts`.
- **OOS runs server-side**: the server runs the OOS pass via the leaf `runUniverseOosPass(...)` (`lib/finder/finder-universe-oos.ts`), a faithful lift of the prior `FinderManager.applyUniverseOosValidationIfNeeded`. The browser loads NO Universe OHLCV for IS or OOS. Diagnostics are combined server-side by the leaf `buildCombinedUniverseDiagnostics(...)` (`lib/finder/finder-universe-diagnostics-combine.ts`). Do NOT re-introduce a browser-side Universe OOS path or `loadUniverseDataset` — those were removed.
- **Param generation MUST be passed through**: the HTTP handler builds a `FinderParamSpace` and passes `generateParamSets` to `processFinderUniverseRun`. The core falls back to `() => []` when it's missing, producing zero candidates. Tests inject their own; the production HTTP path is the only place this is easy to miss.
- **Data slicing MUST be applied in the server loader wrapper**: the HTTP handler's `loadDatasetWithSlice` applies `sliceFinderDataWindow(data, options.dataSlice)` before IS evaluation. OOS resolves its OWN complementary slice via `resolveUniverseOosSlice(...)` + `sliceFinderDataWindow(...)` exactly once inside the OOS loader wrapper.
- **Stop MUST POST `/api/finder/stop` with the active `runId`**: Stop is scoped by run id so a stale tab cannot cancel a newer run. The handler aborts in-flight loads, makes every strategy + OOS loop observe lost ownership, marks the snapshot cancelled, and the browser clears its active-run record. `pendingStopRunId` (single slot) closes the Stop-before-ownership race without an unbounded cancellation set.
- **Reattach on Finder init**: the browser persists the active `runId` (`playground_finder_active_server_run`, schema `finder.active_server_run`, v1) before `fetch`, and `FinderManager.init()` polls `GET /api/finder/status?runId=...` to recover an in-flight or terminal job after reload. Reattach only survives a browser reload while the same Vite process is alive. In-progress `/status` polls are summary-only (candidate counts); the terminal snapshot carries the authoritative candidate slice once.
- **Per-job dataset reuse**: the server job caches successful sliced datasets by `symbol|interval` across all selected strategies and clears the map in the job `finally` path. Do not move this to an unbounded process-global cache. Failed/empty loads must remain retryable, and copied diagnostics must retain the job-cache hit/miss counters.
- **`runId` ownership guard**: every stream + poll callback checks `this.activeServerRunId === runId` before mutating UI state so a stale tab cannot clobber a newer run. `runFinder` and Stop cancel stale reattach polling before changing UI ownership.
- **`useRustEnginePreference` MUST thread through to `executeBacktest`**: the universe runner's `executeBacktest` context carries `useRustEnginePreference` (undefined in browser; set from the request body server-side). The OOS leaf threads the same preference into its `executeBacktest` context. Without it, server-side Finder silently uses TS even when Rust is enabled (the documented Rust-engine trap).
- **Vite server required**: a 404/405 from `/api/finder/universe-run` is an explicit error. Both `vite dev` and `vite preview` register the endpoint; static-only deployments do not.
- **Server-side import hygiene (same bundle trap as Batch)**: `lib/finder/server/finder-vite-plugin.ts` is imported by `vite.config.ts`. Do NOT import from `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`, or anything transitively reaching `lib/constants.ts` or `lib/chart-manager.ts` (both pull `lightweight-charts`, ESM-only). The server plugin reaches only leaf modules (`finder-runner-universe`, `finder-universe-metrics`, `finder-universe-diagnostics-combine`, `finder-universe-oos`, `server-finder-data-loader`, the synthetic-pair disk cache). Symptom of breakage: dev server fails to start with `Failed to resolve "lightweight-charts". This package is ESM only`.
- **No analysis artifacts / no TTL**: Universe has no server-side analysis step. Do NOT copy the Batch plugin's artifact directory or 10-minute TTL machinery into the Finder plugin — they would be dead code.
- **Per-run JSONL diagnostics log**: Asset Opportunity single/batch runs append one JSON line per event (`iteration_start`, `asset_complete`, `asset_failed`, `iteration_complete`) to `<root>/archive/finder-runs/<runId>.jsonl` (`FINDER_RUN_LOG_DIR` overrides the dir; `FINDER_RUN_LOG_DIR=""` disables). This is the durable post-mortem trace when the Vite process dies mid-run — the in-memory debug ring buffer does not survive. The sink is fire-and-forget and must never throw into a run; tests inject a capture sink via `FinderAssetOpportunityRunInput.runLog`.
- **Parallel Asset Opportunity batch holdout sweep**: the production batch route runs holdout iterations across a bounded `worker_threads` pool (`lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts`; one holdout value per task; worker entry `finder-asset-opportunity-batch-worker.ts`). Load-bearing contracts, locked by `tests/finder-asset-opportunity-batch-parallel.spec.ts`:
  - The MAIN THREAD is the single writer. Workers never append archives, emit stream events, or write the JSONL run log directly — completions are buffered and released in ASCENDING holdout order (`completeOrderedIteration` in the plugin), so archives/events stay byte-identical to a sequential run.
  - `runAssetOpportunityIteration` lives in the leaf `lib/finder/server/asset-opportunity-iteration.ts` (re-exported by the plugin) — keep it leaf-only so the worker can import it without dragging in run state or `lightweight-charts`.
  - Strategy objects never cross the worker boundary: tasks carry keys, and the worker re-resolves via `loadBuiltInStrategyByKey`. Iteration payloads on the wire are the already-scalar rows from `toScalarAssetResult`.
  - `FINDER_ASSET_BATCH_WORKERS=1` must keep working — it forces the sequential in-process loop (the rollback lever). The sequential path must remain in `processFinderAssetOpportunityBatchRun`, sharing the same per-iteration tail as the parallel path.
  - Failure semantics match sequential: a fatal iteration archives everything before it and aborts everything after it; Stop discards in-flight iterations but flushes completed ones ascending; a worker crash maps to the same `asset_batch_fatal` path.
  - Each worker holds its own copy of every symbol dataset (~9 MB/symbol); the worker count comes from `resolveAssetOpportunityBatchWorkerCount` (cores − 2, holdout count, and a memory ceiling budgeting 75% of ACTUAL system RAM — `os.totalmem()`, injectable in tests — for the SUM of worker footprints; `--max-old-space-size` is per-isolate and cannot bound that sum). The explicit `FINDER_ASSET_BATCH_WORKERS` override intentionally bypasses the ceiling (operator judgment, capped at 32). Rust-engine runs should use fewer workers (4–8) — the external Rust HTTP server serializes.
  - Worker progress messages carry `loadedSymbols`/`failedSymbols`/`strategyIndex`; the plugin's parallel `onProgress` mirrors them onto the snapshot (latest-writer-wins across in-flight iterations) so `GET /api/finder/status` keeps reporting live counters. Dropping those fields regresses `/status` to zeros mid- and post-run.
- Validation habit after Server-Owned Finder changes:
  - `npm run typecheck`
  - `npm run typecheck:tests`
  - `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-universe-metrics.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-universe-oos.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-batch-parallel.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
  - Manual smoke: start `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run one and multiple strategies over 50 symbols, then 400 symbols. Confirm progress scaling, server-side OOS filtering, Stop (scoped by run id), diagnostics merging, reload reattach during IS and OOS, and Apply.

### Modify Exit Strategy Override
- Keep it gated on `disableSignalExits`; when normal signal exits are enabled, the override is inert
- Preserve `Signal.exitOnly` through signal preparation and every TS engine signal loop; exit-only signals close opposite positions but never open new positions
- Register new settings ids in `BACKTEST_SETTINGS_DOM_CONTRACTS` in `lib/backtest-settings-dom-contract.ts`. `BACKTEST_DOM_SETTING_IDS` is derived from that contract and used by `backtestService.getBacktestSettings()`; `tests/feature-dom-contracts.spec.ts` verifies the matching HTML id exists.
- `applyDerivedBacktestSettingGuards` in `lib/backtest-settings-resolver.ts` must preserve `disableSignalExits` when `exitStrategyOverrideEnabled` is on, even before a strategy key is picked. Without this guard exemption, the resolver strips `disableSignalExits` before the user can finish configuring the override (chicken-and-egg)
- Finder currently has browser-owned current-chart, Strategy Quality, genetic, and Polymarket paths plus server-owned Symbol Universe and Asset Opportunity paths. Keep any unsupported cross-symbol or Worker/Scanner surface explicitly guarded; do not infer support from shared Finder result types alone.
- In Symbol Universe, each entry param set samples one exit strategy lib + param set, and the survivor row exposes `exitStrategyKey`/`exitStrategyName`/`exitStrategyParams` so the chosen lib is visible; Apply writes the override settings (`exitStrategyKey`, `exitStrategyParams`, `disableSignalExits`, `exitStrategyOverrideEnabled`)
- Finder exit params use the `_exit__` prefix internally and must split before entry-strategy normalization, result display, and Apply
- Apply must write both `exitStrategyKey` and `exitStrategyParams`, and force `disableSignalExits` plus `exitStrategyOverrideEnabled`
- Validation habit after changes:
  - `npm run typecheck`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\backtesting-engine.spec.ts`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\exit-strategy-merge.spec.ts`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\exit-strategy-param-prefix.spec.ts`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-cache-decision.spec.ts`
  - `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

### Modify Polymarket scoring
- Keep the five Polymarket contracts separate:
  - direct charting
  - outcome scoring
  - diagnostics
  - bridge export
  - Execution Lab live trade
- `polymarketExitMode` defaults to `resolve_hold`
- `signal_exit_same_event` is only effective on `1m` + `next_open` and supported `1s` BTCUSDT/XRPUSDT CLOB `signal_close`, `next_open`, or `next_close` runs; use `resolveEffectivePolymarketExitMode(...)` instead of open-coded checks
- Signal-exit pricing depends on local `polymarket_price_points`; if you change ingestion or storage, update together:
  - `lib/polymarket-price-points-ingest.ts`
  - `lib/local-sqlite-polymarket-api.ts`
  - `vite.config.ts`
  - `docs/polymarket.md`
- Finder and Hunt signal-exit mode must not fan out by `polymarketEntryOffset`; applying results should preserve `polymarketExitMode` and only write offset data in `resolve_hold`
- endpoint Preview / Copy / HTTP execution intentionally stay on `resolve_hold`; do not silently broaden those callers
- Execution Lab live trade is not bridge export: browser code sends non-secret order intent to a local executor, private keys stay in `.env`, and live entry/exit semantics live in `lib/execution-lab/live-trade-request.ts`, `lib/execution-lab/live-executor-adapter.ts`, and the side-repo one-shot executor docs
- Validation habit after Polymarket changes:
  - `npm run typecheck`
  - `..\..\..\node_modules\.bin\esno tests\polymarket-signal-exit.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts`

### Modify Execution Lab live trade
- Treat Paper Trade and Live Trade as separate modes; Paper Trade must remain the startup default
- Do not send wallet secrets to the browser, localStorage, JSONL logs, or request payloads
- Keep live entry as a buy of the paper-selected YES/NO token; keep live exit as a sell of tracked filled shares for that same token
- Do not buy the opposite outcome as an exit unless a separate hedge feature is explicitly requested
- Preserve idempotency: request ids, ledger behavior, and executor locks must prevent duplicate live submissions
- If exit retry semantics change, keep `docs/execution-lab-live-trading.md`, `docs/polymarket.md`, and the side-repo Strategy Finder live-trade doc aligned
- Validation habit after Execution Lab live-trade changes:
  - `npm run typecheck`
  - `npm run test -- execution-lab`
  - `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

### Modify Walk Forward
- Be careful with UI state versus backtest state handoff
- `walk_forward_oos` snapshots intentionally route through shared result state
- Keep robustness summary and decay panels aligned with actual run data

### Modify Monte Carlo
- Keep the summary contract explicit:
  - `simulations completed` is per scenario when multiple method sets run
  - status text should distinguish per-scenario counts from total counts
- Preserve the compact-memory design in `lib/strategies/monte-carlo/monte-carlo-engine.ts`
  - keep full metric arrays only
  - keep sampled equity paths bounded
  - yield to the event loop during long runs
- Treat Sharpe, drawdown percent, and ruin metrics as app-wide contracts
  - Sharpe should stay aligned with shared performance-metric helpers
  - drawdown percent is percentage points, not fractions
- If Monte Carlo UI ids change, update together:
  - `html-partials/tab-monte-carlo.html`
  - `lib/monte-carlo-dom.ts`
  - `lib/monte-carlo-service.ts`
  - `lib/monte-carlo-renderer.ts`
  - `tests/feature-dom-contracts.spec.ts`

### Modify Chart
- Main containers are `#main-chart` and `#equity-chart`
- Keep tooltip and equity-overlay element references cached; do not re-query structural children in crosshair hot paths
- Treat indicator series lifecycle as explicit:
  - create/add through `chart-manager.ts`
  - clear associated cached lookup state when indicators are cleared
- Keep trade markers and block markers separated:
  - trade markers use `state.markersPlugin`
  - block selection uses its own markers plugin
- Theme changes should flow through `lib/constants.ts` and `chart-manager.updateTheme()`, not inline color objects

### Modify trade analysis
- Heavy analysis lives in `lib/backtest-result-analysis.ts`
- Keep computation in analysis/backtest modules and keep DOM rendering in renderers/services

### Renderer conventions
- Use typed DOM contracts or cached structural element references; do not scatter raw structural lookups
- Prefer event delegation on list/grid containers over per-item listeners
- Keep renderer logic presentation-focused; push heavy computation into services or analysis modules
- Use CSS classes for styling states; do not hardcode theme colors in TypeScript-generated inline styles

### Styling conventions
- Use design tokens from `styles/variables.css`
- Do not hardcode UI colors in TypeScript
- Prefer semantic CSS classes and theme-aware variables over inline styles
- If a styling change introduces or depends on a structural id, update the DOM contract and partial together

## Validation Commands

Run from this directory.

Core:
- `npm run typecheck`
- `npm run test`
- `npm run test:e2e`

`npm run test` is intentionally compact for agent use. It recursively discovers `tests/**/*.spec.ts`, excludes `tests/e2e.spec.ts`, prints one status line per spec plus a short summary, while full logs are written to `artifacts/test-logs/latest` and the structured summary to `artifacts/test-logs/latest/summary.json`.

Useful test runner variants:
- `npm run test:verbose`
- `npm run test:json`
- `npm run test -- --runInBand`
- `npm run test -- --jobs=4`
- `npm run test -- backtesting-engine`

Useful extras:
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\pairCombiner.spec.ts`

## Common Failure Modes
- Renamed UI id in `html-partials/*` but forgot handler or contract update
- Added a strategy file but forgot to run `npm run strategies:sync-manifest`
- Added params in `defaultParams` but forgot matching `paramLabels` or `metadata.walkForwardParams`
- Added a new setting but forgot Rust sanitization or finder parity
- Added a backtest setting id to only one of `BACKTEST_DOM_SETTING_IDS` or `BACKTEST_SETTINGS_DOM_CONTRACTS` (the reader silently drops it; symptom: "DOM checked, settings false")
- Changed `polymarketExitMode` semantics without keeping the endpoint fences explicit
- Added signal-exit price logic in one Polymarket surface but not the shared evaluator, causing manual backtest / Finder / Quick View drift
- Changed price-point loading to raw timestamp ranges and missed same-event exit quotes that occur after the latest trade entry timestamp
- Used raw `document.getElementById(...)` for structural UI instead of a typed contract
- Broke time handling by coercing `BusinessDay` like a number
- Changed signal timing semantics without rechecking entry snapshots / execution model behavior
- Added a new Finder server route but forgot the `isAllowedLocalRequest` gate (audit F1) — remote compute amplification on a `--host`ed dev server
- Made `onSymbolComplete` synchronous again or removed the `ArtifactSubmissionGate` (audit F2) — unbounded artifact closures retain GBs on large runs
- Moved the `releaseLastResults` detach below its first `await` (audit F3) — a concurrent new Run's dir gets clobbered by the old cleanup
- Passed `stream.write` directly to a Batch process function instead of `createDisconnectSafeStream` (audit F4) — a reload mid-run throws into the run loop
- Reverted Batch Stop to unscoped for modern run state (audit F5) — a stale tab can cancel a newer run
- Gated `handleStatusRequest`'s `lastRun` on `hasStoredMineArtifacts()` again (audit F6) — fatal/no-artifact runs vanish from `/status` after a reload
- Reverted the orphan sweep to the bare prefix (audit F7) — deletes a sibling Vite process's active artifacts
- Summed per-strategy `failedSymbols.length` again in the Finder (audit F9) — double-counts shared failing symbols across strategies

## Documentation Standard

If you change behavior substantially, update the docs that actually carry that contract:
- `README.md` for repo-level usage and architecture
- `docs/backtest-endpoint.md` for local HTTP backtest request/response behavior, fixed endpoint sizing, and Preview/Copy Endpoint parity rules
- `docs/polymarket.md` for Polymarket scoring, signal-exit, diagnostics, bridge, and Execution Lab live-trade behavior
- `docs/execution-lab-live-trading.md` for Execution Lab live-trade request/response, executor boundary, and retry safety
- `AGENTS.md` for safe-change guidance
- `workers/README.md` for worker API and cron behavior

Keep repo-level docs broad and operational. Strategy-specific lore belongs in dedicated docs, not in the main README.

Before calling documentation complete, check:
- relative Markdown links resolve
- backticked file paths still exist unless they are placeholders like `<strategy-key>`
- repeated support matrices match the canonical resolver or service code they describe
- README summaries stay shorter than feature-specific docs
