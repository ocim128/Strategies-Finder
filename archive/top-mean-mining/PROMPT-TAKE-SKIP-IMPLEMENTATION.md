# Take/Skip Gate Mining — Implementation Prompt

You are working in this repository:
C:\Users\user\Documents\Repo\Experimental\lightweight-charts\debug\playground\Strategies-Finder

You are the TAKE/SKIP IMPLEMENTATION agent for TM-L2-C1. You receive approved gate
JSON after the GATES marker below. You materialize each gate as a JavaScript
predicate, evaluate it against the L2 ledger, and append results to
archive/top-mean-mining/idea-log.txt.

## GOVERNING FILES

Read AGENTS.md and archive/top-mean-mining/PROMPT-TAKE-SKIP-IDEAS.md for the
concept and already-tested gates. The frozen ledger is:
archive/batch-open-score/sp500_top_mean_1788560534200_jedw

## ACTIVE LEDGER (READ-ONLY)

- pool-snapshots.jsonl and candidate-outcomes.jsonl in the ledger directory
- 938 evaluable events (discovery window 2025-01-10..2025-12-31)
- Total incumbent return: +4,759.22pp

## YOUR TASK

For each gate in the approved JSON:

1. Write a gate implementation as a JavaScript function that takes an event
   context object and returns true (TAKE) or false (SKIP). The event context
   provides: the incumbent pick (asset, score, votes, support, EMA, breadth,
   regime), the event metadata (time, dow, hour), per-asset completed return
   history, and the global completed return history. All history is strictly
   causal (exitTimeSec < decisionTimeSec).

2. Evaluate the gate against ALL 938 evaluable events in chronological order,
   maintaining state incrementally (asset history and global history update
   after each event is evaluated, never before).

3. For each gate, compute and record:
   - eventsTaken (count of TAKE decisions)
   - eventsSkipped (count of SKIP decisions)
   - takenReturnSum (sum of incumbent returns on taken events)
   - allReturnSum (sum of incumbent returns on all 938 events)
   - skipValue = allReturnSum - takenReturnSum (positive = gate added value)

4. Append one result line per gate to idea-log.txt:

TS|<gate-name>|campaign=TM-L2-C1|batch=L2D2|taken=<n>|skipped=<n>|takenSum=<signed>pp|allSum=<signed>pp|skipValue=<signed>pp|verdict=<POSITIVE-or-NEGATIVE>|mechanism=<one-sentence>

5. Rank gates by skipValue descending. Report the full table.

## EVALUATION APPROACH

Use the existing take-skip-eval.ts infrastructure as a reference for:
- How to read pool-snapshots.jsonl and candidate-outcomes.jsonl
- How to build the event list with incumbent picks and returns
- How to track causal asset history and global history
- The 938-event cohort and its total return (+4,759.22pp)

Adapt this approach to evaluate your gate functions. The gates are JavaScript
predicates over the same event context. You may extend take-skip-eval.ts or
write a companion script — whichever is cleaner.

## HARD RULES

- The ledger is read-only. Verify L1 and L2 archive hashes before and after.
- All history is strictly causal: exitTimeSec < decisionTimeSec.
- No outcome from the current event enters the history before the gate evaluates.
- Report every gate's result honestly — including gates that lose money.
- No retries, no tuning, no parameter adjustment after seeing results.
- The 10 already-tested gates are baseline. Do not re-evaluate them.

## FINAL MESSAGE (format)

A table of all gates: name | mechanism | taken | skipped | skipValue | verdict.
Then: which gates are positive, which mechanisms seem real, and which are noise.
One sentence on what to explore next.
```

**GATES:**

<paste the approved gate JSON here>
