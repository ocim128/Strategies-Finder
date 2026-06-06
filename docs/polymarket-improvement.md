# Polymarket Improvements Plan

## Purpose

Implementation-ready plan for low-risk, high-ROI Polymarket improvements scoped to:
- the browser app
- local SQLite API
- existing Polymarket evaluation paths and tests

This document is for planning and execution sequencing only. It does not authorize implementation.

## Assumptions

- Local SQLite endpoints (`/api/sqlite/*`) are the authoritative source for outcome rows and cached price points.
- `BacktestResult.polymarketTradeSummary` is the durable summary contract for reloads, diagnostics, and warnings.
- Annotation code in `lib/polymarket-trade-annotations.ts` and `lib/second-market/evaluation.ts` is the semantic source of truth.
- Degraded price-point or quote coverage should degrade gracefully, not hard-fail.

## Unknowns

- Whether external tooling depends on exact `debugLogger` event names.
- Whether Vite `/api/sqlite/*` server-side latency dominates after client-side caching improves.
- Whether in-flight work by other agents touches the same files.
- Whether undocumented UI flows depend on lazy-rebuild quirks rather than canonical annotation behavior.

## Architecture

### Module map

| Subsystem | Files |
|---|---|
| Outcome loading & series resolution | `lib/polymarket-btc5m.ts`, `lib/local-sqlite-polymarket-api.ts`, `lib/polymarket-outcome-interval.ts` |
| Price-point ensure/load/store | `lib/polymarket-price-points-ingest.ts`, `lib/polymarket-price-points.ts`, `lib/polymarket-history-client.ts` |
| Backtest annotation | `lib/polymarket-trade-annotations.ts`, `lib/polymarket-signal-exit-evaluator.ts`, `lib/second-market/evaluation.ts`, `lib/backtest-service.ts` |
| Lazy UI rebuild | `lib/polymarket-outcome-loader.ts`, `lib/quick-view/quick-view-service.ts`, `lib/renderers/tradesRenderer.ts`, `lib/polymarket-panel-service.ts` |
| Diagnostics & warnings | `lib/backtest-diagnostic-output.ts` |

### Existing tests

- `tests/polymarket-outcome-loader.spec.ts`
- `tests/polymarket-trade-annotations.spec.ts`
- `tests/polymarket-signal-exit.spec.ts`
- `tests/quick-view-polymarket.spec.ts`
- `tests/finder-polymarket.spec.ts`
- `tests/local-sqlite-polymarket-api.spec.ts`
- `tests/polymarket-outcome-evaluator.spec.ts`
- `tests/polymarket-price-points-ingest.spec.ts`
- `tests/strategy-ensemble-polymarket.spec.ts`
- `tests/polymarket-native-session-intervals.spec.ts`

### Data flows

**Non-1s annotation:**
1. UI/backtest selects market context
2. Outcome rows load from SQLite (symbol, time range, outcome symbol, outcome interval)
3. Same-event or limit-entry flows may ensure/load price points
4. Trades are annotated, summary computed and stored
5. Diagnostics and badges render

**1s second-market:**
1. UI/backtest selects market context
2. Second-market quotes and outcome rows load
3. `lib/second-market/evaluation.ts` applies CLOB-aware annotation
4. Diagnostics and badges render

### Duplicated logic (the core problem)

Three UI callers duplicate large parts of the annotation rebuild flow:
- `lib/polymarket-outcome-loader.ts`
- `lib/quick-view/quick-view-service.ts` (outcome loading, mode resolution, limit-entry assembly, price-point ensure, summary rebuild)
- `lib/renderers/tradesRenderer.ts` (same flow again for row-level badge rebuild)

**Primary risk:** These callers blend stored summary values and live UI values in different orders. Consolidation must preserve or make explicit that precedence.

## Constraints

### In-scope surfaces
- Outcome scoring and annotation
- Diagnostics and analysis
- Local SQLite transport for those paths

