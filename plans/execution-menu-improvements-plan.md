# Execution Menu Improvement Plan

## Purpose

Plan low-risk, high-ROI improvements for the Execution Lab tab and adjacent Execution settings contracts before implementation.

This document is implementation planning only. No behavior changes are included here.

## Assumptions And Unknowns

- "Execution menu" means the Strategy Panel `Execution Lab` tab (`data-tab="executionlab"`, `#executionlabTab`) plus the Execution settings section where it shares settings contracts.
- Execution Lab currently runs only for supported `1s` chart symbols through local Vite middleware.
- Execution Lab never places live orders; it paper-fills against live Binance candles and live Polymarket CLOB quotes.
- Existing architecture is Vite + TypeScript, runtime HTML partial injection, id-driven handlers, browser state in `lib/state.ts`, chart updates through `lib/chart-manager.ts`, and local dev/preview middleware in `lib/execution-lab/execution-lab-vite-plugin.ts`.
- Unknown: typical live session length and expected maximum marker/trade counts in real use.
- Unknown: external consumers of `/api/execution-lab/*` beyond the browser app and existing tests.
- Unknown: whether the user wants all improvements implemented together or selected by priority after this plan is reviewed.
- Known planning constraint: Phase 1, Phase 2, Phase 4, and Phase 6 are the lowest-risk implementation candidates. Phase 3 and Phase 5 need a before/after measurement or explicit acceptance because they touch visible chart behavior and live remote-fetch freshness.

## Current Architecture Snapshot

### Module Boundaries

- Bootstrap: `index.ts` delegates to `lib/app-bootstrap.ts`.
- Lazy feature registry: `lib/lazy-feature-init.ts`, registered from `lib/app-bootstrap.ts`.
- Tab lazy activation map: `TAB_TO_FEATURE` in `lib/lazy-feature-init.ts`.
- Execution Lab UI/service: `lib/execution-lab/execution-lab-service.ts`.
- Execution Lab DOM contract: `lib/execution-lab/execution-lab-dom.ts`.
- Execution Lab API client: `lib/execution-lab/execution-lab-api.ts`.
- Execution Lab dev/preview middleware: `lib/execution-lab/execution-lab-vite-plugin.ts`.
- Paper lifecycle logic: `lib/execution-lab/paper-session.ts`.
- Log schema validation: `lib/execution-lab/paper-log-schema.ts`.
- Chart rendering surface: `lib/chart-manager.ts`.
- Execution settings HTML: `html-partials/tab-settings-section-execution.html`.
- DOM contract test: `tests/feature-dom-contracts.spec.ts`.
- Execution Lab tests: `tests/execution-lab-*.spec.ts`.

### Data Flow

1. User starts a paper session from `#executionlabTab`.
2. `ExecutionLabService.prepareSession()` snapshots strategy, params, backtest settings, capital settings, Polymarket settings, stake, and session metadata.
3. Browser calls local Vite middleware:
   - `/api/execution-lab/session/start`
   - `/api/execution-lab/live-candles`
   - `/api/execution-lab/live-events`
   - `/api/execution-lab/live-quote`
   - `/api/execution-lab/live-outcomes`
   - `/api/execution-lab/log`
4. Service polls every second, merges candles, fetches active event/quote/outcomes, runs `executeBacktest(...)`, evaluates paper fills, appends log records, and updates the chart/UI.
5. Logs are JSONL under `logs/paper-execution/<strategy>/<symbol>/<yyyy-mm-dd>/<session-id>.jsonl`.

## Implementation Phases

### Phase 0: Baseline And Selection

**Objective**

Establish a clean baseline and confirm which improvements are in scope before code changes.

**Scope**

- No implementation.
- Measurement and task selection only.

**Technical Tasks**

- Confirm `git status --short` is clean or identify unrelated work.
- Record current validation baseline:
  - `npm run typecheck`
  - `npm run test -- execution-lab`
  - `npm run test -- feature-dom-contracts`
  - `npm run build` if bundle/startup effects will be measured.
- Confirm whether all phases should be implemented or only the highest-priority subset.

**Dependencies**

