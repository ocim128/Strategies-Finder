# Non-UI engineering improvements plan

Status: Accepted scope; planning only; implementation has not started.
Date: 2026-10-09.

Scope: implement all seven findings from the non-UI engineering audit. This
temporary plan is in `docs/` at the user's explicit request, overriding the
index's normal exclusion of active implementation plans. After delivery, fold
shipped behavior into the owning guides and remove this plan.

## Baseline and boundaries

The October 8 audit passed five focused specs and separately reproduced Rust
cache precision loss, expired body deadlines, timeout-induced crypto batch
cancellation, and same-second SQLite metadata collisions. October 9 source
inspection confirms those paths remain. Live-price identity and cache/CI
improvements are source-based findings, not measured production speedups.

Use the existing services, provider helpers, cache owners, local SQLite API,
and GitHub Actions workflow. Preserve strategy execution, sizing, settings,
source precedence, local authorization, Finder/Batch ownership and wire
contracts. No UI structure, new service, runtime dependency, Worker/D1 change,
or general cache framework is required.

Read [AGENTS.md](../AGENTS.md), [testing.md](testing.md),
[price-data.md](price-data.md), [engine contracts](backtest-engines-typescript-rust.md),
[synthetic pairs](synthetic-pairs.md), and [Batch server contracts](batch-backtest-server-side.md)
for the corresponding phase. Keep server modules free of browser-bound imports.

| Phase | Deliverable | Dependency | Estimated effort |
| --- | --- | --- | --- |
| 1 | Crypto timeout/failover correction | None | XS |
| 2 | Precise Rust dataset cache identity | None | S |
| 3 | Deadlines through crypto/live-price body reads | Phase 1 for crypto cancellation semantics | S |
| 4 | Provider-scoped live quotes and chart reuse | Phase 3; share service-level test coverage | S |
| 5 | Browser, Cargo, and timing-history CI caches | None | S |
| 6 | Candle-point retention budget | None; inspect browser and server callers | S |
| 7 | Transactional SQLite series revision | None; publish writer and fingerprint reader together | M |

Each phase should be a reviewable patch with its regression coverage. Effort
estimates include focused validation; XS is under one hour, S is about half a
day, and M is one to two days. Run integration checks after all phases.

## Phase 1 - Distinguish crypto endpoint timeout from Stop

**Objective:** A failed host can fall through to another host; an exhausted
symbol fails individually without cancelling remaining symbols.

**Tasks / deliverables:** In
[crypto-data-vite-plugin.ts](../lib/crypto-data/crypto-data-vite-plugin.ts),
change the catches in `fetchCryptoKlines` and `processCryptoSyncBatch` to use
the policy already applied by `fetchKlinesBatch` in
[binance.ts](../lib/dataProviders/binance.ts):

```ts
const cancelled = signal?.aborted ||
    (isAbortError(error) && !isTimeoutError(error));
```

Import the existing `isTimeoutError`; keep `isAbortError`'s shared definition.
Only cancellation ends the batch. Timeouts exhaust the existing retry/host
budget and reach `symbol_failed`, counters, and the existing warning log.
Retain owner checks, completed targets, NDJSON events, and Stop behavior.
Update the fetch/error-handling section of `price-data.md` after implementation.

**Risks:** Caller cancellation may itself carry a `TimeoutError` reason;
checking the caller signal first is required. Additional failover attempts
increase elapsed time by the existing attempt budgets, not an unbounded retry.

**Validation:** Extend `crypto-data-vite-plugin.spec.ts` with host timeout then
success, all hosts failing then a later symbol succeeding, and caller Stop
during requests/backoff. Exercise the actual kline fetch path with mocked
fetch and mock timers; a batch-only injected fetcher cannot verify failover.
Retain `fetch-helpers.spec.ts` coverage. Fixtures must stay in temporary storage.

**Exit criteria:** Timeout-only failures never report cancellation, Stop
prevents subsequent requests, and per-symbol/terminal counts agree.

## Phase 2 - Preserve Float64 precision in Rust cache keys

**Objective:** Changed low-priced candles cannot reuse the previous Rust data ID
because of the current six-decimal rounding.

**Tasks / deliverables:** In
[rust-engine-client.ts](../lib/rust-engine-client.ts), replace numeric rounding
in `mixHash` with word mixing over both halves of a Float64 representation.
Allocate one reusable eight-byte `DataView` per hash operation, not per field.
Continue hashing every candle, index, OHLCV field, and existing normalized time
representation into the two seeded accumulators. Preserve empty-input,
time-shape, four-entry LRU, invalidation, and cancellation behavior. Define
finite-value and signed-zero handling explicitly against `packData`/JSON
semantics; the key must describe the uploaded values.

