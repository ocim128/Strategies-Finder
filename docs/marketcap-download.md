# Market Cap download for IBKR Data — technical plan

**Status: planning document. Not yet implemented.**
**Revision 2** — folds in corrections from a skeptical audit (2026-09-12):
split-factor convention is now defined explicitly with a numeric invariant,
EDGAR facts are anchored point-in-time at the filing date, the
split-correction-failure fallback was removed (strict per-symbol failure),
wire-type changes are stated precisely, and Phase 1 gained live-fixture exit
criteria.

## Motivation

The planned "TOP_MEAN coordinator" experiment needs a market-cap series per
S&P 500 symbol over roughly the last 5 years. Alpaca does not provide market
cap or shares outstanding through any endpoint (its Market Data API is
bars/quotes/trades/corporate-actions/news only), so the data must be assembled:

```
marketcap(t) = price(t) × sharesOutstanding(t)
```

`price(t)` already exists as local `1d` CSVs under `price-data/ibkr/csv/1d/`.
`sharesOutstanding(t)` is freely available from SEC EDGAR XBRL company-concept
data: each 10-Q/10-K cover page reports `dei:EntityCommonStockSharesOutstanding`,
mandatory since late 2019 (assumption — verified via fixtures in Phase 1),
roughly 15–20 quarterly snapshots per symbol over a 5-year window, one small
JSON request per symbol, no API key.

This document plans a **Download MarketCap** button on the existing **IBKR
Data** tab. It follows the architecture of the existing Alpaca source
(`docs/alpaca-ibkr-sync.md`): a provider-shaped leaf fetcher next to the
server plugin, the existing batch/stream/stop/reattach machinery, and a new
on-disk dataset that stays strictly outside the candle CSV tree.

## Current architecture (context for the plan)

The IBKR Data feature is one vertical slice in `lib/ibkr-data/`:

- `html-partials/tab-ibkr-data.html` — buttons (`ibkrDataDownloadBtn`,
  `ibkrDataSyncBtn`, `ibkrDataStopBtn`, ...) and inputs (`ibkrDataSymbols`,
  `ibkrDataSource`, `ibkrDataInterval`, `ibkrDataPeriod`).
- `lib/ibkr-data/ibkr-data-dom.ts` — `IBKR_DATA_REQUIRED_IDS` DOM contract +
  `createIbkrDataDom()`, verified by `tests/feature-dom-contracts.spec.ts`.
- `lib/ibkr-data/ibkr-data-service.ts` — browser service (`IbkrDataService`):
  one click handler per button, `runAction(url, invalidate)` POSTs
  `{symbols, interval, source, period}`, consumes NDJSON via
  `consumeNdjsonStream`, aggregates events into status/output, and
  invalidates local caches in `finally`. Also reattach-polls
  `GET /api/ibkr/sync/status` after reload. Provider labels are derived from
  `source` in several places (reattach completion ~line 91,
  `renderRunSnapshot` ~line 152, the `runAction` status lines).
- `lib/ibkr-data/ibkr-data-vite-plugin.ts` — Vite server plugin. Route
  registration in `ibkrDataVitePlugin()` (`register` closure, every mutation
  route gated by `isAllowedLocalRequest`). `handleSyncRequest` (~line 2196)
  acquires the module-level owner-generation lock (`syncOwner` /
  `syncOwnerGen`, `SYNC_OWNER_NONE`) and runs `processSyncBatch(body,
  syncOnly, writer, owner, {signal})`: one per-symbol worker
  (`syncOneSymbol` for IBKR, `syncOneAlpacaSymbol` for Alpaca), one NDJSON
  event per symbol (`symbol` / `symbol_failed` / `symbol_warning`),
  per-symbol catalog write, terminal `done`/`fatal`. In-progress state lives
  in `syncRunState` (snapshot for `/api/ibkr/sync/status` reattach); Stop
  aborts via `syncAbortController`. Cancellation invariant: no CSV/catalog
  write once aborted.
