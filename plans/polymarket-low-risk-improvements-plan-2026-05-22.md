# Polymarket Low-Risk Improvement Implementation Plan

## Purpose

Plan the implementation of low-risk, high-ROI Polymarket improvements before changing behavior.

This document is planning only. It does not implement any improvement.

## Assumptions And Unknowns

- The scope is the Polymarket-focused findings from the code review: annotation cache keys, local SQLite probes, outcome-row pagination, 1s CLOB truncation visibility, optional gamma loading, proxy timeouts, price-point ensure bounds, and the stale deployability path.
- Existing architecture is Vite + TypeScript, runtime HTML partial injection, local SQLite through Vite middleware, browser state in `lib/state.ts`, and lazy feature loading through `lib/app-bootstrap.ts` / `lib/lazy-feature-init.ts`.
- Polymarket has separate contracts for direct charting, outcome scoring, diagnostics, bridge export, and Execution Lab live trade. This plan keeps those contracts separate.
- Local SQLite middleware is dev/preview middleware, not a production public API.
- Unknown: typical maximum row counts in `price-data/market-data.sqlite` and `price-data/1second-chart/second-market-data.sqlite`.
- Unknown: whether the dormant deployability UI should be restored or removed. Phase 6 requires a product decision before implementation.

## Current Architecture Snapshot

### Module Boundaries

- App entry/bootstrap: `index.ts`, `lib/app-bootstrap.ts`.
- Polymarket scoring support: `lib/polymarket-btc5m.ts`, `lib/polymarket-trade-annotations.ts`, `lib/polymarket-signal-exit-evaluator.ts`.
- Polymarket price points: `lib/polymarket-price-points.ts`, `lib/polymarket-price-points-ingest.ts`, `lib/local-sqlite-polymarket-api.ts`, `lib/local-sqlite-vite-plugin.ts`.
- Polymarket diagnostics panel: `html-partials/tab-polymarket.html`, `lib/polymarket-panel-service.ts`, `lib/polymarket-outcome-loader.ts`, `lib/polymarket-panel-dom.ts`.
- Quick View diagnostics: `lib/quick-view/quick-view-service.ts`, `lib/quick-view/quick-view-renderer.ts`.
- 1s CLOB data path: `lib/second-market-vite-plugin.ts`, `lib/second-market/api.ts`, `lib/second-market/evaluation.ts`, `lib/second-market/finder-runner.ts`.
- Execution Lab live path: `lib/execution-lab/*`. This plan does not change live order semantics.
- Proxies: `vite.config.ts` provides `/api/polymarket-event` and `/api/polymarket-history`.

### Data Flow

1. Backtest/Finder/Quick View identifies a Polymarket-supported run.
2. Outcome rows load through `loadPolymarketOutcomesForTimeRange(...)` -> `loadPolymarketOutcomes(...)` -> `/api/sqlite/load-polymarket-outcomes`.
3. Signal-exit and limit-entry paths ensure price points through `ensurePricePointsForOutcomes(...)` -> `/api/sqlite/load-polymarket-price-points` and `/api/sqlite/ensure-polymarket-price-points`.
4. 1s CLOB paths load outcomes, quotes, and optionally gamma snapshots through `loadSecondMarketEvaluationContext(...)`.
5. UI diagnostics reuse annotated `BacktestResult.trades` and `BacktestResult.polymarketTradeSummary`.

### API And Storage Contracts

- No schema migration is planned for `polymarket_outcomes`, `polymarket_price_points`, or second-market tables.
- API changes should be backward-compatible where possible:
  - Add optional response metadata such as `truncated`, `limit`, and a tie-safe pagination cursor if pagination is endpoint-driven.
  - Keep existing `rows`, `quotes`, and `gammaSnapshots` fields stable.
- Settings storage keys and Polymarket exit-mode semantics are not changed.

## Implementation Phases

### Phase 0: Baseline And Scope Lock

**Objective**

Establish a clean starting point and prevent implementation before the plan is accepted.

**Scope**

- Planning and baseline commands only.
- No source behavior changes.

**Technical Tasks**

- Confirm `git status --short`.
- Record baseline results before implementation:
  - `npm run typecheck`
  - `npm run test -- polymarket`
  - `npm run test -- finder-polymarket`
  - `npm run test -- quick-view-polymarket`
  - `npm run test -- second-market`
- Confirm whether all phases should be implemented or only the highest-priority subset.

**Dependencies**

- Node/npm available.
- Existing compact test runner behavior.

**Risks/Blockers**

- Existing unrelated failures could obscure regression signals.
- Filtered test names depend on `scripts/run-tests.ts` matching behavior.

