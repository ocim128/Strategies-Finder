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
- app startup sequencing lives in `lib/app-bootstrap.ts` and `lib/bootstrap-feature-registry.ts`
- shared state still lives in `lib/state.ts`, but app writes should go through `lib/state-actions.ts`
- read-only state slices live in `lib/state-domains.ts`
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
- If you change the Polymarket bridge `external_signal` payload or `polymarketEntryOffset` contract, keep `scripts/export-latest-entry-signal.ts` and `scripts/export-latest-ensemble-entry-signal.ts` aligned
- If you change `polymarketExitMode`, keep `docs/polymarket.md`, endpoint fences, Strategy Ensemble fences, and Finder/Hunt apply-result behavior aligned

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
Read `lib/strategies/lib/robust_median_channel_breakout.ts` for a simple implementation or `lib/strategies/lib/rolling_vwap_center.ts` for a Finder-prepared implementation.

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
- `lib/strategies/lib/robust_median_channel_breakout.ts`
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
- add or update `strategies.spec.ts` if normalization, Finder, or WFA behavior is non-trivial
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
- Batch (`lib/batch-backtest/batch-backtest-runner.ts`): `BatchBacktestSymbolResult` carries `data`, `signals`, and `result.trades` per row. These are required for Mine Timing on synthetic pair rows and are pruned after Mine runs; non-synthetic rows omit `signals`. Don't add post-Mine reads of these arrays — use `tradeSummary` or scalars off `result` instead.
- Realistic browser heap limits: 1000+ synthetic pairs exceed a default 8 GB V8 heap. Recommend running with `--max-old-space-size=12288+` and/or splitting into chunks of 200–400 pairs per run.
- Cache caps to respect (lower only with cause; raise only after checking steady-state footprint):
  - `UNIVERSE_DATASET_CACHE_MAX_ENTRIES` in `lib/finder-manager.ts` (default 128)
  - `MAX_CACHE_ENTRIES` in `lib/data/data-cache.ts` (default 64)
  - `legCache` / `pairCache` in `lib/batch-backtest/batch-backtest-loader.ts` (default 24 / 16)
  - These are cleared at Batch run end and after Mine runs; Finder Universe relies on cross-strategy reuse, so do not clear mid-run.
- IBKR 4H synthetic pairs require the 30m seed CSVs at `price-data/ibkr/csv/30m/`. Do NOT try to "optimize" synthetic pairs by loading pre-aggregated 4H legs — the ratio must be computed at the seed interval (30m) and *then* aggregated, not the other way around. Computing `base.high/quote.high` from 4H bars conflates extremes from different moments within the bucket and inflates the bar range (see comment at `scripts/lib/synthetic-pair.ts` `buildSyntheticPairDataset`). `npm run ibkr:aggregate` exists to write `4h/*.csv` for **single-symbol IBKR 4H charts** (where no ratio is involved); it does not help and must not be used for synthetic-pair legs.

### Server-Side Batch Backtest
- The Batch Backtest tab has two execution paths, gated by the `batchExecutionMode` setting (`Settings → Backend Engine → Batch Execution Mode`):
  - `"browser"`: original in-tab path via `runBatchBacktest` (`lib/batch-backtest/batch-backtest-runner.ts`)
  - `"server"`: default; runs in the Vite dev server via `lib/batch-backtest/batch-backtest-vite-plugin.ts`, mirroring the IBKR sync plugin's owner-lock + NDJSON stream + status-snapshot reattach pattern. See `docs/batch-backtest-server-side.md`.
