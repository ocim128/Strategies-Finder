# Finder Monthly Rank Replay — blueprint

Status: revised after external audit (FMR-01 through FMR-14). Design only; implementation has not started.

## 1. Question and scope

**Does rank #1 consistently produce good forward strategy performance, regardless of which configuration occupies that rank?**

Repeat the Symbol Universe ranking at monthly historical checkpoints. At each checkpoint, choose the top configuration using only information available then, freeze it, and measure its strategy PnL over the next configurable X bars. Summarize those forward outcomes by ranking rule.

Changing winners are intentional. January's highest-Sharpe configuration and February's highest-Sharpe configuration belong to the same summary row: `Sharpe — rank #1`. Configuration identity is audit detail only.

Sharpe and PF are examples, not a scope restriction. Apply the same monthly rank-#1 experiment independently to the other existing historical Symbol Universe sorts.

The user already uses Symbol Universe and Batch Backtest to investigate configuration quality. This feature does not add a configuration-consistency leaderboard or another pair selector.

## 2. Proposed minimum version

Place a `Monthly Rank Replay` submode inside Symbol Universe. Ordinary Universe remains the default.

New inputs:

| Input | Meaning |
| --- | --- |
| From year | First scheduled checkpoint is January of this year. It is not the start of training history. |
| Eval window bars (L) | Positive, fixed trailing number of scored historical bars per symbol. |
| Forward bars (H) | Positive number of bars per symbol over which the frozen winner is tested. |

Reuse the selected symbols, interval, strategies, parameter ranges, Runs / Strategy, applicable historical eligibility filters, and supported backtest settings. Capture them once at run start.

V1 scope:

- Fixed monthly checkpoints; fixed rank #1.
- Replay each existing historical Universe sort independently, using its existing formula and ascending/descending direction. Include all applicable historical sorts automatically; no extra metric-selection control, new score, or secondary-sort combinations are needed.
- One seeded random parameter pool generated once per run, reused across all months and ranking rules. Same requested sampling budget per strategy; report actual unique normalized counts, which can differ.
- TypeScript execution for every historical and forward backtest. Set the engine explicitly and display `engine: typescript`; do not mix engines or silently follow the ordinary Finder Rust preference. Rust support is deferred.
- No genetic search, changing parameter pools, Top K, ensemble construction, portfolio switching simulation, or parameter optimization using forward results.
- No all-candidate forward baseline in v1. Measuring every candidate forward would broaden the compute and research scope. The output describes top-1 forward consistency; it cannot establish that top-1 beats random selection or that ranking has predictive value beyond alternatives.
- Configuration keys and exact parameters appear only in monthly details. No new Apply workflow.
- Existing data-slice, OOS-validation, Top Results, search-mode, and sort controls do not participate in replay. Hide or disable them while explaining that replay uses one fixed random pool and reports rank #1 separately for each historical sort. L/H own the scoring boundaries. Do not overwrite ordinary Universe's saved settings when switching submodes.
- Only historical ranking metrics are allowed. OOS-derived scores such as `windowStabilityScore` cannot select a winner using the same forward period being measured.

No automatic "consistent", PASS, or FAIL verdict. Describe the report as **"Forward outcomes of monthly historical rank #1."** The user judges the distribution rather than a new composite score or arbitrary threshold.

The current Universe sort coverage is:

| Direction | Existing sorts |
| --- | --- |
| Higher ranks first | Robust Universe Score; Profitable Active Ratio; Active Symbols; Median Expectancy; Median Expectancy × Total Trades; Median Sharpe; Median Profit Factor; Median Profit Factor × Total Trades; Median Composite Edge Ratio; Median Exit Alpha; Median Return / Drawdown Ratio; Worst Net Profit; Total Trades. |
| Lower ranks first | Worst Max Drawdown; Median Max Drawdown. |
| Excluded from this replay | Window Stability Score: it consumes OOS outcomes, which must not select the winner for that same forward measurement. |

Use the existing Universe metric keys, labels, and definitions as the source of truth. The list above documents current coverage, not a new parallel registry. If a historical metric cannot be calculated for a configuration, expose that metric's unavailability/reason; do not silently omit the sort or substitute zero. Existing current-chart-only sorts are outside this Symbol Universe submode.

