# Finder Asset Opportunity Re-Sort Implementation Guide

This guide is for implementing the complete experimental thesis set in the
existing Finder Asset Opportunity feature. It covers the browser `Re-Sort`
control and the server-owned batch archive contract under
`archive/asset opportunity/`.

When a request supplies an ideas/theses array, implementation means every idea
in that array. Do not stop after the first key appears in the dropdown. The
dropdown is only a registry symptom; each thesis needs its calculation,
invalid-value policy, visible result value, copy/archive field, and regression
test. A grouped thesis also needs its full-pool preservation rule.

This is an implementation guide only. It does not prescribe how to compare,
judge, or promote a sort after it has been implemented. Every implemented sort must
choose candidates only from historical or otherwise available-at-ranking
fields; forward evaluation results must never be used as sort inputs.

The companion idea-generation prompt is
[`archive/prompt-finder-asset-opportunity-resort.txt`](../archive/prompt-finder-asset-opportunity-resort.txt).
It is deliberately strict: a proposed metric must be a real post-run sort and
must identify any scalar/archive data it needs.

## Scope

This guide covers the code and archive changes required to add the complete
experimental ranking set. It does not define a deployment rule or change
the Asset Opportunity evaluator.

The sort may use only historical or otherwise available-at-ranking fields. Do
not use `oosResult`, `oosVerdict`, `oosHorizonMetrics`, or
`oosNextExitMetrics` as inputs. Preserve `nextExitOosPerformance` as an output
of the existing evaluator so the forward result remains available to archive
consumers.

## Required thesis inventory

The current ten-idea inventory is the reference shape for the implementation
that motivated this guide. Keep the keys and directions aligned with the idea
specification; do not silently implement only the first row.

| Key | Unit and formula | Direction / fixed gate |
| --- | --- | --- |
| `medianBarsToTp` | Median candle distance from entry to `take_profit` exits | Lower first; at least 3 TP hits |
| `priorTupleRecurrence` | Count earlier archived fold snapshots containing the exact `(symbol, strategyId, candidateFingerprint)` tuple | Higher first; earlier cutoff only |
| `strategyCoverageGate` | Keep normalized symbols represented by at least 3 distinct strategies; representative is the grade winner, ordered by resolved PF | PF descending; minimum 3 strategies |
| `barrierExitShare` | `(take_profit + stop_loss) exits / completed IS trades` | Higher first; at least 10 trades |
| `entryHourConcentration` | Circular resultant length of completed IS entry hours in UTC | Higher first; at least 8 entries |
| `tradeGapUniformity` | Mean completed-entry bar gap divided by gap standard deviation | Higher first; at least 3 gaps; regular gaps may be `+Infinity` |
| `topDecileProfitShare` | PnL of the top `ceil(10% of trades)` divided by total absolute PnL | Lower first; at least 10 trades |
| `winnerLoserHoldGapBars` | Median winner hold bars minus median loser hold bars | Lower first; at least 3 winners and 3 losers |
| `entryPriceRegimeMembership` | `1 - abs(2 * empiricalCDF(freshEntryPrice) - 1)` over historical entry prices | Higher first; at least 8 historical entries |
| `equityPathLinearity` | Pearson `r²` between trade ordinal and cumulative completed-trade PnL | Higher first; at least 8 trades |

The invalid policy is part of the thesis, not an implementation detail: the
row-level metrics above sort missing/insufficient/non-finite values last, while
`strategyCoverageGate` excludes symbols below its gate only for that grouped
view. The underlying strategy-level pool remains unchanged. `priorTupleRecurrence`
uses only snapshots with a strictly earlier data cutoff; under the pinned batch
convention this is a larger reserved-holdout value. The fixed recurrence
density threshold (`0.05`) belongs to inference/reporting, not to silently
zero-filling a missing row.

## Current data flow

