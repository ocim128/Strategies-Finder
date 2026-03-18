# Strategies Finder

Strategies Finder is a Vite + TypeScript trading research playground for building, testing, comparing, and validating strategy ideas on chart data.

It is not just a chart page. The app combines:
- a browser UI assembled from HTML partials at runtime
- a TypeScript backtest engine with optional Rust acceleration
- a multi-source data pipeline with local caching
- strategy research tools such as Finder, Walk-Forward, Scanner, Replay, Pair Combiner, and Analysis
- optional Cloudflare Worker alerting and subscription execution

## What You Can Do Here
- Load market data from local SQLite, IndexedDB, bundled price files, or remote providers
- Run backtests with realistic execution settings, risk controls, and snapshot filters
- Compare strategies, inspect trades, and analyze entry-quality patterns
- Search parameter spaces with Finder, including random, genetic, and `robust_random_wf`
- Validate robustness with walk-forward analysis and test latest OOS WFA results against a no-edge permutation null
- Audit parameter usefulness, redundancy, and range quality with `Parameter Audit`
- Run one strategy across multiple pairs with Portfolio Lab to compare dispersion, execution filters, open-trade forecast states, pair ranking, sizing scenarios, and correlations
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
- Strategy registry and loading: `strategyRegistry.ts`, `lib/strategies/manifest.ts`, `lib/strategies/library.ts`
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
- Parameter Audit: `lib/parameter-audit-service.ts`, `lib/parameter-audit-logic.ts`
- Walk Forward: `lib/walk-forward-service.ts`
- Trade analysis: `lib/analysis-panel.ts`
- Portfolio Lab: `lib/portfolio-lab-service.ts`
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
- the smoke test `tests/feature-dom-contracts.spec.ts` fails if a required id disappears from the partials

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
- UI and runtime loading use `strategyRegistry`
- Built-in source of truth is `lib/strategies/manifest.ts`
- `lib/strategies/library.ts` is derived from that manifest and is what worker-side evaluation imports

If you add or rename a built-in strategy, update `lib/strategies/manifest.ts` or the strategy will not load consistently.

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

### Use Portfolio Lab effectively
Portfolio Lab is most useful when you separate decision outputs from diagnostics.

High-signal outputs:
- `Current Context`: current target-pair agreement, opposition, matching pairs, and historical odds for the current open trade or latest signal
- `Open Trade Forecast`: ETH-anchored target-state analog matching for the current open trade or latest signal, with projected win/loss odds, remaining expectancy, confidence, and exposure guidance
- `Execution Filters`: breadth and opposition sweeps for the target pair, with separate winners for best expectancy, best net, and best drawdown
- `Pair Ranking`: quick view of likely core pairs, diversifiers, and strong breadth responders
- `Sizing Scenarios`: estimate whether context-weighted sizing is better than hard filtering

Lower-signal diagnostics:
- aggregate agreement-bucket tables across the whole basket
- raw correlation matrices
- full per-pair diagnostics table

Recommended workflow:
1. Run Portfolio Lab in `Common Overlap` mode when comparing pairs fairly matters.
2. Start from `Current Context`, then `Open Trade Forecast`, then `Execution Filters` before reading the diagnostic sections.
3. Do not treat the highest win-rate threshold as automatically best; compare expectancy, net, and drawdown separately.
4. If hard breadth filters reduce net too much, prefer the `Sizing Scenarios` section over removing trades completely.
5. Use diagnostics only to confirm diversification or redundancy after you already have a trade decision.

### Use Strategy Ensemble Lab carefully
Ensemble Lab now treats context as entry-side confirmation, not raw signal spam.

Important behavior:
- context votes are counted from entry-capable signals only; one-sided config exits do not count as opposite-side agreement
- agreement and opposition are aggregated by strategy family (`strategyKey`), so near-duplicate saved configs do not stack votes as independent evidence
- target filtering preserves target exits and only gates target entries
- live recommendations prefer rules that still beat baseline on a 70/30 train-validation split
- if no rule survives validation, the UI labels the fallback as `In-Sample Candidate`

### Add a built-in strategy
1. Pick a stable key and use it consistently for the file name, exported const, and manifest entry.
2. Create `lib/strategies/lib/<strategy-key>.ts`.
3. Export a `Strategy` with `name`, `description`, `defaultParams`, `paramLabels`, and `execute(...)`.
4. Add `normalizeParams(...)` if the strategy rounds, clamps, or coerces parameter values.
5. Add `metadata` when the strategy should participate in walk-forward/finder optimization.
6. Register it in `lib/strategies/manifest.ts`.
7. Run `npm run typecheck`.
8. Verify it appears in the UI dropdown.

The important contract is that Finder and Walk Forward must see the same parameter semantics that `execute(...)` uses. If the strategy silently converts `-2` to `2`, rounds `11.383` to `11.384`, or clamps a lookback upward, expose that through `normalizeParams(...)` or the UI will show impossible base params and misleading WFA summaries.

