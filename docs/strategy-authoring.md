# Strategy Authoring

This guide is for adding or modifying built-in strategies under `lib/strategies/lib/*`.

For repo-level orientation, read [`README.md`](../README.md) first. For operational safety checks while editing code, use [`AGENTS.md`](../AGENTS.md).

## Core Contract

Finder, Walk Forward, the base UI, and the worker-facing library must all observe the same strategy semantics.

That means:
- the file lives in `lib/strategies/lib/<strategy-key>.ts`
- the exported const is the strategy key
- generated strategy catalog files under `lib/strategies/manifest*.ts` are regenerated from the strategy files
- `normalizeParams(...)` exposes the same canonical parameter semantics that `execute(...)` actually uses

If a strategy silently clamps, rounds, or flips a parameter inside `execute(...)` but does not expose that through `normalizeParams(...)`, the UI and optimization layers drift.

## Build Order

1. Pick a stable key and keep the file name and exported const aligned with that key.
2. Start from a nearby example:
   - `lib/strategies/lib/close_location_median_alignment.ts` for a small direct `execute(...)` pattern
   - `lib/strategies/lib/rolling_vwap_center.ts` for normalized thresholds and Finder precompute
   - `lib/strategies/lib/relative_strength_mean_reversion.ts` for cross-symbol prepared execution
   - `lib/strategies/lib/polymarket_fair_value_mispricing.ts` for 1s Polymarket helper context
3. Write the raw signal idea first with `ensureCleanData(...)` and `createSignalLoop(...)`.
4. Add a named parameter normalizer before wiring `metadata.walkForwardParams`.
5. Run `npm run strategies:sync-manifest`.
6. Default to `prepareFinderData(...)` when the strategy builds reusable rolling, VWAP, percentile, entropy, skewness, or cross-symbol arrays. Skip it only for cheap one-pass logic where the extra seam would not reduce Finder cost.

## Minimal Template

