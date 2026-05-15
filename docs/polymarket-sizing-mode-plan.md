# Polymarket Alternative Sizing Plan

## Goal

Add Polymarket bankroll sizing for manual Polymarket-annotated backtests when Alternative Sizing is enabled and the resolved sizing mode is not `percent`.

The user should be able to test whether Polymarket edge improves or degrades under modes such as:

- martingale
- anti-martingale
- Kelly Criterion
- volatility targeting
- risk parity
- Optimal f
- Secure f
- smart fixed modes

The Trades menu must show the Polymarket entry stake and realized Polymarket profit for each sized trade.

## Non-Goals

- Do not change normal chart backtest sizing.
- Do not overwrite `trade.pnl`, `trade.size`, chart net profit, or chart equity curve.
- Do not apply this to normal `percent` sizing when Alternative Sizing is off.
- Do not change endpoint behavior.
- Do not add Finder/Hunt ranking changes in the first implementation.
- Do not model order book liquidity or slippage beyond existing Polymarket entry/exit price annotations.

## Core Decision

Polymarket sizing is a separate bankroll layer built after Polymarket trade annotation.

Normal backtest trades continue to represent chart execution. Polymarket sizing reads the annotated Polymarket entry/exit prices and computes a separate stake, share count, dollar profit, and Polymarket bankroll path.

Polymarket stake means dollars spent to buy YES/NO shares, not number of shares and not maximum payout.

Smart sizing state must update from Polymarket dollar profit, not chart trade PnL.

## Activation Rule

Enable Polymarket sizing only when all are true:

- manual backtest result has Polymarket trade annotations
- Alternative Sizing is enabled in the manual run settings
- resolved `capitalSettings.sizingMode` is not `percent`
- the trade has usable Polymarket entry price and payout

If the selected mode is `percent`, keep existing Polymarket per-share diagnostics unchanged.

Implementation guard:

- use the `capitalSettings` captured for the manual backtest run
- pass an explicit `alternativeSizingEnabled` boolean into the Polymarket sizing helper
- do not infer sizing mode inside the renderer
- if `getCapitalSettings()` can return a disabled `tradeSizingMode` when Alternative Sizing is off, fix or bypass that before enabling this feature

## Phase 0: Capital Activation Guard

Purpose: make the feature impossible to trigger from stale or disabled sizing UI state.

Check the manual capital read path before adding Polymarket sizing:

- `fixedTradeToggle` controls whether Alternative Sizing is enabled
- when `fixedTradeToggle` is off, the effective sizing mode for this feature is `percent`
- the disabled `tradeSizingMode` select must not activate Polymarket sizing
- the Polymarket sizer receives both `capitalSettings` and `alternativeSizingEnabled`

Verification:

- Alternative Sizing off plus hidden `martingale` select does not produce sized Polymarket fields
- Alternative Sizing on plus `fixed` produces sized Polymarket fields using Base Trade Amount
- Alternative Sizing on plus `martingale` does produce sized Polymarket fields when trades are eligible

## Phase 1: Sizing Model Contract

Purpose: define the data shape without changing UI rendering yet.

Add trade-level Polymarket sizing fields under `trade.polymarketOutcome`, for example:

- `sizedStake`
- `sizedShares`
- `sizedPnl`
- `sizedPnlPercent`
- `sizedEquityBefore`
- `sizedEquityAfter`
- `sizedSizingMode`

Add summary-level fields under `polymarketTradeSummary`, for example:

- `sizedSizingMode`
- `sizedInitialCapital`
- `sizedFinalEquity`
- `sizedNetProfit`
- `sizedNetProfitPercent`
- `sizedGrossProfit`
- `sizedGrossLoss`
- `sizedProfitFactor`
- `sizedExpectancy`
- `sizedMaxDrawdown`
- `sizedMaxDrawdownPercent`
- `sizedTrades`
- `sizedSkippedTrades`
- `sizedNoCapitalTrades`
- `sizedCappedTrades`
- `sizedTotalStaked`
- `sizedAvgStake`
- `sizedMaxStake`

Verification:

- typecheck catches all type contract updates
- tests can construct typed Polymarket outcomes with and without sizing fields
- summary field names do not collide with existing chart or settings sizing fields

## Phase 2: Shared Polymarket Payout Helpers

Purpose: avoid duplicating payout logic across resolve-hold, signal-exit, and Trades display.

Create or reuse helpers that derive:

- `entryPrice`
- `sharePnl`
- whether the trade is eligible for sized bankroll simulation

Eligibility rules:

- skip missing `polymarketOutcome`
- skip `duplicate`
- skip `filtered`
- skip `no_event`
- skip `missing`
- skip missing or non-positive `marketEntryPrice`
- skip missing payout

Payout priority:

1. `marketPnl`
2. `marketExitPrice - marketEntryPrice`
3. resolve-hold fallback: win pays `1 - marketEntryPrice`, loss pays `-marketEntryPrice`

Verification:

- unit tests cover resolve-hold win/loss
- unit tests cover signal-exit `marketPnl`
- unit tests cover skipped trade statuses

## Phase 3: Polymarket Bankroll Sizer

Purpose: compute Polymarket-specific stake and profit using existing sizing semantics.

Add a pure helper, for example `applyPolymarketAlternativeSizing(...)`, that accepts:

- annotated trades
- chart data
- backtest settings needed for indicator preparation
- capital settings

The helper should reuse existing sizing formulas instead of duplicating them.

Preferred implementation:

- build a Polymarket sizing state equivalent to the engine's smart sizing state
- reuse `resolveAllocatedCapital(...)` from `lib/strategies/backtest/position-builder.ts`
- precompute the ATR/indicator input needed by quality and volatility modes
- map each trade entry time to the chart bar index
- for `next_open`, use the previous closed bar as the sizing bar, matching normal engine behavior

