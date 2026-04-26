# Polymarket Monte Carlo Plan

## Goal

Add `Run Polymarket Monte Carlo` inside the existing `Monte Carlo` tab.

It must:

- use the current backtest result only
- simulate bankroll outcomes from Polymarket-priced trades
- keep the existing chart `Run Monte Carlo` path unchanged
- avoid changes to Finder, Hunt, Walk Forward, Quick View, the Polymarket tab, endpoint flows, workers, and Strategy Ensemble

## Purpose

Answer these questions from the `Monte Carlo` tab:

- if bankroll starts at `$10,000`, what is the median ending bankroll?
- what is the 5th percentile ending bankroll?
- how often does bankroll hit the ruin threshold?
- how deep can drawdowns get under worse trade ordering?
- how much of the backtest is actually scorable on Polymarket?

## Audit Outcome

The first draft had five weaknesses:

1. one coverage number was too blunt and would misread intentional `duplicate` or `filtered` skips as missing data
2. it did not say what happens when the result has summary-level Polymarket data but missing trade-level annotations
3. it mixed chart-capital sizing with Polymarket bankroll sizing
4. it proposed extra engine result arrays that are not needed
5. it kept chart-style metric labels that would be misleading for Polymarket payout runs

This plan fixes them by:

- splitting coverage into `overallCoverage` and `dataCoverage`
- requiring trade-level `polymarketOutcome` data and telling the user to rerun the backtest when absent
- making `Allocation Per Trade (%)` a Monte-Carlo-only Polymarket sizing model
- deriving ending bankroll from existing profit samples instead of adding a second raw equity array
- making labels source-aware, especially `Positive Trade Rate` for Polymarket runs

## V1 Scope

- Monte Carlo tab only
- current backtest result only
- no new persistence
- no background re-annotation
- support `resolve_hold` and `signal_exit_same_event` only when trade payout is derivable from current annotated trades

## Non-Goals

- strategy ranking outside the Monte Carlo tab
- batch comparison across strategies
- Finder or Hunt integration
- new Polymarket annotation logic
- live fill modeling
- orderbook or bid-ask simulation
- endpoint or worker changes

## Current Repo Facts

- Monte Carlo tab markup: `html-partials/tab-monte-carlo.html`
- Monte Carlo DOM contract: `lib/monte-carlo-dom.ts`
- Monte Carlo service: `lib/monte-carlo-service.ts`
- Monte Carlo renderer: `lib/monte-carlo-renderer.ts`
- Monte Carlo engine: `lib/strategies/monte-carlo/monte-carlo-engine.ts`
- Monte Carlo types: `lib/strategies/monte-carlo/types.ts`
- existing engine simulates chart `trade.pnl`
- Polymarket trade data lives on `trade.polymarketOutcome`
- share-level payout can already be derived from:
  - `polymarketOutcome.marketPnl`
  - `polymarketOutcome.marketExitPrice - polymarketOutcome.marketEntryPrice`
  - `resolve_hold` fallback from `polymarketOutcome.marketEntryPrice` and `polymarketOutcome.isWin`

## Core Decision

Keep two explicit actions in the same tab:

- `Run Monte Carlo`
- `Run Polymarket Monte Carlo`

Do not add a new tab.

Do not reuse raw `marketPnl` as bankroll dollars.

`marketPnl` is per share. Bankroll simulation must convert share payout into return on allocated capital.

`Allocation Per Trade (%)` is independent from chart backtest sizing settings.

Monte Carlo uses:

- `Initial Capital`
- `Ruin Threshold (%)`
- `Allocation Per Trade (%)`

It does not inherit Kelly, fixed-dollar, volatility-targeted, or other chart sizing modes in v1.

## Polymarket Bankroll Model

V1 uses one Polymarket-specific sizing model:

- `Allocation Per Trade (%)`

Default:

- `2`

Formula per eligible trade:

1. `entryPrice = marketEntryPrice`
2. `sharePnl = marketPnl ?? (marketExitPrice - marketEntryPrice) ?? resolveHoldPayout`
3. require `entryPrice > 0`
4. `returnOnAllocatedCapital = sharePnl / entryPrice`
5. `allocatedCapital = currentEquity * (allocationPercent / 100)`
6. `tradeDollarPnl = allocatedCapital * returnOnAllocatedCapital`
7. `currentEquity += tradeDollarPnl`

Rules:

- skip trades without usable `marketEntryPrice`
- skip trades without usable payout
- skip trades marked by Polymarket as `duplicate`, `filtered`, `missing`, or `no_event`
- ruin check stays `currentEquity < initialCapital * ruinThresholdPercent / 100`
- `overallCoverage = usableTrades / totalChartTrades`
- `dataCoverage = usableTrades / (usableTrades + missingPriceTrades + missingOutcomeTrades)`

