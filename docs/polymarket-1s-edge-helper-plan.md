# Polymarket 1s Edge Helper Plan

## Purpose

Plan the implementation of 1s Polymarket helper surfaces for finding executable mispricing between Binance 1s event state and Polymarket CLOB prices.

The target workflow is:

1. Mine/sync 1s Binance candles and Polymarket CLOB quotes through the existing Execution Lab / second-market paths.
2. Use built-in 1s strategies with `polymarket1sConfig: { required: true }`.
3. Let Finder optimize small parameter surfaces.
4. Paper/live-test selected strategies in Execution Lab.

This plan does not implement helpers. It defines phases, contracts, validation, and risks.

## Current Architecture Evidence

- Strategy source of truth: `lib/strategies/lib/*`.
- 1s Polymarket helper module: `lib/strategies/lib/polymarket-1s-helpers.ts`.
- Strategy execution context types: `lib/types/strategies.ts`.
- Backtest context loading: `lib/backtest-executor.ts`.
- Second-market CLOB/Gamma evaluation context: `lib/second-market/evaluation.ts`.
- Second-market quote/gamma DB row types: `lib/second-market/types.ts`.
- Execution Lab live strategy context: `lib/execution-lab/execution-lab-strategy-context.ts`.
- Existing 1s helper strategies use `buildPolymarket1sPressureGap(...)`.
- `archive/prompt-1s-polymarket.txt` should stay aligned to the real exported helper surface.

## Assumptions

- The first implementation target is supported 1s crypto charts, currently BTCUSDT/XRPUSDT per second-market support.
- The relevant Polymarket event interval is 5m unless the active settings choose another supported outcome interval.
- Chart strategies should continue to execute through the normal strategy/backtest contract.
- Helper output should be causal: bar `i` may only use Binance data up to `i` and Polymarket rows with timestamp `<= bar i`.
- No new service, microservice, or external API is required for the first version.
- No database schema migration is required for executable edge because second-market CLOB rows already contain bid/ask/mid fields.

## Unknowns

- Live entry mode decision: taker-style buy at ask versus posted limit order. This changes whether helpers should optimize ask-edge only or limit-fill probability.
- Whether Execution Lab should pass Gamma snapshots into live strategy context. It currently passes `gammaSnapshots: []`.
- Whether edge should include fees/slippage in helper output or leave that to strategy params and Execution Lab settings.
- Minimum acceptable quote freshness and event-progress boundaries for live use need empirical calibration.
- Whether helper outputs should be displayed in UI diagnostics immediately or remain strategy-internal first.
- Whether the current fair-probability model is calibrated enough by event progress, volatility regime, and symbol. A large model-vs-market gap can mean model error, not Polymarket inefficiency.
- Whether the strategy decision timestamp and the actual paper/live fill timestamp use the same quote. If they differ, edge thresholds need a timing/slippage margin.

## Known Conceptual Weaknesses To Control

- Fair probability is currently model-based, not truth. The existing pressure helper uses event-open distance and remaining volatility; that can misprice trend, jump, liquidation, or news regimes.
- Executable edge is not fill probability. `fairYesProbability - yesAsk` can look positive while the quote disappears before paper/live order placement.
- Polymarket may already be efficient. Finder can overfit tiny historical gaps unless validation checks edge buckets, quote freshness, and out-of-sample event splits.
- Binance chart PnL can be misleading for these strategies. Primary evaluation must use Polymarket priced-trade behavior, not only chart-side return metrics.
- Generated strategies can drift into Polymarket-only or Gamma-only ideas unless `archive/prompt-1s-polymarket.txt` stays explicit about Binance-derived fair probability and Gamma as secondary agreement.

## System Architecture

No new subsystem is planned. The change should extend existing strategy helper and execution-context contracts.

Relevant boundaries:

- `lib/strategies/lib/polymarket-1s-helpers.ts`
  Owns pure, causal helper calculations and caching.
- `lib/types/strategies.ts`
  Owns the strategy-facing runtime context shape.
- `lib/backtest-executor.ts`
  Owns automatic historical second-market context loading for strategies declaring `polymarket1sConfig`.
- `lib/execution-lab/execution-lab-strategy-context.ts`
  Owns live/paper context passed into selected strategy execution.
- `archive/prompt-1s-polymarket.txt`
  Owns AI strategy generation constraints after helper contracts exist.

## Data Flow

Existing flow to preserve:

1. Binance 1s candles load as normal chart/backtest data.
2. Strategies declaring `polymarket1sConfig` receive `StrategyExecutionContext.polymarket1s`.
3. Historical backtests load context through `loadSecondMarketEvaluationContext(...)`.
4. Execution Lab passes recent live CLOB quotes through `buildExecutionLabStrategyExecutionContext(...)`.
5. Strategy helpers align quotes causally to chart bars.
6. Strategies emit normal `buy` / `sell` signals.
7. Existing backtest, Finder, and Execution Lab execution paths consume those signals.

Planned helper data flow:

1. Build or reuse a pressure/fair-probability frame from Binance event-open distance and remaining volatility.
2. Align the latest eligible CLOB quote at or before each bar.
3. Derive executable YES/NO edge from fair probability versus ask-side price.
4. Optionally derive reaction lag from recent changes in fair probability versus market probability.
5. Optionally derive Gamma agreement from historical Gamma snapshots where available.
6. Return arrays indexed to `data`.

## Execution Timing Contract

Helper frames measure decision-time edge. They should not silently claim that the same price is fillable later.

First implementation rule:

- Helper quote alignment remains causal to the chart bar: latest quote with timestamp `<= bar timestamp`.
- Backtest trade timing remains owned by the existing execution model.
- Polymarket scoring/fill timing remains owned by the existing second-market scoring and Execution Lab paths.
- Strategy tests must distinguish helper decision quote from modeled Polymarket entry quote when `signal_close`, `next_open`, or `next_close` creates a timing shift.

Live-readiness rule:

- A strategy is not live-ready just because historical helper edge is positive.
- Paper validation must confirm that Execution Lab entry quotes are still within the intended edge/slippage tolerance at order time.
- If decision quote and fill quote often diverge, add a conservative timing margin as a strategy param or actionability option before live use.

## Evaluation Metrics

Primary metrics for these helpers:

- Polymarket priced-trade expectancy and net PnL.
- Fill rate and unfilled/missing quote rate.
- Average entry price versus decision-time ask.
- Edge bucket calibration: larger predicted edge should show better realized Polymarket PnL or win rate.
- Out-of-sample event performance by symbol/date range.

Secondary metrics:

- Binance chart backtest metrics.
- Raw signal count.
- Helper availability coverage.

Reject a strategy if it only improves Binance chart metrics while Polymarket priced-trade behavior is flat, missing, or worse.

## API And Contracts

### Existing contract to preserve

`buildPolymarket1sPressureGap(data, context, options)` must remain compatible with existing strategies.

### Planned helper contracts

1. `buildPolymarket1sExecutableEdge(data, context, options)`

Objective:
Calculate live-actionable edge using executable ask prices, not only mid prices.

Expected outputs:

- `available`
- `fairYesProbability`
- `fairNoProbability`
- `marketYesProbability`
- `yesAskProbability`
- `noAskProbability`
- `buyYesEdge`
- `buyNoEdge`
- `quoteAgeSec`
- `eventProgress`
- `secondsRemaining`

2. `buildPolymarket1sReactionGap(data, context, options)`

Objective:
Detect Polymarket underreaction to a recent Binance-implied probability move.

Expected outputs:

- `available`
- `spotImpulse`
- `marketImpulse`
- `reactionGap`
- `longLagEdge`
- `shortLagEdge`

3. `buildPolymarket1sActionabilityMask(data, context, options)`

Objective:
Fail closed when a theoretical edge is not tradable.

Expected outputs:

- `available`
- `actionable`
- optional reason/status arrays if needed for tests or diagnostics

Initial filters:

- max quote age
- min/max event progress
- min seconds remaining

4. Binary agreement masks

Objective:
Expose yes/no side permission without adding magnitude thresholds when the strategy only needs agreement or actionability.

Expected outputs:

- `available`
- `longAllowed` / `shortAllowed` or `yesAllowed` / `noAllowed`

5. `buildPolymarket1sGammaAgreement(data, context, options)`

Objective:
Use Gamma as agreement only, not as primary signal.

Expected outputs:

- `available`
- `gammaYesProbability`
- `gammaGap`
- `consensusLongEdge`
- `consensusShortEdge`

## Database And Schema Design

No schema change is planned for the first implementation.

Existing evidence:

- `PolymarketClob1sQuoteRow` already includes `yes_bid`, `yes_ask`, `yes_mid`, `no_bid`, `no_ask`, `no_mid`, quote age, token ids, event boundaries, and sample timestamp.
- `PolymarketGammaSnapshotRow` already includes Gamma YES/NO price fields.

