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
  are also supported. A bounded period is a strict calendar-time limit for
  both Download and Sync: `4d` requests only the last four days. Sync's
  overlap is clipped to that limit, and an empty window is reported without
  fetching an earlier week.
- Alpaca credentials are read only by the Vite/Node process from
  `ALPACA_API_KEY` and `ALPACA_API_SECRET`.

The server fetches `/v2/stocks/{symbol}/bars`, follows pagination, deduplicates
timestamps with last-write-wins semantics, normalizes times to Unix seconds,
and treats missing/invalid volume as `0`. A bounded page ceiling or a
cancellation is reported as incomplete rather than silently marked complete.

Stock daily downloads exclude flat bars (`open = high = low = close`) with
zero volume. IEX can emit these carry-forward placeholders without any
trades, including an unadjusted prior close on a split date (TANH on
2026-09-04). They cannot supply an executable price. Existing IBKR daily CSV,
import, SQLite, and browser-cache loads apply the same exclusion before
signals or fills; the next Alpaca merge also removes saved placeholders.
No replacement price is invented. A next-open order waits for the next
available traded candle, subject to the replay's existing cancellation rules.
Positive-volume flat bars and non-flat bars with missing volume remain
available. Crypto and intraday bars retain their existing contracts.

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
shorter than the file already on disk. The resulting CSV can therefore contain
more than the selected period; the UI's `+N bars` counts fetched rows.

A fresh Alpaca download records its feed, adjustment, and split-adjustment
date, including for bounded periods. When existing Alpaca rows lack that
provenance, the settings change their price scale, a later split is detected,
or the split lookup fails, a bounded request fails for that symbol and leaves
its CSV and catalog unchanged. It asks for **Download** with **Data Period
max**; it never silently expands a bounded request into full history. A
complete explicit full refresh replaces a same-provider interval's old rows
so pre-split bars cannot remain at a stale nominal price scale. An incomplete
full refresh leaves the existing CSV untouched. Download onto another provider
remains an explicit mixed-source merge within the selected period.

To find existing stocks with this problem, select `30m` or `1d` and click
**Load Alpaca Refresh List**. It scans the saved catalog for Alpaca/mixed
intervals with missing adjustment history or price settings that differ from
the current server configuration. It replaces the Symbols input with that
list, selects Alpaca, and sets Data Period to `max`. Review the list, then
click **Download CSV**; loading the list does not start a download. An empty
list or failed scan leaves your inputs intact.

The scan uses `GET /api/ibkr/alpaca-refresh-symbols?interval=30m` (or `1d`),
with the standard local-route authorization gate. It needs no credentials
and makes no remote price or corporate-actions requests. A later split or a
split-lookup failure may still be detected during Download/Sync even when
the saved metadata passes this scan. Refresh reasons appear beside each
symbol in the output. The metadata rule is shared with the merge guard in
`lib/ibkr-data/alpaca-refresh-symbols.ts`.

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

For browser IBKR loads without an in-memory hit, valid explicit imports and
seed CSVs take precedence and skip SQLite/IndexedDB fallback reads. See the
[shared price-data guide](price-data.md) for source selection and persistence.

## Data safety

- Alpaca and IBKR data can differ in feed, adjustments, coverage, and latest
  bar availability. Treat `mixed` intervals as an explicit research choice.
- Alpaca's split-adjusted bars change historical prices after a reverse or
  forward split. The catalog records feed, adjustment, and the established
  split-adjustment date; a later split requires an explicit max/all refresh
  of that interval before new results are merged.
- API keys never appear in URLs, catalog JSON, CSV files, NDJSON events, or
  returned per-symbol results.
- Stop/cancellation has a no-write invariant for the affected symbol.
- The source selector and all mutation routes remain in the local IBKR Data
  server workflow; there is no browser credential path.

## Batch scheduling and settlement ownership

`processSyncBatch` runs one bounded worker loop per slot: three for Alpaca
(`ALPACA_SYNC_CONCURRENCY`, the sliding in-flight limit) and one for IBKR,
whose session-based gateway pipeline is inherently serial. Each loop claims
the next index from a shared cursor, updates the run snapshot's dispatch
frontier, awaits its fetcher, converts the outcome (result / failed /
cancelled), and claims again. Fetch failures become per-symbol outcomes;
only release-time failures (an NDJSON write throwing) are fatal and reject
the awaited batch promise for `handleSyncRequest`'s fatal path.

Event emission stays ordered: outcomes buffer in `pending` and release in
ascending original index order as `symbol` / `symbol_warning` /
`symbol_failed`, with one serialized catalog checkpoint per landed result.
A cancelled outcome's release settles the batch promise immediately — it
does not wait for sibling fetches — and leaves a permanent index gap:
outcomes behind the gap never release and never emit. Cancellation only
stops claiming when the signal is aborted or ownership is lost; a returned
cancellation without those keeps the freed slot replenished from the shared
cursor, so the remaining queue still dispatches and its fetches are then
silently dropped (a known lifecycle wart, preserved for compatibility).
The claim loop checks queue exhaustion before cancellation, so an abort
that fires after the final release does not retroactively cancel a
completed run. A bare `AbortError` from a fetcher is batch cancellation
under the same gap rule, not per-symbol failure accounting. These
settlement behaviors are deliberate compatibility, locked by the
characterization tests in `tests/alpaca-source-integration.spec.ts` and
`tests/ibkr-data-lifecycle.spec.ts`; correcting the gap/dispatch wart is a
separate behavior change, not part of the scheduler's structure.

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

