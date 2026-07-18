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
