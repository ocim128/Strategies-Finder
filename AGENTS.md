# AGENTS.md

## Mission
This repository is a Vite + TypeScript trading strategy playground with a heavy UI layer, local caching, and optional Cloudflare Worker alerts.
Use this guide to make safe, high-signal changes with GPT-5.3 Codex.

## What This Codebase Actually Is
- Frontend app bootstrap: `index.ts`
- Layout is assembled from HTML partials at runtime: `lib/layout-manager.ts`, `html-partials/*`
- Strategy runtime and registry: `strategyRegistry.ts`, `lib/strategies/*`
- Backtest engine (TypeScript) with optional Rust backend client:
  - TS engine: `lib/strategies/backtest/*`, `lib/backtest-service.ts`
  - Rust client: `lib/rust-engine-client.ts`, preference UI in `lib/engine-preferences.ts`
- Data pipeline (multi-source, cached):
  - Manager: `lib/data-manager.ts`
  - Providers: `lib/dataProviders/*`
  - Browser cache (IndexedDB): `lib/candle-cache.ts`
  - Local SQLite API client: `lib/local-sqlite-api.ts`
  - Vite dev server SQLite endpoints: `vite.config.ts`
- Advanced features:
  - Finder: `lib/finder-manager.ts`, `lib/finder/*`
  - Scanner: `lib/scanner/*`
  - Replay: `lib/replay/*`
  - Pair Combiner: `lib/pair-combiner-manager.ts`, `lib/pairCombiner/*`
  - Data Mining / feature export: `lib/data-mining-manager.ts`, `lib/featureLab/*`
- Cloudflare Worker alerting and subscriptions:
  - Worker: `workers/entry-signal-worker.ts`
  - SQL migrations: `workers/migrations/*.sql`
  - Client API wrapper: `lib/alert-service.ts`

## Ground Rules For Changes
- Prefer surgical changes; this repo has broad cross-file coupling via DOM ids and shared settings fields.
- Preserve existing localStorage schema keys unless migration logic is added.
- Keep strategy signal timing semantics consistent (`executionModel`, `barIndex`, `time` mapping).
- Do not bypass normalization helpers for time and settings.
- If a setting impacts Rust fallback behavior, verify both:
  - `BacktestService` Rust sanitization path in `lib/backtest-service.ts`
  - Finder Rust sanitization path in `lib/finder-manager.ts`

## High-Risk Couplings (Do Not Miss)
- Strategy registration split:
  - UI/backtest uses `strategyRegistry` (dynamic + HMR + custom strategies).
  - Worker entry evaluation uses static `strategies` from `lib/strategies/library.ts`.
  - If you add/rename a strategy, update `lib/strategies/library.ts` or worker-side lookup will fail.
- Runtime layout and handlers:
  - DOM ids/classes are defined in `html-partials/*`.
  - Event wiring is spread across `lib/handlers/*`, managers, and e2e checks.
  - Renaming ids without updating handlers breaks runtime silently.
- Time normalization:
  - Code accepts unix seconds, unix ms, ISO strings, and BusinessDay objects.
  - Reuse existing `timeKey`, `timeToNumber`, and parse helpers.
- Settings compatibility:
  - `tradeFilterMode` is canonical.
  - `entryConfirmation` is legacy compatibility and still consumed in some paths.

## Strategy Workflows

### Add a new built-in strategy
1. Create file in `lib/strategies/lib/<strategy-name>.ts`.
2. Use helpers from `lib/strategies/strategy-helpers.ts`:
   - `ensureCleanData`
   - `createSignalLoop`
   - `createBuySignal` / `createSellSignal`
3. Export strategy with:
   - `name`, `description`
   - `defaultParams`, `paramLabels`
   - `execute(data, params)`
   - `metadata` (`role`, `direction`, `walkForwardParams`) when applicable
4. Register in `lib/strategies/library.ts`.
5. If intended for worker alert evaluation, registration in `library.ts` is mandatory.
6. Run tests and verify strategy appears in dropdown at runtime.

### Add/modify strategy parameters safely
- Keep param key names stable when possible (saved configs and finder output depend on keys).
- If renaming keys, add backward-compat mapping where params are loaded.
- Update any walk-forward parameter lists (`metadata.walkForwardParams`) to avoid unexpected optimization scope.

