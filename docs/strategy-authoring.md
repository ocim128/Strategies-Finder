# Strategy Authoring

This guide is for adding or modifying built-in strategies under `lib/strategies/lib/*`.

For repo-level orientation, read [`README.md`](../README.md) first. For operational safety checks while editing code, use [`AGENTS.md`](../AGENTS.md).

## Core Contract

Finder, Walk Forward, the base UI, and the worker-facing library must all observe the same strategy semantics.

That means:
- the file lives in `lib/strategies/lib/<strategy-key>.ts`
- the exported const is the strategy key
- `lib/strategies/manifest.ts` is regenerated from the strategy files
- `normalizeParams(...)` exposes the same canonical parameter semantics that `execute(...)` actually uses

If a strategy silently clamps, rounds, or flips a parameter inside `execute(...)` but does not expose that through `normalizeParams(...)`, the UI and optimization layers drift.

## Build Order

1. Pick a stable key and keep the file name and exported const aligned with that key.
2. Start from a nearby example:
   - `lib/strategies/lib/median_deviation_streak.ts` for a simple pattern
   - `lib/strategies/lib/vwap_zscore_reversion.ts` for normalized thresholds and Finder precompute
3. Write the raw signal idea first with `ensureCleanData(...)` and `createSignalLoop(...)`.
4. Add a named parameter normalizer before wiring `metadata.walkForwardParams`.
5. Run `npm run strategies:sync-manifest`.
6. Add `prepareFinderData(...)` only if dataset-derived precompute materially reduces Finder cost.

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
  Rolling entropy, efficiency ratio, rolling medians, z-scores, kurtosis, min/max bands, and streak counters.

## Type Rules That Matter

- Match array shapes carefully.
  `buildRollingZScore(...)` expects `number[]`, while some helpers like `buildEfficiencyRatio(...)` intentionally work from `OHLCVData[]`.
- Guard padded indicator arrays.
  Use checks like `if (i < lookback || indicator[i] === null) return null;`.
- Track indicator output shape precisely.
  `calculateATR()` and `calculateADX()` return arrays; `calculateMACD()` and `calculateKeltnerChannels()` return objects containing arrays.

## Finder / Walk Forward Rules

- `defaultParams` must already be valid after normalization.
- Every optimized param must exist in:
  - `defaultParams`
  - `paramLabels`
  - `metadata.walkForwardParams`
  - the execution logic
- If you add `prepareFinderData(...)`, keep `executePrepared(...)` behavior identical to `execute(...)`.
- Do not add Finder precompute to cheap strategies just for symmetry.

## Checklist Before You Stop

- file exists in `lib/strategies/lib/*`
- exported const name is the strategy key
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are valid after `normalizeParams`
- `metadata.walkForwardParams` references only real params
- `execute(...)` uses normalized params when behavior depends on normalized values
- `npm run strategies:sync-manifest` was run
- `npm run typecheck` passes
- `strategies.spec.ts` or a focused strategy spec was added/updated if behavior is non-trivial
- the strategy appears in the UI dropdown

## Common Mistakes

- sanitizing params inside `execute(...)` but forgetting `normalizeParams(...)`
- adding a strategy file but forgetting to sync the generated manifest
- exposing a WFA/Finder param that execution later ignores or renames
- adding expensive per-bar allocations in Finder hot paths when a reusable precompute would do
- adding `prepareFinderData(...)` without keeping `executePrepared(...)` aligned with `execute(...)`
- handing `OHLCVData[]` to helpers that expect `number[]`
- indexing compound helper results incorrectly, such as reading `atrMinMax[i]!.min` instead of `atrMinMax.min[i]!`
