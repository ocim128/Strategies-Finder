# Strategy Implementation Guide for AI Agents

This guide is for turning a strategy idea into a valid built-in strategy under `lib/strategies/lib/*`.

If the idea came from an archive prompt, treat it as idea-generation input only. It does not guarantee a compilable implementation. Before writing code, confirm every helper, indicator, duplicate-avoidance assumption, and type assumption against the real codebase.

For repo-level orientation, read [`README.md`](../README.md) first. For the operational checklist, use [`AGENTS.md`](../AGENTS.md). For the higher-level authoring workflow, use [`strategy-authoring.md`](./strategy-authoring.md).

## Non-Negotiable Contracts

- Built-in strategies live in `lib/strategies/lib/<strategy-key>.ts`.
- The exported `const` should match the strategy key.
- Built-ins are loaded from the generated manifest. Do not manually wire `strategyRegistry.ts`.
- After adding or renaming a built-in strategy, run `npm run strategies:sync-manifest`.
- Entry logic must be causal and non-repainting. Bar `i` may only use information available in `data[0..i]`.
- If `execute(...)` rounds, clamps, coerces sign, or otherwise sanitizes params, expose the same behavior through `normalizeParams(...)`.
- If you add `prepareFinderData(...)`, `executePrepared(...)` must stay behaviorally identical to `execute(...)`.

## Build Order

1. Pick a stable key and keep the file name and exported const aligned.
2. Start from a nearby example:
   - `lib/strategies/lib/median_deviation_streak.ts`
   - `lib/strategies/lib/vwap_zscore_reversion.ts`
   - for cross-symbol work:
     - `lib/strategies/lib/relative_strength_mean_reversion.ts`
     - `lib/strategies/lib/pair_spread_efficiency_break.ts`
     - `lib/strategies/lib/correlation_volume_fragility.ts`
3. Write `normalizeParams(...)` first if params need any coercion.
4. Clean the dataset with `ensureCleanData(...)`.
5. Build your base arrays once outside the signal loop.
6. Use `createSignalLoop(...)` and return `createBuySignal(...)`, `createSellSignal(...)`, or `null`.
7. Add `metadata.walkForwardParams` only for params that genuinely affect entries.
8. Run `npm run strategies:sync-manifest` and `npm run typecheck`.

## Using Prompt JSON

When a prompt returns a strategy idea as JSON, translate it into code deliberately instead of copying fields straight into a file.

- `key` -> file name and exported `const` name. Keep them aligned.
- `name` -> strategy `name`.
- `core_thesis` -> short `description`, then trim it to one implementation-focused sentence if needed.
- `helpers` and `indicators` -> candidate imports only. Verify each one exists and that the data shape matches your usage before writing code.
- `params` -> `defaultParams`, `paramLabels`, and usually `metadata.walkForwardParams`. Reject decorative params that do not materially change entries.
- `buy_logic` and `sell_logic` -> the causal conditions inside `createSignalLoop(...)`.
- `closest_existing_keys` -> review-only duplicate check. Do not copy it into the strategy object.
- `why_test_this` -> review-only note for PR or test planning, not runtime code.

Collapse or reject the idea before coding if:

- the JSON depends on a helper or indicator that does not exist
- the same thesis can be expressed with fewer params or fewer transforms
- `buy_logic` and `sell_logic` are not truly symmetric
- the edge disappears once you remove decorative filters

## Minimal Template

