# Trade-Ledger Mining Loop — Agent Guide

You mine trade-SELECTION rules: the strategy is frozen; you decide WHICH of its entry
signals to take. Everything is tested offline on a frozen ledger — no backtests are run.

## Assets
- Active ledger (F2): archive/mining-ledger/2026-08-29_1936_batch-mted6ti8-ooajqsxc
  (open_clearance_collapse_reversal lookback=22, long, next_open, 12-bar max hold,
  1410 pairs, 116,930 candidates)
- Checker: ../../../node_modules/.bin/esno scripts/trade-ledger-checker.ts <folder> <rule.ts>
  (run from repo root, NODE_OPTIONS=--max-old-space-size=8192)
- Rule files: archive/mining-ledger/rules/q<id>-<key>.ts
- Idea log (append-only): archive/mining-ledger/idea-log.txt
- Full contract docs: docs/trade-ledger.md

## Rule file format
    export default (row) => row.feat_atrPct < 3;
ONE predicate over the row. Only feat_* and identity/entry fields. Any read of outcome
fields (pnlPercent, exitTime, exitPrice, fees, exitReason, executed, asIf) THROWS by
design — that is the anti-leakage guard. Do not try to bypass it.

## Available causal features (all known at entry time)
    feat_entryRangePosition  close location vs prior bar range (%; >100 = closed above prior high)
    feat_atrPct              ATR(14)/close*100 at the signal bar
    feat_return20            20-bar return %
    feat_gapPct              this bar's open vs prior close %
    feat_dow, feat_hour      day-of-week / UTC hour of the signal bar
    feat_pairWinRatePrior    trailing win rate of this pair's EARLIER trades (null until 5 priors)
    feat_pairTradesPrior     count of those prior trades
    feat_rank / feat_candidatesAtTime  rank among same-timestamp signals. RANK SORTS BY
                             PAIR NAME ALPHABETICALLY - it carries NO information.
                             Do not mine it. candidatesAtTime (breadth) is fine to use.

## Measured value scales on F2 (calibrate thresholds against these)
    feat_hour    SESSION CONTEXT (US stock synthetic pairs, 4H aggregated from 30m):
                 Data exists only during US regular hours, Mon-Fri, roughly
                 13:30-20:00 UTC (DST-shifting to ~14:30-21:00 in winter).
                 4H bars are fixed-UTC-bucket aggregates: normally TWO bars/day
                 at 12:00 and 16:00 UTC, plus a winter-only 20:00 stub bar.
                 Overnight is a gap, not a bar; bar content varies with DST, so
                 a "4H" bar here is a session slice, not a uniform 4-hour packet.
                 CONSEQUENCE: entry signals fire ~99.9% at hour 12 (session-open
                 bar). Intraday hour-window theses (e.g. 06:00-10:00) match
                 NOTHING; a 16:00/20:00 gate matches ~0.08% (too rare to mine).
                 Do not propose feat_hour gates on this surface.
    feat_dow     getUTCDay(): 1=Monday ... 5=Friday. Values present are 1,2,3,4,5
                 (no weekend bars). Monday=1, Friday=5. The ONLY live time
                 dimension on this surface. Other seasonal theses (month,
                 bar-of-day index) would need NEW exporter features first.
    feat_gapPct  p1 -11.8 | p10 -4.6 | p50 -1.4 | p90 -0.5 | p99 -0.25.
                 Mostly NEGATIVE (median -1.4%). Thresholds like "< -0.2" keep 99.8%
                 of rows; ">= 0.2" keeps ~0%. Selective gap gates need values like
                 "< -3" (deep gap) or "> -0.6" (unusually small gap).
    feat_atrPct  p50 ~2.1, p90 ~5.7 (see earlier smoke).
    feat_candidatesAtTime  p10 11 | p25 18 | p50 31 | p75 50 | p90 82 | max 248.
                           Breadth is HIGH on this surface (1410 pairs): <=2 = 0.4%,
                           <=3 = 0.9%, <=5 = 2.5%, <=8 = 6.3%, >=20 = 72.7%, >=6 =
                           97.5%. "Quiet" gates must use <=3..<=8 to be selective; a
                           ">=6" gate is a no-op. Very tight gates (<1% kept) admit
                           few trades - expect fragile verdicts.
    A rule matching ~0% or ~100% of candidates tests nothing - the checker will
    report it, but the IDEA AGENT must calibrate thresholds to the scales above
    BEFORE proposing.

