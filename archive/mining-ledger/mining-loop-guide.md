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

## Hygiene
- Never edit or delete old idea-log lines. Never delete rule files of tested ideas.
- Never mine with --allow-incomplete; a refused folder means re-run the batch.
- If the checker refuses or errors, report it - never work around it.