**Deliverables**

- Recorded baseline command outcomes in implementation notes.
- Final selected phase list.

**Validation/Testing Criteria**

- Baseline commands either pass or failures are classified as pre-existing.

**Exit Criteria**

- Implementation scope is explicit.
- Baseline is known.

### Phase 1: UI Annotation Cache Correctness

**Objective**

Prevent stale Polymarket panel annotations after scoring-related settings change.

**Scope**

- `lib/polymarket-outcome-loader.ts`
- Focused panel/Quick View tests if needed.

**Technical Tasks**

- Extend `PolymarketOutcomeLoader.getResultSignature(...)` with settings that affect annotation output:
  - `readCurrentPolymarketExitMode()`
  - `readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent()`
  - `readCurrentPolymarketBacktestSlippageCents()`
  - `readCurrentPolymarketEntryCutoffEnabled()`
  - `readCurrentPolymarketEntryCutoffSeconds()`
- Add or update a focused test that proves changing one of these values invalidates the cached signature.
- Before adding a current-UI setting to the signature, confirm the attach path actually reads that setting for the active result shape. Do not use Phase 1 to change whether diagnostics follow the stored result summary or live UI controls.
- Do not change scoring semantics.

**Dependencies**

- Current `PolymarketOutcomeLoader` dependency injection already exposes the needed readers.
- Existing tests: `tests/quick-view-polymarket.spec.ts`, `tests/polymarket-signal-exit.spec.ts`.

**Risks/Blockers**

- Signature invalidation can trigger extra SQLite reads when users toggle settings frequently.
- Risk is bounded because it only re-runs existing annotation paths.
- If a setting is already frozen in `result.polymarketTradeSummary`, adding the live UI value to the signature could invalidate without changing output. Keep signature fields aligned with actual annotation inputs.

**Deliverables**

- Updated signature logic.
- Focused regression test or existing test update.

**Validation/Testing Criteria**

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\polymarket-signal-exit.spec.ts`

**Exit Criteria**

- Settings that affect Polymarket scoring also affect the loader signature.
- No Polymarket scoring tests regress.

### Phase 2: Local SQLite Request Efficiency

**Objective**

Remove avoidable `/api/sqlite/status` fan-out on normal Polymarket SQLite calls.

**Scope**

- `lib/local-sqlite-polymarket-api.ts`
- `lib/local-api-transport.ts` only if helper behavior needs clarification.
- Tests around local SQLite availability.

**Technical Tasks**

- Replace normal `checkSqliteApiAvailable(true)` calls with non-forced availability checks.
- Preserve forced checks for explicit test reset or deliberate refresh paths if needed.
- Verify failed availability still marks the API unavailable through existing `markLocalApiUnavailable(...)` paths.
- Add or update a test that multiple same-origin Polymarket calls do not force repeated status probes within the cache window.

**Dependencies**

- Existing `checkLocalApiAvailable(...)` cache semantics.
- Existing Polymarket SQLite client functions:
  - `loadPolymarketOutcomes`
  - `loadPolymarketPricePoints`
  - `ensurePolymarketPricePointsWithMetadata`
  - store helpers

**Risks/Blockers**

- If the dev server restarts within the cache window after a negative result, a non-forced check may delay recovery until cache expiry.
- Existing cache is 60 seconds, so this is acceptable for normal calls but should be documented in tests.

**Deliverables**

- Reduced status-probe fan-out.
- Test coverage for cached availability behavior.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- local-sqlite`
- `npm run test -- finder-polymarket`

**Exit Criteria**

- Normal Polymarket SQLite calls use the availability cache.
- Existing unavailable-API error handling remains intact.

### Phase 3: Outcome Row Pagination And Truncation Safety

**Objective**

Avoid silent under-scoring when Polymarket outcome ranges exceed the current 100k row cap.

**Scope**

- `lib/polymarket-btc5m.ts`
- `lib/local-sqlite-polymarket-api.ts`
- `lib/local-sqlite-vite-plugin.ts`
- Tests for range loading behavior.

**Technical Tasks**

- Add pagination to `loadPolymarketOutcomesForExpandedRange(...)`.
- Prefer additive endpoint metadata:
  - `limit`
  - `truncated`
  - a tie-safe cursor, such as `nextAfterStartTs` plus `nextAfterEventSlug`, if endpoint pagination is used
- If endpoint pagination is used, order rows by `event_start_ts ASC, event_slug ASC` and continue with a predicate equivalent to:
  - `event_start_ts > nextAfterStartTs`
  - or `event_start_ts = nextAfterStartTs AND event_slug > nextAfterEventSlug`
