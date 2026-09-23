# Strategy Finder

This is the maintained reference for the Finder menu. Read it before changing
Finder controls, ranking metrics, result retention, server routes, or the
backtest path used by Finder.

The Finder searches strategy parameters and displays the strongest candidates
for one of four scopes:

- **Current Chart** searches parameter combinations on the active chart.
- **Symbol Universe** evaluates selected strategies across a list of symbols
  and ranks strategy/universe combinations.
- **Asset Opportunity** searches each symbol for fresh-entry opportunities and
  can validate the selected opportunities forward in time.
- **Strategy Quality Audit** runs each selected strategy with normalized
  defaults across the supplied symbols. It is a baseline quality report, not
  parameter discovery.

The menu is assembled from `html-partials/tab-finder.html`. Its structural DOM
contract is `lib/finder/finder-manager-dom.ts`; do not rename an id in the
partial without updating the contract and its tests.

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

## Shared controls

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

Backtest settings are part of Finder's result meaning. If a setting is not
supported by Rust, strip it consistently in both `lib/backtest-service.ts` and
`lib/finder-manager.ts`. If a setting changes entry timing, fills, exits,
drawdown, or Sharpe, check the browser and server paths together.

## Source map

| Area | Main files |
| --- | --- |
| Menu markup | `html-partials/tab-finder.html` |
| Finder orchestration and persistence | `lib/finder-manager.ts` |
| DOM ids and required-element contract | `lib/finder/finder-manager-dom.ts` |
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
