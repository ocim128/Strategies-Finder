# High-ROI Engineering Improvements Plan

## Goal

Create an implementation-ready plan for the low-risk, high-ROI engineering improvements identified in the repository audit. This document began as planning-only; implementation status is tracked below after approval.

## Implementation Status

- Implemented phases: stale data-load guard, Execution Lab config hermeticity, Vite filesystem hardening, provider/proxy timeouts, staged test type coverage, listener fault isolation, chart-vendor chunking, and local catalog caching.
- `tsconfig.tests.json` uses staged coverage. A full `tests/**/*.spec.ts` typecheck currently exposes broad pre-existing fixture/type debt, mostly `Time` branding, stale settings fixtures, and mirrored `tests/lib/*` import paths.
- Build measurement after chart-vendor chunking: main chunk reduced from the baseline `984.06 kB` to about `812 kB`; `vendor-charts` is about `174.92 kB`.

## Assumptions and Unknowns

- The candidate implementation set is the audit shortlist:
  - stale async market-data load guard
  - Execution Lab live executor test/config hermeticity
  - narrower Vite dev-server filesystem access
  - provider/proxy fetch timeout parity
  - broader test type coverage
  - state/debug listener fault isolation
  - Vite chunking and local catalog cache improvements
- Existing dirty files are unrelated unless later proven otherwise:
  - `.gitignore`
  - `scripts/polymarket-sync-outcomes.ts`
  - `tests/polymarket-sync-outcomes-cli.spec.ts`
- Current compact test baseline is not fully green. The observed failures are in Execution Lab live executor specs and appear environment-coupled.
- Local `.env` may affect Execution Lab behavior. Do not print secrets or expand private key handling while debugging.
- No new database, service, deployment target, or API surface is assumed. Existing architecture is Vite/browser code plus local Vite middleware, optional local SQLite data, optional Rust acceleration, and optional Cloudflare Worker alert code.

## Current Repo Facts

- App entrypoint is thin: `index.ts` delegates startup to `lib/app-bootstrap.ts`.
- Shared mutable app state lives in `lib/state.ts`; writes should route through `lib/state-actions.ts` where possible.
- Market data loading flows through `lib/data-manager.ts`, `lib/data/data-fetcher.ts`, `lib/candle-cache.ts`, provider modules under `lib/dataProviders/*`, and local middleware in `vite.config.ts` / `lib/local-sqlite-vite-plugin.ts`.
- UI and feature contracts are id-driven through `html-partials/*` and feature-local `*-dom.ts` modules.
- Execution Lab live-trade browser code sends non-secret order intent to a local executor through `lib/execution-lab/live-executor-adapter.ts` and Vite middleware.
- Tests are launched by `scripts/run-tests.ts`. `npm run test` recursively discovers `tests/**/*.spec.ts`, while `tsconfig.tests.json` currently covers a much smaller explicit list.
- Build is Vite-based; the main production JavaScript chunk is currently large enough to trigger Vite chunk-size warnings.

## Non-Goals

- No strategy semantics changes.
- No UI redesign.
- No Rust rewrite or Worker behavior expansion.
- No localStorage schema migration unless a selected implementation phase directly requires it.
- No new data store, queue, microservice, or deployment pipeline.
- No broad formatting, lint churn, or unrelated dead-code cleanup.

## System Architecture

The plan preserves the current architecture:

- Browser app bootstrapped by Vite.
- Runtime state in shared TypeScript modules.
- Local market-data and execution endpoints provided by Vite middleware during development/local operation.
- Optional worker-side alert evaluation remains separate from browser UI behavior.
- Optional Rust acceleration remains behind existing fallback paths.

The improvements are local hardening and maintainability changes inside existing seams.

## Module Boundaries