- Node/npm installed.
- Existing tests runnable from repo root.

**Risks/Blockers**

- Existing unrelated failures could obscure regression signals.
- `npm run build` may produce existing warnings unrelated to this work.

**Deliverables**

- Baseline command results recorded in the implementation notes or PR summary.
- Final selected phase list.

**Validation/Testing Criteria**

- Baseline commands complete or failures are classified as pre-existing.

**Exit Criteria**

- Scope is explicit and implementation can start without guessing.

### Phase 1: Lazy-Load Execution Lab

**Objective**

Remove Execution Lab from the eager app bootstrap path.

**Scope**

- `lib/app-bootstrap.ts`
- `lib/lazy-feature-init.ts`
- Existing lazy feature trigger flow in `lib/lazy-feature-init.ts`
- Execution Lab service import boundary only

**Technical Tasks**

- Remove the static `executionLabService` import from `lib/app-bootstrap.ts`.
- Remove the `execution-lab-ui` bootstrap feature from `APP_BOOTSTRAP_FEATURES`.
- Register Execution Lab through the existing lazy feature registry:
  ```ts
  registerLazyFeature("execution-lab", async () =>
      (await import("./execution-lab/execution-lab-service")).executionLabService.init()
  );
  ```
- Add the tab mapping in `lib/lazy-feature-init.ts`:
  ```ts
  executionlab: "execution-lab",
  ```
- Ensure `initial-data-load` no longer depends on `execution-lab-ui`; use `settings-autosave` or the latest required post-restore bootstrap feature that still exists.
- Confirm `executionLabService.init()` remains idempotent.
- Confirm no direct non-tab trigger is needed. If one exists, wire it through `attachLazyFeatureTrigger(...)` rather than reintroducing eager import.

**Dependencies**

- `strategy-panel-shell.html` uses `data-tab="executionlab"`.
- `attachTabLazyListener()` reads `TAB_TO_FEATURE` and dispatches tab changes after bootstrap.

**Risks/Blockers**

- If any non-tab code expects Execution Lab event handlers before the tab opens, lazy-loading could delay those handlers. Current evidence points to tab-local controls only.
- If active saved tab is Execution Lab, startup must still initialize it after `attachTabLazyListener()`.
- If `TAB_TO_FEATURE` is not updated, the dynamic import will be registered but never activated from the tab.

**Deliverables**

- Execution Lab service loaded only when the Execution Lab tab is activated.
- Bootstrap dependency chain remains valid.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- feature-dom-contracts`
- Manual or automated smoke: open Execution Lab tab, start/stop button handlers are bound.
- Optional bundle check: `npm run build` and inspect whether the eager chunk shrinks or warning output changes.

**Exit Criteria**

- App starts without eager Execution Lab import.
- Execution Lab still initializes correctly when selected.
- Active-tab bootstrap initializes Execution Lab when the saved/current tab is `executionlab`.

### Phase 2: Candle And Quote Buffer Efficiency

**Objective**

Remove avoidable sorting and allocation from the 1-second polling loop before touching chart rendering behavior.

**Scope**

- `lib/execution-lab/execution-lab-service.ts`
- Internal data structures only.

**Technical Tasks**

- Extract pure helpers if needed so append/replace behavior can be tested without DOM/chart setup.
- Replace `mergeCandles(...)` full `Map` rebuild and sort with ordered append/replace:
  - append if incoming timestamp is greater than the current tail.
  - replace if incoming timestamp equals the current tail.
  - use full sort fallback only for out-of-order or overlapping batches.
  - trim to `MAX_STREAM_CANDLES`.
- Cache sorted quote arrays within a poll:
  - compute live quote buffer once.
  - compute strategy quote buffer once.
  - compute Polymarket price points once when chart update needs them.
- Consider dirty flags for quote maps only if per-poll local variables do not cover all callers.
- Keep `MAX_POLYMARKET_PRICE_POINTS` trimming behavior.

**Dependencies**

- `loadExecutionLabLiveCandles(...)` usually requests from `lastBufferedTs + 1` to latest timestamp.
- `paper-session.ts` expects quote arrays in chronological order.

**Risks/Blockers**

- Binance can return duplicate or delayed candles; fallback path must preserve correctness.
- Quote maps may receive missing trade quotes out of chronological order.

**Deliverables**

- Normal candle merge path is O(k), where k is new candles.
- Quote buffers are sorted at most once per poll per buffer.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- execution-lab`
- Add/adjust focused tests for append, replace, duplicate, and out-of-order candle merge if helper extraction is needed.

