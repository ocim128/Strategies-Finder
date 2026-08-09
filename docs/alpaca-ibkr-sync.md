# Alpaca source for IBKR Data

The IBKR Data tab can use Alpaca stock bars as an alternate local-data source.
The data is written to the existing `price-data/ibkr/csv/` tree and catalog,
so downstream chart, Finder, Batch, and synthetic-pair loaders do not need a
separate provider path.

This is a local historical-data workflow. It does not place Alpaca orders,
replace IBKR as a source of truth, or run as a scheduled cloud job.

## Supported intervals and settings

- Alpaca supports `30m` and `1d` in the IBKR Data workflow.
- The default Alpaca feed is `iex`; the default adjustment is `split`.
- `period=max` and `period=all` are supported by translating the request into
  a full-range paginated fetch. Bounded periods such as `1y`, `6m`, or `30d`
  are also supported.
- Alpaca credentials are read only by the Vite/Node process from
  `ALPACA_API_KEY` and `ALPACA_API_SECRET`.

The server fetches `/v2/stocks/{symbol}/bars`, follows pagination, deduplicates
timestamps with last-write-wins semantics, normalizes times to Unix seconds,
and treats missing/invalid volume as `0`. A bounded page ceiling or a
cancellation is reported as incomplete rather than silently marked complete.

## Configure the server

Copy `.env.example` to `.env`, then provide the two credentials. Non-`VITE_`
variables are server secrets; do not put them in browser code or localStorage.

When starting Vite manually, export the values in the shell because the
fetcher reads `process.env`:

```powershell
$env:ALPACA_API_KEY="..."
$env:ALPACA_API_SECRET="..."
npm run dev
```

`run_playground.bat` reads these two values from the repository `.env` and
exports them before launching Vite. Optional server-side overrides are
`ALPACA_DATA_HOST`, `ALPACA_FEED`, and `ALPACA_ADJUSTMENT`.

## Download and sync

1. Start the Vite server and open the **IBKR Data** tab.
2. Select `Alpaca` as the source.
3. Choose `30m` or `1d` and a bounded period.
4. Use **Download** for a new or deliberately refreshed interval. Use
   **Sync** for an incremental update after the interval already contains
   Alpaca data.

Both actions merge fetched rows with the existing CSV. This is intentional:
an Alpaca download must not destroy older history when its requested window is
shorter than the file already on disk.

The catalog records the provider as follows:

- a fresh interval or an existing Alpaca interval is `source: "alpaca"`;
- merging Alpaca rows with an existing provider's rows records
  `source: "mixed"`;
- a legacy catalog entry without `source` is treated as unknown.

Incremental Alpaca sync is allowed for `alpaca` and `mixed` intervals. It is
rejected for an IBKR-only or unknown interval until the user establishes an
Alpaca source with Download. This prevents an unintentional provider switch
from looking like a normal incremental update.

After a successful run, the UI invalidates the local data caches. A `30m`
Alpaca file can be aggregated to a derived `4h` file with:

```powershell
npm run ibkr:aggregate -- --symbol AAPL --from 30m --interval 4h
```

The aggregator accepts any finer interval that divides the target exactly,
keeps the source CSV, skips unchanged destinations, and refuses a materially
smaller replacement unless `--force` is supplied. Alpaca `1d` data is already
daily and is not a source for a derived `4h` file.

## Data safety

- Alpaca and IBKR data can differ in feed, adjustments, coverage, and latest
  bar availability. Treat `mixed` intervals as an explicit research choice.
- API keys never appear in URLs, catalog JSON, CSV files, NDJSON events, or
  returned per-symbol results.
- Stop/cancellation has a no-write invariant for the affected symbol.
- The source selector and all mutation routes remain in the local IBKR Data
  server workflow; there is no browser credential path.

## Validation

Focused tests cover the fetcher, source routing and source guards, aggregation
compatibility, and credential handling:

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\alpaca-fetcher.spec.ts
..\..\..\node_modules\.bin\esno tests\alpaca-source-integration.spec.ts
..\..\..\node_modules\.bin\esno tests\alpaca-aggregate-compat.spec.ts
..\..\..\node_modules\.bin\esno tests\alpaca-security.spec.ts
```

Implementation lives in `lib/ibkr-data/alpaca-fetcher.ts` and the existing
IBKR pipeline in `lib/ibkr-data/ibkr-data-vite-plugin.ts`.