- `lib/ibkr-data/alpaca-fetcher.ts` — the provider-shaped leaf fetcher
  pattern to copy: only leaf imports (no `lightweight-charts` — the esbuild
  bundle trap), env-sourced config, exported pure `build*Url` / `parse*`
  helpers for tests, bounded retries, `debugLogger` telemetry, abortable
  delays, `next_page_token` pagination.
- `lib/ibkr-data/ibkr-data-stream-types.ts` — shared wire types
  (`IbkrSyncRunSnapshot`, `IbkrStreamEvent`, `IbkrIntervalMeta`). Note the
  exact shapes: `IbkrSyncRunSnapshot.mode` is `"sync" | "download"` and
  `.source` is `"ibkr" | "alpaca"`; the `start` NDJSON event's `mode` is
  already plain `string` but its `source` is the narrow union; the `done`
  event has no `mode` field.
- CSV writes go through `writeCsv` (~line 956; atomic temp+rename + `.bak`
  backup + Windows-lock fallback via the exported `replaceFileWithRetry`);
  paths from `getCsvPath(symbol, interval)` →
  `price-data/ibkr/csv/<interval>/<SYM>.csv`. Catalog is
  `price-data/ibkr/catalog.json` (`{updatedAt, entries[]}`, per symbol per
  interval `IbkrIntervalMeta`), written by the private `writeCatalog` with
  the same atomic idiom.

Storage isolation is a verified fact, not an assumption: candle consumers
bind only to the `csv/` subtree — `candlesBasePath: "/price-data/ibkr/csv"`
(`lib/local-daily-datasets.ts:132`), `getCsvPath` and `readCatalogAssets()`
scan only `IBKR_CSV_DIR` interval directories with a `.csv`-suffix filter
(plugin ~lines 948–954, 1643–1681), and `scripts/ibkr-aggregate-csv.ts:52`
scans `csv/{fromInterval}` only. `.bak` files (`AAPL.csv.bak`) fail the
`.endsWith(".csv")` filter. Nothing scans `price-data/ibkr/` recursively.

Everything below extends this slice. **No other subsystem is touched**: the
candle CSV tree, price catalog, chart/Finder/Batch loaders, workers, and Rust
sanitization are unaffected.

## Design overview

New button **Download MarketCap** on the IBKR Data tab. It uses the symbols
textarea (`ibkrDataSymbols`, same parse: marker-stripped, uppercased,
deduped) and runs a server-side batch that, per symbol:

1. Resolves ticker → CIK via the EDGAR `company_tickers.json` map
   (fetched once per run, disk-cached with an age-based refresh, written
   atomically via temp+rename).
2. Fetches
   `https://data.sec.gov/api/xbrl/companyconcept/CIK##########/dei/EntityCommonStockSharesOutstanding.json`
   and reduces the fact list to a **point-in-time step function**: each fact
   carries a measurement date (`end`, the cover-page "as of" date) and an
   availability date (`filed`). The step function is keyed by `filed` — a
   count is treated as known only from its filing date onward, never
   backdated to `end`. This keeps a historical TOP_MEAN replay free of
   look-ahead. Dedupe rule: for the same `filed` date, latest wins;
   `end` is carried as metadata. (See Assumptions for the multi-class
   caveat.)
3. Fetches split events for the symbol from the Alpaca corporate-actions API
   (same credentials/host as the bars fetcher, following the fetcher's
   existing pagination pattern) and converts each raw (as-filed) share count
   into the share count consistent with the repo's split-adjusted `1d`
   bars.
4. Joins the corrected share step function against the local `1d` closes
   read by the same-module `readCsvCandles(symbol, "1d")` (private in the
   plugin; fine — the worker lives there too) and writes a daily CSV
   `time,close,shares_outstanding,market_cap` plus a summary entry into a
   market-cap catalog.

### Split-factor convention (defined, non-negotiable)