**Exit Criteria**

- Existing paper session behavior is unchanged.
- Hot-loop sorting/allocation is materially reduced.

### Phase 3: Chart Hot-Path Performance

**Objective**

Stop rebuilding full chart datasets every second during live paper sessions.

**Scope**

- `lib/execution-lab/execution-lab-service.ts`
- `lib/chart-manager.ts`
- No changes to backtest semantics or paper fill logic.
- Implement only after Phase 2 unless profiling shows chart `setData(...)` is already the dominant remaining cost.

**Technical Tasks**

- Measure or instrument the current steady-state chart update path before changing rendering:
  - full `setData(...)` call count per poll.
  - candle count passed to chart render.
  - approximate poll duration before/after the render call.
- Split paper stream rendering into initial/backfill and incremental update paths:
  - keep a full `setData` path for initial load and out-of-order recovery.
  - add an incremental method that calls `candlestickSeries.update(...)` for newly appended or replaced candles.
- Update `state._ohlcvTimeMap` incrementally for new paper stream candles instead of rebuilding from all candles each poll.
- Avoid unconditional `timeScale().scrollToRealTime()` when no new candle was added.
- Keep Heikin-Ashi handling correct. If incremental Heikin-Ashi update is not simple, fall back to full `setData` only when `state.chartMode === "heikin-ashi"` and document that tradeoff.
- Preserve chart restore behavior in `ExecutionLabService.stop()`.
- Keep marker rendering separate from candle updates; do not change paper marker lifecycle in this phase.

**Dependencies**

- Current full render path: `chartManager.displayPaperStreamData(...)`.
- Current service calls this method at session start and after every poll.
- Phase 2 should identify whether a poll added, replaced, or skipped candles.

**Risks/Blockers**

- Lightweight Charts incremental updates require monotonic time or same-time replacement.
- Heikin-Ashi candle values depend on prior candles, so incremental handling may require retaining previous transformed candle state.
- Paper stream mode mutates chart display independently of `state.ohlcvData`; restore path must remain intact.
- `state._ohlcvTimeMap` supports chart tooltip/crosshair behavior, so incremental map updates must be verified with hover/crosshair smoke checks.

**Deliverables**

- Full chart render is limited to initial load/backfill/recovery.
- Normal 1-second poll updates only the latest candle(s).

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- execution-lab`
- Manual smoke: start Execution Lab, chart updates, markers remain visible, stop restores normal chart data.
- Performance check: confirm normal poll path avoids full `candlestickSeries.setData(...)`.
- Crosshair smoke: hover recent paper-stream candles and confirm tooltip values still resolve.

**Exit Criteria**

- Per-poll chart update work is O(new candles) for normal candlestick mode.
- Visual behavior remains equivalent for start, live update, and stop.
- If instrumentation shows Phase 2 removed enough overhead and chart updates are not material, this phase can be deferred rather than implemented speculatively.

### Phase 4: Batch Logging And API Contract Hardening

**Objective**

Reduce local API/log overhead and tighten the file-writing API contract.

**Scope**

- `lib/execution-lab/execution-lab-api.ts`
- `lib/execution-lab/execution-lab-vite-plugin.ts`
- `lib/execution-lab/paper-log-schema.ts`
- `tests/execution-lab-log-schema.spec.ts`
- Relevant Execution Lab API tests

**Technical Tasks**

- Add a batch log endpoint:
  - `POST /api/execution-lab/logs`
  - body shape: `{ records: ExecutionLabRecord[] }`
  - validate every record before writing.
  - cap batch length to a small operational bound, for example 100 records, and keep the existing `MAX_BODY_BYTES` limit.
  - append one JSONL string with all records.
- Keep existing `POST /api/execution-lab/log` for compatibility.
- Change browser `appendRecords(...)` to send batches.
- Tighten log validation:
  - `stakeUsd > 0`.
  - `paper_entry.entryPrice > 0 && entryPrice <= 1`.
  - `paper_exit.exitPrice >= 0 && exitPrice <= 1` because resolution exits can be `0`.
  - `recordedAtIso` must parse as a valid date.
  - `/session/start` request symbol should pass the same supported-symbol validation used by live endpoints.
- Defer per-session write tokens unless explicitly selected as a separate security change. It changes API shape and is not required for batching.

**Dependencies**

- Session path storage currently uses `sessions: Map<string, string>` inside the Vite plugin.
- Existing validation uses `validateExecutionLabRecord(...)`.

**Risks/Blockers**

- Batch endpoint must handle partial invalid payloads by rejecting the whole batch to keep logs coherent.
- Session stop currently deletes the session from `sessions`; batch containing `session_stop` must delete after append succeeds.
- If a batch contains records for multiple session ids, reject it unless a concrete use case exists. Current service batches one session at a time.

**Deliverables**

- Fewer POSTs per poll.
- One file append per record batch.
- Stricter invalid input rejection.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- execution-lab-log-schema`
- `npm run test -- execution-lab-live-quote`
- Add tests for batch logging validation and session deletion on batched `session_stop`.

