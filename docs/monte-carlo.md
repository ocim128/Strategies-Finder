# Monte Carlo

Open **More → Monte Carlo** and select **Current Chart** or **Symbol Universe**.
For Current Chart, run a chart backtest first, then click **Run Monte Carlo**.
Current Chart uses `state.currentBacktestResult` and requires at least five trades.
Without a backtest, Run is disabled. An insufficient trade sample is reported in
the status bar.

Sequence randomization shuffles the observed trades; bootstrap resampling draws
trades with replacement. With both enabled, the service runs three scenarios:
sequence only, bootstrap only, and combined. The combined scenario supplies the
main summary, with all three shown in Method Comparison. The seed makes runs
reproducible. Simulation counts are capped according to trade count and active
scenarios; Cancel aborts the running simulation.

Current Chart results belong to the backtest used for the run. Replacing or clearing that
backtest hides its Monte Carlo results and cancels any active simulation,
including one at its final asynchronous yield. Run Monte Carlo again for the
new backtest; reopening the tab with the same backtest preserves its results.
All scenarios within a run share the captured chart data and sizing settings.

Paths use the chart's current capital sizing settings and the Monte Carlo
Initial Capital control. Results include profit, drawdown and Sharpe
distributions, confidence intervals, equity paths and ruin frequency.

## Layout and implementation

- `lib/monte-carlo-service.ts` binds controls and orchestrates simulations.
- `lib/strategies/monte-carlo/monte-carlo-engine.ts` simulates trade paths.
- `lib/monte-carlo-renderer.ts` renders tables and canvas charts.
- `lib/monte-carlo-dom.ts` owns the required DOM contract.
- `html-partials/tab-monte-carlo.html` owns the lazily loaded markup.

The renderer sorts drawdown samples once for the percentile table and equity
samples once per fan-chart point, reusing each ordering for all displayed
percentiles. Shorter sampled paths extend their final equity value; empty paths
contribute no values.

Every id declared in `lib/monte-carlo-dom.ts` is required. Initialization
resolves the whole contract before attaching any listener; a missing element
throws, so the lazy tab reports an activation failure (with Reload as the
recovery) instead of wiring controls to substituted elements.

The engine owns sequence/bootstrap sampling and path metrics. The older
standalone simulation helpers and unused parameter-perturbation API have been
removed; simulations operate on observed closed trade records.

## Symbol Universe

Universe runs one captured built-in strategy configuration across a pasted
Batch-style symbol list. **Copy from Finder Universe** copies its current list
without modifying Finder. Ordinary symbols, ratio pairs (`BTC+ETH`), and
equal-dollar pairs (`BTC+ETH@` or `@50/50`) are supported. IBKR markers retain
provider inference. Aliases count once; ratio, 50/50 and reversed pairs stay distinct.

No chart backtest is required. Strategy selection settles before capture.
Entry parameters, confirmation rules, active exit override, execution, costs,
sizing, interval, inclusive date selection and provider/market are captured once.
One server as-of time applies to every backtest. MC Initial Capital seeds both
execution and simulation. Fixed/percent sizing is supported; smart sizing and
partial exits are rejected in v1. Edits apply to the next run. Changing chart
state or tabs does not cancel a captured run.

Each path draws the instrument's N complete trade records with replacement.
Each instrument has a separate account and counts once; there is no pooled
sample or portfolio curve. Defaults: 1,000 paths, seed 1337, minimum 30 records,
at least 90% profitable paths, P95 closed-trade drawdown at most 20%. Seed and
ruin threshold are under Advanced. Zero profit is not profitable. Thresholds
compare unrounded values. P95 is the 95th percentile, not the upper bound of a
two-sided 95% interval. No eligible instruments means no pass-rate percentage.
The denominator and exclusions stay visible; incomplete runs say Partial.

Observed account return divides net profit by MC Initial Capital, even with
smaller fixed sizing. Simulated drawdown measures equity after closed trades;
observed backtest drawdown remains separately saved in details. Independent
record sampling does not model loss clustering, overlapping positions,
intratrade risk or shared-leg portfolio exposure. These are editable screening
conditions, not forecasts.

