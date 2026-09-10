# Selection Rules Detailed Selection View — Technical Plan

Status: revised after skeptical audit
Date: 2026-09-10

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

The current selection means the most recent multi-candidate ledger event for
which the rule returned a pick. Single-candidate events and events where the
rule rejects every candidate are skipped while walking backward. The detail
probe for gated tail events is bounded; the view does not rescore the full
censored history. Outcome status distinguishes `COMPLETE`,
`SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE`, and `PENDING`. Performance
metrics use completed eligible events only, matching the current tally; the
selected count may additionally include bounded probe rows.

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
  `lib/batch-backtest/batch-backtest-service.ts` renders details from data
  already delivered in the coordinator summary; it does not provide a
  reusable details endpoint. Selection Rules needs a new endpoint because
  per-rule history cannot fit in its scalar result events or persisted
  last-run JSON. Reuse the presentation decisions that matter here: lazy
  rendering, a bounded scrollable table, and exclusion from copied/persisted
  summaries.

No database, migration, worker, deployment, or new external service is needed.
The detail data is retained only with the current Selection Rules server run,
using the same process-lifetime behavior as the existing status snapshot.

## Phase 1 — Produce compact detail data during the tally

### Objective

Expose enough structured information from the existing tally pass to answer
“what was selected, when, and how did it perform?” without changing summary
metrics.

### Tasks

1. Add a `PairSelectionDetailRow` and detail aggregate shape near the existing
   tally types in `lib/pair-selection/tally.ts`. Keep fields scalar:
   `signalTime`, pair/base/quote, direction, score, `tiedCount`, candidate
   count, outcome status, selected return, `othersMean`, and delta versus
   `othersMean`. The detail payload is separate from `PairSelectionResult`.
2. Add compact pair-performance aggregates grouped by `pair + direction`:
   selected count, completed count, wins, win rate, mean/median selected
   return, and mean delta versus `othersMean`.
3. Keep the existing summary path byte-stable: outcome gating remains before
   rule scoring, and completed detail rows are emitted from the picks/samples
   already produced by that path. Do not rescore every gated event.
4. Add a bounded detail-only probe from the archive tail for the current
   selection. Walk backward over at most
   `SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS = 64` multi-candidate
   events, score only those needed to find recent picks, and retain every pick
   found in that bounded tail. Do not add probe work to `picks`, `samples`,
   `scoredCandidates`, `unscoredEvents`, comparisons, or report lines. A probe
   row with a finite selected outcome but an incomplete candidate pool is
   `SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE`; a missing selected outcome is
   `PENDING`. A probe with a complete outcome can still be absent from summary
   aggregates when the normal reference-pick gate rejects its event.
5. Send the detail rows and aggregates through a separate detail payload or
   callback. Do not add a detail field to `PairSelectionResult`; the job's
   existing `featureResults` input to `writePairSelectionCheckReceipt(...)`
   must remain unchanged. If an implementation temporarily attaches detail
   metadata, the receipt's canonical JSON must strip it alongside diagnostics.
6. Keep the latest row deterministic by archive event order/time. Do not add
   candidate arrays, raw candles, signals, entry/exit prices, or rule feature
   objects to the detail shape. The archive retains the horizon PnL only, so
   entry and exit UTC columns are unavailable.

### Dependencies

Existing `pickPairSelectionRuleIndexed(...)`, horizon return index, and
`comparison(...)` helpers in `lib/pair-selection/tally.ts`.

### Risks or blockers

- The pending probe adds bounded detail-only scoring. Existing timing
  diagnostics must retain their current meaning. Do not add probe work to the
  existing tally counters; if probe measurement is needed, keep a separate
  detail-only counter outside `PairSelectionResult` and the receipt.
- A run with many selected rules can produce many event rows. The server store
  is explicitly capped in Phase 2; keep rows compact and retain one row per
  event, not one row per candidate.
- Pair performance must include direction so long and short selections are not
  mixed under one pair label.

### Deliverables

- Internal detail-row and pair-performance types plus a separate detail
  payload/sink.
- Detail rows and aggregates produced without changing the returned summary
  result.
- Existing scalar result/report output unchanged.

### Validation/testing

- Extend the focused tally tests to cover completed events, a pending latest
  event, a selected-outcome-known/pool-incomplete event, ties, long/short
   grouping, multiple pending tail selections, rule-rejects-all tail, and the
   configured probe cap.
- Assert that `eligibleEvents`, comparisons, success-bar fields, report lines,
  `scoredCandidates`, and `unscoredEvents` remain identical for the existing
  fixtures.
- Extend `tests/pair-feature-access.spec.ts` so adding detail production does
  not change the feature check receipt's `resultsSha256` or `receiptDigest`.
- Run the pair-selection parity and registry tests.

### Exit criteria

The tally can provide a separate latest/history/performance payload without
reloading the archive, the normal tally path does not score gated history, and
all existing summary, diagnostic, and receipt-digest assertions still pass.

## Phase 2 — Retain details and expose a local read endpoint

### Objective

