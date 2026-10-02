# Price Data Loading and Persistence

This guide owns the shared price-data contracts in `lib/data/`,
`lib/candle-cache.ts`, the provider fetch helpers, and the local SQLite API.
See [Alpaca / IBKR sync](alpaca-ibkr-sync.md) for source provenance and sync,
[synthetic pairs](synthetic-pairs.md) for ratio construction, and
[server-side Batch](batch-backtest-server-side.md) for research loader budgets.

## Local source selection

`DataFetcher` checks explicit imports and its in-memory `DataCache` before
loading persisted sources. On a non-Binance fallback load,
`DataPersistence.loadNonBinanceLocalData` follows provider-specific rules:

- IBKR: a valid explicit import wins, then a valid bundled seed CSV. SQLite
  and IndexedDB are read only when neither authoritative source is available.
  Cancellation during seed loading prevents those fallback reads.
- Bybit: compare SQLite, IndexedDB, and seed candidates together. Imports
  take precedence; otherwise prefer the longest series, with source priority
  breaking ties. A short live overlay must not hide deeper seed history.

The IBKR fast path preserves that source precedence rather than assuming the
longest cached history is authoritative. Normalize times with the existing
time helpers and keep TradFi daily normalization in `data-interval-utils.ts`.

## Stream persistence

`DataPersistence.queuePersistCandles` coalesces updates for 1.2 seconds.
Only one flush per series can run at a time; updates arriving during a slow
flush form the next coalesced snapshot.

The initial SQLite delta contains the newest two bars. Subsequent deltas
include the last successfully persisted timestamp as well as newer bars:
live OHLCV changes at the same timestamp, and the previous candle's final
values may arrive alongside a new candle. SQLite upserts by
`(symbol, interval, time)` make this overlap safe.

Only a response with `ok: true` advances the SQLite cursor. A rejected write
retains that cursor for the next flush and immediately attempts an IndexedDB
fallback snapshot. Rejected responses emit `data.persist.sqlite_failed` and
unexpected exceptions emit `data.persist.stream_failed`; IndexedDB transaction failures emit
`data.cache.write_failed`. Event payloads contain keys/errors, not candle arrays.

IndexedDB snapshots use a separate successful-write clock from the
network/cache synchronization throttle. During continuous streaming they are
due every `DATA_CACHE_SYNC_MIN_MS` (30 seconds). `saveCachedCandles` returns
`true` only after transaction completion; unavailable storage, errors, aborts,
and synchronous storage failures return `false`. Failed snapshots remain due.
The persisted candle record and database version are unchanged.

## Fetch deadlines and pagination

Price-body consumers use `fetchAndConsumeWithTimeoutAndRetry` (Binance,
Bybit, and local asset catalogs) or `fetchLocalApiWithBody` (seed CSV/JSON
and SQLite JSON/binary transfers). These helpers keep the deadline and caller
abort signal active until the body consumer resolves. The response-returning
helpers remain available for callers that only need headers/status.

Binance backward pagination accepts a page only when its cursor moves strictly
backward and its final open time respects the requested end time. A stalled
or invalid page stops pagination and emits `data.fetch.pagination_stalled`;
discarded rows do not inflate candle progress. The existing request ceiling
still applies.

## SQLite authorization

All `/api/sqlite/*` routes use `isAllowedLocalRequest`, the same gate as the
other local APIs. Tokenless access requires a loopback peer and Host, together
with the shared gate's browser-header checks. Internal loopback calls may omit
Origin/Referer. Other callers, including tunnel requests, must supply
`Authorization: Bearer <LOCAL_PROXY_TOKEN>`; without a configured token they
are rejected. An Origin or Referer claiming localhost is insufficient.

## Server crypto CSV tails

`loadFreshCryptoCandlesFromDisk` accepts an optional `limitBars` after
`baseDir`. Batch and Finder historical callers pass their requested bar limit.
Cache hits materialize only that trailing range into fresh candle objects.
Cold reads still parse/cache the complete capped series, and detached callers
without a limit retain the full-series contract. File mtime invalidation and
the columnar cache's entry cap remain intact.

## Server IBKR seed sidecar

`loadFreshIbkrCandlesFromDisk` persists each parsed IBKR seed as a binary
columnar sidecar under `price-data/ibkr/seed-cache/<interval>/<SYM>.bin`
(mirroring the `csv/` tree; `price-data/` is gitignored). The sidecar stores
the post-normalization series with the source CSV's `(mtimeMs, size)` in its
header, so an IBKR/Alpaca sync that rewrites a seed invalidates its sidecar
automatically on the next stat — no explicit clear.

- Reads validate magic, format version, bar count, length, and the stat pair;
  any mismatch or I/O error falls back to the authoritative CSV text parse,
  which rewrites the sidecar atomically (tmp-then-rename).
- `limitBars` tail materialization works from sidecar columns exactly as it
  does from the in-memory parsed-seed cache.
- The sidecar amortizes parsing ACROSS worker processes and runs: the
  in-memory parsed-seed cache is per-process (512–4096 entries), which large
  TOP_MEAN runs exceed and then re-parse every seed. Sidecar files are
  regenerable data and safe to delete; set `IBKR_CSV_SEED_CACHE=0|false|off`
  to disable reads and writes.
- Bump `SEED_SIDECAR_FORMAT_VERSION` in
  `lib/batch-backtest/server-ibkr-csv-loader.ts` whenever the CSV parse or
  TradFi normalization behavior changes; stale-format sidecars are ignored and
  rebuilt.

## Validation

```powershell
npm run test -- data-persistence data-fetcher.spec.ts candle-cache.spec.ts fetch-helpers.spec.ts local-sqlite local-route-authorization.spec.ts server-crypto-csv-loader.spec.ts server-ibkr-csv-loader.spec.ts batch-backtest-server-loader-parity.spec.ts finder-server-loader-parity.spec.ts
npm run typecheck
npm run typecheck:tests
```

`tests/data-persistence-stream.spec.ts` covers write rejection/recovery,
same-timestamp corrections, snapshot cadence and abort recovery, serialized
slow writes, and authoritative IBKR source selection.
