# Strategy Finder

This is the maintained reference for the Finder menu. Read it before changing
Finder controls, ranking metrics, result retention, server routes, or the
backtest path used by Finder.

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
contributor-exclusion basis. Parameters, all remaining metrics, and existing
lazy symbol/measurement breakdowns are available under Parameters & details.
OOS verdict badges and incomplete replay status remain visible in the table.

Apply uses the same candidate index and guards in both views; quality audits
remain read only, and cached-preview Apply restrictions remain in place.
Re-Sort continues to rank the retained inventory before Top Results limits
the rendered rows. Table mode does not add a second sorting path or start a
run. On narrow screens only the table's region scrolls horizontally. View
and disclosure choices last for the mounted Finder session and are not saved;
search settings retain their existing persistence behavior.

Arm Performance display edits coalesce into one update per animation frame.
Duplicate events skip sorting and rendering when the inventory, display limit,
selected arm, and filter are unchanged. The default arm reuses its sorted
inventory. Display snapshots debounce for 300 ms and flush on pagehide;
terminal results still persist immediately, and starting a new run discards
pending checkpoints from the previous run.

### Search controls

| Control | Meaning |
| --- | --- |
| `Top Results` | Number of result cards rendered. In Symbol Universe this is a display limit, not the size of the terminal ranking inventory. |
| `Runs / Strategy` | Candidate evaluations per selected strategy, subject to the selected search mode. |
| `Search Mode` | `Grid Sweep`, `Random Search`, or `Genetic Search`. Server-owned Asset Opportunity currently requires random mode. |
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
- `Total Trades`

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
  the authoritative full candidate inventory needed for re-sort.
- `Run Sort` restores the run-time order and then reapplies the display limit.
- A re-sort must not mutate or discard the full source needed by a later
  re-sort.

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

Metric labels are defined in `lib/finder/constants.ts`; Universe aggregation
is in `lib/finder/finder-universe-metrics.ts`; the candidate fields are in
`lib/types/finder.ts`; the comparator is `sortFinderUniverseCandidates`.

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
- `OOS Horizons`: comma-separated fixed forward horizons, normally `1,3,5`.
- `Eval Window Bars`: limit the historical search to the last N bars before
  any holdout gap; `0` means all available bars.
- `Batch OOS Holdout`: run an inclusive holdout range and append archive blocks
  for each holdout value.

Asset Opportunity keeps the current iteration's full scalar strategy-level
rows for re-sort, while the browser normally displays one representative row
per normalized symbol. Do not send or retain candles, signals, trades, or
equity curves merely to implement a post-run sort.

### Arm Performance

New Finder runs calculate **TOP_COVERAGE**, **TOP_STABLE_SUPPORT**,
**TOP_FRESH_SUPPORT**, **TOP_PRICE_STRENGTH**, and **TOP_GRAPH_STRENGTH**
alongside the original 15 arms, for both Return and Ranking consistency in
both replay modes. Re-Sort lists all twenty through the existing arm selector;
cards, filters, contributor exclusion, exports and Apply use the same inventory.
There are no new search dimensions or settings controls.

