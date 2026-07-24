# Alpaca-to-IBKR CSV Sync Plan

## Objective

Use Alpaca stock market data as an alternate source for the existing IBKR Data
workflow:

```text
Alpaca 30m bars -> price-data/ibkr/csv/30m -> npm run ibkr:aggregate -> 4h CSV
```

The existing IBKR local-data paths, symbol marker, catalog, cache invalidation,
and 4h aggregation command remain the downstream contracts.

## Decisions and constraints

- Use Alpaca’s market-data API, not the paper-trading API:
  `https://data.alpaca.markets/v2/stocks/{symbol}/bars`.
- Read credentials only in the Vite/Node process from
  `ALPACA_API_KEY` and `ALPACA_API_SECRET`. Never send them to the browser or
  persist them in localStorage, CSV, catalog, or stream events.
- Initial Alpaca scope is US stocks/ETFs and `30Min` bars only.
- Use `feed=iex` and `adjustment=split` by default. Make both constants or
  server configuration, not user-entered secrets.
- Alpaca `period=max` is rejected initially. Use an explicit bounded period;
  existing IBKR `max` behavior is unchanged.
- Alpaca data may differ from IBKR data. An Alpaca sync must not merge into an
  interval known to be IBKR-sourced. A full Alpaca download replaces that
  interval and records its source; later Alpaca syncs merge only with Alpaca
  data.
- Add optional `source: "ibkr" | "alpaca"` to interval catalog metadata. Old
  catalog files without `source` remain readable; an Alpaca sync against such
  an interval must require a full Alpaca download first.
- Do not add a database, worker, cloud service, or scheduled job.

## Existing modules to reuse

- `html-partials/tab-ibkr-data.html` — IBKR Data controls.
- `lib/ibkr-data/ibkr-data-dom.ts` — structural DOM contract.
- `lib/ibkr-data/ibkr-data-service.ts` — request handling, NDJSON progress,
  reattach polling, Stop, and cache invalidation.
- `lib/ibkr-data/ibkr-data-vite-plugin.ts` — local routes, authorization,
  owner lock, abort signal, CSV/catalog writes, and `processSyncBatch`.
- `lib/ibkr-data/ibkr-data-stream-types.ts` — shared stream and status types.
- `lib/local-daily-datasets.ts` — IBKR symbol marking and local provider
  identity.
- `scripts/ibkr-aggregate-csv.ts` — existing 30m-to-4h conversion.
- `scripts/lib/synthetic-pair.ts:aggregateSyntheticBars` — existing bar
  aggregation implementation used by the command.

## Data and request flow

1. The IBKR Data tab sends `source: "alpaca"`, symbols, `interval: "30m"`,
   and a bounded period to the existing `/api/ibkr/download` or
   `/api/ibkr/sync` route.
2. The server selects the Alpaca fetcher in `processSyncBatch`.
3. The fetcher requests paginated Alpaca bars, normalizes them to
   `OHLCVData[]`, and deduplicates timestamps.
4. Download writes the normalized dataset. Sync overlaps the last few bars and
   merges only if the catalog interval source is `alpaca`.
5. The server atomically writes the existing six-column CSV and updates the
   catalog after each successful symbol.
6. The browser invalidates the existing DataManager, Finder, Batch, and local
   asset caches.
7. The user runs `npm run ibkr:aggregate` to produce derived 4h files.

## Phase 1 — Server source contract and fetcher

### Objective

Add a tested Alpaca 30m fetcher without changing existing IBKR behavior.

### Scope

Server-side API calls, normalization, pagination, source checks, and reuse of
the existing sync state machine.

### Technical tasks

- Add a focused leaf module under `lib/ibkr-data/` for Alpaca URL building,
  response parsing, pagination, and retry policy.
- Extend the existing request body with `source: "ibkr" | "alpaca"`; default
  missing `source` to `ibkr` for backward compatibility.
- Keep `/api/ibkr/download`, `/api/ibkr/sync`, `/api/ibkr/sync/status`, and
  `/api/ibkr/stop`; do not create a second route family or progress protocol.
- Update `handleSyncRequest`/`processSyncBatch` to select the existing IBKR
  fetcher or the Alpaca fetcher. Keep the existing owner lock and AbortSignal.
- Restrict Alpaca requests to `interval === "30m"` and reject `period ===
  "max"` with an actionable error.
- Call `GET /v2/stocks/{symbol}/bars` with `timeframe=30Min`, bounded `start`
  and `end`, `limit`, `page_token`, `sort=asc`, `feed`, and `adjustment`.
- Follow `next_page_token`; process symbols sequentially to stay within the
  free account’s request limit.