Likely type-only change:

- Extend `Polymarket1sQuoteContextRow` in `lib/types/strategies.ts` with optional ask fields so strategy helpers can use executable prices without casting.

## State Management

No app state or localStorage setting change is planned initially.

If later UI controls are added for edge thresholds, they become settings changes and must follow:

- `lib/settings-manager.ts`
- Rust/finder unsupported-setting stripping where applicable
- persisted JSON compatibility

The first version should keep thresholds as strategy params.

## Security Considerations

No new secret handling is planned.

Constraints to preserve:

- Browser strategy code must not receive private keys.
- Execution Lab live orders continue through the existing local executor boundary.
- Helper output must only use non-secret chart, quote, and Gamma data already passed to strategy execution.

## Performance Considerations

Finder will call strategies many times, so helper implementation must avoid repeated expensive work.

Required practices:

- Cache helper frames by runtime context, data array, and normalized options, matching the existing `WeakMap` style in `polymarket-1s-helpers.ts`.
- Avoid per-bar quote searches from the beginning of the quote array; use sorted quotes and a moving pointer.
- Reuse the existing pressure/fair-probability frame where possible.
- Keep helper outputs as arrays of numbers/nulls aligned to `data`.
- Do not allocate per-candidate objects in hot signal loops.

## Failure Handling

Helpers should fail closed:

- missing context returns `available: false` and null/false arrays
- missing active event quote returns null/false for that bar
- stale quote returns null/false for that bar
- missing event-open price returns null/false for that event until resolvable
- missing bid/ask prevents executable edge for that side
- missing Gamma prevents Gamma agreement, but should not break non-Gamma helpers

Strategies using these helpers should return `[]` when the required frame is unavailable.

## Edge Cases

- Event-open bar absent from chart data.
- Quote exists before event start or at/after event end.
- YES/NO probabilities do not sum cleanly.
- Only one side has bid/ask/mid.
- Wide or crossed markets.
- Duplicate quote sample timestamps.
- `signal_close` and `next_close` scoring use one-second timestamp shifts elsewhere; helper alignment should remain chart-bar causal and not duplicate scoring shifts.
- Very early event seconds can have unstable fair probability.
- Very late event seconds can show large theoretical edge that is not fillable.
- Finder may overfit tiny edge thresholds unless defaults are coarse.

## Rollback Strategy

Keep changes additive.

Rollback path:

1. Remove newly added helpers and tests.
2. Revert prompt updates that reference the new helpers.
3. Leave existing `buildPolymarket1sPressureGap(...)` and existing strategies untouched.
4. If `Polymarket1sQuoteContextRow` receives optional fields, those can remain because optional fields are backward-compatible.

## Phase 0: Contract Verification

### Objective

Confirm exact current helper, type, context-loading, and live Execution Lab contracts before code changes.

### Scope

- Strategy helper module
- Strategy execution context types
- Backtest executor context loading
- Second-market evaluation context
- Execution Lab context adapter
- Existing prompt and 1s helper strategies

### Technical Tasks

- Read `lib/strategies/lib/polymarket-1s-helpers.ts`.
- Read `lib/types/strategies.ts`.
- Read `lib/backtest-executor.ts` Polymarket context loading.
- Read `lib/second-market/evaluation.ts`.
- Read `lib/execution-lab/execution-lab-strategy-context.ts`.
- Inspect current built-in strategies using `polymarket1sConfig`.
- Confirm which helpers in `archive/prompt-1s-polymarket.txt` are implemented.

### Dependencies

- Existing repo files only.

### Risks/Blockers

- Prompt may reference helper APIs that do not exist yet.
- Live context may not include Gamma snapshots.
- Runtime quote type may omit fields available on the underlying DB row.

### Deliverables

- Confirmed implementation target list.
- Confirmed type changes needed.

### Validation/Testing Criteria

- No code change in this phase.
- Findings are reflected in implementation tickets or phase notes.

### Exit Criteria

- Exact file-level contracts are known.
- Unknowns are listed before implementation.

## Phase 1: Helper Contract Design

### Objective

Define stable strategy-facing helper APIs with minimal parameter surfaces.

### Scope

- `lib/strategies/lib/polymarket-1s-helpers.ts`
- `lib/types/strategies.ts`
- Tests for helper output shape and causality

### Technical Tasks

