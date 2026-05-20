# Engineering Improvements Plan

## Goal

Implement the highest-ROI low-risk engineering improvements identified in the code audit without changing trading semantics or adding new product features.

Primary outcomes:

- make time handling consistent across mixed timestamp shapes
- make endpoint dataset references and random searches reproducible
- preserve documented local data-source priority
- keep browser startup lazy-loading effective in development
- harden UI rendering and alert-token storage where external or persisted data reaches the browser

This document is planning-only. Do not begin implementation until the selected phase is explicitly approved.

## Assumptions And Unknowns

Assumptions:

- The target implementation set is the seven findings from the audit:
  - canonical backtest time normalization
  - full endpoint dataset hashing
  - dev debug-global lazy-loading preservation
  - local data-source priority correction
  - endpoint random-search reproducibility and failure reporting
  - live-position detail HTML escaping
  - alert worker token persistence hardening
- Changes should be incremental and independently shippable.
- Existing public UI behavior should remain stable unless the change fixes a documented contract mismatch.

Unknowns:

- Whether any external endpoint caller depends on sampled dataset hashes or non-deterministic random-search seeds.
- Whether users intentionally rely on persisted alert worker tokens across browser restarts.
- Whether length-first non-Binance local-source selection was intentional despite the README documenting source priority.

If an unknown blocks implementation, stop and document the decision instead of guessing.

## Current Repo Facts

- Browser startup enters through `index.ts` and delegates to `lib/app-bootstrap.ts`.
- Runtime feature loading already uses `lib/lazy-feature-init.ts`.
- Backtest time helpers live in `lib/strategies/backtest/backtest-utils.ts`.
- Generic timestamp normalization already exists in `lib/time-normalization.ts`.
- Endpoint routes and in-memory dataset cache live in `lib/backtest-endpoint-plugin.ts`.
- Endpoint execution delegates through `lib/backtest-endpoint-execution.ts` and `lib/backtest-executor.ts`.
- Data loading and persistence are split across `lib/data/data-fetcher.ts`, `lib/data/data-persistence.ts`, and `lib/candle-cache.ts`.
- Browser alert worker URL/token storage lives in `lib/alert-storage.ts`, consumed by `lib/alert-service.ts`.
- Live position UI rendering lives in `lib/handlers/live-positions-handlers.ts`.
- Existing HTML escaping helper is `lib/html-escape.ts`.
- Validation is run with `npm run typecheck` and focused specs through `npm run test -- <filter>`.

## Non-Goals

- No framework rewrite.
- No new database or standalone service.
- No microservice/API expansion beyond existing Vite middleware.
- No strategy behavior changes.
- No Rust engine changes unless a phase reveals a parity issue.
- No broad renderer refactor.
- No security redesign beyond the alert-token storage decision.

## System Architecture

The plan keeps the current architecture:

- Vite browser app with runtime-injected HTML partials.
- Local Vite middleware endpoints for backtest and data helpers.
- Shared TypeScript backtest engine with optional Rust acceleration.
- Browser-local persistence through `localStorage`, IndexedDB, and local SQLite middleware where already present.

Implementation should modify existing seams rather than creating new layers.

## Module Boundaries

Keep changes inside these ownership boundaries:

| Area | Primary files | Boundary rule |
| --- | --- | --- |
| Time normalization | `lib/time-normalization.ts`, `lib/strategies/backtest/backtest-utils.ts` | Centralize conversion; do not add ad hoc timestamp parsing elsewhere. |
| Endpoint cache/search | `lib/backtest-endpoint-plugin.ts`, endpoint tests | Keep endpoint behavior local to the existing Vite plugin. |
| Data source selection | `lib/data/data-persistence.ts`, data-fetcher tests | Do not change provider fetch behavior unless required by source selection. |
| Lazy debug globals | `index.ts`, lazy-init/bootstrap tests if needed | Preserve lazy feature modules by avoiding eager dev imports. |
| Live positions rendering | `lib/handlers/live-positions-handlers.ts`, `lib/html-escape.ts` | Escape interpolated strings or switch small fragments to DOM text APIs. |
| Alert storage | `lib/alert-storage.ts`, `lib/alert-service.ts` | Keep token storage behind the existing storage helper. |

## Data Flow

Relevant flows:

1. Backtest and feature code compare signal/trade/candle times using helpers from `lib/strategies/backtest/backtest-utils.ts`.
2. Endpoint callers upload candles to `/api/backtest/datasets`; the plugin stores an in-memory ref and later resolves requests by that ref.
3. Non-Binance local data candidates are loaded from imported data, SQLite, IndexedDB cache, and seed files before remote fallback.
4. Dev startup exposes optional debug globals from `index.ts`; direct imports here can bypass lazy feature initialization.
5. Alert worker credentials are read by `lib/alert-service.ts` through `lib/alert-storage.ts`.

