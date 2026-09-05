# OPEN_SCORE Take/Skip Report Lines — Technical Plan

Status: planned (no implementation yet)  
Date: 2026-09-05

## Recommendation

Extract the two proven gates from `scripts/take-skip-eval.ts` into one small, pure
take/skip evaluator and call it from `runOpenScoreUsdReplay(...)` after TOP_MEAN's
incumbent outcome is known. Add its two formatted lines to the existing opaque
`reportLines` array, then reuse those same lines in the existing **Show OPEN_SCORE
Details** panel. This is the smallest production path that preserves the tested
cohort: the raw-ledger evaluator has 938 usable incumbent outcomes, while the normal
TOP_MEAN comparison/detail cohort has 937 because it rejects an event when *any*
positive candidate outcome is unavailable. Computing from `openScoreEventDetails`
would therefore change the proven gates. Patching an archived `report.txt` would also
miss the live UI and copy paths, and the raw Phase 0b JSONL files only exist when archive
staging is enabled. The engine change is limited to exposing the already-selected
incumbent's scalar outcome; selector behavior, checker governance, and outcome pricing
remain untouched.

## Scope and assumptions

- Only `same_asset_two_loss_veto` and `global_return_regime_10` are promoted, under
  report labels `LOSS_VETO` and `REGIME_FLOOR`. The other eight exploratory gates stay
  script-only.
- The gates remain tied to the preregistered 24-bar long TOP_MEAN outcome. They are not
  generalized or tuned for other horizons.
- “Show OPEN_SCORE Details” means displaying the two summary lines above the existing
  selector event table. The gates do not become selector choices and do not add
  per-event columns.
- A gate sees only outcomes strictly before the current event. Histories update after
  both decisions, exactly as in the script.
- The first implementation evaluates the selected replay window in chronological
  order. No history before `sampleFromSec` is used, matching the replay window's
  existing self-contained semantics.

## Output contract

For chronological incumbent events `(time, asset, return)` at horizon 24:

- `taken` is the count for which the gate returns TAKE; skipped events contribute zero.
- `top = sum(return for taken events) / taken`.
- `all = sum(return for all evaluable events) / evaluable events`.
- `skip = 100 × (sum(return for taken events) - sum(return for all events))` percentage
  points. This is exactly the value of replacing skipped trades with zero.
- `+blocks` uses the engine's existing count-balanced chronological ten-block rule
  (`start=floor(bN/10)`, `end=floor((b+1)N/10)`). A block is positive only when its
  take-minus-always-take return sum is greater than zero.

The lines use the existing 14-character label alignment and signed percentage
formatting:

```text
LOSS_VETO     n=619 top=+13.37% all=+5.07% skip=+3516.82pp +blocks=<n>/10
REGIME_FLOOR  n=592 top=+12.67% all=+5.07% skip=+2743.82pp +blocks=<n>/10
```

These baseline counts and values are parity targets for
`archive/batch-open-score/sp500_top_mean_1788560534200_jedw`. In an OPEN_SCORE report,
both lines appear in the 24-bar section immediately after `TOP_MEAN` and before
`TOP_MEAN_RAW_UNIQUE_V1`. If horizon 24 was not requested, neither line is emitted. If
horizon 24 exists but has no evaluable incumbent outcomes, both lines use `n=0`,
`top=n/a`, `all=n/a`, `skip=+0.00pp`, and `+blocks=0/10`.

## Affected files and data flow

| File | Planned change |
|---|---|
| `lib/batch-backtest/open-score-take-skip.ts` | New pure leaf containing the two frozen gates, aggregation, ten-block calculation, and line formatter. |
| `scripts/take-skip-eval.ts` | Keep raw JSONL loading and incumbent reconstruction here; pass the reconstructed scalar events to the shared evaluator so the research script and production report cannot drift. |
| `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` | In `runOpenScoreUsdReplay(...)`, collect valid TOP_MEAN incumbent outcomes before the existing all-positive `allValid` gate, evaluate horizon 24, attach the small summaries to that horizon, and have `buildReportLines(...)` insert the two lines at the stated location. |
| `lib/batch-backtest/batch-backtest-service.ts` | In `renderTopMeanOpenScoreEventDetails(...)`, render the first full-window `LOSS_VETO` and `REGIME_FLOOR` report lines in a `<pre>` above the event sections; in `syncTopMeanOpenScoreDetailsControl(...)`, treat those lines as detail content so restored summary-only results can still open the panel. |
| `tests/open-score-take-skip.spec.ts` | Focused gate and formatter tests. |
| `tests/batch-open-score-usd-replay-engine.spec.ts` | Cohort, placement, and no-24-horizon integration coverage. |
| `tests/batch-backtest-service-lifecycle.browser.spec.ts` | Details-panel visibility, selector-independence, restore behavior, and escaping coverage. |

