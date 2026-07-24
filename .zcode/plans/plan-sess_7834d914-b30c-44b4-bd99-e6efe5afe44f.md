## Plan: Selector-signal P&L for the OPEN_SCORE USD report

### What you'll get
A new `TOP_MEAN P&L` section in the same OPEN_SCORE USD `reportLines` you already compare across direction modes (long / both / combine). For each horizon, it simulates **"always trade the TOP_MEAN pick vs USD"** and reports portfolio-style P&L metrics — so you can judge whether following the selector signal is actually profitable, not just whether it beats a random candidate (delta).

It reuses the per-event net-of-slippage/commission forward returns the engine **already computes internally** (in `SelectorSeries.returns/times/assets`) and currently discards after building delta. No new backtests, no per-pair P&L aggregation, no worker/artifact changes.

### The modeling decision (read this — it matters)
The engine's per-event returns are **overlapping fixed-horizon trades**: a new TOP_MEAN pick fires at every decision event, each holding `h` bars. Consecutive trades therefore overlap in time. I'll implement this as an **equal-weight, overlapping, non-compounding position basket** and report it honestly:

- **Total return** = sum of per-event net returns (equal 1-unit notional per trade, no compounding). This is the right "did the signal make money" number and matches the existing `topMean` semantics (just summed instead of averaged).
- **Sharpe** = `calculateSharpeRatioFromReturns(per-event returns)` (already exported, reused as-is), annualized at 4H bar rate for the horizon.
- **Win rate** = fraction of events with positive net return.
- **Max drawdown** = peak-to-trough on the **cumulative-return curve** (chronological by event time).
- **Trade count** = eligible events.

I will **not** model capital allocation, compounding, or portfolio-level risk (margin/overlap sizing). The report will explicitly label this as an **equal-weight overlapping signal basket** so it isn't mistaken for a live portfolio P&L. This keeps the build small and the number interpretable; a true compounding portfolio sim is a larger, separate phase.

For comparison, each horizon also reports the **random-control basket** (same metrics over the uniform-random positive-candidate returns the engine already computes), so you can see whether the TOP_MEAN signal's P&L beats the random baseline — the P&L analogue of delta.

### Files changed

1. **`lib/batch-backtest/batch-open-score-usd-replay-engine.ts`** (the only engine change)
   - **Capture the TOP_MEAN + random-control per-event series** before they're discarded. Inside the horizon loop, after `buildComparison` runs for `topMean`, fold `topMean.returns` / `topMean.times` (and the per-event random mean via the existing `randomMeanOf`) into a small `SelectorPnlSummary` using a new pure helper `computeSelectorPnl(returns, times)`.
   - Add a `pnl?: SelectorPnlSummary` field to each horizon of `OpenScoreUsdReplayResult` (additive, optional — old payloads still parse).
   - Wire the summary into `buildReportLines`: one new line per horizon, e.g. `TOP_MEAN_PNL    trades=N total=+X% sharpe=Y winrate=Z% maxDD=W%` and a matching `RANDOM_PNL` control line.
   - The pure helper is a leaf (uses `calculateSharpeRatioFromReturns` from `performance-metrics.ts` + a local drawdown fold). No DOM, no fs.

2. **`lib/strategies/performance-metrics.ts`** — **no change** (reuse `calculateSharpeRatioFromReturns`).

3. **No UI/service/plugin changes.** `reportLines` flows verbatim through the coordinator (`TopMeanResultSummary.reportLines`) and the service (`copyOpenScoreUsdResults`, the DOM summary div, the Copy button). The new P&L lines ride for free — same opaque-`reportLines` contract as every existing selector arm.

4. **Tests** — add `tests/batch-open-score-usd-selector-pnl.spec.ts`:
   - Pure-helper tests: known return series → expected total/Sharpe/winrate/drawdown; monotonicity (all-positive → positive total, all-negative → negative); empty/finite-filtering.
   - Engine integration: feed a tiny fixture that produces a deterministic TOP_MEAN series, assert the `pnl` field is populated and the report contains `TOP_MEAN_PNL`/`RANDOM_PNL` lines, and that the summary equals the pure helper applied to the same returns.

### Validation
- `npm run typecheck`
- `esno tests/batch-open-score-usd-replay-engine.spec.ts` (existing — must stay green)
- `esno tests/batch-open-score-usd-selector-pnl.spec.ts` (new)
- `esno tests/batch-open-score-usd-max-active.spec.ts` (existing — additive field must not break it)
- `esno tests/feature-dom-contracts.spec.ts` (no UI ids touched, sanity)

### Non-goals (explicitly out of scope)
- No compounding / capital-allocation portfolio sim (larger separate phase).
- No automated multi-config sweep (you compare runs manually — per your answer).
- No per-pair real-strategy P&L aggregation (that was the other option; you chose selector-signal).
- No worker/`CompactPairArtifact` schema changes.
- No new UI controls or DOM ids.

### Rollback
The `pnl` horizon field is additive and optional; revert the single engine file to drop the feature. Existing `reportLines` consumers are unaffected.