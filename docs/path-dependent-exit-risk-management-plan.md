# Path-Dependent Exit Risk Management Plan

## Purpose

Add experimental exit logic to Risk Management that can be tested on long and short trades without changing strategy entry logic.

The feature targets exits that are not just fixed TP, fixed SL, ATR TP/SL, ATR trailing, min/max hold, or ordinary opposite-signal exits. The first implementation should support these modes:

- `mfe_giveback`: exit after favorable excursion gives back a configurable share.
- `momentum_deceleration`: exit when directional move progress weakens.
- `capitulation_exhaustion`: exit into exhaustion after a stretched directional candle fails to continue.
- `squeeze_pressure`: exit when opposite-side squeeze pressure appears.
- `conditional_hazard`: exit when rolling historical open-trade states suggest holding has no remaining edge.
- `triple_barrier_meta`: exit from a causal rolling meta-label model trained on previous closed trades.
- `structure_reclaim`: exit when price reclaims a structure level that should not be reclaimed if the trade is still valid.
- `profit_compression`: exit when profit remains positive but profit-per-bar decays below a threshold.

## Assumptions And Unknowns

### Assumptions

- The UI home is the existing Risk Management section in `html-partials/tab-settings-section-core.html`.
- The feature should work for `tradeDirection` values that can produce long or short positions: `long`, `short`, `both`, `both_flip_loss_2`, and `combined`.
- First implementation should be TypeScript-engine only. New settings must force or preserve TypeScript fallback through existing Rust-sanitizer contracts.
- The first version should expose one selected path-exit mode at a time, not a combinatorial stack of all modes at once.
- The feature should not change built-in strategy files. It should manage exits after entries are already created.
- Causal behavior is required for learning modes: `conditional_hazard` and `triple_barrier_meta` may use only closed trades and completed bars available before the current decision point.

### Unknowns

- Whether the final UI should allow multiple path-exit modes simultaneously. This plan treats that as out of scope for v1.
- Whether learning modes will have enough closed-trade samples in short runs. The planned fallback is no path exit until minimum samples are available.
- Whether these exits should participate in Polymarket `signal_exit_same_event`. By default, they are chart exits, not signal exits.
- Whether any mode should be eligible for Rust later. That depends on experiment value and TS performance.

## Existing Architecture References

- Settings UI markup: `html-partials/tab-settings-section-core.html`
- Settings read path: `lib/backtest-settings-reader.ts`
- Resolver contract: `lib/backtest-settings-resolver.ts`
- DOM contract: `lib/backtest-settings-dom-contract.ts`
- Settings/default types: `lib/types/strategies.ts`, `lib/types/backtest.ts`
- Backtest exit engine: `lib/strategies/backtest/exit-handlers.ts`
- Backtest simulation loops: `lib/strategies/backtest/backtest-engine.ts`
- Position construction: `lib/strategies/backtest/position-builder.ts`
- Direction helpers: `lib/strategies/backtest/backtest-utils.ts`
- Rust fallback/sanitizer: `lib/rust-settings-sanitizer.ts`
- Trade/result display: `lib/renderers/tradesRenderer.ts`, `lib/backtest-result-analysis.ts`, `lib/quick-view/quick-view-renderer.ts`
- Existing parity guard: `tests/backtest-settings-id-parity.spec.ts`
- Core behavior tests: `tests/backtesting-engine.spec.ts`, `tests/backtesting-engine-compact-parity.spec.ts`

## System Architecture

No new service, database, worker, API, or infrastructure is needed.

Recommended module shape:

- Add a pure exit-mode helper module under `lib/strategies/backtest/`, for example `path-exit-rules.ts`.
- Keep orchestration in `exit-handlers.ts` or a narrow call from `backtest-engine.ts`.
- Add settings types/defaults in existing settings modules, not a separate settings store.
- Keep UI id-driven through the existing settings partial and DOM contract systems.

The new logic should be deterministic for the same candles, signals, settings, and execution model.

## Module Boundaries

- `html-partials/tab-settings-section-core.html`: adds Risk Management controls only.
- `lib/backtest-settings-resolver.ts`: reads, clamps, guards, and defaults new fields.
- `lib/backtest-settings-dom-contract.ts`: registers every new DOM id with `rustSupport: "unsupported"`.
- `lib/types/strategies.ts`: adds `BacktestSettings` fields and any new exit reason/type aliases.
- `lib/types/backtest.ts`: adds normalized settings fields and optional position bookkeeping.
- `lib/strategies/backtest/path-exit-rules.ts`: pure rule evaluation for all modes.
- `lib/strategies/backtest/exit-handlers.ts`: calls path-exit rules after protective TP/SL and before generic time-stop exits.
- `lib/strategies/backtest/backtest-engine.ts`: passes bar context and learning state into exit handling.
- `lib/rust-settings-sanitizer.ts`: marks the feature TypeScript-only.
- Renderer/analysis modules: display the new exit reason without breaking existing reason summaries.

