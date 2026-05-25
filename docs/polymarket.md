# Polymarket Guide

This repo has several Polymarket features that share UI space but use different runtime contracts.

Keep these paths separate:

- direct Polymarket market charting
- Polymarket outcome scoring for backtests, Finder, and Hunt
- diagnostics on scored trades and deployability analysis helpers
- bridge export for downstream `external_signal` bots
- Execution Lab live trade through a local executor

Most Polymarket regressions come from mixing those paths together.

## Quick Answers

If you want to open a Polymarket market on the chart:

- use the `PM` button in the timeframe bar, or search/paste a Polymarket slug or event URL
- this uses the Polymarket data provider, not the outcome-scoring path

If you want to score a strategy against resolved Polymarket crypto events:

- enable `Polymarket Annotation`
- use `executionModel = next_open`; supported `1s` CLOB backtests also support `signal_close` and `next_close`
- choose `Polymarket Outcome Session`:
  - `5m` stays the default
  - `15m` and `1h` use native Polymarket session rows instead of the old `5m` bridge
- sync local outcome rows first with `npm run poly:sync-outcomes:all`
- optionally set `Polymarket Outcome Symbol` if the chart symbol is different from the outcome target
- choose `Polymarket Exit Mode`:
  - `resolve_hold` scores at final event resolution on supported chart intervals, including supported `1s` BTCUSDT/XRPUSDT CLOB runs
  - `signal_exit_same_event` is effective on `1m` + `next_open` using locally cached Polymarket price points, and on supported `1s` BTCUSDT/XRPUSDT CLOB runs using `signal_close`, `next_open`, or `next_close` exact-second bid/ask rows
  - `chart_exit_same_event` uses the same support gates and price sources as `signal_exit_same_event`, but exits the Polymarket leg at the chart trade close timestamp for any non-`end_of_data` chart exit reason
- optionally set `Polymarket Entry Price Filter`; for example, `20` skips trades whose selected Polymarket entry price is at or below 20c or at or above 80c
- optionally enable `Polymarket Entry Cutoff` in Backtest Realism; it defaults off, and when enabled the seconds field defaults to `15`
- on supported `1s` CLOB runs, optionally enable Polymarket Take Profit and/or Stop Loss. In same-event exit modes, TP fills at the target limit price and SL fills at the first sell-side quote after entry that reaches the stop threshold. In `resolve_hold`, Execution Lab holds the Polymarket leg to final resolution and ignores chart exits, signal exits, TP, and SL.
- optional for native `5m` outcome sessions, including supported `1s` CLOB runs: enable `Post-Signal Limit Entry` to require the selected YES/NO side to trade at or below the configured limit price after the chart entry signal and before the event's final minute; on supported `1s` CLOB runs, `stale_signal_price` uses the original chart-entry quote as the limit and begins checking after `polymarketEntryDelayBars`
- `Disable Exit Signal` lives in Risk Management, not Polymarket. It is effective only when chart TP or SL is active and lets chart entries continue to be signal-based while exits come from chart risk exits or forced Polymarket protective exits.

If you want to manually paper-trade the latest still-open backtest trade:

- open the `Trades` panel on a supported `1m` or `5m` Polymarket-annotatable run
- `Poly open` is only authoritative when it is worker-backed
- that badge now appears only when the matching alert subscription is actively polling through `Live Positions`, the worker still reports the position open, and the local backtest agrees on which trade is open
- if worker/local state diverges, the Trades panel stays silent instead of guessing

If you want bridge files for `external_signal`:

- use the `Polymarket` strategy-panel tab
- select a saved config
- stay on a supported `5m` chart
- bridge export does not consume `polymarketExitMode`; it stays an entry-signal bundle contract

If you want endpoint Preview / Copy or Strategy Ensemble parity:

- both stay on `resolve_hold`
- `signal_exit_same_event` is explicitly fenced out there

If you want Execution Lab live trading:

- use the Execution Lab tab on supported `1s` BTCUSDT/XRPUSDT `signal_close`, `next_open`, or `next_close` runs
- keep Paper Trade as the default until dry-run executor preflight is clean
- configure Strategy Finder `.env` with the local executor path or optional `EXECUTION_LAB_LIVE_EXECUTOR_URL`, plus the live-enabled flag
- configure the side executor repo with the private key, signature mode, stake cap, `FAK`/`FOK` taker order type, `GTC` limit order type, and `LIVE_TRADE_ONCE_LIVE_ENABLED`
- live entries buy the same YES/NO side accepted by the paper decision path
- paper/live entries use the Backtest Realism `Polymarket Entry Cutoff` toggle; when enabled, entries inside that event-close window are skipped in paper and rejected as `event_too_close_to_close` in live if the current clock has crossed the same cutoff
- for `signal_close` and `next_close` 1s runs, Execution Lab paper fills use the quote one second after the chart candle timestamp, matching the close-based CLOB scoring contract
- Execution Lab has separate `Poly TP` and `Poly SL` controls in its Live Config panel. These controls apply to open paper positions. When Live Trade is active, a confirmed live entry with TP enabled immediately submits a resting GTC sell-limit for the filled shares; SL remains a tracked-share taker exit when the paper SL trigger fires.
- live exits sell tracked filled shares for the same token when the matching paper trade emits `paper_exit`
- order-status polling is still not implemented. A posted TP is tracked locally by request/order id; when the paper TP trigger appears, Strategy Finder treats the resting TP as the intended live exit.
- browser code must never receive private keys; it sends only request intent to the local executor endpoint

If you want to author 1s Polymarket-aware strategies:

- declare `polymarket1sConfig: { required: true }`
- use helpers from `lib/strategies/lib/polymarket-1s-helpers.ts`
- prefer executable ask-side edge, actionability, and persistence checks when the goal is live/paper deployability
- treat Gamma as secondary agreement only; Execution Lab live context may not provide Gamma snapshots
- fail closed when the helper frame is unavailable

