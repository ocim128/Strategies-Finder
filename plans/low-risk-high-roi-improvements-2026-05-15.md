# Low-Risk High-ROI Engineering Improvement Plan

## Assumptions And Unknowns

- This is a planning artifact only. No improvement implementation is included here.
- The current app architecture is Vite + TypeScript, browser runtime HTML partial injection, local SQLite/IndexedDB market-data cache, optional Rust backtest engine, and optional Cloudflare Worker alerts.
- Local SQLite endpoints in `vite.config.ts` are dev/preview middleware, not a production public API.
- `npm run test` intentionally excludes `tests/e2e.spec.ts`.
- Unknown: real production-like data volume in `price-data/market-data.sqlite` and `price-data/1second-chart/second-market-data.sqlite`.

## Verified Baseline

- `git status --short`: clean before this planning document was added.
- `npm run typecheck`: pass, 4.83s.
- `npm run test -- --jobs=4`: pass, 103/103 specs, 12.88s.
- `npm run build`: pass, 3.63s, main JS chunk `dist/assets/index-CNKPGOVT.js` is 1067.6 KB.
- Build emits repeated warnings where modules are dynamically imported but also statically imported, so those dynamic imports do not create separate chunks.
- `git ls-files .wrangler` shows one tracked Miniflare D1 SQLite file: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/390a93dcabc6f134406233fc49f1d88a3f081f9942702092f4978dc30058d626.sqlite`.
- Ad hoc strict test compilation included 0 tests in normal `tsconfig.json`; compiling tests directly surfaces many existing type drift errors. Runtime tests still pass.

## Current Architecture Constraints

- App startup runs through `index.ts` -> `lib/app-bootstrap.ts` -> `lib/bootstrap-feature-registry.ts`.
- Layout is injected from `html-partials/*` by `lib/layout-manager.ts`.
- Structural DOM ids are intended to live in feature-local `*-dom.ts` modules.
- Blob-style localStorage persistence should use `lib/persisted-json.ts` where a versioned shape exists.
- General candle cache flow is `lib/data-manager.ts` -> `lib/data/data-fetcher.ts` -> `lib/local-sqlite-api.ts` / IndexedDB / seed files / remote providers.
- Polymarket SQLite client already has a stronger pattern in `lib/local-sqlite-polymarket-api.ts`: request timeout, in-flight availability probe coalescing, and test reset.
- Test execution is centralized in `scripts/run-tests.ts`.
- Worker runtime state uses `.wrangler/` only for local Miniflare state; worker source and migrations live in `workers/`.

## Implementation Phases

### Phase 0: Baseline And Guardrails

**Objective**

Lock in the current validated state and avoid mixing implementation with measurement.

**Scope**

- Validation commands only.
- No behavior changes.

**Technical Tasks**

- Record current `typecheck`, `test`, and `build` results.
- Keep the build warning output for before/after comparison.
- Confirm `.wrangler` tracked files before repo hygiene changes.

**Dependencies**

- Node/npm available.
- Current tests passing.

**Risks/Blockers**

- E2E remains environment-sensitive and is not part of the compact baseline.

**Deliverables**

- Baseline numbers in this document.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- --jobs=4`
- `npm run build`

**Exit Criteria**

- Baseline is documented and reproducible.

### Phase 1: Reliability And Security Quick Wins

**Objective**

Remove avoidable hangs, request fan-out, and tracked local runtime state.

**Scope**

- `lib/local-sqlite-api.ts`
- SQLite status branch in `vite.config.ts`
- `scripts/run-tests.ts`
- `.gitignore`
- Git index cleanup for tracked `.wrangler` local state

**Technical Tasks**

- Add general SQLite request timeout and in-flight availability coalescing, mirroring `lib/local-sqlite-polymarket-api.ts`.
- Add `resetLocalSqliteApiAvailabilityForTests()` and cover concurrent status coalescing.
- Make `/api/sqlite/status` cheap by default. Keep `totalCandles` behind `?includeCount=1` if anything still needs it.
- Add per-spec timeout support to `scripts/run-tests.ts` with CLI/env override.
- Print compact test results as specs complete instead of only after all children exit.
- Add `.wrangler/` to `.gitignore`.
- Remove the tracked local Miniflare D1 SQLite file from the Git index while leaving local files intact.

**Dependencies**

- Existing local SQLite tests in `tests/local-sqlite-api.spec.ts`.
- Existing test runner behavior in `scripts/run-tests.ts`.

**Risks/Blockers**

- Timeout defaults must be high enough for slower machines and filtered heavy specs.
- If external tooling consumes `totalCandles` from `/api/sqlite/status`, switch it to `?includeCount=1`.
- Git index cleanup should be reviewed because it removes a tracked file.

**Deliverables**

- Hardened general SQLite client.
- Bounded test runner.
- No tracked local `.wrangler` runtime database.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- local-sqlite-api`
- `npm run test -- --jobs=4`
- `git ls-files .wrangler` returns no local state files.

**Exit Criteria**

- SQLite availability probes are bounded and coalesced.
- A hung spec fails with a clear runner timeout instead of hanging indefinitely.
- Local worker D1 state is ignored and untracked.

### Phase 2: Build Signal And Startup Surface Cleanup

**Objective**

Make Vite chunk warnings actionable again and reduce avoidable eager imports.

**Scope**

- `index.ts`
- `lib/app-bootstrap.ts`
- `strategyRegistry.ts`
- Potentially `lib/scanner/*` import boundaries

**Technical Tasks**

- Remove debug-global dynamic imports for modules already statically included, especially `state` and `debug-logger`.
- Convert scanner shortcut and `scanner:load-symbol` handlers to import `./scanner` lazily at use time instead of statically importing `scannerPanel` in `app-bootstrap`.
- Gate verbose `strategyRegistry.ts` console logs behind `import.meta.env.DEV` or route them through `debugLogger` with consistent event names.
- Re-run build and compare warnings plus main chunk size.

**Dependencies**

- Existing lazy feature initialization in `lib/lazy-feature-init.ts`.
- Scanner exports in `lib/scanner/index.ts`.

**Risks/Blockers**

- Scanner keyboard shortcut must still work before the Scanner tab is opened.
- Do not lazy-load stateful singleton modules in a way that creates separate singleton instances.

**Deliverables**

- Fewer static/dynamic import warnings.
- Smaller or cleaner main bundle.
- Less production console noise.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- app-bootstrap`
- `npm run build`
- Manual smoke for `Ctrl+Shift+S` scanner shortcut if scanner import is changed.

**Exit Criteria**

- Build warnings are reduced or remaining warnings are known core-module tradeoffs.

### Phase 3: Cache Metadata Correctness

**Objective**

Keep in-memory candle cache metadata consistent with cache entry eviction and invalidation.

**Scope**

- `lib/data/data-cache.ts`
- `lib/data-manager.ts`
- Focused DataCache tests

**Technical Tasks**

- Centralize DataCache entry removal so `lruCache` and `cacheSyncAtByKey` are evicted together.
- Make `delete()` and `invalidate()` clear `syncAtByKey`.
- When LRU evicts the oldest candle entry, also evict its sync timestamp.
- Add tests for LRU eviction and explicit invalidation metadata cleanup.

**Dependencies**

- Current `DataFetcher` uses `cache.syncAtByKey` to decide whether to skip persistence refresh.

**Risks/Blockers**

- Some callers may rely on `syncAtByKey` surviving candle entry eviction, but that would be a stale-cache coupling.

**Deliverables**

- DataCache metadata no longer outlives entries.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run test -- data-fetcher`
- New focused cache metadata test

**Exit Criteria**

- Reused cache keys cannot inherit stale sync timestamps from evicted entries.

### Phase 4: Incremental Type Safety For Tests

**Objective**

Stop test type drift from growing without requiring a repo-wide test rewrite.

**Scope**

- `tests/`
- New test fixture helpers
- Optional new `tsconfig.tests.json` or narrower `tsconfig.tests.contract.json`
- `package.json` scripts

**Technical Tasks**

- Add small test builders for common typed fixtures: `time(sec)`, `ohlcv(...)`, `trade(...)`, and minimal `BacktestResult`/`BacktestSettings` builders.
- Start with a narrow typecheck subset that already aligns or can be fixed quickly.
- Avoid turning on strict test compilation for all existing tests in one pass.
- Add `npm run typecheck:tests` once the selected subset is clean.

**Dependencies**

- `Time` comes from `lightweight-charts` and many tests currently use raw numbers.
- Some tests intentionally validate legacy settings that no longer exist in current types.

**Risks/Blockers**

- Compiling all tests today is noisy; this must be incremental.
- Old tests may need `unknown as` casts when intentionally constructing legacy payloads.

**Deliverables**

- A small typed fixture surface.
- A test typecheck script that catches new drift in the cleaned subset.

**Validation/Testing Criteria**

- `npm run typecheck`
- `npm run typecheck:tests`
- `npm run test`

**Exit Criteria**

- New tests have a typed path that does not require copy-pasted `as any` fixtures.

### Phase 5: Browser Storage Hardening

**Objective**

Avoid UI failures when browser storage is unavailable, blocked, or full.

**Scope**

- `lib/alert-storage.ts`
- `lib/live-positions-storage.ts`
- `lib/handlers/settings-ux-handlers.ts`
- Existing `lib/persisted-json.ts` patterns

**Technical Tasks**

- Wrap simple localStorage reads/writes in safe helpers with fallback values.
- Keep existing key names stable.
- Use `readPersistedJson` only where versioned object payloads are introduced; do not force JSON envelopes onto simple boolean/string keys unless migration is required.
- Add focused tests for unavailable/throwing localStorage.

**Dependencies**

- Existing key names: `alert_worker_url`, `livePositionsCollapsed`, `livePositionsEnabled`, `playground_settings_preset`.

**Risks/Blockers**

- Changing key shape would break saved settings; do not change shape for simple keys.

**Deliverables**

- Storage failures degrade to defaults instead of throwing.

**Validation/Testing Criteria**

- `npm run typecheck`
- Focused storage tests
- `npm run test -- settings-compat`

**Exit Criteria**

- Alerts, live positions, and settings UX can initialize with unavailable localStorage.

## Ranked Findings

### 1. Harden The General SQLite Candle Client

**Problem**

`lib/local-sqlite-api.ts` performs `/api/sqlite/status`, `load-ohlcv`, and `store-ohlcv` fetches without request timeouts or in-flight availability coalescing. Concurrent cold loads can fan out duplicate status probes. The status endpoint in `vite.config.ts` also runs `SELECT COUNT(*) AS count FROM candles` even though clients only need `response.ok`.

This matters because Finder, Scanner, Portfolio Lab, and chart loads depend on fast local data fallback. A hung local dev endpoint can stall data loading, and repeated status probes add avoidable local IO.

**Why This Is High ROI**

The Polymarket SQLite client already has the safer pattern, so the implementation is mostly a local port. Impact is reliability and local data latency with minimal behavior change.

**Risk Level**

Low. The change bounds existing calls and preserves fallback behavior. The only contract to watch is `totalCandles` on `/status`.

**Estimated Effort**

S (half day).

**Recommended Solution**

- Add `SQLITE_REQUEST_TIMEOUT_MS`.
- Add `sqliteApiAvailabilityCheckPromise`.
- Add `resetLocalSqliteApiAvailabilityForTests()`.
- Use timeout signals for status/load/store requests.
- Move `totalCandles` behind `?includeCount=1`.

Pseudo-fix:

```ts
let sqliteApiAvailabilityCheckPromise: Promise<boolean> | null = null;

function createRequestTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(SQLITE_REQUEST_TIMEOUT_MS);
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    const cacheIsFresh = sqliteApiAvailable !== null && Date.now() - sqliteApiCheckedAt < AVAILABILITY_CACHE_MS;
    if (!force && cacheIsFresh) return sqliteApiAvailable ?? false;
    if (sqliteApiAvailabilityCheckPromise) return sqliteApiAvailabilityCheckPromise;
    // fetch('/api/sqlite/status', { signal: createRequestTimeoutSignal() })
}
```

**Expected Impact**

- Collapse N concurrent cold availability probes to 1.
- Bound local SQLite stalls to a known timeout, e.g. 8s.
- Avoid full-table count work on every status probe.

**Priority Score**

10/10.

### 2. Add Per-Spec Test Runner Timeouts And Streaming Progress

**Problem**

`scripts/run-tests.ts` captures output and runs specs in a bounded pool, but a hung child process can hang the full suite indefinitely. It also prints compact results only after the full pool completes, which hides progress during a stall.

**Why This Is High ROI**

The runner is already centralized. One change improves every test run and CI invocation.

**Risk Level**

Low. This changes runner failure handling, not app behavior. Timeout defaults can be conservative.

**Estimated Effort**

S (half day).

**Recommended Solution**

- Add `--timeoutMs=<n>` and env fallback, defaulting to a conservative value.
- Kill timed-out child processes and mark the spec as `FAIL`.
- Print each result as it completes while preserving the existing summary JSON.

Pseudo-fix:

```ts
const timeoutId = setTimeout(() => {
    stderr += `\n[runner-error]\nTimed out after ${timeoutMs}ms.\n`;
    child.kill();
}, timeoutMs);
child.on("close", () => clearTimeout(timeoutId));
```

**Expected Impact**

- CI/dev hangs fail in minutes instead of waiting indefinitely.
- Faster diagnosis because the last completed spec is visible.

**Priority Score**

9/10.

### 3. Stop Tracking Local Wrangler D1 State

**Problem**

The repo tracks a local Miniflare D1 SQLite file under `.wrangler/state/v3/d1/...sqlite`. That is runtime state, not source. Worker migrations and config are already represented under `workers/` and `wrangler.toml`.

This matters because local D1 state can contain subscriptions, signals, or test data and can create noisy or sensitive diffs.

**Why This Is High ROI**

The fix is tiny and prevents repeated future mistakes.

**Risk Level**

Low. Keep source files and migrations; remove only local runtime state from version control.

**Estimated Effort**

XS (<1 hour).

**Recommended Solution**

- Add `.wrangler/` to `.gitignore`.
- Run `git rm --cached` for the tracked `.wrangler/state/...sqlite` file.
- Verify `git ls-files .wrangler` is empty.

**Expected Impact**

- Prevent accidental commits of local Worker/D1 state.
- Reduce security and reproducibility risk.

**Priority Score**

9/10.

### 4. Clean Up Defeated Dynamic Imports And Eager Scanner Import

**Problem**

`npm run build` reports modules that are dynamically imported but also statically imported, so Rollup cannot move them to separate chunks. Some warnings are unavoidable core-module tradeoffs, but at least two are quick wins:

- `index.ts` dynamically imports `state` and `debug-logger` for debug globals even though startup already statically imports them.
- `lib/app-bootstrap.ts` statically imports `scannerPanel` only for a keyboard shortcut and custom event handler.

The main JS chunk is currently about 1067.6 KB minified.

**Why This Is High ROI**

Small import-boundary cleanup makes build warnings more meaningful and can trim startup code.

**Risk Level**

Low to Medium. Debug global changes are low risk. Scanner lazy import needs shortcut smoke coverage.

**Estimated Effort**

S (half day).

**Recommended Solution**

- Replace debug-global dynamic imports for already-static modules with direct imports or a small debug exposure helper.
- Change scanner shortcut handlers to `void import("./scanner").then(...)` at use time.
- Re-run `npm run build` and compare warnings/chunk size.

**Expected Impact**

- Fewer Rollup warnings.
- Expected main chunk reduction is modest, likely 10-30 KB from scanner path cleanup, but the bigger win is cleaner build signal.

**Priority Score**

8/10.

### 5. Evict DataCache Metadata With Candle Entries

**Problem**

`lib/data/data-cache.ts` evicts/removes candle entries but does not remove matching `syncAtByKey` timestamps. `DataFetcher` uses `syncAtByKey` to decide whether cache persistence recently synced. A reused key can inherit stale sync metadata after invalidation or LRU eviction.

**Why This Is High ROI**

The cache object owns both maps, so the correct fix is small and localized.

**Risk Level**

Low. Stale metadata surviving eviction is more surprising than removing it.

**Estimated Effort**

XS (<1 hour).

**Recommended Solution**

- Add a private `removeEntry(key)` helper in `DataCache`.
- Use it from LRU eviction, `delete`, and `invalidate`.
- Add tests for sync timestamp cleanup.

Pseudo-fix:

```ts
private removeEntry(key: string): boolean {
    this.cacheSyncAtByKey.delete(key);
    return this.lruCache.delete(key);
}
```

**Expected Impact**

- Prevent stale persistence-throttle decisions.
- Remove a small memory leak in long symbol-scan sessions.

**Priority Score**

8/10.

### 6. Add Incremental Typechecking For Tests

**Problem**

Normal `tsconfig.json` typechecking includes app/script/worker source but not `tests/**/*.ts`. Runtime tests pass, but direct strict compilation of tests surfaces many existing type drifts: raw number `Time` values, stale settings fields, outdated test object shapes, and stale test shims under `tests/lib`.

**Why This Is High ROI**

Tests are the safety net for this repo's contract-heavy architecture. Making new tests type-correct prevents test fixtures from hiding real interface drift.

**Risk Level**

Medium if attempted all at once; Low if incremental.

**Estimated Effort**

M (1-2 days) for a useful first subset.

**Recommended Solution**

- Create typed fixture builders instead of broad casts.
- Start with a narrow `typecheck:tests` subset.
- Expand by feature as touched.
- Keep legacy-payload tests explicit with `unknown as` where they intentionally violate current types.

**Expected Impact**

- Catch interface drift before runtime.
- Reduce refactor cost in backtest/settings/time contracts.

**Priority Score**

7/10.

### 7. Harden Simple Browser Storage Helpers

**Problem**

`lib/alert-storage.ts`, `lib/live-positions-storage.ts`, and `lib/handlers/settings-ux-handlers.ts` call `localStorage` directly. `lib/persisted-json.ts` handles unavailable storage for versioned JSON blobs, but simple string/boolean keys still throw if storage is blocked or unavailable.

**Why This Is High ROI**

Very small change, better startup resilience, and aligns with existing persistence standards.

**Risk Level**

Low. Keep existing key names and values.

**Estimated Effort**

XS (<1 hour).

**Recommended Solution**

- Add tiny safe get/set helpers or local try/catch wrappers.
- Keep `alert_worker_url`, `livePositionsCollapsed`, `livePositionsEnabled`, and `playground_settings_preset` shapes unchanged.
- Add tests with throwing `localStorage`.

**Expected Impact**

- Alerts, Live Positions, and Settings UX degrade to defaults instead of crashing under storage restrictions.

**Priority Score**

7/10.

### 8. Gate Strategy Registry Console Noise

**Problem**

`strategyRegistry.ts` logs registration, unregister, clear, HMR, save, and restore events directly to `console`. That can be noisy in production-like builds and is inconsistent with the existing `debugLogger` event stream.

**Why This Is High ROI**

Small observability cleanup that makes real console warnings easier to spot.

**Risk Level**

Low.

**Estimated Effort**

XS (<1 hour).

**Recommended Solution**

- Gate routine logs with `import.meta.env.DEV`.
- Keep actual error logs or route them to `debugLogger.error`.
- Preserve HMR logs in dev.

**Expected Impact**

- Cleaner console output without losing dev diagnostics.

**Priority Score**

6/10.

## Rollback Strategy

- Each phase is independently revertible.
- Prefer one PR/commit per phase.
- For SQLite timeout/coalescing, rollback is limited to `lib/local-sqlite-api.ts` plus status endpoint changes.
- For `.wrangler` cleanup, rollback is `git add` of the local state file, though that is not recommended.
- For test runner changes, keep old CLI behavior as defaults where possible.
- For scanner lazy import changes, revert `lib/app-bootstrap.ts` only if shortcut smoke fails.

## Edge Cases And Failure Handling

- SQLite status count removal must not silently break external diagnostics; keep `?includeCount=1`.
- Timeout errors should be distinguishable from normal unavailable SQLite fallback.
- Test runner timeout must include child stdout/stderr tail in the failure log.
- Browser storage wrappers must preserve existing raw key/value formats.
- `.wrangler/` ignore must not ignore `wrangler.toml` or `workers/wrangler.example.toml`.
