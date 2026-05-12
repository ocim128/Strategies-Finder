# Cross-Symbol Support

This document describes the current cross-symbol contract in the repo as of May 12, 2026.

Use it when you need to change cross-symbol behavior, add support to a new surface, or debug a run that depends on a secondary symbol.

For rollout history and the original implementation plan, see [`docs/cross-symbol-plan.md`](./cross-symbol-plan.md).

## Core Rules

- A strategy becomes cross-symbol by declaring `crossSymbolConfig` on the `Strategy`.
- The runtime resolves one secondary symbol per run from `backtestSettings.crossSymbolSecondary` or the strategy default.
- Strategies never fetch or align secondary data themselves.
- Supported runtimes must pass `StrategyExecutionContext` into `execute(...)`, `prepareFinderData(...)`, and `executePrepared(...)`.
- Unsupported runtimes must fail fast instead of silently dropping the secondary dependency.

## Source Of Truth

### Strategy contract

Defined in `lib/types/strategies.ts`.

Relevant types:

```ts
export interface CrossSymbolConfig {
    defaultSymbol: string;
    userSelectable?: boolean;
    minBars?: number;
}

export interface CrossSymbolRuntimeContext {
    primarySymbol: string;
    secondarySymbol: string;
    secondaryData: OHLCVData[];
    alignedLength: number;
    trimmedLeadingBars: number;
}

export interface StrategyExecutionContext {
    crossSymbol?: CrossSymbolRuntimeContext;
}
```

Important behavior:

- `userSelectable === false` means the UI shows the field but disables editing and uses `defaultSymbol`.
- `minBars` defaults to `50` when omitted.
- Strategies must tolerate `context === undefined` because the third argument is optional at the type level.

### Persisted setting

The one persisted override is `crossSymbolSecondary`.

Primary files:

