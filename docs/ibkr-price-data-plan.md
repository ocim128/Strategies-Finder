# IBKR Price Data Plan

## Purpose

Add an IBKR price-data manager inside the Strategy panel that can download and sync stock candles into `price-data/ibkr` as CSV files, then expose those symbols to chart loading, Finder, Batch Backtest, and synthetic-pair workflows with a distinct bullet marker.

Target symbol examples:

- `NVDA•`
- `AAPL•`
- `NVDA•+AAPL•`

The bullet marker must mean "IBKR local CSV data" and must stay distinct from the existing diamond marker:

- `AAPL♦` = existing downloaded `price-data/stock_market_data` local daily dataset
- `AAPL•` = new IBKR-managed local CSV dataset

## Assumptions And Unknowns

### Assumptions

- The first implementation should be local-only and should not require deploying any Worker.
- IBKR authentication is session-based, not a simple API-key workflow.
- The sync path should use either TWS / IB Gateway API or Client Portal Gateway, but the browser UI should call only local Vite endpoints.
- CSV is the required durable output format for the first version.
- `price-data/stock_market_data` should remain a read-only historical snapshot.
- `price-data/ibkr` should be the new mutable sync folder.
- IBKR symbols should be explicitly namespaced with `•` so `NVDA`, `NVDA♦`, and `NVDA•` cannot collide in local caches, Finder, Batch, or synthetic pairs.
- Finder and Batch should treat IBKR data exactly like a local source once CSVs exist.

### Unknowns

- Final IBKR API bridge choice:
  - TWS / IB Gateway socket client, likely easiest for historical bars.
  - Client Portal Gateway local REST, better aligned with browser session login but has daily reauthentication.
- Whether the user's account can fetch API historical bars for every symbol visible in the IBKR chart. IBKR's docs say API historical data can require market-data subscriptions even when delayed charts are visible.
- Exact supported timeframe set from the chosen bridge.
- Whether adjusted prices should be stored. The first version should store unadjusted OHLCV unless IBKR clearly returns adjusted historical bars for the selected request.
- Symbol contract resolution rules for ambiguous tickers, for example exchange and primary exchange for US stocks.

## Recommended Storage Contract

Keep IBKR data separate:

```text
price-data/
  stock_market_data/        existing downloaded snapshot, diamond symbols
  ibkr/
    catalog.json            generated metadata for downloaded symbols
    csv/
      1d/
        NVDA.csv
        AAPL.csv
      1h/
        NVDA.csv
      5m/
        NVDA.csv
    logs/
      latest-sync.jsonl
```

CSV columns should be normalized to the app's existing OHLCV contract:

```csv
time,open,high,low,close,volume
2026-07-02T20:00:00.000Z,158.1,160.2,157.4,159.7,12345678
```

Rules:

- One file per symbol per timeframe.
- `time` should be ISO UTC or unix seconds; pick one and keep it consistent. ISO UTC is easier to audit manually.
- Rows must be sorted ascending by time.
- Sync must merge by normalized time key, replace the last overlapping row, then append newer rows.
- Partial current candles should either be excluded by default or clearly flagged in `catalog.json`; first version should exclude unfinished candles.
- Keep generated CSVs out of `stock_market_data`.
- `catalog.json` should include enough contract metadata to reproduce the request:
  - symbol
  - marked symbol
  - conId if available
  - exchange / primary exchange
  - currency
  - supported intervals present on disk
  - first / last complete candle per interval
  - last sync time

## Existing Codepath Findings

The current local stock-data flow is not just a folder reader. The plan must preserve these contracts:

- `lib/local-daily-datasets.ts` owns the local dataset registry and currently has a diamond-only stock-market marker.
- `vite.config.ts` owns local catalog endpoints for `indonesian-stock` and `stock_market_data`.
- `lib/candle-cache.ts` owns seed-file and local CSV loading, including:
  - `localDailyCsvCache`
  - `missingLocalDailyCsvFiles`
  - `loadSeedCandlesFromPriceData(...)`
  - `loadLocalDailyDatasetCandles(...)`
