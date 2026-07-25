# OPEN_SCORE USD ACCELERATING — Implementation Plan

## Goal

Add an `ACCELERATING` selector arm to the existing OPEN_SCORE USD replay. It tests whether assets receiving fresh positive pair-entry flow outperform another asset receiving fresh positive flow at the same event.

`TOP_MEAN` remains unchanged and stays in the report as the baseline.

## Selector definition

At one timestamp, after all deltas have been applied:

```text
entryFlow(asset) = sum(delta for that asset where delta.isEntry === 1)
acceleration    = entryFlow(asset) / max(1, activePairCount(asset))
```

An ACCELERATING candidate must have:

```text
rawScore(asset) > 0
acceleration(asset) > 0
```

The selector chooses the highest acceleration with the existing deterministic FNV tie-break. An event is eligible only when at least two candidates pass the rule. The random control is the mean forward long return of the other eligible accelerating candidates.

This definition intentionally uses fresh entries only. Exit deltas do not create acceleration; an exit-only score improvement is not treated as new bullish information.

## Affected architecture

### Primary module

`lib/batch-backtest/batch-open-score-usd-replay-engine.ts`

- Extend internal `DecisionEvent` with the per-asset entry-flow snapshot.
- Add acceleration to the internal candidate/view records.
- Add an ACCELERATING selector series and random-control series.
- Add `horizon.accelerating` and ACCELERATING PNL fields.
- Add ACCELERATING report lines.

### Reused unchanged

- `lib/batch-backtest/batch-backtest-vite-plugin.ts`: existing `/api/batch-backtest/open-score-usd` route and stream.
- `lib/batch-backtest/batch-backtest-service.ts`: existing opaque `reportLines` display and copy paths.
- `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts`: existing `done.result` transport.
- `lib/batch-backtest/sp500-top-mean-coordinator-engine.ts`: existing shared replay invocation and report propagation.
- `lib/batch-backtest/compact-pair-artifact.ts`: existing entry/exit timestamps and trade directions.
- `lib/batch-backtest/max-active-research-contract.ts`: existing deterministic tie-break.

No new endpoint, DOM id, localStorage setting, database schema, Worker, secret, or deployment change is required.

## Data flow and contracts

1. Compact artifacts become the existing per-pair `ScoreDelta` streams.
2. During the existing timestamp group, accumulate entry-only signed deltas in addition to `rawScore` and `activePairCount`.
3. After the full timestamp group is applied, store a `DecisionEvent` snapshot when the timestamp contains an entry.
4. Candidate formation computes `acceleration` from the event snapshot.
5. The existing target loader supplies forward returns. No new target-data path is added.
6. Aggregation produces:
   - `ACCELERATING`: selected return versus the same-event random accelerating pool.
   - `ACCELERATING_PNL`: selected-return overlapping basket.
   - `ACCELERATING_RANDOM_PNL`: matching random-control basket.

Additive result fields:

```ts
horizon.accelerating: ReplayComparison;
horizon.pnl.accelerating: SelectorPnlSummary;
horizon.pnl.acceleratingRandom: SelectorPnlSummary;
```

Report lines per horizon:

```text
ACCELERATING             n=... top=... rand=... delta=... CI95=[...] +blocks=.../...
ACCELERATING_PNL         trades=... avg/trade=... sharpe=... winRate=...
ACCELERATING_RANDOM_PNL  trades=... avg/trade=... sharpe=... winRate=...
```

If no event has two valid accelerating candidates, report zero events and a warning. Do not zero-fill or fall back to TOP_MEAN.

## Phase 1 — Add causal entry-flow state

### Objective

Capture fresh signed entry flow without changing existing score or event semantics.

### Scope

Internal event construction in `batch-open-score-usd-replay-engine.ts`.

### Technical tasks

- Add an entry-flow array to internal `DecisionEvent`.
- Reset an entry-flow accumulator at each timestamp group.
- For every `ScoreDelta` with `isEntry === 1`, add its signed `delta` to the accumulator.
- Continue applying all entry and exit deltas to `rawScore` and `activePairCount` exactly as today.
- Store entry flow only after the complete timestamp group has been processed.
- Keep exit-only timestamps from creating events.

### Dependencies

- Existing `ScoreDelta.isEntry`, `compareDeltas`, k-way merge, and timestamp-group logic.

### Risks or blockers

- Entry flow must be captured before the accumulator is reset.
- Same-timestamp entries and exits must not expose a partial score snapshot.
- Entry flow is signed by trade direction and leg, so the existing long/short mapping must not be duplicated.

### Deliverables

- Internal `DecisionEvent` entry-flow data with no artifact or wire-schema change.

### Validation and testing criteria

- A fixture with multiple same-timestamp entries produces the summed entry flow.
- Exit-only score changes do not produce acceleration input.
- Existing same-timestamp leakage and score-direction tests remain unchanged and pass.

### Exit criteria

The engine can expose an entry-flow snapshot for every entry-bearing decision event, and existing selector outputs are unchanged.