## Market cap download

**Download MarketCap** on the IBKR Data tab assembles a daily market-cap
series per symbol (design reference: `docs/marketcap-download.md`):

```
marketcap(t) = local 1d close(t) × split-corrected shares outstanding(t)
```

- **Shares outstanding** comes free from SEC EDGAR XBRL: the
  `dei:EntityCommonStockSharesOutstanding` cover-page fact of each 10-Q/10-K,
  fetched keyless via the company-concept API with a descriptive
  `User-Agent` and a client-side rate limiter (≥150 ms between EDGAR
  requests; `Retry-After` is honored). Ticker → CIK resolution uses
  `company_tickers.json`, disk-cached at
  `price-data/ibkr/marketcap/.company-tickers.json` and refreshed when older
  than ~30 days.
- **Point-in-time semantics**: each fact is keyed by its `filed` date
  (availability), never backdated to `end` (measurement). A trading day uses
  the latest fact with `filed ≤ tradingDay`; days before the first filing are
  skipped. Historical replays therefore never see a count before the public
  did (values within a quarter are slightly stale versus "true" cap —
  accepted).
- **Split convention (non-negotiable)**: split factors are SHARE-COUNT
  multipliers derived from Alpaca corporate-actions (`new_rate / old_rate`,
  effective from the split's `ex_date`, which matches the repo's
  split-adjusted 1d bars). Historical raw EDGAR counts are MULTIPLIED by the
  cumulative factor of later splits —
  `adjustedShares = edgarShares × F(filed → now)` — so the invariant
  `adjustedClose × adjustedShares === rawClose × rawShares` holds row by row
  (NVDA June 2024: $120.89 × 24.6B = $1,208.90 × 2.46B ≈ $2.97T). Dividing
  instead would print a smooth-looking 100× wrong level on all pre-split
  history, which is why continuity is NOT a valid smoke check.
- **Storage**: `price-data/ibkr/marketcap/<SYM>.csv`
  (`time,close,shares_outstanding,market_cap`, one row per trading day) plus
  a flat `catalog.json` in the same directory. This is a sibling of the
  candle `csv/` tree — candle loaders never see it. Market-cap data also
  never enters the in-memory candle caches.
- **Lock occupancy**: the run occupies the shared IBKR Data lock (same
  `syncOwner` machinery), so it is mutually exclusive with candle
  sync/download, the Stop button cancels it, and a page reload reattaches via
  `GET /api/ibkr/sync/status` (rendered as "EDGAR marketcap …"). It never
  touches the IBKR Gateway. A second run while one is active gets a 409
  ("An IBKR Data run is already in progress. Use Stop first.").
- **Strict failure modes** (per-symbol `symbol_failed`, nothing written, run
  continues): ticker unknown in the EDGAR map (share-class tickers are
  mapped `.` → `-`, e.g. `BRK.B` → `BRK-B`), no `dei` facts on EDGAR, no
  local 1d prices (download 1d first), or a failed/unrecognized Alpaca
  corporate-actions fetch. The last one is deliberate: knowingly writing an
  unadjusted (wrong-level) series would poison the dataset. Only a failure of
  the tickers map itself is fatal for the whole run.
- **Multi-class caveat**: EDGAR `dei` elements are not dimensionable per
  class, so the filer reports one filer-chosen cover-page number. Empirically
  (verified live, see `tests/fixtures/marketcap/`): AAPL/NVDA-style single
  class filers report ≥5 years of facts; **Alphabet (GOOGL) publishes no
  `dei` shares-outstanding facts at all**; **Berkshire (BRK-B/BRK-A) stopped
  tagging the fact after May 2011**. Those symbols fail per-symbol by design
  rather than writing an unusable series.
- **EDGAR User-Agent format matters**: `www.sec.gov/files` rejects User-Agents
  without an `adminContact@domain`-style contact with a misleading
  "Request Rate Threshold Exceeded" page (verified live). The fetcher's
  constant uses the documented `Name email@domain` convention.

### Coverage (verified live 2026-09-12, full 502-symbol list run)

435 of 502 symbols produced a market-cap series; all 67 failures are
permanent EDGAR data gaps, not transient errors (each was re-probed
individually):

- 29 symbols: the companyconcept endpoint returns 404 — no dei
  shares-outstanding facts at all (e.g. GOOGL, GOOG, META, PLTR, APP, DELL).
- 33 symbols: the concept exists but the `units.shares` container is empty
  (e.g. ABT, KO, CB, SPGI).
- 3 symbols: missing from `company_tickers.json` entirely (EA, AVB, EQR —
  an EDGAR map gap; the tickers file omits some filers).
- 2 symbols: facts stopped years ago (TAP after 2010, Berkshire after 2011),
  refused by the staleness fence (newest fact older than 3 years) — the join
  would otherwise price every recent day with that ancient count, a
  smooth-looking wrong-level series (Berkshire's is also a Class-A count on
  Class-B prices).
- The list itself contains one stray token (`135`) that no ticker map can
  resolve.

Expect roughly 85–90% coverage on a large-cap US list. Failed symbols are
always safe to re-run after EDGAR catches up (the dataset is rewritten
atomically per symbol).

A full S&P 500 run costs ~1000+ requests (tickers map + one EDGAR concept +
one Alpaca splits query per symbol) and takes on the order of 4–8 minutes.

```powershell
npm run typecheck
..\..\..\node_modules\.bin\esno tests\marketcap-fetcher.spec.ts
..\..\..\node_modules\.bin\esno tests\marketcap-batch.spec.ts
```