Do not add strategy-lib dependencies on path-exit modes.

## Data Flow

1. User selects a path-exit mode and parameters in Risk Management.
2. `getBacktestSettings()` reads new ids via `BACKTEST_DOM_SETTING_IDS`.
3. `resolveBacktestSettingsFromRaw(...)` normalizes enabled state, mode, numeric bounds, and disabled defaults.
4. Backtest execution normalizes settings into `NormalizedSettings`.
5. Each open position is evaluated in existing priority order:
   - stop loss
   - take profit
   - partial take profit
   - path-dependent exit
   - max hold / time stop
   - signal exit paths already handled by engine logic
6. If path exit fires, engine records a chart trade exit with a distinct reason.
7. Renderers and result analysis show the new reason in trade tables and summaries.

## API And Contracts

### Settings Contract

Proposed primary fields:

```ts
type PathExitMode =
    | "off"
    | "mfe_giveback"
    | "momentum_deceleration"
    | "capitulation_exhaustion"
    | "squeeze_pressure"
    | "conditional_hazard"
    | "triple_barrier_meta"
    | "structure_reclaim"
    | "profit_compression";
```

Proposed settings:

- `pathExitEnabled: boolean`
- `pathExitMode: PathExitMode`
- `pathExitMinBars: number`
- `pathExitMinMfePercent: number`
- `pathExitGivebackPercent: number`
- `pathExitLookbackBars: number`
- `pathExitThreshold: number`
- `pathExitMinSamples: number`
- `pathExitHorizonBars: number`

Use shared parameters where possible. Add mode-specific fields only when a mode cannot be expressed with the shared set.

### Engine Contract

Add an optional context object instead of changing every rule signature ad hoc:

```ts
interface PathExitEvaluationContext {
    data: OHLCVData[];
    barIndex: number;
    atrValue: number | null | undefined;
    learningState?: PathExitLearningState;
}
```

`processPositionExits(...)` should accept this context as an optional last argument. If it is missing, path exits return `null`.

### Trade Contract

Preferred minimal trade contract:

- Add `path_exit` to `Trade["exitReason"]`.
- Add optional `pathExitMode?: PathExitMode` only if mode-specific post-run analysis is needed.

If only one mode can be active per run, `exitReason: "path_exit"` is enough for v1 display and summaries.

## Exit Mode Semantics

All modes must use `directionFactorFor(position.direction)` so long and short behavior is symmetric.

### MFE Giveback

- Track favorable extreme using existing `position.extremePrice`.
- Compute favorable excursion from entry to extreme.
- Exit when MFE exceeds `pathExitMinMfePercent` and current close gives back at least `pathExitGivebackPercent` of MFE.
- For shorts, favorable extreme is the lowest low; for longs, highest high.

### Momentum Deceleration

- Measure signed return progress over `pathExitLookbackBars`.
- Exit when the trade is profitable, minimum hold is satisfied, and signed momentum falls below a threshold after previously being favorable.
- Avoid using future bars or centered indicators.

### Capitulation Exhaustion

- Detect stretched same-direction candle using range/body/volume percentile over a trailing lookback.
- Exit after the next completed bar fails to extend in the trade direction or closes back through a configurable reference level.
- For shorts, this covers after selloff exhaustion; for longs, after upside blowoff exhaustion.

### Squeeze Pressure

- Detect opposite-side pressure while a trade is open:
  - opposite-color close
  - close location against the trade direction
  - range or volume expansion
  - reclaim of short-term average or VWAP proxy when available
- Exit only when the trade has positive MFE or after `pathExitMinBars`.

### Conditional Hazard

- Maintain rolling summaries from previously closed trades only.
- At each bar of an open trade, classify the current path state by bars held, MFE bucket, MAE bucket, volatility/range bucket, and current PnL bucket.
- Exit when historical continuation expectancy for similar states is less than or equal to zero and sample count is at least `pathExitMinSamples`.
- If samples are insufficient, do not exit.

### Triple-Barrier Meta

