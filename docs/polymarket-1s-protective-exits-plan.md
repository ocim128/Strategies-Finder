# Polymarket 1s Protective Exits Plan

## Purpose

Add Polymarket 1s take-profit and stop-loss behavior for backtest scoring and Execution Lab live trading, while preserving existing chart, Polymarket, and live-executor boundaries.

The requested behavior is stronger than a Polymarket annotation overlay: when a Polymarket TP/SL closes the active Polymarket leg, the modeled chart trade must also close at that timestamp/reason so later chart signals can open another Polymarket entry. A post-pass annotation-only change is insufficient because skipped entries are already lost by the time `result.trades` is annotated.

## Current Facts

- Main chart backtests are executed by `lib/strategies/backtest/backtest-engine.ts`.
- Polymarket 1s CLOB scoring is handled after the chart backtest by `lib/second-market/backtest.ts` and `lib/second-market/evaluation.ts`.
- UI manual backtest annotation enters the 1s CLOB path through `lib/backtest-service.ts`.
- Execution Lab paper decisions are handled by `lib/execution-lab/paper-session.ts`.
- Execution Lab live requests, response normalization, and JSONL records are modeled in `lib/execution-lab/execution-lab-model.ts` and `lib/execution-lab/live-trade-request.ts`.
- The local executor boundary is configured by `lib/execution-lab/live-executor-adapter.ts` using `.env` values such as `EXECUTION_LAB_LIVE_EXECUTOR_PATH` or `EXECUTION_LAB_LIVE_EXECUTOR_URL`.
- Existing live request types support entry buy, taker exit sell, and cancel-all. The repository does not currently document order-status polling for resting TP limit orders.
- Existing docs state that `signal_exit_same_event` only exits early on `exitReason === "signal"`; chart TP/SL/time-stop currently settle to resolution in the Polymarket scoring path.

## Assumptions

- Scope is limited to supported Polymarket 1s CLOB contexts: BTCUSDT/XRPUSDT chart interval `1s` with execution model `signal_close`, `next_open`, or `next_close`.
- Polymarket TP/SL thresholds are configured in cents from the Polymarket entry fill price.
- Long chart trades buy YES; short chart trades buy NO.
- Backtest TP uses sell-side CLOB prices and fills at the target price when touched.
- Backtest SL uses sell-side CLOB prices and fills at the available bid when the stop threshold is crossed.
- Chart trade `exitTime` and `exitReason` should be changed in the Polymarket-aware run so later entries can occur.
- Chart trade `exitPrice` for forced Polymarket exits should stay chart-price based by default, using the chart candle close/open selected by the active execution model at the forced exit timestamp. True Polymarket entry/exit prices stay in `trade.polymarketOutcome`.
- Paper Trade remains the startup default.
- Live Trade must not send wallet secrets, API keys, signatures, or auth headers to the browser, localStorage, or JSONL logs.

## Unknowns

- Whether the side-repo `.exe` supports sell limit orders for TP.
- Whether the side-repo `.exe` supports order-status polling or fill reconciliation for resting limit orders.
- Whether the side-repo `.exe` returns stable order ids and filled-share quantities for all live limit states.
- Whether TP limit orders should use GTC only, or support other Polymarket limit order types if the executor exposes them.
- Whether forced chart `exitPrice` should be chart-price based or Polymarket-price based. Chart-price based preserves chart PnL semantics; Polymarket-price based makes chart PnL no longer a chart-market result.

## Architecture

### Module Boundaries

- Chart backtest engine:
  - Owns chart positions, chart trade list, chart equity, chart risk settings, and signal processing.
  - Should not import Execution Lab or live-executor modules.
- Second-market Polymarket layer:
  - Owns CLOB quote indexing, event mapping, Polymarket entry/exit fills, and Polymarket annotation.
  - Can provide a TypeScript-only protective-exit adapter used by manual backtest, Finder, Quick View rebuilds, and Execution Lab paper if needed.
- Execution Lab:
  - Owns live-session UI, paper position state, live request construction, local JSONL records, and executor calls.
  - Must keep Paper and Live modes separate.