Before evaluating candidates, show the loaded data range for each required primary, auxiliary, and synthetic seed series: earliest/latest usable timestamp, available pre-window history, first feasible checkpoint, and unavailable-checkpoint reasons. State whether January of From year is reachable. The shared loader has a 100,000 target-bar cap and separate synthetic seed limits; a requested year is not a guarantee of available history. Respect those caps in v1. Do not add a historical downloader, raise caps, silently shorten L/H, or silently advance From year. If no checkpoint can be measured, return the coverage report without an expensive search.

## 3. Monthly procedure

For each UTC calendar-month boundary T, starting in January of From year:

1. Freeze the historical cutoff at T. For fixed-duration candles, include a bar only when `barOpenTime + intervalDuration <= T`. Use existing time normalization and interval helpers; calendar intervals require their actual close boundary. Apply the cutoff to primary, auxiliary, and synthetic seed inputs before strategy preparation, then keep only fully closed aggregate candles. Supply explicit checkpoint time to execution; today's clock and the ordinary include-open-candle preference cannot define historical eligibility.
2. For each symbol, score the last L historical bars. Keep earlier available causal data for indicator warmup, excluded from account state and metrics. Use the same frozen source-history start across checkpoints and report warmup counts; enforce known strategy/alignment minimum-history requirements. Do not invent a universal warmup length or claim all indicators are fully warmed merely because L bars exist. The forward region begins with its first tradable bar at or after T and consists of H bars. Record actual start and end timestamps; different calendars can produce different dates.
3. Evaluate every canonical candidate against the complete fixed symbol set, deriving the required historical metrics from that shared evaluation. Request optional analytics needed by the replayed sorts, including Sharpe, drawdown, and edge metrics. A candidate is eligible only after every symbol is successfully evaluated, including valid no-trade results. Apply existing historical filters after this completeness gate. Disable the ordinary early-stop and consecutive-zero-signal shortcuts for replay. Never treat an unevaluated symbol as a successful no-trade result.
4. Maintain one independent best-so-far candidate per sort across all selected strategies, before any survivor/top-N truncation. Retain only those winners and their scalar detail. Complete historical coverage is shared eligibility; metric availability is rule-specific, as defined below.
5. Freeze the complete execution configuration for each winner. Run each distinct winning configuration forward once per symbol/checkpoint, and share that outcome across every sort that chose it.
6. Record both successes and losses. Forward performance never changes that month's selected identity, eligibility, or historical rank.
7. Advance to the next calendar month. New historical information can change rankings; the candidate pool and experiment settings remain fixed.

Example: January 2023 ranks using history closed by January's boundary; February repeats using history closed by February's boundary. From year alone is insufficient without L and pre-2023 data. Each window tests H bars, which need not equal one month.

Canonical candidate identity contains entry strategy key, normalized entry parameters, exit strategy key and normalized parameters, effective risk overrides, and frozen execution/capital settings. Serialize fields in stable order. Deduplicate identical configurations and preserve a stable generation ordinal. Compare the ranking metric in its existing direction, then canonical identity, then ordinal; compare equal infinities directly rather than subtracting them. Do not reuse ordinary name/entry-param tie-breaking or alter the ordinary comparator as a side effect.

Historical rank preserves each existing Universe metric's aggregation/formula, with explicit availability. Some metrics are active-symbol medians; others are counts, ratios, worst cases, or composite scores. Availability checks apply independently per sort:

- Sharpe: require `medianSharpeAvailable === true` and a finite value. Preserve the per-symbol minimum-sample/availability rules, including pair-neutral trade-return Sharpe. Missing Sharpe cannot rank as zero; an actual finite zero remains valid. Copy the number of active symbols and symbols contributing Sharpe.
- PF: require at least one active symbol and a computed nonnegative PF for every active symbol. Preserve the existing convention: gross profit / gross loss when loss is positive; positive infinity when profit is positive with no loss; zero when both are zero. NaN, negative infinity, missing or invalid values are unavailable. Positive infinity can win and must survive transport as an explicit scalar value tag such as `positive_infinity`, not JSON's silent conversion to null.
- Drawdown-based sorts require computed drawdown values; edge/Exit Alpha sorts require actual computed observations. Respect existing applicability restrictions, such as Composite Edge Ratio on cross-symbol runs. A missing metric excludes the candidate only from sorts that require it. Weighted sorts inherit the availability requirements of their underlying metric.
- Preserve ordinary single-sort score meaning when computing extra diagnostics for other rows. In particular, Robust Universe Score can use Composite Edge Ratio or its PF fallback; calculating edge data for the separate edge-sort row must not silently change the robust row's ordinary single-sort dependency/fallback behavior.
- If no candidate meets a sort's eligibility, record `no selection` for that sort. No sort depends on Sharpe/PF availability unless its own formula requires it.