- Label previous closed-trade path states by whether the next `pathExitHorizonBars` would have reached favorable, adverse, or time barrier first.
- Use a simple deterministic classifier first, such as bucket win-rate/expectancy lookup. Do not introduce ML dependencies.
- Exit when the current state maps to a bucket whose historical keep-holding outcome is poor.
- Labels must be produced only after the source trade is closed, then used for later trades.

### Structure Reclaim

- For each position, derive a structure level from completed bars near entry:
  - breakdown/breakout candle midpoint
  - prior swing high/low
  - rolling channel boundary
- Exit when close reclaims the invalidation level against the trade direction.
- Do not use confirmed pivots that require future bars after the entry unless the confirmation occurred before the exit decision.

### Profit Compression

- Compute current signed profit percent and bars held.
- Exit when profit is positive, MFE threshold was reached, and `profitPercent / barsHeld` decays below threshold.
- This should not fire while the trade is still accelerating in the favorable direction.

## State Management

No new persistent app state is required.

Runtime state additions:

- Extend `PositionState` only for values that cannot be derived cheaply from existing fields and current bar context.
- Prefer derived values from `entryPrice`, `extremePrice`, `barsInTrade`, `openedBarIndex`, and candle history.
- Learning-mode state should live inside the backtest run only. It should not write to `state.ts`, localStorage, IndexedDB, or SQLite.

Settings persistence:

- Existing settings persistence should pick up new registered DOM ids.
- Defaults must keep the feature off so old saved settings preserve current behavior.
- Old saved payloads without new fields must resolve cleanly.

## Performance Considerations

- Keep per-bar rule evaluation O(1) or O(lookback) with small bounded lookbacks.
- Precompute rolling range/body/volume statistics only when the selected mode needs them.
- Do not allocate arrays per bar in Finder hot paths.
- Learning modes should use bounded rolling maps or arrays, not retain every path sample indefinitely.
- New modes must not disable existing fast paths accidentally without explicit diagnostics. If fast-path support is not practical, add a clear blocker reason.

## Edge Cases

- `maxOpenTrades > 1`: each position needs independent path state or fully derivable state.
- `next_open`: path exit should fill according to the same execution timing model as other chart exits. Avoid same-bar lookahead.
- `allowSameBarExit: false`: do not path-exit on the same bar a position opens unless current engine semantics already permit it.
- `riskMinHoldEnabled`: decide per mode whether min hold applies. Default should apply it to all path exits except protective stop-like modes; document exceptions in tests.
- `disableSignalExits`: path exits are chart exits, not signal exits. They should still be allowed when explicitly enabled.
- `combined` and `both`: verify flips still respect existing cooldown and signal-exit rules.
- `end_of_data`: open trades still close through existing forced close logic.
- Non-finite candle prices or zero entry price: path exit returns `null`.
- Sparse/flat volume: volume-dependent exhaustion/squeeze checks must degrade to price-only rules or return `null`.

## Failure Handling

- Invalid mode resolves to `off`.
- Invalid numeric fields clamp to safe defaults.
- Insufficient sample counts in learning modes produce no path exit, not a synthetic failure.
- Missing context object in `processPositionExits(...)` returns no path exit.
- If Rust is enabled and path exits are enabled, the existing TypeScript-engine fallback warning path should apply.

## Rollback Strategy

- Feature defaults to off.
- UI can be hidden by removing the new settings block while keeping resolver defaults.
- Engine logic should be gated by `pathExitEnabled && pathExitMode !== "off"`.
- Since no schema/database changes are planned, rollback is code-only.

## Phase 1: Contracts And Settings Skeleton

### Objective

Add disabled-by-default settings contracts for path-dependent exits without changing backtest behavior.

### Scope

- Types, defaults, resolver, DOM ids, DOM contracts, Rust sanitizer.
- Minimal UI block under Risk Management with a mode select and shared parameters.

### Technical Tasks

- Add `PathExitMode` and new `BacktestSettings` fields in `lib/types/strategies.ts`.
- Add normalized fields in `lib/types/backtest.ts`.
- Add defaults in `EFFECTIVE_BACKTEST_DEFAULTS`.
- Add numeric and boolean resolver rules in `lib/backtest-settings-resolver.ts`.
- Add ids to `BACKTEST_DOM_SETTING_IDS`.
- Add matching DOM contracts in `lib/backtest-settings-dom-contract.ts` with `rustSupport: "unsupported"`.
- Add the UI controls to `html-partials/tab-settings-section-core.html`.
- Add the new keys to `RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS` and `requiresTypescriptEngine(...)`.

### Dependencies

