# AGENTS.md

## Mission
This repository is a Vite + TypeScript trading strategy playground with a large UI surface, local market-data caching, optional Rust acceleration, and optional Cloudflare Worker alerts.

Use this file as the short operational handbook for making safe changes quickly.

## Start Here

Before editing anything important:
1. Read `README.md` for the repo-level map.
2. Read `index.ts` to understand initialization order.
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

## The Contracts Most Likely To Break

### 1. UI DOM contracts
- Structural ids are defined in `lib/feature-dom-contracts.ts`
- HTML source of truth is `html-partials/*`
- Consumers live in handlers and managers such as:
  - `lib/handlers/ui-event-handlers.ts`
  - `lib/analysis-panel.ts`
  - `lib/finder-manager.ts`
  - `lib/walk-forward-service.ts`

If you rename or remove a structural id:
1. update the partial
2. update `lib/feature-dom-contracts.ts`
3. update the feature code
4. run `feature-dom-contracts.spec.ts`

### 2. Strategy registration split
- Main UI/runtime registers built-ins through `strategyRegistry.ts`
- Built-in source of truth is `lib/strategies/manifest.ts`
- `lib/strategies/library.ts` is derived from that manifest and is what worker-side evaluation imports

If a built-in strategy is added or renamed and `manifest.ts` is not updated, the strategy will not load consistently in the UI/worker path.

### 3. Settings compatibility
- Preserve localStorage/backward compatibility unless you add migration logic
- `tradeFilterMode` is canonical
- `entryConfirmation` is legacy compatibility still consumed in some paths

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

## First-Tier File Map

### Bootstrap and app wiring
- `index.ts`
- `lib/layout-manager.ts`
- `lib/handlers/*`

### Trading engine
- `lib/strategies/backtest/*`
- `lib/backtest-service.ts`
- `lib/rust-engine-client.ts`
- `lib/rust-settings-sanitizer.ts`

### Data layer
- `lib/data-manager.ts`
- `lib/dataProviders/*`
- `lib/candle-cache.ts`
- `lib/local-sqlite-api.ts`
- `vite.config.ts`

### Research tools
- Finder: `lib/finder-manager.ts`, `lib/finder/*`
- Walk Forward: `lib/walk-forward-service.ts`
- Analysis: `lib/analysis-panel.ts`
- Portfolio Lab: `lib/portfolio-lab-service.ts`
- Scanner: `lib/scanner/*`
- Replay: `lib/replay/*`
- Pair Combiner: `lib/pair-combiner-manager.ts`, `lib/pairCombiner/*`
- Data Mining: `lib/data-mining-manager.ts`, `lib/featureLab/*`

### Alerts / Worker
- `workers/entry-signal-worker.ts`
- `workers/migrations/*`
- `lib/alert-service.ts`
- `workers/README.md`

## Safe Change Checklist

### Any UI change
- Confirm whether the element is structural or optional
- If structural, add it to `lib/feature-dom-contracts.ts`
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
- Recheck snapshot filters and entry timing if signals/fills moved

### Any settings change
- Keep key names stable when possible
- Check UI load/save path in `lib/settings-manager.ts`
- Check any resolver/sanitizer path that mirrors those settings

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
6. Register the strategy in `lib/strategies/manifest.ts`
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
Read `lib/strategies/lib/median_deviation_streak.ts` for a simple implementation or `lib/strategies/lib/vwap_zscore_reversion.ts` for a slightly more complex robust logic.

Useful helper maps:
- `lib/strategies/strategy-helpers.ts`: Core signals (`createSignalLoop`, `createBuySignal`, `createSellSignal`) & base OHLCV array extractors (`getCloses`, `getHighs`, `getVolumes`, `ensureCleanData`).
- `lib/strategies/lib/price-action-frequency-core.ts`: For individual bar geometry (`getPriceActionBarMetrics`) extracting wicks, body, and range metrics seamlessly.
- `lib/strategies/lib/price-action-statistics-core.ts`: Essential for robustness constraints (`buildRollingEntropy`, `buildEfficiencyRatio`, `buildRollingMedian`, `buildRollingZScore`, `buildRollingKurtosis`, `buildRollingMinMax`, `buildStreakCount`).