Data flow:

`pair artifacts → replay EventView/TOP_MEAN pick → selected long outcome → pure take/skip evaluator → reportLines → coordinator result → live report, copy paths, archive report, and details panel`

`reportLines` remains the transport contract. `sp500-top-mean-coordinator-engine.ts`,
`sp500-top-mean-archive-log.ts`, and both existing copy handlers already preserve it
verbatim, so they need no feature-specific changes.

## Phase 1 — Freeze and share the tested evaluator

### Objective

Create one source of truth for the two accepted gate decisions and their report math
without changing the raw-ledger selection logic.

### Tasks

1. Define a minimal input record in `open-score-take-skip.ts`: decision time, selected
   asset, and incumbent net return. Sort by decision time with a deterministic secondary
   key.
2. Move only the two accepted predicates and prior-history update order from
   `scripts/take-skip-eval.ts` into the leaf evaluator.
3. Return structured results (`taken`, `skipped`, `takenSum`, `allSum`, means,
   `positiveBlocks`) plus the two formatted lines. Keep all values as decimal returns
   until formatting.
4. Adapt the script to call the shared evaluator after its existing raw
   `pool-snapshots.jsonl` / `candidate-outcomes.jsonl` join. Preserve its current raw
   reads, TOP_MEAN tie-break, and diagnostic output for the other gates.

### Dependencies

- Existing FNV-1a TOP_MEAN tie-break in the script.
- Existing chronological, count-balanced block convention in
  `batch-open-score-usd-replay-engine.ts`.

### Risks or blockers

- A refactor could accidentally include the current return in its own gate decision.
  Tests must prove decisions are made before histories update.
- Floating-point formatting can turn a tiny zero into `-0.00`; normalize formatted zero
  to `+0.00`.

### Deliverables

- Pure evaluator/formatter module.
- The raw-ledger script producing unchanged gate totals through that module.

### Validation/testing

- Synthetic sequences prove: first two same-asset observations are taken; two prior
  losses veto only that asset's next pick; another asset has independent history; the
  regime gate takes its first ten warm-up events and then uses exactly the preceding ten
  returns.
- Aggregation fixtures verify means, total skip value, strict-positive block counting,
  deterministic ordering, empty input, and signed formatting.
- A targeted parity run against the archived L2 JSONL must reproduce 619/319 and
  592/346, the two return sums, and the displayed means above. This 100 MB archive scan
  is a release check, not part of the fast default unit suite.

### Exit criteria

The focused spec passes and the archive parity output matches the proven script result
without changing any gate threshold, lookback, tie-break, or cohort rule.

## Phase 2 — Add the lines to replay output

### Objective

Make every completed 24-bar OPEN_SCORE report carry the two summaries without requiring
archive mode or retaining Phase 0b JSONL rows in memory.

### Tasks

1. In the per-horizon loop of `runOpenScoreUsdReplay(...)`, capture the TOP_MEAN
   incumbent return from `perAsset.get(view.topMean)?.long[hIdx]` before the existing
   all-positive `allValid` early-continue. Require finite return, entry time, and exit
   time, matching the script's `eligible && status === "ok"` join.
2. Evaluate only the 24-bar scalar records with the shared module and add the two small
   summaries to the horizon result contract. Do not expose the per-event gate history or
   Phase 0b rows in the network result.
3. In `buildReportLines(...)`, emit `LOSS_VETO` and `REGIME_FLOOR` immediately after
   `comparisonLine("TOP_MEAN", h.topMean)` and before the existing
   `TOP_MEAN_RAW_UNIQUE_V1` line.

### Dependencies

- `view.topMean` remains the authoritative incumbent selected by existing engine code.
- Net returns and entry/exit times remain owned by the existing outcome phase.

### Risks or blockers

- Capturing after `allValid` would reproduce the 937-event comparison cohort rather
  than the 938-event gate cohort. The integration fixture must include an event where
  the incumbent outcome is valid and a non-incumbent outcome is missing.
