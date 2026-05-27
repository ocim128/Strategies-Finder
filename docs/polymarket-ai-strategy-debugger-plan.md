# Polymarket AI Strategy Debugger Plan

## Purpose

Build an easy feedback loop for 1s Polymarket strategy research:

1. AI generates one strategy-lib idea.
2. The strategy is implemented normally.
3. The user runs Strategy Debugger from the Strategy Panel.
4. Strategy Debugger compares selected strategies against `polymarket_event_direction_follow`.
5. The user copies one or more diagnostic JSON objects into `archive/prompt-1s-polymarket-feedback-loop.txt`.
6. AI proposes the next small experiment.

The user should not need to understand trading theory. The menu should explain what helped, what hurt, and what to try next.

## Better Loop Than Raw Idea Generation

The old loop was:

AI idea -> strategy lib -> Finder result -> guess why it failed.

The new loop is:

AI idea -> strategy lib -> debugger comparison -> AI-readable failure report -> next smaller idea.

This is closer to the successful diagnostic-output workflow already used for Finder and backtest fixes.

## Known Weaknesses And Controls

This plan has real conceptual and execution weaknesses. V1 should name them in the UI output instead of pretending the diagnostic is proof.

### Conceptual Weaknesses

1. The debugger can over-explain noise.
   - Control: every diagnostic must include a verdict confidence: `low`, `medium`, or `high`.
   - Control: bucket claims require a minimum trade count. Small buckets should be labeled `too small`.

2. One chart range can create fake lessons.
   - Control: the diagnostic must say `singleRangeOnly: true` in V1.
   - Control: AI prompt should treat V1 output as a next-experiment guide, not final proof.

3. Default params are not a fair final comparison.
   - Control: record `paramSource` for baseline and candidate: `current_ui` or `strategy_default`.
   - Control: V1 compares strategy ideas; Finder still validates parameters after a candidate looks promising.

4. Trade overlap matching can be imperfect.
   - Control: report `matchQuality` and keep aggregate metrics separate from overlap metrics.
   - Control: do not base the verdict only on matched trades.

5. Candidate-added trades can look good only because they increased coverage.
   - Control: always show delta expectancy and delta win rate next to delta net.
   - Control: verdict should not be `better` unless expectancy improves or net improves with no meaningful expectancy damage.

6. Missing prices and duplicate handling can hide losses.
   - Control: surface missing, duplicate, and unscored counts in the diagnostic header.
   - Control: verdict should be `needs data check` when scored share is low.

7. The baseline itself may be overfit.
   - Control: this tool compares against the chosen baseline; it does not prove the baseline is live-ready.
   - Control: output should say when all candidates are worse but the baseline still has unresolved validation risk.

### Execution Weaknesses

1. Running many strategies can be slow.
   - Control: V1 should run selected candidates only, show progress, and allow cancellation.

2. Backtest runs can mutate shared UI state.
   - Control: snapshot current chart data and settings before the run.
   - Control: debugger runs should not apply Finder results or write strategy params back to the UI.

3. Polymarket 1s context loading can dominate runtime.
   - Control: reuse existing context/cache paths and show a separate `pricePointLoading` or `contextLoading` timing if available.

4. Some strategies cannot run without required context.
   - Control: unsupported or failed strategies should produce a row with a failure reason, not break the whole run.

5. Copyable JSON can become too large.
   - Control: cap examples and bucket rows. The copied payload should be AI-readable, not a full trade dump.

6. UI tab contracts can drift.
   - Control: add the tab to feature DOM contract tests when implemented.

V1 is successful if it reliably says "this candidate added bad trades" or "this candidate skipped good trades." It does not need to solve full statistical validation.

## UI Placement

Add a new Strategy Panel tab:

- tab id: `strategydebugger`
- label: `Debug`
- partial: `html-partials/tab-strategy-debugger.html`
- DOM contract: `lib/strategy-debugger-dom.ts`
- service/controller: `lib/strategy-debugger-service.ts`

This should be a lazy tab like other heavier research panels. It should not be inside Settings because it runs backtests and compares multiple strategies.