| Surface | Source of truth | Responsibility |
| --- | --- | --- |
| Finder Asset Opportunity settings and `Re-Sort` select | `html-partials/tab-finder.html` | Provides the existing controls; normally no new structural DOM id is needed for a metric-only sort. |
| Finder DOM contract | `lib/finder/finder-manager-dom.ts` | Defines required IDs. Update only if the new idea adds a control or output field. |
| Metric and comparator | `lib/finder/finder-asset-opportunity-metrics.ts` | Defines the metric key, available metric list, value extraction, direction, grouping, ties, and invalid-value behavior. |
| Browser orchestration | `lib/finder-manager.ts` | Populates `finderResort`, applies the selected metric, retains the full strategy-level pool, and renders the bounded result view. |
| Asset Opportunity result presentation | `lib/finder/finder-ui.ts` | Renders the scalar on each visible result row. A dropdown label alone is not proof that the metric is available to the user. |
| Per-asset result production | `lib/finder/finder-asset-opportunity-runner.ts` and `lib/finder/server/asset-opportunity-iteration.ts` | Produces the result row and, when needed, computes a new scalar before heavy arrays are stripped. |
| Browser Copy Top Results payload | `lib/finder/finder-asset-opportunity-metadata.ts` | Includes a new user-facing scalar when available, while omitting it for legacy rows that never had the field. |
| Server wire contract | `lib/finder/server/finder-stream-types.ts` | Strips `trades` and `equityCurve` arrays before Asset Opportunity rows cross the server boundary. |
| Compact archive row | `lib/finder/finder-asset-opportunity-metadata.ts` | Selects the scalar fields persisted in each `oos-holdout-<N>-bars.txt` block. |
| Archive writer | `lib/finder/server/finder-vite-plugin.ts` and `lib/finder/server/finder-asset-opportunity-archive.ts` | Emits the default order and every registered metric for each batch holdout. |
| Archive compatibility | `lib/finder/finder-asset-opportunity-metadata.ts`, `lib/finder/server/finder-asset-opportunity-archive.ts`, and the archive parser | Keeps each new sort block labeled and its required scalar fields available to archive consumers. |

The browser receives the full scalar strategy-level Asset Opportunity rows on a
terminal run. `assetOpportunityRunResults` retains that full pool, but
`setAssetOpportunityLatestResults()` deduplicates the ranked rows by normalized
symbol and applies `topN` for display and Copy Top Results. A new metric must
rank first, then let the UI select the representative row; applying the limit
or deduplicating before sorting can hide the metric's intended winner. This is
especially important for `strategyCoverageGate`: it is a grouped display view,
but `assetOpportunityRunResults` must continue to hold the complete
strategy-level pool so a later sort can inspect it.

For a new scalar, the visible result row must show both states:

- a finite valid value with its unit, for example `Median TP 3.5 bars`;
- an explicit unavailable marker such as `Median TP --` for old snapshots,
  insufficient observations, or invalid inputs.

The UI presentation is intentionally not a new structural DOM contract when it
is just an inline metric chip. The existing browser UI test harness can still
render a representative Asset Opportunity row and assert the value and the
unavailable marker.

## Definition of done

A thesis set is complete only when every supplied idea—and every key in the
inventory above when that inventory is the requested scope—meets all of these
conditions:

- Each thesis has one descriptive metric key and a clear high-first or
  low-first direction.
- Its input fields are available on the browser result and, when the batch
  archive needs them, on the compact archive row.
- It is deterministic for invalid values, ties, repeated strategy rows, and
  normalized symbols.
- Selecting it in `finderResort` changes the displayed Asset Opportunity order
  without changing the original run order or the underlying run results.
- The visible Asset Opportunity row renders the scalar with its unit when it is
  valid and an explicit unavailable marker when it is missing; the browser Copy
  Top Results payload carries the same scalar when available.
- A browser-side presentation test proves the value is actually rendered. A
  test that only checks the dropdown option or metric inventory is insufficient.
- The server batch emits a labeled `Archive sort: <new-key>` block for every
  holdout iteration.
- Focused unit, archive, server, typecheck, and test-suite checks pass.
- Existing archive rows remain parseable, and the new block contains every
  scalar required by the implemented metric's definition.

## Step 1: Freeze the sort specification

Before editing code, copy every supplied idea into a short run card. Record:

- metric key and human label;
- unit of analysis: one strategy row or a normalized-symbol group;
- exact formula and sort direction;
- fixed constants and why they are not tuned;
- input fields and their availability;
- invalid, missing, zero-trade, infinite, and tie behavior;
- representative-row behavior for symbol-level grouping;
- the exact source and archive fields required by the implementation.