## The Five Polymarket Contracts

### 1. Direct Polymarket market charting

This is the provider path for opening a real Polymarket event market as chart data.

Important behavior:

- accepts full Polymarket event URLs
- accepts canonical inputs like `PM:<slug>`, `polymarket:<slug>`, or plain event slugs
- accepts side selection via `:up`, `:down`, `:yes`, `:no`, or URL query params `outcome` / `side`
- the `PM` button opens Polymarket markets on `1m` first
- chart candles come from Polymarket history, not SQLite outcome rows

Core files:

- `lib/dataProviders/polymarket.ts`
- `lib/asset-search-service.ts`
- `lib/handlers/ui-event-handlers.ts`
- `html-partials/header.html`

### 2. Outcome scoring and annotation

This is the research path for asking whether executed chart trades would have been correct on the Polymarket contract and, in `1m` signal-exit or supported `1s` CLOB mode, what the realized Polymarket trade PnL would have been.

Important behavior:

- scores executed trades, not raw signals
- uses local SQLite outcome rows, not live outcome fetches during evaluation
- `polymarketOutcomeInterval` selects which native outcome session rows to load; default is `5m`
- native `15m` and `1h` runs match each trade to the containing Polymarket session event
- same-event exit modes also use local SQLite price points for intra-event pricing
- `1s` BTCUSDT/XRPUSDT runs use the separate second-market SQLite DB and executable CLOB bid/ask quotes sampled by `sample_ts`
- post-signal limit entry is an optional `5m` outcome-session overlay that uses local SQLite price points to decide whether a chart trade would have filled at a fixed limit price or a signal-quote offset before scoring it
- `lib/polymarket-outcome-evaluator.ts` remains the headless resolve-hold helper when the caller only supplies outcome rows
- stores the resolved target on `BacktestResult.polymarketTradeSummary.outcomeSymbol` so later UI reloads do not drift
- stores the applied evaluation mode on `BacktestResult.polymarketTradeSummary.evaluationMode`
- stores the applied native session on `BacktestResult.polymarketTradeSummary.outcomeInterval`
- stores post-signal limit-entry attempts, fills, misses, duplicate attempts, fill rate, wait time, average entry improvement, and optional target-exit counts when the overlay is enabled
- stores Polymarket protective TP/SL exits as `marketExitSource = protection_take_profit` or `protection_stop_loss`, with summary counts on `protectionTakeProfitExitedTrades` and `protectionStopLossExitedTrades`
- manual supported `1s` backtests replay Polymarket protective exits as chart trade exits with `exitReason = polymarket_take_profit` or `polymarket_stop_loss`, so later chart entries can occur after the Polymarket leg has exited

Core files:

- `lib/polymarket-btc5m.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-outcome-evaluator.ts`
- `lib/polymarket-exit-mode.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-price-points-ingest.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/second-market/evaluation.ts`
- `lib/second-market/finder-runner.ts`

### 3. Diagnostics and analysis helpers

This is the read and analysis layer on top of scored trades.

It powers:

- Quick View payout diagnostics
- Trades panel outcome badges
- the `Polymarket` strategy-panel diagnostics tab
- headless fillability and deployability analysis helpers

Important behavior:

- Quick View, Trades, and the Polymarket tab can rebuild Polymarket annotations lazily
- when the active result uses a same-event exit mode, the lazy rebuild path also ensures local price points before recomputing
- when the active result is a supported `1s` BTCUSDT/XRPUSDT spot or futures run, Quick View can rebuild strict CLOB annotations from the second-market DB
- the Polymarket tab renders diagnostics only; `lib/polymarket-deployability-analysis.ts` remains a headless analysis module and is not wired into the visible tab UI

Core files:

- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`
- `lib/polymarket-diagnostics-utils.ts`
- `lib/polymarket-fill-history.ts`
- `lib/polymarket-deployability-analysis.ts`

### 4. Bridge export

This is a separate contract for generating local bridge files and bot env snippets.

Important behavior:

- uses the current chart symbol and interval, not `polymarketOutcomeSymbol`
- requires a saved config
- only supports supported crypto symbols on `5m`
- blocks cross-symbol strategies
- keeps `polymarketEntryOffset` in the JSON signal payload when present
- does not switch to `signal_exit_same_event`

Core files:

- `html-partials/tab-polymarket.html`
- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`

### 5. Execution Lab live trade

This is the local live-order path for selected `1s` paper decisions. It is not scoring, charting, diagnostics, or bridge export.

Important behavior:

