# Strategies Finder

Strategies Finder is a Vite + TypeScript trading research playground for building, testing, comparing, and validating strategy ideas on chart data.

It is not just a chart page. The app combines:
- a browser UI assembled from HTML partials at runtime
- a TypeScript backtest engine with optional Rust acceleration
- a multi-source data pipeline with local caching
- strategy research tools such as Finder, Walk-Forward, Scanner, Replay, Monte Carlo, Pair Combiner, and Analysis
- optional Cloudflare Worker alerting and subscription execution

## What You Can Do Here
- Load market data from local SQLite, IndexedDB, bundled price files, or remote providers
- Run backtests with realistic execution settings, risk controls, and snapshot filters
- Compare strategies, inspect trades, and analyze entry-quality patterns
- Search parameter spaces with Finder, including `robust_random_wf`
- Validate robustness with walk-forward analysis
- Build live or scheduled alert subscriptions through the Worker API

## Quick Start

### Requirements
- Node.js 20+ recommended
- npm
- Windows PowerShell works well in this repo

### Install and Run
```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually `http://localhost:5173`.

### First Useful Smoke Check
1. Pick a symbol and timeframe.
2. Select a strategy from the dropdown.
3. Click `Run Backtest`.
4. Open `Trades`, `Analysis`, `Finder`, and `Walk Forward` tabs to verify the feature panels loaded.

## Architecture Map

### App bootstrap
- Entry: `index.ts`
- Layout injection: `lib/layout-manager.ts`
- Runtime HTML source: `html-partials/*`

### Core trading engine
- Strategy registry and loading: `strategyRegistry.ts`, `lib/strategies/library.ts`
- Backtest orchestration/UI: `lib/backtest-service.ts`
- TS backtest engine: `lib/strategies/backtest/*`
- Rust engine client: `lib/rust-engine-client.ts`

### Data pipeline
- Main manager: `lib/data-manager.ts`
- Providers: `lib/dataProviders/*`
- Browser cache: `lib/candle-cache.ts`
- Local SQLite API client: `lib/local-sqlite-api.ts`
- Vite SQLite endpoints: `vite.config.ts`

### Major research tools
- Finder: `lib/finder-manager.ts`, `lib/finder/*`
- Walk Forward: `lib/walk-forward-service.ts`
- Trade analysis: `lib/analysis-panel.ts`
- Scanner: `lib/scanner/*`
- Replay: `lib/replay/*`
- Pair Combiner: `lib/pair-combiner-manager.ts`, `lib/pairCombiner/*`
- Data Mining / feature export: `lib/data-mining-manager.ts`, `lib/featureLab/*`

### Alerts / Worker
- Worker: `workers/entry-signal-worker.ts`
- API client: `lib/alert-service.ts`
- Worker docs: `workers/README.md`

## UI Structure

This app is heavily id-driven.

The important rule is:
- markup lives in `html-partials/*`
- binding happens in `lib/handlers/*` and feature managers
- required structural ids are now defined in `lib/feature-dom-contracts.ts`
- the smoke test `feature-dom-contracts.spec.ts` fails if a required id disappears from the partials

If you rename a UI id, update the partial, the feature DOM contract, and the consuming handler/manager together.

## Data Flow and Caching

`DataManager` currently prefers:
1. local SQLite cache via Vite `/api/sqlite/*`
2. IndexedDB cache
3. bundled `price-data/*`
4. remote fetch from provider

This ordering matters because Finder, Scanner, and repeated backtests depend on fast warm-cache reads.

## Important Contracts

### Strategy registration is split
- UI and runtime editing use `strategyRegistry`
- Worker entry evaluation uses static `lib/strategies/library.ts`

If you add or rename a built-in strategy, update `lib/strategies/library.ts` or Worker-side evaluation will fail.

### Settings compatibility is real
- `tradeFilterMode` is the canonical filter field
- `entryConfirmation` still exists as compatibility baggage in some paths
- any new setting unsupported by Rust must be stripped in both:
  - `lib/backtest-service.ts`
  - `lib/finder-manager.ts`

### Time handling is broad
The code accepts unix seconds, unix milliseconds, ISO strings, and `BusinessDay` objects.

Reuse existing helpers instead of inventing new conversions:
- `timeKey`
- `timeToNumber`
- existing parse/normalize helpers in backtest and data utilities

## Common Workflows

### Add a built-in strategy
1. Create `lib/strategies/lib/<strategy-name>.ts`
2. Export `name`, `description`, `defaultParams`, `paramLabels`, `execute(...)`
3. Add `metadata` if the strategy participates in walk-forward/finder logic
4. Register it in `lib/strategies/library.ts`
5. Verify it appears in the UI dropdown

### Change backtest behavior
- Engine logic: `lib/strategies/backtest/*`
- UI orchestration and engine selection: `lib/backtest-service.ts`
- Validate long, short, both, combined, and execution model variants

### Change UI controls safely
1. Add or update markup in `html-partials/*`
2. Add the required id to `lib/feature-dom-contracts.ts` if it is structural
3. Wire the feature through its typed DOM contract
4. Run the smoke test and typecheck

### Work on alerts / subscriptions
- Read `workers/README.md`
- Keep `workers/entry-signal-worker.ts` aligned with `lib/alert-service.ts`
- DB changes require a new migration in `workers/migrations/*`

## Validation Commands

Run from this directory.

```bash
npm run typecheck
npm run test
npm run test:e2e
```

Useful extras:
```bash
..\..\..\node_modules\.bin\esno pairCombiner.spec.ts
npm run robust:summary -- run-seed-1337.txt run-seed-7331.txt
```

## Known High-Value Files
- `index.ts`: app bootstrap and feature initialization order
- `lib/settings-manager.ts`: persistence and backtest settings loading
- `lib/feature-dom-contracts.ts`: required UI element contracts
- `lib/backtest-service.ts`: orchestration layer between UI and engines
- `lib/finder-manager.ts`: large optimization UI + execution surface
- `lib/walk-forward-service.ts`: robustness validation UI + execution

## Specialized Project Docs

These are intentionally narrower than the repo itself:
- `workers/README.md`: Worker endpoints, cron behavior, D1 setup, Telegram
- `EMPIRE_CONSTITUTION.md`: locked portfolio / empire-specific rules
- `DEPLOY_TO_VERCEL.md`: deployment notes

The old README content about the Twin Towers / Empire setup belongs in those specialized docs, not as the main project entrypoint.