All split factors in this feature are **share-count multipliers**: a 10:1
split has factor `10` (shares ×10, price ÷10). Let `F(t → now)` be the
product of share-count multipliers of all splits between date `t` and now.
Local bars are split-adjusted: `barPrice(t) = rawPrice(t) / F(t → now)`.
EDGAR counts are raw: `edgarShares(t) = rawShares(t)`. Therefore the share
count paired with adjusted prices is:

```
adjustedShares(t) = edgarShares(t) × F(t → now)     ← MULTIPLY, never divide
```

Numeric invariant (must hold for every row and is locked by a test):
`barPrice(t) × adjustedShares(t) === rawPrice(t) × rawShares(t)`.
Worked example (NVDA 10:1, June 2024): raw price $1200, EDGAR 2023 count
2.4B → correct cap $2.88T. Adjusted price $120 → required adjusted shares
`2.4B × 10 = 24B`. Dividing instead would yield $28.8B — a 100× level error
on all pre-split history, and one that leaves the series perfectly smooth
across the split (which is why continuity is *not* an acceptable smoke
check; the invariant is).

The batch reuses the existing lock, snapshot, Stop, and reattach machinery so
a market-cap run is mutually exclusive with candle sync/download and the
existing Stop button works unchanged. A market-cap run must NOT touch the
IBKR Gateway: no `ensureBrokerageSession`, no keepalive interaction — those
belong to the IBKR worker path only.

### Data flow

```
UI button (tab-ibkr-data.html)
  → ibkr-data-service.ts runAction("/api/ibkr/marketcap")     [symbols only]
    → POST /api/ibkr/marketcap (isAllowedLocalRequest gate)
      → handleMarketCapRequest (owner lock, 409 conflict path, AbortController)
        → processMarketCapBatch(writer, owner, {signal, fetcher?})
            per symbol:
              shares-outstanding-fetcher.ts  (EDGAR + Alpaca splits)
              readCsvCandles(symbol, "1d")   (same-module private helper)
              writeMarketCapCsv + writeMarketCapCatalog
                (re-check signal immediately before each write)
            NDJSON: start / symbol / symbol_failed / done
  → status line + ibkrDataOutput rendering (existing event handlers)
```

### Storage contract (new files only)

```
price-data/ibkr/marketcap/
  catalog.json           # {updatedAt, entries: [...]} — see below
  <SYMBOL>.csv           # daily series, atomic temp+rename, .bak backup
```

- `<SYMBOL>.csv` header: `time,close,shares_outstanding,market_cap`.
  `time` is the ISO date of the `1d` close used (UTC date key from
  `parseTimeToUnixSeconds` / the plugin's existing UTC-date-key helper — no
  ad-hoc `Date` parsing); `market_cap = close × shares_outstanding`, USD.
  Filename uses the same `encodeURIComponent(stripIbkrMarker(symbol).
  replace(/\//g, ""))` rule as `getCsvPath`. One row per trading day whose
  date is ≥ the `filed` date of the latest applicable fact (dates before
  the first filing are skipped — the join keys on filing dates, so
  non-trading `end`/`filed` dates never need special-casing: a fact simply
  applies from the first trading day at or after its `filed` date).
- `catalog.json` entry:
  `{symbol, markedSymbol, firstTime, lastTime, points, lastSyncAt,
  sharesSource: "dei:EntityCommonStockSharesOutstanding"}`. A series is
  only written when split correction succeeded (see error handling), so no
  `splitAdjusted` flag is needed. Flat per-symbol meta — no intervals;
  market cap is a daily dataset by definition.
- This directory is a **sibling of `csv/`, never inside it** — candle
  loaders scan `csv/<interval>/*.csv` and must never see these rows (isolation
  verified — see Current architecture).
- Both CSV and catalog writers implement the same atomic temp+rename +
  `.bak` + `replaceFileWithRetry` discipline as `writeCsv`/`writeCatalog`;
  the market-cap catalog gets its own small writer and type (the existing
  private `writeCatalog` writes the candle catalog and is not reusable).