Do not add a UI parameter merely to make an experiment configurable. If a
threshold, weight, minimum count, or percentile is part of the idea, freeze it
in the run card first. Before coding, reconcile the run-card keys against the
inventory, and after coding reconcile them against the metric list, result
fields, UI chips, copy/archive fields, and tests.

## Step 2: Classify the data requirement

Use the smallest implementation path that satisfies the idea.

### A. Existing scalar fields

Use this path when the metric can be computed from fields already present in
`FinderAssetOpportunityResult` and the compact archive payload, especially
`selectionResult` / `selectionPerformance` values such as:

- `netProfit`, `netProfitPercent`, `winRate`, `expectancy`;
- `avgTrade`, `avgWin`, `avgLoss`, `profitFactor`;
- `maxDrawdownPercent`, `sharpeRatio`, and `totalTrades`.

This path normally requires only the metric module, its UI label, and tests.
The server batch already loops over
`[null, ...getAssetOpportunityResortMetrics()]`, so registering the metric in
the existing list makes it eligible for archive output automatically.

### B. A new per-row scalar

Use this path when the idea needs a historical path summary that is not yet
retained, such as a carefully defined bars-to-event statistic.

Compute the value while the full candidate/backtest result is still available
in the Asset Opportunity runner. Add the scalar to
`FinderAssetOpportunityResult`, then ensure `toScalarAssetResult` preserves it.
The field must be finite or have an explicit invalid sentinel policy. Do not
send `trades`, `equityCurve`, signals, or candles just to support a sort.

Add the same scalar to `AssetOpportunityPerformancePayload` in
`lib/finder/finder-asset-opportunity-metadata.ts`, and populate it in
`buildAssetOpportunityPerformancePayload`. The archive parser and any archive
consumer should read the same scalar name from every selected row. If the
value is not present in the archive, the batch block cannot support that
metric after the run.

If the scalar is user-facing, also add it to
`AssetOpportunityMetadataPayload`/`buildAssetOpportunityMetadataPayload` so
the browser's Copy Top Results output agrees with the row. Keep that field
optional when older persisted snapshots or archives may not contain it.

### C. A cross-strategy or per-symbol aggregate

Use this path only when the research mechanism genuinely depends on agreement
or dispersion across the strategy-level rows for one normalized symbol.

The comparator must state:

1. the normalized grouping key;
2. which rows are eligible;
3. how the aggregate is calculated;
4. which row represents the symbol in the displayed result;
5. how a second re-sort can still access the complete strategy-level pool.

Follow the existing `freshSignalLibraries` pattern in
`sortAssetOpportunityResultsByMetric`: derive one representative per symbol
for the consensus view, but keep `assetOpportunityRunResults` as the complete
strategy-level set for later re-sorts. Archive consumers must use the tuple
identity `(symbol, strategyId, candidateFingerprint)` and must not count
correlated parameter variants as independent strategy families.

If the aggregate needs a value not present in compact archive rows, add a
minimal scalar field or an explicit archive-compatible diagnostic. Do not
silently reconstruct a runtime-only value from fields that were not persisted.

## Step 3: Implement the pure metric

Edit `lib/finder/finder-asset-opportunity-metrics.ts` surgically.

1. Add a named constant for the new key if it is not a normal `FinderMetric`.
2. Add the key to `FinderAssetOpportunityResortMetric`.
3. Add it to `ASSET_RESORT_METRICS`, which feeds both the UI list and the batch
   archive list.
4. Add scalar extraction to `getAssetOpportunityMetricValue` when the metric
   is a direct row-level field.
5. Add a dedicated branch in
   `sortAssetOpportunityResultsByMetric` when the metric needs grouping,
   special direction, fixed constants, or custom tie logic.
6. Return a new array from the public post-run sort function. Do not mutate the
   caller's saved default order.

The comparator must explicitly handle:

- non-finite values, including whether they sort last or are converted to a
  documented neutral value;
- zero trades or insufficient observations;
- all-win values where a ratio would otherwise be undefined;
- ties at saturated or rounded values;
- the final deterministic tie-breaker, normally normalized symbol and then a
  stable candidate tuple where strategy rows remain visible.