### Do not change
- Bridge export semantics
- Worker-facing alert contracts
- Execution Lab live-order behavior
- Direct Polymarket data-provider behavior
- SQLite endpoint URLs or payload shapes
- `BacktestResult` public fields
- Saved settings keys

### Module boundaries to preserve
- Transport/API logic stays in `lib/local-sqlite-polymarket-api.ts`
- Raw outcome loading stays in `lib/polymarket-btc5m.ts`
- Price-point fetch/caching stays in `lib/polymarket-price-points-ingest.ts`
- Low-level price lookup stays in `lib/polymarket-price-points.ts`
- Scoring rules stay in their existing modules
- UI orchestration stays in loader/service/renderer modules

### Allowed new boundary
- A new headless helper under `lib/` may orchestrate shared lazy-rebuild annotation steps.

### Disallowed
- Moving pricing semantics into UI modules
- Merging second-market logic into the non-1s path
- Adding global Polymarket caches in `state.ts`

## State Management Rule

For each rebuild action, resolve a single immutable Polymarket settings snapshot at the entry point and pass it through. Do not add new persistent app-level Polymarket state.

This fixes the current weakness: several consumers call `resolvePolymarketDomSettings()` repeatedly during a single rebuild, creating noise and risking mixed-setting reads if the user edits controls mid-flow.

## Shared Helper Design

### Module: `lib/polymarket-annotation-rebuilder.ts`

**Responsibilities:**
- Resolve market context and settings snapshot
- Determine non-1s vs 1s annotation path
- Resolve requested/effective exit mode
- Load outcome rows (non-1s)
- Assemble same-event and limit-entry options
- Call existing scoring functions
- Return normalized result for UI callers

**Not responsible for:**
- Defining scoring semantics
- Second-market quote loading (delegates to `lib/second-market/evaluation.ts`)
- Transport retry logic
- Writing to `state.ts`

**Input:**
```ts
{
  result: BacktestResult
  marketContext: { symbol: string; interval: string }
  settingsSnapshot: PolymarketDomSettings
  executionModel?: string
  preferStoredSummary: boolean
  allowSecondMarket: boolean
  caller: "panel" | "quick_view" | "trades"
}
```

**Output:**
```ts
{
  result: BacktestResult
  outcomesLoaded: number
  pricePointsLoaded: number
  effectiveExitMode: PolymarketExitMode
  usedSecondMarket: boolean
  usedPricePointEnsure: boolean
  usedFallback: boolean
  durationMs: number
}
```

**Design rules:**
- Orchestrate only; call existing annotation and summary builders
- Support stored-summary-first precedence where callers expect it
- Make it explicit whether a result was rebuilt from stored data or current UI settings

## Caching Design

### Outcome-row cache (`lib/polymarket-btc5m.ts`)
- **Type:** sequential in-memory, layered on existing `pendingOutcomeRequests`
- **Key:** `seriesId:startTs:endTs`
- **Value:** immutable copy of rows + `cachedAt`
- **TTL:** short-lived (10s-30s, tune during implementation)

### Price-point cache (`lib/polymarket-price-points-ingest.ts`)
- **Type:** sequential in-memory, layered on existing in-flight coalescing maps
- **Key:** `seriesId:eventStartTs[]` or normalized outcome signature via `buildEnsureKey(...)`
- **Value:** immutable merged sorted price-point array + `cachedAt`
- **TTL:** short-lived

### Invalidation rules
- TTL expiry
- Bypass after successful store/ensure when new data is newer than cached
- Never reuse across incompatible outcome intervals or series ids
- Never return cached arrays by mutable reference

### Non-goals
- No IndexedDB or localStorage cache additions
- No cross-session persistence
- No state-level cache registry

## Phases

### Phase 1: Baseline parity and instrumentation

**Goal:** Regression protection and baseline visibility before refactoring.

