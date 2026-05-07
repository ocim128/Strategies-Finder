# Polymarket Post-Signal Limit Entry Plan

## Goal

Add optional Polymarket limit-entry simulation after a modeled chart entry.

When enabled:

- a long trade attempts to buy YES
- a short trade attempts to buy NO
- the configured limit price is in cents for the selected side
- a trade is Polymarket-valid only if that side touches the limit price or better after the chart entry
- entries during the final 60 seconds before event resolution are invalid
- missed limit entries are counted in diagnostics, never in valid Polymarket entries
- existing exit modes stay unchanged

## Purpose

Answer:

- "After my signal fires, would a lower Polymarket entry price get filled?"
- "If it fills, is the Polymarket trade still profitable?"
- "How many signals are skipped because the lower entry never happens?"

## V1 Scope

- manual backtest Polymarket annotation
- Finder Polymarket mode
- Hunt runs that delegate to Finder Polymarket mode
- Quick View, Trades, and Polymarket diagnostics reload paths
- native `5m` Polymarket outcome session only
- existing local `polymarket_price_points`
- `resolve_hold`
- `signal_exit_same_event` only under the current `1m` + `next_open` + native `5m` gate

## Non-Goals

- worker alerts
- bridge export
- endpoint Preview / Copy / HTTP execution
- Strategy Ensemble Polymarket
- orderbook replay
- liquidity sizing
- spread modeling
- slippage modeling
- partial fills
- continuous position carry across Polymarket events
- candle high/low touch simulation
- native `15m` or `1h` limit-entry support

## Weaknesses Found And Fixes

| Weakness | Fix |
| --- | --- |
| "Signal" could mean raw strategy signal, signal candle close, or modeled entry. | Define the start as the normal chart trade `entryTime` after the current execution model. |
| The first plan put resolve-hold limit entry inside `polymarket-signal-exit-evaluator.ts`. | Create a small shared limit-entry helper and let signal-exit import it. |
| Support scope was too broad because current Polymarket sessions include `15m` and `1h`. | V1 is native `5m` only; hide the controls for other outcome sessions. |
| Missed limit entries could disappear from rows if represented as `null` annotations. | Store skipped limit attempts as non-scored annotations with a clear entry status. |
| Current signal-exit missing-price attempts do not claim an event. That would let a later same-event trade replace a missed limit. | Limit-entry mode uses stricter event claiming: the first event attempt claims the event whether filled or missed. |
| Finder could rank a tiny number of filled entries too highly. | `polymarketMinScored` applies to filled limit entries, and result cards must show attempts, missed count, and fill rate. |
| Adding more optional positional arguments to annotation helpers would be error-prone. | Convert Polymarket annotation inputs to a typed options object before adding limit-entry settings. |

## Product Decisions

- setting names:
  - `polymarketPostSignalLimitEntryEnabled`
  - `polymarketPostSignalLimitEntryPriceCents`
- default:
  - enabled: `false`
  - price: `50`
- input range:
  - integer cents
  - `1..99`
- internal price:
  - `limit = priceCents / 100`
- start timestamp:
  - use the normal chart trade `entryTime`
  - do not use raw strategy signal timestamps in v1
- fill condition:
  - side price `<= limit`
- filled entry price:
  - use the configured limit price, not the observed lower quote
- valid fill window:
  - `candidateStartTs <= quote.ts < event_end_ts - 60`
- invalid window:
  - if `candidateStartTs >= event_end_ts - 60`, count the attempt as `invalid_window`
- one Polymarket attempt per event:
  - the first eligible chart trade creates the event attempt
  - the attempt claims the event even when missed
  - later same-event trades are duplicates, not extra chances
- side price:
  - YES uses `yes_price`
  - NO uses `no_price` when present
  - if `no_price` is missing, use `1 - yes_price`
- base chart backtest:
  - unchanged
  - missed Polymarket limit entries do not remove chart trades
- exit mode behavior:
  - `resolve_hold` can fill until the final-minute cutoff
  - `resolve_hold` does not cancel because of the chart trade exit timestamp
  - `signal_exit_same_event` requires fill before the modeled signal-exit timestamp
- Polymarket metrics:
  - filled entries only
  - missed entries only appear in diagnostics and skip badges

## Phase 1 - Settings Contract

**Purpose**

Persist the feature without breaking saved configs.

**Changes**

- add fields to:
  - `lib/types/strategies.ts`
  - `lib/settings-model.ts`
  - `lib/backtest-settings-resolver.ts`
  - `lib/backtest-settings-dom-contract.ts`
  - `lib/polymarket-dom-reader.ts`
  - `lib/rust-settings-sanitizer.ts`
- default legacy configs to disabled
- clamp cents to `1..99`
- strip the new settings before Rust engine execution
- preserve the full settings for the Polymarket annotation post-pass

**Verification**

- old saved configs load with the feature disabled
- save/load preserves both new fields
- invalid cents values normalize to the valid range

## Phase 2 - UI Contract

**Purpose**

Expose the toggle only where Polymarket annotation can use it.

