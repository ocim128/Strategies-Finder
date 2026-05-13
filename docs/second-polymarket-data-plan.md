# 1-Second Polymarket Data Plan

## Purpose

Build a maintainable 1-second data layer for BTCUSDT and XRPUSDT Polymarket research.

The layer must support:

- strict 1-second Binance and Polymarket alignment
- no-lookahead backtesting
- future chart integration
- future strategy features from Polymarket reference prices and Gamma market prices
- resumable mining through a separate CLI process

## Core Rule

Binance price and Polymarket price are different data types.

- Binance price is the underlying asset price, e.g. BTCUSDT or XRPUSDT.
- Polymarket reference price is Polymarket's streamed underlying BTC/XRP price.
- Polymarket market price is the YES/NO outcome price, usually a probability or quote.
- Polymarket Gamma price is a displayed market/outcome price snapshot, not a fill price.

Do not name Polymarket outcome prices as `btc_price` or `xrp_price`. Use names such as:

- `yes_price`
- `no_price`
- `yes_bid`
- `yes_ask`
- `yes_mid`
- `gamma_yes_price`
- `gamma_no_price`

Use names such as these for Polymarket underlying reference prices:

- `reference_symbol`
- `reference_price`
- `reference_source`
- `reference_source_ts_ms`

## Scope

Initial symbols:

- `BTCUSDT`
- `XRPUSDT`

Initial storage path:

```text
price-data/1second-chart/second-market-data.sqlite
```

Initial runtime shape:

- repo-owned TypeScript CLI
- optional `.bat` launcher
- no dependency on browser UI
- no Vite server requirement for mining

## Non-Goals

- Do not rewrite current 1m Polymarket scoring.
- Do not make the browser chart load large 1-second ranges in phase 1.
- Do not treat Gamma prices as executable fill prices.
- Do not treat Polymarket reference prices as executable YES/NO fill prices.
- Do not fill missing Polymarket seconds with future quotes.
- Do not support symbols beyond BTCUSDT and XRPUSDT until the two-symbol path is verified.

## Data Sources

### Binance 1s

Use Binance 1-second klines for underlying OHLCV.

Supported source types:

- spot klines
- futures klines if selected by current app market type

Stored as OHLCV candles.

### Polymarket CLOB

Use Polymarket CLOB orderbook, best bid/ask, price change, and last trade data for executable market pricing.

Stored as second-level quotes.

This is the only Polymarket source eligible for execution-quality backtest fills.

### Polymarket Reference Crypto Price

Use Polymarket RTDS crypto price streams for the Polymarket-side underlying BTC/XRP price.

Examples:

- `crypto_prices` for Binance-source symbols such as `btcusdt` and `xrpusdt`
- `crypto_prices_chainlink` for Chainlink-source symbols such as `btc/usd` and `xrp/usd`

Stored as reference price ticks.

Reference prices are strategy features and diagnostics. They are not YES/NO execution prices.

### Polymarket Gamma

Use Gamma API market/event fields for discovery and future strategy features.

Examples:

- `outcomePrices`
- `lastTradePrice`
- liquidity
- volume
- open interest
- active/closed flags

Stored as snapshots.

Gamma data is not execution data.

## Known Weaknesses To Avoid

- Do not conflate Gamma `outcomePrices` with Polymarket RTDS BTC/XRP reference prices.
- Do not align a delayed CLOB update backward to `source_ts_ms`; the quote is only safely known at `sample_ts`.
- Do not backfill historical CLOB 1-second quotes from minute-fidelity history and label it execution quality.
- Do not use the app's chart lookback limits as backtest data limits.
- Do not include open or incomplete Binance 1-second candles in backtests.
- Do not derive NO prices from YES prices unless the row is explicitly marked synthetic.

## Storage Contract

### Table: `binance_1s_candles`

Purpose: underlying asset OHLCV at 1-second resolution.

```sql
CREATE TABLE IF NOT EXISTS binance_1s_candles (
    symbol TEXT NOT NULL,
    market_type TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    trade_count INTEGER,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(symbol, market_type, ts)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_binance_1s_symbol_time
    ON binance_1s_candles(symbol, market_type, ts);
```

### Table: `polymarket_clob_1s_quotes`

Purpose: executable Polymarket quote state by second.