- Paper Trade remains the startup default and writes JSONL paper records only
- Live Trade requires an explicit UI mode switch and confirmation
- Strategy Finder reads local executor path/cwd/args or optional `EXECUTION_LAB_LIVE_EXECUTOR_URL`, hard live enablement, timeout/output limits, geoblock display state, fallback order settings, and optional broad cancel scope from `.env`
- Execution Lab UI owns non-secret per-browser live behavior: order mode, taker order type, live sizing mode, max stake cap, entry/exit slippage, protective TP/SL toggles and cent offsets, limit offset, and limit cancel-on-exit
- the local executor process reads wallet secrets from its own server-side `.env`
- taker mode uses `FAK` or `FOK`; `.env` fallback accepts `EXECUTION_LAB_LIVE_TAKER_ORDER_TYPE`, `EXECUTION_LAB_LIVE_ORDER_TYPE`, or `ARBITRAGE_ORDER_TYPE` before falling back to `FAK`
- limit mode uses `EXECUTION_LAB_LIVE_LIMIT_ORDER_TYPE=GTC` as the current resting order type
- Strategy Finder infers the side-repo working directory for `target/debug` and `target/release` executor binaries; otherwise set `EXECUTION_LAB_LIVE_EXECUTOR_CWD` so the executor loads the correct `.env`
- entry requests buy the paper-selected YES/NO token with `maxPrice` capped at the paper entry price plus configured entry slippage
- limit entry requests submit immediately with `limitPrice` derived from the paper entry reference price minus optional UI offset; they also include `maxPrice = limitPrice` for executor schema compatibility and may rest unfilled
- the Backtest Realism `Polymarket Entry Cutoff` toggle is applied before paper entries are accepted, so Execution Lab paper PnL and live eligibility use the same event-close cutoff when the toggle is enabled
- UI or fallback `exchange_min` sizing allows live entries to auto-size to the minimum valid Polymarket order, still capped by the effective Strategy Finder cap and `MAX_ORDER_SIZE_USDC`
- exit requests sell the tracked filled shares of the same token with `minPrice` floored by the configured exit slippage against the lower of paper exit price and actual live entry fill
- Polymarket TP submits an immediate resting GTC sell-limit after a confirmed live entry fill. When the paper TP fires while that order is still tracked, Strategy Finder target-cancels the resting TP before using the tracked-share taker exit path; only a `not_canceled` response is treated as local evidence that the resting TP may already have filled.
- posted or delayed limit entries remain pending until the executor reports matched/partial filled shares, or until an exit-triggered targeted cancel returns `not_canceled`; the latter is promoted to a provisional live position so the normal exit sell is attempted
- known posted Strategy Finder order ids are targeted-canceled on paper exit by default, even when broad cancel-on-exit is off; broad account cancellation requires explicit scope configuration and is shown in UI status and JSONL logs
- if a paper exit is expected but the exact second-market exit quote is missing, a matching tracked live position still queues an exit using the latest same-event bid as the first floor reference when available
- while the latest same-event bid is already below the exit floor, Strategy Finder records a local rejected exit attempt every one-second retry cooldown instead of silently hiding the loop
- rejected or failed live exits can retry with fresh request ids; `delayed` and `posted_live` stop blind retries until reconciliation
- executor geoblock preflight failures are treated as live safety rejections and block further Strategy Finder live submissions for the current session
- if a paper entry and paper exit first appear in the same poll batch, the live entry is rejected as `paper_exit_same_tick`
- live submission is registered only in the Vite dev server path unless preview live trading is explicitly allowed
- duplicate live request ids are coalesced by a process-local Strategy Finder ledger before invoking the executor; the executor still owns the durable idempotency ledger
- Strategy Finder writes the `live_*_request` JSONL record before invoking the executor, then writes the result record after the adapter returns
- the live tick path reuses complete local second-market candle ranges and exact local CLOB quotes when available; if the latest exact quote is missing, a same-event local quote up to two seconds old may be used with `recent_local_fallback` quality flags before live CLOB REST fallback

Core files:

- `html-partials/tab-execution-lab.html`
- `lib/execution-lab/execution-lab-service.ts`
- `lib/execution-lab/live-trade-request.ts`
- `lib/execution-lab/live-executor-adapter.ts`
- `lib/execution-lab/execution-lab-vite-plugin.ts`
- `docs/live-trade-plan.md`

## Exit Modes

The canonical resolver for effective exit-mode gating is `resolveEffectivePolymarketExitMode(...)` in `lib/polymarket-exit-mode.ts`. If this section, the support matrix, or the settings rules below change, keep all three aligned with that helper and its focused tests.

### `resolve_hold`

This is the default mode.

Behavior:

- keeps the existing final-outcome scoring path
- native `5m`, `15m`, and `1h` use direct session rows
- `1m` uses the `1m -> 5m` bridge with two entry-selection modes:
  - `fixed_offset` keeps the existing `polymarketEntryOffset` filter
  - `actual_entry_minute` scores the first eligible trade per `5m` event and uses that trade's real minute for entry pricing while still holding to final resolution
- supported `1s` BTCUSDT/XRPUSDT charts use exact-second CLOB entry pricing under `signal_close`, `next_open`, or `next_close`; other execution models keep `resolve_hold` selected but skip the CLOB annotation pass
- if a synced local outcome row is missing for a supported `1s` run, a decisive final CLOB quote at the event close can infer the final binary outcome for resolve-hold scoring
- for regular backtest annotation, Polymarket Take Profit is ignored in `resolve_hold`; Polymarket Stop Loss remains active because it is a protective failure exit before final resolution
- native `15m` and `1h` use the first local price point at or after the chart trade entry when payout diagnostics need an entry price
- Quick View uses annotated Polymarket payout data for its Performance expectancy card when resolve-hold trades have priced Polymarket outcomes
- the Trades panel now keeps row-level skip context on `1m` resolve-hold runs:
  - `Poly skip mN` means the trade was filtered out by the active fixed minute selection because it entered on minute `N`
  - `Poly dup` means another trade in that same scored event already claimed the Polymarket slot
- Finder also supports the existing `15m`, `1h`, and `4h` resolve-hold paths
- metrics stay classification-first: wins, losses, win rate, baseline delta, break-even style payout diagnostics

### Same-Event Exit Modes

`signal_exit_same_event` and `chart_exit_same_event` are pricing-aware modes.

Effective gating:

- annotation must be enabled
- chart interval must be `1m` with execution model `next_open`, or a supported `1s` BTCUSDT/XRPUSDT CLOB run with execution model `signal_close`, `next_open`, or `next_close`
- supported `1s` charts use this mode only when it is selected; unsupported 1s execution models downgrade to `resolve_hold` through `resolveEffectivePolymarketExitMode(...)`

Behavior:

- uses the normal chart backtest only for timing
- for `1m`, because chart timing comes from the shared `next_open` engine, a full `signal` exit blocks re-entry on that same bar; the earliest new chart entry is the next `1m` bar
- long trades buy YES; short trades buy NO
- entry fill uses the first locally captured side price at or after the chart trade entry timestamp inside the containing `5m` event
- `signal_exit_same_event` exits from cached Polymarket quotes only when `trade.exitReason === "signal"` and the chart exit timestamp is still inside the same event
- `chart_exit_same_event` exits from cached Polymarket quotes when the chart trade closes for any non-`end_of_data` reason and the chart exit timestamp is still inside the same event
- for `1m` + `next_open`, that exit timestamp is the modeled next bar open from the shared backtest engine, not an intraminute wall-clock guess
- for supported `1s` CLOB runs, the entry and signal-exit fills use strict exact-second bid/ask quotes from the second-market DB; `next_open` uses the chart trade timestamp directly, while `signal_close` and `next_close` use one second after the chart candle timestamp because Binance `1s` candles are stored by open time
- supported `1s` Finder runs surface local CLOB quote truncation separately from low exact-second quote coverage
- `polymarketEntryDelayBars` is a research-only `1s` CLOB annotation delay; when set to `N`, the chart trade stays at the same timestamp but the Polymarket entry quote is priced `N` seconds after the modeled chart entry
- Polymarket protective TP/SL applies after the entry quote and before the modeled chart trade exit or event resolution. If TP and SL both appear on the same quote timestamp, SL wins because the local data cannot prove intrasecond ordering.
- TP protection fills at `entryPrice + polymarketProtectionTakeProfitCents / 100`, capped below `1.00`; SL protection fills at the observed sell-side quote when it reaches `entryPrice - polymarketProtectionStopLossCents / 100`.
- `polymarketBacktestSlippageCents` is a backtest-only adverse fill adjustment; entries pay that many cents more and modeled exits receive that many cents less
- post-signal limit entries keep the filled limit price, and filled target exits keep the target price; quote-style signal exits and resolve-hold settlement exits apply the backtest slippage adjustment
- example: if the opposite chart signal is detected on the `15:02` candle, the modeled chart exit is `15:03:00`, so the Polymarket exit uses the latest local quote at or before `15:03:00`
- the signal-exit quote must not be earlier than the chosen entry quote
- with zero backtest slippage, if the latest locally captured quote before the chart exit is the same quote that was used for entry, the trade scores as a flat same-event exit instead of being dropped
- if no eligible same-event chart exit applies, the Polymarket leg settles to final binary resolution at event end
- by default, only the first eligible trade per `5m` event is scored; later duplicates in that event are ignored
- when `polymarketSignalExitAllowMultipleTradesPerEvent` is enabled, every eligible chart trade inside the same event is scored instead of marking later trades as duplicates
- `polymarketEntryPriceFilterCents` skips trades with selected entry prices at or below `N` cents or at or above `100 - N` cents; skipped trades do not claim the same-event slot before duplicate detection
- missing-price attempts do not claim the event; with the default event cap, the first scorable trade claims it and later scored attempts in that `5m` event are reported as duplicates instead of adding extra scored trades
- if the entry quote is missing, the trade is unscored
- if a same-event signal exit is required but no usable exit quote exists, the trade is unscored and counted as a missing-price trade
- in the Trades panel, worker-backed live-open rows can render `Poly open`; otherwise missing-price or current-bucket unresolved rows stay unscored / silent rather than claiming live-open state from `end_of_data`
- only `exitReason === "signal"` can close early in this mode; stop-loss, take-profit, trailing stop, time stop, partial, probation fail, and end-of-data all settle at final outcome

PnL semantics:

- `marketPnl = marketExitPrice - marketEntryPrice`
- `isProfitable` means realized Polymarket PnL was greater than zero
- zero PnL is neutral, not profitable and not losing
- Quick View and the Polymarket diagnostics tab label signal-exit rates as profitable-trade rates, not prediction-accuracy win rates
- neutral scored trades stay visible as neutral / flat instead of being folded into losses
- summary metrics shift to priced-trade behavior:
  - profitable trades
  - losing trades
  - signal-exited trades
  - resolved trades
  - missing-price trades
  - net PnL
  - expectancy
  - profit factor

Sized bankroll overlay:

- manual annotated runs can add dollar sizing only when Alternative Sizing is enabled and the resolved sizing mode is not `percent`
- chart backtest PnL, chart trade size, and chart equity are unchanged
- Polymarket stake is dollars spent to buy YES/NO shares
- Fixed Amount uses the configured Base Trade Amount; Polymarket multiplier and fallback sizing use a $1 base trade amount, independent of the chart backtest Base Trade Amount
- Kelly uses Polymarket return per $1 staked for its history; after enough valid win/loss history, the stake is a bankroll fraction instead of the $1 fallback
- shares are `sizedStake / marketEntryPrice`
- sized dollar PnL is `sizedShares * marketPnl`, with resolve-hold fallback from final binary payout when needed
- martingale, anti-martingale, Kelly, Optimal f, and related sizing state updates use Polymarket dollar PnL, not chart trade PnL
- stakes are capped to the available Polymarket bankroll; later eligible trades are skipped once bankroll is depleted
- Trades shows `Poly Stake`, share count, entry price, and dollar profit when sized fields exist
- percent mode keeps existing per-share Polymarket diagnostics only

### Post-signal limit entry

This is an optional entry-fill overlay, not a third exit mode.

Effective gating:

- annotation must be enabled
- `Polymarket Outcome Session` must be `5m`
- the overlay is available in `resolve_hold` and same-event exit modes
- fixed entry limit price is stored as cents and normalized to `1..99`; default is `50`
- entry offset is stored as cents and normalized to `0..99` with 0.1c precision; default is `20`

Behavior:

- long chart trades attempt to buy YES; short chart trades attempt to buy NO
- the attempt starts at the chart trade entry timestamp; on supported `1s` CLOB runs, `polymarketEntryDelayBars` pushes the start later by that many seconds
- fixed-price entry mode fills when the side price is at or below `polymarketPostSignalLimitEntryPriceCents` before `event_end_ts - 60`
- signal-offset entry mode computes the limit from the aligned entry-side quote minus `polymarketPostSignalLimitEntryOffsetCents`; for example, a 60c first YES quote with offset `0.5` becomes a 59.5c entry limit
- on supported `1s` CLOB runs, signal-offset mode must have a usable quote at the modeled entry second; it does not look ahead to a future quote to choose the limit price
- on supported `1s` CLOB runs, signal-offset mode with a `0` cent offset is treated as normal quote entry so it matches disabled limit-entry scoring
- stale-signal entry mode is for supported `1s` CLOB delay research: it reads the selected side ask at the modeled chart-entry second, then starts the limit-fill scan after `polymarketEntryDelayBars`; if the delayed market has already moved away and never revisits that stale limit before the same-event signal exit, the trade is reported as missed instead of scored
- if the contract touches only during the final minute, the attempt is reported as `last_minute_only` and is not scored
- if the active same-event exit mode has an eligible chart exit before the limit touch, the attempt is reported as `invalid_window` and is not scored
- filled/scored attempts claim the event when duplicate suppression is active; missed attempts do not block a later same-event attempt from filling
- filled attempts use the resolved limit price as `marketEntryPrice`, not the first observed quote
- missed attempts stay visible in Trades, Quick View, and Polymarket diagnostics, but they do not count as scored Polymarket trades
- when `no_price` is absent from price points, NO can be derived as `1 - yes_price`; explicit `no_price` wins when present

Optional target exit:

- target exit is scoped to post-signal limit-entry fills
- fixed target mode exits when the filled side reaches `polymarketPostSignalLimitExitPriceCents`
- entry-offset target mode exits when the filled entry price plus `polymarketPostSignalLimitExitOffsetCents` is reached; for example, a 60c filled entry with offset `20` targets 80c
- if the computed target is `>= 100c`, the target is marked `unreachable` and the trade falls back to the active exit model
- in `resolve_hold`, a target touch exits before final resolution; if target never fills, the trade holds to resolution
- in same-event exit modes, target exit and the eligible chart exit race by timestamp; the first fill executes, and no later exit is applied
- target-exited trades use realized `marketPnl = marketExitPrice - marketEntryPrice` in payout diagnostics and Finder ranking

## Supported Outcome Targets