- The browser-side `BatchBacktestService.runBatch()` dispatches on the mode. The server branch POSTs to `/api/batch-backtest/run`, consumes NDJSON via the shared `consumeNdjsonStream` (`lib/ndjson-stream.ts`), and reconstructs scalar-only rows.
- **The `row` sent over the wire must NEVER contain array fields** (`data`, `signals`, `result.trades`). Use `toScalarRow(...)` (`lib/batch-backtest/batch-backtest-stream-types.ts`) before emitting a `symbol` event. The server writes Mine Timing artifacts to a temporary disk directory and loads linked pairs back per target during Mine. This contract keeps the browser tab and Node heap bounded regardless of pair count.
- **Mine button gating flips in server mode**: gate on the `serverHasArtifacts` flag (set by the `done` event / `GET /status`), NOT on `row.data !== undefined`. The browser never holds `row.data` in server mode.
- **Engine selection**: `shouldAttemptRust` in `lib/backtest-executor.ts` consults `context.useRustEnginePreference` when running in Node (no DOM). The server-side runner threads `useRustEnginePreference` from the request body, which the browser-side service populates from `shouldUseRustEngine()`. Without this, server-side mode silently uses the TypeScript engine even when the user has Rust enabled (the "Rust-engine trap").
- **`fetchLocalApi` Node URL resolution**: `lib/local-api-transport.ts:resolveLocalApiUrl` resolves relative `/api/...` URLs against `http://127.0.0.1:5173` (override via `VITE_DEV_SERVER_ORIGIN`) when running in Node. Browser `fetch` does this automatically; Node's `fetch` does not. The server-side loader goes through `loadSqliteCandles` → `fetchLocalApi("/api/sqlite/...")`, so without this fix every local-data load would throw `TypeError: Invalid URL` server-side.
- **Node heap requirement**: recommend `NODE_OPTIONS=--max-old-space-size=16384` (or higher) when running server-side batches. Document this whenever you touch the plugin's memory budget.
- **Artifact TTL**: the plugin holds disk-backed Mine artifacts until Mine/Stability Mine completes OR a new Run starts OR a 10-minute TTL fires (`DEFAULT_ARTIFACT_RETENTION_MS` in `batch-backtest-vite-plugin.ts`). The TTL is the defense-in-depth the browser path got for free via tab reload. Do NOT remove it without a replacement.
- **Loader parity**: `lib/batch-backtest/server-batch-data-loader.ts` must mirror `lib/batch-backtest/batch-backtest-loader.ts` 1:1 (same synthetic-pair pipeline, same `SyntheticLegCache` cap, same stale-fragment thresholds, same DATA_CHART_TOTAL_LIMIT lookback). The browser loader goes through the `dataManager` singleton (browser-bound); the server loader constructs `DataFetcher` directly with empty UI callbacks (recipe at `lib/data/data-fetcher.ts:178-192`). Drift between the two causes silent wrong-data symptoms. `tests/batch-backtest-server-loader-parity.spec.ts` locks the structural invariants.
- **Server-side import hygiene (vite.config.ts bundle trap)**: anything imported by `lib/batch-backtest/batch-backtest-vite-plugin.ts` (transitively) ends up bundled by esbuild when Vite bundles `vite.config.ts` for the Node dev server. Do NOT import from `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`, `lib/ui-manager.ts`, or any module that transitively reaches `lib/constants.ts` or `lib/chart-manager.ts` — both import `lightweight-charts`, which is ESM-only and fails the cjs config bundle. The server-side loader imports `parseSyntheticPairToken` from the leaf `lib/synthetic-pair-token.ts` (not finder-manager) for exactly this reason. If a new server-side module needs a helper that currently lives in a browser-bound module, extract the helper to a leaf first. Symptom of breakage: dev server fails to start with `Failed to resolve "lightweight-charts". This package is ESM only but it was tried to load by require`.
- New settings ids must be registered in BOTH DOM-contract systems (already enforced by `tests/backtest-settings-id-parity.spec.ts`); `batchExecutionMode` is in both `BACKTEST_DOM_SETTING_IDS` (`lib/backtest-settings-resolver.ts`) and `BACKTEST_SETTINGS_DOM_CONTRACTS` (`lib/backtest-settings-dom-contract.ts`), with parser `"batchExecutionMode"` (case-sensitive; do NOT use the generic `"string"` parser which uppercases).
- Validation habit after Server-Side Batch changes:
  - `npm run typecheck`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-loader-parity.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\backtest-settings-id-parity.spec.ts`
  - Manual smoke (server-side): start `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run a 50-pair batch in browser mode (regression) then server-side mode (parity), then 1000-pair batch in server-side mode (the goal). Confirm: progress streams, Stop works, Copy produces identical summary (minus B&H/OPEN_SCORE sections — documented degradation), Mine Timing produces verdicts, reload mid-run reattaches.

