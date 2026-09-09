# Selection Rules Detailed Selection View — Technical Plan

Status: proposed  
Date: 2026-09-09

## Purpose and scope

Add an on-demand detail view to the Selection Rules result table. For one
`ruleKey` + `horizonBars` result, the view should show:

- the latest pair selected by that rule in the loaded ledger;
- the chronological selection history, including score, direction, and the
  completed horizon result when available;
- performance grouped by selected pair and direction.

The existing summary table, success bar, report text, copy behavior, archive
eligibility rules, and comparison semantics remain unchanged. The detail view
is a research inspection surface; it is not a new backtest or order-execution
path.

The current selection means the latest multi-candidate ledger event selected by
the rule. If its horizon has not completed, it is shown as `PENDING` with
outcome fields set to `n/a`. Performance aggregates use completed eligible
events only, matching the current tally.

## Existing architecture and constraints

- `lib/pair-selection/tally.ts`
  - `tallyPairSelectionRule(...)` loads the already parsed archive, calls
    `pickPairSelectionRuleIndexed(...)`, and computes selected return, the
    leave-one-out `othersMean`, and reference returns.
  - `PairSample` is currently private and contains the completed outcome data.
  - The current strict gate omits events with fewer than two candidates or a
    missing horizon outcome from the summary tally.
- `lib/selection-rules/stream-types.ts`
  - `SelectionRuleResult` is deliberately scalar except for `reportLines`.
  - `assertSelectionRuleResultIsScalar(...)` protects the NDJSON contract;
    full history must not be added to streamed result rows.
- `lib/selection-rules/job.ts`
  - loads one `PairSelectionArchive` per job and reuses it across rules and
    horizons;
  - converts each `PairSelectionResult` with
    `resultFromPairSelection(...)` before emitting a `rule_result` event.
- `lib/selection-rules/server-vite-plugin.ts`
  - owns the run lock, generation checks, status snapshots, and local-only
    `/api/selection-rules/*` routes;
  - retains the latest run in process memory for status reattachment.
- `lib/selection-rules/service.ts` and
  `html-partials/tab-selection-rules.html`
  - render the result table and reports;
  - currently toggle a selected row on click but have no detail panel or
    detail request.
- The TOP_MEAN detail control in
  `html-partials/tab-batch-backtest.html` and
  `lib/batch-backtest/batch-backtest-service.ts` is the presentation pattern
  to follow: fetch/use detail data only when requested, render a bounded
  scrollable table, and keep detail rows out of copied/persisted summaries.

No database, migration, worker, deployment, or new external service is needed.
The detail data is retained only with the current Selection Rules server run,
using the same process-lifetime behavior as the existing status snapshot.

## Phase 1 — Produce compact detail data during the tally

### Objective

Expose enough structured information from the existing tally pass to answer
“what was selected, when, and how did it perform?” without changing summary
metrics.

### Tasks

1. Add an internal `PairSelectionDetailRow` shape near the existing tally
   types in `lib/pair-selection/tally.ts`. Keep fields scalar:
   `signalTime`, pair/base/quote, direction, score, `tiedCount`, candidate
   count, outcome status, selected return, `othersMean`, and delta versus
   `othersMean`.
2. Add compact pair-performance aggregates grouped by `pair + direction`:
   selected count, completed count, wins, win rate, mean/median selected
   return, and mean delta versus `othersMean`.
3. In `tallyPairSelectionRule(...)`, select the winner for every
   multi-candidate event once. Record a detail row even when the horizon is
   pending; continue adding to `PairSample` only when the existing strict
   outcome/reference gates pass.
4. Return detail data on the internal `PairSelectionResult` while leaving
   `PairSelectionTally`, `resultFromPairSelection(...)`, and the scalar
   `SelectionRuleResult` fields semantically unchanged.
5. Keep the latest row deterministic by archive event order/time. Do not add
   candidate arrays, raw candles, signals, or rule feature objects to the
   detail shape.

### Dependencies

Existing `pickPairSelectionRuleIndexed(...)`, horizon return index, and
`comparison(...)` helpers in `lib/pair-selection/tally.ts`.

### Risks or blockers