| Improvement | Primary modules | Boundary to preserve |
| --- | --- | --- |
| Data load race guard | `lib/data-manager.ts`, `lib/handlers/state-subscriptions.ts`, `lib/state-actions.ts` | DataManager owns async loading; state actions own state mutation and cache writes. |
| Execution Lab hermetic config | `lib/execution-lab/live-executor-adapter.ts`, execution-lab tests | Browser payloads remain non-secret; local executor config remains server/local only. |
| Vite filesystem hardening | `vite.config.ts` | Dev middleware should serve only required project and dependency paths. |
| Fetch timeout parity | `lib/dataProviders/*`, `vite.config.ts`, shared fetch helper if added | Provider modules own provider-specific errors; shared helper only handles timeout/signal composition. |
| Test type coverage | `tsconfig.tests.json`, `package.json`, `scripts/run-tests.ts` | Runtime test discovery behavior should not be changed unless explicitly needed. |
| Listener fault isolation | `lib/state.ts`, `lib/debug-logger.ts` | Existing subscription APIs remain stable. |
| Chunking/catalog cache | `vite.config.ts`, local dataset catalog code | Build output and local catalog behavior should remain semantically equivalent. |

## Data Flow

- Market data:
  1. UI or subscription code requests a symbol/interval change.
  2. `DataManager.setSymbol(...)` updates context and calls `loadData(...)`.
  3. `DataFetcher` obtains data from provider/local sources.
  4. `commitOhlcvData(...)` writes state and cache using the current app context.
  5. Chart/render paths react to state updates.

  Risk point: an older async request can finish after a newer request and commit data into the newer context.

- Execution Lab live executor:
  1. Browser sends non-secret live-trade intent to local middleware.
  2. Adapter resolves executor configuration from overrides and environment.
  3. Adapter spawns local executor and maps result into app-facing status.

  Risk point: environment-derived cwd/args can leak into tests or override scenarios.

- Provider/proxy fetch:
  1. Browser provider modules call remote exchange endpoints directly or through Vite middleware.
  2. Vite middleware proxies selected requests and maps failures into JSON errors.

  Risk point: inconsistent timeout behavior can leave requests hanging longer than expected.

- Local asset catalog:
  1. Browser requests local Indonesian-stock catalog metadata.
  2. Vite middleware scans the local CSV directory and returns symbols.

  Risk point: repeated full-directory scans add unnecessary local latency and IO.

## API and Contracts

- No public endpoint or persisted settings contract should change.
- `DataManager.loadData(...)` should remain callable by existing consumers, but only the latest active load may commit app state.
- Stale or aborted loads should not surface as user-visible errors unless the active load fails.
- Execution Lab config precedence must be explicit and covered by tests.
- Vite `server.fs.allow` changes must still support local app development and parent `node_modules` resolution.
- Fetch timeout errors should preserve existing provider fallback behavior where fallback already exists.
- New package scripts, if added, must be additive.

## State Management

- Do not add a new global state system.
- Data load generation or abort state should be private to `DataManager`.
- State subscribers should keep the existing subscription API.
- Listener error isolation should prevent one subscriber from blocking others, while still surfacing failures through concise logging.

## Infrastructure and Deployment

- Relevant infrastructure is local Vite config and local middleware only.
- Validate with `npm run build`; no production deployment pipeline exists in this repository.
- Do not assume Cloudflare Worker deployment changes unless Worker code is directly edited.

## Security Considerations

- Narrowing `server.fs.allow` reduces accidental local file exposure in the Vite dev server.
- Execution Lab work must not log, serialize, or send wallet secrets to the browser.
- Do not inspect or print `.env` contents during implementation.
- Timeout helper code must not include request payloads in thrown/logged errors.

## Performance Considerations

- Data load race guarding prevents wasted stale commits and reduces chart/cache churn during rapid symbol/interval changes.
- Provider timeouts reduce hung request cost and improve fallback latency.
- Manual chunking should improve browser cache reuse and reduce main chunk parse pressure.
- Local catalog caching avoids repeated directory scans over hundreds of CSV files.
- Test type coverage increases defect detection without slowing normal compact test execution if implemented as a separate script.

## Observability and Failure Handling

- Fire-and-forget async reloads should attach `.catch(...)` and route active-load failures through existing user-facing paths.
- Listener failures should be logged without recursively depending on the same failing listener mechanism.
- Timeout, abort, and stale-load paths must be distinguishable in tests.
- Existing compact test logging under `artifacts/test-logs/latest` remains the source for full test output.

## Rollback Strategy

- Implement phases independently so each can be reverted as a small patch.
- Prefer additive tests before behavior changes where practical.
- If a phase exposes broad pre-existing failures, stop that phase after documenting the baseline and keep unrelated phases unblocked.
- Avoid combining security/config changes with data-flow changes in one commit.