```sql
CREATE TABLE IF NOT EXISTS polymarket_clob_1s_quotes (
    series_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    outcome_interval TEXT NOT NULL DEFAULT '5m',
    event_start_ts INTEGER NOT NULL,
    event_end_ts INTEGER NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    market_slug TEXT NOT NULL DEFAULT '',
    yes_token_id TEXT NOT NULL,
    no_token_id TEXT NOT NULL DEFAULT '',
    sample_ts INTEGER NOT NULL,
    yes_bid REAL,
    yes_ask REAL,
    yes_mid REAL,
    yes_last REAL,
    no_bid REAL,
    no_ask REAL,
    no_mid REAL,
    no_last REAL,
    source TEXT NOT NULL,
    source_ts_ms INTEGER,
    quote_age_ms INTEGER,
    quality_flags TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(series_id, event_start_ts, yes_token_id, sample_ts)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_clob_1s_symbol_time
    ON polymarket_clob_1s_quotes(symbol, sample_ts);

CREATE INDEX IF NOT EXISTS idx_clob_1s_event_time
    ON polymarket_clob_1s_quotes(series_id, event_start_ts, sample_ts);
```

`sample_ts` is the miner sample second.

`source_ts_ms` is the timestamp from the latest underlying CLOB update used to build the sample.

Strict execution alignment compares fill time to `sample_ts`. `source_ts_ms` is freshness metadata.

### Table: `polymarket_reference_1s_prices`

Purpose: Polymarket-side BTC/XRP reference price ticks for future strategy features.

```sql
CREATE TABLE IF NOT EXISTS polymarket_reference_1s_prices (
    symbol TEXT NOT NULL,
    reference_source TEXT NOT NULL,
    source_symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    source_ts_ms INTEGER NOT NULL,
    received_ts_ms INTEGER,
    reference_price REAL NOT NULL,
    full_accuracy_value TEXT NOT NULL DEFAULT '',
    is_carried_forward INTEGER NOT NULL DEFAULT 0,
    quality_flags TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(symbol, reference_source, source_ts_ms)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_reference_1s_symbol_time
    ON polymarket_reference_1s_prices(symbol, reference_source, ts);
```

### Table: `polymarket_gamma_snapshots`

Purpose: Gamma market price and metadata snapshots for future strategy features.

```sql
CREATE TABLE IF NOT EXISTS polymarket_gamma_snapshots (
    series_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    outcome_interval TEXT NOT NULL DEFAULT '5m',
    market_id TEXT NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    market_slug TEXT NOT NULL DEFAULT '',
    event_start_ts INTEGER NOT NULL,
    event_end_ts INTEGER NOT NULL,
    snapshot_ts INTEGER NOT NULL,
    gamma_yes_price REAL,
    gamma_no_price REAL,
    last_trade_price REAL,
    liquidity REAL,
    volume REAL,
    open_interest REAL,
    active INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    remote_updated_at INTEGER,
    raw_json_hash TEXT NOT NULL DEFAULT '',
    raw_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(series_id, market_id, snapshot_ts)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_gamma_symbol_time
    ON polymarket_gamma_snapshots(symbol, snapshot_ts);

CREATE INDEX IF NOT EXISTS idx_gamma_event_time
    ON polymarket_gamma_snapshots(series_id, event_start_ts, snapshot_ts);
```

`raw_json` is optional debug storage. The live miner stores `raw_json_hash` and leaves `raw_json` null by default to keep long-running databases bounded.

### Table: `second_data_sync_state`

Purpose: resumable mining cursors.

```sql
CREATE TABLE IF NOT EXISTS second_data_sync_state (
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    series_id TEXT NOT NULL DEFAULT '',
    cursor_ts INTEGER,
    cursor_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(source, symbol, series_id)
);
```

### Table: `second_data_quality_runs`

Purpose: store validation output for each mined range.

```sql
CREATE TABLE IF NOT EXISTS second_data_quality_runs (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    binance_seconds INTEGER NOT NULL,
    clob_quote_seconds INTEGER NOT NULL,
    reference_price_seconds INTEGER NOT NULL,
    gamma_snapshot_count INTEGER NOT NULL,
    binance_gap_count INTEGER NOT NULL,
    clob_gap_count INTEGER NOT NULL,
    reference_gap_count INTEGER NOT NULL,
    exact_quote_coverage_pct REAL NOT NULL,
    max_quote_age_sec INTEGER,
    max_reference_age_sec INTEGER,
    created_at INTEGER NOT NULL
);
```

## Alignment Contract

All times are Unix UTC seconds.

For Binance 1-second candle at `ts`:

```text
candle covers [ts, ts + 1)
```

For strategy decision at candle `ts`:

```text
earliest fair execution second = ts + 1
```

For a Polymarket CLOB sampled row:

```text
quote_ts = sample_ts
```

For Polymarket CLOB quote time `quote_ts`:

```text
quote can be used for fill_ts only when quote_ts <= fill_ts
```