## V1 Scope

Keep V1 small.

V1 should:

- use current chart data
- use current backtest settings
- force Polymarket annotation to be enabled for supported 1s runs
- use `polymarket_event_direction_follow` as the default baseline
- let the user select multiple candidate strategy libs
- run each candidate once with resolved params and record `paramSource`
- compare each candidate against the baseline
- render a compact table
- render one selected candidate's diagnostic output
- provide Copy Diagnostic JSON

V1 should not:

- optimize params
- replace Finder
- claim statistical proof
- generate strategies inside the UI
- call external AI APIs
- edit strategy files
- run live orders

## Controls

Recommended controls:

- Baseline Strategy select
- Candidate strategy search
- Candidate checklist
- Select Visible / None
- Run Debugger
- Copy Diagnostic JSON

Optional V1 controls if cheap:

- Top N candidates
- Min scored trades
- Include only Polymarket 1s strategies

Avoid advanced trading controls in V1. The user should change normal backtest settings in Settings/Finder as usual.

## Output Table

Each candidate row should show:

- strategy name
- scored trades
- coverage
- Polymarket win rate
- expectancy per trade
- profit factor
- sized net
- delta expectancy versus baseline
- delta sized net versus baseline
- match quality
- scored share
- verdict

Verdict labels:

- `better`
- `worse`
- `flat`
- `bad coverage`
- `needs data check`
- `low confidence`

## Diagnostic Output Contract

Copy Diagnostic JSON should be concise enough to paste into AI.

Suggested schema:

```json
{
  "schema": "polymarket.strategy_debugger.v1",
  "run": {
    "symbol": "BTCUSDT",
    "interval": "1s",
    "executionModel": "signal_close",
    "polymarketExitMode": "resolve_hold",
    "riskManagement": {
      "chart": {},
      "polymarketProtection": {}
    },
    "singleRangeOnly": true,
    "generatedAtIso": "2026-05-27T00:00:00.000Z"
  },
  "baseline": {
    "strategyKey": "polymarket_event_direction_follow",
    "paramSource": "strategy_default",
    "params": {},
    "scoredTrades": 211,
    "unscoredTrades": 31,
    "duplicateTradesIgnored": 0,
    "winRate": 0.621,
    "expectancyCents": 6.5,
    "profitFactor": 1.32,
    "sizedNet": 121.07
  },
  "candidate": {
    "strategyKey": "candidate_key",
    "paramSource": "strategy_default",
    "params": {},
    "scoredTrades": 225,
    "unscoredTrades": 27,
    "duplicateTradesIgnored": 18,
    "winRate": 0.556,
    "expectancyCents": 5.6,
    "profitFactor": 1.26,
    "sizedNet": 156.45
  },
  "delta": {
    "expectancyCents": -0.9,
    "winRatePoints": -6.5,
    "sizedNet": 35.38,
    "scoredTrades": 14
  },
  "tradeOverlap": {
    "matchQuality": "medium",
    "bothTook": {
      "count": 180,
      "candidateBetterCount": 82,
      "baselineBetterCount": 98,
      "avgDeltaCents": -1.2
    },
    "candidateAdded": {
      "count": 45,
      "winRate": 0.44,
      "expectancyCents": -3.1
    },
    "candidateSkipped": {
      "count": 31,
      "baselineWinRate": 0.68,
      "baselineExpectancyCents": 8.4
    }
  },
  "helpedBuckets": [
    {
      "bucket": "entryPrice 45-60c",
      "candidateDeltaCents": 3.2,
      "trades": 80
    }
  ],
  "hurtBuckets": [
    {
      "bucket": "entryPrice 65-80c",
      "candidateDeltaCents": -8.1,
      "trades": 36
    }
  ],
  "diagnosis": {
    "verdict": "worse",
    "confidence": "medium",
    "plainEnglish": [
      "Candidate added too many low-quality trades.",
      "Skipped baseline trades were mostly winners.",
      "Raising minimum edge did not improve outcome quality."
    ],
    "limitations": [
      "Single chart range only.",
      "Default params are not final parameter validation."
    ],
    "nextPromptHint": "Do not raise edge threshold again. Try filtering baseline entries by entry price or event progress instead."
  }
}
```

