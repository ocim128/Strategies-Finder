# Asset Opportunity time-filter audit — 2026-09-26

The large improvement with Entry Time Filter enabled is not trustworthy evidence of a predictive edge. Two interacting defects explain the observed discrepancy: inconsistent endpoint exclusion during ranking, and a forward-return measurement that can credit price movement already visible when the candidate is selected.

The initial investigation did not change runtime code or archived runs. The
subsequent correction and rerun protocol are recorded below. Archived results
remain unchanged.

## Compared runs

- Filter on: `finder-mui5zl8p-a7tds8h3`, in `archive/asset opportunity/archived runs/1D averagegain`.
- Filter off: `finder-mui9uxng-m7nc3eff`, in `archive/asset opportunity`.
- Both use daily candles, next-open execution, fixed $1,000 sizing, 2% SL/TP, entry confirmation, and the same ten strategies. The config diff also changes Kelly fraction from full to quarter, which is inactive under fixed sizing.
- The saved reports cover different ranges: 2–960 versus 2–135. The newer run continued producing files during this audit, so comparisons below freeze the range at 2–135, top K = 1, horizon = 1.

| Sort | Filter on mean | Filter off mean |
| --- | ---: | ---: |
| averageGain | 7.2507% | 0.6439% |
| run_default | 4.2982% | -0.1509% |
| netProfitPercent | 6.0274% | 0.5232% |

These are arithmetic means of archived observations, not compounded portfolio returns.

## 1. The filter changes endpoint exclusion, although it allows every daily bar

In [backtest-engine.ts](../lib/strategies/backtest/backtest-engine.ts), `getSinglePositionFinderFastPathBlockers` disables the optimized path when `entryTimeFilterEnabled` is true. Both runs use TypeScript for the reproduced candidate; this is not a Rust-versus-TypeScript discrepancy.

The optimized path computes `endpointSelection` even without retaining trade history. The general compact path returns scalar results without that adjustment. Server Asset Opportunity requests `trades: false` and falls back to [buildSelectionResult](../lib/finder/endpoint.ts), which cannot remove endpoint trades from an empty trade array and returns the unadjusted result.

Concrete reproduction: AKAM / Modern Arbitrage Speed Reversion, holdout 100, a 300-bar selection window ending April 16, 2026. The raw trades are identical with the filter on and off:

- Two stop losses totaling **-$40.392**.
- One entry on April 16 at **91.403277**, forcibly liquidated at that day's **96.84** close for **+$59.4806136**. Its exit reason is `end_of_data`.

The production candidate helper produces:

| Setting | Endpoint trades removed | Selection trades | Selection net profit | Average win |
| --- | ---: | ---: | ---: | ---: |
| Filter on | 0 | 3 | +$19.0886136 | $59.4806136 |
| Filter off | 1 | 2 | -$40.392 | $0 |

The filter-on values exactly match AKAM's rank-1 `averageGain` archive row at holdout 100. This is a ranking/accounting defect, not a daily timing advantage.

## 2. Forward OOS sometimes starts before selection

[finder-asset-opportunity-runner.ts](../lib/finder/finder-asset-opportunity-runner.ts) permits a one-bar-old source signal for next-bar execution. For those rows, fixed-horizon measurement can use the already-visible boundary bar's opening price as `freshEntryPrice`, while the horizon target is a hidden future close.

The ranking has already seen the boundary close. A strategy chosen using that information cannot then be bought at the earlier boundary open. This is selection-time look-ahead / return contamination even though hidden candles need not enter the signal calculation.

For the same AKAM row:

- Visible boundary, April 16: open **91.385**, close **96.84**.
- First hidden day, April 17: open **97.53**, close **95.94**.
- Archived one-bar OOS: `(95.94 / 91.385 - 1) × 100` = **+4.9844%**.
- First hidden day's open-to-close return: `(95.94 / 97.53 - 1) × 100` = **-1.6303%**.

The first defect favors the boundary-day winners; the second credits their already-seen movement again in what is presented as forward OOS. Both settings can suffer the second problem: disabling the filter is not a complete repair.

For filter-on `averageGain`, local CSV prices reconciled 132 of 134 selected observations: 72 used the visible boundary open and 60 used the first hidden open. Across those same 132 picks, archived mean return was **+7.2367%**; first-hidden-open to first-hidden-close mean was **-0.0440%**. Two observations could not be reconciled and were excluded from this diagnostic. This is a same-picks repricing exercise, not a corrected reranked strategy backtest; it excludes fees, slippage, confirmation, and exit rules.

## Checks and limits

- Direct engine reproduction confirms identical raw trades under the toggle.
- The production `runAssetCandidateBacktest` helper reproduces the endpoint-adjustment discrepancy with trade retention disabled.
- For all ten configured strategies at their default parameters on AKAM, signals before the holdout were unchanged when the series was truncated at the boundary or all hidden OHLC prices were multiplied by ten. This targeted check found no direct future-price dependence; it is not a universal strategy or engine audit.
- Four existing spec files passed, with zero failures or skipped files: entry-time-filter, backtesting-engine-compact-parity, finder-asset-opportunity-oos, and finder-asset-opportunity-runner.
- Existing coverage misses general-compact endpoint exclusion. The runner test named `uses the actual visible-boundary fill for fixed-horizon next-bar OOS` explicitly preserves the measurement described above; that contract needs revision for a claim about returns achievable after selection.
- Fixed-horizon output is a price-return diagnostic, not the realized SL/TP/confirmation strategy result. Selecting the best sort after inspecting many overlapping holdouts adds a separate research-selection issue.

