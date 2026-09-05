# Take/Skip Gate Mining — Ideas Prompt

You are generating causal TAKE/SKIP gates for the TOP_MEAN selection on the L2 ledger.

## THE CONCEPT

TOP_MEAN picks an asset at each event and holds 24 bars. It is near-optimal at
picking WHICH asset. But it always trades — even when it shouldn't. Your gates
decide whether to TAKE or SKIP each event. A gate that correctly skips losing
events adds real value without needing to find a better asset.

## THE METRIC

For each gate:
- takenSum = sum of incumbent returns on events where the gate says TAKE
- allSum = sum of incumbent returns on ALL events
- skipValue = allSum - takenSum (positive means skipping added value)

A gate is interesting when skipValue is large and positive — meaning the gate
correctly identified losing events to avoid.

## THE LEDGER

L2 archive: archive/batch-open-score/sp500_top_mean_1788560534200_jedw
- 938 evaluable events (discovery window 2025-01-10..2025-12-31)
- Total incumbent return: +4,759.22pp
- Mean per event: +5.07pp
- 133 assets, 4H synthetic pairs (S&P 500)

## AVAILABLE FIELDS FOR GATE CONSTRUCTION

Per candidate (at decision time, all strictly causal):
- signedVotes: pair votes for this asset
- activePairCount: pairs currently supporting this asset
- score: signedVotes / activePairCount (the incumbent's ranking metric)
- ema200Above: whether price is above EMA200
- breadth: fraction of catalog assets above their EMA200 (null possible)
- regime: "bullish" | "bearish" | "unavailable"
- shortEligible: whether the asset is short-eligible
- inPool: whether the asset is in the submitted pair list

Per incumbent (the selected asset):
- realized return (h24 long, net of slippage and costs)
- entry and exit timestamps
- asset identity (for tracking loss streaks and pick patterns)

Per portfolio (aggregate state, incrementally built):
- rolling window of completed incumbent returns
- per-asset history of completed returns
- count of events evaluated so far

## ALREADY TESTED — DO NOT RE-PROPOSE

These 10 gates were evaluated. Results shown. Do not submit variants.

| Gate | Mechanism | Result |
|---|---|---|
| score_floor_075 | skip if score < 0.75 | NEGATIVE (−830pp) |
| coverage_floor_41 | skip if support < 41 | NEGATIVE (−3,765pp) |
| score_margin_0025 | skip if margin to runner-up < 0.025 | NEGATIVE (−2,114pp) |
| unique_score_winner | skip if exact tie exists | NEGATIVE (−2,063pp) |
| bullish_breadth_only | skip if breadth < 0.50 | NEGATIVE (−900pp) |
| breadth_euphoria_cap_078 | skip if breadth > 0.78 | NEGATIVE (−281pp) |
| bear_coverage_confirmation_48 | bear events need coverage ≥ 48 | NEGATIVE (−782pp) |
| same_asset_two_loss_veto | skip after same asset lost 2 in a row | **POSITIVE (+3,517pp)** |
| global_return_regime_10 | skip if last 10 picks net negative | **POSITIVE (+2,744pp)** |
| global_volatility_cap_10pct | skip if recent return stddev > 0.10 | NEGATIVE (−3,585pp) |

## WHAT WE LEARNED FROM THESE 10

- The incumbent's asset selection is sound. Gates that try to second-guess
  WHICH asset it picks (score floors, coverage floors, margin gates) all fail.
- The edge is in knowing WHEN TO STOP, not WHO TO PICK.
- Loss-streak detection and regime detection both work.
- Aggregate volatility and breadth filters do NOT work — they skip too many
  good events along with bad ones.

## YOUR TASK

Generate exactly 10 NEW take/skip gates. Each gate must:
- Test a MECHANISM not covered by the 10 above
- Be strictly causal (only uses outcomes that completed before the decision)
- Have a clear mechanism story: WHY would skipping these events add value?
- Target a specific, identifiable pattern (not a vague "market is bad" filter)

## MECHANISM IDEAS TO EXPLORE

Think about what could cause TOP_MEAN to enter losing streaks:
1. Asset concentration: is the incumbent repeatedly picking the same asset?
   If that asset is in a drawdown, subsequent picks may also lose.
2. Pick-pick correlation: are consecutive picks correlated? If the last two
   picks moved together and both lost, the third may also lose.
3. Win-quality degradation: the incumbent's recent winners are smaller than
   its historical winners — the edge may be fading for specific assets.
4. Skip-recovery patterns: after a skip that would have avoided a loss,
   does the next pick outperform? (Tests whether the gate has momentum.)
5. Time-since-best-pick: if the incumbent's best pick was long ago, the
   selection edge may be stale.
6. Inter-event timing: are losses clustered at period boundaries (month-end,
   quarter-end) or after long gaps between events?

## OUTPUT FORMAT

Return valid JSON only. No markdown fences. No prose outside the JSON.

{
  "gates": [
    {
      "name": "snake_case_name",
      "description": "One sentence: what does this gate skip?",
      "mechanism": "Why would skipping these events add value?",
      "causalBoundary": "What prior information does the gate use?",
      "expectedDirection": "Why would the skipped events have been losses?"
    }
  ]
}

Generate exactly 10 gates.