- Local executor:
  - Owns secrets, signing, CLOB order placement, geoblock checks, order sizing, order status, and durable idempotency.

### Data Flow

Backtest with Polymarket TP/SL enabled:

```text
strategy signals
  -> TypeScript chart backtest with Polymarket protective-exit hook
  -> forced chart trade exits when CLOB TP/SL triggers
  -> later signals can open new chart/Polymarket trades
  -> second-market annotation attaches Polymarket fills/PnL
  -> renderers and diagnostics consume adjusted trades and summary
```

Execution Lab live with Polymarket TP/SL enabled:

```text
accepted paper entry
  -> optional live buy request
  -> track live filled shares
  -> submit TP sell limit if configured and executor supports it
  -> monitor live same-event bid for SL threshold
  -> cancel TP before SL/chart-signal taker exit when possible
  -> submit taker sell for remaining shares
  -> JSONL request/result records and UI status
```

## Proposed Settings

Backtest and paper/live shared Polymarket protection:

- `polymarketProtectionTakeProfitEnabled`
- `polymarketProtectionTakeProfitCents`
- `polymarketProtectionStopLossEnabled`
- `polymarketProtectionStopLossCents`

Chart risk-management setting:

- `disableSignalExits`

Rules:

- `disableSignalExits` is not a Polymarket setting.
- `disableSignalExits` only has effect when at least one chart stop-loss or take-profit exit is active.
- Polymarket protection only has effect when Polymarket annotation is enabled and the effective 1s CLOB mode is supported.
- New settings unsupported by Rust must be included in `lib/rust-settings-sanitizer.ts`.
- Saved settings must remain backward compatible; missing keys default off.

## Phase 1 - Contract And UI Settings

### Objective

Add explicit settings contracts without changing runtime behavior.

### Scope

- Settings types, defaults, resolver, DOM ids, persistence, and UI controls.
- No backtest or live execution behavior yet.

### Technical Tasks

- Add new fields to `lib/types/strategies.ts`.
- Add defaults and resolver rules in `lib/backtest-settings-resolver.ts`.
- Add DOM ids to `BACKTEST_DOM_SETTING_IDS`.
- Add controls to `html-partials/tab-settings-section-core.html` for `disableSignalExits`.
- Add controls to the existing Polymarket settings area in `html-partials/tab-settings-section-execution.html` for Polymarket TP/SL cents.
- Update feature-local DOM contracts if new structural ids are required.
- Update `lib/rust-settings-sanitizer.ts` to strip or force TypeScript for new unsupported settings.
- Ensure settings restore triggers relevant UX change handlers.

### Dependencies

- Existing settings manager and resolver.
- Existing feature DOM contract tests.

### Risks/Blockers

- If settings are placed in the wrong section, users may confuse chart risk exits with Polymarket protection exits.
- If Rust sanitizer is missed, Rust may silently ignore the new behavior.

### Deliverables

- Persisted settings keys.
- UI controls with defaults off.
- Type-safe settings accessors.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Existing settings load/save tests if present.

### Exit Criteria

- Settings can be saved/restored and are inert until later phases wire behavior.

## Phase 2 - Chart Backtest Disable Signal Exits

### Objective

Allow chart risk exits to own trade closure by ignoring opposite strategy signals as exits when configured.

### Scope

- TypeScript backtest engine only.
- No Polymarket quote logic in this phase.

### Technical Tasks

- Add `disableSignalExits` to `NormalizedSettings`.
- Resolve it in `normalizeBacktestSettings(...)`.
- In both compact and full backtest loops, bypass `findSignalExitTarget(...)` when `disableSignalExits` is active.
- Define "active" as `disableSignalExits === true` and at least one chart TP/SL exit is enabled:
  - ATR stop/take-profit
  - percentage stop/take-profit
  - historical level stop/take-profit
- Preserve signal entries when no position is open.
- Preserve combined/long/short/both behavior for entries.
- Keep `riskMinHold` semantics scoped to exits that still exist.

### Dependencies