- Normalize `t/o/h/l/c/v` into finite `OHLCVData` rows with Unix-second times;
  drop invalid OHLC rows and use volume `0` when volume is absent.
- Retry transient network failures and `429` with bounded delays. Do not retry
  401, 403, 422, invalid configuration, or empty-symbol errors.
- Reuse `parseCsvCandleLines`, `mergeCandlesByTime`, `getCsvPath`, `writeCsv`,
  `upsertCatalogEntry`, and the existing per-symbol catalog write.
- Add `source` to `IbkrIntervalMeta` and pass it through the catalog update.
- For Alpaca download, replace the target interval’s dataset. For Alpaca sync,
  require catalog `source === "alpaca"`; otherwise instruct the user to run
  Alpaca Download first. Never merge Alpaca rows into an IBKR interval.

### Dependencies

- Alpaca credentials in the local server environment.
- Existing `OHLCVData`, interval, time-normalization, HTTP, and debug-logger
  helpers.

### Risks or blockers

- Free Alpaca data is IEX-based and may not match IBKR’s consolidated feed.
- Alpaca’s recent-data availability can be delayed; the effective latest bar
  must be reported rather than treated as real-time.
- Existing catalog entries have no source field and must be treated as
  unknown, not assumed to be Alpaca.

### Deliverables

- Alpaca fetch/parse module.
- Source-aware fetcher selection in the existing IBKR sync pipeline.
- Source-aware interval catalog metadata.

### Validation and testing criteria

- Test query construction, headers, pagination, normalization, duplicate
  timestamps, missing volume, 429 retry, non-retryable errors, and abort.
- Test that Alpaca sync rejects an unknown/IBKR interval and that Alpaca
  download can establish the Alpaca source.
- Test that existing IBKR requests remain unchanged when `source` is omitted.

### Exit criteria

The server can download and incrementally sync Alpaca 30m data through the
existing owner-lock/NDJSON lifecycle without corrupting or mixing sources.

## Phase 2 — IBKR Data menu integration

### Objective

Expose the Alpaca source through the current IBKR Data tab with minimal UI
changes.

### Scope

Source selection, 30m restriction, progress labeling, and existing reattach /
cache invalidation behavior.

### Technical tasks

- Add a source selector or explicit Alpaca actions to
  `html-partials/tab-ibkr-data.html`.
- Update `lib/ibkr-data/ibkr-data-dom.ts` for new required ids.
- Update `lib/ibkr-data/ibkr-data-service.ts` to send `source`, enforce/select
  30m for Alpaca, and reuse `runAction`, `consumeNdjsonStream`, Stop, and
  `reattachToInProgressSync`.
- Extend `IbkrStreamEvent` and `IbkrSyncRunSnapshot` only where source is
  needed to render correct reattached status.
- Show source, feed, effective last bar, failed symbols, and whether the run
  was a download or same-source sync.
- After completion, keep using `invalidateSyncedData` with marked symbols.
- Show the follow-up command:
  `npm run ibkr:aggregate -- --from 30m --interval 4h`.

### Dependencies

- Phase 1 request and stream contract.
- Existing feature DOM contract test.

### Risks or blockers

- A reload must not label an Alpaca run as IBKR.
- The UI must not offer Alpaca 4h as if Alpaca supplied a native 4h bar.

### Deliverables

- Source-aware IBKR Data controls and status output.
- Updated DOM and stream contracts.

### Validation and testing criteria

- Run `npm run typecheck`.
- Run the feature DOM contract test.
- Manually download, sync, Stop, and reload during an Alpaca run.
- Confirm existing IBKR actions still work with no source selector changes.

### Exit criteria

The user can perform an Alpaca 30m download or same-source sync and understand
exactly when 4h aggregation is required.

## Phase 3 — Aggregation and downstream compatibility

### Objective

Confirm Alpaca-produced 30m files work with the existing 4h and local-data
consumers.

### Scope

Validation and focused tests only; no aggregation redesign.

### Technical tasks

- Run `npm run ibkr:aggregate -- --symbol SYMBOL --from 30m --interval 4h`.
- Confirm the existing bucket alignment, OHLC, volume summation, missing-session
  gaps, and Unix-second timestamps are suitable for stock 30m bars.
- Confirm reruns are idempotent and update only changed 4h files.
- Confirm 30m and 4h files are found through the IBKR catalog/local-price-data
  route and loaded by chart, Finder, Batch, and synthetic-pair consumers.
- Keep 30m files as the source of truth; do not delete them after aggregation.

### Dependencies

- Phase 1 valid 30m CSVs and catalog metadata.
- Existing `scripts/ibkr-aggregate-csv.ts`.

### Risks or blockers

- Stock sessions contain gaps; tests must verify that aggregation does not
  fabricate bars across missing intervals.
