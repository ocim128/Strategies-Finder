# Asset Opportunity Explorer

A read-only heatmap over the existing `archive/asset opportunity` folder. Open it from **More > Research & validation > Opportunity Explorer**. The feature is descriptive: it helps inspect what the Finder already archived across holdout values and archive sorts. It generates no theses, profitability rules, verdicts, optimized thresholds, or ranking of recommended sorts.

## What it shows

- **Catalog**: every batch run found in matching `oos-holdout-<N>-bars.txt` files directly inside the archive folder (no recursion, report/config files ignored), with the run's latest archive export timestamp, holdout offsets, archived horizons, sort metrics, archived rank limit, and source-block count. The newest run by export timestamp is selected initially. `next_exit` runs and runs with mixed measurement modes are listed but excluded from the heatmap.
- **Heatmap**: one row per archive sort, one column per holdout offset (descending, older boundary first). For each `(sort, holdout, horizon)` cell: the equal-weight mean of selected rows' `averagePnlPercent` (ranks `<= K`, array-position fallback where rank is absent), the matching all-candidate baseline for that exact block, and their difference in percentage points. No observations means the cell is unavailable — never zero-filled. Missing cells and missing counts stay visible.
- **Range detail**: clicking a row selects all visible columns; dragging selects a contiguous interval for one row; labelled start/end inputs and keyboard navigation (arrow keys, `Enter` to select a row, `Esc` to clear) do the same. The detail shows the equal-holdout mean/median over finite cell values, a histogram of those cell values, total/observed holdouts, observed/missing candidate rows, and confirmed candidate identities (`symbol + strategyId + candidateFingerprint`; rows without a fingerprint are counted as unknown observations and never merged into a confirmed identity). The paginated evidence table lists candidate rows with rank, archived return, baseline, fingerprint, and source filename/block timestamp.
- **Columns** can be all holdout offsets or horizon-spaced: starting at the largest offset, greedily keep the next offset at least the chosen horizon lower. The set is fixed per snapshot, so moving a selection never changes the sampling anchor.

## Controls

Run, forward horizon, top-K (bounded by the archived rank limit), actual return (`%`) versus difference from baseline (`pp`), and column spacing. **Refresh** re-reads the archive, bypassing cached metadata and invalidating the retained view; a failed refresh keeps the previous display marked stale.

## Measurement notes and limits

- Holdout offsets are archive export windows in bars — not calendar dates, market decision dates, or independent samples. Windows overlap and nest.
- The archive keeps a ranked shortlist plus aggregate baselines, not all candidate outcomes. K cannot exceed the archived rank limit and a full-universe distribution cannot be reconstructed.
- Delta is the selected mean minus the block's all-candidate baseline in percentage points; no baseline means delta is unavailable. It is not a fee-adjusted portfolio simulation.
- Missing `forwardOosPerformance.basis` (older rows) is labeled unknown; a run mixing explicit bases (`pair` vs `base_only`) is rejected rather than averaged. `next_exit` runs are analyzed by the holdout-analysis CLI, not this heatmap.
- Version one analyzes one batch run at a time. This deliberately differs from the CLI's combine-all-runs default, which is preserved.

## API

Read-only local routes (loopback-gated like every other local API; the folder is local, so static hosting shows a local-server requirement):

| Route | Purpose |
| --- | --- |
| `GET /api/asset-opportunity-explorer/catalog` | Per-run metadata; `?refresh=1` bypasses the cached scan and invalidates the retained view. |
| `GET /api/asset-opportunity-explorer/heatmap` | `batchRunId`, `horizonBars`, `topK`, `spacing` → snapshot id, axes, cells (actual/baseline/delta/counts), measurement metadata, diagnostics. No candidate arrays on the wire. |
| `GET /api/asset-opportunity-explorer/details` | `snapshotId`, `sortMetric`, inclusive `holdoutFrom`/`holdoutTo`, `metric`, `offset`, `limit` (default 100, max 500) → full-range summaries, histogram bins, one candidate-row page. An evicted snapshot answers `409` and the UI reloads the view. |

Loading is bounded: matching files are read one at a time (stat → read → stat; an append mid-scan yields a retryable archive-changed error). A file that cannot be parsed fails the whole scan with its filename rather than being skipped, a missing archive folder is an explicit empty state, and any other directory read failure is an actionable error. At most one compact selected-run view and its derived snapshot are retained per process, scans for identical in-flight requests are coalesced, and an older scan completion never overwrites a newer refresh or run selection.

## Files

- `lib/asset-opportunity-explorer/`: `archive-parser.ts` (shared parser extracted from the CLI script), `analysis.ts` (cell/range calculations), `types.ts` (wire shapes), `archive-reader.ts` (bounded scan), `server-vite-plugin.ts` (routes), `dom.ts` / `service.ts` / `renderer.ts` (UI).
- `styles/asset-opportunity-explorer.css`: lazy-loaded styles.
- `html-partials/tab-asset-opportunity-explorer.html`: tab partial, lazily injected.
- Tests: `tests/asset-opportunity-explorer-analysis.spec.ts`, `tests/asset-opportunity-explorer-server.spec.ts`, `tests/asset-opportunity-explorer-service.spec.ts`.

The CLI report pipeline (`scripts/analyze-asset-opportunity-holdouts.ts`) keeps its behavior and public exports; the parser lives in the shared leaf module and the script re-exports it.