- Phase 1 settings contract.
- Existing backtest engine signal-processing loops.

### Risks/Blockers

- Both compact and full backtest paths must stay aligned.
- Combined direction runs have separate long/short passes and can regress if only the main loop is updated.
- Existing signal-exit re-entry cooldown must not block entries when signal exits are disabled.

### Deliverables

- Chart backtest can ignore signal exits while risk exits remain active.
- Focused tests for long, short, both, combined if touched, `signal_close`, `next_open`, and no-risk guard.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- backtesting-engine`
- Add/extend tests proving opposite signals do not close trades when the toggle is active and risk exit exists.
- Add/extend tests proving the toggle has no effect when no risk exit is active.

### Exit Criteria

- Backtest behavior is deterministic and documented in settings-facing docs.

## Phase 3 - Polymarket Protective Exit Evaluator

### Objective

Add reusable CLOB TP/SL detection that can be used by backtest annotation and Execution Lab paper/live planning.

### Scope

- Second-market quote scanning and result types.
- No chart trade replay yet.
- No live executor changes yet.

### Technical Tasks

- Add a small helper in the second-market layer to scan same-event sell quotes after entry.
- Inputs:
  - side YES/NO
  - entry quote timestamp
  - event end timestamp
  - entry price
  - optional TP cents
  - optional SL cents
  - optional modeled chart exit timestamp
- Outputs:
  - earliest exit source: `polymarket_take_profit`, `polymarket_stop_loss`, `signal`, `resolution`, or `missing`
  - exit timestamp
  - quote timestamp
  - Polymarket fill price
  - target/stop price
- Extend `SecondMarketTradeResult` and summary types with new exit sources or explicit protection fields.
- Preserve existing post-signal limit-entry target exit semantics. Do not mix post-signal limit target settings with the new global Polymarket TP unless explicitly configured.
- Decide tie-break rules:
  - TP and SL same timestamp: conservative default should choose SL.
  - TP/SL and chart signal same timestamp: conservative default should choose chart signal or SL before TP; document final choice.

### Dependencies

- Existing `lib/second-market/backtest.ts` quote indexing.
- Existing CLOB bid/ask alignment helpers.

### Risks/Blockers

- Quote gaps can create false misses.
- TP/SL scanning can add cost in Finder hot paths if implemented with per-trade full scans.
- Exit-source naming affects renderers, diagnostics, Quick View, and tests.

### Deliverables

- Pure helper with focused unit tests.
- Summary fields for protection exits.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\second-market-backtest.spec.ts`
- Tests for TP first, SL first, tie behavior, missing quotes, NO side, entry price filter, event cutoff, and duplicate event handling.

### Exit Criteria

- Protective exit detection is correct and reusable without changing chart trades yet.

## Phase 4 - Polymarket-Aware Backtest Replay

### Objective

Make Polymarket TP/SL force chart trade exits early enough that later entries can be accepted.

### Scope

- Manual 1s CLOB backtests first.
- TypeScript engine only.
- Finder/Quick View integration can follow after the manual path is stable.

### Technical Tasks

- Avoid a post-pass-only trade rewrite because it cannot recover skipped entries.
- Add a TypeScript-only replay seam that can close active chart positions from an external protective-exit trigger.
- Preferred implementation path:
  - Add an optional external exit hook to the backtest engine, or
  - Add a second-market-specific TypeScript replay wrapper that reuses `prepareSignals(...)`, position-building semantics, and CLOB protection exits.
- The hook/wrapper must:
  - map chart position direction to YES/NO side
  - require a valid Polymarket entry fill before opening the Polymarket-aware chart proxy trade
  - treat missing/filtered Polymarket entry fills as unscored attempts that do not block later eligible entries
  - close the chart position at the Polymarket protection timestamp
  - set chart `exitReason` to a new explicit reason, for example `polymarket_take_profit` or `polymarket_stop_loss`
  - set `trade.polymarketOutcome` with true Polymarket entry/exit prices
  - allow later prepared entry signals after the forced exit
