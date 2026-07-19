# Mine Timing / Stability Mine / Portfolio Fit — Validation Findings

## Status: Validated Negative (2026-07-18)

Three diagnostic tools were built to answer: **does Mine Timing produce a tradeable directional edge?** After exhaustive testing across multiple strategies, intervals, horizons, directions, regimes, and sample densities — including a real-P&L A/B test — the answer is **no**.

---

## The Three Diagnostic Tools

### 1. Mine Prediction (IC Diagnostic)
**Button:** "Mine Prediction" in the Batch tab analysis group.  
**What it measures:** Whether Mine's analog `expectedForwardReturnPct` correlates with realized forward return (rank IC) at historical bars where the forward window has fully elapsed.  
**Code:** `lib/batch-backtest/batch-mine-prediction-engine.ts`, `POST /api/batch-backtest/mine-prediction`

**Controls (config row below the analysis buttons):**
- **From / To:** Date-range filter for regime-specific tests (e.g., 2022 bear market)
- **Dir:** Direction filter (Both / Long only / Short only) — critical for direction-biased strategies
- **Samples / Step:** Sample density (Samples=80, Step=10 for dense regime tests)
- **Horizons:** Forward-return windows in bars (MUST match your hold period — if `maxHoldBars=3`, use `1,2,3`)

**Report lines:**
- `RANK_IC` (FORECAST_IC): rank IC of all finite analog predictions vs realized
- `CALL_IC`: rank IC of actionable LONG+SHORT verdicts only
- `VERDICTS`: count of each verdict type (LONG/SHORT/WATCH/SKIP/INCONCLUSIVE)
- `HIT_RATE`: directional accuracy by actual verdict (not underlying direction)
- `EDGE`: LONG/SHORT mean return vs matched non-call baseline
- `CALIB`: confidence calibration (high vs medium vs low hit rate)
- `LIFT_COR`: correlation between `oosLiftPct` and realized (Portfolio Fit grounding test)
- `FORECAST_VERDICT` / `CALL_VERDICT`: sign-aware verdicts anchored to primary horizon

### 2. Mine A/B Test (P&L Diagnostic)
**Button:** "Mine A/B" in the Batch tab exports group.  
**What it measures:** Whether filtering actual batch trades through Mine's LONG verdict improves P&L.  
**Code:** `lib/batch-backtest/batch-mine-prediction-ab-engine.ts`, `POST /api/batch-backtest/mine-prediction-ab`

**How it works:**
- **Control:** existing batch result per pair (all trades)
- **Treatment:** re-runs backtest with signals filtered to only Mine-LONG-gated entries, through the user's real exit overlay (`executeBacktestFromSignals`)
- Compares net P&L, trade count, win rate, profit factor

### 3. CLI Diagnostic (Research Tool)
**Command:** `npm run diagnose:mine-prediction`  
**Code:** `scripts/diagnose-mine-prediction.ts`  
**Flags:** `--sample-from`, `--sample-to`, `--direction-filter`, `--backtest-settings-file`, `--horizons`, `--sample-bars`, `--sample-step`

---

## Key Findings

### Finding 1: Mine's analog forecast layer has no predictive edge
- **RANK_IC** (all finite predictions) is near zero at proper sample density (n>100) across every tested config, interval, horizon, direction, and regime.
- Early "positive" results (+0.10 to +0.37 IC) were inflated by small-sample variance (n=13–58). At dense sampling (n=150+), IC collapses to +0.002–0.07.
- The `oosLiftPct` statistic (used by Portfolio Fit as `edge%`) has near-zero correlation with realized return (`LIFT_COR ≈ 0`) in almost every test.

### Finding 2: Mine's actionable calls (CALL_IC) are borderline at best
- CALL_IC (only verdicts === "LONG" or "SHORT") was +0.27 at n=19 (thin) and +0.07 at n=127 (dense) for the best config found (`rolling_zscore_volatility_adjusted_reversion` at 1d).
- Hit rate at dense sampling: 59.8% CI[51.1, 68.0] — barely excludes 50%.
- EDGE over matched non-call baseline is consistently negative (−0.13% to −1.75%) — Mine picks "safe small winners" and misses explosive movers (a structural property of k-NN on financial data).