Raw data reuse is bounded and scoped to the job. Construct immutable causal views for each month and for each historical/forward phase. Prepared-data caches must be scoped to those views and effective settings/auxiliary context; never reuse a full-dataset preparation for an earlier checkpoint. Forward data may extend to the Hth bar, but must not mutate the historical views or selection. Release phase/month preparations after use. Synthetic aggregates must be equivalent to truncating seed data first and then aggregating; incomplete buckets cannot acquire future extremes.

## 4. Forward performance contract

Proposed v1 meaning: **a fresh, independent strategy backtest for each monthly window**, not the return from buying the pair at the boundary or waiting for one fresh opportunity signal.

- Use `CapitalSettings.sizingMode = "fixed"`, positive `initialCapital`, and positive `fixedTradeAmount`, identical per symbol. Reject percent/adaptive sizing in v1 instead of silently converting it. Freeze the complete resolved capital payload (including `positionSize` and `commission`) and execution settings (including `slippageBps`, direction, timing, exits, and risk overrides). `fixedTradeAmount` controls sizing; inactive fields remain recorded for reproducibility.
- Add one narrow, explicit scored-range execution contract shared by historical and forward evaluation: indicators can read the earlier prefix, while account state begins flat at the first scored bar and statistics cover exactly L or H bars. Flat bars before the first trade remain in the scored period; never start the statistical denominator at the first fill. No prefix PnL, trades, pending orders, risk/account memory, or equity samples enter the scored account.
- Preserve the original draft's conservative fresh-start signal policy: a signal must originate in the scored region AND its resolved execution bar must be inside that region. A signal on the last warmup bar is not carried in as a next-open/next-close order. `signal_close` can fill on scored bar 1; a signal on bar 1 with `next_open`/`next_close` first fills on bar 2. Signals whose fill would occur after H are ignored. Validate signal and execution indices separately.
- Liquidate remaining positions at the final scored bar's close, using direction-correct exit slippage and commission, for both historical and forward scoring. Do not wait for a later strategy exit. The engine already force-closes and includes commission, but its inspected end-of-data paths use the unadjusted close. The new replay range path must handle terminal slippage explicitly, with unchanged defaults for ordinary backtests. Include the terminal close in trades, ending capital, and requested metrics.
- No-trade, successfully evaluated symbol: return is zero. A failed/missing evaluation is never converted to zero.
- Include synthetic pairs using the existing pair-neutral transform for both historical metrics and forward outcomes, as defined below. Preserve seed-then-aggregate construction.

For ranking rule q, checkpoint m, and symbol s:

For an ordinary symbol:

`symbolReturnPct = result.netProfitPercent = 100 * result.netProfit / initialCapital`

For a synthetic pair with trades:

`neutral = buildFinderPairNeutralMetrics(resultWithAllScoredTrades, frozenCapital)`

`symbolReturnPct = neutral.netProfitPercent`

Use the same helper for the historical metrics it supplies, including pair-neutral return, expectancy, PF, Sharpe, and drawdown; preserve existing Universe definitions for other metrics. It derives direction-correct trade multipliers from executed prices, includes the symmetric commission adjustment, and derives cash returns using the frozen sizing. Slippage is already represented in executed prices; do not charge it or commission again after transformation. Retain complete scored trades server-side until all required metric calculations finish, including the final forced close. If the helper returns null for a nonempty trade result, mark that evaluation invalid; never fall back to raw ratio-price return. A successfully evaluated zero-trade pair is explicitly zero without calling the nonempty-trade helper.

Pair-neutral percent is the existing normalized synthetic-pair accounting measure; it is not a claim of realized two-leg broker PnL. Tag each symbol's measurement basis in copied detail, including mixed ordinary/synthetic universes.

`windowReturnPct(q, m) = arithmetic mean of symbolReturnPct across the fixed symbol set`

Average the window returns equally across months. Do not weight by number of trades, active symbols, or configuration frequency. This gives each checkpoint one observation and keeps inactive symbols in the denominator.

