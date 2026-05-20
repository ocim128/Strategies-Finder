# Strategy Implementation Guide for AI Agents

This guide is for turning a strategy idea into a valid built-in strategy under `lib/strategies/lib/*`.

If the idea came from an archive prompt, treat it as idea-generation input only. It does not guarantee a compilable implementation. Before writing code, confirm every helper, indicator, duplicate-avoidance assumption, and type assumption against the real codebase.

For repo-level orientation, read [`README.md`](../README.md) first. For the operational checklist, use [`AGENTS.md`](../AGENTS.md). For the higher-level authoring workflow, use [`strategy-authoring.md`](./strategy-authoring.md).

## Non-Negotiable Contracts

- Built-in strategies live in `lib/strategies/lib/<strategy-key>.ts`.
- The exported `const` should match the strategy key.
- Built-ins are loaded from generated metadata/loaders/eager manifests. Do not manually wire `strategyRegistry.ts`.
- After adding or renaming a built-in strategy, run `npm run strategies:sync-manifest`.
- Entry logic must be causal and non-repainting. Bar `i` may only use information available in `data[0..i]`.
- If `execute(...)` rounds, clamps, coerces sign, or otherwise sanitizes params, expose the same behavior through `normalizeParams(...)`.
- If you add `prepareFinderData(...)`, `executePrepared(...)` must stay behaviorally identical to `execute(...)`.

## Build Order

1. Pick a stable key and keep the file name and exported const aligned.
2. Start from a nearby example:
   - `lib/strategies/lib/robust_median_channel_breakout.ts` — small strategy with explicit normalization and direct `execute(...)` use
   - `lib/strategies/lib/rolling_vwap_center.ts` — Finder-safe prepared-data reuse with normalized params
   - for value-area work:
     - `lib/strategies/lib/value_area_excess_snapback.ts`
     - `lib/strategies/lib/value_rotation_divergence_fade.ts`
   - for cross-symbol work:
     - `lib/strategies/lib/relative_strength_mean_reversion.ts`
     - `lib/strategies/lib/dominance_handoff_exhaustion.ts`
     - `lib/strategies/lib/correlation_range_fragmentation.ts`
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
  Core signal creation, data extraction, pivot flags, and clean-data guards.
- `lib/strategies/lib/price-action-frequency-core.ts`
  Candle geometry and microstructure primitives such as:
  - `buildRangeSeries(...)`
  - `buildBodyPctSeries(...)`
  - `buildCloseLocationSeries(...)`
  - `buildCloseAcceptanceSeries(...)`
  - `buildInitiativePressureSeries(...)`
- `lib/strategies/lib/price-action-statistics-core.ts`
  Rolling and regime helpers such as:
  - `buildRollingMedian(...)`
  - `buildRollingZScore(...)`
  - `buildRollingEntropy(...)`
  - `buildEfficiencyRatio(...)`
  - `buildStreakCount(...)`
- `lib/strategies/lib/value-area-acceptance-core.ts`
  Market-Profile-inspired distribution primitives using only OHLCV data:
  - `buildRollingValueArea(data, lookback, coveragePct?, numBins?)` — returns `{ vah, val, poc }` as `NullableSeries`. TPO-histogram VA boundaries and Point of Control.
  - `buildValueAreaAcceptanceRate(closes, vah, val, acceptLookback)` — fraction of recent bars inside [VAL, VAH].
  - `buildValueAreaWidth(vah, val, closes)` — `(VAH - VAL) / close`, normalized compression gauge.
  - `buildValueAreaMigrationRate(poc, closes, period)` — normalized POC drift rate.
  - `buildPricePositionInVA(closes, vah, val, poc)` — distribution-relative position: 0 = POC, ±1 = VA boundary, beyond = excess.
  - `buildValueAreaRotation(vah, val, closes, period)` — returns `{ shift, spread }`: boundary migration direction and expansion/contraction.
  - Finder precompute: `prepareValueAreaData(data)`, `getPreparedValueAreaData(prepared, data)`, `getValueAreaSeries(prepared, lookback, coveragePct?, numBins?)`.
- `lib/strategies/lib/range-conviction-core.ts`
  Shared ATR/range precompute for Finder hot loops:
  - `prepareRangeConvictionData(data)` — one-time shared array build.
  - `getPreparedRangeConvictionData(prepared, data)` — type-guard accessor.
  - `getAtrSeries(prepared, period)` — memoized ATR by period.
  - `normalizeIntegerParam(value, fallback, min, max?)` and `normalizeNumberParam(value, fallback, min, max?)` — param clamping utilities reusable by any strategy.