- Existing settings parser utilities.
- Existing feature DOM contract tests.
- Existing Rust fallback warning path.

### Risks/Blockers

- Adding a DOM id to only one settings contract silently drops values.
- Too many mode-specific controls could clutter the Risk Management panel.
- New unsupported settings must not leak to Rust requests.

### Deliverables

- Settings compile and round-trip through the UI read path.
- Feature remains off by default.
- Rust eligibility correctly switches to TypeScript when enabled.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\backtest-settings-id-parity.spec.ts`
- Add or update settings compatibility tests for default/off behavior.
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

### Exit Criteria

- New settings can be read and normalized.
- Existing backtests are unchanged when `pathExitEnabled` is false.

## Phase 2: Shared Path Exit Engine

### Objective

Create the path-exit evaluation seam and implement `mfe_giveback` and `profit_compression` first.

### Scope

- Pure helper module.
- Optional context passed to exit handling.
- Exit reason display support.

### Technical Tasks

- Add `lib/strategies/backtest/path-exit-rules.ts`.
- Add `PathExitEvaluationContext` and pure helpers for signed price movement.
- Extend `processPositionExits(...)` with optional context.
- Call path exits after partial TP and before max/time stop.
- Add `path_exit` to trade reason handling.
- Update trade/result renderers for the new reason label.
- Ensure compact/full backtest loops use the same context and ordering.

### Dependencies

- Existing `directionFactorFor(...)`.
- Existing `PositionState.extremePrice`.
- Existing full and compact engine loops.

### Risks/Blockers

- Exit ordering can change existing TP/SL behavior if inserted too early.
- Compact and full paths can drift if only one loop is updated.
- `next_open` timing must not inspect the execution bar in a way current engine rules forbid.

### Deliverables

- `mfe_giveback` and `profit_compression` work for long and short positions.
- Existing behavior is unchanged when disabled.
- Exit reason summaries include path exits.

### Validation/Testing Criteria

- Add focused long/short tests in `tests/backtesting-engine.spec.ts`.
- Add compact parity cases in `tests/backtesting-engine-compact-parity.spec.ts`.
- Verify TP/SL precedence still wins when touched before path exit.
- `npm run typecheck`

### Exit Criteria

- Long and short fixtures close through `path_exit` only under intended conditions.
- Full and compact backtests match on net profit, trades, and exit reasons.

## Phase 3: Price-Action Exit Modes

### Objective

Implement non-learning price-action modes: `momentum_deceleration`, `capitulation_exhaustion`, `squeeze_pressure`, and `structure_reclaim`.

### Scope

- Causal OHLCV-only logic.
- Bounded rolling lookbacks.
- Shared long/short helper functions.

### Technical Tasks

- Add trailing signed return, range/body, close-location, and volume percentile helpers.
- Add structure-level derivation using only completed bars.
- Implement each mode as a pure rule returning `PositionExitTrigger | null`.
- Add mode-specific tests covering long and short symmetry.
- Add fast-path blocker diagnostics if contextual rules cannot run on a fast path.

### Dependencies

- Candle history and bar index supplied by Phase 2 context.
- Existing OHLCV data and direction helpers.
- Existing execution model semantics.

### Risks/Blockers

- Reusing current candle high/low can create optimistic intrabar assumptions.
- Pivot/structure logic can accidentally use future bars.
- Volume-dependent modes may fail on datasets with zero or unreliable volume.

### Deliverables

- Four additional selectable modes.
- No new strategy files.
- Tests encode why each mode exits.

### Validation/Testing Criteria

- Long and short fixture tests for every mode.
- Tests for insufficient lookback returning no exit.
- Tests for volume-missing fallback behavior.
- `npm run typecheck`
- `npm run test -- backtesting-engine`

### Exit Criteria

- Each mode produces deterministic exits without lookahead.
- Existing TP/SL/time-stop tests still pass.

## Phase 4: Causal Learning Exit Modes

### Objective

Implement `conditional_hazard` and `triple_barrier_meta` without future leakage.

### Scope

- Simple rolling, deterministic models.
- No external ML dependency.
- No persistence outside the current backtest run.

### Technical Tasks

- Define `PathExitLearningState` owned by the backtest run.
- Record closed-trade path summaries after each trade closes.
- Build bounded state buckets from bars held, current PnL, MFE, MAE, and volatility/range regime.
- Implement sample-count gates and continuation expectancy checks.
- Implement triple-barrier labels from historical closed-trade path samples only.
- Add diagnostics counters for insufficient-sample skips if existing diagnostics shape can accept them without broad churn.

### Dependencies

- Closed-trade lifecycle hooks in `backtest-engine.ts`.
- Position path data available during trade simulation.
- Bounded memory design for Finder runs.

### Risks/Blockers

- Historical path samples may require storing per-trade bar paths, increasing memory.
- Too sparse buckets can make the mode inert.
- Too broad buckets can overgeneralize and exit good trades.
- Learning-mode behavior may differ between full and compact loops if state updates are not mirrored exactly.

### Deliverables

- Two learning modes with causal sample gating.
- Tests proving later trades can use earlier trade labels but earlier trades cannot use future labels.
- No dataset-wide future label precomputation in the risk-management path.

### Validation/Testing Criteria

- Causality tests where the first trade cannot trigger learning exit but a later similar trade can.
- Insufficient-sample tests.
- Full/compact parity tests.
- `npm run typecheck`
- `npm run test -- backtesting-engine`

### Exit Criteria

- Learning modes are deterministic, bounded, and causal.
- Disabled/off and insufficient-sample behavior does not change normal exits.

## Phase 5: Finder, Batch, And Compatibility Pass

### Objective

Make the feature safe for Finder, Batch, server-side Batch, and existing UI workflows.

### Scope

- Settings propagation.
- Rust fallback.
- Browser memory and speed.
- Copy/summary output compatibility.

### Technical Tasks

- Verify `backtest-service.ts` and `finder-manager.ts` pass settings through the TypeScript path.
- Verify `sanitizeBacktestSettingsForRust(...)` strips all new fields.
- Check server-side Batch payload/scalar rows do not need array fields for path exits.
- Ensure path-exit trade reasons serialize through existing result/copy paths.
- Add documentation note if server-side Batch or Rust behavior is TypeScript-only.

### Dependencies

- Phase 1 sanitizer updates.
- Existing Batch and Finder backtest execution paths.

### Risks/Blockers

- Finder hot paths may slow down if rules allocate per bar.
- Server-side Batch may need explicit settings allowlist updates if any exist outside the normal resolver path.
- Rust-enabled users need clear fallback behavior, not silent parity drift.

### Deliverables

- Finder and Batch can run with path exits enabled using the TS engine.
- No browser-held heavy arrays are introduced.
- Copy and trade summaries do not fail on `path_exit`.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-cache-decision.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-runner.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-copy.spec.ts`
- Focused manual smoke: one long and one short backtest with each mode.