- Force TypeScript engine when Polymarket protective exits are enabled.
- Keep ordinary chart metrics explicit: chart `exitPrice` stays chart-price based; Polymarket PnL remains in Polymarket fields.
- Update renderers to display new exit reasons without breaking existing trade rows.

### Dependencies

- Phase 3 protective exit helper.
- Existing signal preparation and backtest engine internals.
- Access to CLOB quotes before or during backtest execution.

### Risks/Blockers

- This is the highest-risk phase because it changes trade lifecycle, not only annotation.
- If implemented as an engine hook, engine internals may need careful typing to avoid broad refactors.
- If implemented as a separate replay, drift from the core backtest engine is possible.
- If Polymarket entry failures still open chart proxy trades, the run will drift from live-like behavior by blocking later entries.
- Chart-price-based forced exits can make chart PnL and Polymarket PnL diverge; renderers must keep those metrics visually distinct.

### Deliverables

- Manual 1s CLOB backtest produces adjusted trades when protection exits fire.
- Later entries can occur after a forced Polymarket exit.
- Existing annotation summary includes protection-exit counts and PnL.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- backtesting-engine`
- `..\..\..\node_modules\.bin\esno tests\second-market-backtest.spec.ts`
- Add integration tests proving:
  - first trade exits by Polymarket TP and later same-event/next-event entry is accepted when allowed
  - first trade exits by Polymarket SL and later entry is accepted
  - no CLOB entry fill does not open or claim the Polymarket-aware chart proxy, and a later eligible entry can still be accepted
  - Rust is not used for protection-enabled runs

### Exit Criteria

- Manual backtest behavior matches the requested live-like lifecycle and does not regress existing no-protection runs.

## Phase 5 - Finder, Hunt, Quick View, And Diagnostics

### Objective

Propagate Polymarket protective exits through the existing Polymarket research surfaces that support 1s CLOB scoring.

### Scope

- Finder 1s CLOB path.
- Hunt only if it reuses Finder settings/results.
- Quick View and Trades rebuild paths.
- Polymarket diagnostics summary/rendering.

### Technical Tasks

- Route protection settings through `lib/finder-manager.ts` and `lib/second-market/finder-runner.ts`.
- Keep deterministic seeded behavior.
- Avoid per-candidate quote re-indexing in hot loops.
- Update Quick View rebuilds to include protection settings.
- Update Trades/Results labels for protection exit sources.
- Ensure applying Finder/Hunt results preserves unrelated Polymarket settings.

### Dependencies

- Phase 4 manual path.
- Existing Finder 1s CLOB evaluator.

### Risks/Blockers

- Finder performance can degrade if CLOB scanning is not cached.
- Result ranking semantics can change materially; this must be visible in summaries.

### Deliverables

- 1s Finder/Hunt can score protection-enabled runs.
- Quick View and Trades explain protection exits.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts`
- Focused performance check on a representative 1s dataset.

### Exit Criteria

- Research surfaces agree with manual backtest for the same strategy/settings/data.

## Phase 6 - Execution Lab Paper Protection

### Objective

Make Execution Lab paper mode simulate Polymarket TP/SL from live/stored CLOB quotes.

### Scope

- Paper Trade only.
- No live executor calls beyond existing behavior.

### Technical Tasks

- Add protection fields to `ExecutionLabSessionSnapshot.polymarketSettings` or a typed protection config.
- Extend `ExecutionLabOpenPaperPosition` with protection targets if needed.
- In `advanceOpenPosition(...)`, check Polymarket TP/SL before chart signal/resolution exits.
- Use exact same-event quotes for paper TP/SL.
- Add new `ExecutionLabPaperExitReason` values for Polymarket TP/SL.
- Log `paper_exit` records with the new reasons.
- Render markers and recent trades with concise labels.

### Dependencies

- Phase 3 helper.
- Existing Execution Lab quote buffer and paper session state.

### Risks/Blockers

- Paper session uses exact timestamp matching for backtest exits. Protection scanning must not accidentally use future quotes.
- If quotes are missing, paper TP/SL cannot trigger and should fail loud in records/status where relevant.

### Deliverables