This model is enough to answer survivability without adding a second Polymarket sizing system in v1.

## Phase 1: UI Contract And Gating

### Purpose

Expose the new run path in the Monte Carlo tab and make unsupported states obvious.

### Files

- `html-partials/tab-monte-carlo.html`
- `lib/monte-carlo-dom.ts`
- `tests/feature-dom-contracts.spec.ts`

### Changes

Add these Monte Carlo tab controls:

- `mc-run-polymarket-btn`
- `mc-polymarket-allocation-percent`
- `mc-source-badge`
- `mc-polymarket-summary`
- `mc-pm-scored-trades`
- `mc-pm-overall-coverage`
- `mc-pm-data-coverage`
- `mc-pm-skip-breakdown`
- `mc-pm-median-final-bankroll`
- `mc-pm-final-bankroll-p5`

Behavior:

- existing `Run Monte Carlo` keeps chart behavior
- new `Run Polymarket Monte Carlo` is disabled when:
  - no current backtest result exists
  - current backtest lacks trade-level `polymarketOutcome` annotations
  - current backtest has no usable Polymarket payouts
  - usable Polymarket trades are fewer than `5`
- disabled reason goes into Monte Carlo status text
- if `polymarketTradeSummary` exists but trade-level annotations are missing, status text tells the user to rerun the backtest with Polymarket annotation enabled
- `Polymarket Survivability` section stays hidden until a Polymarket run completes

### Verify

- new ids are added to `MONTE_CARLO_REQUIRED_IDS`
- `tests/feature-dom-contracts.spec.ts` passes
- both run buttons render in the Monte Carlo tab

## Phase 2: Polymarket Input Extraction

### Purpose

Turn the current annotated backtest result into a clean Monte Carlo input without changing Polymarket scoring.

### Files

- `lib/strategies/monte-carlo/polymarket-monte-carlo-input.ts`
- `lib/strategies/monte-carlo/index.ts`

### Changes

Add a helper that reads `BacktestResult.trades` and returns:

- usable trade list
- usable trade count
- total trade count
- `overallCoverage`
- `dataCoverage`
- skipped counts by reason
- effective evaluation mode for labeling

Each usable trade must contain:

- `entryPrice`
- `sharePnl`
- chart `exitTime`

Payout fallback order:

1. numeric `marketPnl`
2. numeric `marketExitPrice - marketEntryPrice`
3. `resolve_hold` payout:
   - YES win: `1 - marketEntryPrice`
   - YES loss: `-marketEntryPrice`
   - NO win: `1 - marketEntryPrice`
   - NO loss: `-marketEntryPrice`

Skip rules:

- `polymarketOutcome` missing
- `marketEntryPrice <= 0`
- payout not finite
- `marketExitSource` in `duplicate`, `filtered`, `missing`, `no_event`

Evaluation mode resolution:

1. `BacktestResult.polymarketTradeSummary?.evaluationMode`
2. first non-null `trade.polymarketOutcome?.evaluationMode`
3. default `resolve_hold`

Do not reload price points or outcomes here.

### Verify

- helper returns identical usable trade counts for repeated calls
- fallback order is deterministic
- unsupported trades are excluded before simulation
- `overallCoverage` and `dataCoverage` are stable and match skip counts

## Phase 3: Engine Extension

### Purpose

Reuse Monte Carlo sequencing and distribution logic while adding a bankroll-based Polymarket run path.

### Files

- `lib/strategies/monte-carlo/types.ts`
- `lib/strategies/monte-carlo/monte-carlo-engine.ts`

### Changes

Add a second public engine entrypoint:

- `runPolymarketMonteCarloSimulation(...)`

Keep existing entrypoint unchanged:

- `runMonteCarloSimulation(...)`

Refactor shared logic only where both paths use it:

- scenario order generation
- abort handling
- progress reporting
- chunked execution
- sampling
- distribution aggregation

Add Polymarket-specific engine input based on extracted usable trades:

- `entryPrice`
- `sharePnl`
- `exitTime`

Add result metadata:

- `inputSource: "chart" | "polymarket"`
- `coverageSummary?: { overallCoverage: number; dataCoverage: number; usableTrades: number; totalTrades: number; missingPriceTrades: number; missingOutcomeTrades: number; duplicateTradesIgnored: number; filteredTradesIgnored: number }`
- `successRateLabel?: "Win Rate" | "Positive Trade Rate"`

Observed Polymarket metrics must use original usable-trade order and the same allocation formula as the simulations.

Do not add a second raw `finalEquityValues` array.

For Polymarket runs:

- `netProfitValues` already represent bankroll PnL in dollars
- ending bankroll is `initialCapital + netProfit`
- percentile ending bankroll is derived in the renderer from `netProfitValues`

Sharpe stays secondary in v1:

- compute it from the kept trades' chart `exitTime` values and simulated equity samples
- do not add a new time normalization path

Success-rate semantics:

- chart mode: existing `winRate`
- Polymarket mode: `positivePnlTrades / usableTrades`

Zero-PnL trades count as non-positive for this metric and stay visible separately in the skip or summary output.

Insufficient sample rule:

- chart mode: unchanged
- Polymarket mode: require at least `5` usable Polymarket trades

### Verify

- chart Monte Carlo output remains unchanged for the same seed
- Polymarket Monte Carlo is deterministic for the same seed and same input trades
- final equity distribution is populated for Polymarket runs

## Phase 4: Monte Carlo Service Wiring

### Purpose

Run the new path from the existing Monte Carlo tab only.

### Files

- `lib/monte-carlo-service.ts`

### Changes

Split the current run flow by source:

- `handleRun("chart")`
- `handleRun("polymarket")`

Service rules:

- chart button calls existing engine
- Polymarket button calls the new extraction helper, then `runPolymarketMonteCarloSimulation(...)`
- safe cap uses:
  - chart trade count for chart mode
  - usable Polymarket trade count for Polymarket mode
- cancel, spinner, presets, and scenario toggles stay shared
- no auto-run on tab open
- no writeback to settings outside the Monte Carlo tab
- if `overallCoverage < 0.25`, show a low-confidence warning after the run
- if `dataCoverage < 0.6`, show a data-quality warning after the run

Status text must distinguish source clearly.

Examples:

- `Polymarket Monte Carlo requires a Polymarket-annotated backtest`
- `Only 4 usable Polymarket trades; need at least 5`
- `Completed 2,000 Polymarket sims per scenario across 3 scenarios`

### Verify

- opening the Monte Carlo tab refreshes Polymarket button enabled state
- running chart mode still uses the current behavior
- Polymarket safe cap changes when usable Polymarket trade count changes

## Phase 5: Survivability Presentation

### Purpose

Make the Monte Carlo tab answer bankroll survival directly.

### Files

- `lib/monte-carlo-renderer.ts`

### Changes

Add source-aware rendering.

For all runs:

- show `mc-source-badge`

For Polymarket runs:

- show `Polymarket Survivability` section
- show:
  - scored trades used
  - overall coverage
  - data coverage
  - skip breakdown
  - median ending bankroll
  - 5th percentile ending bankroll
  - ruin probability
  - 95th percentile max drawdown
- use `Ending Bankroll Distribution` for the first histogram
- keep method comparison, drawdown tables, and fan chart
- risk detail text must refer to bankroll stress, not chart path
- label the CI or rate row as `Positive Trade Rate`, not `Win Rate`
- if coverage warning thresholds are breached, the risk detail must include that warning explicitly

For chart runs:

- keep current labels and current histogram semantics
- hide the Polymarket survivability section

### Verify

- Polymarket run renders survivability fields in dollars
- chart run does not show Polymarket-only fields
- switching between chart and Polymarket runs updates labels correctly

## Phase 6: Tests And Validation

### Purpose

Lock the contracts and the bankroll math.

### Files

- `tests/monte-carlo-polymarket.spec.ts`
- `tests/feature-dom-contracts.spec.ts`

### Tests

Add focused tests for:

- payout from `marketPnl`
- payout from `marketExitPrice - marketEntryPrice`
- `resolve_hold` payout fallback
- skip rules for `duplicate`, `filtered`, `missing`, `no_event`
- skip rule for `marketEntryPrice <= 0`
- `overallCoverage` and `dataCoverage` math
- evaluation-mode fallback order
- allocation-percent bankroll compounding
- ruin threshold trigger
- insufficient sample based on usable Polymarket trades
- deterministic results for same seed
- low-coverage warning state
- source-aware label switch to `Positive Trade Rate`

### Validation Commands

Run from this directory:

- `npm run typecheck`
- `npm run test -- monte-carlo`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

## Acceptance Criteria

- existing chart Monte Carlo behavior stays intact
- Polymarket Monte Carlo exists only in the Monte Carlo tab
- bankroll results are based on Polymarket capital return, not raw share payout
- user can set initial capital, ruin threshold, and Polymarket allocation percent
- result shows scored-trade count, overall coverage, data coverage, and skip breakdown
- result shows median and 5th percentile ending bankroll
- result labels do not call Polymarket payout profitability `Win Rate`
- result is deterministic for the same seed
- no Finder, Hunt, Walk Forward, Quick View, endpoint, worker, or Polymarket tab logic changes are required