Keep field names stable. This JSON is the prompt interface.

## Comparison Method

V1 can compare trades by event and side.

Recommended identity key:

- event start timestamp
- event end timestamp
- side
- nearest entry timestamp bucket

If exact matching is too brittle, V1 should still report:

- aggregate candidate versus baseline
- candidate-only trades
- baseline-only trades
- same-event same-side overlap

Do not block V1 on perfect trade matching.

Verdict rules should prefer aggregate Polymarket metrics when match quality is low. Overlap diagnostics should become supporting evidence, not the main verdict.

## Bucket Diagnostics

Start with simple buckets only:

- entry price: 20-35c, 35-45c, 45-55c, 55-65c, 65-80c
- seconds remaining
- event progress
- quote age
- side: YES/NO
- entry source: both, candidate-only, baseline-only

If helper frames are available later, add:

- distanceZ bucket
- executable edge bucket
- pressure gap bucket
- reaction gap bucket

The first useful debugger can work from existing annotated trade outputs.

## Implementation Shape

Recommended modules:

- `lib/strategy-debugger-types.ts`
- `lib/strategy-debugger-analysis.ts`
- `lib/strategy-debugger-service.ts`
- `lib/strategy-debugger-renderer.ts`
- `lib/strategy-debugger-dom.ts`

Keep heavy computation in `strategy-debugger-analysis.ts`.

The service should reuse existing backtest execution paths instead of adding another engine:

- load strategy from existing registry/manifest
- run the baseline
- run each selected candidate
- collect `BacktestResult.polymarketTradeSummary`
- collect trade annotations when available
- pass results to analysis

The service must snapshot chart data and UI settings before running. Debugger runs should be research side effects only: no strategy apply, no localStorage strategy-param writes, and no silent settings changes.

## Finder Relationship

Strategy Debugger is not Finder.

Finder answers:

- Which params rank best?
- Which strategy has the best score?

Strategy Debugger answers:

- Why did this candidate beat or fail the baseline?
- Did it add bad trades?
- Did it skip good trades?
- Which simple bucket explains the difference?
- What should AI try next?

V1 may copy Finder's strategy checklist UI pattern, but should not copy Finder's optimizer.

## Validation

After UI implementation:

- `npm run typecheck`
- `npm run test -- strategy-debugger`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts`

Manual smoke:

1. Load `BTCUSDT` `1s`.
2. Select `polymarket_event_direction_follow` as baseline.
3. Select two candidate Polymarket strategies.
4. Run Debugger.
5. Confirm table renders.
6. Confirm diagnostic JSON copies.
7. Paste diagnostic JSON into `archive/prompt-1s-polymarket-feedback-loop.txt` and get exactly one next experiment.

## First Build Slice

Build in this order:

1. Add the tab shell and DOM contract.
2. Add service that can run baseline plus selected strategies.
3. Render aggregate comparison table.
4. Add Copy Diagnostic JSON for one candidate.
5. Add bucket diagnostics.
6. Add tests.

Do not build AI integration. Copy/paste is enough.

## Implementation Status

Implemented:

- lazy Strategy Panel tab `strategydebugger`
- partial `html-partials/tab-strategy-debugger.html`
- DOM contract `lib/strategy-debugger-dom.ts`
- service `lib/strategy-debugger-service.ts`
- renderer `lib/strategy-debugger-renderer.ts`
- pure analysis module `lib/strategy-debugger-analysis.ts`
- copyable `polymarket.strategy_debugger.v1` JSON
- active chart and Polymarket protection risk context in debugger JSON
- focused analysis tests in `tests/strategy-debugger-analysis.spec.ts`
- feature DOM contract coverage

The implemented V1 intentionally keeps AI integration as copy/paste through `archive/prompt-1s-polymarket-feedback-loop.txt`.