The existing `blockRange` slices input before signal generation and therefore is not the warmup/scoring contract. Implement the smallest adapter or explicit execution-range option that satisfies the rules above using the existing TypeScript engine and signal pipeline. Check indicator/risk arrays and execution-index remapping as well as signals; filtering signals alone does not prove parity. Do not build another engine. Unsupported settings/combinations must fail explicitly before search where detectable, including existing cross-symbol/timeframe incompatibilities and Polymarket-specific execution.

## 5. Missing data and observation counts

Keep the requested symbol set fixed; do not quietly replace or drop symbols from particular months.

- Inadequate historical coverage/warmup: mark the checkpoint unavailable with symbol/reason details. Do not silently shorten L or change the advertised From year.
- No historically eligible candidate for a rule: record `no selection`, not a zero-return observation.
- Fewer than H completed forward bars: record `incomplete horizon`, not a shorter result.
- Forward load/execution failure: preserve the originally selected winner and report an invalid observation. Do not replace it with the next candidate.
- Historical candidate-specific base execution failure: exclude that candidate from every sort and expose counts/reasons and affected identities. An optional diagnostic failure affects only sorts requiring that diagnostic. A shared data/alignment/coverage failure makes the checkpoint unavailable; a broken executor or job-level infrastructure failure terminates the run as fatal with partial results labelled incomplete. Do not let a systemic failure masquerade as a smaller successful candidate search.

Keep a detail record for every scheduled checkpoint through the run's latest closed-data boundary, including skipped/incomplete checkpoints. Show scheduled count and valid/excluded counts per sort. A valid sort observation requires a selected winner and successful complete H-bar evaluation across every fixed symbol. Each summary row uses that sort's own valid checkpoints and labels its denominator. An unavailable optional sort must not remove otherwise-valid months from every other sort. If a sort has no valid observations, keep its row with `no valid observations` and the reasons.

There is no extra common-month comparison mode in v1. When coverage differs, the summary describes each sort's observed outcomes; it is not a controlled head-to-head comparison over identical months. Monthly details retain the checkpoint identities needed to inspect coverage.

Strict symbol coverage trades usable sample size for a fixed universe. The coverage report makes that tradeoff visible; the user can change From year or the symbol list in a later run. Exclusions are not permission to discard errors silently or claim the unmeasured checkpoints would behave similarly.

Overlapping forward windows are allowed and labelled using their actual timestamps. Their observations are dependent and are not a continuous tradable portfolio. Do not compound them, annualize them, or display a stitched equity curve.

## 6. Output

One summary row per ranking rule:

| Ranking rule | Valid / scheduled checkpoints | Mean forward return % | Median forward return % | Positive / valid | Worst window % |
| --- | --- | --- | --- | --- | --- |
| Robust Universe Score — rank #1 | … | … | … | … | … |
| Median Expectancy — rank #1 | … | … | … | … | … |
| Median Sharpe — rank #1 | … | … | … | … | … |
| Median PF — rank #1 | … | … | … | … | … |
| Lowest Median Max Drawdown — rank #1 | … | … | … | … | … |
| Each remaining historical sort — rank #1 | … | … | … | … | … |

The table is illustrative; render an actual row for every historical sort, using existing labels and ordering, rather than a literal "remaining sorts" row. Positive means strictly positive unrounded net return. Zero-return windows remain in each row's denominator. Show all-zero-trade counts per sort within its valid sample. Empty summaries use unavailable values, never misleading zeroes. Label the historical metric's actual aggregation and contributing-symbol count; forward outcome is an equal-weight mean over all fixed symbols. Neither is a pooled portfolio result.

Simple monthly detail table, included in Copy Results:

`Checkpoint | rule | historical rank score | strategy + exact configuration | forward return % | trade count | status/reason`

Record per-symbol scored bounds, warmup counts, scalar return/trade count, measurement basis, and evaluation status in copied detail. Also include historical active-symbol and Sharpe-contributor counts for the selected candidate so narrow metric support is visible. Summary is not a configuration leaderboard.

Copy Results includes From year, L, H, interval, symbols, selected strategies, replayed sort keys/directions and excluded-sort reasons, the complete effective capital/settings payload, `engine: typescript`, pool seed/fingerprint and actual candidate counts, tie/signal-boundary/endpoint conventions, accounting basis, loaded-data range, and per-sort coverage/failure counts. This identifies the experiment without introducing a new archive service.