- Scoring pending events changes the meaning of timing diagnostics such as
  `scoredCandidates`; document and test the new meaning if the counter now
  includes selections needed only for detail output.
- A run with many selected rules can produce many event rows. Keep rows
  compact and retain only one row per event, not one row per candidate.
- Pair performance must include direction so long and short selections are not
  mixed under one pair label.

### Deliverables

- Internal detail-row and pair-performance types.
- Detail rows and aggregates returned by `tallyPairSelectionRule(...)`.
- Existing scalar result/report output unchanged.

### Validation/testing

- Extend the focused tally tests to cover completed events, a pending latest
  event, ties, long/short grouping, and a missing outcome.
- Assert that existing `eligibleEvents`, comparisons, success-bar fields, and
  report lines remain identical for the completed-event fixture.
- Run the pair-selection parity and registry tests.

### Exit criteria

One tally result can provide the latest selection, paged history source rows,
and pair/direction performance without reloading the archive, while all
existing summary assertions still pass.

## Phase 2 — Retain details and expose a local read endpoint

### Objective

Make detail data available on demand without placing large history arrays on
the NDJSON result event, status snapshot, or persisted last-run payload.

### Tasks

1. Extend `SelectionRulesJobArgs` in `lib/selection-rules/job.ts` with a
   narrowly scoped result-detail callback (or equivalent internal hook). Call
   it with the internal `PairSelectionResult` after each rule/horizon tally.
2. Add a run-scoped detail store in
   `lib/selection-rules/server-vite-plugin.ts`, keyed by `ruleKey|horizonBars`.
   Store only the compact rows, latest row, and pair aggregates; do not store
   the archive, candidates, feature arrays, or candles.
3. Clear the store synchronously when a new run is installed and when the
   retained run is reset. Preserve the existing generation/run-id ownership
   checks so an old job cannot write into a newer run's store.
4. Add an authorized `GET /api/selection-rules/details` route to the existing
   Selection Rules plugin. Required query parameters are `runId`, `ruleKey`,
   and `horizonBars`; support bounded `offset`/`limit` for history, with a
   server-enforced maximum page size.
5. Return a typed response containing `latest`, `rows`, `totalRows`,
   `hasMore`, and pair-performance aggregates. Return explicit 400/404-style
   errors for invalid queries, a run mismatch, or unavailable details.
6. Keep this endpoint local-only under the same authorization wrapper as the
   catalog, run, stop, and status routes.

### Dependencies

Phase 1 detail types and the existing route helpers,
`parseRunId(...)`, `registerLocalJsonRoute(...)`, and run generation state.

### Risks or blockers

- Details are available only while the same Vite process retains that run. A
  browser reload can reattach to the run; a Vite restart cannot restore the
  in-memory detail store. The UI must state this clearly instead of silently
  showing stale or empty data.
- Do not put detail arrays into `SelectionRuleResult`, terminal events, or
  `SelectionRulesStatusRun`; that would violate the scalar transport contract
  and enlarge every status poll.
- Bound the page size and avoid returning all history by default. The server
  may retain compact rows in memory, but the browser should render only one
  page at a time.

### Deliverables

- Job-to-plugin detail handoff.
- Generation-safe, run-scoped detail retention.
- `GET /api/selection-rules/details` with pagination and validation.

### Validation/testing

- Extend `tests/selection-rules-server.spec.ts` for detail storage, run-id
  mismatch, invalid rule/horizon, pagination, and stale-generation behavior.
- Keep `assertSelectionRulesWireEventIsScalar(...)` tests passing for every
  streamed event.
- Verify a completed run's status response remains unchanged in shape and
  size apart from the existing summary fields.

### Exit criteria

Given a retained run and result key, the endpoint returns the latest row,
bounded history, and pair performance; a stale or restarted run fails loudly;
the existing stream/status contract remains scalar and compatible.

## Phase 3 — Add the detailed mode to the Selection Rules tab

### Objective

Give the result table a coordinator-style “show details” workflow without
changing the existing report and diagnostics surfaces.

### Tasks

1. Add a small detail area to `html-partials/tab-selection-rules.html`: a
   heading/status line, a hide control, a latest-selection summary, a
   history disclosure/table, and a pair-performance disclosure/table. Add
   only the structural IDs required by `lib/selection-rules-dom.ts`.