- `lib/data/data-provider-router.ts` self-routes diamond symbols to `local-daily`.
- `lib/data/data-persistence.ts` ranks non-Binance local data as imported > SQLite > IndexedDB cache > seed.
- `lib/finder-manager.ts` has its own local-daily asset map promise and universe dataset caches.
- `lib/batch-backtest/batch-backtest-loader.ts` has independent pair and synthetic-leg caches.
- `lib/rank-pairs/rank-pairs-service.ts` reuses Batch loading, so it inherits the same bullet-symbol behavior.
- `lib/signal-committee-service.ts` reuses `parseBatchSymbols(...)` for bulk pairs; bullet symbols should not be accidentally broken even if full IBKR sync support is out of initial scope.
- `lib/portfolioLab/portfolio-lab-synthetic.ts` has its own synthetic parser that currently special-cases only diamond symbols.

Observed Finder details:

- `parseSyntheticPairToken(...)` preserves diamond legs before falling back to Binance suffix inference. Bullet legs need the same preservation.
- `loadUniverseDataset(...)` uses `resolveEffectiveIntervalForSynthetic(...)` before loading.
- `prepareUniverseSymbolProvider(...)` consults a cached local-daily asset map. After IBKR sync creates new catalog entries, that map needs refresh/invalidation or Finder will not learn the new provider in the same page session.
- `populateUniverseWithLocalDailySeeds(...)` fills the Finder universe from all local daily assets and forces `state.currentInterval` to `1d`. That is correct for diamond stock data but wrong for IBKR intraday data.
- `universeDatasetCache` and `syntheticSourceSeriesCache` can hold stale data after CSV sync.

Observed Batch details:

- `parseBatchSymbols(...)` uppercases and splits on whitespace/comma. It should preserve `•`, but tests should assert it.
- `loadBatchDataset(...)` uses the same synthetic interval resolver as Finder.
- `loadSyntheticPairForBatch(...)` skips finer source subdivision only when `isStockMarketSymbol(...)` detects diamond legs. Bullet legs need equivalent interval-source logic.
- Batch has separate `legCache` and `pairCache`; an IBKR sync must either expose invalidation or document that the user must rerun after page reload until invalidation is implemented.

Conceptual correction from this inspection:

- Treating IBKR CSVs as ordinary `seed` files is weak. `DataPersistence` can prefer older SQLite/IndexedDB data over a freshly synced CSV because seed has the lowest local-source priority.
- Either IBKR sync must also write the same normalized bars into SQLite/cache, or the loader needs an `ibkr-csv` local source that outranks old cache for bullet symbols.
- The plan should not rely on the existing "Local Seeds" Finder button for IBKR, because it forces `1d` and mixes diamond and bullet sources.

## Symbol Marker Contract

Add a separate IBKR marker helper instead of broadening the diamond helper:

```ts
export const IBKR_SYMBOL_SUFFIX = "\u2022";

export function markIbkrSymbol(symbol: string): string;
export function isIbkrSymbol(symbol: string): boolean;
export function stripIbkrMarker(symbol: string): string;
export function isMarkedLocalStockSymbol(symbol: string): boolean;
export function stripMarkedLocalStockSymbol(symbol: string): string;
```

Important distinction:

- Existing `isStockMarketSymbol(...)` should continue to mean diamond-only unless intentionally renamed.
- New code should use `isIbkrSymbol(...)` for bullet symbols.
- Shared local-only checks should use a new helper such as `isMarkedLocalStockSymbol(...)`.
- Shared marker stripping should not silently drop the source. Code that needs source-aware behavior should branch diamond vs bullet explicitly.

Synthetic behavior:

- `deriveSyntheticSymbol("NVDA•", "AAPL•")` should produce `NVDA•+AAPL•`.
- `parseSyntheticPairToken("NVDA•+AAPL•")` must preserve both bullet-marked legs.
- Batch parser should keep `•` in symbols.
- Portfolio Lab synthetic parser should preserve bullet-marked legs if this source is intended there later.
- `resolveEffectiveIntervalForSynthetic(...)` should not blindly coerce bullet symbols to `1d`. It should coerce only when the requested interval is not present for one of the IBKR legs.