**Changes**

- add rows in `html-partials/tab-settings-section-execution.html`
- add structural ids to `lib/handlers/state-subscriptions-dom.ts`
- update visibility in `lib/handlers/state-subscriptions.ts`
- show rows only when Polymarket annotation is enabled
- show rows only when `polymarketOutcomeInterval === "5m"`
- rely on the existing `signal_exit_same_event` gate for `1m` + `next_open`
- add `feature-dom-contracts.spec.ts` coverage

**UI Labels**

- toggle: `Post-Signal Limit Entry`
- price input: `Limit Entry Price`
- hint: `Requires local Polymarket price points. Missed limit entries are skipped from Polymarket performance.`

**Verification**

- rows appear only with Polymarket annotation enabled
- rows hide when annotation is off
- DOM contract test passes

## Phase 3 - Price Point Helpers

**Purpose**

Use one deterministic touch detector across manual backtest, Finder, Hunt, and reload paths.

**Changes**

- extend `lib/polymarket-price-points.ts`
- add `lib/polymarket-post-signal-limit-entry.ts`
- add:
  - `getPolymarketSidePrice(point, side)`
  - `findPostSignalLimitEntryFill(eventPoints, input)`
- input fields:
  - `side`
  - `startTs`
  - `eventEndTs`
  - `limitPrice`
  - optional `latestAllowedTs`
- return fields:
  - `status`
  - `fillTs`
  - `fillPrice`
  - `firstAvailablePrice`
  - `firstDisallowedTouchTs`
  - `entryImprovement`
- statuses:
  - `filled`
  - `not_touched`
  - `last_minute_only`
  - `missing_price_points`
  - `invalid_window`
- never infer touches from OHLC candles

**Verification**

- fills at or below limit
- rejects quotes at `event_end_ts - 60` or later
- separates no data from no touch
- reports `last_minute_only` only when the first touch is in the rejected final-minute window
- derives NO from YES only when `no_price` is absent

## Phase 4 - Annotation Model

**Purpose**

Store limit-entry outcome without counting missed entries as valid trades.

**Changes**

- extend `TradePolymarketOutcome` in `lib/types/polymarket-outcomes.ts`:
  - `marketEntrySource?: "quote" | "limit"`
  - `marketEntryStatus?: "filled" | "not_touched" | "last_minute_only" | "missing_price_points" | "invalid_window" | "duplicate"`
  - `marketEntryFillTs?: number | null`
  - `marketEntryLimitPrice?: number | null`
- extend `BacktestPolymarketTradeSummary`:
  - `limitEntryEnabled?: boolean`
  - `limitEntryPriceCents?: number`
  - `limitEntryAttempts?: number`
  - `limitEntryFilledTrades?: number`
  - `limitEntryMissedTrades?: number`
  - `limitEntryNotTouchedTrades?: number`
  - `limitEntryLastMinuteOnlyTrades?: number`
  - `limitEntryMissingPriceTrades?: number`
  - `limitEntryFillRate?: number`
  - `avgLimitEntryWaitSec?: number`
  - `avgLimitEntryImprovement?: number`
- extend `PolymarketEvalResult` with matching Finder summary fields
- missed limit entries:
  - keep row-level skip context when useful
  - set `isWin`, `isProfitable`, `marketEntryPrice`, `marketExitPrice`, and `marketPnl` to `null`
  - do not increment `scoredTrades`
  - do not affect win rate, profit factor, expectancy, or net PnL

**Verification**

- filled trades count as scored Polymarket trades
- missed attempts count as missed diagnostics only
- summary fill rate uses attempts as denominator

## Phase 5 - Shared Evaluator

**Purpose**

Apply limit-entry semantics once and reuse them everywhere.

**Changes**

- create `lib/polymarket-post-signal-limit-entry.ts`
- keep `lib/polymarket-signal-exit-evaluator.ts` focused on signal-exit pricing
- import the shared limit-entry resolver from:
  - `lib/polymarket-signal-exit-evaluator.ts`
  - `lib/polymarket-trade-annotations.ts`
  - `lib/finder/finder-runner-polymarket.ts`
- shared resolver is used by:
  - signal-exit mode
  - resolve-hold mode when limit entry is enabled
- for limit entry:
  - candidate starts at the normal chart trade `entryTime`
  - event lookup uses the existing containing-event logic
  - price points are loaded by event key
  - filled entry price is `limitPrice`
  - fill timestamp is the quote timestamp that touched the limit
- for `resolve_hold`:
  - exit remains final event resolution
  - pending limit can fill until the final-minute cutoff
- for `signal_exit_same_event`:
  - existing signal-exit exit logic remains unchanged
  - limit fill must occur before the chart signal-exit timestamp
  - if fill would occur after the signal exit, mark `invalid_window`
- for time parsing:
  - use existing `parseTimeToUnixSeconds(...)`
  - keep all evaluator windows in unix seconds
- event claim rule:
  - first eligible event attempt claims the event
  - missed attempts remain visible in diagnostics
  - later same-event candidates become duplicates

**Verification**