The CSV layout is the contract a future TOP_MEAN coordinator loader will
read; nothing consumes it in this feature.

### API contract

- `POST /api/ibkr/marketcap` — body `{symbols: string[]}` (interval/source/
  period fields are accepted and ignored, so the browser can reuse the
  existing request builder). Response is the same NDJSON event stream as
  `/api/ibkr/download`: `start` → per-symbol `symbol`/`symbol_failed` →
  `done`/`fatal`. Result rows carry `{symbol, markedSymbol, points,
  firstTime, lastTime}`. `done.totals` is left untouched — the browser
  service does not consume it, so no `bars`-aliasing hack.
- Reattach reuses `GET /api/ibkr/sync/status`: `syncRunState.mode` is
  `"marketcap"`, `interval` is `"1d"`, `source` is `"edgar"`.
- Wire-type changes in `ibkr-data-stream-types.ts`, precisely:
  - `IbkrSyncRunSnapshot.mode`: `"sync" | "download"` →
    `"sync" | "download" | "marketcap"`.
  - `IbkrSyncRunSnapshot.source`, `IbkrStreamEvent.start.source`,
    `IbkrStreamEvent.done.source`: `"ibkr" | "alpaca"` →
    `"ibkr" | "alpaca" | "edgar"`.
  - `IbkrStreamEvent.start.mode` is already `string` — no change.
  - `IbkrDataSource` ("ibkr" | "alpaca", the candle-source request
    validation type) stays untouched — `"edgar"` is run provenance for the
    snapshot, never a candle source.
  All are union widenings; old snapshots still parse. Every site that maps
  `source` → provider label must learn `"edgar"` → `"EDGAR"`:
  `ibkr-data-service.ts` reattach completion (~line 91),
  `renderRunSnapshot` (~line 152), and the `runAction` status lines; the
  reattach-finish cache invalidation is skipped when `source === "edgar"`
  (market-cap data never enters the candle caches).

### Security

- New route gated by `isAllowedLocalRequest` (audit F1 contract — never add
  an ungated route).
- No new credentials: EDGAR is keyless. The Alpaca corporate-actions call
  reuses `resolveAlpacaConfig()` and the existing header-construction
  discipline (secrets never in URLs, catalog, CSV, NDJSON, or logs).
- EDGAR fair-access policy: a descriptive static `User-Agent` constant
  (contact string, not a secret), a client-side rate limiter keeping EDGAR
  requests ≥150 ms apart (well under the published ~10 req/s guidance),
  and `Retry-After` respected on 429.
- Symbol validation reuses `normalizeSymbol` (character allowlist blocks
  path traversal); filenames are additionally `encodeURIComponent`-ed.
- Writes are confined to `price-data/ibkr/marketcap/` via resolved paths.
- Known limitation (same as the candle pipeline): the lock serializes runs
  within one Vite process only; two concurrent dev-server processes can both
  write the tree. Accepted for this local research tool, as it already is
  for candle syncs.

### Performance

- Cost per run: 1 `company_tickers.json` fetch (≈1 MB, disk-cached,
  refreshed when older than ~30 days) + 1 EDGAR company-concept JSON per
  symbol + 1 (possibly paginated) Alpaca corporate-actions query per symbol.
  500 symbols ≈ 1000+ requests. With ~150 ms EDGAR spacing plus response
  latency, retry backoffs, and per-symbol writes, plan for **4–8 minutes**
  for a full S&P 500 run — do not promise the ~2-minute lower bound.
- Memory is trivial (a step function of ~20 points + the existing `1d`
  closes, which `readCsvCandles` already loads one symbol at a time).
- No hot-path impact anywhere else; no caches shared with the candle tree.

### Error handling

- `company_tickers.json` fetch failure → fatal (no per-symbol work possible).
- Unknown ticker in the map (share classes: `BRK.B` → EDGAR ticker `BRK-B`;
  map `.` → `-` before lookup; still unknown → e.g. `BF.B`) → per-symbol
  `symbol_failed` with an actionable message; the run continues.