Do not consult `oosResult`, `oosVerdict`, `oosHorizonMetrics`, or
`oosNextExitMetrics` as ranking inputs. They are forward outputs, and using
them to choose the displayed winner leaks the holdout into selection.

## Step 4: Register the UI label

`lib/finder-manager.ts` populates the `finderResort` options in
`populateResortOptions()`.

- If the new key is a normal `FinderMetric`, the existing
  `METRIC_FULL_LABELS` lookup may be sufficient.
- If the key is a custom `FinderAssetOpportunityResortMetric`, add an explicit
  human-readable label in the Asset Opportunity label map. Do not rely on
  `METRIC_FULL_LABELS[metric as FinderMetric]` for a custom key; that can render
  an undefined label.
- Do not add `ASSET_OPPORTUNITY_ALL_SORTS` to the browser metric list. It is a
  server batch archive mode and the browser already rejects it as a displayed
  sort.

`applyResort()` already calls
`sortAssetOpportunityResultsByMetric()` for the Asset Opportunity scope. Keep
the full strategy-level result set intact for normal metrics. If the new sort
is grouped like the two existing consensus sorts, follow their special
representative-row behavior and test that a later sort can still restore or
inspect the full run pool.

Do not stop after adding the option label. Update
`FinderUI.renderAssetOpportunityResults()` to render a visible chip from the
same scalar used by the comparator. Format valid numeric values with the
metric's unit and render an explicit unavailable marker for `undefined`,
`null`, non-finite, or otherwise invalid values. This is required even when no
new HTML element or DOM id is needed.

No new DOM contract is needed for a metric-only sort. If the idea genuinely
needs a user setting, update the HTML partial, the feature-local DOM contract,
the settings read/write path, and the DOM contract test together. Keep a fixed
default and preserve persisted settings compatibility.

## Step 5: Keep server, browser, and archive definitions aligned

The server batch path is intentionally centralized:

```text
resolveAssetOpportunityArchiveSorts()
  -> [null, ...getAssetOpportunityResortMetrics()]
  -> sortAssetOpportunityResultsByMetric(iteration.results, sortMetric)
  -> slice topN for the archive block
  -> buildAssetOpportunityPerformancePayload(...)
  -> append `Archive sort: <metric>` to oos-holdout-<N>-bars.txt
```

After registering a metric, verify this path rather than adding a second
per-metric server branch. The archive must contain a new labeled block for the
metric at every holdout value.

If the metric uses only existing persisted fields, no archive format change is
needed. The existing archive persists `nextExitOosPerformance` when the run
uses `Next configured exit`; do not copy that forward output into the sort's
input fields. If the metric needs a new scalar:

- add it to the result type and producer;
- preserve it through `toScalarAssetResult`;
- add it to `AssetOpportunityPerformancePayload`;
- add it to the archive consumer's row interface and parser;
- test an archive block containing the field;
- document older archives as unavailable for this metric when the field is
  absent, rather than treating missing values as zero.

The same compatibility rule applies to persisted browser snapshots: rows
created before the scalar existed must remain renderable, display the
unavailable marker, and sort after valid rows. Do not silently recompute a
historical path metric from arrays that were intentionally stripped from the
snapshot/wire payload.

Keep the existing scalar-wire contract. Never add heavy arrays to
`FinderAssetOpportunityResult` on the stream or to automatic archive rows.

For `priorTupleRecurrence`, the server must load existing holdout blocks before
the batch loop, match the exact normalized tuple using the persisted
`candidateFingerprint`, and compare only strictly earlier cutoffs. Because
All-Sorts appends one block per metric, collapse blocks by `(batchRunId,
holdoutBars)` before counting; otherwise one fold is incorrectly counted once
per sort. A new/current row starts at zero when no prior snapshot matches.

## Step 6: Add focused tests

Start with `tests/finder-asset-opportunity-metrics.spec.ts`. Tests should encode
the implementation contract, not only that JavaScript `.sort()` returns an
order.
Include the cases relevant to every supplied idea:

- the intended mechanism ranks the correct synthetic rows;
- fixed constants and direction are applied exactly;
- missing, NaN, infinite, zero-trade, and insufficient-observation rows do not
  break the ranking;