**Tasks:**
1. Audit existing Polymarket tests for coverage of: resolve-hold rebuilds, same-event rebuilds, second-market rebuilds, stored-summary precedence
2. Create `tests/polymarket-annotation-parity.spec.ts` with cases:
   - Non-1s resolve-hold
   - `1m` same-event
   - Stored summary overriding live UI fields
   - Limit-entry enabled
3. Compare outputs across: canonical annotation path, `PolymarketOutcomeLoader.attachLoadedPolymarketOutcomes(...)`, Quick View rebuild, Trades renderer rebuild
4. Add `debugLogger.info(...)` success-path instrumentation to `lib/polymarket-outcome-loader.ts`, `lib/quick-view/quick-view-service.ts`, `lib/renderers/tradesRenderer.ts` with: `path`, `symbol`, `interval`, `requestedMode`, `effectiveMode`, `outcomeInterval`, `outcomesLoaded`, `pricePointsLoaded`, `missingPriceTrades`, `duplicateTradesIgnored`, `durationMs`, `usedSecondMarket`, `usedPricePointEnsure`, `usedFallback`

**Risks:**
- UI consumers may lack clean test seams; may need narrow helper extraction or test shims.

**Validation:** parity tests fail on intentional drift; existing Polymarket tests pass; logs show enough fields for before/after comparison.

**Exit:** stable parity baseline exists; success/fallback paths are visible in logs; at least one test covers stored-summary precedence.

**Rollback:** remove added logs or tests independently.

---

### Phase 2: Shared annotation rebuild extraction

**Goal:** Remove duplicated annotation orchestration without changing scoring semantics.

**Tasks:**
1. Inventory duplicated logic in the three UI callers, categorized as: market-context resolution, settings precedence, outcome loading, exit-mode resolution, same-event assembly, limit-entry assembly, price-point ensure, summary rebuilding
2. Create the shared helper module (`lib/polymarket-annotation-rebuilder.ts`)
3. Extract common logic in smallest safe increments
4. Migrate callers in order: `PolymarketOutcomeLoader` -> Quick View -> Trades renderer
5. Run parity tests after each caller migration before touching the next
6. Keep `lib/second-market/evaluation.ts` delegated for 1s path

**Risks:**
- Callers intentionally use different stored-summary vs live-DOM precedence
- Quick View and Trades may have different degraded behavior when outcomes are missing
- Over-extraction could create an overly broad helper

**Validation:** Phase 1 parity tests pass after each migration; Quick View, outcome loader, and trade annotation tests pass; 1s tests unchanged.

**Exit:** UI rebuild paths share a headless helper; second-market behavior unchanged; duplicated orchestration materially reduced.

**Rollback:** revert individual callers to their local path while keeping shared helper and tests.

---

### Phase 3: Sequential in-memory caching

**Goal:** Reduce repeated SQLite and price-point ensure work across repeated rebuilds.

**Tasks:**
1. Add TTL cache for outcome-row loads in `lib/polymarket-btc5m.ts` (keep `pendingOutcomeRequests` for concurrent dedupe)
2. Add TTL cache for ensured/loaded price-point results in `lib/polymarket-price-points-ingest.ts` (keep existing coalescing maps)
3. Return immutable copies or frozen data from caches
4. Add cache hit/miss instrumentation

**Risks:**
- Aggressive TTL could hide just-synced SQLite updates
- Mutable array reuse could cause cross-caller contamination
- Under-specified cache keys could mix incompatible requests

**Validation:** existing transport and Polymarket tests pass; new tests for same-key requests within TTL; tests for stale-beyond-TTL; verify cache doesn't merge distinct series/intervals/events.

**Exit:** sequential repeated rebuilds skip redundant SQLite/ensure work; cache is bounded, deterministic, test-covered; no stale data past TTL.

**Rollback:** disable TTL cache reads while keeping in-flight dedupe intact.

---

### Phase 4: Memoization and settings snapshot cleanup

**Goal:** Reduce repeated CPU work and improve per-action determinism.