Output wording should say "historical monthly checkpoints" and "forward H-bar return". It must not imply each observation is a calendar-month return or evidence of live profitability. This is a retrospective replay of the selected current strategy library and symbol list; it does not reconstruct which strategies/symbols a researcher would have chosen historically. Choosing the best rule or tuning L/H after reading these results is exploratory selection; a later untouched period would be needed for a fresh confirmation.

## 7. Repository seams and traps

Read and verify these existing contracts before implementation:

- [Universe runner](../lib/finder/finder-runner-universe.ts): scalar metrics are computed conditionally for the active sort; survivor storage is bounded according to that sort. Simply re-sorting its final output cannot recover another metric's global winner. Replay must request the metrics each sort needs and maintain one best-so-far candidate per sort before trimming. Drawdown sorts select minima; most other sorts select maxima. Avoid retaining all trades or candidates just to find winners.
- [Universe labels](../lib/finder/constants.ts), [metric types](../lib/types/finder.ts), and [ordinary sort options](../lib/finder-manager.ts): align replay coverage with existing historical Universe sorts. Any helper needed server-side must be a leaf; do not import the browser-bound Finder manager into the server plugin.
- [Universe metrics](../lib/finder/finder-universe-metrics.ts): ordinary filters permit partial successful symbol sets and the comparator does not guard unavailable median Sharpe. Add replay-specific completeness, availability, and tie handling; preserve ordinary behavior.
- [Universe OOS pass](../lib/finder/finder-universe-oos.ts): removes OOS failures and re-sorts survivors. Its filtering orchestration is unsuitable for this replay's outcome measurement. Reuse lower-level execution only where contracts match.
- [Parameter space](../lib/finder/finder-param-space.ts) and [Finder types](../lib/types/finder.ts): preserve normalized canonical identities and deterministic candidate generation.
- [Executor](../lib/backtest-executor.ts), [block slicing](../lib/block-selector.ts), and [engine](../lib/strategies/backtest/backtest-engine.ts): add the narrow scored-range contract; explicitly use TypeScript and handle end-of-range slippage. Do not assume existing block slicing preserves warmup.
- [Pair-neutral metrics](../lib/finder/finder-pair-neutral.ts): complete scored trades are needed for conversion, and null on a traded result is a failure. Release trades immediately after deriving scalars.
- [Prepared-data cache](../lib/finder/finder-runner-core.ts) and [cross-symbol runtime](../lib/cross-symbol-runtime.ts): isolate causal input views, settings and auxiliary context per phase/checkpoint. Avoid unrestricted auxiliary fetches inside historical evaluation.
- [Server loader](../lib/finder/server/server-finder-data-loader.ts) and [data limits](../lib/data/constants.ts): use the existing loader pipeline/caps and report actual date coverage; From year must not imply unavailable history can be loaded.
- [Finder server plugin](../lib/finder/server/finder-vite-plugin.ts) and [server documentation](finder-server-side.md): keep the server as job owner, with loopback authorization, runId-scoped Stop, disconnect-safe execution, reload reattach, cancellation, and explicit terminal status. Browser receives result summaries and scalar detail, never OHLCV/trade arrays.
- [Finder markup](../html-partials/tab-finder.html) and [DOM contract](../lib/finder/finder-manager-dom.ts): submode controls must follow existing structural-id conventions and settings compatibility.

Keep processing sequential across months initially. Reuse raw datasets within existing bounded job/loader caches and release month-specific computations; no new thread pool, artifact store, process-global history cache, or framework. "Load once" is a reuse preference, not permission to retain every raw seed array beyond existing memory limits. Evicted raw series may be reloaded from the same source snapshot. Base historical search costs approximately months × unique candidates × symbols. Forward work is months × distinct winners per month × symbols, with distinct winners bounded by the number of sorts. Some existing metrics add work: Exit Alpha needs its historical control backtest; edge metrics need trade/bar analysis. Reuse these calculations where identical, but do not claim all metrics are free or rerun the entire search per sort. Warmup signal-generation cost depends on retained prefix length. Never retain trades across candidates/months for this report.

This work must not restore removed Mine Timing / prediction / allocation features. No contracts in ordinary Universe, Asset Opportunity, or Batch should change implicitly.

## 8. Acceptance criteria for later implementation

These are future checks; no implementation or test pass is claimed by this document.

