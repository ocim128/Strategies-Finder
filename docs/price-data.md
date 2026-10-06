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

IBKR daily stock normalization excludes flat, zero-volume carry-forward
placeholders before session deduplication and lookback slicing. This rule
also applies to imports, persisted fallbacks, warm browser caches, and the
server CSV loader. It prevents stale pre-split IEX closes from becoming
signals or fills; see [Alpaca / IBKR sync](alpaca-ibkr-sync.md).
Parsed-seed sidecars and synthetic-pair disk caches from before this rule
are version-invalidated and rebuild automatically. Existing TOP_MEAN results,
archives, and endpoint dataset references are snapshots: rerun or regenerate
them to obtain results using the filtered candles.

The IBKR fast path preserves that source precedence rather than assuming the
longest cached history is authoritative. Normalize times with the existing
time helpers and keep TradFi daily normalization in `data-interval-utils.ts`.
Warm IBKR cache entries receive a provider/interval/revision `sanitizedFor`
stamp after normalization. Repeated reads reuse the normalized candles;
unguarded replacements and updates clear the stamp. Bump the IBKR revision in
`DataFetcher.getSanitizedCacheMetadata` when normalization behavior changes.

## Browser cache and live-stream lifecycle

IndexedDB retains a successful connection or an in-flight open. Failed opens
can retry after a one-second cooldown, and an open that stalls for eight
seconds falls back to other sources. A late successful open is closed rather
than retained. Version-change events close and invalidate the connection so
another tab can clear or upgrade the database. Failed or aborted reads return
`null`; failures emit `data.cache.read_failed` without candle payloads.

Realtime rolling-window eviction removes the same timestamps from the
crosshair candle lookup, keeping both representations bounded by the active
lookback. WebSocket construction starts a handshake; only a current socket's
`open` event resets reconnect attempts and emits `data.stream.connected`.
Failures before opening retain the existing exponential backoff and ceiling.

## Chart display modes and live ticks

`state.ohlcvData` always holds raw OHLCV and is the only input to strategies,
persistence, and research paths. Chart mode (`candlestick` or `heikin-ashi`)
is a visual transformation applied when the displayed series is built:
`chartManager.updateChartData()` performs the full transform, and live stream
ticks go through `chartManager.updateLiveCandle` — candlestick mode keeps the
incremental raw update, Heikin Ashi mode recomputes only the transformed tail
in constant time from a bounded tail state, so the displayed bar always
matches a full redraw without a per-tick data commit. Rolling-window
evictions re-seed the Heikin Ashi chain (the first bar anchors every later
value), so an evicting tick rebuilds the displayed series through
`updateChartData` with the visible range preserved.

## Stream persistence

`DataPersistence.queuePersistCandles` coalesces updates for 1.2 seconds.
Only one flush per series can run at a time; updates arriving during a slow
flush form the next coalesced snapshot.

The initial SQLite delta contains the newest two bars. Subsequent deltas
include the last successfully persisted timestamp as well as newer bars:
live OHLCV changes at the same timestamp, and the previous candle's final
values may arrive alongside a new candle. SQLite upserts by
`(symbol, interval, time)` make this overlap safe.

Normalized, sorted realtime callers opt into tail-only delta selection. Other
callers retain the full-filter path, and malformed tails fall back to it.
The delta and its cursor are captured before awaiting SQLite. Full arrays are
copied only for due IndexedDB snapshots or failed-write fallback. The snapshot
clock is checked again after slow writes; deferred snapshots may capture newer
live updates without advancing SQLite's cursor beyond acknowledged rows.

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
Binance exchange-info and synthetic-pair SQLite metadata reads also consume
their JSON bodies inside the deadline, so a stalled body cannot hold a shared
catalog load or fingerprint lookup indefinitely.

The shared provider helper retries its own deadline failures within the
configured attempt budget, preserving `TimeoutError` even when fetch reports
an `AbortError` for that deadline. Binance then tries its next endpoint after
exhausting timeout retries. Caller cancellation stops retries and failover
immediately, including when the caller's abort reason is `TimeoutError`.