- EDGAR symbol with no `dei` facts (foreign issuers) → `symbol_failed`
  ("no shares-outstanding facts on EDGAR").
- No local `1d` closes for a symbol → `symbol_failed`
  ("download 1d prices first"). Deliberately strict: the dataset's purpose is
  the join; a shares-only file would silently differ from the rest.
  (`readCsvCandles` returns `[]` in this case; the worker checks before any
  write.)
- **Split-event fetch failure or unrecognized payload → `symbol_failed`
  (strict, no partial write).** The split-corrected series is the dataset's
  point: knowingly writing an unadjusted (wrong-level) series behind a
  warning would poison a future TOP_MEAN replay. The user re-runs the
  symbol after fixing the cause (credentials, entitlement, pagination
  drift). EDGAR data is cached in-memory per run, so the retry only
  re-fetches splits + join.
- Transient HTTP failures retry with the `alpaca-fetcher.ts`-style bounded
  backoff; SEC 403 is classified as non-retryable (User-Agent/policy
  problem) and surfaces loudly. Cancellation observes `signal` at every
  loop/await and is re-checked immediately before the CSV write and the
  catalog write, preserving the no-write-on-cancel invariant.

### Rollback

- Runtime: remove the button + DOM contract entry + click handler + route.
  Nothing else references the feature.
- Data: delete `price-data/ibkr/marketcap/`. Every CSV and catalog write
  keeps a `.bak` of the prior file (same idiom as `writeCsv`), so an
  interrupted backfill is recoverable per file.
- No settings, schema, localStorage, worker, or Rust surface changes → no
  migrations to unwind.

## Implementation phases

### Phase 1 — EDGAR + splits leaf fetcher (with live-fixture exit criteria)

- **Objective**: a provider-shaped leaf module that resolves CIKs, fetches
  and reduces EDGAR shares-outstanding facts to a point-in-time step
  function, and fetches split factors — fully unit-testable without
  network, and validated against live fixtures before anything consumes it.
- **Tasks**:
  - New `lib/ibkr-data/shares-outstanding-fetcher.ts` (leaf imports only —
    bundle-trap rule; it will be imported by
    `ibkr-data-vite-plugin.ts`).
  - Exported pure helpers, mirroring `alpaca-fetcher.ts`:
    `buildCompanyTickersUrl()`, `parseCompanyTickers(payload)` (ticker→CIK
    map, `.`→`-` normalization), `buildEdgarConceptUrl(cik)`,
    `parseSharesOutstandingFacts(payload)` → step function keyed by `filed`
    (dedupe: same `filed` → latest wins; validate `val` positive finite;
    keep `end` as metadata), `applySplitFactors(stepFn, splits)` (MULTIPLY
    each count by the cumulative share-multiplier factor of splits between
    its date and now — see the convention section), `parseAlpacaSplits(payload)`
    (handles pagination; selects the split execution date as the effective
    date).
  - Async `fetchEdgarSharesOutstanding(...)` / `fetchAlpacaSplits(...)`
    modeled on `fetchAlpacaBarsPage`: `createFetchTimeoutSignal`,
    bounded retry backoff with abortable delays, `Retry-After` handling,
    `debugLogger` events, static descriptive `User-Agent` for EDGAR plus
    the ≥150 ms EDGAR rate limiter, reuses `resolveAlpacaConfig()` for the
    splits call, `next_page_token` pagination for corporate actions.
  - Disk cache for the tickers map under
    `price-data/ibkr/marketcap/.company-tickers.json` (age-checked,
    atomic temp+rename write).
- **Dependencies**: none (this phase only).
- **Risks**: Alpaca corporate-actions entitlement on the configured
  (IEX-tier) account is unverified; the exact EDGAR payload shape, EDGAR
  coverage depth, and multi-class reporting behavior are unverified until
  fixtures are pulled. SEC occasionally returns 403 without a compliant
  `User-Agent`.