- Define TypeScript interfaces for executable edge, reaction gap, actionability mask, edge persistence, and Gamma agreement frames.
- Normalize helper options with conservative defaults.
- Extend `Polymarket1sQuoteContextRow` with optional executable quote fields if needed.
- Keep `buildPolymarket1sPressureGap(...)` public contract unchanged.
- Decide whether actionability is a standalone helper or option accepted by executable-edge helper.

### Dependencies

- Phase 0 findings.
- Existing second-market quote row fields.

### Risks/Blockers

- Too many helpers can make strategy generation harder to constrain.
- Adding reason arrays to actionability may add memory pressure if overused.

### Deliverables

- Final helper interface definitions.
- Short update to `archive/prompt-1s-polymarket.txt` API section after implementation exists.

### Validation/Testing Criteria

- Typecheck catches incorrect helper use.
- Existing pressure-gap strategies still compile.

### Exit Criteria

- Helper API names, options, and frame outputs are stable enough for implementation.

## Phase 2: Executable Edge Helper

### Objective

Implement the first useful live-trading helper: fair probability versus executable YES/NO ask.

### Scope

- `lib/strategies/lib/polymarket-1s-helpers.ts`
- Focused helper tests

### Technical Tasks

- Reuse pressure/fair-probability calculations where possible.
- Align latest quote causally by sample timestamp.
- Normalize YES/NO mid probability as the existing pressure helper does.
- Normalize ask-side prices for YES and NO.
- Compute `buyYesEdge = fairYesProbability - yesAsk`.
- Compute `buyNoEdge = fairNoProbability - noAsk`.
- Include quote age, event progress, and seconds remaining.
- Cache frames by context, data, and options.

### Dependencies

- Phase 1 helper interfaces.
- Optional ask fields available in strategy context rows.

### Risks/Blockers

- Historical context may include mid fields but missing bid/ask in some rows.
- Live context may have stale exact-second quotes.
- Fair-probability model may be too naive in the final seconds.

### Deliverables

- `buildPolymarket1sExecutableEdge(...)`.
- Unit tests with synthetic candles and quote rows.

### Validation/Testing Criteria

- Causal quote alignment test: future quote must not affect current bar.
- Missing ask test: side edge is null.
- Missing ask test: affected side fails closed without blocking the other side.
- Event boundary test: no output outside active event.
- Existing tests still pass.

### Exit Criteria

- Helper returns actionable edge arrays without breaking existing pressure-gap users.

## Phase 3: Calibration And Timing Validation

### Objective

Prove the fair-probability edge is directionally useful before adding more helper complexity.

### Scope

- Synthetic helper tests
- Historical second-market sample validation where local data exists
- No strategy generation yet

### Technical Tasks

- Build a small validation harness or focused tests that bucket `buyYesEdge` and `buyNoEdge` by size.
- Compare edge buckets against realized Polymarket priced-trade behavior where scoring data is available.
- Measure helper availability, stale quote rate, and missing ask rate.
- Compare decision-time ask versus modeled Polymarket entry quote under supported execution models.
- Check calibration by event progress buckets so final-seconds behavior does not dominate results.
- Document whether the initial fair-probability model needs a conservative minimum edge or timing margin before strategy use.

### Dependencies

- Phase 2 executable edge helper.
- Local second-market data coverage for at least one supported symbol/date range.

### Risks/Blockers

- Local historical data may be sparse or biased toward specific market regimes.
- Positive edge buckets may be too rare after executable ask and actionability constraints.
- Calibration can look good in-sample but disappear across event/date splits.

### Deliverables

- Calibration note with symbol, date range, event count, helper coverage, edge buckets, and timing drift.
- Recommended conservative defaults for `minEdge`, quote age, and event-progress filters.

### Validation/Testing Criteria

- Edge buckets are computed without future quotes.
- Results report missing/unavailable samples separately from losing samples.
- At least one out-of-sample split is checked before strategy generation.

### Exit Criteria

- The helper either shows enough executable edge to continue, or the plan pauses for fair-probability model revision.

## Phase 4: Reaction, Actionability, And Persistence Helpers

### Objective

Add timing-sensitive helpers that distinguish real underreaction from stale/noisy edge.

### Scope

- `lib/strategies/lib/polymarket-1s-helpers.ts`
- Focused helper tests

### Technical Tasks

- Implement `buildPolymarket1sReactionGap(...)` using configurable `lagSec`.
- Compute fair-probability impulse and market-probability impulse over the lag.
- Implement actionability filtering for quote age, event progress, seconds remaining, and side ask availability.
- Implement edge persistence using consecutive seconds and/or EWMA.
- Ensure helpers return null/false when base frame values are unavailable.
- Share cache and alignment code where practical without creating broad abstractions.