The repo-level Polymarket crypto outcome target symbols are fixed:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`
- `XRPUSDT`

These map to fixed SQLite `series_id` values in `lib/polymarket-btc5m.ts`.

If you add another target, update:

- `lib/polymarket-btc5m.ts`
- `scripts/polymarket-sync-outcomes.ts`
- `html-partials/tab-settings-section-execution.html`
- support messages in Finder / panel / ensemble paths
- focused Polymarket tests

## Support Matrix

| Surface | `resolve_hold` | Same-event exit modes | Post-signal limit entry | Important notes |
| --- | --- | --- | --- | --- |
| Direct Polymarket charting | not applicable | not applicable | not applicable | provider path only |
| Manual backtest annotation | native `5m` / `15m` / `1h`, existing `1m` / `15m` / `1h` / `4h` bridge paths, and supported `1s` + `signal_close`, `next_open`, or `next_close` CLOB runs | `1m` + `next_open` on the selected native outcome session; supported `1s` + `signal_close`, `next_open`, or `next_close` uses exact-second CLOB exits inside the event; `signal_exit_same_event` is signal-only and `chart_exit_same_event` uses chart trade close | native `5m`, including supported `1s` CLOB runs | same chart backtest, Polymarket post-pass |
| Headless `evaluatePolymarketOutcomes(...)` | resolve-hold only | not supported | not supported | caller supplies outcome rows only; no price-point input surface |
| Finder Polymarket mode | `1m`, `5m`, `15m`, `1h`, `4h`, and supported `1s` + `signal_close`, `next_open`, or `next_close` CLOB runs | `1m` + `next_open`; supported `1s` + `signal_close`, `next_open`, or `next_close` uses exact-second CLOB exits inside the event | native `5m`, including supported `1s` CLOB runs | `grid` and `random` only; no combo; no multi-timeframe |
| Hunt | same as Finder | same as Finder | same as Finder | preserves Polymarket mode settings in profiles |
| Quick View / Trades / Polymarket diagnostics reload | can reuse stored summary broadly; native `15m` / `1h` show summary and payout cards; supported `1s` spot/futures resolve-hold summaries rebuild with CLOB entry pricing when needed | `1m` when price points are available or can be ensured; supported `1s` spot/futures + `signal_close`, `next_open`, or `next_close` uses exact-second CLOB rows | reloads `1m` price points or `1s` CLOB quotes for `5m` limit attempts | active consumers, not passive renderers |
| Endpoint Preview / Copy / HTTP execution | `resolve_hold` only | not supported | not supported | exit mode and limit-entry settings are stripped |
| Strategy Ensemble Polymarket | `resolve_hold` only | not supported | not supported | explicit fence in the ensemble path |
| Bridge export | separate contract | separate contract | separate contract | ignores scoring-mode settings; still chart-symbol `5m` entry-signal export |
| Execution Lab Paper/Live Trade | not a scoring surface | supported `1s` BTCUSDT/XRPUSDT `signal_close`, `next_open`, or `next_close` CLOB decision path | entry filter applies through the paper decision path | browser intent plus local executor; no browser secrets |

Two important nuances:

- `signal_exit_same_event` is intentionally signal-only; use `chart_exit_same_event` when TP/SL/time-stop chart closes should price the Polymarket exit.
- endpoint and ensemble surfaces still expose Polymarket annotation, but only in `resolve_hold`.
- post-signal limit entry is intentionally limited to the native `5m` outcome session because it depends on intra-event price-point replay.

## Outcome And Price Data Model

Outcome scoring is built around local SQLite rows, not live remote outcome fetches during evaluation.

Main outcome-row contract:

- `lib/types/polymarket-outcomes.ts`

Each `PolymarketOutcomeRow` contains:

- fixed `series_id`
- event and market slug
- `event_start_ts` and `event_end_ts`
- YES and NO token ids
- YES checkpoint prices at:
  - open
  - `+1m`
  - `+2m`
  - `+3m`
  - `+4m`
- `resolved_outcome_up`

Signal-exit mode and post-signal limit entry add a second local data surface:

- SQLite table: `polymarket_price_points`
- browser API: `loadPolymarketPricePoints(...)`
- browser API: `storePolymarketPricePoints(...)`
- browser API: `ensurePolymarketPricePoints(...)`

Each `PolymarketPricePoint` contains:

- `series_id`
- `event_start_ts`
- `event_end_ts`
- `market_slug`
- YES and NO token ids
- quote timestamp `ts`
- `yes_price`
- `no_price`
- `updated_at`

Relevant Vite SQLite routes:

- `/api/sqlite/load-polymarket-outcomes`
- `/api/sqlite/store-polymarket-outcomes`
- `/api/sqlite/load-polymarket-price-points`
- `/api/sqlite/store-polymarket-price-points`
- `/api/sqlite/ensure-polymarket-price-points`

Important behavior:

- long outcome-row ranges are loaded in pages from `/api/sqlite/load-polymarket-outcomes`; response metadata can include `limit`, `truncated`, `nextAfterStartTs`, and `nextAfterEventSlug`
- price points are event-keyed, not treated as one continuous market series
- `ensurePricePointsForOutcomes(...)` loads existing local rows by event start, treats a session as covered only when local quotes reach near `event_end_ts`, then fetches missing event histories and stores the missing rows locally
- price-point ensure calls are chunked client-side, and `/api/sqlite/ensure-polymarket-price-points` rejects requests above its per-request outcome cap
- first-run signal-exit or post-signal limit-entry backtests or Finder runs may trigger on-demand price-point ingestion
- there is no separate manual sync command required for price points
- outcome rows still require the normal `poly:sync-outcomes` flow
- direct Polymarket proxy routes use bounded upstream timeouts and return `504` on proxy timeout

## Sync Workflow

Outcome scoring only works after the local SQLite outcome rows exist.

Run from this repo with `npm run dev` active unless you are using `--dry-run`.

Common commands:

```bash
npm run poly:sync-outcomes
```

```bash
npm run poly:sync-outcomes:all
```

```bash
npm run poly:sync-outcomes:repair
```

```bash
npm run poly:sync-outcomes:repair:all
```

Direct single-symbol sync:

```bash
..\..\..\node_modules\.bin\esno scripts\polymarket-sync-outcomes.ts --symbol BTCUSDT
```

Useful notes:

- default `npm run poly:sync-outcomes` syncs the default BTC series
- `--interval 5m|15m|1h` selects one native outcome session
- `--all` walks all supported symbols; without `--interval` it expands across `5m`, `15m`, and `1h`
- existing rows are skipped by default
- `--refresh-recent <n>` or the `:repair` scripts rewrite recent rows after sync logic changes
- the sync script fetches remote Polymarket outcome data, normalizes it, then writes through the local Vite SQLite endpoint

Price points are different:

- they are ensured on demand by the scoring surfaces that need them
- they are fetched from Polymarket history by event and cached into `polymarket_price_points`

1-second Polymarket research has a separate implementation plan:

- [1-Second Polymarket Data Plan](second-polymarket-data-plan.md)

## Finder And Hunt Behavior

Finder uses a dedicated Polymarket runner instead of bolting scoring onto the normal sort path.

Current behavior:

- file: `lib/finder/finder-runner-polymarket.ts`
- loads outcome rows once per run
- native `15m` and `1h` Finder runs load the selected native session rows, not grouped `5m` rows
- native `15m` and `1h`, plus same-event exit modes, ensure price points once per run
- default `5m` keeps the older bridge fan-out for `1m`, `15m`, `1h`, and `4h` resolve-hold runs
- supports cross-symbol outcome scoring through `backtestSettings.polymarketOutcomeSymbol`
- reuses normal strategy execution and backtest machinery
- applies same-event exit evaluation through the shared evaluator, not a Finder-only pricing path
- applies post-signal limit entry through the same shared annotation/evaluator paths used by manual backtests

Signal-exit restrictions:

- `grid` and `random` only
- `multiTimeframeEnabled` is blocked
- `comboEnabled` is blocked
- supported rank modes:
  - `expectancy`
  - `expectancyTrades`
  - `profitFactor`
  - `profitFactorTrades`
  - `sizedNet`
- blocked rank modes:
  - `balanced`
  - `accuracy`
  - `volume`

Important same-event exit differences versus the old `1m` bridge mode:

- Finder does not fan out one parameter set into five offset variants
- `polymarketEntryOffset` is ignored in same-event exit modes
- `polymarketLockOffset` becomes irrelevant and the UI disables it
- same-event exit results are per-event by default; when `polymarketSignalExitAllowMultipleTradesPerEvent` is enabled, Finder and Hunt rank the per-chart-trade variant and duplicate counts should be expected to fall
- applying a Finder result preserves `polymarketExitMode` and only writes `polymarketEntryOffset` back when the effective mode is still `resolve_hold`

Native-session resolve-hold note:

- Finder also does not fan out offset variants when `polymarketOutcomeInterval` is `15m` or `1h`
- Finder also does not fan out offset variants when post-signal limit entry is enabled
- native-session resolve-hold ranks the actual selected session annotations and payout metrics

Hunt behavior:

- Hunt exposes its own `Polymarket Exit Mode` and signal-exit multi-trade controls and preserves them in run settings and saved profiles
- Hunt inherits the actual execution logic from Finder
- applying a Hunt survivor follows the same mode-aware rule as Finder result application

## Settings And Persistence

User-facing controls live in the Backtest Realism section:

- `polymarketAnnotationEnabled`
- `polymarketOutcomeSymbol`
- `polymarketOutcomeInterval`
- `polymarketEntrySelectionMode`
- `polymarketEntryOffset`
- `polymarketEntryPriceFilterCents`
- `polymarketBacktestSlippageCents`
- `polymarketExitMode`
- `polymarketSignalExitAllowMultipleTradesPerEvent`
- `polymarketPostSignalLimitEntryEnabled`
- `polymarketPostSignalLimitEntryMode`
- `polymarketPostSignalLimitEntryPriceCents`
- `polymarketPostSignalLimitEntryOffsetCents`
- `polymarketPostSignalLimitExitEnabled`
- `polymarketPostSignalLimitExitMode`
- `polymarketPostSignalLimitExitPriceCents`
- `polymarketPostSignalLimitExitOffsetCents`
- `polymarketProtectionTakeProfitEnabled`
- `polymarketProtectionTakeProfitCents`
- `polymarketProtectionStopLossEnabled`
- `polymarketProtectionStopLossCents`

Execution Lab has separate `Poly TP`, `TP c`, `Poly SL`, and `SL c` controls in `html-partials/tab-execution-lab.html`. Those values are stored in `executionLabSettings` and override the Backtest Realism Polymarket protection settings for Execution Lab sessions only.

`Start 1s Miner` is also a chart-stream action when the current chart is a supported `1s` BTCUSDT/XRPUSDT chart. It starts the local miner and refreshes the chart, latest candle, live quote, and price-alignment diagnostics even before a Paper Trade or Live Trade session is started. Execution Lab diagnostics can be copied as compact JSON for later feedback-loop analysis: the payload keeps the latest full sample, bounded flat health/stream segment rows with quote ranges, cumulative summary stats, and a stream-health block for feed lag, fill-only candles, missing quotes, repeated candles, and inverted CLOB spreads. The miner process log reports CLOB/reference row counts as interval summaries instead of one line per sample. Fresh CLOB quotes are preferred over stale exact-second local quote rows during live monitoring.

Execution Lab live sessions treat `resolve_hold` as a strict hold-to-resolution contract: after an entry, chart exits, time stops, signal exits, and Execution Lab Poly TP/SL controls do not submit a live sell. The position remains open until the Polymarket event resolves, and with `one/event` enabled the next entry can only claim a later Polymarket event.

Current UI rules:

- `polymarketOutcomeSymbol` shows when annotation is enabled
- `polymarketOutcomeInterval` shows when annotation is enabled
- `polymarketExitMode` shows when annotation is enabled
- on `1s` + `signal_close`, `next_open`, or `next_close` charts, `resolve_hold`, `signal_exit_same_event`, and `chart_exit_same_event` are available
- on `1s` charts with other execution models, same-event exit modes are disabled and CLOB scoring is skipped
- `polymarketSignalExitAllowMultipleTradesPerEvent` only shows when annotation is enabled and a same-event exit mode is active
- `polymarketEntryPriceFilterCents` shows when annotation is enabled
- `polymarketBacktestSlippageCents` shows when annotation is enabled
- `polymarketProtectionTakeProfit*` and `polymarketProtectionStopLoss*` rows show when annotation is enabled on a `1s` chart
- `polymarketEntryDelayBars` only shows on `1s` charts with a supported CLOB scoring execution model
- `polymarketEntrySelectionMode` only shows when annotation is enabled, chart interval is `1m`, native outcome session is `5m`, and the selected exit mode is not a same-event exit mode
- `polymarketEntryOffset` only shows when annotation is enabled, chart interval is `1m`, native outcome session is `5m`, the selected exit mode is not a same-event exit mode, and entry selection is `fixed_offset`
- `polymarketPostSignalLimitEntryEnabled` shows when annotation is enabled and native outcome session is `5m`, including supported `1s` CLOB charts
- post-signal entry mode and exit toggle only show when post-signal limit entry is enabled
- fixed entry price only shows when entry mode is `fixed_price`
- entry offset only shows when entry mode is `signal_offset`
- target exit mode only shows when post-signal target exit is enabled
- fixed target price only shows when target exit mode is `fixed_price`
- target offset only shows when target exit mode is `entry_offset`
- Finder and Hunt rank-mode dropdowns disable unsupported rank modes when a same-event exit mode is selected

Persistence and compatibility:

- `polymarketExitMode` defaults to `resolve_hold`
- on `1s` + `signal_close`, `next_open`, or `next_close` charts, saved `resolve_hold` values stay in `resolve_hold`
- on `1s` charts with other execution models, saved same-event exit values downgrade to `resolve_hold` and CLOB scoring is skipped
- invalid persisted values normalize back to `resolve_hold`
- Hunt uses the same default and normalization behavior
- `polymarketOutcomeSymbol` is normalized to uppercase
- `polymarketOutcomeInterval` defaults to `5m`
- invalid persisted values normalize back to `5m`
- `polymarketEntrySelectionMode` defaults to `fixed_offset`
- invalid persisted values normalize back to `fixed_offset`
- `polymarketEntryOffset` stays persisted for backward compatibility even when ignored by same-event exit modes
- `polymarketEntryPriceFilterCents` defaults to `0`, disables filtering at `0`, and clamps to `0..49`
- `polymarketBacktestSlippageCents` defaults to `5` and clamps to `0..99` with 0.1c precision
- `polymarketSignalExitAllowMultipleTradesPerEvent` defaults to `false`
- `polymarketPostSignalLimitEntryEnabled` defaults to `false`
- `polymarketPostSignalLimitEntryMode` defaults to `fixed_price`
- `polymarketPostSignalLimitEntryPriceCents` defaults to `50` and clamps to `1..99`
- `polymarketPostSignalLimitEntryOffsetCents` defaults to `20` and clamps to `0..99` with 0.1c precision
- `polymarketPostSignalLimitExitEnabled` defaults to `false`
- `polymarketPostSignalLimitExitMode` defaults to `entry_offset`
- `polymarketPostSignalLimitExitPriceCents` defaults to `80` and clamps to `1..99`
- `polymarketPostSignalLimitExitOffsetCents` defaults to `20` and clamps to `0..99`
- Polymarket settings are Rust-unsupported
- same-event exit modes require the TypeScript engine

Resolver and compatibility files:

- `lib/backtest-settings-resolver.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