**Tasks:**
1. Identify repeated index-building (`indexPricePointsByEvent(...)`, `outcomeByEntryTs` maps) and memoize within same rebuild/result context
2. Replace repeated `resolvePolymarketDomSettings()` reads within single actions with one immutable snapshot in: `lib/polymarket-panel-service.ts`, `lib/quick-view/quick-view-service.ts`, `lib/renderers/tradesRenderer.ts`
3. Document stored-summary vs snapshot precedence at helper boundaries

**Risks:**
- Memoization keys must include result and settings identity
- Some callers intentionally mix stored summary with live settings

**Validation:** parity and behavior tests pass; rebuild logs show reduced duration on repeated same-result actions; stored-summary precedence unchanged.

**Exit:** single rebuild actions use stable settings snapshots; repeated derived indexing reduced; no deep DOM reads in rebuild path.

**Rollback:** revert memoization or snapshot plumbing without touching scoring.

---

### Phase 5: SQLite transport cleanup

**Goal:** Reduce duplicated request/timeout/error-handling code in the SQLite client.

**Tasks:**
1. Extract private shared request helpers in `lib/local-sqlite-polymarket-api.ts` covering: availability checks, timeout handling, 404 unavailable marking, JSON parsing, `ok` validation, error shaping
2. Keep public function signatures unchanged
3. Split read/write helpers if needed to avoid over-generalization

**Risks:**
- Minor error text changes may break brittle tests
- Over-generalized helper could obscure read vs write differences

**Validation:** transport tests pass; higher-level Polymarket tests pass; 404 and timeout behavior unchanged.

**Exit:** request boilerplate materially reduced; public behavior compatible; errors at least as explicit.

**Rollback:** restore per-endpoint request logic.

---

### Phase 6: Documentation alignment

**Goal:** Keep docs aligned with implemented changes.

**Tasks:**
1. Update `docs/polymarket.md` if caching, logging, or rebuild behavior changes troubleshooting flow
2. Update `AGENTS.md` only if safe-change guidance or validation habits change
3. Document new debug event names only if intended for ongoing use

**Validation:** doc references match real file paths; no docs claim unimplemented changes.

**Rollback:** N/A.

## Validation Matrix

### After every behavioral phase
```
npm run typecheck
npm run test -- polymarket
```

### Phase-specific tests

| Phase | Key specs |
|---|---|
| 1 | parity spec, loader spec, quick-view spec |
| 2 | parity spec, trade-annotations spec, signal-exit spec, quick-view spec |
| 3 | price-points-ingest spec, local-sqlite-polymarket-api spec, parity spec |
| 4 | parity spec, quick-view spec, loader spec |
| 5 | local-sqlite-polymarket-api spec, one higher-level spec for transport drift |
| 6 | None unless docs expose new operational contracts |

## Edge Cases

Exercise these explicitly during implementation:
- `1m` same-event exit vs `resolve_hold`
- `1s` second-market with exact-second quote requirements
- Stored summary mode differing from current UI settings
- Actual-entry-minute vs fixed-offset on `1m -> 5m`
- Limit-entry enabled vs disabled
- Entry cutoff enabled vs disabled
- Entry price filter enabled vs disabled
- Duplicate trades within the same event
- `open_position` blocked trades
- Missing price points with fallback settlement
- Unsupported symbol/interval combinations
- No-trade results
- Stale or newly synced local SQLite data

## Failure Handling

Preserve existing style:
- Return original or partially annotated result where possible
- Log warning or error
- Keep UI functional with degraded diagnostics

Cases needing explicit treatment:
- SQLite unavailable
- Price-point ensure timeout
- Partial ensure with fallback fetch
- Second-market annotation failure on 1s runs
- Malformed or missing stored summary
- Stale cache hit after local sync

## Out of Scope

- Database schema redesign
- Vite endpoint contract redesign
- New persistence layer
- Polymarket feature expansion
- Direct data-provider redesign
- Execution Lab architecture changes
- Worker or infrastructure redesign