## UI Scope

Add a new lazy Strategy panel tab:

- Tab id: `ibkrdata`
- Partial: `html-partials/tab-ibkr-data.html`
- Service: `lib/ibkr-data/ibkr-data-service.ts`
- DOM contract: `lib/ibkr-data/ibkr-data-dom.ts`

Controls:

- Gateway status:
  - connection state
  - last authentication/status check
  - selected bridge type
- Symbol input:
  - textarea for multiple tickers
  - one symbol per line or comma-separated
  - optional exchange / primary exchange fields can wait until contract resolution proves ambiguous
- Timeframe selector:
  - start with `1d`
  - add supported intraday options after bridge validation
- Date/window controls:
  - start date or lookback duration
  - "sync latest only" toggle
- Actions:
  - Test connection
  - Resolve symbols
  - Download CSV
  - Sync latest
  - Stop
  - Copy selected bullet symbols
- Output:
  - per-symbol status rows
  - bars fetched
  - first/last time
  - file path
  - error message

Do not put credentials in the browser, localStorage, request payloads, logs, or CSV metadata.

## Backend / Vite API Shape

Add a local Vite plugin rather than calling IBKR directly from browser code:

- File: `lib/ibkr-data/ibkr-data-vite-plugin.ts`
- Register in `vite.config.ts`

Proposed endpoints:

- `GET /api/ibkr/status`
- `POST /api/ibkr/resolve`
- `POST /api/ibkr/download`
- `POST /api/ibkr/sync`
- `POST /api/ibkr/stop`
- `GET /api/local-price-data/ibkr/catalog`

The Vite plugin owns:

- bridge process/client connection
- pacing and concurrency
- request cancellation
- CSV writing
- catalog updates
- safe path resolution under `price-data/ibkr`
- source/cache invalidation messages for affected marked symbols

The browser service owns:

- DOM reads/writes
- progress rendering
- user-triggered requests
- symbol-copy convenience

## IBKR Bridge Plan

Create an internal bridge interface first so the UI and CSV logic do not depend on one IBKR client library:

```ts
interface IbkrHistoricalBridge {
    getStatus(): Promise<IbkrBridgeStatus>;
    resolveContracts(symbols: string[]): Promise<IbkrResolvedContract[]>;
    fetchHistoricalBars(request: IbkrHistoricalRequest): AsyncIterable<IbkrHistoricalBarBatch>;
}
```

Recommended implementation order:

1. TWS / IB Gateway bridge.
2. Client Portal Gateway bridge only if TWS / IB Gateway is blocked.

Reasons:

- TWS historical bars are a mature API path.
- Client Portal Gateway is local REST but requires browser authentication and at least daily reauthentication.
- Browser scraping should stay out of scope.

The first bridge spike should be a standalone script before UI integration:

```text
scripts/ibkr-sync-smoke.ts
```

Smoke target:

- connect to local IB Gateway / TWS
- resolve `NVDA`
- fetch `1d` bars ending at latest complete session
- write `price-data/ibkr/csv/1d/NVDA.csv`
- print first/last bar and count

Do not build the full UI until this smoke test proves the account/API path returns usable bars.

## Local Dataset Integration

Extend the local dataset registry, but do not hide IBKR semantics behind the current daily-only assumptions:

- Add dataset key such as `ibkr-stock`.
- Add catalog endpoint `/api/local-price-data/ibkr/catalog`.
- Add `candlesBasePath` pointing to `/price-data/ibkr/csv/<interval>` or route candle reads through an API endpoint if interval-specific paths are easier.
- Add provider label such as `IBKR Local`.
- Add a same-session catalog refresh/invalidation path for search, Finder, and symbol picker code.

The current `LocalDailyDatasetConfig` assumes one `candlesBasePath` per dataset. Because IBKR is timeframe-specific, choose one of these designs:

### Option A: one dataset per timeframe

Examples:

- `ibkr-stock-1d`
- `ibkr-stock-1h`
- `ibkr-stock-5m`

