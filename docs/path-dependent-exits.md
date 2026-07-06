# Path-Dependent Exit Risk Management

## Overview

Path-dependent exits add experimental exit logic to Risk Management that evaluates how a trade's price path evolves — not just fixed TP/SL levels. The feature is TypeScript-engine only, works for all trade directions, and defaults to off.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pathExitEnabled` | boolean | `false` | Master toggle |
| `pathExitMode` | select | `off` | Which exit rule to use |
| `pathExitMinBars` | number | `3` | Minimum bars before path exit can fire |
| `pathExitMinMfePercent` | number | `0.5` | Minimum MFE % required (giveback/compression) |
| `pathExitGivebackPercent` | number | `50` | MFE giveback threshold % |
| `pathExitLookbackBars` | number | `10` | Rolling lookback window |
| `pathExitThreshold` | number | `0.1` | Mode-specific threshold |
| `pathExitMinSamples` | number | `30` | Minimum closed-trade samples for learning modes |
| `pathExitHorizonBars` | number | `50` | Forward horizon for triple-barrier labeling |

All settings live in the Risk Management section. When `pathExitEnabled` is true and Rust engine is selected, the system automatically falls back to the TypeScript engine.

## Exit Modes

### MFE Giveback (`mfe_giveback`)
Exits when the trade has reached a minimum favorable excursion and then gives back a configurable share of that move. Uses `pathExitMinMfePercent` and `pathExitGivebackPercent`.

### Profit Compression (`profit_compression`)
Exits when profit remains positive but profit-per-bar decays below `pathExitThreshold`. Requires MFE threshold to have been reached. Does not fire while the trade is still making new extremes.

### Momentum Deceleration (`momentum_deceleration`)
Exits when directional momentum over `pathExitLookbackBars` falls below `pathExitThreshold` after previously being above it. Only fires on profitable trades.

### Capitulation Exhaustion (`capitulation_exhaustion`)
Detects stretched candles (range/body/volume in the top percentile over `pathExitLookbackBars`) in the trade direction. Exits on the next bar if price fails to extend or closes back through the capitulation midpoint.

### Squeeze Pressure (`squeeze_pressure`)
Detects opposite-side pressure: opposite-color close, close location against the trade, plus range/volume expansion or SMA reclaim. Exits when the trade has positive MFE or has been held for `pathExitMinBars`.

### Structure Reclaim (`structure_reclaim`)
Derives a structure support/resistance level at entry from the breakout candle midpoint blended with the prior swing high/low over `pathExitLookbackBars`. Exits when close reclaims this level against the trade direction.

### Conditional Hazard (`conditional_hazard`)
**Causal learning mode.** After each trade closes, records per-bar continuation returns bucketed by bars held, current PnL%, and MFE%. On subsequent trades, exits when the current state has enough samples (`pathExitMinSamples`) and average continuation expectancy ≤ 0.

### Triple-Barrier Meta (`triple_barrier_meta`)
**Causal learning mode.** After each trade closes, classifies each intermediate bar's forward outcome as favorable (+1), adverse (−1), or neutral (0) using `pathExitThreshold`-wide barriers over `pathExitHorizonBars`. On subsequent trades, exits when the current state's average label ≤ 0.

## Causality Guarantees (Learning Modes)

- Learning state is initialized empty at the start of each backtest run
- State is updated **only after** a trade fully closes — a trade's own bars never influence its own exit
- The first trade in a run never triggers a learning exit
- Subsequent trades can exit once enough samples accumulate in matching state buckets
- 75 max state keys (5 bars-held × 5 PnL × 3 MFE buckets) — bounded memory, O(1) lookup
- No data persisted between runs, no external ML dependencies

## Exit Priority

Path exits are evaluated after stop loss, take profit, and partial take profit, but before time stops. They are chart exits, not signal exits — they fire even when `disableSignalExits` is on.

The exit reason appears as `path_exit` in trade tables, exit reason breakdowns, and quick-view badges.

## Finder / Batch / Rust Compatibility

- **Finder**: Path exits work in Finder runs using the TypeScript engine. No settings are filtered.
- **Batch Backtest**: Both browser-side and server-side Batch pass path exit settings through the standard resolver pipeline.
- **Rust engine**: All `pathExit*` keys are in `RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS`. When path exits are enabled, the system falls back to the TypeScript engine with a visible warning.

## Experiment Workflow

Recommended comparison workflow for evaluating path exit modes:

1. **Baseline**: Run with `pathExitEnabled: false` — native signal exits only
2. **Fixed TP/SL reference**: Run with standard TP/SL for comparison
3. **Path exit mode**: Enable one mode at a time with `pathExitEnabled: true`
4. **Direction split**: Test long-only and short-only separately
5. **Buy-and-hold**: Compare net profit % against buy-and-hold
6. **OOS validation**: Use Finder Symbol Universe or Walk Forward for out-of-sample confirmation

## Known Limitations

- Only one path-exit mode can be active per run (no combinatorial stacking)
- Learning modes (`conditional_hazard`, `triple_barrier_meta`) may be inert on short datasets with few trades
- Path exits are not supported by the Rust engine
- Volume-dependent modes (`capitulation_exhaustion`, `squeeze_pressure`) degrade on datasets with zero or unreliable volume
- Path exits do not participate in Polymarket `signal_exit_same_event`