### Finding 3: SHORT verdicts are universally counter-predictive
- Across every config, interval, and regime tested: SHORT hit rate 35–49%.
- SHORT is never actionable. Never follow Mine's SHORT verdicts.

### Finding 4: Confidence labels are not calibrated
- In bull markets, confidence sometimes shows a clean monotone ordering (high > medium > low).
- In bear markets (2022), confidence inverts: high < low.
- Do not size by Mine's confidence labels.

### Finding 5: Edge does not survive regime isolation
- Configs that look positive on full history collapse in isolated regime windows (2020, 2022).
- At 4h interval: ALL configs fail the regime test.
- At 1d interval: some configs survive weakly, but the A/B test (below) settles the question.

### Finding 6: Mine's LONG filter destroys P&L (the A/B test)
- **Control (all trades):** +$125,645 net P&L, 854 trades, PF 5.86
- **Treatment (Mine-LONG-gated only):** −$69,311 net P&L, 309 trades, PF 0.11
- Mine's filter removed 64% of trades and the remaining 36% performed worse than the removed ones.
- **Verdict: CONTROL_BETTER — Mine is actively harmful as a trade filter.**

---

## Root Cause Analysis

### Why Mine doesn't predict direction
Mine uses k-NN (nearest-neighbor) on cross-sectional breadth snapshots. It finds historical bars where the peer-pair agreement state looked similar to today, then averages the forward returns of those analogs. This has two structural weaknesses:

1. **k-NN predicts the median outcome, not the tail.** Bars that preceded explosive moves (the biggest winners) are rare and look chaotic — they don't have many "similar" precedents. The engine finds many matches for "quiet uptrend continuation" (common, small moves) and few for "about to explode" (rare, large moves). By averaging, Mine systematically underestimates large moves.

2. **4h snapshots are noisier than 1d snapshots.** At 4h, intraday volatility creates false breadth signals. At 1d, a full day's price action is more informative, so analogs are slightly more reliable — but even at 1d, the IC is too weak to trade.

### Why Mine's filter destroys P&L
The batch pair-strategy generates entry signals that are already profitable (+$125k). Mine's LONG verdict is a *direction vote* that doesn't correlate with return magnitude. When used as a filter, it:
- Removes trades where Mine said WATCH/SKIP/INCONCLUSIVE (which include many winners)
- Keeps trades where Mine said LONG (which are slightly less profitable on average)
- The net effect: Mine removes more P&L than it preserves.

