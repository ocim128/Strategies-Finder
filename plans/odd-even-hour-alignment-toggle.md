# Plan: 2H Close-Hour Parity Toggle (Odd vs Even)

## Scope
Add a user toggle that lets 2H candles run in three modes:
- `odd` close-hour parity (current behavior)
- `even` close-hour parity (shifted 1 hour)
- `both` (run odd and even independently, show both backtest results together)

Goal: run the same strategies on both and compare results safely.

## Audit Corrections (from prior draft)
1. Current behavior is already **odd close-hour parity** for 2H bars (epoch-aligned 2H bars open on even hours, therefore close on odd hours).
2. We **must not** "just shift timestamps" on native 2H bars. That changes labels, not candle composition. Even-parity 2H requires re-aggregation from 1H data.
3. `/api/sqlite/clear` and `clearAllCandles()` do not exist in this repo.
4. Settings change wiring for dynamic UI behavior belongs in `lib/handlers/ui-event-handlers.ts`, not `lib/handlers/settings-handlers.ts`.
5. Cache cannot be shared between odd/even 2H modes; keys must be mode-aware or stale data will leak between universes.

## Design Choices
1. Keep feature scope to **2H only** (no behavior change for 4H+ in this iteration).
2. Persist setting in `BacktestSettingsData` for config/save-share continuity.
3. Keep engine/backtest contracts unchanged unless strictly required; this is a data-shaping feature.

Suggested setting key:
- `twoHourCloseParity: 'odd' | 'even' | 'both'`
- default: `'odd'` (preserve existing behavior)

## Implementation Plan

### 1. Settings + UI
Files:
- `lib/settings-manager.ts`
- `html-partials/tab-settings.html`
- `lib/handlers/ui-event-handlers.ts`

Changes:
1. Add `twoHourCloseParity` to `BacktestSettingsData`.
2. Add default `'odd'` to `DEFAULT_BACKTEST_SETTINGS`.
3. Read/write this field in `getBacktestSettings()` and `applyBacktestSettings()`.
4. Add a select in Backtest Realism section:
   - `id="twoHourCloseParity"`
   - options: `odd`, `even`, `both`
5. In `ui-event-handlers.ts`, attach `change` handler that:
   - logs event
   - invalidates in-memory timeframe caches (finder/scanner cache hooks)
   - reloads current symbol+interval via `dataManager.loadData(...)` for `odd/even`
   - for `both`, keep chart data as-is and prompt user to run a compare backtest

Notes:
- Do not rely on a manual cache-clear button for correctness.

### 2. Resampling Core
File:
- `lib/strategies/resample-utils.ts`

Changes:
1. Extend `resampleOHLCV` with optional options object:
   - `{ twoHourCloseParity?: 'odd' | 'even' }`
2. Apply 1-hour phase shift **only when target interval is 2H and parity is `even`**.
3. Keep default path identical to today (`odd`).
4. Export a shared bucket-start helper (or equivalent) and reuse it where bucket mapping is needed.

Important:
- Aggregation must happen on source candles, not by rewriting final timestamps.

### 3. Provider Fetch Paths
Files:
- `lib/dataProviders/binance.ts`
- `lib/dataProviders/bybit.ts`

Binance changes:
1. Thread parity options through:
   - `resolveFetchInterval`
   - `fetchBinanceData`
   - `fetchBinanceDataWithLimit`
   - `fetchBinanceDataAfter`
2. For `interval === '2h' && parity === 'even'`:
   - force source interval to `1h`
   - set `needsResample = true`
   - resample with parity options
3. Keep native 2H fast path for `odd`.

Bybit changes:
1. Thread parity options to all `resampleOHLCV(...)` calls.
2. 2H already resamples from lower TF there; parity option only changes bucket phase.

### 4. Data Manager + Cache Isolation
File:
- `lib/data-manager.ts`

Changes:
1. Read parity from settings manager in a dedicated helper.
2. Pass parity options into provider fetch functions.
3. Make cache keys parity-aware for 2H:
   - example storage interval token: `2h@close-odd` / `2h@close-even`
4. Use parity-aware key for:
   - IndexedDB (`loadCachedCandles` / `saveCachedCandles`)
   - SQLite (`loadSqliteCandles` / `storeSqliteCandles`)
   - DataManager in-memory sync keys
5. Keep network request interval as plain `2h`/`1h`; only storage key gets suffix.
6. Keep seed-file lookup on raw interval (no suffix).

### 5. Strategy Timeframe Alignment Path
Files:
- `strategyRegistry.ts`

Changes:
1. When `strategyTimeframeEnabled` and `strategyTimeframeMinutes === 120`, pass parity options to `resampleOHLCV`.
2. Use the same bucket-phase logic when mapping HTF signals back to base bars, so mapping is consistent with generated 2H buckets.

### 6. Streaming / Realtime Behavior
Files:
- `lib/data-manager.ts`

Changes:
1. For Binance with `2h + even parity`, do not trust native 2H websocket bars.
2. Use an alignment-safe realtime path:
   - either poll-based update for latest aligned 2H bar, or
   - 1H stream + local 2H aggregation.
3. Ensure realtime updates append/replace candles in the same parity universe as historical fetch.

### 7. Backtest Compare Mode (`both`)
Files:
- `lib/backtest-service.ts`
- `lib/state.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/renderers/resultsRenderer.ts`
- `html-partials/tab-results.html`

Changes:
1. Add a compare state object for paired results (`odd` and `even`) without merging trades.
2. In `runCurrentBacktest()`, when parity is `both`:
   - run odd and even as separate backtests (same strategy, same settings)
   - if current chart interval is 2H, fetch parity-specific data for each run
   - if strategy timeframe is 120m, run each scenario under matching parity context
3. Keep one baseline result in `currentBacktestResult` for existing consumers (markers, trades, replay, analysis).
4. Render a dedicated compare block in Results tab with odd/even summary metrics side-by-side.

### 8. Alerts Integration (`both`)
Files:
- `lib/handlers/alert-handlers.ts`
- `lib/alert-service.ts`
- `workers/entry-signal-worker.ts`

Changes:
1. Quick Subscribe creates two subscriptions when interval is 2H and parity mode is `both`.
2. Stream IDs carry parity tags so odd/even alerts are independent channels.
3. Stored backtest settings are parity-specific per stream (`odd` or `even`), never `both`.
4. Worker fetch path re-aggregates even 2H subscriptions from 1H candles before signal evaluation.

## Compatibility and Contracts
1. Existing saved settings/configs with no new key fall back to `'odd'`.
2. Worker strategy registration (`lib/strategies/library.ts`) is unaffected.
3. Rust sanitization lists (`lib/backtest-service.ts`, `lib/finder-manager.ts`) are unaffected if this remains data-layer only. If the key is added to runtime backtest settings objects, explicitly strip it for Rust paths.

## Validation
Run:
```bash
npm run typecheck
npm run test
```

Manual checks:
1. Load `BTCUSDT` on `2h`, parity `odd`, note last 10 bar timestamps.
2. Switch parity to `even`, verify:
   - timestamps shift to opposite close-hour parity
   - OHLC values differ (not just time labels)
3. Toggle back/forth without manual cache clear; confirm no stale crossover.
4. Run backtest/finder/scanner on both modes and confirm reproducible mode-specific outputs.

## Affected Subsystems
1. Settings persistence and UI
2. Data providers (Binance + Bybit)
3. DataManager caching and fetch orchestration
4. Strategy timeframe resample/mapping path
5. Streaming/polling update path
6. Results UI/state flow for dual backtest rendering