- limit miss cannot be replaced by a later same-event winning trade
- signal-exit PnL uses delayed limit entry and existing exit quote
- resolve-hold payout uses delayed limit entry and final outcome

## Phase 6 - Manual Backtest Path

**Purpose**

Make regular Polymarket backtests use the shared limit-entry evaluator.

**Changes**

- update `lib/backtest-service.ts`
- replace positional annotation arguments with a typed options object before adding limit-entry options
- when limit entry is enabled:
  - ensure local price points for matched events
  - pass price points into annotation even in `resolve_hold`
- update `lib/polymarket-trade-annotations.ts`
- keep existing behavior when the toggle is off
- keep endpoint and ensemble callers fenced out

**Verification**

- toggle off matches current results
- toggle on reduces or equals scored Polymarket trades
- missed entries never improve Polymarket metrics by being counted as wins

## Phase 7 - Finder And Hunt

**Purpose**

Keep optimization results honest under the same fill rule.

**Changes**

- update `lib/finder/finder-runner-polymarket.ts`
- update `lib/finder-manager.ts`
- update `lib/hunt/hunt-model.ts`
- update `lib/hunt/hunt-service.ts`
- include the limit-entry settings in Finder options
- include limit-entry diagnostics in Finder results
- apply `polymarketMinScored` to filled limit entries, not attempts
- preserve the settings when applying Finder or Hunt results
- do not fan out by limit price in v1
- do not treat missed entries as scored predictions

**Verification**

- Finder rankings use filled entries only
- Finder candidates below min filled entries are rejected
- Finder result cards show fill count and missed count
- Hunt saved profiles preserve the two new settings

## Phase 8 - Diagnostics UI

**Purpose**

Show why Polymarket trade count changed.

**Changes**

- update:
  - `lib/quick-view/quick-view-service.ts`
  - `lib/quick-view/quick-view-renderer.ts`
  - `lib/renderers/tradesRenderer.ts`
  - `lib/polymarket-panel-service.ts`
  - `lib/polymarket-diagnostics-utils.ts`
- show summary cards:
  - attempts
  - filled
  - missed
  - fill rate
  - not touched
  - last-minute only
  - missing price data
  - average wait to fill
  - average entry improvement
- Trades row badges:
  - `Poly limit fill`
  - `Poly limit miss`
  - `Poly last-min`
  - `Poly no price`
- keep skipped rows out of Polymarket win/PnL totals

**Verification**

- Quick View and Polymarket tab agree after lazy reload
- Trades panel makes missed entries visible without labeling them wins

## Phase 9 - Fences And Docs

**Purpose**

Prevent partial support from leaking into unsupported surfaces.

**Changes**

- strip or ignore the new settings in:
  - `lib/backtest-endpoint-copy.ts`
  - `lib/backtest-endpoint-execution.ts`
  - `lib/backtest-executor.ts`
  - Strategy Ensemble Polymarket paths
  - bridge export scripts
  - worker alert paths
- update:
  - `docs/polymarket.md`
  - `README.md` only if the top-level Polymarket feature summary changes

**Verification**

- endpoint payloads do not silently include the new settings
- bridge export remains unchanged
- worker payloads remain unchanged

## Phase 10 - Tests

**Purpose**

Lock down the anti-fake-performance behavior.

**Add Or Update**

- `tests/polymarket-post-signal-limit-entry.spec.ts`
- `tests/polymarket-signal-exit.spec.ts`
- `tests/polymarket-trade-annotations.spec.ts`
- `tests/finder-polymarket.spec.ts`
- `tests/quick-view-polymarket.spec.ts`
- `tests/settings-compat.spec.ts`
- `tests/feature-dom-contracts.spec.ts`

**Required Cases**

- limit disabled preserves existing results
- YES fills when YES price touches limit
- NO fills from `1 - YES` when `no_price` is missing
- price never touches means missed, not scored
- price touches only in final 60 seconds means missed, not scored
- missing price points are counted separately from no touch
- first missed event attempt blocks later same-event candidates
- filled entry uses configured limit price
- resolve-hold can fill after chart exit but before event cutoff
- signal-exit rejects fills after chart signal exit
- Finder rank metrics exclude missed entries
- Finder min scored uses filled entries
- Quick View reload keeps the same fill diagnostics

## Validation Commands

- `npm run typecheck`
- `npm run test -- polymarket-post-signal-limit-entry`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-signal-exit.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\polymarket-trade-annotations.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\finder-polymarket.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\quick-view-polymarket.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\settings-compat.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

## Success Criteria

- user can enable post-signal limit entry and set a side price in cents
- Polymarket scored trades only include filled limit entries
- missed limit entries are visible in diagnostics
- missed limit entries never count as wins, losses, PnL, or valid entries
- entries in the final 60 seconds before resolution are rejected
- each event has at most one limit-entry attempt
- Finder cannot pass min scored using missed attempts
- current Polymarket results are unchanged when the toggle is off
- manual backtest, Finder, Hunt, Quick View, Trades, and Polymarket diagnostics agree