- `lib/settings-model.ts`
- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/settings-manager.ts`
- `lib/rust-settings-sanitizer.ts`

Important behavior:

- Empty string means "use the strategy default".
- Stored UI settings are normalized to uppercase in `settings-model`.
- The DOM contract marks `crossSymbolSecondary` as both Rust-unsupported and worker-unsupported.

## Runtime Flow

The shared resolver lives in `lib/cross-symbol-runtime.ts`.

Supported callers should use:

- `resolveCrossSymbolExecution(...)`
- `resolveCrossSymbolExecutionSync(...)` when the secondary dataset is already fetched

Resolution steps:

1. Read `strategy.crossSymbolConfig`.
2. Resolve `crossSymbolSecondary ?? defaultSymbol`.
3. Reject `primary === secondary`.
4. Reject provider mismatch.
5. Fetch detached secondary data with the same interval.
6. Align secondary to primary with causal LOCF.
7. Trim the leading prefix where no secondary bar exists yet.
8. Reject when the remaining aligned length is below `minBars`.
9. Return trimmed primary data plus `context.crossSymbol`.

### Alignment guarantees

Implemented in `lib/strategies/lib/cross-symbol-helpers.ts`.

- `alignSecondaryToPrimary(...)` never looks forward.
- `trimAlignedPair(...)` returns equal-length primary and secondary arrays with no `null`s.
- `secondaryData[i]` corresponds to `data[i]` at the same bar index after trimming.
- `trimmedLeadingBars` records how much primary history was removed before the strategy saw the data.

### Backtest-window re-alignment

`lib/backtest-executor.ts` performs an additional slice after closed-candle trimming and block-range filtering so `context.crossSymbol.secondaryData` stays aligned with the exact bars used by the run.

Do not assume the first resolved pair from `cross-symbol-runtime.ts` is the final pair used by the backtest engine.

## Supported Surfaces

| Surface | Status | Notes |
|---|---|---|
| Manual backtest UI | Supported | `lib/backtest-service.ts` -> `lib/backtest-executor.ts` |
| Shared executor / endpoint parity path | Supported | `lib/backtest-executor.ts` accepts `crossSymbolInput` or a runtime fetcher |
| HTTP backtest endpoint | Supported | Request must include `crossSymbol.secondarySymbol` and `crossSymbol.dataset` |
| Preview Endpoint / Copy Endpoint | Supported | Secondary dataset is resolved from the latest UI snapshot and attached automatically |
| Finder single/random | Supported | `lib/finder/finder-runner-single.ts` resolves once per strategy key |
| Finder Symbol Universe | Supported | `lib/finder/finder-runner-universe.ts` passes the universe data loader into the shared executor |
| Finder genetic | Supported | `lib/finder/finder-runner-genetic.ts` resolves once per selected strategy |
| Finder Polymarket mode | Supported | `lib/finder/finder-runner-polymarket.ts` resolves once per base strategy plan |
| Walk Forward | Supported | `lib/walk-forward-service.ts` resolves once per run and threads the context through WFA helpers |
| Polymarket outcome evaluation | Supported | `lib/polymarket-outcome-evaluator.ts` accepts `executionContext` from the caller |

## Unsupported Or Guarded Surfaces

| Surface | Current behavior | Primary guard |
|---|---|---|
| Worker alerts / subscriptions | Not supported | `lib/alert-subscription-utils.ts` excludes cross-symbol strategies from worker support |
| Scanner | Skips cross-symbol strategies | `lib/scanner/scanner-engine.ts` |
| Portfolio Lab | Throws user-facing error | `lib/portfolio-lab-service.ts` |
| Strategy Ensemble Lab | Warns and skips strategy | `lib/strategy-ensemble-engine.ts` |
| Ensemble recipes | Throws user-facing error | `lib/ensemble-signal-recipes.ts` |
| Combined Strategy Backtest | Blocks both primary and secondary cross-symbol strategies | `lib/backtest-service.ts` |
| Polymarket bridge export | Not supported | `lib/polymarket-panel-service.ts` |

If you add support to one of these surfaces, do not bypass the guard first. Add full runtime resolution and context threading, then remove or narrow the guard.

## Strategy Timeframe Interaction

Cross-symbol strategies are incompatible with strategy-timeframe resampling.

Current enforcement:

- `lib/cross-symbol-runtime.ts` rejects `settings.strategyTimeframeEnabled`
- `strategyRegistry.ts` rejects registry-wrapped cross-symbol execution when the global strategy-timeframe wrapper is active
- `lib/backtest-executor.ts` assumes this combination was rejected before higher-timeframe signal generation

This is intentionally explicit. Do not silently ignore strategy timeframe for cross-symbol runs.

## UI Contract

Primary files:

- `html-partials/tab-settings-section-execution.html`
- `lib/cross-symbol-dom.ts`
- `lib/cross-symbol-ui.ts`

Structural ids:

- `crossSymbolRow`
- `crossSymbolSecondary`
- `crossSymbolDefault`

Behavior:

- The row is shown only when the selected strategy has `crossSymbolConfig`.
- The default label shows `crossSymbolConfig.defaultSymbol`.
- The field persists through the standard backtest-settings save/load path.
- Runtime validation rejects invalid cases such as `primary === secondary`; the UI does not fully prevent every bad input.

If you rename a structural id, update the HTML partial, `lib/cross-symbol-dom.ts`, and `tests/feature-dom-contracts.spec.ts` together.

## Endpoint And Parity Contract

Primary files:

- `lib/backtest-endpoint-plugin.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-service.ts`

Important behavior:

- Endpoint requests for a cross-symbol strategy must include `crossSymbol.secondarySymbol` and `crossSymbol.dataset`.
- The endpoint rejects omitted secondary datasets instead of refetching unrelated market data.
- `Preview Endpoint` and `Copy Endpoint` reuse the latest UI snapshot and attach the resolved secondary dataset automatically.
- `executeBacktest(...)` cross-checks the provided `crossSymbolInput.secondarySymbol` against the resolved `backtestSettings.crossSymbolSecondary` or default symbol and rejects mismatches.

If you change endpoint behavior, keep [`docs/backtest-endpoint.md`](./backtest-endpoint.md) in sync.

## Strategy Authoring Notes

The current built-in example is:

- `lib/strategies/lib/relative_strength_mean_reversion.ts`

Preferred helper file:

- `lib/strategies/lib/cross-symbol-helpers.ts`

Authoring rules:

- Read `context?.crossSymbol` instead of loading data yourself.
- Use the same context in `prepareFinderData(...)` and `executePrepared(...)` if the strategy supports those seams.
- Treat `secondaryData` as already aligned and trimmed.
- Keep `defaultParams` valid after `normalizeParams(...)`.
- Keep `metadata.walkForwardParams` aligned with the real execution params for WFA/Finder parity.

If you add a built-in cross-symbol strategy, still run `npm run strategies:sync-manifest`.

## High-Risk Failure Modes

- Dropping the third `context` argument in a wrapper or decorator around `strategy.execute(...)`.
- Passing `context` to `execute(...)` but forgetting `prepareFinderData(...)` or `executePrepared(...)`.
- Adding a new supported surface but calling the strategy directly on primary-only data.
- Carrying `crossSymbolSecondary` through UI persistence but forgetting the endpoint copy/preview path.
- Forgetting that the resolved primary data may be trimmed before the strategy sees it.
- Letting unsupported surfaces silently skip signals instead of rejecting clearly.
- Allowing strategy-timeframe resampling to continue on a cross-symbol strategy.
- Caching prepared data by strategy key only when the resolved secondary symbol can differ.

### Registry wrapper gotcha

If you wrap strategies centrally, always preserve `context`.

The current regression test for this is:

- `tests/strategy-registry-cross-symbol.spec.ts`

That test exists because a previous registry wrapper forwarded `(data, params)` but dropped `context`, which caused valid cross-symbol strategies to produce `0` signals in registry-backed/UI paths.

## Change Map

### If you change alignment semantics

Touch:

- `lib/strategies/lib/cross-symbol-helpers.ts`
- `lib/cross-symbol-runtime.ts`
- `tests/cross-symbol-helpers.spec.ts`
- `tests/cross-symbol-runtime.spec.ts`

### If you change runtime resolution or support a new execution surface

Touch:

- `lib/cross-symbol-runtime.ts`
- the caller for that surface
- `tests/cross-symbol-runtime.spec.ts`
- at least one integration test for that surface

Prefer one of two patterns only:

- support the surface fully by resolving cross-symbol data and threading `StrategyExecutionContext`
- guard the surface explicitly with a user-facing message

### If you change UI or settings behavior

Touch:

- `html-partials/tab-settings-section-execution.html`
- `lib/cross-symbol-dom.ts`
- `lib/cross-symbol-ui.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-resolver.ts`
- `lib/backtest-settings-dom-contract.ts`
- `tests/feature-dom-contracts.spec.ts`
- `tests/settings-compat.spec.ts`

### If you change endpoint parity behavior

Touch:

- `lib/backtest-endpoint-plugin.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-service.ts`
- `docs/backtest-endpoint.md`
- endpoint-related cross-symbol tests

### If you change worker support rules

Touch:

- `lib/alert-subscription-utils.ts`
- worker-side consumers if you truly add support
- `tests/worker-strategy-support.spec.ts`

## Validation

Useful commands:

- `npm run typecheck`
- `npm run test -- cross-symbol`
- `npm run test -- strategy-registry-cross-symbol`
- `npm run test -- backtest-endpoint`

Useful specs:

- `tests/cross-symbol-runtime.spec.ts`
- `tests/cross-symbol-helpers.spec.ts`
- `tests/strategy-registry-cross-symbol.spec.ts`
- `tests/settings-compat.spec.ts`
- `tests/worker-strategy-support.spec.ts`
- `tests/backtest-endpoint-copy.spec.ts`
- `tests/backtest-endpoint-execution.spec.ts`
- `tests/backtest-endpoint-plugin.spec.ts`

If you change structural UI ids, also run:

- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