## Phase 0: Baseline and Scope Confirmation

### Objective

Confirm the implementation scope and establish a current validation baseline before touching production code.

### Scope

- Planning and verification only.
- No behavior changes.

### Technical Tasks

- Re-check `git status --short` and preserve unrelated dirty files.
- Record current results for:
  - `npm run typecheck`
  - `npm run typecheck:tests`
  - `npm run test -- --json`
  - `npm run build`
- Re-run focused Execution Lab specs if the full compact suite still fails.
- Confirm which phases are approved for implementation.

### Dependencies

- Existing npm scripts.
- Current local environment and `.env` state.

### Risks/Blockers

- Pre-existing failing tests can obscure regressions.
- Environment-coupled Execution Lab failures may require config isolation before reliable full-suite validation.

### Deliverables

- Baseline command summary.
- Approved implementation phase list.
- Any pre-existing failures clearly classified.

### Validation/Testing Criteria

- Baseline commands are run or explicitly marked skipped with reason.
- Failures are tied to specific specs and not silently treated as new regressions.

### Exit Criteria

- Approved phase list is known.
- Baseline status is documented.
- No unrelated dirty files are modified.

## Phase 1: Guard Stale Market-Data Loads

### Objective

Ensure only the latest active market-data request can commit app state or cache data.

### Scope

- `lib/data-manager.ts`
- `lib/handlers/state-subscriptions.ts`
- Focused tests for data-load ordering or stale commit prevention.

### Technical Tasks

- Add a private load generation token and, where supported, an `AbortController` in `DataManager`.
- Increment the generation on symbol/interval-changing loads.
- Pass the active abort signal to data fetch paths that already accept signals.
- Before calling `commitOhlcvData(...)`, verify the generation still matches the active request.
- Treat stale/aborted requests as non-errors for UI status.
- Add `.catch(...)` handling to fire-and-forget subscription-triggered loads.
- Add a test using deferred fetch responses to prove an older request cannot overwrite a newer request.

### Dependencies

- Existing `DataFetcher` signal support.
- `commitOhlcvData(...)` current-context behavior in `lib/state-actions.ts`.
- Existing test runner support for isolated TypeScript specs.

### Risks/Blockers

- Some callers may rely on `loadData(...)` resolving data even after context changed.
- Aborting shared provider requests could interact with existing request de-duplication if present.
- Test setup may require lightweight stubs rather than full app bootstrap.

### Deliverables

- DataManager stale-load guard.
- Fire-and-forget error handling.
- Focused regression test.

### Validation/Testing Criteria

- `npm run typecheck`
- Focused new/updated data-manager spec.
- `npm run test -- data-manager` if the runner filter matches the new spec name.

### Exit Criteria

- Rapid consecutive loads commit only the newest data.
- Aborted stale loads do not produce unhandled promise rejections.
- Existing load success and active-load failure behavior remains unchanged.

## Phase 2: Make Execution Lab Config and Tests Hermetic

### Objective

Make live executor config resolution deterministic when tests or callers pass explicit overrides.

### Scope

- `lib/execution-lab/live-executor-adapter.ts`
- `tests/execution-lab-live-executor-adapter.spec.ts`
- `tests/execution-lab-live-quote.spec.ts`
- Docs only if config precedence behavior changes.

### Technical Tasks

- Add or clarify precedence rules for executor path, cwd, args, and timeout:
  - explicit override wins
  - environment fills only missing runtime config
  - tests can isolate from environment-derived cwd/args
- Add a focused test proving env cwd/args cannot poison an explicit test executor override.
- Avoid printing or inspecting secret environment values.
- Re-run the previously failing Execution Lab specs.

### Dependencies

- Existing local executor adapter contract.
- Existing live-trade docs if config semantics are documented there.

### Risks/Blockers

- Real local executor users may rely on environment cwd while overriding only the executor path.
- Changing config precedence without documenting it can create operational confusion.

### Deliverables