Containing event rule:

```text
event_start_ts <= fill_ts < event_end_ts
```

No trade may open at or after `event_end_ts`.

Strict mode:

```text
sample_ts must equal fill_ts
```

Causal relaxed mode:

```text
sample_ts <= fill_ts
fill_ts - sample_ts <= maxQuoteAgeSec
```

Reference feature mode:

```text
reference_ts = floor(source_ts_ms / 1000)
reference_ts <= bar_ts
bar_ts - reference_ts <= maxReferenceAgeSec
```

Gamma feature mode:

```text
snapshot_ts <= bar_ts
bar_ts - snapshot_ts <= maxGammaAgeSec
```

Never use:

```text
quote_ts > fill_ts
reference_ts > bar_ts
snapshot_ts > bar_ts
```

## Fill Price Rules

Backtest fill source must be explicit.

Allowed execution-quality sources:

- CLOB bid
- CLOB ask
- CLOB mid only if strategy mode explicitly allows midpoint simulation
- CLOB last only if strategy mode explicitly allows last-trade simulation

Default fill policy:

- buy YES uses `yes_ask`
- sell YES uses `yes_bid`
- buy NO uses `no_ask`
- sell NO uses `no_bid`

Fallback rules:

- if exact quote is missing in strict mode, mark trade unscored
- if quote age is too old in causal relaxed mode, mark trade unscored
- if only Gamma exists, do not fill
- if only Polymarket reference price exists, do not fill
- if NO bid/ask is missing, do not derive it from YES unless the row is marked `synthetic_no_from_yes`

## CLI Contract

Primary command:

```text
npm run mine:1s -- --symbols BTCUSDT,XRPUSDT --mode live
```

Useful modes:

```text
--mode backfill
--mode live
--mode verify
```

Useful source flags:

```text
--include-binance
--include-clob
--include-reference
--include-gamma
```

Default cadence:

```text
binance backfill: paginated REST
clob live: websocket capture, active and near-future token ids, refreshed every 60 seconds
reference live: RTDS websocket capture
gamma live: poll every 30 seconds
```

Recommended Windows launcher:

```text
scripts/run-1s-miner.bat
```

The `.bat` file must only call the npm script. It must not contain mining logic.

## Module Layout

```text
scripts/
  second-market-miner.ts
  run-1s-miner.bat

lib/second-market/
  schema.ts
  db.ts
  symbols.ts
  binance-1s-sync.ts
  polymarket-clob-sync.ts
  polymarket-reference-sync.ts
  polymarket-gamma-sync.ts
  alignment.ts
  quality-report.ts
  loaders.ts
```

## Phase 0: Contract And Guards

Purpose: prevent ambiguous implementation before code exists.

Deliverables:

- define symbol allowlist: BTCUSDT, XRPUSDT
- define source names: `binance_1s`, `polymarket_clob_1s`, `polymarket_reference_1s`, `polymarket_gamma`
- define SQLite path constant
- define alignment modes: `strict`, `causal_relaxed`
- define default quote age limits
- define default reference age limits
- add `1s` interval parsing support in the app interval utilities
- add docs link from `docs/polymarket.md`

Verification:

- typecheck
- unit tests for source naming and alignment mode constants

Exit criteria:

- no module uses Polymarket Gamma as execution price
- no module uses Polymarket reference price as YES/NO execution price
- no module calls Polymarket outcome price `btc_price` or `xrp_price`
- `parseIntervalSeconds("1s")` returns 1

## Phase 1: SQLite Schema And Access Layer

Purpose: create durable local storage independent from the browser app.

Deliverables:

- create `lib/second-market/schema.ts`
- create `lib/second-market/db.ts`
- create migrations for all tables
- add insert/upsert helpers
- add range query helpers
- add sync-state read/write helpers

Verification:

- schema creation test
- upsert idempotency test
- range query ordering test

Exit criteria:

- database can be created at `price-data/1second-chart/second-market-data.sqlite`
- repeated inserts do not duplicate rows
- all range queries return ascending timestamps

## Phase 2: Binance 1s Backfill

Purpose: mine underlying 1-second OHLCV data.

Deliverables:

- add Binance 1s REST pagination
- update Binance interval support lists for `1s`
- support spot/futures market type
- store OHLCV in `binance_1s_candles`
- update sync cursor after each committed batch
- report gaps after each range
- exclude open or incomplete 1-second candles
- keep miner and backtest range loading independent from `DATA_CHART_TOTAL_LIMIT`

Verification:

- fetch one short BTCUSDT range
- fetch one short XRPUSDT range
- assert timestamps are 1-second aligned
- assert duplicate backfill is idempotent
- assert latest open candle is not included

Exit criteria:

- BTCUSDT and XRPUSDT can be backfilled over a requested range
- interrupted backfill resumes from stored cursor
- gaps are reported, not hidden

## Phase 3: Polymarket Event Mapping

Purpose: map Binance symbols and timestamps to the correct Polymarket event markets.

Deliverables:

- reuse existing local outcome rows where possible
- define symbol-to-series mapping for BTCUSDT and XRPUSDT
- keep outcome interval explicit, default `5m`
- load event rows by symbol, series, and time range
- resolve YES/NO token ids for each event
- expose event lookup by timestamp
- use `event_start_ts <= ts < event_end_ts`

Verification:

- BTCUSDT timestamp maps to expected BTC event
- XRPUSDT timestamp maps to expected XRP event
- timestamp outside known event returns null
- timestamp equal to `event_end_ts` returns null

Exit criteria:

- CLOB and Gamma sync modules can resolve active event metadata without duplicating outcome-sync logic

## Phase 4: Polymarket CLOB 1s Capture

Purpose: capture executable Polymarket quote state.

Deliverables:

- subscribe to active YES/NO token ids
- maintain latest bid/ask/last per token
- write one quote row per second per active event
- keep `sample_ts` separate from `source_ts_ms`
- mark quote source and quality flags
- mark carried-forward quote samples with quote age
- rotate subscriptions as events change
- block historical minute-fidelity price history from execution-quality labels

Verification:

- captured rows contain no future timestamps
- YES and NO prices stay in probability bounds
- missing bid/ask produces nulls, not fabricated prices
- strict-mode execution eligibility is based on `sample_ts`
- delayed CLOB source timestamps are reported through quote age and quality flags
- quote writer survives reconnect

Exit criteria:

- live miner captures CLOB quotes for BTCUSDT and XRPUSDT
- quote coverage report shows exact second coverage
- reconnect does not corrupt timestamps

## Phase 5: Polymarket Reference Price Capture

Purpose: store Polymarket-side underlying BTC/XRP reference prices for future strategy features and diagnostics.

Deliverables:

- subscribe to RTDS `crypto_prices` for `btcusdt` and `xrpusdt`
- optionally subscribe to RTDS `crypto_prices_chainlink` for `btc/usd` and `xrp/usd`
- store source timestamp and received timestamp
- store carried-forward flag when present
- expose causal reference price by chart time

Verification:

- reference price rows store BTCUSDT and XRPUSDT values
- reference price timestamps come from payload measurement time
- carried-forward values are flagged
- future reference ticks are rejected by alignment tests

Exit criteria:

- Polymarket reference prices are available as strategy features
- reference prices can be compared against Binance 1s candles
- reference prices remain blocked from YES/NO fill-price paths

## Phase 6: Polymarket Gamma Snapshot Capture

Purpose: store Gamma market price and metadata for future strategy features.

Deliverables:

- poll Gamma event/market endpoint by active event slug or market id
- parse `outcomePrices` into `gamma_yes_price` and `gamma_no_price`
- parse `lastTradePrice`, liquidity, volume, and open interest
- store active-event snapshots at configured cadence
- store raw JSON hash for auditability

Default cadence:

```text
30 seconds
```

Verification:

- Gamma snapshot stores expected YES/NO prices
- snapshot timestamps are local capture time in Unix seconds
- repeated unchanged snapshots are either deduped by hash or safely upserted

Exit criteria:

- Gamma snapshots are available for BTCUSDT and XRPUSDT events
- strategy feature loaders can request causal Gamma state by chart time
- Gamma remains blocked from fill-price paths

## Phase 7: Alignment And Feature Loaders

Purpose: provide one tested path for backtest and future strategy use.

Deliverables:

- `loadSecondMarketWindow(symbol, startTs, endTs)`
- `alignClobQuotesToCandles(...)`
- `alignReferencePricesToCandles(...)`
- `alignGammaSnapshotsToCandles(...)`
- quality fields per aligned row:
  - `hasExactClobQuote`
  - `clobQuoteAgeSec`
  - `hasReferencePrice`
  - `referenceAgeSec`
  - `hasGammaSnapshot`
  - `gammaAgeSec`
  - `qualityFlags`

Verification:

- exact alignment test
- causal relaxed alignment test
- future quote rejection test
- future reference price rejection test
- future Gamma snapshot rejection test
- missing data remains missing

Exit criteria:

- backtest code can consume aligned CLOB data without custom timestamp logic
- strategy code can consume aligned reference and Gamma features without custom timestamp logic