- ties use the documented deterministic rule;
- symbol grouping and representative selection are correct if applicable;
- the input array remains unchanged;
- every supplied key is returned by `getAssetOpportunityResortMetrics()`.

Add or update these tests when their contracts are touched:

- `tests/finder-asset-opportunity-metadata.spec.ts` for a new archive scalar;
- `tests/finder-asset-opportunity-archive.spec.ts` for the block label and
  persisted payload;
- `tests/finder-asset-opportunity-stream.spec.ts` for scalar wire preservation;
- `tests/finder-manager-lifecycle.browser.spec.ts` (or an equivalent browser
  UI spec) for visible valid/unavailable scalar rendering and the normalized
  result-view path;
- `tests/finder-server-plugin.spec.ts` for batch archive registration or HTTP
  metric validation;
- `tests/feature-dom-contracts.spec.ts` if a new structural UI id is added.

Do not write a test that only checks the metric name exists. It must fail if a
future change reverses direction, uses OOS data, drops a tie-breaker, or loses
the archive field.

## Step 7: Preserve batch archive compatibility

The server-owned Asset Opportunity batch writes to:

```text
archive/asset opportunity/oos-holdout-<N>-bars.txt
archive/asset opportunity/oos-pair-summary-<N>-bars.txt
archive/asset opportunity/config.txt
```

The implementation must not change the archive's existing evaluation
semantics. It must preserve the existing `nextExitOosPerformance` payload,
including its exited, censored, and unavailable states, separately from the
sort inputs.

The holdout files are append-only and contain the default block plus every
registered re-sort. Registering the new key in
`getAssetOpportunityResortMetrics()` makes the server batch emit a labeled
`Archive sort: <new-key>` block automatically through
`resolveAssetOpportunityArchiveSorts()`.

Do not add a second archive loop. The archive writer already sorts the same
iteration result set by each registered metric and slices only after sorting.
The default run order remains `run_default`; the new metric gets its own label.

If the metric uses only existing persisted fields, no archive format change is
needed. The existing archive already persists `nextExitOosPerformance` when the
run uses `Next configured exit`; do not copy that forward output into the sort's
input fields. If the metric needs a new scalar:

- add it to the result type and producer;
- preserve it through `toScalarAssetResult`;
- add it to `AssetOpportunityPerformancePayload`;
- add it to the archive parser's row interface and validation;
- add an archive fixture test proving the field survives the block round trip;
- make missing old-archive values explicit rather than treating them as zero.

The new block must remain distinguishable from the existing next-exit output.

## Final implementation checklist

- [ ] The supplied idea list has been reconciled against the metric inventory;
      no thesis is left as a dropdown-only placeholder.
- [ ] Formula, direction, constants, missing-value policy, grouping, and ties
      are frozen in a run card.
- [ ] The comparator is pure and does not read OOS or future outcomes.
- [ ] Browser scalar and compact archive inputs are the same definition.
- [ ] The full result pool remains available for subsequent re-sorts.
- [ ] `getAssetOpportunityResortMetrics()` exposes the key.
- [ ] `finderResort` shows a non-empty label for the key.
- [ ] `FinderUI.renderAssetOpportunityResults()` visibly renders the metric's
      value and unit, plus an explicit unavailable marker for missing legacy or
      invalid values.
- [ ] `Copy Top Results` carries the same new scalar when it is available.
- [ ] A browser UI test checks presentation; dropdown/inventory coverage alone
      does not prove the metric is visible.
- [ ] Sorting happens before normalized-symbol deduplication and `topN` display
      slicing, so the full retained pool can affect the visible result.
- [ ] A batch archive contains `Archive sort: <key>` for every holdout.
- [ ] New scalar fields, if any, survive wire stripping and are parsed by the
      archive consumer.
- [ ] Focused tests cover the reason the metric exists and its failure modes.
- [ ] Typecheck, test suite, and feature contracts pass.
- [ ] Existing next-exit target fields remain separate from the sort inputs.
- [ ] Grouped sorts preserve the complete strategy-level pool for later
      re-sorts, even when their displayed result is one representative per
      normalized symbol.
