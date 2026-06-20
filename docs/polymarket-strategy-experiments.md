# Polymarket Strategy Experiments

Progress log for the 1s Polymarket strategy-lib experiments.

## Baseline Observation

The original observation came from `Decay Momentum Alignment` on a `5m` chart with `signal_close`, using effectively `ROC Period = 1` and `Decay Factor = 0`. That setup can behave like seeing the completed 5m outcome because the signal is based on the closed 5m candle.

The follow-up experiments move the decision to the `1s` chart and use exact-second Polymarket CLOB scoring.

## Built Strategies

### Polymarket Event Direction Follow

Key: `polymarket_event_direction_follow`

Purpose: causal version of the 5m answer-key idea.

Rule:

- buy YES when the latest closed 1s close is above the current 5m event open
- buy NO when it is below the current 5m event open
- hard default cutoff keeps new entries early in the event

Current exposed parameter:

- `minSecondsToEventEnd`, default `180`

Observed reference result from manual testing:

- `resolve_hold`
- `minSecondsToEventEnd = 180`
- `minMove = 0`
- no confirmation delay
- 211 scored trades
- 62.1% profitable
- +6.5c expectancy per trade
- +$121.07 sized net

Interpretation: this points to an early-event direction bias. It performs through final resolution, not necessarily through short-term quote movement.

### Polymarket Fair Value Mispricing

Key: `polymarket_fair_value_mispricing`

Purpose: simple model-vs-market baseline.

Rule:

- buy YES when `fairYesProbability - yesAsk >= minEdgeCents`
- buy NO when `fairNoProbability - noAsk >= minEdgeCents`

Hardcoded:

- `volLookback = 45`
- `maxQuoteAgeSec = 1`
- `minSecondsToEventEnd = 180`

Current exposed parameter:

- `minEdgeCents`, default `3`

Observed reference result from manual testing:

- `resolve_hold`
- `minEdgeCents = 3`
- 225 scored trades
- 55.6% profitable
- +5.6c expectancy per trade
- +$156.45 sized net

Interpretation: fair-value direction is useful as a gate, but increasing `minEdgeCents` did not improve performance. That suggests edge magnitude is not calibrated enough to rank trades by itself.

### Polymarket Fair Value Catch-Up Scalper

Key: `polymarket_fair_value_catchup_scalper`

Purpose: test `signal_exit_same_event` behavior by targeting short-term market catch-up rather than final resolution.

Rule:

- enter YES when executable YES edge is large enough and Binance-implied YES probability is moving faster than market YES probability
- enter NO when executable NO edge is large enough and Binance-implied NO probability is moving faster than market NO probability
- flip when the opposite side develops catch-up pressure above the exit threshold

Hardcoded:

- `volLookback = 45`
- `maxQuoteAgeSec = 1`
- no new entries after `180` seconds remaining

Current exposed parameters:

- `entryEdgeCents`, default `3`
- `exitEdgeCents`, default `0`
- `reactionLagSec`, default `5`

Expected use:

- chart interval: `1s`
- execution model: `signal_close`
- Polymarket exit mode: `signal_exit_same_event`
- compare against `resolve_hold` to separate final-outcome edge from short-term quote catch-up

Finder result:

- best found params: `entryEdgeCents = 20`, `exitEdgeCents = 1`, `reactionLagSec = 33`
- `signal_exit_same_event`
- no slippage
- 895 taken trades
- 639 scored trades
- 71.4% coverage
- 308 wins
- 48.2% Polymarket win rate
- +0.1c expectancy per trade
- 1.01 Polymarket profit factor
- +$14.83 sized net
- 53.6% BaseY

Verdict: failed strategy.

What was bad:

- The best Finder result was only barely positive before slippage. A +0.1c expectancy and 1.01 PF are not usable.
- Win rate was 48.2%, below 50% and below the 53.6% BaseY reference.
- The best parameter set needed a very high 20c entry edge and a slow 33s reaction lag just to reach break-even, which suggests the edge magnitude is not a short-term quote-movement ranker.
- High taken/scored counts with weak expectancy imply the strategy is trading noise, not selecting a small high-quality catch-up subset.
- The `signal_exit_same_event` contract forces exits through opposite signals. Without a close-only signal, the strategy tends to become a flip strategy, so exits and new opposite entries are mixed together.
- The resolve-hold direction edge did not transfer to signal-exit quote capture. Being right at final resolution is not the same as the selected side price rising before the event ends.

### Polymarket Event Direction Gamma Skew Filter

Key: `polymarket_event_direction_gamma_skew_filter`

Purpose: test the best Debugger lead as a filtered version of `polymarket_event_direction_follow`.

Rule:

- keep the event-open direction from `polymarket_event_direction_follow`
- require more than `180` seconds remaining in the 5-minute event
- require event-open distance shift, Binance return skew, and Gamma consensus to agree with the same side

Current exposed parameters:

- `volLookback`, default `164`
- `skewThreshold`, default `1.6`
- `minEdge`, default `0`

Finder result:

- best found params: `volLookback = 164`, `skewThreshold = 1.6`, `minEdge = 0`
- `resolve_hold`
- 264 taken trades
- 177 scored trades
- 67.0% coverage
- 65.0% Polymarket win rate
- +8.5c expectancy per trade
- 1.45 Polymarket profit factor
- +$160.74 sized net
- 49.4% BaseY

Implementation note: `minEdge = 0` means any positive Gamma consensus edge is enough. It does not disable the Gamma consensus gate.

## Next Checks

- Stop adding entry-only strategies for `signal_exit_same_event` until the exit contract is cleaner.
- Prefer testing the stronger resolve-hold entry ideas with Polymarket protective TP/SL or post-signal limit exits, because those model quote exits without pretending every opposite signal is a good new entry.
- If `signal_exit_same_event` remains a priority, the next code change should be an explicit close-only signal contract so a strategy can exit YES/NO without automatically flipping into the other side.
- After close-only exits exist, retest simple exit rules first: same-side edge <= 0, side price take-profit, side price stop-loss, and fair-probability reversal.