The same arms are also available under Batch Backtest's TOP_MEAN Coordinator,
including its latest-pick and details selectors, full-window/annual summaries,
copy/download and saved-result recovery. See the
[Batch coordinator guide](batch-backtest-server-side.md#additional-causal-arms).

The five arms use only the ordinary positive pool (`rawScore > 0`), further
restricted when their own required score is unavailable. A negative or zero
additional score is still eligible. Profit gates never apply to these arms;
price strength does not search the entire asset catalog.

#### Additional causal score definitions

Let `B = parseIntervalSeconds(interval)` and `W = 24 * B`. `D[a]` is the
degree of successfully loaded, structurally valid two-leg pair identities
incident to asset `a`, including pairs with no trades. Failed loads, missing
legs and same-asset pairs do not count. Trusted enumeration and duplicate
rules are unchanged. This frozen denominator differs from the active open
position count and from the legacy retained-degree counter, which is unchanged.

| Arm | Highest-first score |
| --- | --- |
| TOP_COVERAGE | `rawScore[a,t] / D[a]`. Zero degree is unavailable. Signed overlapping trade votes are preserved; coverage is not clamped to `[-1,1]`. |
| TOP_STABLE_SUPPORT | `integral(C[a,s], s=t-W..t) / W`, where `C=rawScore/D` is a step function changed by every entry and exit. Requires a full elapsed window since the earliest processed score timestamp. |
| TOP_FRESH_SUPPORT | `sum(sign * max(0, 1-(t-entrySec)/W)) / D[a]` over still-open positions. At age `W` a vote expires; its eventual exit cannot remove it twice. |
| TOP_PRICE_STRENGTH | From the last 25 completed, finite, positive target closes, form 24 log returns `r`. Score is `sum(r)/(sqrt(24)*max(populationStdDev(r),1e-8))`. Flat closes score zero. |
| TOP_GRAPH_STRENGTH | Least-squares strengths fitting `s[A]-s[B] = netSignedBaseVotes/openPositionCount` with one equally weighted edge per active retained pair identity. Strengths are centered within the selected component. |

Stable and fresh support use **elapsed seconds**, including nights and
weekends. They do not count decision events, synthetic empty bars or asset
calendar bars. Pre-window entries and exit-only buckets warm up the state;
only in-window pair-entry buckets emit decisions. Same-time entries and exits
are all applied before scores are captured. Forced `end_of_data` liquidation
keeps the existing interpretation that the vote remains open.

Price strength uses actual completed target bars. A close is known only when
`candleOpenSec + B <= decisionSec`, also bounded by the frozen evaluation
cutoff. Insufficient history, invalid/nonmonotonic/duplicate timestamps,
nonpositive or nonfinite required closes, stale history and lookback gaps make
only that asset's price score unavailable. Gap and staleness checks use the
existing candle-gap/calendar policy (the 30-day large-gap threshold); ordinary
market closures are allowed. Supported time shapes are normalized with
`timeToNumber`. Future closes and forward returns never form a price score or
pick. Causal picks and their eligible pools are frozen before forward inspection;
future failures omit the affected comparison instead of supplying another pick.

The graph fit includes both positive and negative assets, but ranks only
ordinary positive candidates in the selected active component. Inactive pairs
provide no edges. Overlapping long and short positions are netted into the
pair comparison, with opposite orientations reversed consistently. A zero-net
active pair remains an edge. For disconnected graphs, use the component with
the most vertices; size ties choose the lexicographically smallest sorted
normalized asset-name list. Independently centered components are never
compared. Excluded candidates are counted.

The deterministic sparse Laplacian solver anchors the lexicographically first
vertex, uses relative residual tolerance `1e-10` and at most 500 iterations,
then centers and rounds final ranking keys to `1e-8`. A zero right-hand side
is exactly zero. Solver nonconvergence or nonfinite output makes the graph
score unavailable at that event, with an explicit failure count. It never
falls back to TOP_RAW. In switch mode, a no-pick decision holds the current
asset and clears pending orders under the existing execution rules.

All five use the ordinary TOP digest tie break. Ranking stores the actual
score key so numerical score ties retain half credit. The random control uses
each arm's eligible pool and the existing leave-one-out rule. Cooldown applies
before top-five capture, using the existing arm history. Five members are
frozen before forward inspection, with no replacement after target failures.

Scalar results include `causalArmDefinitions.version: "finder-causal-arms-v1"`
and the fixed lengths, volatility floor, solver rules and clock definitions.
`causalArmDiagnostics` reports eligible candidate observations, zero-degree
and insufficient-support counts, price unavailability reasons, graph exclusions
and solver failures. Existing card details and Copy Top Results expose these
values; counts describe candidate observations rather than successful trades.

Old fifteen-arm results remain readable with their Return/P&L and valid
`top-five-ranking-v2` ranking summaries. Absent additional arms show
**Rerun required**, never zero performance. Present additional data are validated
independently, so a malformed additional metric does not erase valid old arms.
Recovery never fabricates missing zero-event sections. Newly enabled child
runs must provide all five sections, including genuinely calculated zero-event
sections. No persistence-envelope or ranking-semantics version change is needed.
Switch cards also tolerate an absent replay arm: P&L and trade counts stay
unavailable, Apply remains available, and any independently valid ranking
summary is still displayed.

These fixed first-version choices are recorded, not automatically tuned or
claimed optimal. Correct implementation does not establish transfer to a
different pair list. Compare identical fixed configurations on the original
and a separately chosen untouched pair list before interpreting performance
as transferable.


**Measurement** defaults to **Return**. **Ranking consistency** opts into a
fixed forward top-five comparison for every arm, alongside the original replay.
Its **Ranking sort** defaults to **Overall ordering**, which ranks configurations
by the lower bound of the mean-accuracy CI95. **Selected asset** instead sorts
descending by the existing #1 superiority point score. Both choices require the
same confidence eligibility (100 scored events, ten populated time blocks and
an available mean-accuracy CI); unavailable values sort last and equal values
use `candidateOrdinal`. The choice is saved locally and sorts the complete retained
inventory before `Top Results`, without running backtests. Return sorting and
the arm selector retain their existing behavior. Five distinct
assets must have complete cost-adjusted long returns with matching entry and
exit timestamps. Predictor and outcome ties receive half credit. BOT arms use
their minimum-first preference order and remain hypothetical longs.

Each pair-entry decision is an observation; exit-only updates are excluded.
Membership is frozen before future target inspection, including cooldown from
the existing arm history. Missing, invalid, gapped, censored, mismatched-calendar,
small-pool or unresolved-pick events are skipped without replacement. A changed
effective replay pick also skips its frozen ranking. Every valid completed event,
including overlapping forward windows, contributes to both mean accuracy and
#1 superiority. Ten pair comparisons contribute one equally weighted event.
The event filter uses **scored ranking events** in both replay modes.

For those same events, **Best asset frequency** is the fraction where the actual
selected #1 has a strictly higher completed return than all four other assets.
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
The current measurement semantics are `top-five-ranking-v2`. Older v1 ranking
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
returns compact summaries for all 20 arms. There is no arm selector before the
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
runs a separate, path-dependent simulation for each of the 20 arms. Each arm
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

`Randomize Path Exits` varies the numeric controls for the selected
path-dependent exit mode. It may vary path-exit controls even when other risk
settings are frozen; other risk controls remain fixed.

### Exit Strategy Override

`Exit Strategy Override` requires Disable Exit Signal plus a configured exit
strategy override. When enabled, Finder samples exit strategies from the
checked list and varies their parameters with the entry parameters. Applying a
result writes both entry and exit strategy settings.

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

Backtest settings are part of Finder's result meaning. If a setting is not
supported by Rust, strip it consistently in both `lib/backtest-service.ts` and
`lib/finder-manager.ts`. If a setting changes entry timing, fills, exits,
drawdown, or Sharpe, check the browser and server paths together.

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
| Result inventories, display limits, re-sort and Run Sort restoration, Arm run/apply context | `lib/finder/browser/finder-result-store.ts` | `tests/finder-result-store.spec.ts`, `tests/finder-manager-lifecycle.browser.spec.ts`, `tests/finder-asset-opportunity-all-resorts.spec.ts` |
| Candidate Apply flows, apply-in-flight guard, backtest-settings merge | `lib/finder/browser/finder-result-actions.ts` | `tests/finder-selection-apply.browser.spec.ts`, `tests/finder-arm-performance-settings.spec.ts`, `tests/finder-freeze-randomize-path-exit.spec.ts` |
| Strategy selection sets, toggle maps, filter/range/bulk selection | `lib/finder/browser/finder-strategy-selection.ts` | `tests/finder-selection-apply.browser.spec.ts` |
| Server run ownership, scoped Stop, reattach/recovery polling | `lib/finder/browser/finder-server-session.ts` | `tests/finder-manager-lifecycle.browser.spec.ts` |
| Scope workflows (current chart, universe, asset single/batch, arm, quality) | `lib/finder/browser/workflows/*` | `tests/finder-manager-lifecycle.browser.spec.ts`, `tests/finder-asset-opportunity-stream.spec.ts` |
| Form binding/capture, `readOptions`, scope visibility, sorting controls, reset | `lib/finder/browser/finder-controls.ts` | `tests/feature-dom-contracts.spec.ts`, `tests/finder-settings-persistence.spec.ts` |
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