- Annual replay invocations also use `runOpenScoreUsdReplay(...)`. The two lines should
  be emitted for their 24-bar selected windows using history available inside that
  window; they must not be mistaken for the full-window baseline counts.

### Deliverables

- Two report lines in normal OPEN_SCORE UI text, both Copy paths, coordinator output,
  persisted `result.json`, and archived `report.txt`, all through existing
  `reportLines` propagation.

### Validation/testing

- Engine spec asserts the incumbent-valid/non-incumbent-missing event contributes to
  take/skip but not the ordinary TOP_MEAN comparison.
- Assert exactly one pair of lines in the 24-bar section, exact ordering around
  `TOP_MEAN`, no lines in non-24 sections, and deterministic output across repeated
  runs.
- Existing `batch-open-score-usd-replay-engine.spec.ts`,
  `batch-open-score-usd-max-active.spec.ts`, and
  `sp500-top-mean-archive-log.spec.ts` remain green to protect opaque report copying and
  archive serialization.

### Exit criteria

The engine fixture produces the expected gate cohort and line placement, while all
existing selector metrics and report lines are byte-for-byte unchanged outside the two
insertions.

## Phase 3 — Surface the same lines in Show OPEN_SCORE Details

### Objective

Show the already-computed summaries in the on-demand details panel without adding a new
DOM contract or duplicating gate math in the browser.

### Tasks

1. Add a private report-line extractor in `batch-backtest-service.ts` that selects the
   first full-window lines beginning with `LOSS_VETO` and `REGIME_FLOOR`. Because the
   full-window report precedes calendar-year sections, stop scanning at the first
   `================ OPEN_SCORE USD | CALENDAR YEAR` separator.
2. Render the extracted lines, escaped, in the existing details container immediately
   after the heading/note and before the first event section. Keep them visible when the
   event selector changes because both gates apply only to the incumbent, not to the
   chosen detail-table selector.
3. Count the presence of either line in `syncTopMeanOpenScoreDetailsControl(...)` so a
   persisted result can open the panel even though large event-detail rows are
   intentionally omitted from localStorage.
4. If an older result has no gate lines, render the panel exactly as today.

### Dependencies

- Existing `batchBacktestSp500TopMeanDetails` container and
  `batch-report-pre`/details styles.
- Existing persistence retains `reportLines` while stripping event detail rows.

### Risks or blockers

- `reportLines` can contain full-window and annual copies. Stopping at the first annual
  separator prevents duplicate or mislabeled summaries in the top-level details panel.
- Report text is server-produced but must still pass through `escapeHtml(...)` before
  insertion into `innerHTML`.

### Deliverables

- Both summary lines visible at the top of **Show OPEN_SCORE Details** for live and
  restored completed results.
- No HTML partial, DOM id, selector option, CSS, storage schema, or API change.

### Validation/testing

- Browser lifecycle spec opens the panel and finds both exact lines before the event
  table; switching from TOP_MEAN to MAX_ACTIVE leaves the summaries visible while still
  filtering table rows.
- A fixture containing full-window and annual gate lines renders only the full-window
  pair.
- A restored result with report lines but no event rows enables the button and shows the
  summaries; a legacy result without the lines preserves current behavior.
- Include a malicious-looking report fragment in the fixture and assert it is escaped.
- Run `npm run typecheck`, the three focused specs above, and
  `tests/batch-backtest-copy.spec.ts`.

### Exit criteria

The two lines are visible in the expanded UI, remain identical to copied/archived text,
and no duplicate calculation or new browser-side research logic exists.

## Operational considerations and rollback

- **Database/schema/infrastructure:** none. The result addition is optional and
  backward-compatible; `reportLines` already crosses the server/browser boundary.
- **Security:** no route, input, permission, or external I/O change. UI text remains
  HTML-escaped.
- **Performance:** O(evaluable events) time and small scalar histories per horizon. Do
  not enable or retain the ~100 MB Phase 0b JSONL arrays merely to compute these gates.
- **Error handling:** absent horizon/data yields the explicit empty result above; a gate
  calculation must not fail the parent replay. Non-finite incumbent outcomes are
  excluded exactly as in the research script.
- **Rollback:** remove the optional horizon summaries and two `buildReportLines(...)`
  insertions, remove the details-panel extraction block, and put the two predicates back
  inline in the standalone script. Existing reports, persisted results, and archives
  require no migration.