Binance backward pagination accepts a page only when its cursor moves strictly
backward and its final open time respects the requested end time. A stalled
or invalid page stops pagination and emits `data.fetch.pagination_stalled`;
discarded rows do not inflate candle progress. The existing request ceiling
still applies.
Forward gap-fill pagination likewise validates its first/last timestamps and
strictly advancing cursor before accepting a page or reporting progress.

## SQLite metadata freshness

Every successful candle upsert invalidates its series metadata inside the
write transaction, including stream/default writes that omit `summary`.
The next `/series-meta` read rebuilds count, first/last timestamps, and the
update timestamp from committed candles; `summary=true` writes rebuild
immediately. Other series remain cached. This keeps Binance synthetic-pair
fingerprints fresh after appends and historical corrections without a full
summary scan on every stream write. Update timestamps retain Unix-second
precision, so corrections within the same second can share a fingerprint.

## SQLite authorization

All `/api/sqlite/*` routes use `isAllowedLocalRequest`, the same gate as the
other local APIs. Tokenless access requires a loopback peer and Host, together
with the shared gate's browser-header checks. Internal loopback calls may omit
Origin/Referer. Other callers, including tunnel requests, must supply
`Authorization: Bearer <LOCAL_PROXY_TOKEN>`; without a configured token they
are rejected. An Origin or Referer claiming localhost is insufficient.

## Server crypto CSV tails

Both server CSV loaders share their columnar representation in
`lib/data/ohlcv-columns.ts`: one six-column `OhlcvColumns` shape, one
`columnsFromCandles` packer, and one `candlesFromColumns(columns, startIndex)`
materializer that returns fresh candle objects. The IBKR seed sidecar uses the
same shape without changing its binary format. Provider loaders keep their own
limit normalization and bounds: crypto clamps `limitBars` before materializing
and applies the limit on cold reads too, while IBKR cold text reads return the
full parsed series and warm/sidecar hits materialize the requested tail.

`loadFreshCryptoCandlesFromDisk` accepts an optional `limitBars` after
`baseDir`. Batch and Finder historical callers pass their requested bar limit.
Cache hits materialize only that trailing range into fresh candle objects.
Cold reads still parse/cache the complete capped series, and detached callers
without a limit retain the full-series contract. File mtime invalidation and
the columnar cache's entry cap remain intact.
The crypto cache also caps retention at eight million candle points (six
Float64 columns, at most 384 MB of backing arrays) per process, alongside the
512-entry cap. It shares `PointBoundedParsedCache` with IBKR daily targets.
`getParsedCryptoCsvCacheStats()` exposes entries, retained points, and budget
evictions; clearing the cache resets these counters. Evicted data is reloaded
normally without changing candle values.

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
  in-memory parsed-seed cache is per-process, which large
  TOP_MEAN runs exceed and then re-parse every seed. Sidecar files are
  regenerable data and safe to delete; set `IBKR_CSV_SEED_CACHE=0|false|off`
  to disable reads and writes.
- Main-thread daily targets use a separate 8,192-entry LRU capped at 8 million
  candle points (six Float64 columns, about 384 MB). The original 512-entry
  seed cache and 4,096-entry main-thread 4h cache retain their own budgets.
  Mtime validation, clear, and fresh candle-object materialization apply to
  all three caches. A daily series larger than its point budget is returned
  normally and evicted from retained columns.
- Bump `SEED_SIDECAR_FORMAT_VERSION` in
  `lib/batch-backtest/server-ibkr-csv-loader.ts` whenever the CSV parse or
  TradFi normalization behavior changes; stale-format sidecars are ignored and
  rebuilt.

## Validation

```powershell
npm run test -- data-persistence data-fetcher.spec.ts candle-cache data-manager-stream.browser.spec.ts point-bounded-parsed-cache.spec.ts fetch-helpers.spec.ts local-sqlite local-route-authorization.spec.ts server-crypto-csv-loader.spec.ts server-ibkr-csv-loader.spec.ts batch-backtest-server-loader-parity.spec.ts finder-server-loader-parity.spec.ts
npm run typecheck
npm run typecheck:tests
```

`tests/data-persistence-stream.spec.ts` covers write rejection/recovery,
same-timestamp corrections, snapshot cadence and abort recovery, serialized
slow writes, and authoritative IBKR source selection.
