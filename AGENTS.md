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

"Add validation" → "Write tests for invalid inputs, then make them pass"
"Fix the bug" → "Write a test that reproduces it, then make it pass"
"Refactor X" → "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:


1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
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
- Browser UI listing uses `manifest-meta.ts`; browser strategy execution loads code through `manifest-loaders.ts`
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
Read `lib/strategies/lib/median_deviation_streak.ts` for a simple implementation or `lib/strategies/lib/vwap_zscore_reversion.ts` for a slightly more complex robust logic.

Useful helper maps:
- `lib/strategies/strategy-helpers.ts`: Core signals (`createSignalLoop`, `createBuySignal`, `createSellSignal`) & base OHLCV array extractors (`getCloses`, `getHighs`, `getVolumes`, `ensureCleanData`).
- `lib/strategies/lib/price-action-frequency-core.ts`: For individual bar geometry (`getPriceActionBarMetrics`) extracting wicks, body, and range metrics seamlessly.
- `lib/strategies/lib/price-action-statistics-core.ts`: Essential for robustness constraints (`buildRollingEntropy`, `buildEfficiencyRatio`, `buildRollingMedian`, `buildRollingZScore`, `buildRollingKurtosis`, `buildRollingMinMax`, `buildStreakCount`).
- If you edit `archive/prompt.txt`, only list helpers that already exist as exported strategy-layer utilities. Prefer low-complexity primitives such as price extractors (`getOpens`, `getMidpoints`, `getTypicalPrices`), bar geometry series (`buildRangeSeries`, `buildBodySeries`, `buildCloseLocationSeries`), crossover, pivot, and timeframe-alignment helpers over prompt-only or speculative surfaces.

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

### Modify Polymarket scoring
- Keep the five Polymarket contracts separate:
  - direct charting
  - outcome scoring
  - diagnostics
  - bridge export
  - Execution Lab live trade
- `polymarketExitMode` defaults to `resolve_hold`
- `signal_exit_same_event` is only effective on `1m` + `next_open` and supported `1s` BTCUSDT/XRPUSDT CLOB `next_open` runs; use `resolveEffectivePolymarketExitMode(...)` instead of open-coded checks
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