- Keep existing `rows` shape stable.
- Fetch until the requested expanded end timestamp is covered or no next page remains.
- Do not continue pages using `event_start_ts + 1`; multiple rows can share the same `event_start_ts`.
- If avoiding endpoint cursor changes, page by bounded time windows instead.
- Preserve concurrent request coalescing by keying the full expanded range, not individual pages.

**Dependencies**

- Existing SQLite query is ordered by `event_start_ts ASC`; cursor pagination must add a stable secondary order.
- Existing callers expect an array of `PolymarketOutcomeRow`.

**Risks/Blockers**

- Rows can share the same `event_start_ts`; pagination must not skip same-start rows at page boundaries.
- Endpoint metadata must not break tests that mock `{ ok: true, rows }` only.

**Deliverables**

- Paginated outcome loading.
- Backward-compatible endpoint response metadata.
- Tests for more-than-one-page loads.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- polymarket`
- `npm run test -- finder-polymarket`
- `npm run test -- quick-view-polymarket`

**Exit Criteria**

- Long outcome ranges load completely without relying on a single 100k cap.
- Existing single-page mocks still work.

### Phase 4: 1s CLOB Window Visibility And Performance

**Objective**

Make 1s CLOB quote range truncation explicit and skip unused gamma snapshot loading on pure annotation paths.

**Scope**

- `lib/second-market-vite-plugin.ts`
- `lib/second-market/api.ts`
- `lib/second-market/evaluation.ts`
- `lib/second-market/finder-runner.ts`
- Backtest/Quick View 1s annotation callers.

**Technical Tasks**

- Change `/api/second-market/clob-quotes` to query one extra row or otherwise report whether the current `LIMIT 250000` truncated results.
- Add response metadata such as `truncated` and `limit`.
- Teach `loadSecondMarketClobQuotesWithStats(...)` to carry the metadata.
- In Finder, surface truncation as a hard warning or status message, separate from low exact coverage.
- Add `includeGammaSnapshots?: boolean` to `loadSecondMarketEvaluationContext(...)`.
- Default `includeGammaSnapshots` to current behavior.
- Pass `includeGammaSnapshots: false` from annotation-only paths that do not execute strategies.

**Dependencies**

- Existing `SecondMarketClobQuoteStats`.
- Existing 1s CLOB tests: `tests/second-market-*.spec.ts`, `tests/quick-view-polymarket.spec.ts`.

**Risks/Blockers**

- Finder strategy execution may need gamma snapshots for strategies using Gamma helpers; do not disable gamma there.
- Backtest execution for `polymarket1sConfig` strategies may still need gamma context.
- Truncation and missing-coverage are different failure modes; do not collapse them into one percentage warning.

**Deliverables**

- Truncation-aware second-market quote API/client.
- Optional gamma loading with default-compatible behavior.
- Updated status messaging where relevant.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- second-market`
- `npm run test -- quick-view-polymarket`
- `npm run test -- finder-polymarket`

**Exit Criteria**

- Long 1s CLOB quote loads cannot silently truncate.
- Annotation-only paths avoid unused gamma snapshot work.

### Phase 5: Price-Point Ingestion Guardrails And Proxy Failure Handling

**Objective**

Bound local price-point ingestion work and prevent stalled upstream Polymarket proxy requests.

**Scope**

- `lib/polymarket-price-points-ingest.ts`
- `lib/local-sqlite-vite-plugin.ts`
- `vite.config.ts`
- Price-point ingestion tests.

**Technical Tasks**

- Add a maximum outcomes-per-request limit to `/api/sqlite/ensure-polymarket-price-points`.
- Chunk client-side ensure calls in `ensurePricePointsForOutcomes(...)` before POSTing to the middleware.
- Keep existing load chunking by `MAX_EVENT_STARTS_PER_LOAD_REQUEST`.
- Add `AbortSignal.timeout(...)` to `/api/polymarket-event` and `/api/polymarket-history` upstream fetches.
- Return clear timeout errors, preferably `504`, without changing success payloads.
- Keep existing proxy URL and query-parameter contracts.

**Dependencies**

- Existing `fetchPolymarketHistoryWithFallback(...)` retry behavior.
- Existing Vite middleware helper `sendJson(...)`.

**Risks/Blockers**

- Too-small ensure chunks could add overhead for first-run signal-exit scoring.
- Node runtime must support `AbortSignal.timeout`; current project targets Node 20+, so it should.

**Deliverables**