The change is client-local. Rust's `cache_id_for_data` in
[routes.rs](../rust-engine/src/api/routes.rs) already hashes floating-point
bits; no Rust endpoint, protocol version, or service rebuild is needed.
Document the client identity rule in `backtest-engines-typescript-rust.md`.

**Risks:** More word mixing can increase hash CPU time. Preserve the O(n)
scan and bounded allocations; this remains a noncryptographic cache key,
not a mathematical guarantee against all hash collisions.

**Validation:** Extend `rust-engine-client.spec.ts`: identical copies reuse
one ID; `1e-7` versus `2e-7` closes require different keys and two uploads;
small mutations of each OHLCV field are detected; existing unsampled-candle
and supported-time tests remain valid. Run `finder-rust-batch-cancellation.spec.ts`
and `finder-universe-runner.spec.ts` for the `cacheData` callers. Compare hash
time on the existing 400,001-bar fixture before/after, without timing assertions.

**Exit criteria:** Precision fixtures distinguish datasets, unchanged uploads
still deduplicate, and measured overhead is acceptable. Client restart clears
old in-memory key mappings.

## Phase 3 - Keep deadlines active through body consumption

**Objective:** Stalled JSON bodies settle through the configured attempt
deadline and release pending work.

**Tasks / deliverables:** Use the existing
`fetchAndConsumeWithTimeoutAndRetry` in
[fetch-helpers.ts](../lib/dataProviders/fetch-helpers.ts) for `fetchCryptoKlines`
and the Binance/Bybit ticker branches of `fetchCurrentPrice` in
[live-positions-service.ts](../lib/live-positions-service.ts). Consume JSON
inside the callback; cancel unused terminal error bodies inside the same scope.
Preserve current timeout, retry status, attempt count, delay, and fallback
settings. Keep response-returning helpers for legitimate status-only consumers;
do not globally change their API or add retries to mutations.

Add service-level coverage to `crypto-data-vite-plugin.spec.ts` and a proposed
`tests/live-positions-service.browser.spec.ts`. The existing runner bundles
`.browser.spec.ts` for browser-coupled modules. Use only a narrow test seam if
needed to drive quote requests; avoid extracting a general transport/cache layer.
Update `price-data.md` with the migrated consumers.

**Dependencies / risks:** Apply Phase 1 first so exhausted crypto deadlines
remain symbol failures. A consumer exception can be retried by the shared
helper; keep terminal HTTP handling explicit and cover malformed JSON.
These are per-attempt deadlines; Retry-After/backoff and multiple endpoints
mean they are not a single whole-operation wall-clock limit.

**Validation:** Run `fetch-helpers.spec.ts`, the crypto spec, and the proposed
live-price spec. Mock headers followed by a stalled body, body-time caller
cancellation, retry success/exhaustion, malformed bodies, and normal responses.
Assert the live-price pending entry is released and a subsequent request can
start. Restore globals and clear/dispose all fixture resources.

**Exit criteria:** Body stalls time out at 30 seconds per crypto attempt and
5 seconds per ticker attempt; Stop remains effective after headers arrive.

## Phase 4 - Scope live quotes and chart shortcuts by provider

**Objective:** Spot and futures subscriptions for one symbol cannot share a
cached/in-flight quote or an incompatible chart close.

**Tasks / deliverables:** Resolve the provider before shortcuts in
`LivePositionsService.fetchCurrentPrice`. Key both `PRICE_CACHE` and
`PRICE_REQUESTS` by normalized symbol plus requested provider. Include the
normalized fallback interval for Bybit TradFi, whose fallback candle price
depends on that interval. Keep ticker-only Binance keys interval-independent.
Use the same key for insertion, lookup, and identity-safe pending cleanup.
Keep existing TTLs, clearing, endpoint/fallback policy, and public types.

Require matching loaded context before `getActiveChartPrice` can reuse Binance
candles. Reuse `DataManager.getLoadedContextKey()` in
[data-manager.ts](../lib/data-manager.ts), which captures loaded symbol,
interval, and Binance market. `state.binanceMarketType` alone describes the
selection and may change before replacement data loads. Where loaded provider
provenance cannot be established (including imported data), skip the shortcut;
do not invent persisted provenance or relabel unknown data.

**Dependencies / risks:** Build on Phase 3's service tests. Resolving the
provider earlier must preserve deduplication after the asynchronous resolution.
Skipping an unproven shortcut can add a quote fetch; existing Bybit fallback
semantics remain a separate source policy, not a guarantee of exchange parity.