Practical build order:
1. Start from a nearby existing strategy:
   - `lib/strategies/lib/median_deviation_streak.ts` for simple rolling-stat thresholds
   - `lib/strategies/lib/vwap_zscore_reversion.ts` for normalized threshold and WFA-safe params
   - a strategy with `prepareFinderData(...)` only if Finder hot-loop cost is actually high
2. Write the raw signal idea first with `ensureCleanData(...)` and `createSignalLoop(...)`.
3. Add a named param normalizer before wiring `metadata.walkForwardParams`.
4. Register in `lib/strategies/manifest.ts`.
5. Add Finder precompute only if profiling justifies it.

Minimal template:
Read `lib/strategies/lib/median_deviation_streak.ts` for a simple template or `lib/strategies/lib/vwap_zscore_reversion.ts` for WFA-safe pattern.
```ts
import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";

function normalizeMyStrategyParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    threshold: Math.max(0, Number(params.threshold ?? 1)),
  };
}

export const my_strategy_key: Strategy = {
  name: "My Strategy Name",
  description: "One-line thesis.",
  defaultParams: {
    lookback: 20,
    threshold: 1,
  },
  paramLabels: {
    lookback: "Lookback",
    threshold: "Threshold",
  },
  normalizeParams: normalizeMyStrategyParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const normalizedParams = normalizeMyStrategyParams(params);
    if (cleanData.length < normalizedParams.lookback) return [];

    return createSignalLoop(cleanData, [], (i) => {
      if (i < normalizedParams.lookback) return null;
      if (/* bullish condition */) {
        return createBuySignal(cleanData, i, "Bullish reason");
      }
      if (/* bearish condition */) {
        return createSellSignal(cleanData, i, "Bearish reason");
      }
      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "threshold"],
  },
};
```

Helpful helper files:
- `lib/strategies/strategy-helpers.ts`: signal creation, clean-data guards, base OHLCV series extractors
- `lib/strategies/lib/price-action-frequency-core.ts`: candle geometry and trailing range/high-low helpers
- `lib/strategies/lib/price-action-statistics-core.ts`: percentile, z-score, skewness, streak, ROC, ER, and decay helpers

Strategy author checklist:
- keep `defaultParams` valid after normalization
- keep `defaultParams`, `paramLabels`, and `metadata.walkForwardParams` on the same exact keys
- use normalized params inside `execute(...)` when bounds or thresholds depend on them
- register only in `lib/strategies/manifest.ts`; do not hand-wire `strategyRegistry.ts`
- add or extend `strategies.spec.ts` when normalization or WFA behavior is non-trivial

Common mistakes:
- sanitizing params inside `execute(...)` but forgetting `normalizeParams(...)`
- adding a new strategy file but forgetting the manifest entry
- exposing a WFA param that the strategy later ignores or renames
- adding `prepareFinderData(...)` for a cheap strategy and paying complexity for no gain

### Change backtest behavior
- Engine logic: `lib/strategies/backtest/*`
- UI orchestration and engine selection: `lib/backtest-service.ts`
- Validate long, short, both, combined, and execution model variants

### Change UI controls safely
1. Add or update markup in `html-partials/*`
2. Add the required id to `lib/feature-dom-contracts.ts` if it is structural
3. Wire the feature through its typed DOM contract
4. Run the smoke test and typecheck

### Modify Portfolio Lab
- Main controller: `lib/portfolio-lab-service.ts`
- Markup: `html-partials/tab-portfolio.html`
- DOM contract: `lib/feature-dom-contracts.ts`
- Shared backtest seam: `lib/backtest-service.ts`

Important behavior:
- pair runs use the current selected strategy and current live UI settings
- `Latest N Bars` keeps each symbol on its own latest history window
- `Common Overlap` trims all selected symbols to the shared overlapping calendar window
- `Current Context` is a one-shot calculation, not a live stream
- `Open Trade Forecast` is target-centric and uses ETH-relative plus universe-relative analog features, not all pair-vs-pair synthetic charts
- `Execution Filters` are target-symbol decisions; `Pair Context Probability` is basket-level descriptive analysis

If you change Portfolio Lab logic, verify:
- target symbol handling when the benchmark is not one of the ranked pair rows
- breadth/opposition sweeps still use causal same-bar or trailing-lag context only
- sizing scenarios still render when the target symbol is benchmark-only
- repeated sweep rows collapse correctly when thresholds stop changing outcomes
- structural ids stay aligned with `tests/feature-dom-contracts.spec.ts`

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
..\\..\\..\\node_modules\\.bin\\esno tests\\pairCombiner.spec.ts
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
- `DEPLOY_TO_VERCEL.md`: deployment notes

The old README content about the Twin Towers / Empire setup belongs in those specialized docs, not as the main project entrypoint.
