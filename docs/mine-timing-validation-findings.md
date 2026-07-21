# Mine Timing / Spread Quality / Signal Selection — Validation Findings

## Status: Validated Negative (2026-07-20)

A series of research diagnostics were built to answer: **does Mine Timing
produce a tradeable directional edge, can spread-quality metrics rank pairs,
and can history-based features pick the best simultaneous trade?** After
exhaustive testing across multiple strategies, intervals, horizons,
directions, regimes, and sample densities — including a real-P&L A/B test —
the answer for every approach was **no**.

After the negative conclusions were recorded, the exploratory diagnostic UIs
(Mine Prediction, Mine A/B, Portfolio Fit, Exposure & Redundancy, signal-event
replay) were removed from the Batch tab. The retained Batch analysis surface
is limited to **Mine Timing**, **Stability Mine**, and **OPEN_SCORE USD**
(see [docs/batch-backtest-server-side.md](batch-backtest-server-side.md)).
The reusable CLI diagnostic `scripts/diagnose-mine-prediction.ts`
(`npm run diagnose:mine-prediction`) is kept so the same question can be asked
about a future strategy without rebuilding the harness.

---

## The Research Questions And Results

### 1. Does OPEN_SCORE predict direction? — ANTI-SIGNAL
The signed OPEN_SCORE (positive minus negative pair votes per asset) does not
predict the asset's forward return.

### 2. Does Mine's analog engine predict forward return? — NO_EDGE
`RANK_IC` between Mine's analog `expectedForwardReturnPct` and realized forward
return is near zero at proper sample density (n>100) across every tested
config, interval, horizon, direction, and regime. Early "positive" results
(+0.10 to +0.37 IC) were inflated by small-sample variance (n=13–58). At dense
sampling (n=150+), IC collapses to +0.002–0.07.

The `oosLiftPct` statistic (used by the removed Portfolio Fit as `edge%`) has
near-zero correlation with realized return (`LIFT_COR ≈ 0`) in almost every
test.

### 3. Does filtering trades through Mine improve P&L? — CONTROL better
- **Control (all trades):** +$125,645 net P&L, 854 trades, PF 5.86
- **Treatment (Mine-LONG-gated only):** −$69,311 net P&L, 309 trades, PF 0.11

Mine's filter removed 64% of trades and the remaining 36% performed worse than
the removed ones. Mine is actively harmful as a trade filter.

### 4. Do ADF / half-life / Hurst predict which pairs are profitable OOS? — FAIL
Walk-forward validation (`scripts/validate-spread-quality.ts`) splits each
pair's ratio history into 6-month train / 3-month test folds. No metric
consistently predicts OOS P&L across configurations. ADF stationarity bugs
were found in the audit (level y used instead of Δy, post-hoc consistency
direction, inverted quantiles, etc.); even after fixing them the cleanest
config is negative. The Exposure & Redundancy Report — descriptive
concentration and overlap without any quality labels — was useful regardless
and lived briefly in the Batch tab before the analysis surface was simplified.

### 5. Can causal history and entry features pick the best simultaneous trade? — NO_OOS_EDGE
The signal-event replay grouped trades by their original signal time and
compared top-1 selection against the mean return of all candidates in the same
event. The adaptive walk-forward selector's 95% CI `[-0.14%, +0.24%]` crosses
zero; it did not beat a seeded-random baseline `+0.20%` and was flat on the
untouched final holdout (`-0.01%`). The oracle ceiling was `+7.46%`, proving
that dispersion exists but cannot be identified causally. After documenting
the result, the signal-event replay CLI, launcher, tests, and package commands
were removed.

### 6. Does the largest positive OPEN_SCORE asset beat another positive asset (USD)? — TOP_RAW not general; MAX_ACTIVE INCONCLUSIVE
`TOP_RAW` was attractive on certain pair lists but depended strongly on
pair-list construction and a few high-coverage assets. On a broad random
2,000-symbol universe it underperformed random selection. `MAX_ACTIVE` passed
8/10 positive-seed count at the primary 72-bar horizon, but the cross-seed 95%
CI `[-0.09%, +0.67%]` crossed zero and the 96-bar secondary matrix was
incomplete. Frozen verdict: **INCONCLUSIVE**.

The `OPEN_SCORE USD` Replay (live Batch analysis button + server route
`POST /api/batch-backtest/open-score-usd`) is retained because it remains a
useful diagnostic surface. Its result is event-level only and must not be
promoted into a tradeable claim without a fresh preregistered holdout.

A balanced Batch pair-list generator is also retained
(`lib/batch-backtest/balanced-pair-list-generator.ts`, Batch UI). It is a
reproducibility/balance tool only — it must not be confused with a validated
selector.

---

## Root Cause Analysis

### Why Mine doesn't predict direction
Mine uses k-NN on cross-sectional breadth snapshots. Two structural
weaknesses:

1. **k-NN predicts the median outcome, not the tail.** Bars that preceded
   explosive moves are rare and look chaotic; Mine finds many matches for
   "quiet uptrend continuation" and few for "about to explode." By averaging,
   Mine systematically underestimates large moves.
2. **4h snapshots are noisier than 1d snapshots.** Intraday volatility creates
   false breadth signals. Even at 1d, the IC is too weak to trade.