### Mine / Stability Miner Acceleration
- Mine Timing and Stability Mine run an accelerated path in layers, tried in order: Rust miner backend → parallel Node `worker_threads` → sequential TypeScript. Each layer falls back deterministically; verdicts are byte-identical to the pre-acceleration path on a fixed seed (locked by `tests/batch-synthetic-state-miner.spec.ts`, `tests/batch-miner-artifact.spec.ts`, `tests/batch-stability-parallel.spec.ts`).
- **Top-K analog selection + asset index** (`lib/batch-backtest/batch-synthetic-state-miner.ts`, `lib/batch-backtest/batch-miner-index.ts`): always on. The top-K max-heap uses the original sample index as the explicit final tie-breaker so the selected analog set matches V8's stable full-sort slice exactly. Do NOT change `compareAnalogByDistanceThenOrder` without updating the parity spec. On a 448-pair 4H workload this cut `linkedPairFilterMs` 9.8→1.7 ms and `analogSelectionMs` 629→155 ms — but `candidateSamplesMs` (~60s, 85% of Stability) is untouched; that needs Rust/Rayon (Phase 5, no backend exists).
- **Compact miner artifacts** (`lib/batch-backtest/batch-miner-artifact.ts`): versioned struct-of-arrays shape (Float64Array OHLCV + `timeKey` string arrays). Time is stored as the exact `timeKey(bar.time)` string — NOT normalized to seconds — because the miner's `timeIndex` is keyed by `timeKey(...)`, which returns the RAW time shape (ms stays ms). Normalizing time here breaks lookup parity with freshly-loaded raw target candles. `localTimeKey` in `batch-miner-artifact.ts` MUST stay byte-identical to `lib/time-key.ts:toTimeKey`. Bump `COMPACT_MINER_ARTIFACT_SCHEMA_VERSION` when the on-disk shape changes; the schema guard rejects stale artifacts and the Rust client reports `schema_mismatch`.
- **Gates** (`batch-backtest-vite-plugin.ts`): `BATCH_MINER_COMPACT_ARTIFACTS_ENABLED=false` (compact store-time tax is a net loss on the TS-only path — validated against a real 448-pair 4H benchmark where it made Run +89% slower for zero benefit; only pays off when a Rust backend reads the compact shape). `BATCH_MINER_PARALLEL_STABILITY_ENABLED=true` (default on — the worker is esbuild-bundled to `.js` on first use so it loads under `vite dev`). `BATCH_MINER_RUST_ROUTING_ENABLED=true` but has a compact-gate precondition, so effectively off until compact is on. Tests toggle gates via `__testInternals.setMinerGatesForTests(...)` + `resetMinerGatesForTests()`.
- **Rust miner client** (`lib/batch-backtest/batch-rust-miner-client.ts`): SEPARATE from `lib/rust-engine-client.ts` (backtest engine). Default URL `http://127.0.0.1:3031`. File-manifest handoff ONLY (Rust reads compact pair + target artifact files from the server temp dir); never send multi-GB JSON payloads. Returns `{ ok: false, reason }` on any failure — the plugin routes to the parallel/sequential TS path on `ok: false`. The backend is OPTIONAL and lives outside this repo; see `docs/batch-backtest-server-side.md` "Rust miner backend contract".
- **Parallel Stability workers** (`lib/batch-backtest/batch-stability-worker.ts`, `batch-stability-parallel.ts`): partition reruns (not pairs); each worker reads artifact FILES (compact OR raw) from disk independently. Engages only at `reruns >= 4` (`PARALLEL_STABILITY_MIN_RERUNS`). Merge MUST concatenate per-row arrays in ascending rerun-order for determinism — `mergeStabilityAccumulators` is the single seam. Worker failures fall back to sequential TS once (plan §"Failure Handling"). The worker is bundled to `.js` via esbuild on first use (`resolveWorkerPath()`) because Node `worker_threads` cannot load `.ts` under `vite dev`; the bundle is mtime-keyed so source changes re-bundle. The end-to-end spawn+parity is locked by `tests/batch-stability-parallel.spec.ts`.
- **Engine reporting**: every Stability result carries `engine` (`typescript` | `typescript_parallel` | `rust` | `rust_fallback`) + `rustFallbackReason`. The Copy Benchmark surfaces these in `phases.stability.engine` and the new `minerProfile` fields (`artifactConversionMs`, `rustRequestMs`, `rustProcessingMs`, `rustResponseMs`, `parallelWorkerCount`). Do not remove the engine label — Phase 6 observability depends on it.
- Tests toggle gates via `__testInternals.setMinerGatesForTests(...)` + `resetMinerGatesForTests()` and inject a stub Rust client via `setRustMinerClientForTests(...)`. The `before` hook installs an always-unavailable stub + default gates so the suite never pays a real health-probe timeout; tests needing a healthy (mock) backend or compact storage opt in and reset in `finally`.
- Validation habit after miner-acceleration changes:
  - `npm run typecheck`
  - `..\..\..\node_modules\.bin\esno tests\batch-synthetic-state-miner.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-miner-artifact.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-stability-mine.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-stability-parallel.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-rust-miner-client.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`

### Modify Exit Strategy Override
- Keep it gated on `disableSignalExits`; when normal signal exits are enabled, the override is inert
- Preserve `Signal.exitOnly` through signal preparation and every TS engine signal loop; exit-only signals close opposite positions but never open new positions
- New settings ids must be registered in BOTH DOM-contract systems or the reader silently drops them:
  - `BACKTEST_DOM_SETTING_IDS` in `lib/backtest-settings-resolver.ts` (used by `backtestService.getBacktestSettings()`)
  - `BACKTEST_SETTINGS_DOM_CONTRACTS` in `lib/backtest-settings-dom-contract.ts` (used by `settingsManager` read/write)
  Adding to only one causes the exact symptom "DOM checked, settings false" — verify both lists after adding a backtest setting id