## Phase 8: Backtest Integration

Purpose: allow 1-second Polymarket performance testing without changing current 1m behavior.

Deliverables:

- add a gated 1s Polymarket evaluation path
- require TypeScript engine
- require explicit 1s interval
- require explicit Polymarket CLOB fill source
- produce coverage summary in result
- keep existing `signal_exit_same_event` behavior unchanged for 1m

Verification:

- long entry uses causal CLOB ask
- short/NO entry uses causal CLOB ask for NO
- exit uses causal bid for the held side
- missing exact quote creates unscored trade in strict mode
- future quote is never selected
- reference and Gamma prices cannot satisfy missing CLOB fills

Exit criteria:

- 1s backtest can score BTCUSDT and XRPUSDT against CLOB quotes
- result reports skipped trades and quote coverage
- no existing 1m Polymarket tests regress

## Phase 9: Strategy Context Integration

Purpose: expose reference, Gamma, and CLOB features to strategies without allowing strategy-side fetches.

Deliverables:

- add optional second-market context to strategy execution context
- expose aligned arrays only
- expose age and quality fields
- document that strategies must not fetch Polymarket data directly

Possible context shape:

```ts
context.secondMarket = {
    symbol,
    clob: alignedClobRows,
    reference: alignedReferenceRows,
    gamma: alignedGammaRows,
    quality: alignedQualityRows,
};
```

Verification:

- strategy receives arrays matching primary data length
- all feature timestamps are causal
- missing feature rows are explicit nulls

Exit criteria:

- future strategies can use Polymarket reference price and Gamma market price as features
- execution fills still use backtest-owned CLOB pricing

## Phase 10: Chart Integration

Purpose: display 1-second data without loading unbounded ranges.

Deliverables:

- add read-only `1s` panel tab
- load bounded ranges from SQLite through `/api/second-market/window`
- render Binance 1-second candles
- render Polymarket CLOB YES/NO bid/ask lines on a probability scale
- render RTDS reference price separately from CLOB execution prices
- show coverage, lag, quote age, active event, and latest Gamma prices

Verification:

- chart loads a short 1s range
- chart does not request unbounded 1s history
- overlay timestamps match candle timestamps

Exit criteria:

- chart can inspect mined 1s data
- chart does not start, stop, mutate, or backfill mining data
- chart uses `price-data/1second-chart/second-market-data.sqlite`

## Phase 11: Operations

Purpose: make mining safe to run unattended.

Deliverables:

- `.bat` launcher
- log directory under `price-data/1second-chart/logs`
- lock file or DB lock guard
- graceful shutdown
- reconnect policy
- periodic quality summary

Verification:

- second miner instance exits or waits safely
- Ctrl+C flushes pending rows
- logs include source, symbol, cursor, and latest write time

Exit criteria:

- miner can run through Windows Task Scheduler
- restart resumes without duplicate or corrupted data

## Validation Commands

Core:

```text
npm run typecheck
npm run test
```

Targeted:

```text
..\..\..\node_modules\.bin\esno tests\second-market-schema.spec.ts
..\..\..\node_modules\.bin\esno tests\second-market-alignment.spec.ts
..\..\..\node_modules\.bin\esno tests\second-market-reference.spec.ts
..\..\..\node_modules\.bin\esno tests\second-market-backtest.spec.ts
```

Manual:

```text
npm run mine:1s -- --symbols BTCUSDT,XRPUSDT --mode verify
```

## Success Criteria

The implementation is acceptable only when:

- every stored timestamp is Unix UTC seconds
- Binance and Polymarket rows are joined causally
- future quotes are rejected by tests
- future reference prices are rejected by tests
- Gamma snapshots are available as features only
- Polymarket reference prices are available as features only
- CLOB quotes are the only Polymarket execution-price source
- missing seconds are reported, not fabricated
- CLOB strict mode uses `sample_ts` and never back-aligns delayed source updates
- BTCUSDT and XRPUSDT are both covered
- the miner is resumable
- current 1m Polymarket scoring still passes existing tests

## Source References

- Binance spot klines support `1s`: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- Binance futures interval definitions include `1s`: https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition
- Polymarket API split: https://docs.polymarket.com/api-reference/introduction
- Polymarket Gamma outcome prices: https://docs.polymarket.com/market-data/overview
- Polymarket CLOB price endpoint: https://docs.polymarket.com/api-reference/market-data/get-market-price
- Polymarket market WebSocket: https://docs.polymarket.com/api-reference/wss/market
- Polymarket RTDS crypto prices: https://docs.polymarket.com/market-data/websocket/rtds