## Phase 2 — Implement ACCELERATING aggregation

### Objective

Select accelerating candidates and calculate comparison/P&L results using the existing aggregation helpers.

### Scope

Candidate formation, target eligibility, horizon aggregation, and result fields in the replay engine.

### Technical tasks

- Add `acceleration` to the internal candidate record.
- Build the accelerating pool from `rawScore > 0` and `acceleration > 0`.
- Require at least two accelerating candidates.
- Select the maximum acceleration with the shared FNV tie-break.
- Build ACCELERATING series using the existing `appendSelection`/`buildComparison` pattern.
- Build `SelectorPnlSummary` values with `computeSelectorPnl`.
- Keep ACCELERATING eligibility independent from unrelated selector gates: only accelerating candidates must have finite returns for this arm.
- Do not alter TOP_MEAN, TOP_RAW, TOP_ADJUSTED, MAX_ACTIVE, reversion, or pairwise-control eligibility.
- Reuse the existing positive-asset target requests; do not add a second loader.

### Dependencies

- Phase 1 entry-flow snapshots.
- Existing `ReplayComparison`, `SelectorPnlSummary`, `SelectorSeries`, target return maps, and report aggregation.

### Risks or blockers

- ACCELERATING may have fewer events than TOP_MEAN; the report must expose that coverage difference.
- A candidate can have positive raw score but zero fresh flow and must be excluded.
- Missing data for a non-accelerating positive candidate must not suppress a valid ACCELERATING event.
- Existing aggregation currently has a shared all-positive validity gate; refactor it carefully so existing selectors retain their exact behavior while ACCELERATING uses its own gate.

### Deliverables

- `horizon.accelerating` comparison.
- `horizon.pnl.accelerating` and `horizon.pnl.acceleratingRandom` summaries.
- No new artifact or target-data contract.

### Validation and testing criteria

- A positive but static asset loses to an asset with lower score and positive fresh flow.
- One accelerating candidate yields zero ACCELERATING events.
- Equal acceleration is deterministic across artifact order.
- Missing non-accelerating target data does not remove an otherwise valid ACCELERATING event.
- ACCELERATING PNL equals `computeSelectorPnl` over its selected-return series.

### Exit criteria

The pure replay engine returns correct ACCELERATING comparison and P&L fields while all existing selector results remain stable.

## Phase 3 — Report integration and validation

### Objective

Expose the new arm through the existing Batch menu and verify it is research-useful across universes and time windows.

### Scope

Report construction, regression tests, and manual research validation. No new UI control.

### Technical tasks

- Add ACCELERATING comparison and PNL lines to `buildReportLines`.
- Add one model line stating “positive entry flow per active pair; exit-only changes excluded; overlapping PNL is non-compounding.”
- Add a zero-eligibility warning.
- Confirm both existing copy paths carry the lines verbatim.
- Compare ACCELERATING against TOP_MEAN, random, and rank-independent baselines across 12/24/48 bars.
- Run the same pair universe on multiple date windows and at least one alternative pair graph.
- Record ACCELERATING coverage and selected-asset concentration.

### Dependencies

- Phase 2 result fields.
- Existing opaque report-line contract in `docs/batch-backtest-server-side.md`.

### Risks or blockers

- Overlapping PNL is descriptive, not account PNL.
- A positive result in one pair graph may be graph construction bias.
- Short-horizon returns may be dominated by the configured slippage and commission.

### Deliverables

- ACCELERATING report output in normal Batch and S&P 500 TOP_MEAN runs.
- Focused regression coverage and a reproducible comparison table.

### Validation and testing criteria

```text
npm run typecheck
..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-max-active.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-selector-pnl.spec.ts
..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

Manual checks:

- Repeated runs produce identical ACCELERATING output.
- Stop and server reattach remain responsive.
- No array fields are added to scalar Batch stream rows.
- Existing report lines are byte-for-byte unchanged except for the additive ACCELERATING lines/model warning.

### Exit criteria

ACCELERATING has causal event construction, independent eligibility, deterministic results, passing regression tests, and documented sensitivity to pair universe and date window.

## Performance and memory

- Reuse the existing event arrays and candidate views; add only one numeric entry-flow snapshot per decision event.
- Do not retain target datasets beyond the existing per-asset outcome pass.
- Do not add per-event records to NDJSON or browser state.
- Do not raise existing Batch/Finder cache caps for this experiment.

## Failure handling

- Invalid artifact/trade timestamps follow existing omission behavior.
- First events need no baseline because acceleration is entry-flow based.
- Fewer than two positive-flow candidates produces an explicit zero-event arm.
- Non-finite returns are omitted for the ACCELERATING arm; never zero-filled.
- Cancellation follows existing `shouldStop` paths and must not emit partial success.

## Rollback

Remove the additive ACCELERATING fields, report lines, entry-flow state, and focused tests. Existing artifacts, endpoints, persisted settings, and other selector arms require no migration or cleanup.