- A derived 4h file can remain stale after a new 30m sync until aggregation is
  run again; the UI must state this explicitly.

### Deliverables

- Focused 30m-to-4h compatibility tests.
- Documented Alpaca 30m → aggregate 4h workflow.

### Validation and testing criteria

- Run aggregate dry-run and single-symbol aggregation.
- Check expected timestamps, bar counts, finite OHLCV values, and idempotence.
- Run existing IBKR aggregation and downstream loader parity tests.
- Manually load both intervals from local data.

### Exit criteria

The unchanged aggregation command produces usable 4h CSVs from Alpaca 30m
files, and downstream consumers require no provider-specific code.

## Phase 4 — Security, failure handling, and rollback

### Objective

Make frequent local syncing safe and reversible.

### Scope

Credentials, logs, rate-limit behavior, errors, tests, and recovery of bad
source data.

### Technical tasks

- Log source, symbol, interval, page count, fetched/merged bars, retry count,
  status class, duration, and completion state through `debugLogger`; never log
  keys, secrets, authorization headers, or credential-bearing URLs.
- Report missing credentials, 401/403, 422, 429, timeout, empty data, partial
  pagination, stale latest data, and cancellation clearly in the existing UI.
- Keep all Alpaca mutation routes behind `isAllowedLocalRequest`.
- Verify credentials are absent from localStorage, catalog JSON, CSV, NDJSON,
  and copied output.
- If Alpaca data is wrong, remove/restore the affected 30m and derived 4h CSVs
  and rerun the existing IBKR Download path. Removing the Alpaca source code
  must not affect existing IBKR files or the aggregator.

### Dependencies

- Phases 1–3.
- Local environment configuration for Alpaca credentials.

### Risks or blockers

- Frequent sync cannot bypass Alpaca’s free-tier delay or IEX coverage.
- Mixing providers for research remains a data-quality risk; the source guard
  and catalog metadata are required, not optional diagnostics.

### Deliverables

- Focused tests and operational documentation.
- Rollback procedure for affected symbol intervals.

### Validation and testing criteria

- Run `npm run typecheck` and `npm run typecheck:tests`.
- Run the focused Alpaca/plugin tests, `tests/feature-dom-contracts.spec.ts`,
  existing IBKR data tests, and aggregation tests.
- Manual smoke: download one symbol, sync it again, aggregate 4h, reload during
  a run, Stop it, and start a new run.

### Exit criteria

The feature is local-only, source-safe, rate-limit aware, test-covered, and
reversible without changing the existing IBKR workflow.

## Out of scope

- Alpaca orders or paper-trading integration.
- Native Alpaca 4h retrieval.
- Crypto or options data.
- Cloudflare Worker deployment or scheduled background jobs.
- Replacing IBKR as the authoritative historical source.

## Implementation status (2026-07-24)

All four phases landed on branch `feat/alpaca-ibkr-sync`. No existing IBKR
behavior changed when `source` is omitted.

### What landed

- `lib/ibkr-data/alpaca-fetcher.ts` (new leaf) — URL builder, response parser,
  bar normalizer, retry policy, abortable pagination, env-sourced config.
  Reaches only `debug-logger`, `vite-http-utils`, `time-normalization`,
  `dataProviders/fetch-helpers`, and `types/strategies` — never the
  browser-bound `lightweight-charts` graph (same bundle-trap discipline as
  the Batch / Finder server plugins).
- `lib/ibkr-data/ibkr-data-stream-types.ts` — added optional `source:
  "ibkr" | "alpaca"` to `IbkrIntervalMeta`, `IbkrSyncRunSnapshot`, and the
  `start` / `done` stream events. Old catalog files and snapshots without
  `source` remain readable.
- `lib/ibkr-data/ibkr-data-vite-plugin.ts` — `normalizeDataSource`,
  `assertSourceConstraints` (30m-only + reject `max` for Alpaca),
  `resolveAlpacaWindow`, `syncOneAlpacaSymbol` (mirrors `syncOneSymbol`'s
  return shape + no-write-on-cancel), and source-aware dispatch inside
  `processSyncBatch`. The existing IBKR fetcher now writes `source: "ibkr"`
  to new catalog entries.
- `lib/ibkr-data/ibkr-data-dom.ts` + `html-partials/tab-ibkr-data.html` —
  added a `Source` selector (`ibkr` / `alpaca`) and a hint that surfaces the
  follow-up aggregate command.
- `lib/ibkr-data/ibkr-data-service.ts` — sends `source` from the selector,
  labels Alpaca runs in progress / reattach / completion status, and surfaces
  the `npm run ibkr:aggregate` hint after a successful Alpaca run.