## Backtest And Engine Workflows

### Change backtest behavior
- Primary logic lives in `lib/strategies/backtest/*`.
- UI orchestrator and engine selection logic live in `lib/backtest-service.ts`.
- Validate:
  - long/short/both/combined direction paths
  - `executionModel` behavior (`signal_close`, `next_open`, `next_close`)
  - snapshot/trade filters if touched

### Rust engine compatibility
- Rust backend is optional.
- Any new setting not supported by Rust must be stripped from Rust requests in:
  - `lib/backtest-service.ts`
  - `lib/finder-manager.ts`
- Ensure TypeScript fallback remains correct.

## Data Pipeline Workflows

### Data source order and caching model
`DataManager` currently prefers:
1. Local SQLite cache (`/api/sqlite/*` via Vite plugin)
2. IndexedDB cache
3. Seed files under `price-data/`
4. Remote provider fetch (Binance/Bybit)

- If changing fetch behavior, preserve merge/de-dup semantics and time ordering.
- Scanner uses `fetchDataForScan` and depends on fast local cache hits.

### Intervals and resampling
- Binance provider supports custom minute intervals by resampling base intervals.
- Reuse `resolveFetchInterval` and `resampleOHLCV`; do not duplicate interval math.

## Worker + Alerts Workflows
- Worker endpoint surface is documented in `workers/README.md`.
- DB schema changes require new migration under `workers/migrations/`.
- Keep API contract aligned with `lib/alert-service.ts` and alert tab UI (`html-partials/tab-alerts.html`, handlers).
- Subscriptions and signal dedupe rely on stable stream/channel keys.

## UI Workflows
- Layout source of truth is `html-partials/*` + `lib/layout-manager.ts`.
- Most interactivity wiring lives in:
  - `lib/handlers/ui-event-handlers.ts`
  - `lib/handlers/state-subscriptions.ts`
  - feature managers (`finder`, `scanner`, `pair-combiner`, etc.)
- If adding controls:
  - add id/class in partial
  - wire in handler/manager
  - include settings persistence if user-configurable

## Finder/Scanner Notes
- Finder is memory-sensitive and includes adaptive batching for large datasets.
- Scanner uses cache fingerprinting and open-position detection via backtest replay logic.
- Keep these paths performant; avoid introducing expensive per-bar allocations in hot loops.

## Validation Commands
Run from this directory.

- Type check: `npm run typecheck`
- Strategy test suite: `npm run test`
- E2E smoke: `npm run test:e2e`

Additional useful test file:
- Pair combiner tests: `..\..\..\node_modules\.bin\esno pairCombiner.spec.ts`

## Current Baseline Test Notes (observed on 2026-02-12)
- `npm run typecheck`: passes
- `npm run test`: fails with 2 Trade Analyzer assertions in `strategies.spec.ts`
  - "should only suggest below direction for bars-from-high/low features"
  - "should keep tiny non-zero suggested thresholds non-zero"
- `npm run test:e2e`: fails with Puppeteer navigation timeout

Treat these as existing baseline issues unless your change directly targets them.

## Fast File Map For Common Tasks
- Add strategy: `lib/strategies/lib/*`, `lib/strategies/library.ts`
- Strategy registry/HMR/custom runtime: `strategyRegistry.ts`
- Backtest core: `lib/strategies/backtest/*`
- Backtest orchestration/UI: `lib/backtest-service.ts`
- Data fetching/streaming/cache: `lib/data-manager.ts`, `lib/dataProviders/*`, `lib/candle-cache.ts`, `lib/local-sqlite-api.ts`
- Finder: `lib/finder-manager.ts`, `lib/finder/*`
- Scanner: `lib/scanner/*`
- Replay: `lib/replay/*`
- Alerts worker: `workers/entry-signal-worker.ts`, `workers/migrations/*`
- Alert client/UI: `lib/alert-service.ts`, `html-partials/tab-alerts.html`
- Settings persistence: `lib/settings-manager.ts`

## Codex Output Standard For This Repo
- Explain what changed and why in terms of feature flow.
- Explicitly list affected subsystems when a change crosses boundaries.
- Include exact validation commands run and whether failures are pre-existing or introduced.
- When touching strategy or settings contracts, note compatibility impact on saved configs and worker evaluation.