Pros:

- Minimal change to current local-daily loader.
- CSV paths remain static.

Cons:

- Search results may duplicate the same ticker across timeframe datasets.
- UI labels get noisy.

### Option B: add interval-aware local dataset paths

Change `LocalDailyDatasetConfig` to support:

```ts
candlesBasePath: string | ((interval: string) => string)
supportedIntervals?: string[]
```

Pros:

- Cleaner user model: one IBKR dataset.
- Matches the requested timeframe selection.

Cons:

- Touches shared loader contracts and needs broader tests.

Recommendation: use Option B if implementing the full IBKR manager, because IBKR is inherently syncable by timeframe. Use Option A only for a very narrow daily-only MVP.

### Provider Source Recommendation

Prefer a dedicated provider value:

```ts
type DataProvider = BinanceDataProvider | "bybit-tradfi" | "polymarket" | "local-daily" | "ibkr-local";
```

Reasons:

- `local-daily` currently implies bundled/local seed behavior and often daily-only behavior.
- IBKR is mutable and syncable.
- Provider labels, cache keys, SQLite rows, and status text should distinguish `NVDA♦` from `NVDA•`.
- A dedicated provider lets `DataPersistence` apply a source priority rule for bullet symbols without changing diamond behavior.

If the implementation keeps `local-daily`, it must still add source-specific metadata so IBKR CSVs are not treated as stale low-priority seeds.

### Source Priority Recommendation

Do not let old SQLite/IndexedDB data outrank newly synced IBKR CSVs.

Use one of these approaches:

- On every IBKR sync, write normalized bars to CSV, SQLite, and IndexedDB cache under the bullet symbol/provider key.
- Or add an `ibkr-csv` local source to `DataPersistence` with priority above generic cache/sqlite for bullet symbols.

The first approach is simpler operationally because Finder, Batch, chart loading, and detached reads already consult SQLite/cache.

## Finder And Batch Integration

Required behavior:

- `NVDA•` loads from `price-data/ibkr`.
- `NVDA•+AAPL•` builds a synthetic ratio from IBKR CSV legs.
- Finder Symbol Universe can run on bullet symbols.
- Batch Backtest can parse bullet symbols and synthetic bullet pairs.
- Rank Pairs can run on bullet synthetic pairs because it reuses Batch loading.

Touch points:

- `lib/local-daily-datasets.ts`
- `lib/data/data-provider-router.ts`
- `lib/data/data-persistence.ts`
- `lib/data/data-cache.ts`
- `lib/data-manager.ts`
- `lib/candle-cache.ts`
- `lib/finder-manager.ts`
- `scripts/lib/synthetic-pair.ts`
- `lib/batch-backtest/batch-backtest-loader.ts`
- `lib/rank-pairs/rank-pairs-service.ts` through shared Batch loader tests
- `lib/signal-committee-service.ts` through shared symbol parsing tests
- `lib/portfolioLab/portfolio-lab-synthetic.ts` if Portfolio Lab support is included
- `tests/stock-market-data.spec.ts` or a new `tests/ibkr-price-data.spec.ts`

Important existing behavior to preserve:

- Diamond stock-market symbols are daily-only.
- Bullet IBKR symbols should only coerce to `1d` when the requested IBKR timeframe is unavailable.
- Existing Binance/Bybit/Polymarket symbols must not change.
- Existing `AAPL♦+MSFT♦` behavior must remain valid.
- Finder `Local Seeds` should remain diamond/daily-oriented unless a separate IBKR universe helper is added.

### Finder UI Recommendation

Add a separate helper for IBKR symbols instead of changing `Local Seeds`:

- Keep `finderUniverseUseLocalSp500` behavior: fill local seeds and switch to `1d`.
- Add a later optional button such as `IBKR List` only if useful, fed from the IBKR catalog and preserving the selected interval.
- After IBKR sync, invalidate Finder's local-daily asset map and universe caches for affected symbols.

This avoids mixing "daily downloaded stock snapshots" with "syncable IBKR timeframe data."

## Sync Semantics

Full download:

1. Resolve contract.
2. Request historical bars for selected timeframe and window.
3. Normalize bars.
4. Write CSV atomically through a temporary file then replace.
5. Update `catalog.json`.
6. Write the normalized same data to SQLite/cache under the bullet symbol key, or mark the affected cache entries invalid.

Sync latest:

1. Read existing CSV.
2. Find latest complete candle time.
3. Request overlap from at least one candle before latest known time.
4. Merge by time.
5. Replace duplicate overlapping rows with the newest normalized row.
6. Write CSV atomically.
7. Update SQLite/cache or invalidate stale rows.
8. Clear in-memory CSV and feature-level caches for affected symbols if the app has already loaded them.

Required invalidation targets:

- `candle-cache.ts` local CSV cache and missing-file cache for affected IBKR files.
- `DataCache` entry for the bullet symbol/provider/interval.
- `DataManager.importedDataByKey` only if an imported or generated synthetic symbol overlaps.
- Finder `localDailyAssetMapPromise`, `universeDatasetCache`, and `syntheticSourceSeriesCache`.
- Batch `legCache` and `pairCache`.

If cache invalidation is not implemented in the MVP, the UI must say that a page reload is required after sync before Finder/Batch reruns use the new CSV.

Multiple-symbol downloads:

- Use a small concurrency limit.
- Respect IBKR pacing limits.
- Keep per-symbol failures isolated.
- Write successful symbols even when others fail.
- Preserve a resumable status log under `price-data/ibkr/logs`.

## Phased Implementation

### Phase 0: IBKR Smoke Test

Goal:

- Prove the local IBKR session can return historical bars for `NVDA`.

Work:

- Add a minimal bridge smoke script.
- Write one CSV into `price-data/ibkr/csv/1d`.
- Document required local IBKR process and port.

Verify:

- Manual run against TWS / IB Gateway.
- CSV has ascending rows and latest complete daily candle.

Stop condition:

- If API historical bars are not available despite the chart being visible, do not build the UI yet. Resolve IBKR permissions/bridge first.

### Phase 1: Bullet Symbol Dataset

Goal:

- Load `NVDA•` from local IBKR CSV without any sync UI.

Work:

- Add bullet marker helpers.
- Add `ibkr-local` provider or an explicit IBKR source branch if keeping `local-daily`.
- Add IBKR local dataset catalog endpoint.
- Add CSV loader path.
- Add provider routing.
- Decide and implement source priority so fresh IBKR CSV data is not hidden behind old SQLite/cache rows.
- Add tests for marker preservation and CSV parsing.