**Validation / deliverables:** Extend the proposed live-price spec for concurrent
spot/futures requests, same-provider deduplication, TTL expiry, failed-request
recovery, TradFi interval identity, and market selection changing before chart
load completion. Assert returned prices/request counts, not implementation strings.
Document quote identity and shortcut eligibility in `price-data.md`.

**Exit criteria:** Each subscription receives its provider-scoped quote;
compatible callers still share work, and unknown/mismatched chart data is bypassed.

## Phase 5 - Reuse CI artifacts without skipping checks

**Objective:** Warm CI avoids repeated browser downloads/dependency compilation
and retains useful scheduling history.

**Tasks / deliverables:** Modify only
[strategies-finder-test-specs.yml](../.github/workflows/strategies-finder-test-specs.yml):

- Set an explicit job-level `PUPPETEER_CACHE_DIR` under the runner's temporary
  directory and cache that exact directory before `npm ci` in unit/E2E jobs.
  Key browser caches by OS/architecture and the app lockfile. Both jobs need
  the browser: `monte-carlo-dom.spec.ts` launches Puppeteer in the unit suite.
- After Rust toolchain installation, cache Cargo registry/index/git data and
  `rust-engine/target`. Include actual compiler identity, platform, and
  `rust-engine/Cargo.lock` in compatible keys. Keep fmt/test/clippy commands.
- Restore only `artifacts/test-logs/timings.json` before the unit command.
  Separate keys by runner/Node version and timing format; use a unique run ID
  plus attempt for saves, with a compatible restore prefix, so immutable
  cache entries do not freeze timing updates. Save updated history after
  successful tests; never restore `latest/` as execution evidence.

Keep npm caching, job permissions, versions, timeouts, failure logs, and full
test discovery. `scripts/run-tests.ts` already reads successful timings and
safely falls back on missing/corrupt history; no runner rewrite is required.
Update `testing.md` with the cache paths, key policies, and measured results.

**Risks / unknowns:** Net benefit depends on download/compile versus cache
transfer time. Actual CI timings are unavailable locally. Partition binary
caches by platform/compiler and cache no credentials or application databases.
Use the existing Actions cache family and verify action compatibility at implementation.

**Validation:** Compare cold, warm, and lockfile/compiler-change runs on Windows
unit and Linux E2E/Rust jobs. Verify browser launch, cache misses, refreshed
timings, and unchanged selected/pass counts. Existing runner contract tests
remain the scheduling gate; a local test run cannot prove hosted cache behavior.

**Exit criteria:** All three jobs pass on cache hits and misses; hosted logs
show artifact reuse and net savings. No test outcome is inferred from a cache.

## Phase 6 - Bound DataCache by retained candle points

**Objective:** Variable dataset sizes cannot turn a 64-entry cache into
unpredictable retained memory.

**Tasks / deliverables:** Add an optional constructor point budget, with a
named production default, to [data-cache.ts](../lib/data/data-cache.ts).
Retain the 64-entry LRU and use the dual-budget eviction pattern from
[point-bounded-parsed-cache.ts](../lib/data/point-bounded-parsed-cache.ts),
without converting candle objects to columns or merging the two cache classes.
Maintain per-key accounted lengths independently of mutable array references;
adjust totals on set, update, removal, invalidation, and clear. Oversized
datasets remain available to callers but are not retained. Expose scalar
point/eviction statistics without adding UI or per-candle logging.

Inspect both owners: browser `DataManager` and the singleton cache in
[server-data-fetcher-factory.ts](../lib/data/server-data-fetcher-factory.ts).
`DataManager.applyRealtimeCandle` mutates arrays without a full state commit;
notify cache accounting after accepted length-changing mutations using the
existing cache-key/update path. Preserve sanitization metadata semantics and
avoid per-tick array copies. Eviction must remove matching sync metadata;
persistence writes must not recreate orphan throttle entries for evicted keys.

**Risks / unknowns:** More misses can increase source reads; active datasets
and other caches retain independent references. A point cap bounds this cache,
not total process heap. One million points is an initial measurement candidate,
not a committed default. Choose the default from representative browser churn
and server fallback loads; allow constructor overrides without a new setting.

**Validation:** Extend `data-cache.spec.ts` with small configurable budgets:
LRU order, replacement, mutable-array growth/shrink, oversized entries, metadata
cleanup, and reset. Run `data-fetcher.spec.ts`, `data-persistence-stream.spec.ts`,
`data-manager-stream.browser.spec.ts`, and Batch/Finder server loader-parity
specs. Measure retained points, cache misses, source requests, wall time, and
heap on representative workloads; candle values/source precedence must agree.