- Deterministic config resolution.
- Hermetic Execution Lab tests.
- Documentation update if precedence changes are user-visible.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- execution-lab-live-executor-adapter`
- `npm run test -- execution-lab-live-quote`
- Full `npm run test -- --json` when practical.

### Exit Criteria

- Execution Lab live executor specs pass independent of local executor `.env` cwd/args.
- No browser payload includes secrets.

## Phase 3: Harden Vite Dev-Server Filesystem Access

### Objective

Reduce local file exposure risk from overly broad Vite filesystem allowlisting.

### Scope

- `vite.config.ts`

### Technical Tasks

- Replace broad `server.fs.allow: ['../../..']` with explicit resolved paths required by this app.
- Include the app root and any proven dependency/workspace path needed for the parent `node_modules` layout.
- Keep local middleware endpoints unchanged.
- Smoke-check dev-server path assumptions if a local dev server is started.

### Dependencies

- Current repo location under the larger `lightweight-charts` workspace.
- Parent `node_modules` dependency resolution.

### Risks/Blockers

- Too narrow an allowlist can break Vite dev serving of parent workspace dependencies.
- Local CSV/dataset paths outside the app root may require explicit inclusion.

### Deliverables

- Narrower `server.fs.allow` configuration.
- Short note in final implementation summary describing allowed paths.

### Validation/Testing Criteria

- `npm run build`
- `npm run typecheck`
- Optional local dev smoke if a dev server is needed for verification.

### Exit Criteria

- Vite build still passes.
- Dev server no longer allowlists the broad grandparent directory unless a specific proven dependency requires it.

## Phase 4: Add Provider and Proxy Timeout Parity

### Objective

Bound remote data-provider waits consistently across direct provider fetches and Vite proxy middleware.

### Scope

- `lib/dataProviders/binance.ts`
- `lib/dataProviders/bybit.ts`
- Shared provider fetch helper if warranted.
- Relevant proxy handlers in `vite.config.ts`.

### Technical Tasks

- Add a small shared helper for timeout signal composition if the same pattern appears in multiple provider modules.
- Preserve caller-provided abort behavior.
- Apply reasonable per-request defaults to direct Binance fetches and Bybit/TradFi proxy calls.
- Keep existing Polymarket proxy timeout behavior intact or route it through the shared helper if that reduces duplication safely.
- Add tests for timeout helper behavior if helper logic is non-trivial.

### Dependencies

- Browser and Node `AbortController` support in the project runtime.
- Existing provider fallback/error mapping.

### Risks/Blockers

- A timeout that is too short can increase false provider failures during large historical loads.
- Different providers may need different timeout values.
- Node/browser abort errors can have different names.

### Deliverables

- Consistent timeout handling for selected provider/proxy paths.
- Tests or focused verification proving abort and timeout paths remain distinct.

### Validation/Testing Criteria

- `npm run typecheck`
- Focused provider/helper tests if added.
- `npm run test -- data` or the closest matching provider spec filter.

### Exit Criteria

- Direct and proxied provider requests have bounded wait behavior.
- Existing caller aborts still cancel promptly.
- Existing provider fallback semantics are preserved.

## Phase 5: Broaden Test Type Coverage

### Objective

Make TypeScript test checking cover the same test surface that `npm run test` discovers.

### Scope

- `tsconfig.tests.json`
- `package.json` scripts if an additive verification command is useful.
- Test type fixes only if surfaced by the broadened config.

### Technical Tasks

- Change test typecheck includes from a small explicit spec list to `tests/**/*.spec.ts`, or document and implement a staged include if the full set exposes too much pre-existing debt.
- Add an additive `verify` script only if it matches existing package-script style.
- Run the broadened test typecheck.
- Fix narrow test typing issues only when they are clearly mechanical and low risk.

### Dependencies

- Existing test runner and TypeScript config.
- DOM and Node type declarations already available to tests.

### Risks/Blockers

- Broad typecheck may reveal many pre-existing test type errors.
- Some specs may depend on globals that are valid at runtime but not represented in the current TS config.

### Deliverables

- Broader test typecheck config or staged coverage with explicit rationale.
- Optional additive verification script.
- Mechanical test type fixes if necessary.

### Validation/Testing Criteria

- `npm run typecheck:tests`
- `npm run test -- --json` if test code changed.

### Exit Criteria

- Test typecheck coverage materially matches test discovery, or remaining exclusions are explicitly justified.
- No product behavior changes are introduced by test typing work.

## Phase 6: Isolate State and Debug Listener Failures

### Objective

Prevent one throwing subscriber from blocking other state or debug listeners.

### Scope

- `lib/state.ts`
- `lib/debug-logger.ts`
- Focused listener behavior tests.

### Technical Tasks

- Wrap listener calls in isolated `try/catch` blocks.
- Log failures concisely without depending on the same failing listener chain.
- Preserve unsubscribe behavior and listener ordering for non-throwing listeners.
- Add tests proving later listeners still run after an earlier listener throws.

### Dependencies

- Existing subscription APIs.
- Existing debug logging conventions.

### Risks/Blockers

- Swallowing errors can hide programmer mistakes if logging is too quiet.
- Using debug logging inside debug listener error handling can recurse.

### Deliverables

- Fault-isolated listener dispatch.
- Focused tests for state and debug logger subscriptions.

### Validation/Testing Criteria

- `npm run typecheck`
- Focused listener tests.
- `npm run test -- state` or closest matching filter.

### Exit Criteria

- Throwing listeners are reported and do not block later listeners.
- Non-throwing listener behavior remains unchanged.

## Phase 7: Improve Build Chunking and Local Catalog IO

### Objective

Reduce main bundle pressure and repeated local filesystem scans without changing app behavior.

### Scope

- `vite.config.ts`
- Local Indonesian-stock catalog middleware or helper code.
- No strategy-loading redesign unless bundle measurements show it is the next clear bottleneck.

### Technical Tasks

- Add a conservative `manualChunks` split for stable large vendor code such as `lightweight-charts`.
- Re-run `npm run build` and compare chunk sizes.
- Add module-level catalog caching for local CSV metadata, with a simple invalidation approach:
  - process-lifetime cache, or
  - short TTL, or
  - mtime-based invalidation if already cheap enough.
- Preserve behavior when the local catalog directory is missing.
- Defer strategy catalog splitting unless the vendor split does not materially reduce the main chunk.

### Dependencies

- Current Vite build output.
- Local CSV directory layout under `price-data/indonesian-stock`.

### Risks/Blockers

- Chunking can improve cacheability while not reducing total downloaded bytes on first load.
- Catalog cache can become stale after adding/removing CSVs until invalidated.
- File watching for invalidation may add unnecessary complexity.

### Deliverables

- Manual chunk config for stable vendor code.
- Local catalog cache with clear invalidation tradeoff.
- Before/after build size summary.

### Validation/Testing Criteria

- `npm run build`
- `npm run typecheck`
- Manual or scripted request to local catalog endpoint if feasible.

### Exit Criteria

- Main chunk size is reduced or the no-op result is documented.
- Repeated catalog requests avoid repeated full scans under normal local usage.
- Missing-directory behavior remains graceful.

## Phase 8: Documentation and Final Verification

### Objective

Capture behavior changes and finish with a clean, reproducible validation report.

### Scope

- Relevant docs only:
  - `README.md` if repo-level commands or architecture notes change.
  - `docs/live-trade-plan.md` or `docs/polymarket.md` only if Execution Lab behavior documented there changes.
  - This plan may be updated with final phase status if useful.

### Technical Tasks

- Update docs only for real behavior or command changes.
- Run final validation set based on touched modules:
  - `npm run typecheck`
  - `npm run typecheck:tests`
  - focused specs for touched areas
  - `npm run build` for Vite config/chunking phases
  - full `npm run test -- --json` when practical
- Summarize residual failures separately from changes made.

### Dependencies

- Results from all implemented phases.
- Existing documentation locations.

### Risks/Blockers

- Full compact test suite may retain unrelated baseline failures.
- Documentation can drift if behavior changes after the docs are updated.

### Deliverables

- Updated docs where required.
- Final validation report.
- Residual risk list.

### Validation/Testing Criteria

- Markdown paths referenced in docs exist unless intentionally placeholders.
- Final command results are recorded accurately.

### Exit Criteria

- Implemented phases have passing focused validation.
- Any remaining failures are identified as baseline or explicitly unresolved.
- Final summary lists changed files, validation, and follow-up priorities.