Important Type and Dependency Gotchas:
- Keep track of indicator outputs: some like `calculateADX` and `calculateATR` return pure generic arrays `(number | null)[]`, while `calculateMACD` and `calculateKeltnerChannels` return objects nested with arrays (`macd.histogram`, `kc.lower`).
- Type coercion matters: pass `cleanData` (which is `OHLCVData[]`) to `buildEfficiencyRatio`, but pass `closes` (which is `number[]`) to standard mapping and extraction routines.
- Array indexing: ensure you loop against generic padding `if (i < lookback || indicator[i] === null) return null;` securely within closures.

Useful examples:
- `lib/strategies/lib/median_deviation_streak.ts`
  - small strategy with explicit normalization and direct `execute(...)` use
- `lib/strategies/lib/vwap_zscore_reversion.ts`
  - WFA/Finder-safe threshold normalization
- search `prepareFinderData` under `lib/strategies/lib/*`
  - only for strategies where dataset-derived precompute materially reduces Finder cost

Strategy-lib checklist before you stop:
- file exists in `lib/strategies/lib/*`
- exported const name matches manifest import
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are already valid after `normalizeParams`
- `normalizeParams` exists if execution sanitizes params
- `metadata.walkForwardParams` only references real params
- `execute(...)` uses normalized params if bounds or trigger semantics depend on them
- manifest import + entry added in `lib/strategies/manifest.ts`
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

### Modify Walk Forward
- Be careful with UI state versus backtest state handoff
- `walk_forward_oos` snapshots intentionally route through shared result state
- Keep robustness summary / candidate validation panels aligned with actual run data

### Modify trade analysis
- `lib/analysis-panel.ts` is part UI controller, part feature orchestration
- Keep heavy computation in backtest analysis modules, not in DOM rendering code

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
- `lib/feature-dom-contracts.ts`
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

## Robust Random WF Discipline

Treat `robust_random_wf` as survivability validation, not as a peak-profit optimizer.

Hard expectations:
- deterministic `robustSeed`
- explicit `PASS` or `FAIL`
- pass rate computed from Stage C survivors
- audit event emitted for both passes and fails:
  - `[Finder][robust_random_wf][cell_audit]`

Recommended validation habit:
- hold strategy set, symbols, timeframes, data span, and cost assumptions fixed
- use a fixed seed set such as `1337, 7331, 2026, 4242, 9001`
- do not reroll seeds until the result passes

## Validation Commands

Run from this directory.

Core:
- `npm run typecheck`
- `npm run test`
- `npm run test:e2e`

Useful extras:
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\pairCombiner.spec.ts`
- `npm run robust:summary -- run-seed-1337.txt run-seed-7331.txt`

## Current Baseline

Observed baseline as of `2026-03-08`:
- `npm run typecheck`: expected to pass
- `npm run test`: expected to pass
- `npm run test:e2e`: may still be environment-sensitive because of browser timing

Treat unrelated pre-existing failures carefully. Do not assume your change caused them without checking.

## Common Failure Modes
- Renamed UI id in `html-partials/*` but forgot handler or contract update
- Added a strategy file but forgot `lib/strategies/manifest.ts`
- Added params in `defaultParams` but forgot matching `paramLabels` or `metadata.walkForwardParams`
- Added a new setting but forgot Rust sanitization or finder parity
- Used raw `document.getElementById(...)` for structural UI instead of a typed contract
- Broke time handling by coercing `BusinessDay` like a number
- Changed signal timing semantics without rechecking entry snapshots / execution model behavior
- Treated basket-level consensus tables as if they were already validated target-symbol filters
- Broke benchmark-only target handling in Portfolio Lab, causing sizing or current-context sections to go empty

## Documentation Standard

If you change behavior substantially, update the docs that actually carry that contract:
- `README.md` for repo-level usage and architecture
- `AGENTS.md` for safe-change guidance
- `workers/README.md` for worker API and cron behavior

Keep repo-level docs broad and operational. Strategy-specific lore belongs in dedicated docs, not in the main README.
