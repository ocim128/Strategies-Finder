# Strategy Finder

This is the maintained reference for the Finder menu. Read it before changing
Finder controls, ranking metrics, result retention, server routes, or the
backtest path used by Finder.

Synthetic symbols ending in `@50/50` (or the shorthand `@`) select
[equal-dollar leg execution](synthetic-pairs.md#equal-dollar-two-leg-execution).
The ratio still drives strategy signals, while candidate profit, costs and
drawdown come from the two legs. Current-chart, Universe and OOS runs use
TypeScript for this mode, with the single-position fast path available under
its normal settings fences. Universe ranking skips the legacy pair-neutral log
adjustment, and symbol lists deduplicate `@` and `@50/50` aliases.

The Finder searches strategy parameters and displays the strongest candidates
for one of five scopes:

- **Current Chart** searches parameter combinations on the active chart.
- **Symbol Universe** evaluates selected strategies across a list of symbols
  and ranks strategy/universe combinations.
- **Asset Opportunity** searches each symbol for fresh-entry opportunities and
  can validate the selected opportunities forward in time.
- **Strategy Quality Audit** runs each selected strategy with normalized
  defaults across the supplied symbols. It is a baseline quality report, not
  parameter discovery.
- **Arm Performance** evaluates each generated configuration across the same
  supplied synthetic-pair universe, then lets the user re-sort the completed
  configuration inventory by any of the 20 TOP_MEAN replay arms.

The menu is assembled from `html-partials/tab-finder.html`. Its structural DOM
contracts are `lib/finder/finder-manager-dom.ts` for controls and
`lib/finder/finder-ui-dom.ts` for result, progress, status, and benchmark
elements. Do not rename an id in the partial without updating its contract
and the feature DOM tests.

## User workflow

> Metric semantics note: percentage drawdown is maximized independently of
> dollar drawdown (the worst relative loss may come from a smaller early
> peak). Results and archives produced before this correction underreported
> `maxDrawdownPercent` whenever a larger dollar loss occurred from a higher
> peak; persisted snapshots keep their historical scalars and cannot be
> repaired without the original execution data, so corrected metrics require
> reruns. Walk Forward analyses honor an active exit strategy override on the
> same terms as the normal executor and require the chart interval in their
> configuration when that override is active.

1. Select a scope.
2. Select one or more strategies. The bulk actions are `All`, `None`,
   `Invert`, `Visible`, `Follow`, and `Reversion`.
3. Configure the search, data window, ranking, filters, and optional OOS
   validation.
4. Click `Run Finder`.
5. Inspect the result cards and symbol breakdowns.
6. Use `Apply` on a result to copy its strategy parameters into the active
   backtest configuration.
7. Use `Copy Top Results`, `Copy Diagnostics`, or `Copy Configuration` when
   recording or reproducing a run.

`Stop` cancels the active run. `Reset Settings` restores Finder defaults while
preserving the current strategy selections. Finder settings are persisted in
the browser, so changes to the settings schema require backward-compatible
defaults and normalization.

Follow and Reversion are curated presets. Their buttons show the number of
matching strategies available in the current library; a preset with no matches
is disabled and never clears the existing selection. None remains the explicit
action for clearing selections.

From/To edits, including clearing either date, use the same debounced settings
save as other search inputs. Pending settings writes flush on pagehide, so a
reload preserves date-only edits without requiring a run first.

Scopes locked to Random Search display that enforced mode without replacing
the saved search-mode preference. Editing other controls in those scopes also
keeps the preference; returning to Current Chart or Arm Performance restores
the chosen Grid Sweep or Random Search mode. Scope changes immediately refresh
the universe count and its symbol/pair label.

Arm Performance hides the shared OOS Validation control and always submits it
as disabled, including with a Date range. The checkbox preference remains
available when returning to a scope that supports shared OOS validation.
`tests/finder-menu-controls.browser.spec.ts` and the Finder E2E workflow cover
these scope transitions.

## Shared controls

### Workspace layout and result views

Run Finder, Stop, progress, and status share a sticky execution bar within the
strategy panel's scroll area. At panel widths of at least 1,040px, configuration
and results appear side by side; narrower panels stack them. Layout follows
the actual panel width, including when the chart is visible or the panel is resized.

Risk management, exit strategy override, trade-count filters, and universe
filters use collapsed disclosures. Their summaries show the selected options
and bounds and update after edits and Reset Settings. Collapsing a section
does not disable its settings or change the saved settings contract.

Cards/Table selects how the current result inventory is displayed. Table
columns follow the scope: chart performance, universe aggregates, fresh-entry
support, baseline quality, or the selected arm's return/P&L/ranking measurement.
Tables reuse the formatted card metrics, preserving unavailable values and
contributor-exclusion basis. Card/table identity is explicit: each render
computes every displayed metric once and declares its formatted value under a
stable key (`lib/finder/finder-results-table.ts`), together with the
candidate's title, OOS badges, replay status, detail/disclosure nodes, and
Apply button. That one set of parts is laid out either as a card or directly
as comparison-table rows, so the table never parses card wording or scrapes
card DOM: renaming a label cannot change column identity, and Arm column
selection is resolved once per render from the replay mode, measurement, and
ranking sort rather than inferred from card texts. A column whose value the
row did not declare falls back to `--`.
Parameters, all remaining metrics, and existing lazy symbol/measurement
breakdowns are available under Parameters & details. OOS verdict badges and
incomplete replay status remain visible in the table.

Apply uses the same candidate index and guards in both views; quality audits
remain read only, and cached-preview Apply restrictions remain in place.
Every Apply flow also participates in the app-wide selection-ownership
boundary (see [settings](settings.md#strategy-selection-ownership)): the
candidate's strategy loads before anything is committed — a missing strategy
aborts Apply without touching ownership — and a pending dropdown selection is
superseded at commit time, so a selection that was still loading when Apply
ran can never replace the applied strategy, metadata, parameters, or applied
backtest settings.
Re-Sort continues to rank the retained inventory before Top Results limits
the rendered rows. Table mode does not add a second sorting path or start a
run. On narrow screens only the table's region scrolls horizontally. View
and disclosure choices last for the mounted Finder session and are not saved;
search settings retain their existing persistence behavior.

Arm Performance display edits coalesce into one update per animation frame.
Duplicate events skip sorting and rendering when the inventory, display limit,
selected arm, and filter are unchanged. Every accepted edit sorts ONLY the
selected arm from the full inventory; there is no cached default array. Arm
"Run Sort" (an empty re-sort dropdown) routes through the same display
controls and re-applies the current filter to the default arm, so a filter
that hides every default-arm row keeps the view empty. Display snapshots
debounce for 300 ms and flush on pagehide; terminal results still persist
immediately, and starting a new run discards pending checkpoints from the
previous run.

### Search controls

| Control | Meaning |
| --- | --- |
| `Top Results` | Number of result cards rendered. In Symbol Universe this is a display limit, not the size of the terminal ranking inventory. |
| `Runs / Strategy` | Candidate evaluations per selected strategy, subject to the selected search mode. |
| `Search Mode` | `Grid Sweep` or `Random Search`. Symbol Universe, Asset Opportunity, and Strategy Quality Audit lock this control to Random Search. |
| `Range (%)` | Parameter variation range used by the candidate generator. |
| `Steps / Param` | Number of values per parameter for grid-style generation. |
| `Data Window` | Full chart, a fifth, an oldest/newest half, or a `Date range` (From/To, UTC, inclusive on both ends). A missing bound is unbounded: `From` only runs to the newest data, `To` only runs from the oldest. Invalid bounds degrade to unbounded; an inverted range is swapped. |
| `OOS Validation` | Validates eligible top survivors on a complementary holdout window where one exists. For `Date range` the holdout is every bar AFTER the `To` date (forward validation); when `To` is unset or at/near the newest data that window is empty, the OOS pass is skipped (server Universe) or verdicts are `inconclusive` — either way the candidate is kept. |

The exact candidate count is strategy-dependent. Do not infer it from
`Runs / Strategy` alone: parameter-space constraints, strategy metadata,
normalization, and mode-specific generation all affect the actual count.

### Ranking

Current Chart uses `Sort By` and `Then By`. Advanced sorting lets the user
chain additional metrics into a priority list.

Symbol Universe has its own `Universe Ranking` controls. The available metrics
include:

- `Robust Universe Score`
- `Window Stability Score`
- `Profitable Active Ratio`
- `Active Symbols`
- `Average Win Rate`
- `Average Expectancy`
- `Average Net Profit`
- `Trade-Weighted Win Rate`
- `Win Reliability Q25`
- `Median Expectancy`
- `Median Expectancy x Total Trades`
- `Median Sharpe Ratio`
- `Median Profit Factor`
- `Median Profit Factor x Total Trades`
- `Median Composite Edge Ratio`
- `Median Exit Alpha`
- `Worst-Symbol Max Drawdown`
- `Median Max Drawdown`
- `Median Return / Drawdown Ratio`
- `Worst Net Profit`
- `Buy & Hold Beat Ratio`
- `Total Trades`

The section toggle turns Universe Ranking off for the next run. Ranking off
submits an empty sort priority instead of a shortened chain:

- the survivor ranker becomes a first-K rotation buffer, so the retention bound
  keeps the first evaluations rather than the highest-scoring ones;
- the terminal inventory keeps evaluation order (an empty priority makes
  `sortFinderUniverseCandidates` a pass-through), so `Run Sort` in the post-run
  `Re-Sort` menu restores evaluation order, and only an explicit Re-Sort metric
  imposes an order;
- `Sort By` / `Then By` are disabled but remembered, so re-enabling ranking
  restores the previous choice.

Both selects are captured at submit; changing them after a run does nothing to
the displayed inventory. Use `Re-Sort` for post-run ordering.

Strategy Quality Audit uses its own quality metrics, including median/average
expectancy, profit factor, average Sharpe, profitable-active ratio, weighted
win rate, total net profit, total trades, active/profitable symbol counts, and
worst drawdown.

### Re-Sort: critical behavior

`Re-Sort` is a post-run operation. It must rank the complete result inventory
retained for the run and apply the display limit only after sorting.

For Symbol Universe the required flow is:

```text
full terminal candidates
        -> sort by selected Re-Sort metric
        -> take Top Results
        -> render result cards
```

It must never be:

```text
full candidates -> take Top Results -> sort the visible prefix
```

The first version makes a candidate outside the initial ranking visible when a
different metric is selected. The second version permanently hides it and was
the source of the Symbol Universe re-sort bug.

Implementation invariants:

- `symbolUniverseRunResults` is the full terminal scalar candidate inventory.
- `latestResults.results` is the display-bounded view.
- `symbolUniverseDisplayLimit` is the current `Top Results` limit.
- Live progress snapshots may be bounded to `Top Results`; they are not the
  authoritative terminal inventory.
- The server terminal `done` event and terminal `/status` snapshot must carry
  the authoritative full candidate inventory needed for re-sort. An inventory
  too large for one JSON string is carried in bounded `terminal_candidates`
  batches (and paged from `/api/finder/terminal-candidates` on reattach)
  instead of being truncated or dropped.
- `Run Sort` restores the run-time order and then reapplies the display limit.
- A re-sort must not mutate or discard the full source needed by a later
  re-sort.
- While idle, the Re-Sort menu follows the selected Scope, even while results
  from a previous scope are retained and hidden. Switching scopes or starting a new
  run resets it to Run Sort; refreshing options within the same scope keeps a
  valid selection. Run start and server reattach refresh the menu before any
  candidates arrive, including Arm Performance previews. Re-Sort and Arm
  display edits never change a hidden inventory belonging to another scope.
- While running or reattached, the submitted job owns the result view and
  Re-Sort metrics. Scope and Reset Settings are disabled until the run ends.
  A browser-restored Scope value is read before submitting a new job, even
  when restoration did not dispatch a change event.
- Reloaded Universe runs request a bounded live preview from the matching
  server job: up to 25 ranked candidates and 200 scalar symbol rows per candidate.
  The list updates with status polls without restarting computation. This
  preview is not the full inventory; terminal adoption still restores every
  retained candidate for post-run re-sort.

Current Chart and Strategy Quality have their own result-retention paths. If a
new scope is added, define explicitly which collection is full and which is
display-only before implementing its re-sort behavior. Asset Opportunity has a
similar full strategy-level pool and can additionally produce one
representative row per normalized symbol for grouped metrics.

### Metric availability

A ranking option is a contract across four places: metric computation, result
types, comparator, and UI availability/presentation. Adding a dropdown option
alone is incomplete.

Symbol Universe computes Median Sharpe even when Sharpe was not the initial
run sort. This is intentional because Median Sharpe is available in the
post-run Re-Sort menu. `--` is valid only when no eligible symbol has a finite
available Sharpe value, for example when a symbol has too few observations for
the Sharpe calculation.

Other expensive or optional metrics may depend on the initial run priority.
Drawdown, Composite Edge Ratio, and Exit Alpha have availability rules in the
Universe runner. If one of these becomes a universal Re-Sort option, either
compute it for every candidate or hide it when the retained result does not
contain valid values. Never silently sort missing values as if they were zero.

The Symbol Universe Re-Sort menu follows that rule: `Median Exit Alpha`,
the drawdown family (`Worst-Symbol Max Drawdown`, `Median Max Drawdown`,
`Median Return / Drawdown Ratio`), and `Median Composite Edge Ratio` are only
offered when the retained inventory carries the measurement
(`medianExitAlpha`/`medianOosExitAlpha` finite, `drawdownMetricsAvailable`, and
a non-zero median Composite Edge Ratio respectively). With Universe Ranking off
none of those metrics is requested by the run, so they are absent from the menu
until a run asks for them.

Metric labels are defined in `lib/finder/constants.ts`; Universe aggregation
is in `lib/finder/finder-universe-metrics.ts`; the candidate fields are in
`lib/types/finder.ts`; the comparator is `sortFinderUniverseCandidates`.

`Buy & Hold Beat Ratio` is always measured, so it is always offered. It is the
share of comparable active symbols whose `netProfitPercent` beat that symbol's
buy-and-hold percent (`lastClose / firstClose - 1`, the same convention as
Batch's `computeBuyAndHoldPct` and its buy-hold alpha). Comparable means the
symbol was active and retained finite positive `firstClose`/`lastClose` plus a
finite `netProfitPercent`; `buyHoldComparableSymbols` and
`buyHoldBeatenSymbols` record the counts behind the ratio. Snapshots persisted
before the metric existed carry no value and sort last, never as zero. The
result card shows it as `B&H beaten/comparable (percent)` next to the
Profitable Active Ratio chip.

## Scope-specific behavior

### Current Chart

Current Chart uses the active symbol, interval, loaded data, selected entry
strategy, and current backtest settings. Its result cards rank parameter sets
for that chart. It remains browser-side.

The normal sort metrics include expectancy, composite edge ratio, entry score,
exit score, exit alpha, profit factor, total trades, max drawdown, Sharpe,
average gain, win rate, and net profit. Exit Alpha is only offered when the
run produced the required value.

The trade-count filter applies to this scope. When enabled, a result must meet
the minimum and maximum trade limits; an empty maximum is unbounded. The
filter is not a substitute for the Symbol Universe filters.

### Symbol Universe

Symbol Universe evaluates the selected entry strategies against the same
universe. Symbols may be entered one per line or comma-separated. The helper
buttons are:

- `Use Current`: use the current symbol.
- `Current + Majors`: use the current symbol plus the configured major set.
- `Local Seeds`: use local seed symbols and switch to daily data.
- `Clear`: remove the universe symbols.

The Universe filters are:

- `Min Active Symbols`: minimum number of symbols with at least one trade.
- `Min Total Trades`: minimum aggregate trade count.
- `Min Profitable Ratio`: minimum profitable-active-symbol ratio.

Each surviving candidate contains scalar aggregate metrics plus a symbol
breakdown. Symbol statuses distinguish profitable, losing, flat, no-trade,
load-failed, and run-failed symbols. Failed symbols are counted uniquely for
the user-facing total even when multiple strategies were selected.

Applying a Universe survivor uses the current chart symbol's retained
in-sample first/last candle as the chart block range before running the
backtest. This preserves the Finder window and indicator initialization,
including for restored results whose original Finder controls are unavailable.
The block remains selected for subsequent Run clicks; clear the block to test
the full history. The comparison is against that symbol's IS row, not its OOS
badge or the universe aggregate. If the current symbol has no retained bounds,
Apply keeps the current chart range and reports that the original window is
unavailable. Identical results also require the same interval, candle data,
capital, and execution settings.

Two aggregates are arithmetic means over the active symbols (symbols with at
least one trade), which makes them deliberately different from their
robust-median counterparts: `Average Net Profit` (`averageNetProfit`) and
`Average Expectancy` (`averageExpectancy`). A single outsized symbol moves an
average while `Worst Net Profit` and the median metrics stay anchored to the
typical symbol, so both are available as sort options. The result card shows
them as the `Avg Exp` and `Avg Net` chips. They are computed for every candidate,
so neither depends on the initial run sort.

Symbol Universe is server-owned. The server performs IS evaluation, merges all
selected strategies, performs optional OOS validation, combines diagnostics,
and publishes the terminal candidate inventory. The browser controls the run,
renders progress, and reattaches after reload. Multi-strategy jobs evaluate
their selected strategies in parallel across a bounded worker pool; results
are released in strategy order so the merged output is identical to the
sequential loop, and `FINDER_UNIVERSE_WORKERS=1` forces the original
in-process loop.

Universe OOS uses a complementary half-window when the IS data slice is
`1/2 oldest` or `1/2 newest`. Fifth-window slices do not have one single
complementary OOS half. A `Date range` IS window validates forward on every
bar after its `To` date. The OOS gate is based on non-negative OOS net profit
and OOS profit factor at least `1.0`; a result with fewer OOS trades than the
minimum trade floor is `inconclusive`, not automatically rejected.


### Asset Opportunity

Asset Opportunity searches each supplied symbol independently for fresh-entry
opportunities. Its specific guide is
[finder-asset-opportunity-resort-guide.md](finder-asset-opportunity-resort-guide.md).

The controls are:

- `Candidate Pool`: number of sampled candidates retained per asset.
- `Min Fresh Support`: minimum support count for grouped opportunity views.
- `Forward Measurement`: `Fixed horizons` or `Next configured exit`.
- `OOS Holdout Bars`: bars reserved for forward validation. In next-exit mode
  this label becomes `OOS Max Wait Bars`.
- `OOS Horizons`: comma-separated fixed forward horizons; any count is honored
  (for example `1,3,5`, `12`, or `12,23`), de-duplicated and applied in
  ascending order. Unparseable tokens are dropped; only an entry with no usable
  horizon at all (blank, `abc`) falls back to the `1,3,5` default, so a run
  never measures horizons the field does not list. A horizon longer than the
  holdout is measured ongoing: the return is taken
  at the last available candle (mark-to-market) and flagged `ongoing` in
  results/archives instead of being discarded. The holdout analyzer keeps the
  main aggregates completed-only — a horizon the sweep has not reached yet
  shows its ongoing mark-to-market in separate `Ongoing n` / `Ongoing avg`
  columns instead of duplicating another horizon's numbers.
- `Forward Horizon Basis` (removed from the UI): every fixed-horizon run
  measures all three price bases in the same pass — `pair` (shown in results),
  `base_only` (BASE long), and `quote_only` (QUOTE short) — because the basis
  never affects candidate search. Leg-only modes measure the selected leg
  independently of the strategy direction and share the pair timeline and
  execution-model entry timing; missing leg horizon timestamps are unavailable.
  Ordinary symbols retain pair measurement only. Analyze a per-basis view with
  `archive/asset opportunity/analyze-asset-opportunity-holdouts-by-basis.bat`
  or the analyzer's `--basis <pair|base_only|quote_only>` flag. The bat asks
  for the calculation mode first: `1` keeps the default per-boundary
  fixed-horizon aggregation whose forward windows overlap, `2` switches the
  summary to non-overlapping rank-1 hold-until-change tenures (`--mode
  hold_until_change`) — the bat skips the top-K prompt in this mode because
  only the rank-1 pick is measured. Each leader is entered the first boundary
  it takes rank 1 and held until the rank-1 pick changes to a different
  symbol. The
  printed summary shows only the entry→exit hold return; when the archive
  stores the 1-bar horizon (set `OOS Horizons` to include 1, for example
  `1, 36, 96`) it is chained from consecutive 1-bar returns. Each 1-bar value
  is measured from the run's entry price, so under next-open entry the chain
  omits the close→open gaps between bars: short holds are near exact, longer
  tenures that span session gaps are approximate, and the chain is exact only
  under signal_close entry. Without the 1-bar horizon the summary reports
  that entry→exit cannot be chained (per-horizon tenure outcomes stay in the
  JSON).
- Reading the basis reports: a synthetic pair is a **ratio** (`close = base /
  quote`), so its forward return is `(1+base)/(1−quote) − 1` and a quote-leg
  collapse amplifies the pair far beyond the sum of the two legs. The analyzer
  therefore prints `Trimmed avg (5%)` (the middle 90% of completed rows) next to
  the average and a `Rows |PnL|>100%` count; when the trimmed average sits far
  below the average, a handful of rows — not the typical row — set it. Its
  `Basis consistency:` line counts completed rows whose pair value disagrees
  with `(1+base)/(1−quote)−1` by more than one point (and how many exceed 100
  points): those rows were measured on different bar aggregation for the pair
  than for the legs, so a basis-by-basis comparison is indicative there, not
  bar-for-bar. Compare medians and trimmed averages when pairing bases.
- `Eval Window Bars`: limit the historical search to the last N bars before
  any holdout gap; `0` means all available bars.
- `Batch OOS Holdout`: run an inclusive holdout range and append archive blocks
  for each holdout value.

Asset Opportunity keeps the current iteration's full scalar strategy-level
rows for re-sort, while the browser normally displays one representative row
per normalized symbol. `FinderResultStore` owns every inventory transition:
`adoptAssetOpportunityResults` (terminal stream done, status recovery,
terminal reattach, latest batch iteration), 
`setAssetOpportunityProvisionalResults` (streamed rows — never persisted,
Run Sort baseline untouched), and `restoreAssetOpportunityResults` (a
reload's saved display view keeps its saved order — never grade-sorted or
re-persisted). The store retains TWO pools: the working order produced by
the re-sort chain and the default-order baseline for Run Sort. Both are
necessary — pairwise metric comparators tie same-symbol rows (capped trades
never consults expectancy; the generic cascade ends at symbol), so the
stable sort makes earlier re-sorts observable through the deduplicated
representative. Do not send or retain candles, signals, trades, or equity
curves merely to implement a post-run sort.

### Arm Performance

New Finder runs calculate **TOP_STABLE_SUPPORT** and **TOP_FRESH_SUPPORT**
alongside the original 15 arms, for both Return and Ranking consistency in
both replay modes. Re-Sort lists all seventeen through the existing arm selector;
cards, filters, contributor exclusion, exports and Apply use the same inventory.
There are no new search dimensions or settings controls.

The same arms are also available under Batch Backtest's TOP_MEAN Coordinator,
including its latest-pick and details selectors, full-window/annual summaries,
copy/download and saved-result recovery. See the
[Batch coordinator guide](batch-backtest-server-side.md#additional-causal-arms).

The two support arms use only the ordinary positive pool (`rawScore > 0`), further
restricted when their own required score is unavailable. A negative or zero
additional score is still eligible. Profit gates never apply to these arms.

#### Additional causal score definitions

Let `B = parseIntervalSeconds(interval)` and `W = 24 * B`. `D[a]` is the
degree of successfully loaded, structurally valid two-leg pair identities
incident to asset `a`, including pairs with no trades. Failed loads, missing
legs and same-asset pairs do not count. Trusted enumeration and duplicate
rules are unchanged. This frozen denominator differs from the active open
position count and from the legacy retained-degree counter, which is unchanged.

| Arm | Highest-first score |
| --- | --- |
| TOP_STABLE_SUPPORT | `integral(C[a,s], s=t-W..t) / W`, where `C=rawScore/D` is a step function changed by every entry and exit. Requires a full elapsed window since the earliest processed score timestamp. |
| TOP_FRESH_SUPPORT | `sum(sign * max(0, 1-(t-entrySec)/W)) / D[a]` over still-open positions. At age `W` a vote expires; its eventual exit cannot remove it twice. |

Stable and fresh support use **elapsed seconds**, including nights and
weekends. They do not count decision events, synthetic empty bars or asset
calendar bars. Pre-window entries and exit-only buckets warm up the state;
only in-window pair-entry buckets emit decisions. Same-time entries and exits
are all applied before scores are captured. Forced `end_of_data` liquidation
keeps the existing interpretation that the vote remains open.

TOP_COVERAGE, TOP_PRICE_STRENGTH and TOP_GRAPH_STRENGTH have been retired.
Their graph solver, graph bookkeeping and separate price-history scoring pass
are removed. Stable and Fresh Support use only reconstructed trade votes and
entry times; target candles are loaded only for execution or outcome measurement.
Causal picks stay frozen before forward inspection; future failures omit the
affected comparison instead of supplying another pick.

Both support arms use the ordinary TOP digest tie break. Ranking stores the actual
score key so numerical score ties retain half credit. The random control uses
each arm's eligible pool and the existing leave-one-out rule. Cooldown applies
before top-K capture, using the existing arm history. K members are
frozen before forward inspection, with no replacement after target failures.

Scalar results include `causalArmDefinitions.version: "finder-causal-arms-v2"`
with the fixed support length, elapsed-time clock and valid loaded degree.
`causalArmDiagnostics` reports eligible candidate observations, zero-degree
and insufficient-support counts. Existing card details and Copy Top Results
expose these values; counts describe candidate observations rather than trades.

Old fifteen-arm results remain readable with their Return/P&L and valid
`top-five-ranking-v2` ranking summaries. Absent additional arms show
**Rerun required**, never zero performance. Present additional data are validated
independently, so a malformed additional metric does not erase valid old arms.
Recovery never fabricates missing zero-event sections. Newly enabled child
runs must provide both support sections, including genuinely calculated zero-event
sections. Historical twenty-arm snapshots drop the three retired arms while
preserving all seventeen retained metrics and their original provenance version.
No persistence-envelope or ranking-semantics version change is needed.
Switch cards also tolerate an absent replay arm: P&L and trade counts stay
unavailable, Apply remains available, and any independently valid ranking
summary is still displayed.

These fixed first-version choices are recorded, not automatically tuned or
claimed optimal. Correct implementation does not establish transfer to a
different pair list. Compare identical fixed configurations on the original
and a separately chosen untouched pair list before interpreting performance
as transferable.


**Measurement** defaults to **Return**. **Ranking consistency** opts into a
fixed forward top-K comparison for every arm, alongside the original replay.
Its **Ranking top K** input (2..5, default 5) chooses how many of each arm's
highest-ranked assets are frozen per decision event before forward inspection;
5 keeps the original `top-five-ranking-v2` semantics, any other depth records
`top-k-ranking-v3` with the exact K in each result, and a section captured at a
different depth than requested is a child contract error, never re-baselined.
K stays fixed for the whole run and changing it requires new runs — results
captured at different depths never display as one another.
Its **Ranking sort** defaults to **Overall ordering**, which ranks configurations
by the lower bound of the mean-accuracy CI95. **Selected asset** instead sorts
descending by the existing #1 superiority point score. Both choices require the
same confidence eligibility (100 scored events, ten populated time blocks and
an available mean-accuracy CI); unavailable values sort last and equal values
use `candidateOrdinal`. The choice is saved locally and sorts the complete retained
inventory before `Top Results`, without running backtests. Return sorting and
the arm selector retain their existing behavior. K distinct
assets must have complete cost-adjusted long returns with matching entry and
exit timestamps. Predictor and outcome ties receive half credit. BOT arms use
their minimum-first preference order and remain hypothetical longs.

Each pair-entry decision is an observation; exit-only updates are excluded.
Membership is frozen before future target inspection, including cooldown from
the existing arm history. Missing, invalid, gapped, censored, mismatched-calendar,
small-pool or unresolved-pick events are skipped without replacement. A changed
effective replay pick also skips its frozen ranking. Every valid completed event,
including overlapping forward windows, contributes to both mean accuracy and
#1 superiority. Each event contributes `K * (K - 1) / 2` equally weighted pair
comparisons (ten at the default K = 5).
The event filter uses **scored ranking events** in both replay modes.

For those same events, **Best asset frequency** is the fraction where the actual
selected #1 has a strictly higher completed return than the other K−1 captured
assets.
**Shared first place** is the fraction where #1 equals the highest return and
at least one other asset ties it. These separate counts divide by `scoredEvents`;
shared first places never count as sole wins. Comparisons use the existing exact
return equality, including when predictor scores were tied. Predictor ties still
receive half credit in accuracy and superiority; they do not prevent a sole
realized first place. Zero scored events show unavailable rates.

Ranking cards and comparison tables lead with the active sort value
(**Ordering CI lower** or **Selected asset sort score**) and **Rank eligibility**.
The sort value uses the same confidence gate as the comparator; unavailable
sort values never hide descriptive point scores. Cards then show **Selected
asset score**, **Best asset frequency**, **Shared first place**, **Overall ordering
accuracy**, and actual replay return/P&L.
Scored events, holding, pending orders, incomplete replay status and Apply stay
outside the measurement panel; completed replay status is omitted. The native
**Measurement details** panel starts expanded and contains the mean-accuracy CI, skipped
counts/reasons, tied comparisons, populated time-block count, width and elapsed
coverage, and existing replay metadata. Durations use readable units such as
`22 days`. The mean-accuracy CI estimates overall ordering accuracy; selecting
the superiority sort does not give that separate point score its own CI.

Ranking notes and Copy Top Results report the requested display horizon,
including when saved measurements use another horizon. Copy output records
each candidate's `storedRankingHorizon` separately; a mismatch remains
unavailable and requires a new run rather than reinterpreting saved scores.

Mean accuracy remains visible with any scored events. Sortable confidence
requires **at least 100 scored events AND at least ten populated time blocks**.
Event counts and the ten comparisons within an event are not independent-sample
counts. The deterministic time-block bootstrap uses this exact duration rule:

1. Use normalized target entry and exit candle-open timestamps in Unix seconds.
   For each completed measurement, define `D_i = exitOpen - entryOpen + B_i`.
   `B_i` is the replay interval parsed by `parseIntervalSeconds`; adding it
   includes the final candle. Observed elapsed time includes nights, weekends,
   holidays and other irregular calendar spacing. If the interval is unavailable
   and `H > 1`, infer `B_i = (exitOpen - entryOpen) / (H - 1)`; this may
   conservatively include calendar closures in the inferred final candle.
2. Set `D = max(D_i)` across this arm's scored windows and initial block width
   `W = 2 * D`. Anchor half-open elapsed-time bins at the earliest scored entry
   `A`: event entries in `[A + k*W, A + (k+1)*W)` belong to the same block.
   An entry exactly at a boundary belongs to the next bin. Empty bins are
   omitted and never count toward the ten-block requirement. Block sizes can
   differ; blocks are never formed from fixed event counts.
3. Resample all `K` populated blocks with replacement, drawing `K` whole blocks
   per replicate. Pool their accuracy sums and event counts, then divide the
   sum by the count. Use the existing deterministic seed/LCG and **10,000**
   draws; report the 2.5th and 97.5th percentile bounds. This estimates the same
   all-valid-event mean shown on the card, rather than an equal-block mean.

For `H = 1`, entry and exit have the same candle-open timestamp, but the window
still covers one full parsed interval: `D_i = B_i`, not zero seconds. If no
valid interval is available for that one-bar measurement, means remain visible
but time-block metadata and confidence are unavailable. Finder supplies the
captured interval. Elapsed coverage is the latest measured candle end minus
the earliest scored entry; it can include empty calendar stretches, so populated
block count is shown separately.

Time blocks preserve neighboring observations within each bin, including their
shared price data. Overlapping windows can cross bin boundaries; this finite
block approximation does not remove all dependence. The internal block helper
also supports longer widths (including `2*W`) for deterministic sensitivity
checks without adding a user setting. Longer widths can reduce populated blocks
below ten; they do not necessarily produce wider bounds. A single unusually
long valid calendar window can conservatively enlarge all blocks and suppress
confidence. Bounds are null when either count requirement or duration coverage
is unavailable, and unavailable scores sort last.

A 50% score is a no-information reference, not a probability of luck. These
exploratory intervals do not correct for searching configurations or eliminate
market dependence. Profit look-ahead arms retain their research labels. Compare
finalists on a separately chosen later window with configuration, universe and
horizon frozen; Finder does not add automatic OOS validation for this scope.

Ranking reuses the saved horizon input. It stays enabled in switch mode while
ranking is selected: a switch after seven bars or a 50-bar hold still measures
the full selected horizon (for example 20 bars). Trading follows the original
switch path, and ranking-data failures do not change trading status or P&L.
**Exclude top contributor** is disabled for ranking while retaining its saved
Return preference. Re-Sort changes arm, measurement or ranking sort locally using the full
inventory; unavailable intervals sort last with stable candidate-order ties.
The current measurement semantics are `top-five-ranking-v2` at the default
capture depth and `top-k-ranking-v3` (recording its exact `topK`) at any other
depth. Older v1 ranking
summaries require a rerun because both their scoring sample and bootstrap changed;
their original return/P&L results survive. First-place counts/rates are additive
fields within v2, with no measurement or persistence-envelope version bump.
Older v2 summaries retain their accuracy, superiority, confidence and return/P&L;
only the new frequencies show unavailable with a rerun message when their source
counts are absent or malformed. An older Return-only run, unsupported
ranking semantics, or a different ranking
horizon shows **Rerun required**. Copy Configuration uses the frozen run context;
Copy Top Results identifies the current display measurement and ranking sort,
first-place frequency availability, scored-event filter,
frozen measurement horizon, availability and scalar summaries. Reload recovers
measurements through the existing compact checkpoint and server inventory,
and restores the saved local sort preference. Copy Configuration includes the
ranking sort captured at run submission; later local changes are recorded by
Copy Top Results without changing that frozen configuration.
Apply continues to copy only strategy/backtest settings.

Arm Performance reuses Finder's selected strategies, Grid Sweep or Random
Search, Runs / Strategy budget, risk controls, optional exit-strategy sampling,
Run / Stop, result cards, Apply, and copy actions. Enter one supported local
synthetic pair per line (or comma-separated), select an interval and one
replay mode, then run. Fixed horizon mode also requires one positive replay
horizon. The server accepts 1–5,000 pairs and rejects
blank lists, single symbols, duplicate resolved pairs, provider conflicts,
unsupported built-in strategies, and requests above its validated search
limits. Pairs with missing local leg data are skipped, and the run reports how
many were skipped. At least one pair must have usable data. A blank pair list
requires an explicit pair list and has no bundled default universe.

If a pair passes preflight but its candles are missing or too short when a
candidate runs, that pair is skipped for that candidate and the remaining
pairs are still evaluated. Backtest execution errors remain fatal. Copy
Diagnostics includes runtime pair-load failures and per-candidate pair and
replay coverage counts. If every pair fails to load for a candidate, it cannot
be scored; the run stops with the pair failures available in Copy Diagnostics.

Completed, failed, and stopped candidate timing diagnostics are also retained
in the server's per-run JSONL log before child artifacts are deleted; see
[Arm Performance server diagnostics](finder-server-side.md#arm-performance).
**Copy Diagnostics** is available as soon as an Arm run is submitted, including
before its first completed candidate and after browser reattachment. It copies
a compact speed report: frozen configuration counts, progress, server memory,
phase/worker/cache totals, the current child, and at most five slow candidates.
It omits the full pair list and arm result tables. Live timings can be partial;
the report labels summed worker time, overlapping replay time, and sampled
engine phases. If the server is unavailable, copying still returns a bounded
browser snapshot with a message that server timings are unavailable.
Unreadable completed backtest shards fail the run rather than silently
reducing replay coverage.

Each configuration runs through TOP_MEAN over the same ordered pairs and
returns compact summaries for all 17 arms. There is no arm selector before the
run. `Re-Sort` sorts the complete retained configuration inventory locally,
then applies `Top Results`; it does not launch pair backtests or rank individual
pairs. `Run Sort` restores the default `TOP_RAW_PROFIT_NOW` order. Equal values
keep candidate order and unavailable arms sort last. Grid and Random are
supported. Genetic search, fifth/half data slices, OOS gates, and chart trade
filters are disabled for this scope.

In Fixed horizon mode, the sort value is the selected arm's **mean forward
return** (`topMean`) at the chosen horizon. It is an equal-event research
statistic, not compounded account P&L: events may overlap and do not model
position sizing or a shared capital limit. The card also shows the comparison
mean, eligible event count, pair coverage, and `deltaMed CI95`. `delta` is the
median paired excess return;
the interval estimates that median, not `topMean`, and it does not correct for
searching many configurations. Each configuration is measured on its own
eligible event dates, so comparisons are not matched-event experiments. No
minimum event threshold is applied; zero-event or missing means are shown as
unavailable.

The Arm Performance controls can change the displayed inventory without
rerunning pair backtests:

- **Exclude top contributor** switches ranking and cards to an adjusted
  summary for every arm. In Fixed horizon mode, it finds the asset with the
  largest sum of paired excess returns, removes that asset's selected events,
  and rebuilds the comparison and bootstrap interval. In switch mode, it finds
  the asset with the largest cumulative net P&L per arm (closed trades plus
  that asset's terminal open mark, if held) and subtracts that contribution
  from total, realized, and open P&L. The switch path itself is unchanged, so
  this is a concentration sensitivity calculation rather than a counterfactual
  replay, blacklist, or calibrated confidence test. Ties use asset-name order;
  the highest contribution is excluded even if every asset's total is
  negative. Raw and adjusted summaries remain in the result; older snapshots
  without adjusted values show them as unavailable and need a rerun.
- **Completed count filter** uses comparison-event counts in Fixed horizon mode
  and completed-trade counts in switch mode. Minimum and optional maximum are
  inclusive; an empty maximum means unlimited. The order is basis, filter,
  sort, then Top Results. The compact full candidate inventory stays available,
  so changing arms or thresholds restores filtered rows without another run. Pair coverage
  remains the actual run count.
- **Block repeat asset selection** (Fixed horizon only) applies during the
  replay and therefore requires a new run. It keeps separate cooldown state
  per configuration, replay window, and selector arm. The bar count uses the selected target's
  candles, including candles with no selection event: a selection at index 100
  with a 5-bar cooldown blocks through 105 and permits selection again at 106.
  A blocked rank falls through to the next eligible asset. A singleton can
  still be selected and start cooldown, but cannot form a paired comparison or
  count as a completed event. The maximum accepted cooldown is 10,000 bars.

Fixed horizon cards and copied top-result metadata name the active basis,
selected arm, completed events, excluded contributor when available, event
filter, and the cooldown used by the run. Changing cooldown in the controls
does not alter an existing result. Apply continues to use only the candidate's
saved strategy and backtest settings; replay scoring controls are not applied
to the chart.

**Replay mode** defaults to **Fixed horizon**. **Hold until asset changes**
runs a separate, path-dependent simulation for each of the 17 arms. Each arm
starts flat and holds one long target-asset position. BOT arms still choose
from their existing bottom-ranked candidates; they do not open short trades.
The first unique pick enters at the target's next open strictly after the
decision. Repeating the held asset leaves the position and costs unchanged.
A pick of another asset schedules a sale at the held asset's next open and then
a purchase at the replacement's first open at or after the sale. The two
positions never overlap. Ranked arms use the existing deterministic selector
tie-break, so a tied best score still produces a pick. The unique-only
TOP_MEAN_RAW_UNIQUE arm and tied BOT extrema can remain unresolved; an
unresolved tie or no pick holds the actual position, or keeps the arm flat,
and cancels any outstanding switch. A one-candidate pool can make a pick. The
pair-entry decision clock is retained, so score changes at exit-only timestamps
do not place orders.

Switch mode uses a fixed $1,000 entry notional for every trade, without
compounding. This is normalized research P&L, not a shared or self-financing
account; each arm is independent, and fees are additional costs. Closed-trade
net P&L includes entry and exit commission and slippage through the fill
prices. Open-position P&L includes entry costs and uses the last fully closed
target candle at or before the requested end and frozen run cutoff, without a
hypothetical exit fee. Cards rank total net P&L in USD (realized plus the open
mark). An entered arm with no closed trades remains rankable; a never-entered
or incomplete arm is unavailable. Cards and Copy Top Results show total,
realized, and open P&L, completed trades, costs, current holding, and pending
order separately. The optional count filter then means **completed trades**.
Pending switch text names the held asset being sold and the intended purchase
separately (for example, "Pending sell AMAT, then buy GEV"). A pending buy
while flat names only its destination; any scheduled timestamp applies to the
next pending action.
Re-Sort uses the completed result's mode even if the live control has changed.
Switch-mode total, realized, and open P&L values are green when positive and red
when negative.

Switch Return mode disables the horizon and cooldown controls while retaining their
saved horizon-mode values. Contributor exclusion remains available as a
display-side sensitivity for completed switch results. A mode change requires
a new run; it never reinterprets completed results. Both modes persist through
Finder settings and bounded result snapshots;
legacy mode-less results are read as fixed horizon, and unknown future modes
are not treated as horizon results. Copy output identifies the switch
semantics and its $1,000 long-only sizing.

Each run starts flat inside its effective date window. The frozen evaluation
cutoff bounds both fills and the terminal mark; a pre-window selection does
not create a position. Switch-mode fills can use a candle's open when its
timestamp is at or before the cutoff, even if that candle is not fully closed;
terminal marks still use only fully closed candles. Target timestamps are normalized before execution. A
missing target series, invalid or non-monotonic timestamps, invalid required
prices, a holding or order spanning a data gap over 30 days, or a terminal
mark older than 30 days makes that arm incomplete and unrankable. Shorter
calendar gaps are allowed without interpolation. A healthy series with no
next open before the cutoff leaves a pending order; a pending buy that waits
through a gap over 30 days makes the arm incomplete. An open position is
marked rather than fabricated into a closing trade. `TOP_RAW_PROFIT` and
`TOP_MEAN_PROFIT` remain labeled **LOOK-AHEAD RESEARCH** because their existing
selection pools depend on full-window pair profit.

`TOP_RAW_PROFIT` and `TOP_MEAN_PROFIT` use a full-window pair-profit gate that
is known only after the backtest. They are labeled **LOOK-AHEAD RESEARCH** and
must not be treated as live signals. BOT arms keep TOP_MEAN's existing long
return calculation; they are not inverted short returns.

Apply restores the candidate's stored normalized parameters and resolved
backtest settings, along with the run's interval and capital settings, then
runs the normal backtest on the current chart. That chart rerun is separate
from the pair-universe replay. If an older cached preview has no retained run
context, Apply uses the candidate settings, its saved interval when available,
and the current capital settings. Copy Configuration uses the frozen run
context; Copy Top Results includes the selected arm, all arm metrics, exact
candidate settings, and the shared run id. A cached localStorage snapshot is a
bounded preview: Re-Sort ranks the candidates currently available, while
unseen candidates may rank higher until the full server inventory is restored.
During a running sweep, the browser refreshes this preview periodically and
keeps it visible after reload while status polling waits for the full terminal
inventory.

The evaluation cutoff is fixed for every configuration so later candidates do
not gain newly closed candles or newly matured outcomes. It does not freeze
historical files: corrections or replacement during a long sweep can still
change later data reads. For reproducibility, use fixed local datasets and
compare a candidate with a standalone TOP_MEAN run using the same pairs,
settings, horizon, date window, and cutoff. Cost grows with configurations ×
pairs; a 30-configuration run across 2,000 pairs performs 60,000 pair
backtests. For large server runs, use
`NODE_OPTIONS=--max-old-space-size=16384` or higher and a small configuration
budget.

### Strategy Quality Audit

Quality Audit runs normalized default parameters once per selected strategy and
symbol. It is for baseline library review, not parameter discovery. Its OOS
output is informational and does not filter a library. The normal trade-count
filter and parameter-search controls that do not apply to this scope must stay
disabled or ignored.

## Risk and exit settings

### Risk Management

`Freeze Finder risk management` keeps the current risk settings fixed. Finder
then searches strategy parameters only, and applying a result does not replace
the frozen risk settings.

### Exit Strategy Override

`Exit Strategy Override` requires Disable Exit Signal plus a configured exit
strategy override. When enabled, Finder samples exit strategies from the
checked list and varies their parameters with the entry parameters. Applying a
result writes both entry and exit strategy settings.

Sampled-exit candidate construction has one owner:
`buildFinderCandidatePlans` in `lib/finder/finder-candidate-plans.ts`. It
builds entry defaults, normalizes and deduplicates entry sets, lazily
generates and caches exit sets per exit key, falls back to copied exit
defaults when a generator returns none, draws the exit strategy and parameter
set, and prefixes exit parameters with `_exit__`. All three scopes call it:
the current chart passes one run-scoped `randomFn` and `exitParamSetsByKey`
so the draw sequence continues across entry strategies and exit sets are
generated once per run; Universe and Arm omit the overrides and get a fresh
RNG and cache per call (per entry strategy). Current chart then groups the
returned plans by exit key in first-seen order for execution; Arm adds
candidate ordinals. `tests/finder-candidate-plans.spec.ts` pins the seeded
draw sequences, lifetimes, and grouping. Asset Opportunity keeps its separate
index-modulo sampler; it is not equivalent to this random sampler.

Any change to exit parameter generation must preserve normalized parameters and
the TypeScript/Rust execution contract. Validate long, short, combined, signal
close, and next-open/next-close behavior when the change affects fills or exit
timing.

## Server-owned execution contract

The deep server lifecycle is documented in
[finder-server-side.md](finder-server-side.md). The following invariants are
the short version needed when changing the menu or its client/server wiring.

### Symbol Universe routes

- `POST /api/finder/universe-run` starts one job containing all selected entry
  strategy keys and a browser-generated `runId`.
- `GET /api/finder/status?runId=...` reports progress or the retained terminal
  snapshot for reattachment.
- `GET /api/finder/terminal-candidates?runId=...&offset=&limit=` pages a
  terminal inventory that was too large to inline in one JSON response.
- `POST /api/finder/stop` stops only the active matching `runId`.
- `POST /api/finder/invalidate-cache` clears or defers dataset-cache invalidation
  at a safe run boundary.

Finder routes are local-only and use the shared loopback/bearer authorization
policy. A Vite server exposed through a host flag, tunnel, or reverse proxy
must not become a remote CPU-heavy job launcher or result endpoint.

The browser persists the active run before issuing `fetch`. Every stream and
poll callback checks the active run id before mutating UI state. A disconnected
stream does not imply cancellation; a reload may reattach while the same Vite
process is alive. Stop is run-id scoped, including the Stop-before-ownership
race.

A server-owned job must cancel on BOTH stop signals: the run's abort request and
the ownership loss caused by a newer run. Ownership is deliberately retained by
a stopped job until its own teardown, so a phase that checks only ownership
keeps evaluating after Stop. Single-strategy Symbol Universe jobs, which run
through the sequential in-process strategy loop, and the post-strategy OOS pass
both depend on this rule; see
[the server guide](finder-server-side.md#runtime-contract).

Stop responses are also scoped in the browser: confirmation clears only the
matching persisted run record, and a delayed failure cannot replace a newer
run's status, even after that newer run completes.

### Wire and retention rules

- Finder server events and terminal candidates are scalar-only. Do not send
  `data`, `signals`, `trades`, or `equityCurve` arrays over the wire.
- Symbol-level scalar metrics may remain in the candidate's symbol breakdown;
  this is not permission to attach raw backtest arrays.
- Live progress is bounded for responsiveness and memory.
- The terminal Symbol Universe snapshot is authoritative and retains the full
  scalar inventory required by Re-Sort.
- That inventory may be too large for one JSON string (V8 caps a string at
  ~536MB). It then arrives as bounded `terminal_candidates` batches before
  `done`, and `/status` withholds it so the browser can page it back on
  reattach. Re-Sort still ranks the complete inventory; only the transport is
  chunked. See the terminal inventory transport rules in
  [Finder server guide](finder-server-side.md#terminal-inventory-transport-v8-single-string-limit).
- `GET /api/finder/terminal-candidates` is budgeted by BYTES, not rows: a
  candidate carries one IS+OOS scalar row per symbol, so a 200-row page over a
  several-hundred-symbol universe is 100+ MB of JSON that serializes for tens of
  seconds and then dies in the browser's response-body stream. Callers advance by
  the returned `candidates.length`, never by the requested `limit`. A page that
  still fails is retried, then ends the paging loop with a partial inventory — a
  completed run is never reported as failed because one page did not arrive.
- The server job dataset cache is per-job and cleared in the job `finally`
  path. Failed or empty loads remain retryable. In the parallel strategy
  sweep each worker keeps a private per-job cache (one dataset copy per
  worker); do not share or evict worker caches mid-job.
- The Finder server loader reuses the shared batch dataset-loader core. Do not
  fork a second synthetic-pair or gap-fill pipeline.
- Synthetic pair ratios must be built from the seed interval before aggregation;
  do not replace seed data with pre-aggregated leg extremes.

The server threads the browser's Rust-engine preference into the Node path.
Engine eligibility is still decided by the backtest executor; a preference is
not proof that Rust was used. Preserve this field when changing the request
body or server runner.

Daily entry-time filters still require TypeScript, but are supported by its
single-position Finder fast path. The filter gates entries at the actual fill
bar and leaves exits unrestricted. Eligible runs retain the indexed signal
preparation and typed Sharpe buffer even with `day_open` or `day_close` enabled.

For a repeatable local comparison, run
`npm exec -- esno scripts/bench-finder-entry-time.ts <configuration.json> <label> [symbolCount]`.
This benchmarks 4h Symbol Universe with a fixed random seed, discards one warmup,
then records three runs and candidate-result hashes under
`artifacts/finder-entry-time-bench/`. It uses the captured exit override; copied
UI configurations do not include the checked list of sampled exit strategies,
so it cannot reconstruct that part of a historical random run. Compare hashes
as well as durations, on unchanged local histories and an idle machine.

For large server-owned runs, use the documented Node heap budget, for example:

```powershell
$env:NODE_OPTIONS = "--max-old-space-size=16384"
npm run dev
```

The full terminal inventory is intentional for correct re-sort, so increasing
the heap does not justify retaining raw datasets or trade arrays after they
are no longer needed.

## Data and backtest semantics

Finder accepts Unix seconds, Unix milliseconds, ISO strings, and
`BusinessDay`-style times through the repository's existing normalization
helpers. Reuse `timeKey`, `timeToNumber`, and existing data-loader helpers;
do not add a Finder-only time conversion.

The normal local data order is local SQLite API, IndexedDB cache, bundled
`price-data`, then remote fetch where enabled. A Finder change must not bypass
the cache or silently change the selected interval.

IBKR fallback loads prefer valid imports and seed CSVs before persisted
caches; server CSV loaders retain their mtime freshness checks. See
[price-data contracts](price-data.md) for the provider-specific rules.

Backtest settings are part of Finder's result meaning. Candidates resolve ONE
canonical `BacktestSettings` object through `resolveFinderRiskOverrides` in
`lib/finder/finder-runner-core.ts`; there is no candidate-level Rust mirror.
The Rust request projection for each batch item is derived only at submission
packing (`projectRustBatchItemSettings` inside
`dispatchRustBatchWithFallback`): exactly the eligible ATR-period and enabled
percentage SL/TP candidate overrides are copied onto the sanitized run base,
and candidates without a projected difference share the run-level object. If
a setting is not supported by Rust, strip it consistently in both
`lib/backtest-service.ts` and `lib/finder-manager.ts`. If a setting changes
entry timing, fills, exits, drawdown, or Sharpe, check the browser and server
paths together.

## Source map

The browser manager is decomposed into cohesive collaborators under
`lib/finder/browser/`; `lib/finder-manager.ts` is the composition point and
public facade (construction, `init`, and public delegation) and owns no
mutable state of its own beyond the retained run context
(`lastFinderRunBacktestSettings`, `lastFinderOptions`,
`lastFinderEvaluationData`) and the latest diagnostics.

| Task / change | Owner | Focused tests |
| --- | --- | --- |
| Persisted settings shape, defaults, normalizers | `lib/finder/browser/finder-settings.ts` | `tests/finder-settings-persistence.spec.ts` |
| Storage envelopes (UI state, results snapshot, active server run) | `lib/finder/browser/finder-persistence.ts` | `tests/finder-settings-persistence.spec.ts`, `tests/finder-result-snapshot.spec.ts` |
| Copy payloads (top results, run configuration, Arm/Asset diagnostics), clipboard | `lib/finder/browser/finder-export.ts` | `tests/finder-export-diagnostics.spec.ts`, `tests/finder-config-capture.spec.ts` |
| Failure/fallback/quality diagnostics builders, engine-mode label | `lib/finder/browser/finder-run-diagnostics.ts` | `tests/finder-export-diagnostics.spec.ts`, `tests/finder-diagnostics.spec.ts` |
| Result inventories, display limits, re-sort and Run Sort restoration, Arm run/apply context | `lib/finder/browser/finder-result-store.ts` — owns every Asset Opportunity inventory transition (adopt/provisional/restore); Arm default views are derived from the full inventory under the current display filter (`TOP_RAW_PROFIT_NOW` + filter); there is no cached default array | `tests/finder-result-store.spec.ts`, `tests/finder-manager-lifecycle.browser.spec.ts`, `tests/finder-asset-opportunity-all-resorts.spec.ts` |
| Candidate Apply flows, apply-in-flight guard, backtest-settings merge | `lib/finder/browser/finder-result-actions.ts` | `tests/finder-selection-apply.browser.spec.ts`, `tests/finder-arm-performance-settings.spec.ts` |
| Strategy selection sets, toggle maps, filter/range/bulk selection | `lib/finder/browser/finder-strategy-selection.ts` | `tests/finder-selection-apply.browser.spec.ts` |
| Server run ownership, scoped Stop, one shared owned-run poll loop (reattach + recovery) | `lib/finder/browser/finder-server-session.ts` | `tests/finder-manager-lifecycle.browser.spec.ts` |
| Scope workflows (current chart, universe, asset single/batch, arm, quality) | `lib/finder/browser/workflows/*` | `tests/finder-manager-lifecycle.browser.spec.ts`, `tests/finder-asset-opportunity-stream.spec.ts` |
| Form binding/capture, `readOptions`, scope visibility, sorting controls, reset | `lib/finder/browser/finder-controls.ts` — shared private readers keep each identical DOM conversion in one place for capture and submission; intentional differences (capture-only bounds caps, text maxima, trade/cooldown gating, scope mode gates) stay explicit at their own call sites. Run submission calls `readOptions` only; capture runs on input events and Copy Configuration | `tests/feature-dom-contracts.spec.ts`, `tests/finder-settings-persistence.spec.ts`, `tests/finder-manager-lifecycle.browser.spec.ts` |
| Browser run lifecycle flags, `runFinder` dispatch, Run/Stop wiring | `lib/finder/browser/finder-run-controller.ts` | `tests/finder-manager-lifecycle.browser.spec.ts` |
| Facade: construction, `init`, public accessors, render dispatch | `lib/finder-manager.ts` | `tests/finder-manager-lifecycle.browser.spec.ts` |

| Area | Main files |
| --- | --- |
| Menu markup | `html-partials/tab-finder.html` |
| Finder facade | `lib/finder-manager.ts` |
| DOM ids and required-element contracts | `lib/finder/finder-manager-dom.ts`, `lib/finder/finder-ui-dom.ts` |
| Option normalization and data/OOS slices | `lib/finder/finder-manager-logic.ts` |
| Browser UI rendering | `lib/finder/finder-ui.ts` |
| Finder labels and metric inventories | `lib/finder/constants.ts` |
| Universe execution | `lib/finder/finder-runner-universe.ts` |
| Universe metric aggregation/comparison | `lib/finder/finder-universe-metrics.ts` |
| Universe OOS | `lib/finder/finder-universe-oos.ts` |
| Universe parallel strategy sweep (pool + worker) | `lib/finder/server/finder-universe-strategy-pool.ts`, `lib/finder/server/finder-universe-strategy-worker.ts` |
| Finder result types | `lib/types/finder.ts` |
| Server routes and job lifecycle | `lib/finder/server/finder-vite-plugin.ts` |
| Server wire types and scalar stripping | `lib/finder/server/finder-stream-types.ts` |
| Server data loading | `lib/finder/server/server-finder-data-loader.ts` |
| Shared batch/Finder dataset core | `lib/batch-backtest/batch-dataset-loader-core.ts` |

## Safe-change checklist

Before changing Finder:

1. Read this document and [finder-server-side.md](finder-server-side.md).
2. Check `git status --short` and preserve unrelated work.
3. Read the immediate caller, result type, comparator, and loader before
   editing.
4. Decide whether the change affects Current Chart, Symbol Universe, Asset
   Opportunity, Quality Audit, or more than one scope.

For a UI/control change:

- update the HTML partial, feature-local DOM contract, manager wiring, and
  persisted state/defaults together;
- run `npm run typecheck` and the feature DOM contract test.

For a metric or Re-Sort change:

- define the metric's source fields, units, direction, invalid-value policy,
  tie behavior, and availability rule;
- update computation, type, label, comparator, presentation/copy output, and
  tests;
- prove that the full result pool remains available after the run and that
  `Top Results` is applied only after sorting;
- add a regression test that would fail if a candidate outside the initial
  top-N became permanently invisible.

For a Symbol Universe server change:

- preserve run-id ownership, Stop, reload reattach, local authorization,
  terminal failure visibility, scalar-only events, and full terminal inventory;
- preserve server/browser loader parity and Rust preference propagation;
- preserve parallel-sweep ordered release and sequential/parallel parity; keep
  `FINDER_UNIVERSE_WORKERS=1` as the sequential rollback path.

Recommended validation commands:

```powershell
npm run typecheck
npm run typecheck:tests
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-universe-parallel.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-date-range.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-manager-lifecycle.browser.spec.ts
..\..\..\node_modules\.bin\esno tests\finder-universe-oos.spec.ts
npm test
```

For a UI change, manually confirm the relevant scope, Run/Stop state,
result-card rendering, Apply, Copy actions, and Re-Sort. For a server-owned
run, also confirm reload reattach, scoped Stop, a terminal failure snapshot,
and a second Re-Sort that promotes a candidate outside the initial display
prefix.