No new persistent schema is required for the first six phases. Alert token storage may switch from durable to session-scoped browser storage.

## API And Contracts

Contracts to preserve or clarify:

- Backtest time helpers must accept unix seconds, unix milliseconds, ISO strings, and `BusinessDay`.
- Endpoint dataset refs must identify the actual candle payload, not a sample of it.
- Endpoint random search should return enough metadata to reproduce or diagnose the run.
- README data-source priority should either match implementation or be corrected in docs after a deliberate decision.
- Lazy feature initialization should stay meaningful in both production and development.
- Alert worker token persistence semantics must be explicit.

Additive endpoint response fields are preferred over breaking response shape changes.

## State Management

- Do not add global state for these phases.
- For alert token persistence, keep storage reads/writes in `lib/alert-storage.ts`.
- For endpoint search failures, return per-request metadata from the route handler instead of storing process-level diagnostics.
- Do not route unrelated app state through `lib/state.ts`.

## Observability And Logging

Use existing debug/logging patterns only where a phase benefits from diagnostics:

- Endpoint random search should expose failure counts in the response; optional server logs should be concise and not print full request bodies.
- Dataset hash collision handling should return a clear endpoint error if a caller reuses a `keyHint` for different candle content.
- Data-source priority changes should be covered by tests rather than new logs unless unexpected source switching is observed.

## Security Considerations

- Escaping live-position detail strings is a browser hardening fix for persisted or external data.
- Alert worker token storage is the only credential-handling change in scope.
- Do not log alert tokens.
- Do not move wallet/private-key handling into browser code.

## Performance Considerations

- Full endpoint dataset hashing is O(n) over uploaded candles. This happens at upload time and should be cheaper than repeated backtests/searches.
- Removing eager dev debug imports should improve dev startup and keep lazy-loading measurements meaningful.
- Time normalization should use existing helpers and avoid per-bar allocations in hot loops beyond current behavior.

## Rollback Strategy

Each phase should be independently revertible:

- Time normalization: revert helper change and focused tests.
- Dataset hashing: revert hash implementation and collision handling.
- Data priority: revert comparator and tests.
- Debug globals: revert `index.ts` debug exposure change.
- Random search metadata: revert additive fields and tests.
- UI escaping: revert rendering-only change.
- Alert storage: revert storage target and any migration/UX copy.

Avoid bundling unrelated phases in one commit.

## Phase 0: Baseline And Guardrails

### Objective

Create focused regression coverage before touching shared helper behavior.

### Scope

- Add or identify focused specs for time normalization, endpoint hashing/search, data-source priority, live-position rendering, and alert storage.
- No production code changes unless a missing test seam requires a tiny exported helper.

### Technical Tasks

1. Inventory existing specs:
   - `tests/data-interval-utils.spec.ts`
   - `tests/data-fetcher.spec.ts`
   - `tests/backtest-endpoint-plugin.spec.ts`
   - `tests/backtest-endpoint-batch.spec.ts`
   - `tests/data-cache.spec.ts`
2. Add focused tests only where coverage is missing.
3. Confirm tests can run individually through `npm run test -- <filter>`.
4. Record any baseline failures before implementation.

### Dependencies

- Existing Node test runner in `scripts/run-tests.ts`.
- Existing TypeScript typecheck.

### Risks/Blockers

- Some endpoint internals are not exported. Prefer route-level tests over broad exports.
- Test setup may need minimal fake middleware/request helpers from existing endpoint tests.

### Deliverables

- Focused test plan and, if approved for implementation, new or updated tests.
- No behavior changes.

### Validation/Testing Criteria

- `npm run typecheck`
- Focused existing specs still pass.

### Exit Criteria

- Each later phase has a concrete verification command.
- Any pre-existing failure is documented before code changes.

## Phase 1: Canonical Backtest Time Normalization

### Objective

Make equivalent timestamp shapes compare and index consistently in backtest-adjacent code.

### Scope

- `lib/strategies/backtest/backtest-utils.ts`
- Time-related tests.
- Optional cleanup of duplicate local `timeKey` wrappers only when directly touched.

### Technical Tasks

1. Change `timeToNumber(...)` to delegate to `parseTimeToUnixSeconds(...)`.
2. Keep `timeKey(...)` behavior stable unless tests prove map keys need canonicalization.
3. Add tests covering:
   - unix seconds vs unix milliseconds
   - ISO string vs equivalent unix seconds
   - `BusinessDay`
   - `compareTime(...)`
   - `getTimeIndex(...)` lookup behavior if canonical keys are changed
4. Search for local duplicate time helpers before finalizing.

### Dependencies

- `lib/time-normalization.ts`
- `lightweight-charts` `Time` type through existing project types.