### Dependencies

- Phase 2 executable edge and pressure frame behavior.
- Phase 3 calibration defaults.

### Risks/Blockers

- Reaction gap can become a momentum duplicate if strategy rules ignore executable edge.
- Actionability criteria could overlap Execution Lab fill rules if not kept descriptive.

### Deliverables

- `buildPolymarket1sReactionGap(...)`.
- `buildPolymarket1sActionabilityMask(...)`.
- Binary agreement masks for pressure, executable edge, no-adverse actionability, reaction, and Gamma consensus.
- Tests for lag, stale quotes, event-progress fences, and binary side permission.

### Validation/Testing Criteria

- Reaction gap uses only values at or before current bar.
- Lag behavior handles missing intermediate seconds.
- Actionability fails closed on stale or missing quotes.
- Binary masks fail closed when the underlying frame is unavailable.

### Exit Criteria

- Strategies can express "mispriced and tradable now" using small param surfaces.

## Phase 5: Prompt And Strategy Authoring Alignment

### Objective

Update AI idea generation to produce implementable strategies against the actual helper surface.

### Scope

- `archive/prompt-1s-polymarket.txt`
- New strategy ideas only after helpers exist

### Technical Tasks

- Replace references to unimplemented helpers only after they are implemented.
- Shift prompt language from chart-signal-plus-veto toward executable mispricing:
  - fair probability edge
  - ask-side executable edge
  - reaction lag
  - actionability
  - persistence
- Clarify that the Binance raw signal can be the Binance-implied fair probability/event-state direction; the Polymarket CLOB price supplies the executable mispricing check.
- List `buildPolymarket1sGammaAgreement(...)` only as secondary agreement, not as a primary signal source.
- Keep strategy idea rules constrained to 2-4 params.
- Require `polymarket1sConfig: { required: true }`.
- Require helper unavailable paths to return `[]`.
- Keep Gamma agreement optional and secondary.

### Dependencies

- Phases 2-4 implemented.

### Risks/Blockers

- Prompt may generate Polymarket-only entries unless it explicitly requires Binance-implied fair probability or Binance event-state direction.
- Too many helper choices can produce overfit strategy ideas.

### Deliverables

- Updated `archive/prompt-1s-polymarket.txt`.
- Optional archived generated idea JSON after prompt update.

### Validation/Testing Criteria

- Prompt only lists real exported helpers.
- Generated ideas are implementable with existing strategy contracts.
- No generated idea depends on unavailable UI, DB, or service APIs.

### Exit Criteria

- AI idea generation can produce strategy specs without inventing helper APIs.

## Phase 6: First Strategy Implementation

### Objective

Implement one simple built-in strategy to prove the helper surface.

### Scope

- One new file under `lib/strategies/lib/*`.
- Generated manifests via `npm run strategies:sync-manifest`.
- Focused strategy tests if behavior is non-trivial.

### Technical Tasks

- Start with a minimal strategy:
  - Buy YES when `buyYesEdge >= minEdge`, actionable, and persistent.
  - Buy NO when `buyNoEdge >= minEdge`, actionable, and persistent.
- Expose only core params:
  - `volLookback`
  - `minEdge`
  - `persistenceSec` or `lagSec`
- Implement `normalizeParams`.
- Declare `polymarket1sConfig: { required: true }`.
- Ensure unavailable helper frames return `[]`.
- Run manifest sync.

### Dependencies

- Phases 2, 3, and 4.
- Phase 5 prompt update if strategy ideas are generated with AI.
- Strategy authoring contracts.

### Risks/Blockers

- A pure market-price threshold strategy would be invalid; the strategy must derive fair direction from Binance/event state before comparing executable Polymarket price.
- Finder may discover edge thresholds that are not live-fillable.

### Deliverables

- One built-in executable-edge strategy.
- Synced strategy manifests.
- Optional tests for normalized params and unavailable context.

### Validation/Testing Criteria

- `npm run strategies:sync-manifest`.
- `npm run typecheck`.
- `npm run test -- polymarket`.
- Focused helper tests.
- Manual Finder smoke run on 1s BTCUSDT/XRPUSDT if data exists locally.

### Exit Criteria

- Strategy appears in dropdown.
- Strategy runs on supported 1s context.
- Strategy fails closed without Polymarket 1s context.