- Bounded ensure payloads.
- Timeout-protected Polymarket proxy middleware.
- Tests for chunking and timeout/failure response where practical.

**Validation/Testing Criteria**

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\polymarket-price-points-ingest.spec.ts`
- `npm run test -- polymarket`

**Exit Criteria**

- Huge price-point ensure requests are chunked or rejected predictably.
- Polymarket proxy upstream stalls do not leave middleware requests open indefinitely.

### Phase 6: Polymarket Panel Deployability Decision

**Objective**

Resolve the stale deployability path in the Polymarket panel.

**Scope**

- `lib/polymarket-panel-service.ts`
- `lib/polymarket-outcome-loader.ts`
- `lib/polymarket-deployability-analysis.ts`
- `html-partials/tab-polymarket.html` only if deployability UI is restored.
- `lib/polymarket-panel-dom.ts` only if structural ids are added.

**Technical Tasks**

- Decide one path:
  - Remove dead deployability methods/imports/cache if deployability is not currently a product requirement.
  - Or restore it explicitly by rendering deployability output into the current diagnostics content.
- If restoring:
  - Populate `outcomeByStartTs` when outcome rows load.
  - Decide whether `enrichHistoryInBackground(...)` should run, and where it should be triggered.
  - Avoid adding raw structural DOM lookups; update `polymarket-panel-dom.ts` and `html-partials/tab-polymarket.html` together if new ids are needed.
- If removing:
  - Remove unused deployability imports, cache fields, and unreachable methods.
  - Keep `lib/polymarket-deployability-analysis.ts` if tests or other modules still import it.

**Dependencies**

- Product decision: restore visible deployability diagnostics or remove stale panel path.
- Existing DOM contract test if markup changes.

**Risks/Blockers**

- Restoring the UI has higher regression risk than removal because it touches visible panel rendering.
- Fill-history enrichment may create remote request fan-out if started automatically without bounds.

**Deliverables**

- Either removed dead panel path or restored explicit deployability rendering.
- Tests aligned with the chosen behavior.

**Validation/Testing Criteria**

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` if markup/contracts change.
- `npm run test -- polymarket-deployability`
- `npm run test -- quick-view-polymarket`

**Exit Criteria**

- No no-op deployability references remain.
- Panel behavior matches visible UI and documentation.

### Phase 7: Documentation And Final Validation

**Objective**

Keep operational documentation aligned with changed Polymarket contracts.

**Scope**

- `docs/polymarket.md`
- `README.md` only if user-facing behavior changes.
- `AGENTS.md` only if safe-change guidance changes.
- Test and typecheck validation.

**Technical Tasks**

- Document any new truncation warnings or pagination behavior that affects operator expectations.
- Document any changed timeout behavior for direct Polymarket proxy usage.
- If deployability is restored or removed, align `docs/polymarket.md` with the actual panel behavior.
- Run focused validation first, then broader validation.

**Dependencies**

- Completed implementation phases.
- Stable final behavior.

**Risks/Blockers**

- Documentation can drift if updated before implementation details settle.
- E2E may remain environment-sensitive; do not treat unrelated E2E timing failures as implementation regressions without evidence.

**Deliverables**

- Updated docs only where behavior or operator expectations changed.
- Final validation summary.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test`
- Focused Polymarket tests:
  - `..\..\..\node_modules\.bin\esno tests\polymarket-signal-exit.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\finder-polymarket.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\quick-view-polymarket.spec.ts`
  - `..\..\..\node_modules\.bin\esno tests\polymarket-price-points-ingest.spec.ts`
  - `npm run test -- second-market`

**Exit Criteria**

- Focused and broad tests pass or failures are classified as pre-existing.
- Documentation matches implemented behavior.

## Rollback Strategy

- Keep each phase commit-sized and independently revertible.
- Prefer additive response metadata over replacing API shapes.
- If pagination or chunking causes performance regressions, revert the caller loop while keeping truncation metadata.
- If optional gamma loading causes any strategy-context drift, restore default eager gamma loading and keep only quote truncation metadata.
- If deployability restoration is unstable, revert to removal of dead panel code and keep pure analysis tests untouched.

## Cross-Phase Edge Cases

- Long 5m outcome ranges greater than 100k rows.
- 1s CLOB ranges that hit `LIMIT 250000`.
- Sparse price points with only one point per event.
- `signal_exit_same_event` with entry cutoff enabled.
- `signal_exit_same_event` with allow-multiple toggled.
- Native `15m` / `1h` outcome intervals.
- Second-market strategies that require `polymarket1sConfig`.
- Preview mode where Execution Lab live submission remains fenced.