2. Add a `Details` action to each generated result row in
   `lib/selection-rules/service.ts`. Keep row selection styling separate from
   opening details.
3. On click, request the first history page from the new endpoint using the
   active run ID and the row's `ruleKey|horizonBars`. Render the latest row
   immediately and provide a bounded “load older” action while `hasMore` is
   true.
4. Render timestamps in the same UTC style used by TOP_MEAN details. Show
   `PENDING`/`n/a` for incomplete outcomes, and color only display values; do
   not infer or recalculate returns in the browser.
5. Keep details out of `reportLines`, Copy Report, Copy Diagnostics, and the
   persisted last-run JSON. If details are unavailable after a server restart,
   show the endpoint error in the detail area and leave the summary usable.
6. Add the required detail IDs to the Selection Rules DOM contract and update
   only the Selection Rules stylesheet for the bounded table/disclosure.

### Dependencies

Phase 2 endpoint and response shape; existing Selection Rules service run-id
ownership and lazy stylesheet initialization; existing research-tab disclosure
styles where suitable.

### Risks or blockers

- The page must not render thousands of rows at once. Use the server page
  limit and a scroll container consistent with TOP_MEAN details.
- Results can arrive while a run is still active. Ignore a response whose
  `runId` no longer matches `activeServerRunId`.
- The detail panel must not accidentally become part of copied report text or
  persisted terminal state.

### Deliverables

- A per-result Details action.
- Latest selection summary, paged history, and pair/direction performance
  tables.
- DOM contract and focused Selection Rules styles updated together.

### Validation/testing

- Extend the browser service lifecycle test to click Details, verify latest
  selection, pending outcome rendering, history ordering, pair aggregates, and
  load-older behavior.
- Verify stale run responses do not replace a newer run's detail panel.
- Run the feature DOM contract test and manually inspect narrow and wide tab
  layouts.

### Exit criteria

Selecting any completed result row opens a useful detail view with the latest
selection and historical performance; the summary table, reports, copy paths,
and reattach behavior remain unchanged.

## Phase 4 — Final verification and rollback readiness

### Objective

Confirm the feature is additive, bounded, and safe to remove if the detail
surface proves too expensive or misleading.

### Tasks

1. Run `npm run typecheck` and the focused pair-selection, Selection Rules
   server, Selection Rules service, and DOM-contract specs.
2. Exercise a small fixture with completed and pending outcomes, then a large
   ledger with multiple rules. Record detail-store size, endpoint response
   size, and browser render time.
3. Confirm Stop, cancellation, fatal errors, status reattachment, and a new
   run clear or replace the detail store without exposing previous-run rows.
4. Confirm the existing strict success bar still excludes pending/right-censored
   events from performance comparisons.

### Dependencies

All previous phases and the repository's existing Selection Rules fixtures.

### Risks or blockers

If a many-rule run makes the in-memory detail store materially increase heap,
stop before broadening scope. The fallback is to reduce the retained history
window or introduce a bounded artifact store in a separate plan; do not add an
unbounded browser payload as a workaround.

### Deliverables

- Passing focused validation and a documented manual smoke result.
- A measured retention/page-size decision for the initial implementation.

### Validation/testing

- `npm run typecheck`.
- Existing Selection Rules server/service tests plus the new detail tests.
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`.
- Manual run: start a Selection Rules job, open details while running and after
  completion, reload to reattach, stop a run, and start a new run.

### Exit criteria

The detail mode is demonstrably additive, local-only, bounded in transport and
DOM rendering, and removable by reverting the detail types/store/route/UI
changes without changing the existing Selection Rules summary behavior.

## Assumptions and open decisions

- “Currently selected” refers to the latest selection event in the chosen
  mining-ledger folder, not the separate open-position TOP_MEAN snapshot.
- Detail history is newest-first in the UI; the underlying archive order and
  summary calculations remain unchanged.
- Detail data is intentionally process-lifetime state. Persisting it in
  localStorage or adding a database is out of scope.
- The initial page size should be chosen from measurement in Phase 4; a
  bounded default (for example, a few hundred rows) is preferred over a fixed
  unbounded response.