- **Deliverables**: the leaf module + unit tests + a fixture set checked
  into the spec fixtures (real payloads, redacted if needed).
- **Validation**: new `tests/marketcap-fetcher.spec.ts` (build/parse helpers,
  step-function reduction with `filed`-keyed point-in-time semantics,
  dedupe precedence, **the NVDA cap-invariance test**:
  `adjPrice × adjustedShares === rawPrice × rawShares` across a 10:1 split,
  pagination handling, malformed payloads → thrown `HttpStatusError`),
  `npm run typecheck`, `npm run typecheck:tests`.
  **Live-fixture exit criteria (must pass before Phase 2):** fetch real
  payloads with a compliant User-Agent for (a) AAPL (single-class baseline,
  ≥5 years of `dei` facts — verifies the coverage assumption), (b) BRK.B
  after `.`→`-` mapping, (c) a dual-class issuer (GOOGL — establishes what
  the cover-page tag actually reports for multi-class filers), (d) NVDA
  corporate-actions splits (verifies entitlement, response shape, effective
  date field, pagination) and (e) NVDA local 1d bars pre/post June 2024
  (verifies the repo's own split-adjustment assumption).
- **Exit criteria**: all helpers tested without HTTP; live fixtures parsed
  correctly; split convention invariant holds on NVDA real numbers;
  typecheck green; no import from browser-bound modules (bundle trap stays
  closed).

### Phase 2 — Server route and batch loop

- **Objective**: `POST /api/ibkr/marketcap` runs the per-symbol batch with
  the existing lock/stop/snapshot semantics and writes the market-cap
  dataset.
- **Tasks**:
  - `processMarketCapBatch(body, writer, owner, {signal, fetcher?})` in
    `ibkr-data-vite-plugin.ts`, mirroring `processSyncBatch`'s structure but
    with its **own** options type (the existing private
    `ProcessSyncBatchOptions` is candle-worker-specific and is not reused)
    and its own injectable per-symbol fetcher (test seam). Populate
    `syncRunState` (`mode: "marketcap"`, `interval: "1d"`, `source:
    "edgar"`, `total/index/completed/failed/currentSymbol/failedSymbols/
    completedSymbols/updatedAt`), same `lostOwnership`/`wasCancelled`
    checks, same per-symbol event + terminal `done` shapes, same
    ownership-safe `finally`.
  - Reuse the existing `syncOwner` / `syncOwnerGen` / `syncAbortController`
    (no second concurrency domain): a market-cap run 409-conflicts with an
    in-flight candle sync and vice versa, and `/api/ibkr/stop` cancels it.
    The batch must not invoke `ensureBrokerageSession` or the Gateway
    keepalive. Make the 409 conflict message and the Stop button/title
    wording mode-neutral ("an IBKR Data run is already in progress") so a
    market-cap occupant is not mislabeled a candle sync; document in
    `docs/alpaca-ibkr-sync.md` that market-cap runs occupy the IBKR Data
    lock.
  - Per-symbol worker `buildMarketCapForSymbol(...)`: EDGAR fetch (phase 1)
    → splits → join vs `readCsvCandles(symbol, "1d")` → `writeMarketCapCsv`
    (same atomic temp+rename + `.bak` + `replaceFileWithRetry` idiom as
    `writeCsv`, but the `time,close,shares_outstanding,market_cap` header) →
    `writeMarketCapCatalog` upsert (own writer, own atomic discipline) —
    with the abort signal re-checked immediately before each write.
  - Wire-type changes exactly as specified in the API contract section;
    `"edgar"` never enters `IbkrDataSource` or `normalizeDataSource`.
  - Route registration in `register`: method check →
    `isAllowedLocalRequest` → `readJsonBody(req, IBKR_BODY_LIMIT_BYTES)` →
    `handleMarketCapRequest` (lock acquisition + 409 path + `finally`
    clearing `syncRunState`, mirroring `handleSyncRequest`). Route order is
    free — `/api/ibkr/marketcap` shares no prefix with `/api/ibkr/sync`
    (the documented ordering hazard is `/sync/status` vs `/sync` only);
    keep it grouped with the other routes for readability.
- **Dependencies**: Phase 1 (including its live-fixture exit criteria).
- **Risks**: forgetting the authorization gate (audit F1) is the classic
  failure mode for new routes here; dropping the no-write-on-cancel check
  before the second (catalog) write would let a Stop race leave a catalog
  entry for an unwritten CSV.
- **Deliverables**: route + batch loop + storage writers.
- **Validation**: new `tests/marketcap-batch.spec.ts` using the existing
  test seams (`__resetIbkrSyncStateForTests`,
  `__acquireIbkrSyncOwnerForTests`, injected per-symbol fetcher) — covering
  start/symbol/done ordering, `symbol_failed` isolation, cancel → no write
  (assert both the CSV and the catalog are untouched), per-symbol catalog
  persistence, snapshot `mode`/`source` values, and the authorization gate
  exercised the way the existing lifecycle specs do (direct
  `isAllowedLocalRequest`-style coverage, matching repo convention — not a
  new middleware harness). File-isolation tests use a **unique sentinel
  symbol** (e.g. `ZZTESTMKTCAP`) plus catalog preserve/restore in
  `afterEach` — market-cap files have no interval subdirectory, so the
  `zztest`-interval trick from `tests/ibkr-download-merge-safety.spec.ts`
  does not transfer, and cleanup must never delete real user data.
  `tests/ibkr-data-lifecycle.spec.ts`,
  `tests/ibkr-download-merge-safety.spec.ts`, `tests/alpaca-*.spec.ts` must
  stay green (they lock the shared machinery).
- **Exit criteria**: batch drives a temp-safe sentinel through the full
  event sequence with a fake fetcher; Stop mid-run writes nothing for the
  in-flight symbol; all existing IBKR specs pass.

### Phase 3 — UI button and browser service wiring

- **Objective**: the button exists, is contract-locked, and streams the run
  into the existing status/output surface with correct EDGAR labeling
  everywhere.
- **Tasks**:
  - `html-partials/tab-ibkr-data.html`: add
    `<button ... id="ibkrDataMarketCapBtn">Download MarketCap</button>` in
    the actions row (`btn btn-quiet`, tooltip: SEC EDGAR shares outstanding ×
    local 1d closes, daily).
  - `lib/ibkr-data/ibkr-data-dom.ts`: add the id to
    `IBKR_DATA_REQUIRED_IDS` and `createIbkrDataDom()`.
  - `lib/ibkr-data/ibkr-data-service.ts`:
    - `init()` click handler → `runAction("/api/ibkr/marketcap", false)` —
      `invalidate=false` (market-cap data never enters the candle caches);
      a small optional provider-label override keeps the status lines
      reading "EDGAR …" instead of "IBKR …".
    - `setBusy` includes the new button (Stop stays always-enabled).
    - Every source→provider label site learns `"edgar"` → `"EDGAR"`:
      reattach completion, `renderRunSnapshot`, `runAction` status lines;
      the reattach-finish cache invalidation is explicitly skipped for
      `source === "edgar"`.
- **Dependencies**: Phase 2 (route must exist for the stream to open).
- **Risks**: forgetting the DOM contract entry —
  `tests/feature-dom-contracts.spec.ts` will fail loudly by design; a
  missed label site silently misreports an EDGAR run as "IBKR".
- **Deliverables**: button + service wiring.
- **Validation**: `npm run typecheck`;
  `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`;
  a reattach test asserting an EDGAR-labeled snapshot renders "EDGAR
  marketcap …" and skips cache invalidation (lives with the
  `marketcap-batch` or lifecycle spec, depending on where the service is
  testable — if the service is not currently unit-tested, cover the label
  map as an exported pure helper instead of forcing DOM tests);
  `npm run test -- ibkr marketcap alpaca`.