### Exit Criteria

- Feature is usable from normal backtest, Finder, and Batch without known setting drops.
- Rust fallback is visible and deterministic.

## Phase 6: Documentation And Experiment Readiness

### Objective

Document how to evaluate the new exits without overstating deployability.

### Scope

- User-facing notes in existing docs if implementation proceeds.
- Test coverage checklist.
- Experiment interpretation guidance.

### Technical Tasks

- Update `README.md` or a focused risk-management doc with concise mode descriptions.
- Document that learning modes are causal and sample-gated.
- Document that `path_exit` is a chart exit, not a strategy signal exit.
- Add recommended comparison workflow:
  - baseline native signal exits
  - fixed TP/SL
  - path exit mode
  - long vs short split
  - buy-and-hold comparison
  - OOS/Finder universe validation

### Dependencies

- Final mode names and parameter names.
- Final renderer labels.

### Risks/Blockers

- Documentation can imply alpha when the feature only improves trade management on selected samples.
- Too many modes can encourage overfitting without OOS validation.

### Deliverables

- Short implementation docs.
- Validation checklist.
- Known limitations.

### Validation/Testing Criteria

- Docs match final setting ids and mode names.
- Manual smoke confirms UI text matches visible controls.

### Exit Criteria

- A user can run controlled long/short experiments and understand what each mode is testing.

## Validation Command Set

Core:

```bash
npm run typecheck
npm run test -- backtesting-engine
..\\..\\..\\node_modules\\.bin\\esno tests\\backtesting-engine-compact-parity.spec.ts
..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts
..\\..\\..\\node_modules\\.bin\\esno tests\\backtest-settings-id-parity.spec.ts
```

Compatibility:

```bash
..\\..\\..\\node_modules\\.bin\\esno tests\\finder-cache-decision.spec.ts
..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-runner.spec.ts
..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-copy.spec.ts
```

Manual smoke:

- Long-only run with each mode.
- Short-only run with each mode.
- `both` or `combined` run with signal flips.
- Run with Rust enabled and confirm TypeScript fallback messaging.
- Finder run with path exit enabled and disabled, verifying no setting loss.