Make detail data available on demand without placing large history arrays on
the NDJSON result event, status snapshot, or persisted last-run payload.

### Tasks

1. Extend `SelectionRulesJobArgs` in `lib/selection-rules/job.ts` with a
   narrowly scoped detail callback. Pass the separate detail payload after
   each rule/horizon tally; do not pass or mutate the receipt's
   `PairSelectionResult`.
2. Add a run-scoped detail store in
   `lib/selection-rules/server-vite-plugin.ts`, keyed by `ruleKey|horizonBars`.
   Retain the latest row, at most
   `SELECTION_RULES_DETAIL_HISTORY_CAP = 2_000` newest history rows per key,
   a `totalRows` counter, a `historyTruncated` flag, and streaming pair-plus-
   direction aggregates over all completed rows. The tally computes exact
   pair-level mean/median values before the store callback; the server retains
   those aggregate values, not per-event values for median calculation. The
   selected count may include bounded probe rows, while completed metrics
   exclude it. Do not
   store the archive, candidates, feature arrays, or candles. The cap is a
   design constraint, not a Phase 4 fallback.
3. Clear the store synchronously when a new run is installed. The existing
   test reset helper must clear it as well. Preserve the existing
   generation/run-id ownership checks so an old job cannot write into a newer
   run's store.
4. Add an authorized `GET /api/selection-rules/details` route to the existing
   Selection Rules plugin. Required query parameters are `runId`, `ruleKey`,
   and `horizonBars`; support bounded `offset`/`limit` for history. Use an
   initial page size of 250 and enforce a maximum page size of 500.
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
- The 2,000-row per-result cap means older history is intentionally omitted;
  expose `historyTruncated` and keep pair aggregates complete over all
  completed events.
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
  mismatch, invalid rule/horizon, pagination, cap/truncation, stale-generation
  behavior, and details available after cancellation/fatal terminal events.
- Keep `assertSelectionRulesWireEventIsScalar(...)` tests passing for every
  streamed event.
- Verify a completed run's status response remains unchanged in shape and
  size, and verify fixture NDJSON bytes are unchanged when the detail callback
  is attached.
- Add the details route to the existing route-authorization enumeration in
  `tests/selection-rules-server.spec.ts`.

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
4. Render signal timestamps in the existing UTC style. Show
   `COMPLETE`, `SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE`, or `PENDING`, with
   `n/a` only for unavailable fields. There are no entry/exit time columns:
   the pair-selection archive retains horizon PnL but not those timestamps.
   State that rows use the rule's default parameters because the job passes no
   parameter sweep. Do not infer or recalculate returns in the browser.
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

- There is no existing Selection Rules browser lifecycle harness. Test pure
  detail formatting/pagination helpers and stale-run guards, use
  `tests/feature-dom-contracts.spec.ts` for required structure, and cover the
  click-through with the manual smoke. Do not introduce a broad DOM harness
  solely for this feature.
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
2. Exercise a small fixture with completed, pending, and partially censored
   outcomes, then a 112-rule large ledger. Confirm the 2,000-row cap, complete
   aggregate counts, 250-row default page, 500-row hard maximum, endpoint
   response size, and browser render time.
3. Confirm a new run replaces the detail store. Confirm Stop/cancellation/
   fatal runs retain details for already-tallied rules consistently with the
   retained partial summary, and confirm no previous-run rows are exposed.
4. Confirm the existing strict success bar still excludes pending/right-censored
   events from performance comparisons.

### Dependencies

All previous phases and the repository's existing Selection Rules fixtures.

### Risks or blockers

If the measured 2,000-row cap is still too large for a many-rule run, stop and
revise the cap in this plan before implementation. Do not replace it with an
unbounded browser payload or silently spill into a new persistence system.

### Deliverables

- Passing focused validation and a documented manual smoke result.
- Measured confirmation that the stated retention and page-size constants are
  acceptable for the 112-rule run.

### Validation/testing

- `npm run typecheck`.
- Existing Selection Rules server/service tests plus the new detail tests.
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`.
- Manual run: start a Selection Rules job, open details while running and after
  completion, reload to reattach, stop a run, and start a new run.

### Exit criteria

The detail mode is demonstrably additive, local-only, bounded in server
retention, transport, and DOM rendering, and removable by reverting the detail
types/store/route/UI changes without changing Selection Rules summary,
diagnostic, or receipt behavior.

## Assumptions and open decisions

- “Currently selected” refers to the latest multi-candidate event where the
  rule produced a pick, with a bounded trailing probe for gated events. It is
  not the separate open-position TOP_MEAN snapshot.
- Detail history is newest-first in the UI; the underlying archive order and
  summary calculations remain unchanged.
- Detail data is intentionally process-lifetime state. Persisting it in
  localStorage or adding a database is out of scope.
- The initial retention cap is 2,000 rows per rule/horizon; the default page is
  250 rows and the hard maximum is 500. Phase 4 measures these explicit
  values rather than deferring the decision.
- Cancelled and fatal runs retain details for already-tallied results because
  their partial summaries are retained by the existing server state.