### Risks/Blockers

- Changing map-key semantics can affect chart/tooling lookups. Start with numeric comparison only.
- Some callers may intentionally preserve raw string keys for display or data attributes.

### Deliverables

- Canonical numeric comparison path.
- Focused time helper tests.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- backtest`
- `npm run test -- cross-symbol`
- `npm run test -- portfolio` if canonical keys are changed

### Exit Criteria

- Mixed timestamp shapes sort consistently.
- No trading semantics change except fixed timestamp equivalence.

## Phase 2: Endpoint Dataset Identity And Random Search Diagnostics

### Objective

Make endpoint dataset refs trustworthy and random-search runs reproducible or diagnosable.

### Scope

- `lib/backtest-endpoint-plugin.ts`
- `lib/backtest-endpoint-contract.ts` only if response types need additive metadata.
- Endpoint route tests.

### Technical Tasks

1. Replace sampled `computeCandleHash(...)` with full-candle hashing.
2. If `keyHint` already exists with a different hash, return a clear 409-style endpoint error instead of overwriting silently.
3. Keep existing ref format for non-conflicting uploads.
4. For random search:
   - return the seed used
   - collect failed run count
   - return bounded failure summaries, not full stack traces
   - avoid silently treating `processed` as successful runs
5. Prefer additive fields such as `failed`, `failureSamples`, and `evaluated`.
6. Decide whether no-seed random search should remain non-deterministic; if yes, the returned seed is mandatory for replay.

### Dependencies

- Existing Vite middleware route tests in `tests/backtest-endpoint-plugin.spec.ts`.
- Existing endpoint contracts in `lib/backtest-endpoint-contract.ts`.

### Risks/Blockers

- External callers may compare hashes generated by the old sampled logic.
- A stricter `keyHint` collision error can surface previously hidden caller mistakes.
- Response type changes must remain backward-compatible.

### Deliverables

- Full-content dataset hash.
- Collision-safe dataset upload behavior.
- Random-search response diagnostics.
- Endpoint tests for hash sensitivity and failed-run reporting.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- backtest-endpoint-plugin`
- `npm run test -- backtest-endpoint-batch`

### Exit Criteria

- Two datasets that differ in any candle field cannot share a content hash.
- Random search reports how many generated param sets ran, failed, and returned.

## Phase 3: Local Data Source Priority Alignment

### Objective

Make non-Binance local data selection match the documented source priority unless a deliberate product decision says otherwise.

### Scope

- `lib/data/data-persistence.ts`
- Data-fetcher/persistence tests.
- README/docs only if implementation intentionally keeps length-first behavior.

### Technical Tasks

1. Change candidate sorting from length-first to source-priority-first, then length.
2. Preserve imported data as highest priority if that is intentional for user-provided datasets.
3. Add a test with:
   - shorter SQLite data
   - longer IndexedDB/seed data
   - expected selected source based on documented priority
4. If length-first behavior is intentionally retained, update README instead and stop this phase.

### Dependencies

- Existing `loadSqliteCandles`, `loadCachedCandles`, and `loadSeedCandlesFromPriceData` seams.
- Existing data fetcher test harness.

### Risks/Blockers

- Users may see fewer bars if SQLite has less history than seed/cache.
- The README contract says one thing; current implementation does another. The implementation owner must choose one explicitly.

### Deliverables