**Exit criteria:** Bounds hold at cache writes and live length updates,
retention statistics reconcile, and the selected budget has acceptable reload
cost. The illustrative 6.4M-to-1M scenario reduces retained points by 84%; it
does not establish an equivalent total-heap reduction.

## Phase 7 - Add a transactional SQLite series revision

**Objective:** Same-second historical repairs change SQLite-backed synthetic
fingerprints even when count and endpoint timestamps are unchanged.

**Tasks / deliverables:** Extend the schema initialization in
[local-sqlite-vite-plugin.ts](../lib/local-sqlite-vite-plugin.ts) with this
proposed additive table, using the existing `CREATE TABLE IF NOT EXISTS` pattern:

```sql
CREATE TABLE IF NOT EXISTS series_revisions (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(symbol, interval)
);
```

Increment once per accepted JSON/binary `/store-ohlcv` request inside the
existing candle-upsert/metadata-invalidation transaction. Initial writes use
revision 1; conflict updates add 1. Rollback must undo candles, invalidation,
and revision together. Do not put the counter in `series_meta`, which is
deleted on every upsert, or scan historical candles to generate a revision.

Add `revision` to `/api/sqlite/series-meta` responses. Existing series without
a revision row read as 0; empty series retain existing null metadata behavior.
Preserve Unix-second `updatedAt` and all current response fields. Extend
`SeriesMetaResponse`/`binanceBackedSegment` in
[synthetic-pair-disk-cache.ts](../lib/batch-backtest/synthetic-pair-disk-cache.ts)
to validate and include the revision. Missing revisions from older endpoints
use an explicit legacy segment and retain only legacy freshness guarantees;
malformed supplied revisions must bypass disk caching rather than fabricate 0.
Bump `SYNTHETIC_PAIR_CACHE_VERSION` from the inspected value 8 to the next
version, verifying the current value at implementation. Keep CSV mtime
fingerprints and run-scoped memo/reset lifetimes intact.

**Deployment / risks:** This is `price-data/market-data.sqlite`, not Worker D1.
Initialize the extra table when opening fresh/existing databases, without
rewriting candles or adding a migration service. Deliver writer and reader
together and restart the local server. Existing test DB injection bypasses
initialization; update fixture schemas and test real initialization separately
in a temp directory. Revision guarantees cover writes through this plugin,
not external SQL edits or transactional snapshots across both legs. Version
invalidation causes a one-time pair-cache rebuild, including file-backed pairs.

**Validation:** Extend `local-sqlite-vite-plugin.spec.ts` and
`synthetic-pair-disk-cache.spec.ts`: frozen-time repairs, JSON/binary writes,
summary/default paths, independent series, revision failure rollback, legacy
metadata, malformed revisions, old-cache misses, and memo reset visibility.
Test fresh/old-schema startup, retained data, and restart persistence. Run
`local-sqlite-api.spec.ts`, local-route authorization, and both server
loader-parity specs. Update `price-data.md` and the Batch cache guide.

**Exit criteria:** Every committed plugin write advances revision, failed
writes do not, and same-second repair produces a disk-cache miss and rebuilt
data without changing candle or authorization contracts.

## Integration, evidence, and rollback

For each implementation patch, preview routing with
`rtk proxy npm.cmd run validate:changes`, add the semantic checks above, and
run application/test typechecks when TypeScript/specs change. Inspect test
selection with `--list --json`; execute test/validation commands sequentially
because they replace shared logs. Use mock timers, bounded waits, restored
mocks, and temporary fixtures as described in `testing.md`.

After all phases, run `rtk proxy npm.cmd run ci` and
`rtk proxy npm.cmd run test:e2e`; retain CI's Rust fmt/test/clippy checks and
hosted cache hit/miss evidence. Start Vite to check server import hygiene.
Exercise crypto failover/Stop, mixed-market quote isolation, bounded live
cache growth, and same-second synthetic rebuilds. Record unavailable hosted
or service checks explicitly; do not claim measured gains from estimates.

Rollback each phase independently: revert transport/quote/hash patches and
restart transient cache owners; remove workflow cache steps to restore cold
CI; increase/disable the point budget through constructor policy to restore
the former retention behavior. A SQLite code rollback leaves the additive
table intact. Stop jobs and invalidate regenerable synthetic disk caches
when switching writer/fingerprint versions; do not run old/new writers
concurrently or treat an old writer as revision-aware. Never delete candle
data or reverse the schema destructively. Previously computed research
results are snapshots and require reruns for corrected inputs.

Completion requires all seven delivered changes, passing required checks,
documented memory/CI measurements, and updates to the durable guides. Remove
this temporary plan and its index entry after folding the shipped behavior in.