- `applyDerivedBacktestSettingGuards` in `lib/backtest-settings-resolver.ts` must preserve `disableSignalExits` when `exitStrategyOverrideEnabled` is on, even before a strategy key is picked. Without this guard exemption, the resolver strips `disableSignalExits` before the user can finish configuring the override (chicken-and-egg)
- Finder support covers current-chart and Symbol Universe; do not silently expand to Hunt, Walk Forward, Scanner, Portfolio Lab, genetic mode, or Polymarket Finder
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
- endpoint Preview / Copy / HTTP execution and Strategy Ensemble intentionally stay on `resolve_hold`; do not silently broaden those callers
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
- If exit retry semantics change, keep `docs/live-trade-plan.md`, `docs/polymarket.md`, and the side-repo Strategy Finder live-trade doc aligned
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

### Modify Portfolio Lab
- Treat `Portfolio Lab` as two features in one:
  - execution decision support for the target symbol
  - descriptive diagnostics for the whole basket
- High-value sections are:
  - `Current Context`
  - `Execution Filters`
  - `Pair Ranking`
  - `Sizing Scenarios`
- Lower-value sections are diagnostics only:
  - aggregate agreement buckets
  - correlation matrix
  - full per-pair table

When touching Portfolio Lab, check these contracts:
- `html-partials/tab-portfolio.html`
- `lib/portfolio-lab-dom.ts`
- `lib/portfolio-lab-service.ts`
- `lib/backtest-service.ts` if custom-signal or custom-data backtests change

Behavior expectations:
- use the current selected strategy and current UI backtest/capital settings
- keep context calculations causal; only same-bar or backward-looking lag windows are valid
- keep `Current Context` one-shot only unless a separate live mode is intentionally introduced
- preserve the distinction between:
  - target-symbol filter sweeps
  - basket-level descriptive bucket summaries
- if the benchmark/target is outside the ranked pair rows, target-specific sections must still render

Validation habit after Portfolio Lab changes:
- `npm run typecheck`
- `npm run test`
- `..\..\..\node_modules\.bin\esno feature-dom-contracts.spec.ts`
- if a UI regression is suspected, manually verify:
  - `Current Context`
  - `Execution Filters`
  - `Sizing Scenarios`
  - collapsed diagnostics state

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

## Current Baseline

Observed baseline as of `2026-03-08`:
- `npm run typecheck`: expected to pass
- `npm run test`: expected to pass
- `npm run test:e2e`: may still be environment-sensitive because of browser timing

Treat unrelated pre-existing failures carefully. Do not assume your change caused them without checking.

## Common Failure Modes
- Renamed UI id in `html-partials/*` but forgot handler or contract update
- Added a strategy file but forgot to run `npm run strategies:sync-manifest`
- Added params in `defaultParams` but forgot matching `paramLabels` or `metadata.walkForwardParams`
- Added a new setting but forgot Rust sanitization or finder parity
- Added a backtest setting id to only one of `BACKTEST_DOM_SETTING_IDS` or `BACKTEST_SETTINGS_DOM_CONTRACTS` (the reader silently drops it; symptom: "DOM checked, settings false")
- Changed `polymarketExitMode` semantics without keeping endpoint / ensemble fences explicit
- Added signal-exit price logic in one Polymarket surface but not the shared evaluator, causing manual backtest / Finder / Quick View drift
- Changed price-point loading to raw timestamp ranges and missed same-event exit quotes that occur after the latest trade entry timestamp
- Used raw `document.getElementById(...)` for structural UI instead of a typed contract
- Broke time handling by coercing `BusinessDay` like a number
- Changed signal timing semantics without rechecking entry snapshots / execution model behavior
- Treated basket-level consensus tables as if they were already validated target-symbol filters
- Broke benchmark-only target handling in Portfolio Lab, causing sizing or current-context sections to go empty

## Documentation Standard

If you change behavior substantially, update the docs that actually carry that contract:
- `README.md` for repo-level usage and architecture
- `docs/backtest-endpoint.md` for local HTTP backtest request/response behavior, fixed endpoint sizing, and Preview/Copy Endpoint parity rules
- `docs/polymarket.md` for Polymarket scoring, signal-exit, diagnostics, bridge, and Execution Lab live-trade behavior
- `docs/live-trade-plan.md` for Execution Lab live-trade request/response, executor boundary, and retry safety
- `AGENTS.md` for safe-change guidance
- `workers/README.md` for worker API and cron behavior

Keep repo-level docs broad and operational. Strategy-specific lore belongs in dedicated docs, not in the main README.

Before calling documentation complete, check:
- relative Markdown links resolve
- backticked file paths still exist unless they are placeholders like `<strategy-key>`
- repeated support matrices match the canonical resolver or service code they describe
- README summaries stay shorter than feature-specific docs