- Paper positions close on configured Polymarket TP/SL.
- Paper PnL reflects Polymarket entry and protection exit prices.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- execution-lab`
- Add tests in `tests/execution-lab-paper-session.spec.ts` for TP, SL, missing quotes, zero bid, and tie behavior.

### Exit Criteria

- Paper Trade behavior is a reliable dry-run model for live protection logic.

## Phase 7 - Live TP/SL Executor Contract

### Objective

Document and, only if supported, wire live TP limit and SL taker behavior through the local executor boundary.

### Scope

- Documentation first.
- Browser and Vite request types after executor capabilities are confirmed.
- No wallet secrets in browser payloads.

### Technical Tasks

- Update `docs/live-trade-plan.md` or `docs/polymarket.md` with an executor capability matrix:
  - buy taker entry
  - buy limit entry
  - sell taker exit
  - sell limit TP
  - cancel order
  - order-status polling
  - filled-share reconciliation
- Inspect or test the side-repo `.exe` contract before wiring sell limit TP.
- If sell limit TP is supported:
  - add a `live_take_profit_request` or extend existing request union with `action: "take_profit_limit"`
  - include token id, side, shares, limit price, event ids, and request id
  - add request/result JSONL records
  - track pending TP order id on live position
- If polling is supported:
  - add bounded same-session polling or reconciliation for TP fills
  - close or reduce live position when filled shares are confirmed
- If polling is not supported:
  - document TP as "submitted but not reconciled" and do not mark position closed until a supported fill signal exists
  - consider deferring live TP implementation while still supporting SL taker exit
- For SL:
  - monitor latest same-event bid for remaining live shares
  - when bid <= entry price - SL cents, queue taker sell
  - cancel TP first if a TP order is pending and cancel is supported
  - submit taker exit for remaining shares using existing exit request path

### Dependencies

- Existing local executor protocol.
- Side-repo `.exe` behavior or docs.
- Phase 6 paper protection.

### Risks/Blockers

- Without order-status polling, live TP cannot be made fully reliable.
- Without cancel support, TP and SL/chart exits can conflict.
- Partial fills require share accounting before submitting subsequent exits.
- Live CLOB latency can cause SL to trigger after the displayed bid has moved.

### Deliverables

- Updated live-trade documentation.
- Capability-gated implementation path.
- No live TP wiring until executor support is confirmed.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- execution-lab`
- Dry-run executor tests for every new request shape.
- Manual dry-run with configured executor path or URL.

### Exit Criteria

- Live protection behavior is either implemented with confirmed executor support or explicitly documented as blocked.

## Phase 8 - Live Execution Protection

### Objective

Execute configured live TP/SL behavior with idempotent logging and failure handling.

### Scope

- Execution Lab Live Trade only.
- No Cloudflare Worker live trading.

### Technical Tasks

- On live entry matched/partial:
  - track remaining shares as currently done
  - submit TP limit immediately if enabled and supported
  - record TP request/result
- On every poll:
  - reconcile pending TP if polling is supported
  - check SL threshold from latest same-event bid
  - check chart signal exit and paper exits as existing logic does
  - cancel TP before taker exits when possible
  - submit taker exit for remaining shares
- Ensure request ids are deterministic and include action, session, paper trade id, token id, exit type, timestamp, and attempt.
- Ensure duplicate request ids are blocked by Strategy Finder and executor.
- Keep geoblock/auth/order failures as live safety rejections.
- Update UI status and recent live result rendering.

### Dependencies

- Phase 7 confirmed executor capabilities.
- Existing live entry/exit/cancel infrastructure.

### Risks/Blockers

- Double exit from TP fill plus SL/chart exit.
- Position state drift after partial fills.
- Executor returns `posted_live` or `delayed` without final fill status.
- Browser reload loses process-local live state; this is already a V1 limitation and must remain documented.

### Deliverables

