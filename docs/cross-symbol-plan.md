# Cross-Symbol Strategy Surface Plan

## Goal

Allow a strategy to use one secondary symbol as causal context for the primary chart, while keeping single-symbol strategies unchanged and avoiding silent behavior drift across the rest of the app.

The first version must work for:

- normal backtest runs
- Polymarket performance evaluation
- Finder
- Walk Forward

The first version must not silently "sort of work" in other surfaces. Unsupported surfaces need explicit guards.

## Design Corrections

### 1. Use execution context, not a second execution API

Do not add parallel strategy methods like `executeCrossSymbol()` and `prepareCrossSymbolFinderData()`.

That doubles the strategy surface, forces every caller to branch on method selection, and creates the same problem again later for `indicators`, `entryPreview`, and any future execution surface.

Use one strategy contract with an optional runtime context:

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

export interface Strategy {
  name: string;
  description: string;
  defaultParams: StrategyParams;
  paramLabels: { [key: string]: string };
  normalizeParams?: (params: StrategyParams) => StrategyParams;
  crossSymbolConfig?: CrossSymbolConfig;
  execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => Signal[];
  prepareFinderData?: (data: OHLCVData[], settings?: BacktestSettings, context?: StrategyExecutionContext) => unknown;
  executePrepared?: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => Signal[];
}
```

Why this is better:

- existing strategies keep compiling because they can ignore the optional third or fourth arg
- every runtime keeps calling the same methods
- future extensions can reuse the same context pattern

### 2. Persist one resolved secondary symbol, not a per-strategy map inside engine settings

Do not put `crossSymbolOverrides: Record<string, string>` into `BacktestSettings`.

That is the wrong level of abstraction for this repo because:

- saved strategy configs store one strategy, not a whole strategy map
- endpoint snapshots copy one run, not a strategy registry
- alert/export payloads should carry one resolved choice, not unrelated overrides

Use:

```ts
crossSymbolSecondary?: string;
```

inside `BacktestSettings` and `BacktestSettingsData`.

If you later want "sticky per-strategy UI memory", keep that as a separate app-level convenience layer, not as part of the engine contract.

### 3. Resolve cross-symbol inputs in one shared runtime helper

Create one shared resolver instead of repeating fetch/align/trim logic in many files.

Suggested file:

- `lib/cross-symbol-runtime.ts`

Suggested shape:

```ts
export interface ResolvedCrossSymbolExecution {
  primaryData: OHLCVData[];
  context?: StrategyExecutionContext;
}