```ts
import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";

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

## Prompt Intake

When a prompt or JSON idea becomes a strategy, treat it as a draft, not as code.

- `key` becomes the file name and exported const name.
- `name` becomes `strategy.name`.
- thesis text becomes a short `description`, not runtime metadata.
- helper and indicator names are candidate imports only; verify every export before coding.
- decorative params that do not affect entries should be rejected.
- duplicate-check fields are review notes, not strategy object fields.

Reject or simplify an idea before implementation when it depends on missing helpers, adds filters that do not change the thesis, uses non-causal future bars, or can be expressed with fewer params.

## Signal Loop Rules

Most entry strategies should use `createSignalLoop(...)`.

Return `Signal | null | undefined`, not numeric flags. Use `createBuySignal(...)` and `createSellSignal(...)` so downstream code receives the expected shape and reason strings.

`createSignalLoop(...)` only guards the indicator arrays passed to it. If the callback reads additional arrays or object-of-arrays members, guard those values explicitly.

Keep signal reason strings stable and descriptive. They are used by diagnostics and debugging output.

## Required Fields

Every built-in strategy should include:
- `name`
- `description`
- `defaultParams`
- `paramLabels`
- `execute(data, params)`
- `metadata` with `role`, `direction`, and `walkForwardParams` when applicable

Add `normalizeParams(...)` when execution rounds, clamps, coerces sign, snaps to a grid, or otherwise sanitizes inputs.

## Useful Helpers

- `lib/strategies/strategy-helpers.ts`
  Core signal creation, loop helpers, clean-data guards, and base OHLCV extractors.
- `lib/strategies/lib/price-action-frequency-core.ts`
  Candle geometry helpers plus microstructure-oriented primitives such as close acceptance, initiative pressure, and sweep-reclaim scoring.
- `lib/strategies/lib/price-action-statistics-core.ts`
  Rolling entropy, efficiency ratio, rolling medians, z-scores, and streak counters.
- `lib/strategies/lib/polymarket-1s-helpers.ts`
  For supported 1s Polymarket strategies only. Declare `polymarket1sConfig: { required: true }`, use causal runtime context, and fail closed when helper frames are unavailable. Executable-edge strategies should prefer ask-side edge plus actionability/persistence over mid-price-only pressure.

## Type Rules That Matter

- Match array shapes carefully.
  `buildRollingZScore(...)` expects `number[]`, while some helpers like `buildEfficiencyRatio(...)` intentionally work from `OHLCVData[]`.
- Guard padded indicator arrays.
  Use checks like `if (i < lookback || indicator[i] === null) return null;`.
- Track indicator output shape precisely.
  `calculateATR()` and `calculateADX()` return arrays; `calculateKeltnerChannels()` returns an object containing arrays.

## Finder / Walk Forward Rules

- `defaultParams` must already be valid after normalization.
- Every optimized param must exist in:
  - `defaultParams`
  - `paramLabels`
  - `metadata.walkForwardParams`
  - the execution logic
- If you add `prepareFinderData(...)`, keep `executePrepared(...)` behavior identical to `execute(...)`.
- For heavy strategies, treat prepared execution as the default path rather than an optional extra.
- Keep the prepared payload small and cache reusable arrays by the real param dimension, usually lookback.
- Do not add Finder precompute to cheap strategies just for symmetry.

## Cross-Symbol Strategies

Cross-symbol strategies declare `crossSymbolConfig` and receive the resolved secondary data through the optional third `StrategyExecutionContext` argument. Strategies must not fetch or align secondary data themselves.

Rules:

- declare `crossSymbolConfig.defaultSymbol`
- read `context?.crossSymbol.secondaryData`
- return `[]` or fail closed when required context is missing
- pass the same context through `prepareFinderData(...)` and `executePrepared(...)`
- do not combine cross-symbol execution with strategy-timeframe resampling

Use `lib/strategies/lib/relative_strength_mean_reversion.ts` as the main example. See [cross-symbol.md](cross-symbol.md) for the full runtime support matrix.

## 1s Polymarket Strategies

Use this path only when the strategy requires supported 1s Binance chart data plus local Polymarket CLOB context.

Rules:

- declare `polymarket1sConfig: { required: true }`
- accept `StrategyExecutionContext` in `execute(...)`
- return `[]` when the required context or helper frame is unavailable
- call Polymarket helper builders once before the signal loop
- prefer executable ask-side edge, actionability, and persistence checks when the target is paper/live deployability
- treat Gamma helpers as agreement filters, not primary signal sources

Do not build spread-only alpha or call Polymarket helper builders inside the per-bar callback.

## Synthetic Pair Strategies

Synthetic pairs are already merged into one OHLCV ratio series before a strategy runs. Do not declare `crossSymbolConfig` for a synthetic-pair strategy.

Rules:

- use scale-invariant thresholds such as z-score, percentile, rolling median distance, efficiency ratio, or return/range ratios
- do not use absolute price levels
- do not use raw volume as tradable flow; synthetic volume is the less-liquid leg's volume proxy
- treat wide high/low ranges as possible leg disagreement, not ordinary volatility

See [synthetic-pairs.md](synthetic-pairs.md) for generation and support details.

## Checklist Before You Stop

- file exists in `lib/strategies/lib/*`
- exported const name is the strategy key
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are valid after `normalizeParams`
- `metadata.walkForwardParams` references only real params
- `execute(...)` uses normalized params when behavior depends on normalized values
- `npm run strategies:sync-manifest` was run
- `npm run strategies:audit-prepared` was run if the strategy uses rolling statistics, VWAP, or cross-symbol state
- `npm run typecheck` passes
- `tests/new-strategy-lib-smoke.spec.ts` passes (smoke-tests every manifest strategy), and a focused strategy spec was added/updated if normalization, Finder, or WFA behavior is non-trivial
- the strategy appears in the UI dropdown

## Common Mistakes

- sanitizing params inside `execute(...)` but forgetting `normalizeParams(...)`
- adding a strategy file but forgetting to sync the generated manifest
- exposing a WFA/Finder param that execution later ignores or renames
- adding expensive per-bar allocations in Finder hot paths when a reusable precompute would do
- adding `prepareFinderData(...)` without keeping `executePrepared(...)` aligned with `execute(...)`
- adding a heavy rolling/VWAP/cross-symbol strategy without checking `npm run strategies:audit-prepared`
- handing `OHLCVData[]` to helpers that expect `number[]`
- indexing compound helper results incorrectly, such as reading `atrMinMax[i]!.min` instead of `atrMinMax.min[i]!`