## Endpoint, Ensemble, And Bridge Fences

These fences are intentional. Do not assume shared helper growth means parity everywhere.

Endpoint behavior:

- endpoint Preview / Copy auto-enable Polymarket annotation for supported runs
- endpoint request building strips `polymarketExitMode`
- endpoint request building strips post-signal limit-entry and target-exit settings
- endpoint request building strips Polymarket protective TP/SL settings
- endpoint execution therefore stays on `resolve_hold`

Relevant files:

- `lib/backtest-endpoint-copy.ts`
- `lib/backtest-endpoint-execution.ts`
- `lib/backtest-endpoint-settings.ts`
- `docs/backtest-endpoint.md`

Strategy Ensemble behavior:

- Strategy Ensemble Polymarket remains `resolve_hold` only
- signal-exit support is intentionally not wired there yet

Relevant file:

- `lib/strategy-ensemble-service.ts`

Bridge export behavior:

- still uses chart symbol plus chart interval
- still requires supported `5m` crypto symbols
- still blocks cross-symbol strategies
- still exports entry-signal files, not exit-mode research state

## Polymarket Tab: Diagnostics vs Bridge Export

The `Polymarket` strategy-panel tab contains two different features:

- Bridge Export
- Polymarket Diagnostics

Diagnostics focuses on scored historical trades and includes:

- payout expectancy by event price
- break-even win rate and edge versus break-even in `resolve_hold`
- same-event exit counts and realized PnL metrics in `signal_exit_same_event` and `chart_exit_same_event`
- Backtest Trades diagnostics report `chart_exit_same_event` quote exits as `chart_exit` and expose `sameEventExitedTrades`; `signalExitedTrades` is reserved for actual chart `signal` exits in the copied diagnostics payload
- Backtest Trades diagnostics include active Polymarket filters plus capped examples for unscored sources such as `entry_price_filtered`, `entry_time_filtered`, and `missing`
- Backtest Trades diagnostics include `recommendations` when settings and observed exits conflict, such as selecting `signal_exit_same_event` while all chart trades close through `time_stop`
- forced `end_of_data` closes in same-event modes can still settle at final resolution, but Trades diagnostics do not warn on those alone
- timing buckets
- snapshot profile diagnostics

Bridge Export focuses on downstream automation and includes:

- saved-config selection
- downloadable PowerShell bridge script
- bot env snippet copy
- latest-entry export integration

Do not treat a change to one as automatically affecting the other.

## Change Checklist

If you touch Polymarket code, first decide which contract you are editing:

- provider-side charting
- outcome-symbol resolution
- `resolve_hold` scoring semantics
- same-event exit pricing semantics
- post-signal limit-entry fill semantics
- Execution Lab live trade request, retry, or executor status semantics
- local price-point storage or ingestion
- Finder or Hunt Polymarket ranking
- diagnostics rendering
- headless fillability or deployability analysis
- endpoint parity fences
- bridge export

Then verify the matching files together.

### If you change settings or persistence

Update together:

- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-resolver.ts`
- `lib/settings-model.ts`
- `lib/backtest-settings-dom-contract.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/rust-settings-sanitizer.ts`

### If you change signal-exit scoring semantics

Recheck together:

- `lib/polymarket-exit-mode.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/quick-view.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`
- `lib/polymarket-diagnostics-utils.ts`

### If you change post-signal limit-entry semantics

Recheck together:

- `lib/polymarket-post-signal-limit-entry.ts`
- `lib/polymarket-price-points.ts`
- `lib/polymarket-trade-annotations.ts`
- `lib/polymarket-signal-exit-evaluator.ts`
- `lib/backtest-service.ts`
- `lib/finder/finder-runner-polymarket.ts`
- `lib/quick-view/quick-view-service.ts`
- `lib/renderers/tradesRenderer.ts`
- `lib/polymarket-panel-service.ts`

### If you change local price-point storage or ingestion

Keep aligned:

- `lib/local-sqlite-polymarket-api.ts`
- `lib/polymarket-price-points-ingest.ts`
- `vite.config.ts`

### If you change bridge export

Keep aligned:

- `lib/polymarket-panel-service.ts`
- `scripts/export-latest-entry-signal.ts`
- `scripts/export-latest-ensemble-entry-signal.ts`
- `workers/README.md`

## Validation Targets

Core:

```bash
npm run typecheck
```

Doc drift checks:

```bash
rg -n "signal_exit_same_event|resolve_hold|Post-Signal Limit Entry|Polymarket Entry Cutoff" README.md AGENTS.md docs\polymarket.md lib tests
```

```bash
rg -n "resolveEffectivePolymarketExitMode|signal_close|next_open|next_close" lib\polymarket-exit-mode.ts tests\polymarket-signal-exit.spec.ts docs\polymarket.md README.md AGENTS.md
```

Focused Polymarket tests:

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-post-signal-limit-entry.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-signal-exit.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-trade-annotations.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-outcome-evaluator.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-diagnostics-utils.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\polymarket-deployability-analysis.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

Execution Lab live-trade tests:

```bash
..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts
```

```bash
..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts
```

```bash
npm run test -- execution-lab
```

## Rule Of Thumb

Use this mental shortcut:

- charting a market uses the Polymarket provider
- scoring a backtest uses local SQLite outcome rows
- `1m` signal-exit scoring also uses local SQLite price points
- `1s` signal-exit scoring and Execution Lab live decisions use exact-second CLOB rows
- diagnostics read scored results and may lazily rebuild them
- bridge export is a bot-facing file-generation path with tighter rules
- Execution Lab live trade is a local executor path with real order side effects

When those stay separate, Polymarket changes remain predictable.