**Exit Criteria**

- Existing single-record log endpoint still works.
- Batch endpoint is covered and used by Execution Lab service.
- Invalid records cannot corrupt paper log JSONL.

### Phase 5: External Fetch Coalescing And TTL Cache

**Objective**

Reduce repeated Gamma requests and rate-limit sensitivity without making live CLOB quotes stale.

**Scope**

- `lib/execution-lab/execution-lab-vite-plugin.ts`
- Tests around live events/outcomes/quotes where practical.

**Technical Tasks**

- Add small in-memory TTL cache in the Vite plugin:
  - active live events keyed by `symbol|outcomeInterval|seriesId`, TTL 2 seconds by default.
  - closed outcomes keyed by `symbol|outcomeInterval|seriesId|startTs|endTs`, TTL 10-15 seconds by default.
- Coalesce in-flight identical requests before adding longer-lived caching. Coalescing reduces duplicate calls without freshness tradeoffs.
- Do not cache live CLOB quote responses in this phase; quote freshness matters more than request reduction.
- Keep browser responses `Cache-Control: no-store`; this is server-side dev middleware caching only.

**Dependencies**

- `fetchLiveEvents(...)` and `fetchLiveOutcomes(...)` are pure enough for keyed caching.
- Current middleware is process-local and stateful already via session map.

**Risks/Blockers**

- Too-long active event TTL could delay recognition of a new event around boundary transitions; keep TTL short and consider bypassing cache when the current event is near `eventEndTs`.
- Closed outcome cache should not hide late settlement corrections for too long; prefer shorter TTL over fewer calls.

**Deliverables**

- Bounded TTL caches with explicit keys and expiry.
- Tests or test hooks to verify cache hit/miss behavior without waiting real time.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- execution-lab-live-quote`
- Add a focused middleware test that two identical outcome requests within TTL perform one upstream fetch.

**Exit Criteria**

- Repeated identical Gamma calls are reduced.
- Boundary freshness remains acceptable for a 1-second polling UI.
- CLOB quote endpoint remains uncached.
- If in-flight coalescing produces enough reduction, TTL caching can be skipped instead of added speculatively.

### Phase 6: Execution Settings Contract Test

**Objective**

Catch Execution settings DOM/schema drift before runtime.

**Scope**

- `tests/feature-dom-contracts.spec.ts` or a new focused settings contract spec.
- `html-partials/tab-settings-section-execution.html`
- `lib/backtest-settings-dom-contract.ts`

**Technical Tasks**

- Extract `id` attributes from form controls in `tab-settings-section-execution.html`.
- Assert every relevant input/select id is registered in `BACKTEST_SETTINGS_DOM_IDS`.
- Maintain an explicit allowlist only for structural/UI-only ids that should not persist as backtest settings.
- Keep this test narrow to Execution settings to avoid surfacing unrelated legacy drift.

**Dependencies**

- `BACKTEST_SETTINGS_DOM_IDS` already centralizes settings contracts.
- Existing registry test already checks section registration, not individual control registration.

**Risks/Blockers**

- Some controls may be intentionally handled outside backtest settings; those need explicit allowlist entries with comments.
- Regex-based HTML extraction is consistent with current DOM contract tests but still limited.

**Deliverables**

- Focused regression test for Execution settings controls.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- feature-dom-contracts`
- `npm run test -- strategy-panel-settings-registry`