- `lib/strategies/lib/polymarket-1s-helpers.ts`
  Supported 1s Polymarket helper surface for Binance-chart strategies scored against Polymarket CLOB quotes:
  - `buildPolymarket1sPressureGap(data, context, { volLookback })`
  - `buildPolymarket1sExecutableEdge(data, context, { volLookback })`
  - `buildPolymarket1sActionabilityMask(data, context, { volLookback })`
  - `buildPolymarket1sEdgePersistence(edgeFrame, { minEdge, ewmaLookback })`
  - `buildPolymarket1sReactionGap(data, context, { volLookback, lagSec })`
  - `buildPolymarket1sGammaAgreement(data, context, { volLookback })`

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
- `buildRollingCorrelation(...)` expects paired `number[]` inputs.
- `buildRollingValueArea(...)` expects `OHLCVData[]` (uses closes/highs/lows internally).
- `buildValueAreaAcceptanceRate(...)` expects `number[]` closes and `NullableSeries` for vah/val.
- `buildPricePositionInVA(...)` expects `number[]` closes and `NullableSeries` for vah/val/poc.

### Output shape matters

- `calculateATR(...)` and `calculateADX(...)` return flat arrays.
- `calculateKeltnerChannels(...)` returns `{ upper, middle, lower }`.

### Access compound helper results correctly

Correct:

```ts
const channel = calculateKeltnerChannels(highs, lows, closes, emaPeriod, atrPeriod, multiplier);
const upper = channel.upper[i];
const lower = channel.lower[i];
```

Wrong:

```ts
const upper = channel[i].upper;
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

If you use `buildPivotFlags(...)`, be explicit about confirmation timing. The helper evaluates a centered window, so a pivot flag at index `i` is only causal after the right-side swing window has elapsed.

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
- value-area series keyed by `(lookback, bins, coverage)` — use `prepareValueAreaData(data)` and `getValueAreaSeries(prepared, lookback, coveragePct?, numBins?)` to memoize VA across param sweeps
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

## 1s Polymarket Strategies

Use this path only for strategies that run on supported 1s crypto charts and require second-market CLOB context.

Required strategy contract:

- declare `polymarket1sConfig: { required: true }`
- accept the optional third `StrategyExecutionContext` argument in `execute(...)`
- return `[]` when `context?.polymarket1s` is missing
- call helpers with the runtime context, not with raw quote arrays
- fail closed when a helper frame has `available === false`
- keep Binance chart state as the raw signal source; Polymarket helpers may allow, veto, rank, or executable-price that signal

Executable-edge pattern:

```ts
const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback });
if (!edge.available) return [];

const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
  volLookback,
  minEventProgress: 0.02,
  maxEventProgress: 0.96,
  minSecondsRemaining: 8,
});
if (!actionability.available) return [];

const persistence = buildPolymarket1sEdgePersistence(edge, {
  minEdge,
  ewmaLookback: persistenceSec,
});
```

Current helper meanings that matter for implementation:

- `buyYesEdge = fairYesProbability - yesAskProbability`
- `buyNoEdge = fairNoProbability - noAskProbability`
- `yesActionable` / `noActionable` mean the side has a usable ask quote inside quote-age and event-timing constraints
- `reactionGap` compares recent Binance-implied probability movement against recent Polymarket mid-probability movement
- Gamma helpers are agreement only, never the primary signal

Do not add spread-based behavior to 1s Polymarket strategies:

- no `maxSpread` params
- no `yesSpread` / `noSpread` fields
- no "trade when spread is tight" logic
- no strategy thesis that treats raw YES/NO price or spread as alpha

When adding a 1s Polymarket built-in, update or add focused tests for:

- missing context returns `[]`
- missing side ask fails only that side
- helper unavailability returns `[]`
- parameter normalization matches Finder and Walk Forward metadata
- manifest sync removes stale params from generated metadata

## Cross-Symbol Strategies

A strategy may use a secondary symbol as causal context, such as relative strength, pair spread, rolling correlation, or relative volume transfer. The runtime provides aligned secondary data - strategies never fetch or align data themselves.

Current support:

- supported: manual backtest, endpoint preview/copy, Finder, Walk Forward, and Polymarket evaluation
- guarded elsewhere: worker alerts, Scanner, Portfolio Lab, Strategy Ensemble Lab, combined backtest, and Polymarket bridge export

Useful real examples:

- `lib/strategies/lib/relative_strength_mean_reversion.ts`
- `lib/strategies/lib/dominance_handoff_exhaustion.ts`
- `lib/strategies/lib/correlation_range_fragmentation.ts`

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
- `buildRollingPairCorrelation(primaryCloses, secondaryCloses, lookback)` - rolling Pearson

### Constraints

1. Never fetch secondary data inside `execute(...)`. The runtime does it for you.
2. `secondaryData` is already aligned via causal LOCF and trimmed - no nulls.
3. v1 cross-symbol strategies cannot use strategy-timeframe resampling.
4. The `prepareFinderData(...)` and `executePrepared(...)` methods receive the same context as `execute(...)`.
5. Walk-Forward Analysis is supported, but it runs through the TypeScript cross-symbol path rather than a Rust-native cross-symbol engine.
6. Endpoint parity paths also support cross-symbol execution, but they only stay correct if the resolved secondary dataset is carried through snapshot and request builders.
7. If a wrapper, decorator, or registry path calls `strategy.execute(...)`, it must preserve the third `context` argument or the strategy may silently produce zero signals.
8. If you need the current support matrix, endpoint parity rules, or maintenance gotchas, see [`docs/cross-symbol.md`](./cross-symbol.md).