## Required corrections before interpreting another run

1. Honor endpoint exclusion in every engine path, including compact results without retained trades. Lock daily filter-on/off parity for selection scalars, not only raw trades.
2. Define the selection instant and measure only subsequent returns. For a new next-open selection made after the visible close, use the first hidden open. Any earlier-entry continuation result must be separate and exclude pre-selection gains.
3. Add tests where the visible boundary rallies sharply but the hidden day falls; the prior rally must not appear as forward profit.
4. Rerun both configurations on an identical frozen dataset and holdout range. The old scalar archives cannot reconstruct the full corrected candidate ranking.

Reproduction artifacts are in [artifacts/asset-opportunity-audit](../artifacts/asset-opportunity-audit): `reproduce.ts`, `reproduction.txt`, `compare.py`, and `comparison.json`. From the repository directory:

```powershell
..\..\..\node_modules\.bin\esno.cmd artifacts/asset-opportunity-audit/reproduce.ts
python artifacts/asset-opportunity-audit/compare.py
```

## Correction and next-run protocol

The general compact engine now uses the same endpoint accumulator as the
optimized path. Fixed-horizon returns now start at the selection boundary close
(`signal_close`), first hidden open (`next_open`), or first hidden close
(`next_close`), for both pair and BASE-only measurement. Signal freshness is
unchanged; earlier fills cannot backdate the forward measurement.

The production AKAM reproduction now reports **two trades, -$40.392, average
win $0**, with the filter either on or off. Regression coverage includes long,
short, and both directions across all three execution models, plus pair/BASE
fixed-horizon cases. Existing Next configured exit semantics were not changed;
the protocol below specifically uses Fixed horizons and does not claim to test
a newly selected trade's full confirmation/exit lifecycle.

Use this controlled rerun first; it tests the original averageGain hypothesis
without changing the strategy universe or tuning thresholds after the result:

| Setting | Value |
| --- | --- |
| Scope / timeframe | Asset Opportunity / 1d |
| Universe and strategy libraries | Same symbols and ten libraries as the archived filter-on config |
| Search | Random, max runs 1, freeze risk management on; same normalized default parameters |
| Historical sort / Top N | Keep netProfit then sharpeRatio / 10 |
| Candidate pool / minimum fresh support | 3 / 1 |
| Trade count filter | On, minimum 2, maximum unset (unchanged for this comparison) |
| Include Open Positions (EOD) | Off |
| Evaluation window | Range Bar, 200 (unchanged) |
| Data slice | Same saved date-range setting and data snapshot |
| Batch holdouts | 2 through 960 |
| Forward Measurement | Fixed horizons |
| Horizons | 1, 3, 6; declare horizon 1 primary before running |
| Basis | Pair/current asset for these single stocks; BASE-only previously falls back to pair for them |
| Execution / direction | next_open / long |
| Capital / size | $10,000 / fixed $1,000 |
| Entry Time Filter | On, day_close; a small matched off run should give the same ranking metrics |
| Confirmation / risk | Keep 4% up within 4 bars, 2% SL, fixed 2% TP, cooldown 2, slippage 2 bps; other switches unchanged |
| AverageGain evaluation | Read archive sort `averageGain`, cumulative top K = 1; do not choose a different K or winning sort afterwards |

Restart the Vite server after any existing run finishes or is stopped using the
UI; old worker processes keep the old code. Reload the page. Avoid refreshing
market data between the on/off comparison runs. The archive remains append-only.
Read the new batch ID from `config.txt`, then run:

```powershell
& '.\archive\asset opportunity\analyze-asset-opportunity-holdouts.bat' --batch-run-id NEW_BATCH_ID
```

Enter **1** at the top-K prompt. Evaluate only the `averageGain` section and its
matched all-candidate baseline. Positive average alone is insufficient: check
the delta versus the baseline, median, tails, concentration, and whether the
result depends on a few observations. The analyzer prints all sorts; those
other results are not grounds to switch the frozen hypothesis. Two trades is
kept only for comparability, not claimed as strong historical support.

This rerun is a corrected re-analysis of already-inspected history, not a fresh
confirmation sample. A surviving advantage needs a later, untouched time period
and a separate entry/exit execution validation before being called tradable.
Do not substitute the pasted DELL single-strategy configuration for the archived
ten-library experiment: its strategy key and actual dataset reference are not
specified, and it represents a different experiment.

Validation: TypeScript typecheck passed. In the 16-file relevant test sweep,
14 passed and two failed: metadata's expected payload lacks an existing field,
and cache-capacity expectations are stale (608/300 actual versus 679/341
expected). Both failures were reproduced in an isolated copy with the original
engine and runner restored from HEAD. No tests were skipped, and those unrelated
tests were not changed to make the sweep green.