Verify:

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\ibkr-price-data.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\stock-market-data.spec.ts`

### Phase 2: Synthetic Bullet Pairs

Goal:

- Load `NVDA•+AAPL•` in chart/Finder/Batch.

Work:

- Update synthetic parsing and derivation helpers for bullet-marked symbols.
- Update interval coercion to understand IBKR supported intervals.
- Ensure Finder and Batch leg cache keys preserve `•`.
- Add cache invalidation hooks or clearly document reload-required behavior after CSV changes.
- Add regression tests beside existing diamond tests.

Verify:

- `..\..\..\node_modules\.bin\esno tests\synthetic-pair-transform.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\stock-market-data.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`

### Phase 3: IBKR Data Manager Tab

Goal:

- Add the Strategy panel UI for resolving, downloading, and syncing CSVs.

Work:

- Add lazy tab loader entry.
- Add partial, DOM contract, service, and Vite API client.
- Register lazy feature in `app-bootstrap.ts`.
- Add catalog refresh after successful writes.
- Add status/progress rendering and stop behavior.
- Add explicit "Copy bullet symbols" and "Copy for Batch/Finder" actions.
- Do not auto-inject downloaded symbols into Finder until cache/provider invalidation is implemented.

Verify:

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual UI smoke:
  - open IBKR Data tab
  - test connection
  - download `NVDA`
  - copy `NVDA•`
  - load chart

### Phase 4: Incremental Sync And Batch Safety

Goal:

- Reliable multi-symbol sync to latest complete candle.

Work:

- Add overlap merge.
- Add per-symbol status log.
- Add stop/cancel behavior.
- Add cache invalidation for synced symbols.
- Add failure summary for permissions, unresolved contracts, pacing, and empty data.
- Add Finder and Batch same-session verification after sync.

Verify:

- Sync a small list twice and confirm row count does not duplicate.
- Confirm latest row advances only when IBKR returns a newer complete candle.
- Confirm Finder/Batch use updated CSV after sync.
- Confirm Rank Pairs still works for bullet synthetic pairs if it is in scope.

## Test Plan

Unit tests:

- bullet marker mark/is/strip
- diamond marker behavior unchanged
- catalog endpoint returns `NVDA•`
- local CSV path strips bullet marker before file lookup
- parser accepts expected CSV shape
- synthetic derivation preserves bullet legs
- synthetic interval resolution handles IBKR intervals
- Batch parser preserves bullet marker
- Finder synthetic parser preserves bullet marker
- Portfolio parser preserves bullet marker if Portfolio support is touched
- local-source priority chooses freshly synced IBKR data over stale cache when that contract is implemented
- cache invalidation removes old IBKR CSV/cache entries
- sync merge replaces overlapping rows and appends new rows

Integration/manual tests:

- IBKR smoke script fetches `NVDA 1d`.
- UI downloads multiple symbols.
- UI sync latest does not duplicate rows.
- Chart loads `NVDA•`.
- Chart loads `NVDA•+AAPL•`.
- Finder Symbol Universe runs on bullet symbols.
- Batch Backtest runs on bullet symbols.
- Sync `NVDA•` while a Finder/Batch session has previously loaded it, then verify the rerun sees the new last candle or the UI explicitly requires reload.

Core validation commands:

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\stock-market-data.spec.ts
..\..\..\node_modules\.bin\esno tests\synthetic-pair-transform.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts
..\..\..\node_modules\.bin\esno tests\data-fetcher.spec.ts
```

## Risks

- IBKR chart visibility does not guarantee API historical-data access.
- IBKR pacing limits can make large universe downloads slow.
- Ambiguous stock contracts can download the wrong listing without explicit exchange/primary exchange.
- Intraday bars may have different availability and entitlement behavior than daily bars.
- The current local-daily registry is daily-shaped; interval-aware IBKR support is a real contract change.
- Reusing `local-daily` without a source-priority fix can serve old SQLite/cache data instead of the freshly synced CSV.
- Finder and Batch have independent in-memory caches, so sync can appear successful while research menus still run stale bars.
- The Finder `Local Seeds` button currently forces `1d`; broadening it for IBKR would be a conceptual bug for intraday IBKR data.
- The symbol search and local picker cache local catalogs; same-session catalog refresh must be intentional.
- Unicode marker handling must be tested because earlier diamond work already had parser regressions.
- Browser-side session automation or chart scraping would be brittle and should stay out of scope.

## Open Decisions

- Use TWS / IB Gateway first, or Client Portal Gateway first?
- Store only completed candles, or include the in-progress latest candle with metadata?
- Use ISO UTC or unix seconds in generated CSVs?
- Daily-only MVP first, or implement interval-aware local dataset support from the start?
- Should `catalog.json` store exchange, primary exchange, currency, and conId for resolved contracts?
- Should IBKR local symbols appear in the normal asset search immediately after sync, or only after reload/catalog refresh?
- Should synced IBKR CSVs also be mirrored into `price-data/market-data.sqlite` immediately?
- Should cache invalidation be implemented for same-session use in Phase 1, or deferred with a visible reload-required status?

## Recommended First Build

Build in this order:

1. Phase 0 smoke script.
2. Phase 1 local bullet dataset with one manually created CSV, including provider/source-priority decision.
3. Phase 2 synthetic bullet pair support, including Finder/Batch cache behavior.
4. Phase 3 UI tab after the local loader is proven.
5. Phase 4 incremental sync hardening and same-session invalidation.

This keeps the riskiest external dependency, IBKR data access, proven before the Strategy panel grows around it.