### Why `oosLiftPct` is ungrounded
Portfolio Fit uses `oosLiftPct` (the analog study's average forward return over baseline) as its `edge%` for dollar allocation. The diagnostic proved `LIFT_COR ≈ 0` — `oosLiftPct` doesn't track realized return. Portfolio Fit's dollar allocations are built on an input that carries no predictive information.

---

## Practical Recommendations

### What to use
- **The batch pair-strategy P&L itself.** That's the real edge (+$125k on 2 pairs, +$922k on 276 pairs). It comes from the strategy + exit overlay, not from Mine Timing.
- **Sort batch pairs by net P&L.** The top pairs ARE the best performers. Mine's overlay doesn't improve the ranking.

### What NOT to use
- **Do not use Mine Timing / Stability Mine verdicts for trade timing or entry filtering.** The A/B test proved it destroys P&L.
- **Do not use Portfolio Fit's `edge%` / dollar allocation recommendations.** The input is ungrounded (`LIFT_COR ≈ 0`). Portfolio Fit's own output already labels itself "EXPERIMENTAL — do not treat as independently validated."
- **Do not size by Mine's confidence labels.** They are not calibrated and invert in bear markets.
- **Do not follow SHORT verdicts.** Universally counter-predictive across all tests.

### What to keep as research display (not trade signals)
- Mine Timing, Stability Mine, and Portfolio Fit can be retained as **research-only displays**. They visualize the batch's positioning state, which is informative for understanding what happened — just not for predicting what will happen.
- The Mine Prediction and Mine A/B diagnostic buttons should be retained to validate any future strategy that might genuinely pass. If a new config shows CALL_IC > +0.15 at n=100+ AND TREATMENT_BETTER on the A/B test, that config has real tradeable edge.

---

## Methodology Notes

### What the IC diagnostic measures vs what you actually do
- **IC diagnostic:** picks historical bars, asks "what did Mine say?", checks "did the price go up?" at fixed horizons. Measures prediction quality — no trading, no entries, no exits, no costs.
- **A/B test:** runs the actual backtest with filtered signals through the real exit overlay. Measures tradeability — captures position-sequencing, exit-overlay interaction, and real P&L.
- **A signal with weak IC can still improve P&L** (if it cuts the worst trades). **A signal with good IC can hurt P&L** (if it removes trades your exit overlay handles better without filtering). The A/B test is the definitive measurement.

### Known limitations
1. **Pair artifacts are prepared once from full-history data** and reused across sampled bars. Pair features (auto-horizons, adverse-ATR) can leak slightly past the slice boundary, but the current-snapshot lookup is bar-N-bounded by timeKey.
2. **The verdict-classification bug** (now fixed) was present in all earlier IC runs: WATCH-LONG and INCONCLUSIVE-LONG bars contaminated the LONG hit-rate bucket. The fix separates CALL_IC from FORECAST_IC and classifies by actual verdict.
3. **n=58–172 per regime window** is adequate for ruling out large effects (IC > +0.15) but may miss small effects (IC +0.03–+0.05).
4. **Realized return is measured at fixed horizons** (bar N to bar N+h at close prices), not through the user's actual exit overlay. The A/B test closes this gap.

### Configs tested
- **Strategies:** `return_sign_streak_fade`, `volume_roc_regime_router`, `range_expansion_exhaustion_reversion`, `body_concentration_entropy_squeeze`, `rolling_zscore_volatility_adjusted_reversion`, `true_range_skew_acceptance`, `initiative_pressure_side`
- **Intervals:** 4h, 1d
- **Pair universes:** 995 → 461 → 326 → 253 pairs (progressive narrowing)
- **Horizons:** 1,2,3 (matching maxHoldBars=3) and 12,24,48 (default)
- **Directions:** both, long-only, short-only
- **Regimes:** full history, 2020 (bull/choppy), 2022 (bear)

---

## File Reference

| Component | Path |
|---|---|
| IC diagnostic engine | `lib/batch-backtest/batch-mine-prediction-engine.ts` |
| IC diagnostic stream types | `lib/batch-backtest/batch-mine-prediction-stream-types.ts` |
| A/B test engine | `lib/batch-backtest/batch-mine-prediction-ab-engine.ts` |
| A/B test stream types | `lib/batch-backtest/batch-mine-prediction-ab-stream-types.ts` |
| CLI diagnostic | `scripts/diagnose-mine-prediction.ts` |
| Server endpoints | `POST /api/batch-backtest/mine-prediction`, `POST /api/batch-backtest/mine-prediction-ab` |
| Mine's analog engine (under test) | `lib/batch-backtest/batch-synthetic-state-miner.ts` |
| Portfolio Fit edge formula | `lib/batch-backtest/batch-portfolio-fit-engine.ts:89-112` |
| Engine spec tests | `tests/batch-mine-prediction-engine.spec.ts`, `tests/batch-mine-prediction-ab-engine.spec.ts` |
| Server-plugin route tests | `tests/batch-backtest-server-plugin.spec.ts` |

---

## Update: Spread Quality Validation (Phase 0) — Also Negative (2026-07-19)

### What was tested

After the Mine Timing investigation concluded negative, we explored whether **spread-quality statistics** (ADF stationarity, half-life of mean reversion, Hurst exponent) could rank pairs by tradeability — identifying which synthetic pairs have genuinely mean-reverting spreads vs trending ones.

A walk-forward validation script (`scripts/validate-spread-quality.ts`) was built to test this. It splits each pair's ratio history into 6-month train / 3-month test folds, computes ADF + half-life on train, measures OOS P&L from existing trades on test, and correlates.

### Result: ADF and half-life do NOT predict OOS P&L

| Config | Pairs | ADF verdict | Half-life verdict |
|---|---|---|---|
| Config 1 | 512 | FAIL (46% consistent) | "PASS" but only 13 folds, many with 5-12 pairs — noise |
| Config 2 | 512 | FAIL (55%) | FAIL (48%) |
| Config 3 | 512 | FAIL (60%, IC≈0) | "PASS" (63%, IC=+0.053) — borderline |
| Config 4 | 512 | "PASS" but ADF bug + inverted direction | FAIL (47%) |

**Honest verdict: FAIL.** No metric consistently predicts OOS P&L across configurations. Config 2 (the cleanest with most populated folds) is clearly negative for both metrics. The winning metric changes across configs (half-life in 1/3, ADF in 4, neither in 2) — that is not consistent evidence.

### Phase 4 (Fixed-Ratio Diagnostics UI) not built

The plan gated Phase 4 on Phase 0 passing. It did not pass. The Exposure & Redundancy Report (descriptive, no quality labels) was built and is useful regardless — it shows concentration and overlap without claiming any pair is "better."

### Bugs found by AI audit of the Phase 0 script

1. ADF residual calculation used level y instead of Δy — every t-stat invalid
2. Consistency direction chosen post-hoc (after seeing mean IC) — inflates pass rate
3. Quantile calculation inverted (most-negative ADF in "bottom")
4. P&L not per-unit-capital; includes exits after the test window
5. OR logic too lenient (passes if either metric passes)
6. Unadjusted corporate-action splits distort both ADF and half-life on raw ratio data

Even after fixing these bugs, the cleanest config (Config 2) is negative. The conclusion stands.

---

## Complete Investigation Summary: Lessons Learned

### What was investigated (4 independent approaches)

| # | Approach | Question | Tool | Result |
|---|---|---|---|---|
| 1 | Batch positioning analysis | Does OPEN_SCORE predict direction? | OPEN_SCORE IC diagnostic | **ANTI-SIGNAL** |
| 2 | Mine Timing prediction | Does Mine's analog engine predict forward return? | Mine Prediction IC diagnostic | **NO_EDGE** at proper density |
| 3 | Mine as trade filter | Does filtering trades through Mine improve P&L? | Mine A/B Test | **CONTROL_BETTER** (Mine destroys $195k) |
| 4 | Spread quality metrics | Do ADF/half-life predict which pairs are profitable OOS? | Phase 0 walk-forward validation | **FAIL** — no OOS predictive value |

### The pattern

Every theoretically-plausible metric failed under rigorous validation:
- Small-sample inflation made early results look positive (+0.10 to +0.37 IC)
- Dense sampling (n>100) collapsed them to near-zero or negative
- Regime splits showed the "edge" was trend beta, not skill
- P&L A/B test proved the signal destroys value when used as a filter
- Walk-forward validation showed spread metrics don't predict OOS

### Root causes

1. **k-NN on financial data predicts the median, not the tail.** Mine's analog engine finds many matches for "quiet continuation" and few for "explosive moves." By averaging, it systematically underestimates large moves. Direction accuracy (60-90% hit rate) does not translate to return prediction.

2. **99.6% pair profitability saturates the selection target.** With 275/276 pairs profitable, there's almost no variance to predict. Any pair-selection metric will look useless because almost everything works. The edge is in the strategy + exit overlay, not in which pair you pick.

3. **In-sample metrics have no OOS value in this system.** ADF, half-life, rank IC, and Mine's analog Lift% all correlate with in-sample performance but fail to predict OOS performance. This is consistent with the backtest-overfitting literature: after enough configuration search, in-sample metrics become uncorrelated with OOS outcomes.

4. **The exit overlay is the product.** Your batch P&L (+$922k) comes from `zscore_deviation_streak_reversion` / `naive_compression_breakout_follow` / `vwap_skew_gradient_exhaustion` applied to pair entry signals. No overlay on top of that (Mine Timing, spread-quality metrics, Portfolio Fit) improves it.

### What works (proven)

- **The batch pair-strategy + exit overlay.** That's the edge. 99.6% of pairs are profitable.
- **The Exposure & Redundancy Report.** Shows concentration (SNDK in 68 pairs, EffAssets=37.7 out of 70) and overlap. Useful for managing capital allocation without claiming any pair is "better."

### What doesn't work (proven)

- Mine Timing / Stability Mine / Portfolio Fit for any trade decision (direction, timing, sizing, filtering)
- ADF / half-life / Hurst exponent for pair selection or OOS prediction
- Any in-sample metric for predicting OOS performance after configuration search

### Methodology lessons for future research

1. **Always start with a walk-forward validation before building UI.** Phase 0 saved weeks of building a diagnostic UI for metrics that don't work. The Mine Timing investigation took longer because Phase 0 wasn't built first.

2. **Use dense sampling (n>100) before trusting any IC.** Small-sample IC is wildly unstable (+0.30 at n=20 can collapse to +0.04 at n=172). Always report n alongside IC.

3. **Match horizons to the actual hold period.** Measuring at h=12 when maxHoldBars=3 dilutes the signal with post-exit drift. The measurement must match the trade.

4. **Test the A/B P&L, not just IC.** A signal with weak IC can still improve P&L (if it cuts losers). A signal with good IC can hurt P&L (if it removes winners). The A/B test is the definitive measurement.

5. **Filter by direction for direction-biased strategies.** Including SHORT verdicts in a long-only strategy's IC drags the aggregate toward zero. Score only the calls you'd actually make.

6. **Don't trust verdict labels without validated thresholds.** "best", "tradeable", "avoid" are unsupported unless backed by OOS evidence. Use descriptive metrics instead.

7. **Don't combine overlapping metrics into a composite score.** ADF + half-life + Hurst measure the same underlying property (mean-reversion speed). Combining them triple-counts one signal and creates false confidence.

### Tools retained for future research

All diagnostic tools are retained in the codebase for validating future signals:

| Tool | Button | What it measures |
|---|---|---|
| Mine Prediction | "Mine Prediction" | Rank IC of Mine's analog predictions vs realized forward return |
| Mine A/B Test | "Mine A/B" | P&L difference between all trades and Mine-filtered trades |
| Exposure & Redundancy | "Exposure" | Asset concentration, shared-leg clusters, cross-pair correlations |
| Phase 0 Validation | `npm run validate:spread-quality` | Walk-forward: do spread metrics predict OOS P&L? |

If a future strategy or signal claims directional edge, run Mine Prediction first (IC test), then Mine A/B (P&L test). If both pass, the edge is real. If either fails, it's not.

---

## Where to focus next

The investigation proved the edge is in the execution layer (strategy + exit overlay), not in direction prediction or pair selection. The highest-value next steps:

1. **Exit-overlay parameter optimization.** Walk-forward optimization on `lookback`, `zScoreBoundary`, `streakThreshold` (for `zscore_deviation_streak_reversion`) or `lookback`, `volPercentileMax`, `zThreshold` (for `naive_compression_breakout_follow`). These are the knobs that determine how much of the +$922k you capture.

2. **Capital efficiency via redundancy reduction.** Use the Exposure Report to cut from 512 to ~150 non-redundant pairs. Same per-trade edge, less capital required, lower concentration risk.

3. **Single-asset direction (if needed).** A standalone momentum/trend strategy on single-asset OHLCV — not an overlay on the pair strategy. The pair strategy is a spread/arbitrage tool; direction is a different tool's job.