- Live TP limit submission where supported.
- Live SL taker exit.
- JSONL records sufficient for diagnosing request, result, cancel, and reconciliation states.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- execution-lab`
- Dry-run session:
  - entry matched
  - TP request submitted
  - SL trigger queues cancel then taker exit
  - duplicate requests are ignored
  - geoblock/auth failure blocks further live submissions

### Exit Criteria

- Live Trade can run protection logic in dry-run and live-enabled modes without secret leakage or duplicate live submissions.

## Edge Cases

- TP and SL touched at the same second.
- TP/SL touched before the entry quote timestamp.
- Entry quote missing.
- Missing/filtered Polymarket entry should not open a Polymarket-aware chart proxy trade.
- Exit quote missing.
- Same-event duplicate trade after a missed entry.
- Same-event duplicate trade after a protection exit.
- `polymarketSignalExitAllowMultipleTradesPerEvent` off versus on.
- `polymarketEntryDelayBars` pushes entry after a possible protection trigger.
- `signal_close` and `next_close` one-second shift.
- NO side with absent or derived `no_price`.
- Zero bid exits.
- Event ends before SL taker exit can be submitted.
- Resting TP order partially fills before SL trigger.
- Cancel request returns `not_canceled`, possibly because order already filled.
- Live entry and paper exit appear in the same poll batch.

## Failure Handling

- Missing historical CLOB entry quotes: mark the Polymarket attempt unscored and do not open the Polymarket-aware chart proxy trade.
- Missing historical CLOB exit quotes after entry: keep the position open until another modeled exit, event resolution, or end-of-data; do not invent fills.
- Unsupported context: ignore protection settings and show/record support status.
- Rust selected: force TypeScript or strip unsupported settings before Rust fallback.
- Executor unavailable: write structured failure result and keep Paper mode unaffected.
- TP unsupported by executor: do not submit fake TP; document the blocker and keep SL taker path separate.
- Polling unsupported: do not claim a TP fill unless the executor response proves filled shares.
- Geoblock/auth failures: block further live submissions in the session, matching existing live safety behavior.

## Security Considerations

- Browser payloads stay non-secret.
- Wallet/private-key material stays in the side-repo executor `.env`.
- JSONL logs must not include private keys, signatures, auth headers, or signed order payloads.
- Live mode remains opt-in per session and must not restore automatically.
- `.env` controls executor path/URL, live enablement, timeouts, byte limits, and fallback order settings.

## Performance Considerations

- Reuse quote indexes across candidate runs where possible.
- Avoid per-trade full-array scans in Finder hot paths.
- Keep second-market CLOB scans event-bucketed and timestamp-sorted.
- Do not broaden live polling frequency without measuring browser and local API cost.

## Observability And Logging

- Backtest summaries should expose protection exit counts and missing quote counts.
- Trades should show clear exit source labels for Polymarket TP/SL.
- Execution Lab JSONL should include request/result records for TP, SL, cancel, and reconciliation attempts.
- Live UI should distinguish paper protection exits from live executor submissions.

## Rollback Strategy

- Settings default off.
- Disable Polymarket protection settings to restore existing behavior.
- Keep `disableSignalExits` independent and default off.
- Keep live TP gated behind executor capability checks.
- If live TP is unstable, ship only documented paper/backtest TP/SL and live SL taker behavior behind explicit toggles.

## Documentation Updates

- Update `docs/polymarket.md`:
  - 1s protection support matrix
  - exit-source semantics
  - chart-trade forced exit behavior
  - Finder/Quick View support
- Update `docs/live-trade-plan.md`:
  - executor capability matrix
  - TP limit and SL taker contracts
  - polling/reconciliation limitations
- Update `AGENTS.md` only if the workflow becomes a durable safe-change rule.

## Overall Completion Criteria

- Manual backtest, Finder, Quick View, Execution Lab Paper, and Execution Lab Live either support the feature or explicitly report unsupported status.
- Protection-disabled runs match the previous baseline.
- Protection-enabled 1s runs can exit chart trades by Polymarket TP/SL and accept later entries.
- Live mode does not submit duplicate exits or leak secrets.
- Required validation passes:
  - `npm run typecheck`
  - `npm run test`
  - `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\second-market-backtest.spec.ts`
  - `npm run test -- execution-lab`