- Tests: `tests/alpaca-fetcher.spec.ts`, `tests/alpaca-source-integration.spec.ts`,
  `tests/alpaca-aggregate-compat.spec.ts`, `tests/alpaca-security.spec.ts`.

### Security contract (verified by `tests/alpaca-security.spec.ts`)

- Credentials are read ONLY from `process.env.ALPACA_API_KEY` /
  `ALPACA_API_SECRET`. There is no request-body path to pass them.
- The auth header is constructed in the private `buildAlpacaHeaders` and is
  only present on the outbound `fetch`; no public function returns it.
- `buildAlpacaBarsUrl` never embeds credentials in the URL.
- The per-symbol result that flows into the NDJSON `done` event carries no
  credential echoes. The catalog JSON written to disk carries no credentials.

### Source guard (verified by `tests/alpaca-source-integration.spec.ts`)

- Alpaca Download replaces the target interval's dataset and records
  `source: "alpaca"`.
- Alpaca Sync requires the catalog interval to already be
  `source === "alpaca"`; otherwise it returns 409 instructing the user to
  run Alpaca Download first. An absent `source` (pre-Alpaca catalog entry)
  is treated as unknown and rejected — never silently merged.
- IBKR requests (no `source`) route to the existing IBKR fetcher unchanged.

### Rollback procedure

If Alpaca data is wrong and you need to revert a symbol interval:

1. Delete the affected derived 4h file:
   `price-data/ibkr/csv/4h/<SYMBOL>.csv`.
2. Delete or restore the affected 30m file:
   `price-data/ibkr/csv/30m/<SYMBOL>.csv`.
3. Remove the symbol's interval entry from `price-data/ibkr/catalog.json`
   (or set its `source` back to `"ibkr"` if you are restoring an IBKR
   interval), then re-run the IBKR Download path for that symbol.
4. Re-run `npm run ibkr:aggregate -- --symbol <SYMBOL>` to rebuild the 4h
   file from the restored 30m data.

Removing the Alpaca source code (the `lib/ibkr-data/alpaca-*.ts` files and
the `source` dispatch in `processSyncBatch`) does NOT affect existing IBKR
files or the aggregator — the Alpaca path is strictly additive and gated on
`source === "alpaca"`.

### Validation habit after Alpaca changes

- `npm run typecheck` and `tsc -p tsconfig.tests.json`
- `..\..\..\node_modules\.bin\esno tests\alpaca-fetcher.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\alpaca-source-integration.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\alpaca-aggregate-compat.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\alpaca-security.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\ibkr-data-lifecycle.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\ibkr-price-data.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual smoke (with `ALPACA_API_KEY` / `ALPACA_API_SECRET` set in the
  server env): start `npm run dev`, Alpaca-Download one symbol, Alpaca-Sync
  it again, run `npm run ibkr:aggregate -- --symbol <SYMBOL> --from 30m
  --interval 4h`, reload during a run, Stop it, and start a new run.

### Audit follow-up (2026-07-24)

Four auditor findings landed as hardening on top of the original four phases.
Each has a focused test that fails under the old behavior.

- **F1 (High) — page ceiling no longer silent**: hitting
  `ALPACA_MAX_PAGES_PER_SYMBOL` with `next_page_token` still present now
  returns `stopReason: "page_limit"`, `complete: false`, and a warn-level
  log. `syncOneAlpacaSymbol` maps `"page_limit"` onto the catalog schema's
  `"chunk_limit"` via `mapAlpacaStopReason`, which fires the existing
  `symbol_warning` + `describeIncompleteStopReason` path. Truncated history
  can no longer be persisted as a complete interval.
- **F2 (Medium) — unknown source is an error, not a fallback**:
  `normalizeDataSource` still defaults a missing/blank `source` to `"ibkr"`
  for backward compatibility, but any non-empty value that is neither
  `"ibkr"` nor `"alpaca"` now throws HTTP 400. A typo like `"alpacca"` can
  no longer silently route to the IBKR Gateway.
- **F3 (Medium) — timeout covers body parsing + transient retries**:
  `createFetchTimeoutSignal` is cleared in a `finally` AFTER
  `response.json()` / `response.text()` completes, so a stalled response
  body still aborts within `ALPACA_REQUEST_TIMEOUT_MS`. Transient
  timeout/network errors (including a `TimeoutError` thrown during body
  parsing) are retried with the existing bounded policy; a user-initiated
  abort (`signal.aborted`) always propagates without retry.
- **F4 (Low) — retry telemetry is accurate**: `fetchAlpacaBarsPage` returns
  its retry count, `fetchAlpacaBars` sums it across pages, and
  `finalizeAlpaca` reports the sum in `AlpacaFetchResult.retries` and the
  `alpaca.fetch.symbol` log.

