# Strategy Authoring

This guide is for adding or modifying built-in strategies under `lib/strategies/lib/*`.

For repo-level orientation, read [`README.md`](../README.md) first. For operational safety checks while editing code, use [`AGENTS.md`](../AGENTS.md).

## Core Contract

Finder, Walk Forward, the base UI, and the worker-facing library must all observe the same strategy semantics.

That means:
- the source file lives under `lib/strategies/lib/*.ts`
- the file contains exactly one `export const <strategy-key>: Strategy = ...`; the exported key is the registry identity
- a new strategy should normally keep its file name and exported key aligned, even though the generator uses the exported key and actual file name independently
- `npm run strategies:sync-manifest` regenerates `manifest.ts`, `manifest-eager.ts`, `manifest-meta.ts`, `manifest-summary.ts`, `manifest-loaders.ts`, and `manifest-keys.ts`
- built-in runtime discovery uses the generated catalog; do not manually wire a built-in into a separate registry
- `normalizeParams(...)` exposes the same canonical parameter semantics that `execute(...)` actually uses

If a strategy silently clamps, rounds, or flips a parameter inside `execute(...)` but does not expose that through `normalizeParams(...)`, the UI and optimization layers drift.

## Build Order

1. Pick a stable key and keep the file name and exported const aligned with that key.
2. Start from a nearby example:
   - `lib/strategies/lib/close_location_median_alignment.ts` for a small direct `execute(...)` pattern
   - `lib/strategies/lib/rolling_vwap_center.ts` for normalized thresholds and Finder precompute
   - `lib/strategies/lib/cross-symbol-helpers.ts` for cross-symbol alignment helpers
   - `lib/strategies/lib/polymarket-1s-helpers.ts` for supported 1s Polymarket context
3. Write the raw signal idea first with `ensureCleanData(...)` and `createSignalLoop(...)`.
4. Add a named parameter normalizer before wiring `metadata.walkForwardParams`.
5. Run `npm run strategies:sync-manifest`; do not manually edit the generated manifest files.
6. Add `prepareFinderData(...)` when dataset-derived precomputation materially reduces repeated Finder work. This is useful for expensive rolling, VWAP, percentile, entropy, skewness, or cross-symbol state, but is unnecessary for cheap one-pass logic.

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

## Causal Signal Rules

Signal generation must be non-repainting:

- At bar index `i`, entry logic may read only the completed current bar and `data[0..i]`.
- Rolling windows must be trailing. Do not use centered windows, future-confirmed pivots, swing points, fractals, or future labels.
- A current-bar calculation is allowed when it uses only the current and previous bars. A signal generated at `i` may be filled later according to the selected execution model; the later fill must not influence signal creation.
- Do not use `data[data.length - 1]`, full-series statistics that include future observations, or later trade outcomes inside `execute(...)`.
- `normalizeParams(...)` must depend only on the parameter object, not on the dataset.
- When a helper offers an inclusive/current-bar option, use the prior-only form for breakout boundaries when including the current value would make the comparison tautological.

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
  Candle geometry helpers plus microstructure-oriented primitives such as close acceptance and initiative pressure.
- `lib/strategies/lib/price-action-statistics-core.ts`
  Rolling entropy, efficiency ratio, rolling medians, standard and robust z-scores, percentile ranks, and streak counters.
- `lib/strategies/lib/polymarket-1s-helpers.ts`
  For supported 1s Polymarket strategies only. Declare `polymarket1sConfig: { required: true }`, use causal runtime context, and fail closed when helper frames are unavailable. Executable-edge strategies should prefer ask-side edge plus actionability/persistence over mid-price-only pressure.

## Type Rules That Matter

- Match array shapes carefully.
  `buildRollingZScore(...)` and `buildRollingRobustZScore(...)` expect `number[]`, while helpers like `buildEfficiencyRatio(...)` intentionally work from `OHLCVData[]`.
  `buildRollingRobustZScore(...)` uses trailing median/MAD normalization and returns `null` during warm-up or when the rolling MAD is zero.
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
- Use prepared execution for heavy repeated calculations when it reduces Finder cost; keep direct `execute(...)` as the canonical fallback path.
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

There is no current built-in cross-symbol strategy example in the manifest.
Use `tests/strategies-lib/prepared-execution-parity.spec.ts` with
`lib/strategies/lib/cross-symbol-helpers.ts` when validating a new one. See
[cross-symbol.md](cross-symbol.md) for the full runtime support matrix.

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
- do not use raw volume as tradable flow; synthetic volume is a constructed `min(base.volume, quote.volume)` proxy and does not identify either leg's liquidity
- treat high/low range as the range of the derived ratio; it may reflect movement in either leg and is not a direct measurement of leg disagreement or either leg's volatility

See [synthetic-pairs.md](synthetic-pairs.md) for generation and support details.

## Checklist Before You Stop

- file exists in `lib/strategies/lib/*`
- exported const name is the strategy key
- `defaultParams` keys match `paramLabels` keys
- `defaultParams` are valid after `normalizeParams`
- `metadata.walkForwardParams` references only real params
- `execute(...)` uses normalized params when behavior depends on normalized values
- `npm run strategies:sync-manifest` was run
- `npm run strategies:audit-prepared` was run when adding or changing a prepared-execution path, or when a heavy repeated calculation needs parity/performance review
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