**Exit Criteria**

- Adding an Execution settings input without a contract fails tests unless intentionally allowlisted.

## Cross-Cutting Considerations

### State Management

- Execution Lab session state should remain private to `ExecutionLabService`.
- Shared app state writes should not be added unless chart restore or selected strategy/symbol behavior requires them.
- Settings should continue through existing settings readers and `readPersistedJson(...)` for Execution Lab stake persistence.

### API And Contracts

- Preserve existing `/api/execution-lab/log` while introducing `/logs`.
- Avoid changing `ExecutionLabRecord` shape unless schema tests and log docs are updated.
- Any new endpoint fields must be optional or versioned unless all callers are updated together.

### Observability And Logging

- Existing JSONL records are the primary observability surface for paper sessions.
- Batch logging must not drop individual records silently; invalid batches should return a clear `400`.
- If performance instrumentation is added, keep it dev-local and avoid noisy per-second console logs.

### Security Considerations

- The Vite middleware writes local files and calls remote APIs; keep symbol/path validation strict.
- Continue sanitizing path parts with `sanitizeExecutionLabPathPart(...)`.
- Do not expose arbitrary file paths or accept client-provided log paths.
- Consider a per-session log token only as a separate security phase because it changes the endpoint contract.

### Performance Considerations

- Highest-impact hot path is the 1-second poll loop in `ExecutionLabService.poll()`.
- Avoid full chart `setData`, full candle resorting, repeated quote sorting, and multiple log POSTs in normal steady state.
- Keep correctness fallbacks for out-of-order candles and Heikin-Ashi chart mode.

### Failure Handling

- Existing transient poll errors should continue through `tryLivePollFetch(...)`.
- Batch logging failure should still stop the session only if it means log integrity cannot be trusted.
- Chart restore should remain best effort on stop/error, matching current behavior.

### Rollback Strategy

- Each phase is separable:
  - lazy-load change can be reverted by restoring eager bootstrap import/init.
  - chart incremental path can fall back to current full `displayPaperStreamData(...)`.
  - candle/quote optimizations are internal and can be reverted independently.
  - batch log endpoint can be disabled by switching `appendRecords(...)` back to single-record calls.
  - TTL cache can be bypassed by setting TTL to `0` or removing cache lookup.
  - contract test can be reverted without runtime impact if it blocks unrelated work.

## Recommended Implementation Order

1. Phase 0: Baseline and selected scope.
2. Phase 1: Lazy-load Execution Lab.
3. Phase 2: Candle and quote buffer efficiency.
4. Phase 4: Batch logging and API hardening.
5. Phase 6: Execution settings contract test.
6. Phase 3: Chart hot-path performance.
7. Phase 5: External fetch TTL cache.

Rationale: start with low-risk module-boundary and allocation wins, then API/log reliability, then visible chart behavior and remote caching where regressions are easier to notice.

## Final Validation Matrix

- `npm run typecheck`
- `npm run test -- execution-lab`
- `npm run test -- feature-dom-contracts`
- `npm run test -- strategy-panel-settings-registry`
- `npm run test`
- Optional after lazy-loading/chart work: `npm run build`
- Manual smoke if UI behavior changes:
  - open Execution Lab tab.
  - start paper session on a supported `1s` symbol.
  - confirm status, latest candle, quote, chart candles, YES/NO lines, and markers update.
  - stop session and confirm original chart data/trade markers restore.