## Running + reading the report
- One checker run per rule; takes seconds to ~1 min.
- PRIMARY comparison: the "rule vs control (per-trade, primary)" line - isMeanPnlDelta,
  isMedianPnlDelta (IS) and holdoutMeanPnlDelta / holdoutMedianPnlDelta, all in
  percentage points vs a seeded random control at the same keep-rate.
- kept% shows how selective the rule is; very small kept% = fragile, hard to certify.
- The IS slice (first 60% of calendar time) is where you INVENT and compare.
  The HOLDOUT slice (last 40%) is SEALED: it exists only to confirm finalists.
  Never select, tune, or iterate based on holdout numbers.
- Lines labeled "scale-dependent (compounded)" are informational only.
- Current control baseline: about -0.10% per trade. A useful rule needs a clearly
  positive IS delta that SURVIVES in holdout.

## Two-phase protocol (idea and implementation are SEPARATE agents)

IDEA PHASE — runs nothing, writes nothing. Reads idea-log.txt (anti-clone) + the
feature table above; outputs JSON ideas only. Prompt:
archive/prompt-trade-rule-ideas.txt

IMPLEMENTATION PHASE — a separate agent (prompt:
archive/prompt-trade-rule-implementation.txt) takes the human-approved JSON ideas and
only then:
1. Writes rule files, runs the checker, collects results.
2. Appends ONE line per idea to idea-log.txt, failures included (verdict INCONCLUSIVE
   if the rule errored - with the reason). Non-finalist entries record holdout as "-".
   Format: Q<id>|F2|<short thesis>|<verdict> <+IS delta>pp hold<delta or ->
3. Declares at most 2 finalists per batch, chosen ONLY on IS numbers. Only finalists'
   holdout numbers are logged and reported.
4. Reports honestly: a table of every idea with verdicts, including failures. Never
   claim a result you did not see.

CLONE RULE (idea phase): a thesis is a clone (forbidden) if it reuses a logged feature
with the same gate direction, rewords a logged thesis, or combines already-dead
features.

## When something looks like EDGE
EDGE bar (default): IS delta >= +0.3pp on kept >= 2% of candidates, AND holdout delta
positive. On a candidate EDGE: stop mining that family, log it as EDGE, and hand it to
the human for certification - the final strategy+rule must be re-run once from raw data
through the real engine (see docs/trade-ledger.md, Discipline section). A checker EDGE
is a candidate, never a conclusion.

## Rule files across surfaces
- Rule files are strategy-agnostic predicates over ledger features. The same q-file can
  be re-run on any ledger folder (the folder is a CLI argument).
- Verdicts are SURFACE-specific: NO-EDGE on F2 does not clone-block the same thesis on
  a different surface - test it there and log it fresh under that surface's tag.
- If featureVersion changes, old verdicts describe the old feature definitions; re-test
  before trusting an old rule on a new featureVersion.

## Long-horizon discipline (many batches)
- Holdout budget: at most TWO finalist holdout views per batch, and at most ~30 TOTAL
  on the same surface. Past ~15 views the surface's holdout is half-spent (treat
  results as weak); past ~30 it is spent - confirm surviving rules on a NEW surface
  instead of re-viewing this one.
- The EDGE bar rises with testing volume: after ~50 logged ideas on one surface, a
  candidate EDGE needs IS delta >= +0.5pp (not +0.3pp) to qualify as a finalist.
  Testing hundreds of theses guarantees some pass any fixed bar by luck.
- Family cap: at most 10 ideas per batch from the same feature pair (e.g. breadth x
  drawdown). An edge that only exists at one exact threshold setting is suspicion of
  noise; an edge with coherent neighbors is research.
- Cross-surface replication: a rule family is only believable after it also tests
  positive on at least one other surface (different strategy and/or config). Until
  then it is a candidate, whatever the holdout said.

## Hygiene
- Never edit or delete old idea-log lines. Never delete rule files of tested ideas.
- Never mine with --allow-incomplete; a refused folder means re-run the batch.
- If the checker refuses or errors, report it - never work around it.