For each eligible trade:

1. read current Polymarket bankroll
2. resolve stake using the existing sizing allocation helper
3. cap stake to available bankroll
4. compute shares as `stake / marketEntryPrice`
5. compute dollar PnL as `shares * sharePnl`
6. update bankroll
7. update smart sizing state from Polymarket dollar PnL

Mode behavior:

- `fixed`: Polymarket sizing overlay using configured Base Trade Amount
- `percent`: no Polymarket sizing overlay for this feature
- multiplier modes use a Polymarket-specific `$1` base trade amount unless configured to use percent base
- Kelly history uses Polymarket return per `$1` stake; the `$1` amount is only the fallback before enough valid history exists
- direct-fraction modes use bankroll fraction
- volatility/risk modes may reuse chart data for volatility input, but their realized PnL state remains Polymarket-based
- direct-fraction fallback before enough history should match normal engine fallback behavior

Bankroll rules:

- cap stake at current bankroll
- if bankroll is `0` or below, skip later eligible trades as no-capital trades
- skipped or no-capital trades must not update sizing state
- do not store a full chart-time equity curve unless a later UI needs it; per-trade equity checkpoints are enough for drawdown

Verification:

- martingale increases stake after a Polymarket loss
- anti-martingale increases stake after a Polymarket win
- stake is capped at current bankroll
- no-capital trades are skipped after bankroll depletion
- Kelly falls back before enough Polymarket history exists
- skipped trades do not update bankroll or sizing state
- entry bar mapping matches `next_open` sizing timing

## Phase 4: Manual Backtest Integration

Purpose: attach sized Polymarket data to the normal manual backtest result.

Integration point:

- in `BacktestService.runCurrentBacktest(...)`
- after `annotateBacktestResultWithPolymarketOutcomes(...)`
- before `commitBacktestResult(...)`

Inputs:

- current capital settings
- current backtest settings
- annotated Polymarket trades

Rules:

- only run when Alternative Sizing is enabled and resolved sizing mode is not `percent`
- leave unannotated and unsupported Polymarket results unchanged
- preserve existing `polymarketTradeSummary` fields
- append sized fields without changing existing per-share expectancy/profit-factor semantics
- keep the helper out of `TradesRenderer`; rendering should read committed sized fields, not recompute bankroll state
- keep endpoint/executor annotation unchanged unless a later endpoint phase is explicitly added

Verification:

- manual backtest result has sized fields for fixed-dollar and advanced modes
- manual backtest result has no sized fields for `percent`
- existing Polymarket summary metrics remain unchanged
- lazy Trades-panel Polymarket annotation does not create partial or inconsistent sized fields

## Phase 5: Trades Menu Display

Purpose: show Polymarket entry size and profit where the user inspects individual trades.

For each sized Polymarket trade, add a compact row:

`Poly Stake: $X | Shares: Y @ Zc | Profit: +$P`

Display rules:

- positive profit uses existing positive styling
- negative profit uses existing negative styling
- skipped Polymarket trades show no sized stake/profit row
- normal chart trade size row remains unchanged
- renderer reads existing sized fields only

Summary behavior:

- keep current Trades summary based on chart PnL for now
- do not mix chart PnL and Polymarket sized PnL in the same summary number

Verification:

- trade row renders stake, shares, entry price, and profit
- fixed mode renders the sized row when eligible
- percent mode does not render the sized row
- skipped Polymarket outcomes do not render misleading zero profit

## Phase 6: Polymarket Panel Summary

Purpose: expose portfolio-level result of the sized Polymarket bankroll without replacing existing diagnostics.

Add a small sized bankroll section when sized data exists:

- final equity
- net profit
- return percent
- max drawdown
- profit factor
- average stake
- max stake
- sized trades / skipped trades

Rules:

- hide the section when sizing mode is `percent`
- hide the section when no sized trades exist
- keep current per-share Polymarket expectancy visible

Verification:

- section appears after a fixed-dollar or advanced sized Polymarket run
- section is absent for percent mode and unsupported runs

## Phase 7: Tests

Purpose: lock down behavior before expanding to Finder or Hunt.

Required tests:

- Polymarket payout helper tests
- Polymarket bankroll sizing tests
- manual annotation integration tests
- capital activation tests for `fixed`, `percent`, and advanced Alternative Sizing modes
- Trades renderer output test if an existing renderer test seam is practical

Recommended commands:

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\polymarket-trade-annotations.spec.ts
..\..\..\node_modules\.bin\esno tests\monte-carlo-polymarket.spec.ts
..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

If the implementation touches shared settings or renderer contracts, also run:

```bash
npm run test
```

## Phase 8: Later Finder/Hunt Extension

Purpose: keep manual backtest implementation small first, then add search support only after the manual behavior is stable.

Possible later rank modes:

- `sizedNetProfit`
- `sizedReturn`
- `sizedProfitFactor`
- `sizedExpectancy`

Rules for later work:

- Finder/Hunt must use the same Polymarket bankroll sizer as manual backtest
- do not rank sized results using old per-share expectancy without making that explicit

## Success Criteria

- Fixed-dollar and advanced Alternative Sizing modes produce Polymarket stake and dollar profit per trade.
- Martingale and anti-martingale react to Polymarket outcomes, not chart outcomes.
- Fixed mode uses Base Trade Amount and reports sized net.
- Percent sizing behavior remains unchanged.
- Existing chart backtest metrics remain unchanged.
- Existing Polymarket per-share diagnostics remain available.
- Trades menu clearly shows Polymarket stake and profit for sized trades.