- Comparator fix or documentation correction.
- Focused data-source selection test.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- data-fetcher`
- `npm run test -- data-interval-utils`

### Exit Criteria

- Data-source selection behavior and docs agree.
- Selection is deterministic for equal candidate lengths.

## Phase 4: Preserve Lazy Loading In Development

### Objective

Prevent dev-only debug globals from eagerly importing optional feature modules at startup.

### Scope

- `index.ts`
- Optional lightweight test if existing test harness covers startup imports.
- No changes to `lib/app-bootstrap.ts` lazy feature registration unless required.

### Technical Tasks

1. Replace eager `Promise.all([import("./lib/command-palette"), import("./lib/scanner")])` with one of:
   - `VITE_EXPOSE_DEBUG_GLOBALS=1` only, or
   - lazy debug getter functions on `window`
2. Keep `__state` and `__debug` exposure cheap if still needed in dev.
3. Ensure scanner and command palette still load when explicitly requested.
4. Do not change production behavior.

### Dependencies

- Current lazy feature setup in `lib/app-bootstrap.ts`.
- Current scanner shortcut behavior in bootstrap.

### Risks/Blockers

- Developers may rely on `window.__scannerPanel` immediately existing in dev.
- A lazy getter changes console usage slightly.

### Deliverables

- Dev startup no longer imports scanner/command-palette unless requested.
- Clear debug-global behavior.

### Validation/Testing Criteria

- `npm run typecheck`
- Manual dev smoke:
  - `npm run dev`
  - app loads
  - scanner shortcut still works
  - debug globals behave as documented by code comments, if comments are added

### Exit Criteria

- Optional feature modules remain lazy during default dev startup.
- No broken scanner/command-palette access paths.

## Phase 5: Browser UI Hardening

### Objective

Remove avoidable HTML injection risk in live-position details.

### Scope

- `lib/handlers/live-positions-handlers.ts`
- `lib/html-escape.ts`
- Focused rendering test only if practical with existing DOM test setup.

### Technical Tasks

1. Import `escapeHtml`.
2. Escape interpolated string fields in `detailContent.innerHTML`:
   - `pos.symbol`
   - `pos.interval`
   - `pos.direction`
   - `pos.strategyKey`
   - `closedPos.exitReason`
   - any other non-numeric live-position field in the same template
3. Leave numeric formatting helpers unchanged.
4. Prefer minimal escaping over rewriting the renderer.

### Dependencies

- Existing `lib/html-escape.ts`.
- Existing live positions handler DOM structure.

### Risks/Blockers

- If a field intentionally contains HTML, escaping will display it literally. That should be acceptable for position metadata.

### Deliverables

- Escaped live-position detail rendering.
- Optional regression test for literal `<script>` or `<img onerror>` text.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- feature-dom-contracts` if structural DOM is touched
- Manual live-positions panel smoke if a DOM rendering test is not practical

### Exit Criteria

- User-controlled or persisted string fields cannot inject markup through the live-position detail template.

## Phase 6: Alert Worker Token Storage Hardening

### Objective

Reduce credential exposure from persistent browser storage while preserving the existing alert worker URL/token abstraction.

### Scope

- `lib/alert-storage.ts`
- `lib/alert-service.ts` only if API semantics need minor adjustment.
- Alert UI handlers only if a deliberate "remember token" option is added.

### Technical Tasks

1. Decide token persistence policy:
   - minimal hardening: use `sessionStorage` for token and keep URL in `localStorage`
   - compatibility path: read old `localStorage` token once, migrate to session, then remove old key
   - optional explicit remember-token setting only if requested
2. Keep `readAlertWorkerToken()` and `writeAlertWorkerToken()` as the only token storage boundary.
3. Do not log tokens.
4. Add tests or browser-storage unit coverage if existing patterns support it.

### Dependencies

- Existing alert storage helper.
- Existing alert service token callsites.

### Risks/Blockers

- Session-scoped token means users re-enter tokens after browser restart.
- Some browser contexts may block both localStorage and sessionStorage; existing catch-and-return behavior should remain.

### Deliverables

- Explicit token persistence policy in code.
- Optional migration from old durable token storage.
- Focused tests for read/write/clear behavior.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- alert` if alert-related specs exist
- Manual alert settings smoke:
  - save worker URL
  - enter token
  - run alert request
  - clear token

### Exit Criteria

- Alert token is not durably stored by default unless explicitly approved.
- Existing worker URL persistence remains unchanged.

## Cross-Phase Edge Cases

- Timestamp values can be seconds, milliseconds, ISO strings, or `BusinessDay`.
- Endpoint callers can reuse `keyHint`.
- Random search can generate invalid params for some strategies.
- Cached data can be shorter than seed data but higher priority.
- Dev globals may be referenced from browser console before feature modules load.
- Browser storage may throw in private or embedded contexts.
- Live-position records may contain unexpected strings from imported or persisted data.

## Cross-Phase Failure Handling

- Prefer explicit endpoint errors over silent fallback for dataset ref collisions.
- Return bounded random-search failure samples, not unbounded logs.
- For storage failures, preserve current fail-closed behavior: return empty token/URL and do not throw.
- For timestamp parse failures, preserve existing null/fallback behavior rather than throwing in hot paths.

## Recommended Implementation Order

1. Phase 0: Baseline and guardrails.
2. Phase 1: Time normalization.
3. Phase 2: Endpoint dataset identity and random-search diagnostics.
4. Phase 3: Local data-source priority alignment.
5. Phase 4: Preserve lazy loading in development.
6. Phase 5: Browser UI hardening.
7. Phase 6: Alert worker token storage hardening.

This order puts correctness and reproducibility first, then performance, then browser hardening. Phases 4-6 can be implemented independently once Phase 0 is complete.

## Final Acceptance Criteria

The plan is complete when all implemented phases satisfy:

- `npm run typecheck` passes.
- Focused tests for touched modules pass.
- No unrelated files are refactored.
- Endpoint response changes are additive or explicitly documented.
- Data-source priority behavior and docs agree.
- Security-sensitive values are not logged or newly exposed.
- Each phase can be explained as a direct fix for one audited finding.
