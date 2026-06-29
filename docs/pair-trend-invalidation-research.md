# Short Synthetic Pair Tail-Risk Research

## Purpose

This note tracks short-direction synthetic-pair thesis work for Batch backtests. It is written as an implementation handoff for future AI/agent work, so it includes the observed results, current code behavior, rejected ideas, and the next research path.

Continuation prompt for future AI work: `docs/short-synthetic-tail-risk-ai-prompt.md`.

The current problem is not low trade win rate. The base run has a very high trade win rate, but one or more catastrophic held losers dominate the portfolio result. The research goal is to identify the unrecoverable short regimes or pair failures without destroying the median pair.

Current code state: Pair Trend Invalidation is not an active feature. It was implemented, tested, judged harmful, and removed from UI/settings/backtest code. Treat mentions of its settings in historical configs as legacy experiment evidence only.

Synthetic pair convention: a pair chart is `base / quote`. A rising ratio means base strength versus quote weakness. For a short strategy, a sustained rise in the ratio is adverse.

## What Is Happening

Baseline Batch result:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 69/110 (63%) | Losing 32 | No Trades 9 | Failed 0 | Verdicts STRONG 2, SOLID 9, MARGINAL 30, WEAK 2, THIN 49, LOSING 9
SUMMARY | Total Net $-225693.05 | Avg Net/Pair $-2051.75 | Median Net +$190.40 | Best NEAR+BNB +$2527.77 | Worst ZEC+APT $-161111.12
SUMMARY | Trades 1762 | Trade WR 96% | Avg/Trade $-128.09 | PF 0.23 | Median Trades 13 | Median AvgTrade +$26.88 | Median Sharpe 0.15 | Median DD 14%
SUMMARY | Median Hold 127b (21d) | Median MaxHold 1110b (185d) | Median Exposure 31%
```

The important contradiction is:

- Trade win rate is 96%.
- Median pair is positive.
- Total net is deeply negative.
- Worst pair is much larger than the rest of the distribution.

That is a tail-risk shape, not a normal entry-quality shape. A short strategy can win often but still fail if a bullish regime is held for too long.

## Base Configuration Evidence

The user provided the base configuration used for the short-only run. Important details:

```text
symbol: FETBNB
interval: 4h
strategy params: lookback 147, gradientPercentileMin 0.99
tradeDirection: short
executionModel: next_open
riskMode: percentage
takeProfitEnabled: true
takeProfitMode: fixed
takeProfitPercent: 4.26
stopLossEnabled: false
riskMinHoldEnabled: false
riskMaxHoldEnabled: false
pairTrendInvalidationExitEnabled: false (legacy/exported experiment field; removed from active code)
disableSignalExits: false
maxOpenTrades: 1
slippageBps: 5
```

Interpretation:

- The base strategy is not protected by stop loss, max hold, historical exits, or trend invalidation.
- Losing shorts can remain open until a strategy signal exit, a reversal/close signal, or end-of-data.
- Winning trades can close by the fixed 4.26% take profit.
- Because `disableSignalExits` is false, the mined strategy's native exit signals are part of the edge.
- Because `riskMaxHoldBars` is present but `riskMaxHoldEnabled` is false, the value `10` is inert in the base run.
- Because `pairTrendInvalidationEmaPeriod` and `pairTrendInvalidationSlopeBars` were present in the exported config but `pairTrendInvalidationExitEnabled` was false, those values were inert in the base run. They are now legacy experiment fields, not active settings.

This explains why Pair Trend Invalidation and max-hold-style experiments can damage performance. They replace the mined strategy's native exit distribution with a generic early-exit rule. The original edge may require tolerating temporary adverse movement until either fixed TP or the strategy's own exit signal resolves the trade.

## Tested Thesis 1: Entry Confirmation

Entry-confirmation thesis: pair EMA position, period 96.

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 70/110 (64%) | Losing 31 | No Trades 9 | Failed 0 | Verdicts STRONG 2, SOLID 13, MARGINAL 25, THIN 52, LOSING 9
SUMMARY | Total Net $-219865.50 | Avg Net/Pair $-1998.78 | Median Net +$200.62 | Best NEAR+BNB +$2808.63 | Worst ZEC+APT $-161111.12
SUMMARY | Trades 1673 | Trade WR 96% | Avg/Trade $-131.42 | PF 0.23 | Median Trades 13 | Median AvgTrade +$28.13 | Median Sharpe 0.15 | Median DD 14%
SUMMARY | Median Hold 129b (21d) | Median MaxHold 1050b (175d) | Median Exposure 29%
```

Entry-confirmation thesis: pair EMA slope, period 96.

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 70/110 (64%) | Losing 31 | No Trades 9 | Failed 0 | Verdicts STRONG 2, SOLID 13, MARGINAL 25, THIN 52, LOSING 9
SUMMARY | Total Net $-219865.50 | Avg Net/Pair $-1998.78 | Median Net +$200.62 | Best NEAR+BNB +$2808.63 | Worst ZEC+APT $-161111.12
SUMMARY | Trades 1673 | Trade WR 96% | Avg/Trade $-131.42 | PF 0.23 | Median Trades 13 | Median AvgTrade +$28.13 | Median Sharpe 0.15 | Median DD 14%
SUMMARY | Median Hold 129b (21d) | Median MaxHold 1050b (175d) | Median Exposure 29%
```

Result: the entry confirmations slightly improved the aggregate and reduced trades, but they did not touch the worst loss. This shows plain entry filtering did not address the catastrophic tail. It does not prove that a generic exit overlay is the right fix.

User observation: adding a max-hold bar cap worsened performance. That suggests a blind time cap cuts good mean-reversion holds too often. Pair Trend Invalidation later showed the same failure pattern in a different form.

## Tested Thesis 2: Pair Trend Invalidation Exit

Implementation tested:

- Risk Management on.
- Pair Trend Invalidation on.
- EMA Period 96.
- Slope Bars 1 or 2.
- Exit is loss-only.
- For shorts: close when pair close is above EMA and EMA is rising.
- For longs: close when pair close is below EMA and EMA is falling.

Result with EMA Period 96, Slope Bars 1:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 37/110 (34%) | Losing 64 | No Trades 9 | Failed 0 | Verdicts SOLID 6, MARGINAL 15, WEAK 4, THIN 26, LOSING 50
SUMMARY | Total Net $-19927.57 | Avg Net/Pair $-181.16 | Median Net $-57.73 | Best WLD+ETH +$799.55 | Worst DOGE+BNB $-2726.57
SUMMARY | Trades 4525 | Trade WR 53% | Avg/Trade $-4.40 | PF 0.83 | Median Trades 29 | Median AvgTrade $-2.47 | Median Sharpe -0.13 | Median DD 3.8%
SUMMARY | Median Hold 10b (1.7d) | Median MaxHold 59b (9.8d) | Median Exposure 5.6%
```