1. A constructed case changes rank #1's configuration between months while keeping its outcomes in the same rule summary row.
2. Altering data after a checkpoint cannot alter its winner or historical score. Include auxiliary data, synthetic seeds/partial buckets, and prepared-data caching. Historical closed-candle results must not depend on today's clock.
3. For every supported historical sort, the accumulator winner matches a full eligible-candidate sort using that metric's existing formula/direction and replay tie rules. Include a PF winner outside Sharpe's top-N, a drawdown minimum, a weighted metric, and a composite score. Verify score meaning does not change because another metric was also computed; missing values never win as fabricated zeros, and positive-infinite PF survives selection/transport. OOS-dependent sorts cannot participate.
4. A selected forward loser remains in results; no OOS verdict or minimum forward-trade filter removes it. Valid no-trade returns remain zero.
5. Mean, median, positive fraction, worst return, per-sort coverage, and equal-symbol weighting match hand-calculated fixtures, including empty and invalid checkpoints. Unavailable optional metrics must not erase another sort's valid months. A candidate succeeding on two symbols but failing on eight cannot rank; valid no-trade symbols count as evaluated.
6. Flat-account warmup and the final bar obey the documented timing/accounting convention for long/short/both and signal_close/next_open/next_close. Verify exclusion of the last warmup signal, inclusion of pre-trade flat bars in metrics, terminal commission/slippage, and no exit after H. Changing unscored account activity must not affect results.
7. Missing history, partial latest horizons, different calendars, overlapping windows, and identical winners have explicit, reproducible outcomes. Several sorts choosing one configuration share a single forward evaluation per symbol/month while retaining separate summary rows.
8. Same inputs, data, code, and seed produce the same winners and output. Every replay backtest uses TypeScript even when ordinary Finder prefers Rust. Synthetic forward output matches the pair-neutral helper, including short/reciprocal cases, fees, terminal prices, zero trades, and invalid/incomplete trade history.
9. Authorization, run-scoped Stop/reload/terminal failure and scalar-only wire contracts survive the new submode; run typecheck, DOM contracts, and focused Finder/engine regression specs required by the actual edits. Unsupported settings fail explicitly without changing ordinary saved preferences.
10. Manual small-universe replay: compare at least two monthly selections and forward results against independently reproduced prefix backtests. Confirm UI and copied output agree.

## 9. Audit disposition

The external audit's ranking and scored-range requirements are retained within the existing server job lifecycle. Following the user's clarification, the accumulator handles every existing historical Universe sort, not a hardcoded Sharpe/PF pair. One candidate pool, one best-candidate slot per sort, and deduplicated forward evaluation preserve a simple implementation. No baseline, configuration leaderboard, pair selector, or portfolio simulation is added.

| Audit finding | Revision |
| --- | --- |
| FMR-01, 04, 05, 06 | Independent accumulators, complete-candidate eligibility, metric availability, full deterministic identity. |
| FMR-02, 03, 09 | Warmup/account separation, checkpoint-controlled closed data, separate phase/month preparations and auxiliary cutoffs. |
| FMR-07, 08 | Explicit pair-neutral forward conversion and loaded-range preflight within existing caps. |
| FMR-10, 11, 12 | Descriptive wording, metric-specific aggregation labels, and explicit per-sort coverage counts. Each sort summarizes its own valid months; an all-sort intersection would let one unavailable diagnostic erase useful outcomes. Identical-month superiority is not claimed. |
| FMR-13, 14 | Exact fixed-dollar sizing contract, full effective payload, TypeScript-only v1. |

Source review qualifies three audit recommendations:

- Start accounting/statistics at the first scored bar, not the first actual trade; otherwise idle time disappears from the historical metric.
- Preserve the fresh-start signal policy by checking both signal origin and execution bar. The auditor's execution-bar-only suggestion would also admit a warmup signal at the boundary, changing the question. This replay intentionally begins reacting to new signals in each scored window.
- Existing forced closes charge commission but use the raw final close in the inspected engine paths. Terminal slippage is an explicit requirement for the replay range path, not an already-satisfied engine guarantee.

Implementation should first prove the scored-range contract against small fixtures using existing execution machinery, then wire the monthly loop with one winner per historical sort and the UI. Indicator warmup readiness must use actual strategy/alignment requirements and recorded prefix coverage; no generic sufficiency guarantee is inferred. If the range contract cannot be delivered narrowly for a requested setting, identify that unsupported setting explicitly rather than broadening engine semantics or silently weakening the measurement.