Sort buttons sort all rows, with missing values last and canonical identity
breaking ties. Default order: Pass first, profitable-path percent descending,
P95 drawdown ascending, identity ascending. Render 100 rows per page.
Terminal-only Copy CSV/Download JSON export every row; JSON includes captured
configuration, coverage and state, with no replay trades or metric arrays.
CSV escapes fields and protects formula-like text.

Details replay saved trades through the existing engine without prices or a
strategy rerun, using the saved sizing, effective paths and row seed. They never
change the live chart. One detail is retained. SHA-256 identifies the allowlisted
replay input, not the complete market dataset. Algorithm/digest mismatch requires
a rerun. Legacy detail ruin probabilities remain fractions on the wire and
render as percentages once.

## Universe server and persistence

Universe requires the local Vite research server (dev or preview); static hosting
keeps Current Chart available. Authorized routes under `/api/monte-carlo/universe/`
are POST `run`, GET `status?runId=...`, POST `stop`, and POST `detail`
(`{runId, rowIndex}`). Identical run-ID retries are idempotent; edited retries
conflict. The checked shared Batch/analysis reservation excludes competing
Finder, Batch and TOP_MEAN work. Stop is scoped, including admission; ownership
lasts until worker termination and pending writes settle. Browser disconnect
leaves the run active. Detail disconnect cancels its transient replay.

One bundled Node worker runs Batch in TypeScript mode and then the existing MC
engine. The completion callback never rejects into Batch's backtest error handler.
Each scalar row publishes after journal append and flush. Numerical row failures
can continue; write/transport failures terminate with the committed prefix.

`artifacts/monte-carlo-universe/<server-owned-safe-id>/` contains `manifest.json` and
`replay-inputs.jsonl`, plus a temporary manifest during replacement. The parent
retains scalar rows and byte offsets. Restart scans bounded records, ignores
an incomplete final line, reports internal corruption and converts unfinished
runs to Interrupted; computation does not resume. Retain latest terminal plus
active only. Cleanup never traverses junctions. A failed terminal write stays a
live failure and may recover as Interrupted after restart.

Version-1 preferences and last-run marker use `persisted-json` keys
`monteCarloUniverse.settings` and `monteCarloUniverse.lastRun`. No rows or trades
enter localStorage. Preferences flush on pagehide. Reload reattaches through
one-at-a-time status polling with bounded error backoff.

`UNIVERSE_LIMITS` centralizes 1,000 canonical/2,000 raw instruments, 1 MiB
requests/manifests, 2 MiB complete status, 256 MiB journals and 16 MiB records.
Requested paths are 250–10,000; effective paths per instrument are
`min(requested, 10000, floor(8000000/N))`. Fewer than 250 paths or an oversized
record produces a resource-limit row before MC. Displays retain at most 48
paths with 512 points each. Versioned FNV-1a over UTF-8
`baseSeed + "\n" + canonicalKey` makes row seeds independent of list order/time.

The five files under `lib/monte-carlo/universe/` own model, worker, server,
store and browser controller. The existing service/renderer compose both scopes
with shared Run/Stop/status controls and the detail display.

Shared-engine allocation matches execution: ordinary/ratio uses entry notional
including entry commission; 50/50 uses gross entry notional. Pair leg notionals
must agree with the stored allocation. Net P&L already includes costs.
Non-finite generated arithmetic or aggregates produce `non_finite_simulation`,
never successful infinite statistics. Existing chart partial-record resizing
remains; Universe rejects unexpected partial records instead of guessing groups.

Every control, result section and the empty state must remain inside
`#montecarloTab`: the lazy loader copies only that root's children. All result
sections for the chart and selected detail belong inside `#mc-results`, while `#mc-empty-state` is its sibling.
An early closing tag can leave IDs in the source but drop them from the runtime
tab, preventing the service from initializing.

Run `npm run test -- monte-carlo feature-dom-contracts.spec.ts` for engine and
parsed-layout regressions. `npm run test:e2e` also opens the lazy tab, publishes
a combined next-open TypeScript backtest with long and short trades, clicks Run,
and verifies all three scenarios render.