- **Exit criteria**: contracts pass; button disables during any IBKR/EDGAR
  run; progress, failures, warnings, and completion render in the existing
  status/output elements with correct provider labels.

### Phase 4 — Docs and manual smoke

- **Objective**: the feature doc carries the contract; the end-to-end path
  is verified against the live services.
- **Tasks**:
  - Keep this file as the design reference; add user-facing behavior to
    `docs/alpaca-ibkr-sync.md` (a "Market cap download" section: button,
    storage location, split-factor convention, EDGAR provenance and its
    point-in-time `filed`-date semantics, lock occupancy, multi-class
    caveat) and link it from `docs/README.md` if that index lists feature
    docs.
  - Manual smoke: `NODE_OPTIONS` as usual + `npm run dev` with
    `ALPACA_API_KEY`/`ALPACA_API_SECRET` present; download market cap for a
    3-symbol list, then for the full S&P 500 list; verify the split
    invariant on real data for NVDA (spot-check one pre-split date:
    `close × shares` from the CSV equals the known raw cap within
    rounding — do NOT rely on series continuity); verify Stop mid-run,
    reload mid-run (reattach via `/api/ibkr/sync/status` shows "EDGAR
    marketcap …"), and a second run's 409.
- **Dependencies**: Phases 1–3.
- **Risks**: live EDGAR/Alpaca behavior (rate limiting, corporate-actions
  drift) only observable here.
- **Deliverables**: updated docs; smoke checklist recorded in the doc.
- **Validation**: full `npm run test`; manual checklist above.
- **Exit criteria**: 500-symbol run completes (expect 4–8 min) with
  per-symbol files + catalog; split invariant verified on real numbers;
  Stop/reattach/409 behave as documented; docs accurate.

## Assumptions and unknowns

- **EDGAR coverage**: `dei:EntityCommonStockSharesOutstanding` is mandatory
  on cover pages since late 2019 → the 5-year window should be covered.
  This is an external-fact assumption verified by the Phase 1 AAPL fixture;
  if coverage is shallower, the window shrinks and the experiment scope
  shrinks with it. SEC also documents missing/mistagged facts for some
  issuers — per-symbol failures surface them rather than papering over.
- **Multi-class issuers**: `dei` elements are not dimensionable per the
  EDGAR Filer Manual, so a filer reports one filer-chosen cover-page number
  (not per-class dimensioned facts); what dual-class filers (BRK, GOOGL)
  actually report — combined or primary class — is established empirically
  by the Phase 1 fixtures. The plan deliberately builds **no class
  aggregation machinery** ahead of that evidence; if fixtures show the
  cover-page number is unusable for dual-class names, those symbols fail
  loudly in the join or get an explicit exclusion list, decided then.
- **Point-in-time semantics**: step functions anchor at `filed`. The gap
  between `end` (measurement) and `filed` (availability) means cap values
  during a quarter use the previously filed count — correct for a historical
  replay, slightly stale versus "true" historical cap. Accepted and
  documented.
- **Split-adjusted local bars**: Alpaca `1d` bars are split-adjusted by the
  pipeline default (`ALPACA_DEFAULT_ADJUSTMENT = "split"`). IBKR-sourced
  `1d` bars are assumed adjusted as well — verified in Phase 1 exit
  criterion (e) on NVDA real bars before any cross-source trust.
- **Exact Alpaca corporate-actions behavior** (entitlement on the
  configured account, response fields, effective-date semantics,
  pagination) is a Phase 1 exit criterion; the fetcher is written against
  captured fixtures, not assumptions.
- **Share-class tickers**: `.` → `-` covers BRK.B-style classes via
  `company_tickers.json`; exotic mismatches surface as per-symbol failures,
  not silent gaps.
- **Coordinator consumption** (TOP_MEAN arm reading the cap series during
  OPEN_SCORE USD Replay) is deliberately **out of scope** here — this plan
  only produces the on-disk dataset and its CSV contract.