## Phase 7: Finder And Execution Lab Validation

### Objective

Verify the helper-backed strategy is usable for the intended research/live workflow.

### Scope

- Finder on 1s strategy
- Quick View / Polymarket scoring where applicable
- Execution Lab paper trade
- Live-trade readiness checks only if paper behavior is clean

### Technical Tasks

- Run Finder on a small known 1s date range.
- Check that caching prevents excessive runtime.
- Compare mid-edge versus executable-edge behavior.
- Paper trade in Execution Lab using Start 1s Miner data.
- Confirm JSONL paper entries show expected YES/NO side and quote timing.
- Do not enable live trading until paper fill behavior is reviewed.

### Dependencies

- Phase 6 strategy.
- Local second-market DB coverage.

### Risks/Blockers

- Local data gaps can dominate results.
- Backtest profitability may depend on mid prices while live entries pay ask.
- Paper trade may reject late-event opportunities that Finder liked.

### Deliverables

- Short validation note with data range, symbol, strategy params, trade count, and missing quote rate.
- List of any live-readiness blockers.

### Validation/Testing Criteria

- `npm run typecheck`.
- `npm run test`.
- Existing 1s Polymarket tests remain green.
- Manual Execution Lab paper smoke passes without missing-context errors.

### Exit Criteria

- Candidate strategy is either accepted for more research or rejected with a concrete failure reason.

## Phase 8: Gamma Agreement Helper

### Objective

Add Gamma as an optional agreement source only after executable CLOB edge is validated.

### Scope

- `lib/strategies/lib/polymarket-1s-helpers.ts`
- `lib/execution-lab/execution-lab-strategy-context.ts` only if live Gamma support is intentionally added
- Focused helper tests
- `archive/prompt-1s-polymarket.txt` if Gamma becomes an allowed helper

### Technical Tasks

- Align latest Gamma snapshot causally by `snapshot_ts`.
- Normalize Gamma YES/NO probability.
- Compare Gamma probability to market probability.
- Compute consensus edge only when executable fair/CLOB edge and Gamma gap point the same way.
- Fail closed when Gamma snapshots are absent.
- Keep prompt wording explicit that Gamma cannot be the primary signal.

### Dependencies

- Phase 2 executable/fair probability frame.
- Phase 3 calibration findings.
- Existing `gammaSnapshots` in `Polymarket1sRuntimeContext`.
- Decision on whether live Gamma snapshots should be passed into Execution Lab strategy context.

### Risks/Blockers

- Execution Lab currently passes empty Gamma snapshots.
- Gamma timestamps may be lower frequency than 1s CLOB quotes.
- Gamma agreement can accidentally become the main signal if prompt wording is loose.

### Deliverables

- `buildPolymarket1sGammaAgreement(...)`.
- Tests for absent Gamma, causal alignment, and consensus direction.
- Prompt update that lists Gamma only as secondary agreement if the helper is implemented.

### Validation/Testing Criteria

- Helper unavailable when Gamma context is empty.
- Future Gamma snapshot does not affect prior bars.
- Consensus edge requires both fair/CLOB and Gamma agreement.

### Exit Criteria

- Gamma helper is safe for historical research and clearly fenced for live use.

## Documentation Updates

Update docs only when behavior changes.

Likely docs:

- `docs/polymarket.md` if helper behavior becomes a user-facing 1s strategy authoring contract.
- `docs/strategy-authoring.md` if the helper surface becomes part of recommended built-in strategy authoring.
- `archive/prompt-1s-polymarket.txt` after helpers exist.

Do not update endpoint, bridge, or worker docs unless those contracts change.

## Minimal First Implementation Recommendation

Implement in this order:

1. `buildPolymarket1sExecutableEdge(...)`
2. calibration and timing validation against local second-market data
3. `buildPolymarket1sActionabilityMask(...)`
4. binary agreement masks
5. `buildPolymarket1sReactionGap(...)`
6. `archive/prompt-1s-polymarket.txt` update using only implemented helpers
7. one minimal executable-edge strategy
8. Finder and Execution Lab paper validation
9. `buildPolymarket1sGammaAgreement(...)` only after deciding whether Gamma is needed live or only historical

Reason:

Executable ask-side edge directly addresses the current live problem: good chart signal, but bad or missing fill. Calibration must come before strategy generation because a model-vs-market gap is only useful if larger gaps correspond to better Polymarket outcomes after executable pricing and timing drift.