export async function resolveCrossSymbolExecution(args: {
  strategy: Strategy;
  primarySymbol: string;
  interval: string;
  primaryData: OHLCVData[];
  settings: BacktestSettings;
}): Promise<ResolvedCrossSymbolExecution>
```

This helper should:

1. read `strategy.crossSymbolConfig`
2. resolve `crossSymbolSecondary ?? defaultSymbol`
3. reject `primary === secondary`
4. reject provider mismatch via `dataManager.getProvider(...)`
5. fetch secondary bars with the same interval
6. align secondary to primary by causal LOCF
7. trim leading bars until both arrays are fully populated
8. reject when aligned length is below `minBars`
9. return the trimmed primary plus `context.crossSymbol.secondaryData`

Every supported runtime should go through this helper.

### 4. Reject unsupported combinations explicitly

Do not silently ignore incompatible settings.

In v1:

- `strategyTimeframeEnabled + crossSymbol` must be rejected with a clear message
- unsupported app surfaces must guard early and explain why

Silently "ignoring timeframe" or returning empty signals is too easy to misread as a bad strategy instead of a broken execution path.

## Support Matrix

### Supported in v1

| Surface | Status | Notes |
|---|---|---|
| Manual backtest UI | Support | Primary target |
| Backtest endpoint preview/copy | Support | Should work automatically once `executeBacktest()` is cross-symbol aware |
| Polymarket outcome evaluator | Support | Required for your use case |
| Finder standard/random/genetic | Support | Needed for strategy research |
| Finder Polymarket mode | Support | Must be handled explicitly, it does not go through `backtest-executor.ts` |
| Walk Forward | Support | Needed for validation |
| Saved strategy configs | Support | Must persist `crossSymbolSecondary` |

### Guard in v1

| Surface | Status | Reason |
|---|---|---|
| Worker alerts/subscriptions | Guard | Secondary fetch and persistence are not designed there yet |
| Signal export CLI / bridge export | Guard | Uses `signal-entry-evaluator`; do not let it fail silently |
| Scanner | Guard | Extra symbol fetch per scanned pair changes runtime cost and semantics |
| Strategy Ensemble Lab | Guard | It executes strategies directly and assumes single-symbol runs |
| Ensemble recipe builders/export | Guard | Same reason as Strategy Ensemble Lab |
| Portfolio Lab | Guard entire feature | Partial target-only support is more work than it looks and creates UI ambiguity |
| Combined Strategy Backtest | Guard | OR/AND semantics become ambiguous once one side is cross-symbol |
| Strategy timeframe resampling | Guard | Better to reject than silently alter behavior |

## Alignment Contract

### Helper file

- `lib/strategies/lib/cross-symbol-helpers.ts`

### Keep the first helper set small

Do not ship a giant helper library in v1. Start with the minimum set needed to prove the feature:

- `alignSecondaryToPrimary(primary, secondary)`
- `trimAlignedPair(primary, alignedSecondary, minBars?)`
- `buildRelativeStrength(primaryCloses, secondaryCloses)`
- `buildPairSpread(primaryCloses, secondaryCloses)`
- `buildRollingPairCorrelation(primaryCloses, secondaryCloses, lookback)`
- `buildRelativeVolumeStrength(primaryVolumes, secondaryVolumes, lookback)`

Delay heavier helpers like lead-lag scoring until at least one real strategy proves they are needed.

### Alignment rules

`alignSecondaryToPrimary(...)` must follow these rules:

1. output length equals `primary.length`
2. for primary time `T`, matched secondary bar must satisfy `secondary.time <= T`
3. never look forward to `secondary.time > T`
4. if no prior secondary bar exists yet, output `null`
5. use existing repo time helpers like `timeToNumber` and `timeKey`

### Trimming rules

`trimAlignedPair(...)` removes only the leading prefix where the aligned secondary is still `null`.

After trimming:

- `primaryData.length === secondaryData.length`
- neither array contains `null`
- signals still carry original primary timestamps

If the remaining length is below `minBars`, throw a structured error from the runtime helper.

## Persistence Contract

Use `crossSymbolSecondary?: string` in:

- `lib/types/strategies.ts`
- `lib/settings-model.ts`

Then wire it through:

- `lib/backtest-settings-dom-contract.ts`
- `lib/backtest-settings-resolver.ts`
- `lib/settings-manager.ts`
- `lib/rust-settings-sanitizer.ts`

Notes:

- Rust should strip `crossSymbolSecondary`
- saved configs must carry the resolved secondary symbol
- endpoint snapshots must carry it automatically as part of `backtestSettings`

## Implementation Phases

### Phase 1. Contract and shared runtime

Files:

- `lib/types/strategies.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/backtest-settings-resolver.ts`
- `lib/settings-manager.ts`
- `lib/rust-settings-sanitizer.ts`
- `lib/cross-symbol-runtime.ts`
- `lib/strategies/lib/cross-symbol-helpers.ts`

Tasks:

- add `crossSymbolConfig` to `Strategy`
- extend `execute`, `prepareFinderData`, and `executePrepared` with optional execution context
- add `crossSymbolSecondary?: string` to settings types
- build the central runtime resolver
- build alignment and trimming helpers

Exit condition:

- typecheck passes
- single-symbol strategies compile unchanged
- unit tests cover alignment and trimming

### Phase 2. Core backtest and Polymarket support

Files:

- `lib/backtest-executor.ts`
- `lib/backtest-service.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/finder/finder-runner-polymarket.ts`

Tasks:

- `executeBacktest()` uses `resolveCrossSymbolExecution(...)`
- `backtest-service` uses the same flow for manual runs
- `polymarket-outcome-evaluator.ts` uses the same flow instead of calling `strategy.execute(...)` directly
- Polymarket Finder path uses the same flow instead of calling `executePrepared/execute` directly on primary-only data

Important:

- this phase is what makes normal backtest and Polymarket evaluation actually work
- updating only `backtest-executor.ts` is not enough

Exit condition:

- one cross-symbol strategy runs in normal backtest
- the same strategy runs in Polymarket evaluation without contract drift

### Phase 3. Finder and Walk Forward support

Files:

- `lib/finder/finder-runner-core.ts`
- `lib/finder/finder-runner-single.ts`
- `lib/finder/finder-runner-shared.ts`
- `lib/finder/genetic-optimizer.ts`
- `lib/strategies/walk-forward.ts`
- `lib/walk-forward-service.ts`

Tasks:

- pass `StrategyExecutionContext` into `prepareFinderData` and `executePrepared`
- cache prepared data using a key that includes strategy key and resolved secondary symbol
- fetch and align secondary data once per run, not per candidate or per window
- reuse the same trimmed pair across the sweep or WFA run

Important:

- current prepared-data caches key by `OHLCVData[]` and strategy key only; that is not enough once the secondary symbol can vary
- do not store full duplicate OHLCV objects in hot-loop caches unless needed

Exit condition:

- Finder standard/random/genetic all complete on a cross-symbol strategy
- WFA completes on a cross-symbol strategy
- single-symbol output remains unchanged

### Phase 4. UI and strategy authoring flow

Files:

- relevant `html-partials/*`
- a new feature-local DOM contract, for example `lib/cross-symbol-dom.ts`
- `lib/handlers/*` or whichever existing handler owns strategy-panel settings
- `archive/prompt.txt`
- `docs/strategy-implementation-guide.md`

Tasks:

- add one secondary symbol field in the UI
- show it only when the selected strategy has `crossSymbolConfig`
- persist it as `crossSymbolSecondary`
- prevent selecting the current primary symbol as the secondary
- document the runtime contract in the strategy implementation guide
- update the AI prompt so generated strategies use the execution context instead of inventing fetch/alignment logic

Prompt guidance must say:

- strategies never fetch secondary data themselves
- alignment is runtime-provided
- manual alignment helpers are not part of the prompt surface
- v1 cross-symbol strategies cannot use strategy-timeframe mode

Exit condition:

- user can pick a secondary symbol in UI
- saved configs reload with the same secondary symbol
- the prompt can generate a valid cross-symbol strategy shape

### Phase 5. Guard unsupported surfaces

Files:

- `lib/alert-subscription-utils.ts`
- `lib/handlers/alert-handlers.ts`
- `workers/entry-signal-worker.ts`
- `scripts/export-latest-entry-signal.ts`
- `lib/polymarket-panel-service.ts`
- `lib/scanner/scanner-engine.ts`
- `lib/strategy-ensemble-engine.ts`
- `lib/ensemble-signal-recipes.ts`
- `lib/portfolio-lab-service.ts`
- `lib/backtest-service.ts` combined strategy path

Tasks:

- block worker subscription creation for cross-symbol strategies
- block local export flows that rely on `signal-entry-evaluator`
- block Scanner, Portfolio Lab, Strategy Ensemble Lab, and combined backtest when the selected strategy is cross-symbol
- make the error messages explicit and user-facing

Important worker note:

`lib/alert-subscription-utils.ts` currently treats every manifest strategy as worker-supported.

That must change, otherwise:

- health checks lie
- Alerts UI allows unsupported strategies
- `tests/worker-strategy-support.spec.ts` becomes wrong as soon as you add a cross-symbol built-in

Exit condition:

- every unsupported surface fails fast with a clear explanation
- no silent empty-signal behavior remains in unsupported flows

### Phase 6. Example strategies and helper expansion

Start with one example only:

- relative-strength mean reversion using ratio z-score or spread z-score

Only add a second example after the first one works end to end in:

- normal backtest
- Polymarket evaluation
- Finder
- WFA

Do not add heavier helpers until a real strategy needs them.

## Validation

### Unit tests

- `tests/cross-symbol-runtime.spec.ts`
- `tests/cross-symbol-helpers.spec.ts`

Cover:

- equal timestamps
- missing leading secondary bars
- LOCF carry-forward
- mixed time formats
- provider mismatch rejection
- primary equals secondary rejection
- insufficient aligned bars rejection

### Integration tests

- `tests/cross-symbol-backtest.spec.ts`
- `tests/cross-symbol-finder.spec.ts`
- `tests/cross-symbol-polymarket.spec.ts`

Cover:

- normal backtest path
- endpoint preview parity
- Polymarket evaluator path
- Finder standard/random/genetic
- WFA
- unsupported surface guards

Also update existing tests:

- `tests/worker-strategy-support.spec.ts`
- `tests/settings-compat.spec.ts`

### Manual verification

1. Run a cross-symbol strategy on BTCUSDT with ETHUSDT as secondary.
2. Save the config and reload it.
3. Run Polymarket evaluation on a supported symbol and confirm outcomes still annotate the primary trades.
4. Run Finder and WFA on the same strategy.
5. Confirm Alerts, Scanner, Portfolio Lab, Strategy Ensemble Lab, combined backtest, and export flows all fail fast with explicit messages.

## First Deliverable

The minimum solid deliverable is:

1. Phase 1
2. Phase 2
3. one example cross-symbol strategy
4. unsupported-surface guards for anything that would otherwise fail silently

That is the smallest version that is useful for your AI-generated strategy workflow and still honest about what the rest of the app can and cannot do.
