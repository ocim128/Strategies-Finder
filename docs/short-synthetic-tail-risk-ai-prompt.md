# Continue Short Synthetic Pair Tail-Risk Research

You are working in:

```text
C:\Users\user\Documents\Repo\Experimental\lightweight-charts\debug\playground\Strategies-Finder
```

Continue research on the short-only synthetic-pair strategy tail-loss problem. The goal is to identify or avoid unrecoverable short regimes/pairs while preserving the original Finder-mined edge.

Do not start by implementing another generic early-exit overlay. The prior Pair Trend Invalidation exit clipped catastrophic losses, but it destroyed the mined strategy edge. Treat it as a failed performance overlay, similar in effect to a max-hold cap.

Current code state:

- Pair Trend Invalidation is not active in the UI/settings/backtest engine.
- Any `pairTrendInvalidation*` fields seen in historical configs are legacy experiment evidence, not current supported settings.
- Do not revive Pair Trend Invalidation or variants such as loss-thresholded EMA invalidation, EMA buffer, consecutive invalidation bars, or minimum-hold-before-invalidation unless diagnostics first prove baseline winners rarely pass the proposed condition before recovering.

Relevant repo context:

- Follow `AGENTS.md` and existing repo conventions.
- `docs/pair-trend-invalidation-research.md` contains the detailed research log.
- For UI/settings changes, update DOM ids, settings resolver, settings DOM contract, TypeScript types, Rust sanitizer, tests, and docs together.
- For diagnostics, prefer existing Batch/Finder result/copy/export paths instead of ad hoc console logs.

Strategy context:

- The base strategy was found by Finder/data mining.
- Direction is short-only.
- Synthetic pair movement is `base / quote`; rising ratio is adverse for shorts.
- Base interval is `4h`.
- Base example symbol/config: `FETBNB`, strategy params `lookback: 147`, `gradientPercentileMin: 0.99`.
- Base settings include `executionModel: next_open`, fixed take profit `4.26%`, `stopLossEnabled: false`, `riskMaxHoldEnabled: false`, `disableSignalExits: false`, `maxOpenTrades: 1`, `slippageBps: 5`.
- Because `disableSignalExits` is false, native strategy exits are part of the mined edge.
- Historical exported configs may include `pairTrendInvalidationExitEnabled: false` and related EMA/slope fields. Treat those as inert legacy experiment fields.

Known results:

Baseline Batch:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 69/110 (63%) | Losing 32 | No Trades 9 | Failed 0 | Verdicts STRONG 2, SOLID 9, MARGINAL 30, WEAK 2, THIN 49, LOSING 9
SUMMARY | Total Net $-225693.05 | Avg Net/Pair $-2051.75 | Median Net +$190.40 | Best NEAR+BNB +$2527.77 | Worst ZEC+APT $-161111.12
SUMMARY | Trades 1762 | Trade WR 96% | Avg/Trade $-128.09 | PF 0.23 | Median Trades 13 | Median AvgTrade +$26.88 | Median Sharpe 0.15 | Median DD 14%
SUMMARY | Median Hold 127b (21d) | Median MaxHold 1110b (185d) | Median Exposure 31%
```

Entry confirmation using pair EMA position/slope 96 barely helped and did not fix the worst loss.

Pair Trend Invalidation 96/1:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 37/110 (34%) | Losing 64 | No Trades 9 | Failed 0 | Verdicts SOLID 6, MARGINAL 15, WEAK 4, THIN 26, LOSING 50
SUMMARY | Total Net $-19927.57 | Avg Net/Pair $-181.16 | Median Net $-57.73 | Best WLD+ETH +$799.55 | Worst DOGE+BNB $-2726.57
SUMMARY | Trades 4525 | Trade WR 53% | Avg/Trade $-4.40 | PF 0.83 | Median Trades 29 | Median AvgTrade $-2.47 | Median Sharpe -0.13 | Median DD 3.8%
SUMMARY | Median Hold 10b (1.7d) | Median MaxHold 59b (9.8d) | Median Exposure 5.6%
```

Pair Trend Invalidation 96/2:

```text
SUMMARY | Pairs 110 | Tested 110 | Profitable 38/110 (35%) | Losing 63 | No Trades 9 | Failed 0 | Verdicts SOLID 6, MARGINAL 16, WEAK 4, THIN 26, LOSING 49
SUMMARY | Total Net $-20673.69 | Avg Net/Pair $-187.94 | Median Net $-66.96 | Best WLD+ETH +$779.58 | Worst DOGE+BNB $-2700.98
SUMMARY | Trades 4420 | Trade WR 55% | Avg/Trade $-4.68 | PF 0.83 | Median Trades 29 | Median AvgTrade $-3.68 | Median Sharpe -0.16 | Median DD 4.2%
SUMMARY | Median Hold 11b (1.8d) | Median MaxHold 63b (11d) | Median Exposure 5.7%
```

Interpretation:

- Pair Trend Invalidation clipped the catastrophic tail, but degraded median net, win rate, profitable-pair count, trade count, hold time, and Finder competitiveness.
- Do not accept a result that only improves the worst pair while turning the median pair negative.
- Do not accept a result that wins by simply reducing exposure while destroying Finder competitiveness.

First task:

Add or use diagnostics, not another overlay. Analyze baseline trades first. Compare against failed overlay behavior only as a secondary control.

Required diagnostics:

- Winning-trade max adverse excursion before recovery.
- Losing-trade max adverse excursion before final loss.
- Trade PnL by hold-duration buckets.
- Worst trade per pair and contribution to total net.
- Longest losing holds.
- Native strategy signal-exit timing for catastrophic losers.
- Count of baseline winners that temporarily crossed adverse EMA/trend conditions before later hitting fixed TP or native signal exit.
- Re-entry churn after forced exits, only if testing any overlay.

Preferred implementation directions after diagnostics:

1. Tail diagnostics in Batch/Finder exports: expose worst trade, longest losing hold, max adverse excursion, and recovery-after-drawdown counts.
2. Finder ranking with tail-risk penalty: preserve median/robustness while penalizing worst trade, worst pair, long losing hold, or extreme MAE.
3. Pair/regime quarantine: stop taking new shorts for a pair after severe adverse behavior or consecutive failed shorts, instead of closing every small adverse trend move.
4. Native-exit failure analysis: identify when the strategy's own exit signal fails to arrive before catastrophic adverse movement.

Success criteria:

- Top Finder results with the new thesis must compete with the original short-only Finder result.
- Median net should stay positive or not materially degrade from baseline.
- Win rate and profitable-pair count should not collapse.
- Trades should not more than double versus baseline.
- Worst-pair loss should be materially reduced from baseline.

Validation expectations:

- Run focused tests plus typecheck.
- For UI id changes, run `tests/feature-dom-contracts.spec.ts`.
- For backtest behavior changes, run `tests/backtesting-engine.spec.ts`.
- For settings changes, run `tests/settings-compat.spec.ts` and `tests/backtest-settings-id-parity.spec.ts`.