### Why Mine's filter destroys P&L
The batch pair-strategy generates entry signals that are already profitable
(+$125k). Mine's LONG verdict is a direction vote that doesn't correlate with
return magnitude. Used as a filter, it removes trades Mine said WATCH/SKIP/
INCONCLUSIVE for (including many winners) and keeps trades Mine said LONG for
(slightly less profitable on average).

### Why `oosLiftPct` is ungrounded
Portfolio Fit (now removed) used `oosLiftPct` as its `edge%` for dollar
allocation. The diagnostic proved `LIFT_COR ≈ 0` — `oosLiftPct` doesn't track
realized return. Portfolio Fit's dollar allocations were built on an input
that carries no predictive information.

### Why the system looks edge-filled but isn't predictable
99.6% pair profitability saturates the selection target. With 275/276 pairs
profitable, almost everything works — any pair-selection metric looks useless
because almost everything works. The edge is in the strategy + exit overlay,
not in which pair you pick. The signal-event oracle's `+7.46%` ceiling proves
that dispersion exists after the fact, but causal features couldn't identify
the winner beforehand.

---

## Practical Recommendations

### What to use
- **The batch pair-strategy P&L itself.** That's the real edge (+$125k on 2
  pairs, +$922k on 276 pairs). It comes from the strategy + exit overlay, not
  from Mine Timing.
- **Treat historical pair P&L as descriptive evidence about the batch
  configuration.** It identifies past performance, not a validated rule for
  choosing the best trade among signals firing now.

### What NOT to use
- **Do not use Mine Timing / Stability Mine verdicts for trade timing or entry
  filtering.** The A/B test proved it destroys P&L.
- **Do not size by Mine's confidence labels.** They are not calibrated and
  invert in bear markets (2022: high < low).
- **Do not follow SHORT verdicts.** Universally counter-predictive across all
  tests (35–49% hit rate).
- **Do not rank current signals by recent return, win rate, profit factor,
  signal rarity, time since exit, entry volatility, or ratio momentum.** The
  signal-event replay found no reliable OOS selection edge from these rules.
- **Do not promote `MAX_ACTIVE` from the exploratory OPEN_SCORE runs.** Its
  cross-seed 95% CI crossed zero and the 96-bar matrix was incomplete.
- **Do not use Rank Pairs labels to filter a pair universe and then replay the
  same historical window.** Rank Pairs classifies approximately three years
  ending at its latest candle; that workflow leaks future regime information.

### What remains as research display (not trade signals)
- **Mine Timing, Stability Mine** — research-only displays of the batch's
  positioning state. Informative for understanding what happened; not for
  predicting what will happen.
- **OPEN_SCORE USD replay** — descriptive event-level comparison of selector
  arms against the uniform-random baseline.
- **`npm run diagnose:mine-prediction`** — retained CLI diagnostic. If a
  future config shows CALL_IC > +0.15 at n=100+ AND TREATMENT_BETTER on the
  P&L-style replay (build it again if needed), that config warrants a fresh
  look.

---

## Methodology Notes

### Match horizons to the actual hold period
Measuring at h=12 when `maxHoldBars=3` dilutes the signal with post-exit drift.
The measurement must match the trade.

### Test the A/B P&L, not just IC
A signal with weak IC can still improve P&L (if it cuts losers). A signal with
good IC can hurt P&L (if it removes winners). The A/B test is the definitive
measurement.

### Filter by direction for direction-biased strategies
Including SHORT verdicts in a long-only strategy's IC drags the aggregate
toward zero. Score only the calls you'd actually make.

### Choose windows from event density, not convenience
Twelve-month folds were required to retain at least 100 complete events per
fold. Lowering the minimum would have weakened the claim instead of fixing the
design.

### Stop after a negative gate
Do not build capacity simulation or UI for a selector that failed
counterfactual OOS ranking. The signal-event replay CLI was deliberately
removed after its negative conclusion to prevent repeated post-hoc tuning
against the same history.

---

## Retained Tooling Reference

| Tool | Location | What it measures |
|---|---|---|
| Mine Timing | Batch tab button | Per-asset LONG / SHORT / WATCH / SKIP / INCONCLUSIVE verdict from analog study |
| Stability Mine | Batch tab button | Mine Timing under randomized trade subsets |
| OPEN_SCORE USD | Batch tab button | Event-level comparison of TOP_RAW / TOP_ADJUSTED / TOP_MEAN / MAX_ACTIVE / MAX_SUBMITTED / MAX_RETAINED / MAX_ACTIVE_REVERSION against the uniform-positive (or -negative) random control |
| Mine Prediction CLI | `scripts/diagnose-mine-prediction.ts` (`npm run diagnose:mine-prediction`) | Rank IC of Mine's analog predictions vs realized forward return. Flags: `--sample-from`, `--sample-to`, `--direction-filter`, `--backtest-settings-file`, `--horizons`, `--sample-bars`, `--sample-step` |
| Spread-quality CLI | `scripts/validate-spread-quality.ts` (`npm run validate:spread-quality`) | Walk-forward: do ADF / half-life predict OOS P&L? |
| Balanced pair-list generator | Batch UI | Deterministic, degree-balanced, capped-at-2,000 synthetic pair list from single-asset input. Reproducibility only, not a selector |

Removed after their negative conclusions were recorded:
Mine Prediction / Mine A/B HTTP endpoints, Portfolio Fit engine and route,
Exposure & Redundancy server route, signal-event replay CLI/launcher/tests.
The pure compute module `lib/spread-quality/spread-quality-engine.ts` is
retained but not currently wired to a server route.