```ts
import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
} from "../strategy-helpers";
import {
  buildCloseAcceptanceSeries,
  buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeMyStrategyParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    threshold: Math.max(0, Number(params.threshold ?? 0.4)),
  };
}

export const my_strategy_key: Strategy = {
  name: "My Strategy Name",
  description: "One-line thesis.",
  defaultParams: {
    lookback: 20,
    threshold: 0.4,
  },
  paramLabels: {
    lookback: "Lookback",
    threshold: "Threshold",
  },
  normalizeParams: normalizeMyStrategyParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeMyStrategyParams(params);
    if (cleanData.length < p.lookback) return [];

    const acceptance = buildCloseAcceptanceSeries(cleanData);
    const smoothed = buildRollingAverage(acceptance, p.lookback);

    return createSignalLoop(cleanData, [smoothed], (i) => {
      if (i < p.lookback) return null;
      const score = smoothed[i];
      if (score === null) return null;

      if (score > p.threshold) {
        return createBuySignal(cleanData, i, "Acceptance turns strongly positive");
      }
      if (score < -p.threshold) {
        return createSellSignal(cleanData, i, "Acceptance turns strongly negative");
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

## Signal Loop Rules

`createSignalLoop(...)` is the required execution pattern for most built-in entry strategies.

Correct:

```ts
return createSignalLoop(cleanData, [indicatorA, indicatorB], (i) => {
  if (bullish) return createBuySignal(cleanData, i, "reason_buy");
  if (bearish) return createSellSignal(cleanData, i, "reason_sell");
  return null;
});
```

Wrong:

```ts
return createSignalLoop(cleanData, [], (i) => {
  if (bullish) return 1;
  if (bearish) return -1;
  return 0;
});
```

Rules that matter:
- Return `Signal | null | undefined`, not numeric flags.
- Use `null`, not `0`, when no entry triggers.
- `createSignalLoop(...)` only guards the indicator arrays you pass into it. If you access extra arrays or object members inside the callback, guard those yourself.
- Keep reason strings stable and descriptive. They become part of downstream debugging.

## Helper Surface You Should Prefer

Before reaching for a named indicator, check whether a shared strategy-layer helper already expresses the idea more directly.

- `lib/strategies/strategy-helpers.ts`
  Core signal creation, data extraction, pivot detection, and clean-data guards.
- `lib/strategies/lib/price-action-frequency-core.ts`
  Candle geometry and microstructure primitives such as:
  - `buildRangeSeries(...)`
  - `buildBodySeries(...)`
  - `buildCloseLocationSeries(...)`
  - `buildCloseAcceptanceSeries(...)`
  - `buildInitiativePressureSeries(...)`
  - `buildSweepReclaimSeries(...)`
- `lib/strategies/lib/price-action-statistics-core.ts`
  Rolling and regime helpers such as:
  - `buildRollingMedian(...)`
  - `buildRollingZScore(...)`
  - `buildRollingEntropy(...)`
  - `buildRollingKurtosis(...)`
  - `buildEfficiencyRatio(...)`
  - `buildRollingMinMax(...)`
  - `buildStreakCount(...)`

If a prompt or draft strategy references a helper that does not exist in these modules or `strategy-helpers.ts`, do not invent the import path and hope it works. Either map the idea onto existing helpers or add the missing helper first.

## Type Rules That Cause Most Failures

### Array shape matters

- Many helpers return `number[]`.
- Many indicators and rolling helpers return `(number | null)[]`.
- Some indicators return objects containing arrays.

Do not assign `(number | null)[]` to `number[]`.

### Input type matters

- `buildRollingZScore(...)` expects `number[]`.
- `buildEfficiencyRatio(...)` expects `OHLCVData[]`.
- `buildTrailingHighLow(...)` expects `OHLCVData[]`.
- `buildRollingMinMax(...)` expects `number[]`.

### Output shape matters

- `calculateATR(...)` and `calculateADX(...)` return flat arrays.
- `calculateMACD(...)` returns `{ macd, signal, histogram }`.
- `calculateKeltnerChannels(...)` returns `{ upper, middle, lower }`.
- `calculateDonchianChannels(...)` returns `{ upper, lower, middle }`.
- `calculateSupertrend(...)` returns `{ supertrend, direction }`.
- `calculateVolumeProfile(...)` returns `{ poc, vah, val }`.

### Access compound helper results correctly

Correct:

```ts
const bands = buildRollingMinMax(values, lookback);
const upper = bands.max[i];
const lower = bands.min[i];
```

Wrong:

```ts
const upper = bands[i].max;
```

### Guard nulls and warmup periods explicitly

```ts
if (i < lookback) return null;
const z = zscore[i];
if (z === null) return null;
```

## Causality and Repainting Rules

Do not introduce hidden look-ahead.

- Safe: current bar values, prior bar values, trailing windows ending at `i`, previously confirmed pivots.
- Unsafe unless carefully confirmed: centered windows, future bars, pivot logic that treats an unconfirmed swing as already known.

If you use `detectPivots(...)` or `detectPivotsWithDeviation(...)`, be explicit about confirmation timing. A pivot candidate is not automatically a causal signal source unless the confirmation point is already known at the decision bar.

## Parameter Normalization and Finder / WFA Parity

If execution changes parameter meaning, the rest of the engine must see the same canonical meaning.

Use `normalizeParams(...)` when you:
- round integer-like periods
- clamp thresholds
- force positive-only params
- snap to a grid
- coerce signs or absolute values

Required parity rules:
- `defaultParams` must already be valid after normalization.
- Every optimized param must exist in:
  - `defaultParams`
  - `paramLabels`
  - `metadata.walkForwardParams`
  - the execution logic
- If you sanitize a param inside `execute(...)` but not in `normalizeParams(...)`, Finder and Walk Forward will optimize a different strategy than the UI is showing.

## `prepareFinderData(...)` Guidance

Use `prepareFinderData(...)` by default when the strategy builds reusable rolling, VWAP, percentile, entropy, skewness, or cross-symbol arrays. Skip it only when execution is already cheap enough that the extra seam would not reduce Finder cost.

Good candidates:
- session VWAP arrays
- distance series reused across many param combinations
- cached rolling transforms keyed by lookback
- cross-symbol ratio, spread, or rolling-correlation series reused across many candidate evaluations

Bad candidates:
- cheap one-pass arrays that are already trivial
- precompute added only for symmetry

When you do add prepared execution:
- keep `executePrepared(...)` behavior identical to `execute(...)`
- validate prepared payload shape defensively
- cache by real param dimension when multiple lookbacks are possible
- keep the prepared payload small; store raw reusable series plus keyed caches instead of per-run duplicates
- run `npm run strategies:audit-prepared` when the file uses heavy rolling helpers or cross-symbol state

## Common AI Failure Modes

- inventing a helper or import path that does not exist
- manually editing registry wiring instead of syncing the manifest
- returning `1`, `-1`, or `0` instead of `Signal` objects and `null`
- using mismatched param keys across `defaultParams`, `paramLabels`, and logic
- sanitizing params inside `execute(...)` only
- forgetting null checks on padded arrays
- passing `OHLCVData[]` to a helper that expects `number[]`
- accessing compound helper results with the wrong shape
- adding expensive per-bar allocations inside Finder hot loops
- changing semantics in `executePrepared(...)` versus `execute(...)`
- using unconfirmed pivots or future bars in a supposedly causal signal

## Validation Before You Stop

Run from the repo root for this playground:

```bash
npm run strategies:sync-manifest
npm run typecheck
```

Then add focused validation as needed:

- add or update a strategy spec under `tests/strategies-lib/*` when normalization or behavior is non-trivial
- use `npm run test -- <relevant-fragment>` for targeted coverage
- for cross-symbol strategy work, include `npm run test -- cross-symbol`
- manually confirm the strategy appears in the dropdown if UI behavior changed

## Fast Checklist

- file exists in `lib/strategies/lib/*`
- exported const matches the strategy key
- imports come from real repo modules
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are already valid after normalization
- `metadata.walkForwardParams` references only real params
- `execute(...)` is causal and non-repainting
- signal loop returns `createBuySignal(...)`, `createSellSignal(...)`, or `null`
- null and warmup handling is explicit
- `prepareFinderData(...)` and `executePrepared(...)` remain in parity when present
- `npm run strategies:sync-manifest` was run
- `npm run typecheck` passes

## Cross-Symbol Strategies

A strategy may use a secondary symbol as causal context, such as relative strength, pair spread, rolling correlation, or relative volume transfer. The runtime provides aligned secondary data - strategies never fetch or align data themselves.

Current support:

- supported: manual backtest, endpoint preview/copy, Finder, Walk Forward, and Polymarket evaluation
- guarded elsewhere: worker alerts, Scanner, Portfolio Lab, Strategy Ensemble Lab, combined backtest, and Polymarket bridge export

Useful real examples:

- `lib/strategies/lib/relative_strength_mean_reversion.ts`
- `lib/strategies/lib/pair_spread_efficiency_break.ts`
- `lib/strategies/lib/correlation_volume_fragility.ts`

### Prompt workflow

Use `archive/prompt-cs.txt` when you want AI-generated cross-symbol ideas.

The current prompt contract assumes:

- every generated idea is truly cross-symbol, not a single-symbol idea with an optional confirmation input
- every generated idea names a `default_secondary_symbol`
- every generated idea uses at least one helper from `lib/strategies/lib/cross-symbol-helpers.ts`
- the first listed helper is the dominant cross-symbol helper, not a decorative extra

Translate prompt output into code like this:

- `default_secondary_symbol` -> `crossSymbolConfig.defaultSymbol`
- the cross-symbol helper listed in the idea -> import from `lib/strategies/lib/cross-symbol-helpers.ts`
- `secondary_role` and `core_thesis` -> strategy description and implementation comments if needed

Reject the generated idea before coding if:

- the thesis still works after removing the secondary series
- the cross-symbol helper is only confirmatory and not central
- it collapses into raw ratio-z-score or spread-z-score mean reversion without a distinct state transition
- it references helpers or indicators that do not actually exist in the repo

### Declaring the dependency

Add `crossSymbolConfig` to the strategy object:

```ts
import type { Strategy, OHLCVData, StrategyParams, StrategyExecutionContext } from "../../types/strategies";

export const my_cross_symbol_strategy: Strategy = {
  name: "My Cross-Symbol Strategy",
  description: "Example entry logic using primary vs secondary context.",
  crossSymbolConfig: {
    defaultSymbol: "ETHUSDT",
    userSelectable: true,
    minBars: 50,
  },
  // ...
};
```

### Accessing secondary data

The third argument to `execute(...)` is an optional `StrategyExecutionContext`:

```ts
execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
  if (!context?.crossSymbol) return []; // or handle gracefully

  const { secondaryData, secondarySymbol } = context.crossSymbol;
  // secondaryData.length === data.length (already aligned + trimmed)
  // secondaryData[i] corresponds to data[i] at the same time index
};
```

The same `context` must be threaded through `prepareFinderData(...)` and `executePrepared(...)` if the strategy uses those seams. Do not keep parity in `execute(...)` only.

### Available helpers

Import from `lib/strategies/lib/cross-symbol-helpers.ts`:

- `buildRelativeStrength(primaryCloses, secondaryCloses)` - ratio series
- `buildPairSpread(primaryCloses, secondaryCloses)` - difference series
- `buildRollingPairCorrelation(primaryCloses, secondaryCloses, lookback)` - rolling Pearson
- `buildRelativeVolumeStrength(primaryVolumes, secondaryVolumes, lookback)` - relative volume

### Constraints

1. Never fetch secondary data inside `execute(...)`. The runtime does it for you.
2. `secondaryData` is already aligned via causal LOCF and trimmed - no nulls.
3. v1 cross-symbol strategies cannot use strategy-timeframe resampling.
4. The `prepareFinderData(...)` and `executePrepared(...)` methods receive the same context as `execute(...)`.
5. Walk-Forward Analysis is supported, but it runs through the TypeScript cross-symbol path rather than a Rust-native cross-symbol engine.
6. Endpoint parity paths also support cross-symbol execution, but they only stay correct if the resolved secondary dataset is carried through snapshot and request builders.
7. If a wrapper, decorator, or registry path calls `strategy.execute(...)`, it must preserve the third `context` argument or the strategy may silently produce zero signals.
8. If you need the current support matrix, endpoint parity rules, or maintenance gotchas, see [`docs/cross-symbol.md`](./cross-symbol.md).