Result with EMA Period 96, Slope Bars 2:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 38/110 (35%) | Losing 63 | No Trades 9 | Failed 0 | Verdicts SOLID 6, MARGINAL 16, WEAK 4, THIN 26, LOSING 49
SUMMARY | Total Net $-20673.69 | Avg Net/Pair $-187.94 | Median Net $-66.96 | Best WLD+ETH +$779.58 | Worst DOGE+BNB $-2700.98
SUMMARY | Trades 4420 | Trade WR 55% | Avg/Trade $-4.68 | PF 0.83 | Median Trades 29 | Median AvgTrade $-3.68 | Median Sharpe -0.16 | Median DD 4.2%
SUMMARY | Median Hold 11b (1.8d) | Median MaxHold 63b (11d) | Median Exposure 5.7%
```

Observed delta versus baseline:

| Metric | Baseline | Trend Exit 96/1 | Trend Exit 96/2 | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Total Net | -$225,693.05 | -$19,927.57 | -$20,673.69 | Tail loss was clipped, but the strategy edge was damaged. This is diagnostic evidence, not success. |
| Worst Pair | -$161,111.12 | -$2,726.57 | -$2,700.98 | Catastrophic loser was removed. |
| Median Net | +$190.40 | -$57.73 | -$66.96 | Rule over-exits normal pairs and hurts the middle of the distribution. |
| Profitable Pairs | 69/110 | 37/110 | 38/110 | Many formerly small winners became small losers. |
| Trades | 1,762 | 4,525 | 4,420 | Exit creates heavy churn/re-entry. |
| Trade WR | 96% | 53% | 55% | Exit is firing much earlier and much more often. |
| PF | 0.23 | 0.83 | 0.83 | Still losing, but much less broken than baseline. |
| Median Hold | 127b | 10b | 11b | Hold time collapsed. |
| Median Exposure | 31% | 5.6% | 5.7% | Strategy is mostly out of market. |

Interpretation:

- Pair Trend Invalidation mechanically clips the catastrophic tail, but it does not improve the strategy edge.
- The degraded median net, degraded win rate, lower profitable-pair count, much higher trade count, and collapsed hold time mean this rule is behaving like a blunt early-exit or max-hold proxy.
- Slope Bars 1 and 2 are almost equivalent; increasing slope from 1 to 2 did not fix over-exiting.
- The current rule turns the system from rare catastrophic losses into many small losses. That is not a production-ready improvement.
- Do not treat "worst pair improved" as sufficient proof. For this workflow, median net, top Finder competitiveness, win rate, and profitable-pair count matter because the base strategy came from Finder data mining and already had a fragile edge.

Additional user observation after Finder testing:

- Running Pair Trend Invalidation inside Finder produced top performers that were still bad and could not compete with the original short-only strategy found by Finder.
- This is strong evidence that the overlay is incompatible with the mined strategy's edge, not merely a parameter-tuning issue.
- The base short-only strategy likely depends on allowing many positions time to mean-revert. Pair Trend Invalidation exits those trades too early, then allows churn/re-entry.

## Implementation Status

The removed thesis controls were the three entry-confirmation strategy options:

- Pair EMA Position
- Pair EMA Slope
- Pair Recent Return

Pair Trend Invalidation was implemented, tested, and then removed from the active UI/settings/backtest engine after the results showed it was a failed performance overlay.

Historical behavior of the removed rule:

- For a short position, it exited only when the trade was losing, pair close was above EMA, and EMA was rising versus `Slope Bars` ago.
- For a long position, it used the opposite condition.
- It respected the existing minimum-hold setting.
- It was TypeScript-engine only.
- It closed trades with the existing `time_stop` exit reason.

Removal status:

- Removed from Settings UI.
- Removed from DOM/settings contracts.
- Removed from normalized backtest settings and TypeScript types.
- Removed from Rust sanitizer.
- Removed from indicator precompute and backtest exit handling.
- Removed from feature-specific tests.
- This document keeps the experiment as research evidence only.

## Research Conclusion

Revised conclusion: Pair Trend Invalidation is a failed performance overlay for this strategy family.

It is still useful as a diagnostic experiment because it shows the catastrophic loss can be clipped. But the broader behavior is too similar to max-hold experimentation: it prevents long-duration losers by also preventing long-duration recoveries. Since the base short-only strategy was discovered by Finder and the overlay also fails inside Finder, this is not just a Batch aggregation artifact.

Do not continue by simply adding more sensitivity to Pair Trend Invalidation. The next work should first diagnose the original Finder-discovered strategy's trade anatomy, then design a filter that preserves the mined edge.

## Rejected Or Low-Priority Follow-Up Ideas

These ideas are not recommended as immediate implementation work. They are listed so future AI agents do not repeat the same failed direction without first proving the original strategy's trade anatomy.

Do not implement any of these until diagnostics prove baseline winners rarely suffer the same condition before recovering.

### Loss-Thresholded Trend Invalidation

Only allow Pair Trend Invalidation after the trade is losing by at least a configured amount.

Purpose:

- Avoid closing tiny, noisy losses that would normally mean-revert.
- Keep the catastrophic-tail protection.

Candidate parameters:

- `Min Loss %`, default candidate values: 2%, 5%, 8%.
- EMA Period: keep 96 for the first test.
- Slope Bars: keep 1 for the first test, because 1 and 2 were similar.

Status:

- Low priority. This is an attempt to rescue a failed overlay.
- If baseline winners often enter temporary drawdown before recovery, a loss threshold will still cut the core edge.

### EMA Distance Buffer

Only exit a losing short when close is above EMA by more than a buffer, not merely above EMA.

Purpose:

- Reduce whipsaw around the EMA.
- Require clearer trend invalidation before exiting.

Status:

- Low priority. This is still an EMA early-exit overlay.
- Only test it if diagnostics show EMA crosses are rare among baseline winners but common among catastrophic losers.

### Consecutive Invalidation Bars

Require invalidation to persist for N bars before closing.

Purpose:

- Avoid one-bar EMA pokes.
- Keep the rule simple and deterministic.

Implementation caution:

- This is stateful per open position. It should be implemented carefully in the backtest engine, not as a stateless single-bar helper only.
- Low priority unless diagnostics show one-bar noise, rather than the overlay concept itself, was the failure.

### Minimum Hold Before Invalidation

Use the existing minimum-hold rule with Pair Trend Invalidation.

Purpose:

- Prevent the new exit from immediately cutting fresh entries.

Status:

- Low priority. User already observed max-hold style constraints hurt performance; minimum hold only delays the same failed early-exit concept.

## Recommended Next Work

Do not implement another exit overlay immediately.

First, add or use diagnostics on the baseline short-only strategy. Compare against failed Trend Invalidation behavior only as a secondary control:

- Winning-trade drawdown before recovery.
- Losing-trade drawdown before final loss.
- Trade PnL by hold-duration buckets.
- Count of trades that Trend Invalidation exited which would have become winners in the baseline.
- Re-entry churn after invalidation exits.
- Per-pair contribution to total net and worst-trade loss.
- Which baseline losses had no native strategy exit before the catastrophic move.
- Whether baseline winners commonly cross above the 96 EMA before later reaching fixed TP.

The next thesis should be selected from those diagnostics. The likely better direction is not "exit earlier whenever trend flips"; it is "identify pairs/regimes/trades that become unrecoverable and avoid new exposure there while leaving normal mean-reversion holds alone."

Candidate next implementation after diagnostics:

1. Tail diagnostics in Batch/Finder exports: expose worst trade, longest losing hold, max adverse excursion, and recovery-after-drawdown counts.
2. Worst-trade-aware Finder ranking: rank candidates by median performance plus worst-trade or tail-loss penalty, rather than patching the selected strategy afterward.
3. Pair/regime quarantine: stop taking new shorts for a pair after severe adverse behavior or repeated native-exit failure, with a cooldown.
4. Native-exit failure analysis: identify cases where the strategy's own signal exit failed to arrive before a major adverse regime move.

## Batch Test Protocol For Next Research

Run future tests through the Batch backtest menu on the same 110-pair universe, but do not use Pair Trend Invalidation as the next direction.

Recommended order:

1. Baseline, no thesis.
2. Add diagnostics for baseline trade anatomy.
3. Compare baseline winners versus baseline losers by adverse excursion, hold duration, native signal exits, and fixed-TP recovery.
4. If diagnostics show only a small set of pairs/regimes cause unrecoverable shorts, test pair/regime quarantine or Finder tail-risk ranking.
5. Only revisit an early-exit rule if diagnostics prove baseline winners rarely suffer the same condition before recovering.

Compare:

- Worst pair net profit, especially ZEC+APT.
- Total net.
- Profit factor.
- Median net per pair.
- Trades and exposure.
- Median max hold.
- Number of profitable pairs.

Success is not just "more profitable pairs." The proof target is a balanced improvement:

- Worst pair remains far smaller than baseline.
- Total net materially improves versus baseline.
- Median net stays positive or at least does not degrade materially from baseline.
- Top Finder results with the thesis can compete with the original short-only Finder result.
- Trades do not more than double versus baseline.
- Win rate and profitable-pair count do not collapse.

## Open Questions

- Why did DOGE+BNB become the new worst pair after the catastrophic ZEC+APT loss disappeared?
- Are the many new small losses caused by immediate re-entry after invalidation exits?
- Would a cooldown after trend invalidation help, or would it miss profitable reversion entries?
- Is loss threshold better expressed as raw percentage, ATR multiple, or pair-volatility z-score?
- Would a pair/regime quarantine preserve median edge better than closing existing trades?
- Should Finder ranking penalize worst-trade/tail risk directly so weak candidates are rejected before Batch aggregation?

## Tail Diagnostics (Batch)

A diagnostics-only cut landed in the Batch path to answer the open questions
above **without** changing any trade, engine path, setting, or overlay. Every
metric is a pure function of `(OHLCV, trades)` that the Batch runner already
retains per pair.

### Where it surfaces

- A new `SUMMARY | Tail ...` line appended after the hold/exposure line in the
  Batch summary block (DOM and clipboard Copy).
- Per-pair pipe rows now include `Worst`, `MAE`, `LL-Hold`, `EMA96-x` fields.
- The Copy button now appends the per-pair rows after the SUMMARY block, so a
  clipboard copy captures both cross-pair tail rollups and per-pair tail detail.

### Cross-pair SUMMARY fields

```text
SUMMARY | Tail | Worst Trade {pnl} ({pair}) | Max MAE {pct}% | LL-Hold {bars}b | EMA96-x Win/Lose {n}/{n} ({pct}%)
```

- `Worst Trade` — most negative single-trade PnL across all pairs, and the pair it occurred in.
- `Max MAE` — largest single-trade max adverse excursion (cross-trade, cross-pair max).
- `LL-Hold` — longest losing hold in bars across all pairs.
- `EMA96-x Win/Lose` — of all trades that crossed the adverse EMA(96)-rising
  condition during their hold, how many still won vs lost. This is the literal
  research gate: if winners frequently cross the failed 96/1 condition and
  recover, an exit-on-cross overlay must not be revived.

### Per-pair fields (`BatchTailStats`)

- `worstTradePnl` / `worstTradePnlPercent` — worst single trade in the pair.
- `worstTradePairContributionPct` — worst trade PnL as a share of pair net.
- `maxAdverseExcursionPct` — cross-trade max MAE in the pair.
- `longestLosingHoldBars` / `longestLosingHoldDays` — longest losing hold.
- `losingMaeAvgPct` — mean MAE over losing trades (MAE before final loss).
- `winningMaeAvgPct` — mean MAE over winning trades (MAE before recovery).
- `exitReasonCounts` — exit-reason tally restricted to LOSING trades (native
  signal-exit failure analysis).
- `emaCrossWinnersCount` / `emaCrossLosersCount` / `emaCrossWinnerRatePct` —
  the EMA(96) adverse-cross control, per pair.

### Key definitions

- `EMA_CROSS_PERIOD = 96` is pinned to match the historical Pair Trend
  Invalidation 96/1 and 96/2 experiments, so the cross counts are directly
  comparable to those failed overlay runs.
- "Crossed" for a short = at least one in-hold bar where `close > EMA(96)` AND
  `EMA(96)` is rising vs the prior bar (the exact failed 96/1 condition). For
  longs the mirror: `close < EMA(96)` AND EMA falling.
- MAE is direction-aware and computed over `[entryIndex, exitIndex]`
  inclusive. Shorts: `(high - entryPrice) / entryPrice`; longs:
  `(entryPrice - low) / entryPrice`. Clamped to >= 0.
- `ENTRY_RUNUP_WINDOW = 96` is pinned to match `EMA_CROSS_PERIOD` so the
  ex-ante regime filter (entry-runup) and the post-entry cross control read
  on the same horizon (96 × 4h = 16 days).

### Entry-Runup (ex-ante regime separability diagnostic)

`entryRunupPctMedianWinners` / `entryRunupPctMedianLosers` answer the only
remaining viable-lever question after Findings 1-4: **could an ex-ante
base-leg regime filter have prevented the catastrophic shorts from being
entered?**

For each trade, entry-runup is the backward-looking analog of MAE: over the
`ENTRY_RUNUP_WINDOW` bars ENDING at entry (`[entryIndex - 95, entryIndex]`),
the max % adverse move relative to the window's first close. For a short,
that is "how parabolic has the base leg already been when we short?" The
per-pair medians are reported over winners and losers separately; the Tail
SUMMARY line reports `EntryRunup Win/Lose {wPct}%/{lPct}%` as the median
across pairs of each pair's winner/loser median.

Interpretation framework (this is the decision rule for whether to pursue
Dir 3 ex-ante quarantine):

- **If `Lose` >> `Win`** (losers entered mid-parabola, winners entered from
  calm regimes): an ex-ante filter IS viable. The catastrophic entries had a
  distinguishable regime signature at entry time. Proceed to design a filter
  threshold, but apply the credibility constraint below.
- **If `Lose` ≈ `Win`** (both entered from similar regimes): no ex-ante
  filter can separate them. Dir 3 is ruled out, same as the signal-overlay
  family. The catastrophic base-leg moves began AFTER entry, not before.
- **If `Win` >> `Lose`** (winners entered from more parabolic regimes than
  losers): an ex-ante filter would be backwards — it would block winners and
  admit losers. Strong signal of curve-fitting if the data were read the
  other way.

**Credibility constraint (ex-post curve-fitting on ZEC).** The catastrophic
losers are concentrated in ZEC-base pairs (Finding 3). Any filter threshold
calibrated on the full dataset — including ZEC — is ex-post: it "discovers"
that ZEC was parabolic after seeing the ZEC losses. To be credible, a
threshold must be calibrated on NON-ZEC pairs (or a non-overlapping earlier
window) and then applied to ZEC as an out-of-sample test. A filter that only
works because it was tuned to reject ZEC has no live performance basis.

This diagnostic is still **read-only**. It does not implement a filter; it
provides the evidence a filter would need to be worth implementing.

### What this is NOT

- This is **diagnostic only**. It does not revive Pair Trend Invalidation or
  any variant (loss-thresholded EMA invalidation, EMA buffer, consecutive
  invalidation bars, minimum-hold-before-invalidation). Those remain rejected
  until the diagnostics prove baseline winners rarely cross the adverse
  condition before recovering.
- It changes no `Trade` / `PositionState` type, no backtest engine path, no
  Rust sanitizer, no settings, no DOM-id contract.

### Next research step

Run the FETBNB / 4h / short-only baseline Batch (strategy params `lookback:
147`, `gradientPercentileMin: 0.99`; `executionModel: next_open`; fixed TP
4.26%; `disableSignalExits: false`) and read the new Tail line:

- If `EMA96-x Win/Lose` shows winners routinely cross and recover, an
  exit-on-cross overlay is ruled out — pursue Finder tail-risk ranking or
  pair/regime quarantine instead.
- If `losingMaeAvgPct` is large while `winningMaeAvgPct` is small, the edge
  separates cleanly on excursion and a quarantine-on-MAE thesis is worth
  testing.
- If `exitReasonCounts` for catastrophic pairs is dominated by `end_of_data`
  or `signal`, the native exit failed to fire in time — pursue native-exit
  failure analysis, not an early-exit overlay.

## Findings (2026-06-29 baseline run)

Baseline Batch run on the short-only synthetic-pair strategy (params `lookback:
147`, `gradientPercentileMin: 0.99`; `executionModel: next_open`; fixed TP
4.26%; `stopLossEnabled: false`; `disableSignalExits: false`) across 110 pairs.
The Tail diagnostics line produced three conclusive results.

### Headline numbers

```text
SUMMARY | Tail | Worst Trade $-161231.49 (ZEC+APT) | Max MAE 19458.8% | LL-Hold 12114b | EMA96-x Win/Lose 627/64 (91%) | Loser-Exit {...}
```

- **`EMA96-x Win/Lose 627/64 (91%)`**: 627 *winning* trades crossed the exact
  adverse condition (close above a rising EMA(96)) that Pair Trend
  Invalidation 96/1 exited on; only 64 losers crossed it. This is the literal
  proof the open question demanded before any overlay could be revisited.
- **Worst trade is the entire headline loss**: `ZEC+APT` alone is
  `$-161111.12` of the `$-225685` total. The three worst pairs (ZEC+APT,
  ZEC+DOGE `$-36187`, ZEC+ETH `$-26131`) account for ~99% of the loss.
- **Max MAE 19458.8%** (ZEC+APT) — a single short rode a ~195× adverse
  excursion in the base leg before closing.

### Finding 1 — signal-based exits are ruled out (conclusive)

The EMA-cross control is unambiguous. Pair Trend Invalidation 96/1 exited on
`close > EMA(96)` AND `EMA(96) rising`. Of 1762 baseline trades, **627 winners
crossed that condition and still hit +4.26% TP; only 64 losers crossed it.**
The 96/1 result (Profitable 37/110, Median Net `$-57.73`) is fully explained:
it sacrificed 627 winners to dodge 64 losers.

Per-pair, nearly every profitable pair shows cross rates of 10/10, 16/17,
8/8, 20/20 — winners *routinely* cross the adverse condition and recover. An
exit-on-cross overlay is therefore structurally incapable of preserving the
edge. This rules out:

- Pair Trend Invalidation (any period).
- Loss-thresholded EMA invalidation.
- EMA buffer / consecutive invalidation bars / minimum-hold-before-invalidation.

These variants all gate an exit on a condition the winners already satisfy
mid-hold. Do not revisit without new evidence that the winner-cross rate has
materially changed (e.g. a different strategy, interval, or pair universe).

### Finding 2 — MAE does NOT separate winners from losers

This is the negative result that rules out the broader adverse-move overlay
family. Catastrophic losers have extreme MAE, but so do many 100%-WR winners:

| Pair | Verdict | MAE |
|---|---|---|
| ZEC+APT | Losing | 19458.8% |
| ZEC+DOGE | Losing | 3890.6% |
| FET+BTC | Profitable (100% WR) | 3218.1% |
| FET+BNB | Profitable (97% WR) | 1913.8% |
| NEAR+BTC | Profitable (100% WR) | 1238.8% |
| SOL+BNB | Profitable (94% WR) | 1378.0% |
| CRV+BTC | Profitable (96% WR) | 754.6% |

FET+BTC held through a **32× adverse** excursion on a winning trade and still
hit TP. Any MAE or adverse-move stop below ~3,200% kills real winners; the
only "separator" lives in an absurd 3,200%–19,000% band built from ~5 data
points. Not actionable. The mined edge *requires* tolerating extreme adverse
movement — that is what mean-reversion shorting of synthetic ratios is.

### Finding 3 — the tail is a ZEC-base-leg regime artifact

The loss is not spread across the pair universe; it is concentrated in pairs
whose base leg went vertical (ZEC 2024-25 moonshot):

- All 110 pairs: `$-225685`.
- 14 ZEC-base pairs: `≈ $-225755`.
- **96 non-ZEC pairs: `≈ +$69`** (essentially break-even; +$190 median net,
  63% profitable-pair rate — the mined edge is intact outside ZEC).
- Minus the 3 worst ZEC pairs (APT, DOGE, ETH): `≈ -$2256`.

ZEC is not uniformly toxic either: ZEC+BNB `+$2475`, ZEC+NEAR, ZEC+FET,
ZEC+WLD, ZEC+ENA are profitable. The damage is ZEC *during its parabolic
regime* paired with specific quotes that did not also rally.

Crucially, post-loss suspension does not help this tail: ZEC+APT has only 4
trades, so an in-sample "stop taking new shorts after a severe loss" rule
saves roughly nothing — the catastrophic trade already happened. Any
quarantine must be **ex-ante** on the base-leg regime (skip pairs whose base
leg is exhibiting parabolic behavior), not ex-post on the pair's own loss
history.

### Finding 4 — most of the tail is unrealized end-of-data mark-to-market

The `Loser-Exit` tally is the decision-relevant signal:

```text
SUMMARY | Tail | ... | Loser-Exit {end_of_data: 48, signal: 18}
```

**73% of losing trades (48/66) never closed — they were still open at backtest
end and were marked to the endpoint.** Only 18 losers closed via the native
signal. The split is not random; it tracks severity:

| Pair | Worst trade | Loser-Exit | Realized? |
|---|---|---|---|
| ZEC+APT | $-161231.49 | end_of_data: 1 | **No — open at endpoint** |
| ZEC+DOGE | $-36588.60 | signal: 1 | Yes — native exit fired |
| ZEC+ETH | $-27061.34 | end_of_data + signal | Mixed |
| DOGE+BTC | $-6944.94 | end_of_data: 1 | No — open at endpoint |
| SUI+APT | $-8088.48 | end_of_data: 1 | No — open at endpoint |

The single biggest item in the entire `$-225685` headline — **ZEC+APT at
`$-161231.49`, ~71% of the total loss — is endpoint mark-to-market on an open
short, not a realized trade exit.** The fixed-TP / native-signal machinery
never got a chance to fire on it; the position was simply open when the
backtest reached the last available bar.

Implications, in order of importance:

1. **The headline is endpoint-dependent.** A different backtest cutoff could
   produce a materially different total (better *or* worse — ZEC could have
   kept rising, or reverted). Treat `$-225685` as a snapshot, not a constant.
2. **The realized-loss picture is far less catastrophic than the headline.**
   Of the three worst ZEC pairs, only ZEC+DOGE (`$-36187`) was closed by the
   strategy's own signal at a loss. The `$-161k` and a large share of the
   `$-26k` (ZEC+ETH) are MTM on open positions.
3. **The catastrophic trades did not "fail to exit in time" — they did not
   exit at all.** Finding 3's position-survival framing was right in mechanism
   but imprecise on this point. The worst loser is a still-open short in a
   parabolic-base-leg pair, MTM'd at an arbitrary endpoint.
4. **This does not rescue the strategy.** "Still holding a short whose base
   leg went vertical" is the worst possible state; closing it realizes the
   loss. But it *does* mean the edge question (does the strategy work?) and
   the tail question (how bad is the worst case?) are partially separable:
   the realized edge outside the open-ZEC positions is what Finding 3 measured
   (non-ZEC net `≈ +$69`), and the tail is dominated by endpoint MTM on a
   small number of open positions.

This sharpens Dir 3: any rule that closes open positions under some condition
*could* act on the catastrophic open ZEC trades — but only at the MTM loss it
would realize at that moment, which per Finding 2 is observationally
identical to the winners' MTM at their worst. The signal-overlay ruling
stands; the end-of_data finding does not reopen it.

### Finding 5 — ex-ante regime filtering is also ruled out (entry-runup)

The entry-runup diagnostic (`EntryRunup Win/Lose {wPct}%/{lPct}%`) is the
last-lever test for Dir 3. Result:

```text
SUMMARY | Tail | ... | EntryRunup Win/Lose 6.8%/8.1%
```

**Losers entered from regimes only 1.3 percentage points more parabolic than
winners (8.1% vs 6.8%).** Per the interpretation framework, this is the
`Lose ≈ Win` case: no ex-ante regime filter can separate them at the
population level. The catastrophic base-leg moves began AFTER entry, not
before.

The catastrophic pairs are the strongest evidence against a filter — they
invert the expected pattern:

| Pair | Worst trade | EntryRunup Win/Lose | Pattern |
|---|---|---|---|
| ZEC+APT | $-161231 | 28.3% / 34.5% | Losers higher, but winners already at 28% — no clean threshold |
| ZEC+DOGE | $-36589 | **4.2% / 8.5%** | **Backwards**: losers entered calmer than winners. The 3890% MAE came after entry from a calm 8.5% regime |
| ZEC+ETH | $-27061 | **6.6% / 2.9%** | **Backwards**: losers entered at 2.9%, winners at 6.6% |
| DOGE+BTC | $-6945 | **4.6% / 3.1%** | **Backwards**: losers calmer than winners |
| DOGE+CRV | $-4917 | 222% / 569% | Both extreme; winners at 222% means any threshold below 569% kills winners |

Three of the five worst pairs have losers entering from *calmer* regimes
than winners. A filter calibrated on this data would be backwards — it would
block winners and admit losers. The credibility constraint (calibrate on
non-ZEC, apply to ZEC out-of-sample) is moot: the non-ZEC aggregate itself
shows `Lose ≈ Win`, so there is no threshold to calibrate.

This rules out Dir 3 (ex-ante base-leg quarantine). Combined with Findings 1,
2, and 4, every signal/regime-level risk control is now ruled out:

- Signal-overlay exits (EMA-cross, MAE-threshold, adverse-move): ruled out (F1, F2).
- Post-loss pair quarantine: ruled out (F3, F4 — catastrophic trades are open, small N).
- Ex-ante base-leg regime filter: ruled out (F5).

### Structural conclusion

At peak adverse, the eventual winner (FET+BTC at 32× down) and the eventual
catastrophic loser (ZEC+APT at 195× down) are observationally identical on
every signal read available at the time. No signal-based exit can distinguish
them. The catastrophic losses are a **position-survival artifact**: shorting
a ratio whose base leg goes vertical, with no stop, leaves the position open
to accrue mark-to-market losses far exceeding account equity. Per Finding 4,
~71% of the headline loss is the single worst such open position MTM'd at the
backtest endpoint — unrealized, but real if ever closed.

This means the only viable risk controls are non-signal, and after Finding 5
even the ex-ante regime filter is off the table:

1. **Ex-ante base-leg regime filter** — **ruled out by Finding 5**. Losers
   and winners entered from statistically indistinguishable regimes
   (`EntryRunup Win/Lose 6.8%/8.1%`); the catastrophic pairs invert the
   expected pattern. There is no threshold to calibrate.
2. **Hard per-trade dollar loss cap / max-open-loss** — would close the open
   ZEC positions, but per Finding 2 any cap tight enough to catch ZEC+APT
   mid-hold also catches FET+BTC-class winners at their worst. Distinguish
   two forms: a *dollar* cap (notional-bounded, outside strategy-overlay
   scope) vs a *percent* cap (signal-based, ruled out by Finding 2).
3. **Position sizing that bounds mark-to-market survival** — e.g. cap the
   dollar notional of any single short so a vertical base leg cannot book an
   unrecoverable loss; outside the strategy-overlay scope. **This is the only
   remaining risk-control family not ruled out by the diagnostics.** It is
   not a strategy-overlay change; it is a portfolio-construction change.

### Overall conclusion

The investigation has ruled out every signal/regime-level risk control:

- The mined edge requires tolerating extreme adverse movement (Finding 2) —
  winners routinely sit on 1000%+ MAE and recover. Any percent-based stop
  destroys the edge.
- The catastrophic losers are observationally identical to winners at peak
  adverse (F2), at entry (F5), and in mid-hold trend state (F1). No signal
  read available at decision time separates them.
- ~71% of the headline loss is endpoint MTM on a single open ZEC+APT
  position (Finding 4) — not a realized trade exit.
- The tail is concentrated in ZEC-base pairs during the 2024-25 ZEC moonshot
  (Finding 3), but ZEC is not uniformly toxic and ex-ante filtering cannot
   isolate the bad regime.

The strategy cannot be de-risked at the signal or pair-selection level
without destroying the mined edge. The only remaining lever is position
sizing: bound the dollar notional of any single short so that a vertical
base leg cannot book an unrecoverable loss. That is a portfolio-construction
decision outside the strategy-overlay scope this research was scoped to.

### What is now observable in the Batch output

After this cut, the per-pair pipe row and the Tail SUMMARY line expose:

- `Worst`, `MAE`, `LL-Hold`, `EMA96-x Win/Lose` per pair (prior cut).
- `Loser-Exit {reason: n, ...}` per pair and in the aggregate Tail line — the
  native-exit failure signal (Dir 4). For catastrophic losers this reveals
  whether the native signal exit fired, the trade hit `end_of_data`, or a
  `stop_loss`/`take_profit` target was touched.
- `EntryRunup {wPct}%/{lPct}%` per pair and `EntryRunup Win/Lose {wPct}%/{lPct}%`
  in the aggregate Tail line — the ex-ante regime separability diagnostic
  (Dir 3 viability test). Median trailing base-leg runup at entry, over
  winners vs losers.

### Status of the listed implementation directions

- Dir 1 (tail diagnostics in exports) — **done**.
- Dir 2 (Finder tail-risk penalty) — **weakened** by Finding 2/3. The
  worst-trade signal is dominated by small-N pairs; a naive penalty rejects
  good candidates that happen to land one ZEC-like trade. If pursued, must
  use a robust statistic (e.g. worst-trade-to-median-trade ratio) gated on
  sufficient trade count.
- Dir 3 (pair/regime quarantine) — **ruled out by Finding 5**. The ex-ante
  base-leg regime filter was the only viable quarantine form (post-loss
  suspension ruled out by F3/F4), but `EntryRunup Win/Lose 6.8%/8.1%` shows
  losers and winners entered from indistinguishable regimes, and the
  catastrophic pairs invert the expected pattern. No threshold to calibrate.
- Dir 4 (native-exit failure analysis) — **answered**. `Loser-Exit` shows
  48/66 losers (73%) — including the single worst trade — never exited and
  were MTM'd at endpoint; only 18 closed via the native signal. The native
  exit did not "fail to fire in time" on the worst trade; it had no chance to
  fire because the trade was still open at backtest end.
- Signal-overlay family (EMA-cross, MAE-threshold, adverse-move) — **ruled
  out** by Findings 1 and 2. Finding 4 does not reopen this: an overlay that
  closes open positions would realize the same MTM loss that makes the
  winners and losers observationally identical at peak adverse. Do not
  revisit without a changed strategy, interval, or pair universe.

## Scale-out TP (exit-side experiment)

Following the ATR-TP experiment (which cut the tail 67% but at a median-edge
cost), the **scale-out TP** feature lands as the Idea-1 design from the exit
brainstorm: take profit in two chunks to bank base edge quickly on a partial
while leaving upside optionality on the runner.

### What it is

Three new settings under `riskMode: 'percentage'`:

- `takeProfitPercentA` — TP-A level (% from entry). 0 disables scale-out.
- `takeProfitPercentB` — TP-B level (% from entry, the remainder's TP). 0
  falls back to base `takeProfitPercent`.
- `takeProfitSizeAPercent` — fraction (1-99) of the position closed at TP-A.

### How it executes

Reuses the engine's existing **partial-close flow** — no new multi-Trade
mechanism was needed. When TP-A is hit:

1. `processPositionExits` returns a partial trigger (`exitReason: 'scale_out_a'`,
   fractional `exitSize`) BEFORE the full-TP check.
2. `recordExit`/`recordExitFull` shrink `position.size`, accumulate
   `realizedPnl`, and keep the position open via the same path used by the
   legacy `'partial'` exit.
3. The remainder rides until TP-B (or native signal / SL / EOD).

A scale-out round-trip therefore produces **two `Trade` records**: one
`'scale_out_a'` partial and one final-exit trade. Per-chunk PnL is computed
independently by `calculateTradeExitDetails` with entry commission amortized
per-share, so the two chunks sum exactly to what a single full-TP close at
the weighted-average price would yield.

### What it is NOT

- It does **not** cap downside. Scale-out is a TP-shape control, not a stop.
  The catastrophic-tail risk on the remainder is unchanged — scale-out banks
  base edge faster but leaves the runner exposed to the same adverse moves
  Findings 1-5 documented.
- It does **not** revive the legacy dead `partialTakeProfitAtR` /
  `partialTakeProfitPercent` fields. Those stay zeroed (5 places). Scale-out
  is net-new (`takeProfitPercentA/B` + `takeProfitSizeAPercent`) with a
  distinct `'scale_out_a'` exit reason.
- It is **Rust-unsupported** — `requiresTypescriptEngine` forces TS when
  `takeProfitPercentA > 0`, and the sanitizer strips the three keys from the
  Rust settings. The TS engine is the only path that runs scale-out.

### Mining setup

Set `riskMode: percentage`, enable TP, set the three scale-out fields, and
unfreeze Risk Management in Finder. All three knobs randomize independently
alongside the existing `takeProfitPercent`, so a scale-out sweep competes
directly against the baseline-TP and ATR-TP results. The non-ZEC universe
remains the primary scoring surface (per Finding 3).

### Result — scale-out is a regression (Finding 6)

Scale-out was mined and the result was **worse than baseline**, not better.
The looser remainder TP (TP-B > TP-A) systematically deepened the tail
because the remainder had to travel *further* to exit, and on structurally
adverse pairs that remainder is what becomes the catastrophic trade.

```text
ZEC+APT | Losing | Net $-209544.48 | Worst $-209611.42 | MAE 25291.7% | Loser-Exit {end_of_data: 1}
```

The worst pair grew from baseline's `$-161k` to **`$-209k`**; the worst trade
and Max MAE both exceeded baseline. The `Loser-Exit` tally across all pairs
was `{end_of_data: 46, signal: 22}` — **zero `take_profit` loser-exits**,
versus ATR-TP's `{take_profit: 109, end_of_data: 35, signal: 28}`. Scale-out
losers never hit any TP; they ran to EOD or signal.

### TP family comparison (Finding 6)

Three TP experiments are now on record. Tighter exits won; looser exits lost.

| TP family | Total Net | Worst pair | Worst trade | Trades | Verdict |
|---|---|---|---|---|---|
| Scale-out (looser remainder) | `$-326k` | `$-209k` | `$-209k` | 2756 | worst |
| Baseline 4.26% fixed | `$-226k` | `$-161k` | `$-161k` | 1762 | middle |
| **ATR-TP (tighter, adaptive)** | **`$-75k`** | **`$-27k`** | **`$-27k`** | 4420 | **best by far** |

Direction matters more than shape. The "let winners run" intuition (Idea 1's
premise) does not transfer to this strategy: the runner optionality is
captured by the losers, not the winners, because the tail lives in pairs
where price moves against you persistently. Wider remainder TPs give the
losing runner more room to ride into the catastrophe.

**Implication:** stop exploring the looser-TP direction (scale-out,
MFE-trailing, wider TP-B). The viable exit thesis is **tighter,
volatility-adaptive exits** (ATR-TP and its variants). Scale-out stays in the
codebase as an option for strategies with a different winner/loser structure,
but is a documented negative result for this short-only synthetic-pair family.

## Asset selection as a tail cause (open question, not a finding)

A natural hypothesis after Seeing Finding 3 (ZEC concentration) and the TP
family results: **the problem is bad asset selection, not the strategy.**
The 90%+ trade win rate, ~4% TP, and negative total expectancy fit a story
where most pairs are tradeable but a few structurally adverse base legs
(ZEC moonshot, APT downtrend) produce the entire loss.

This is **partly supported by the data and partly in tension with it**, and
the distinction is load-bearing.

### What the data supports

- Finding 3 quantified the concentration: 96 non-ZEC pairs net `≈ +$69`
  (essentially break-even on total net, +$190 median, 63% profitable-pair
  rate). ZEC-base pairs carry the entire headline loss.
- The TP-family results all hit the same wall (ZEC+APT, ZEC+ETH, DOGE+BTC)
  regardless of TP shape. If asset selection were the cause, this is what
  you'd expect: changing the exit doesn't change *which* pairs blow up.
- APT-bearing pairs are over-represented in the losers (ZEC+APT, FET+APT,
  WIF+APT, NEAR+APT, ENA+APT, WLD+APT) — consistent with APTUSDT's secular
  downtrend being an adverse quote leg for shorts (`base/quote` rises when
  `quote` falls).

### What the data pushes back on

- Finding 5 ruled out an ex-ante pair/regime filter: `EntryRunup Win/Lose
  6.8%/8.1%` showed no entry-time signal separates future winners from
  future losers, and the catastrophic pairs *inverted* the expected pattern
  (ZEC+DOGE losers entered from calmer regimes than winners). So "select
  assets better" has no demonstrated entry-time mechanism on this universe.
- The non-ZEC net being `≈ +$69` across 96 pairs over ~5 years is **not
  actually a positive edge** — it's roughly zero after costs. Even with
  perfect ex-ante ZEC exclusion, the strategy would be marginally
  profitable on median but ~flat on total. That is not a strategy you'd
  trade live; it's a strategy you'd keep mining.
- APT as a toxic quote is post-hoc reasoning until tested out-of-sample.
  Calibrating a "no APT" rule on the dataset that contains the APT losses
  is the same ex-post curve-fitting trap Finding 5 warned about for ZEC.

### What "asset selection" would actually require

To convert the asset-selection hypothesis from a story into a finding, three
things would need to be shown, and none are currently demonstrated:

1. **A pre-trade classifier** that flags structurally adverse pairs *before*
   the loss, calibrated out-of-sample. Finding 5's entry-runup test is the
   existing template and it failed. A non-entry classifier (e.g. secular
   base-vs-quote trend over a multi-month window) is untested but is the
   natural next probe — and it is structurally different from the entry-time
   signals Findings 1/2/5 ruled out.
2. **The classifier must beat random exclusion** on the non-ZEC universe
   (i.e. excluding flagged pairs must materially improve total net there,
   not just remove obvious losers after the fact).
3. **The residual edge after exclusion must be positive**, not break-even.
   Even perfect tail-pair exclusion leaves `≈ +$69` on 96 pairs — the
   strategy needs a real edge, not just a cleaner loss distribution.

### Honest current position

Asset selection is the **only untested direction consistent with all five
findings** (it doesn't rely on a signal that separates winners from losers
at decision time — it removes pairs before any signal is evaluated). That
makes it the highest-priority next probe. But it is an *open question*, not
a finding — the ex-ante classifier that would make it a finding has not been
built or tested, and Finding 5's failure of the entry-time version is a
real caution against assuming a slower classifier will work.

If pursued, the credible design is a **secular-trend regime filter on the
base and quote legs separately** (not the ratio): classify each leg's
multi-month trend, and exclude pairs whose legs are stacked adversely for
shorts (base leg strongly up OR quote leg strongly down). This is a
different signal source from anything Findings 1-5 tested and is the one
lever that could plausibly isolate the structural headwind without
curve-fitting on the ratio's own history. Whether it works is an open
empirical question.

## Summary of what the research has established

- The mined edge is **structurally negative on total net**; the 90%+ trade
  win rate is the mechanism that hides it (capped upside via ~4% TP,
  uncapped downside via no stop), not evidence of profitability.
- Signal-based exits, MAE-based exits, EMA-cross exits, post-loss
  quarantine, and ex-ante entry-regime filters are all **ruled out**
  (Findings 1, 2, 4, 5).
- The tail is concentrated in **structurally adverse base legs** (ZEC
  moonshot, APT downtrend), and ~71% of the headline loss is unrealized
  end-of-data mark-to-market on a single open position (Finding 4).
- Exit-shape experiments confirm **tighter beats looser**: ATR-TP cut the
  tail 67%; scale-out deepened it (Finding 6).
- The one remaining untested direction is **ex-ante asset/leg-regime
  selection**, distinct from the entry-time signals already ruled out. It
  is an open question, not a finding.
- The strategy **cannot be made safe to trade live** by any exit overlay,
  TP shape, or signal read. Position sizing (outside strategy-overlay
  scope) is the only demonstrated lever for bounding the catastrophic tail.



## Phase 0 — Leg-trend asset-selection diagnostic (pre-registered)

This section records the **read-only** Phase 0 protocol for the asset-selection
hypothesis. Phase 0 measures whether a pre-trade leg-trend classifier would
separate catastrophic pairs from the rest, **without building any filter or
changing any trade**. The full backtest runs identically to today; only new
diagnostic columns are added.

### What is measured (per synthetic pair)

For each synthetic pair `BASE+QUOTE` (= `BASE/QUOTE`), the diagnostic computes
each leg's **annualized regression-slope %** over three trailing windows
(60 / 90 / 180 bars at 4h). The regression slope (not endpoint-to-endpoint
move %) is robust to a single adverse bar at either end of the window, which
is the right property for a secular-trend measure.

The headline number is `legStackScore = baseTrendPct - quoteTrendPct`:
- **Positive** = base leg trending up faster (or down slower) than quote leg
  = adverse headwind for shorts of `BASE/QUOTE` (the ZEC-up / APT-down
  mechanism from Finding 3).
- **Negative** = favorable for shorts.

This is a **different signal source** from anything Findings 1/2/5 tested:
those read the ratio or the entry bar; this reads the two underlying tokens
separately over a multi-month window, before any strategy signal fires.

### Where it surfaces (read-only)

- New `SUMMARY | Leg-Trend ...` line in the Batch summary block + Copy, showing
  at the 90-bar headline: median `legStackScore` for profitable vs losing
  pairs, plus a residual-net preview (total net of pairs below the losing-median
  stack score).
- Per-pair `LegStack90b {score}%` field in the pipe row.

### Pre-registered questions (Q1, Q2)

- **Q1 (separation):** does `legStackScore` separate profitable from losing
  pairs at a threshold that is **stable across all three lookbacks** (60/90/180)?
  Stability = the threshold that best separates the two groups falls within
  ±10 percentage points across the three windows. If separation only works at
  one magic lookback, the classifier is curve-fit.
- **Q2 (residual edge):** after excluding pairs above the threshold, is the
  residual total net on the remaining pairs **materially positive** (not
  ≈ break-even)? This is the test that distinguishes "asset-selection problem"
  from "structural-negative problem."

### Pre-registered decision criteria (hard gate)

These are committed before the Phase 0 run. They are the gate between
"measure" (Phase 0) and "build a filter setting" (Phase 1). The point of
pre-registering is to prevent goalpost-moving after the result is in.

- **GO (proceed to Phase 1, build the filter):** Q1 threshold stable across
  all three lookbacks within ±10pp **AND** Q2 residual total net > **+$5,000**
  on the non-excluded set.
- **NO-GO (declare structural-negative, stop):** Q1 threshold unstable across
  lookbacks **OR** Q2 residual total net ≤ **+$1,000**.
- **Indeterminate (between +$1k and +$5k residual):** document and discuss
  before any Phase 1 work. Do not silently proceed.

**If NO-GO, do not invent a new direction.** The discipline here matters: the
prior research effort repeatedly invented new levers after each negative
result (Pair Trend Invalidation, scale-out TP, 10 new strategies). Phase 0's
NO-GO is the conclusion of the asset-selection thread, not the start of a new
one. The strategy is structurally negative on synthetic pairs; stop mining it.

### What Phase 0 explicitly does NOT change

- The backtest itself — same entries, same exits, same settings, same trades.
- No new settings, no DOM ids, no engine edits, no Rust sanitizer changes.
- `loadDataset` runner contract unchanged (legs flow through a service-layer
  side-channel map, not through the callback return type).
- Single-token symbols (`BTCUSDT`) are unaffected; the diagnostic only fires
  for synthetic pairs.

### Pre-registered honesty

The most likely outcome remains: **Q1 passes, Q2 fails.** Finding 3 already
showed the ZEC/APT concentration, so leg-trend will likely separate the bad
pairs (Q1). But Finding 3 also showed the non-ZEC body nets ≈ +$69 over 5
years on 96 pairs — roughly zero after costs. Removing the tail cleans the
loss distribution but does not manufacture edge (Q2 fails). If that is the
result, the conclusion is: *asset selection cleans the loss distribution but
the strategy has no realizable edge even after selection* — a more precise
version of structural-negative, not a fix. Phase 1 only proceeds if Q2 shows
a genuine positive residual.

## Phase 0 Result — NO-GO (leg-trend filter fails backwards)

The Phase 0 run produced a decisive, unambiguous NO-GO. The leg-trend
classifier does not just fail to separate winners from losers — it separates
them **backwards**.

### Headline numbers

```text
SUMMARY | Leg-Trend | Stack90b Profit/Lose 26%/-13% | Residual(excl stack<-13%): 41p $-235510.54
```

- Profitable-pair median stack: **+26%** (adverse for shorts).
- Losing-pair median stack: **−13%** (favorable for shorts).
- Residual after excluding above-median-stack pairs: **41 pairs, −$235,510**
  (worse than the full universe's −$225,907).

### Q1 (separation): fails backwards

The hypothesis predicted losers would cluster at *positive* stack scores
(adverse base/quote stacking for shorts). The data shows the opposite:
losers cluster at negative (favorable) stacks. Every single catastrophic
loser has a negative stack score:

| Pair | Net | Stack90b |
|---|---|---|
| ZEC+APT | $-161,111 | **-111%** |
| ZEC+ETH | $-26,131 | -192% |
| ZEC+DOGE | $-36,187 | -112% |
| ZEC+SOL | $-2,112 | -205% |
| ZEC+SUI | $-1,437 | -246% |
| ZEC+WIF | $-1,523 | **-467%** |
| DOGE+BTC | $-6,772 | -67% |

A leg-trend filter built per the hypothesis would have *kept* ZEC+APT (the
$-161k disaster) and *excluded* the profitable ZEC+BNB (+$2,475 at -153%)
and ZEC+NEAR (+$481 at -200%).

### Q2 (residual edge): fails catastrophically

Pre-registered NO-GO threshold: residual ≤ +$1,000. Actual residual after
excluding above-median-stack pairs: **−$235,510**. The "filter" concentrates
the loss by 1.04× instead of removing it.

### Why it failed (the mechanism)

The hypothesis confused two different timeframes. The ZEC moonshot was a
**multi-year secular move**, but the regression slope over a 90-bar (15-day)
window averages out the spike-and-crash cycles ZEC went through. By the time
the catastrophic shorts were entering, the trailing-90-bar slope of ZEC vs.
APT was *negative* (ZEC had recently pulled back from a local high), so the
ratio looked like it was *falling* — favorable for shorts. The secular
adverse drift only expressed itself over horizons far longer than 90 bars.

This is the same trap Finding 5 exposed for entry-time signals: the
information that separates winners from losers is not available at decision
time. Slowing the classifier from per-bar (Finding 5) to multi-month
(Phase 0) did not change that — the 90-day slope is still a backward-looking
average that lags the regime change it would need to detect.

### Verdict: structural-negative confirmed

Per the pre-registered gate: **NO-GO. Do not invent a new direction. The
strategy is structurally negative on synthetic pairs; stop mining it.**

This closes the asset-selection thread. Every signal-based, regime-based,
exit-based, and selection-based lever has now been tested and ruled out:

- Signal-overlay exits (EMA-cross, MAE, adverse-move): ruled out (F1, F2).
- Post-loss quarantine: ruled out (F3, F4).
- Entry-regime filtering: ruled out (F5).
- Ex-ante leg-trend selection: ruled out (Phase 0, backwards).
- Exit-shape variants: ATR-TP cut the tail 67% but median-edge cost; scale-out
  deepened it (F6).

The 90%+ trade win rate with ~4% capped TP and no stop is **the mechanism
that hides negative expectancy, not evidence of edge**. The strategy cannot
be made safe to trade live by any exit overlay, TP shape, signal read, or
asset-selection rule. The only remaining lever is **position sizing**
(outside strategy-overlay scope) — bounding the dollar notional of any single
short so a vertical base leg cannot book an unrecoverable loss.

### What the leg-trend diagnostic was useful for

The Phase 0 diagnostic code (the `batch-leg-trend-diagnostics.ts` module,
the `LegStack90b` per-row field, the `SUMMARY | Leg-Trend` line, and the
synthetic-leg side-channel in the Batch loader) was **removed after this
research concluded** — the archive keeps the findings, not the instrumentation.
The design is documented above so it can be rebuilt for *future* strategies on
*different* universes where the leg-stacking mechanism might align
directionally with profitability. For THIS strategy family on THIS universe,
it is a documented negative result.

