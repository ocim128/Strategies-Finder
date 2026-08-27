# Complexity audit: Finder, Batch, IBKR, and Crypto

Date: 2026-08-27  
Worktree: `Strategies-Finder-complexity-audit`  
Base: `5752bb07ea55b058f446e014e2f4d8356668251d`

## Executive conclusion

The largest maintainability problem is not the shared data layer. It is product-surface accumulation:

1. Batch contains a second research product, `TOP_MEAN`, beside normal Batch and `OPEN_SCORE USD`.
2. Finder contains four scopes, three search modes, browser and server execution, two server recovery paths, and several specialized Asset Opportunity paths in one manager.
3. IBKR and Crypto implement the same browser/server sync lifecycle twice, with provider-specific behavior mixed into each copy.

The highest-return change is deletion, in this order:

- remove `TOP_MEAN` from the main product unless active usage proves it is required;
- remove Asset Opportunity batch/OOS if it is not a regularly used workflow;
- remove Genetic Search if usage telemetry does not justify its unique optimizer;
- remove the dead synthetic-pair parser copy from `finder-manager.ts` immediately.

Do not delete the server hardening, bounded caches, scalar wire contracts, run ownership, artifact retention/cleanup, or synthetic-pair seed-interval logic. Those lines are complexity with a clear reliability or correctness payoff.

The estimates below use approximately 50,611 production lines in the focused surface:

| Area | Approx. LOC |
|---|---:|
| `lib/finder/**` | 23,497 |
| `lib/finder-manager.ts` | 4,321 |
| `lib/batch-backtest/**` | 17,747 |
| `lib/ibkr-data/**` | 3,623 |
| `lib/crypto-data/**` | 1,423 |
| **Focused total** | **50,611** |

Percentages in findings are against that total unless explicitly labelled as a subsystem percentage. Estimates exclude tests and documentation unless stated. They are intentionally ranges because several features share files.

## Scope and method

I created a detached temporary worktree before analysis. The original worktree was clean and was not modified. I read the repository map, startup/lazy-loading path, relevant HTML partials, production modules, targeted tests, and research documentation. I used line counts, import/call-site searches, route searches, and focused test execution.

This is an architecture and maintenance audit, not a product-usage study. “Delete” recommendations for user-facing research features are therefore conditional on confirming usage with telemetry, saved-workflow review, or a short user check. “Dead” means no in-repository production consumer was found.

## Findings

### F1 — `TOP_MEAN` is a second research product embedded in Batch

**Severity:** High  
**Engineering cost:** Medium/High — 3–6 engineer-days to remove UI, routes, state, persistence, worker entrypoints, and tests cleanly.  
**Maintenance cost:** Very high.  
**User impact:** High for the small group using the S&P 500 coordinator; none for normal Batch, balanced pair generation, or `OPEN_SCORE USD`.  
**Expected code reduction:** Approximately 4,900–5,600 production LOC, or 10–11% of the focused surface; approximately 25–30% of the Batch subsystem.  
**Confidence:** 0.99 that the code is expensive; 0.65 that current user value is below its cost.

**Current implementation**

`BatchBacktestService` owns normal Batch state and also a separate TOP_MEAN lifecycle: active-run persistence, reattach, diagnostics, live rendering, stop handling, result persistence, and exports (`lib/batch-backtest/batch-backtest-service.ts:98-314`, `:2264-3300`). The server adds four TOP_MEAN routes through `sp500-top-mean-vite-routes.ts`. The coordinator itself spans 11 files and approximately 4,323 lines, including a worker pool, archive log, artifact store, current snapshot, coordinator engine, performance formatter, and request limits. The Batch partial exposes another large control surface (`html-partials/tab-batch-backtest.html:122-189`).

This is not merely a formatter or an alternate Batch preset. It has its own coordinator phases, persistence, streaming protocol, workers, artifacts, replay, archive, and diagnostic UI. The shared owner-lock adapter exists specifically to keep the two products from colliding (`lib/batch-backtest/batch-backtest-vite-plugin.ts:1993-2008`).

**Why it is more complex than necessary**

The normal Batch path already evaluates submitted pairs. `OPEN_SCORE USD` already provides the retained-artifact analysis surface. The repository’s own research notes say that TOP_MEAN asset pruning was abandoned and that the historical selector arms are retained as diagnostics (`docs/mine-timing-validation-findings.md`, `docs/pairlist-selection-research.md`). A dedicated coordinator therefore maintains a large execution product around a research result that has not demonstrated adoption.

**Simplest alternative**

Delete TOP_MEAN from the main UI, its four server routes, coordinator workers/artifact/archive modules, and service state. Preserve normal Batch, balanced pair generation, and the general `OPEN_SCORE USD` replay. If the research output is still needed, keep a small offline script or a fixture-driven test—not a resident Vite product with its own lifecycle.

This should be the first large deletion, but only after checking recent usage. Do not replace it with another generic coordinator framework; that would preserve the cost under a different name.

### F2 — `FinderManager` is a god object because low-value scopes were kept beside core Finder

**Severity:** High  
**Engineering cost:** High if only split; Medium if a scope is deleted first.  
**Maintenance cost:** Very high.  
**User impact:** Depends on the removed scope. Current-chart and Symbol Universe are core; Asset Opportunity batch and Strategy Quality are niche.  
**Expected code reduction:** Deleting one specialized scope: approximately 2,000–4,000 production LOC, 4–8% of the focused surface. Merely splitting the manager: 0–3% LOC reduction and little product value.  
**Confidence:** 0.98 for the coupling diagnosis; 0.55–0.75 for the deletion target without usage data.

**Current implementation**

`lib/finder-manager.ts` is approximately 4,321 lines. It owns current-chart execution, Symbol Universe server submission and reattach, Asset Opportunity single and batch execution, Strategy Quality, parameter-space setup, strategy selection, advanced sorting, OOS validation, persistence, DOM binding, result rendering, and cache invalidation. The dispatch at `:1995-1999` selects among Universe, Asset Opportunity batch, Asset Opportunity, and the default path. The major server/browser methods are spread across `:2237-3300`.

The HTML simultaneously exposes four scopes plus Grid, Random, and Genetic modes, OOS controls, data slicing, multiple sorting systems, Polymarket scoring, risk controls, and trade filtering (`html-partials/tab-finder.html:1-250`).

**Why it is more complex than necessary**

The manager is acting as UI controller, workflow router, persistence owner, server client, recovery state machine, and research feature host. Every new state or DOM contract must be understood against all scopes. Splitting this object before deleting unused product surface would create more modules without reducing behavior or decisions.

**Simplest alternative**

Delete the least-used scope first—most likely Asset Opportunity batch—then remove its state and contracts from the manager. Only after deletion should the remaining code be separated by scope if the file is still difficult to navigate. Keep shared parameter normalization and result contracts as small leaf modules. Avoid introducing a generic Finder “application framework.”

### F3 — Asset Opportunity batch/OOS is specialized machinery with a poor complexity-to-value ratio

**Severity:** Medium/High  
**Engineering cost:** Medium/High — 4–8 engineer-days, mostly because the feature is interleaved with Finder server job handling.  
**Maintenance cost:** Very high while retained.  
**User impact:** High only for users running multi-asset holdout sweeps; low for ordinary Finder and Symbol Universe workflows.  
**Expected code reduction:** Approximately 1,800–3,000 production LOC, or 4–6% of the focused surface.  
**Confidence:** 0.90 that the feature is expensive; 0.55 that its user value is below its cost.

**Current implementation**

The feature has dedicated browser orchestration in `finder-manager.ts`, server routes and job state in `lib/finder/server/finder-vite-plugin.ts`, iteration logic in `lib/finder/server/asset-opportunity-iteration.ts`, a worker pool in `finder-asset-opportunity-batch-worker-pool.ts`, server-side search code, Rust batch paths, cache-capacity policy, and specialized diagnostics. The worker-pool file alone is approximately 725 lines; the general Asset Opportunity runner is approximately 1,616 lines.

The feature also has its own data-cache capacity policy based on system memory (`lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts:93-105`) and a separate dataset-cache context (`lib/finder/server/server-finder-data-loader.ts:152-190`).

**Why it is more complex than necessary**

This is a niche batch sweep layered on top of Finder’s already complex search and OOS behavior. It needs parallel workers, per-run cache sizing, Rust dispatch variants, iteration snapshots, cancellation, server reattach, and diagnostics. The added machinery is not needed for current-chart Finder, normal Symbol Universe Finder, or a single Asset Opportunity run.

**Simplest alternative**

Remove the batch/OOS sweep and retain the single Asset Opportunity workflow. If the sweep is actively used, move it out of the interactive Finder into a separate script/CLI with one input file and one output artifact. That preserves research capability without making the browser Finder a multi-job scheduler.

Do not remove the worker pool alone. It is a consequence of the feature; removing only its abstraction would make the remaining code less maintainable.

### F4 — Finder server delivery has both live NDJSON and authoritative status recovery

**Severity:** Medium/High  
**Engineering cost:** Medium — 3–5 engineer-days.  
**Maintenance cost:** High.  
**User impact:** Users lose provisional per-candidate/per-asset rows during a run; terminal results, Stop, reload reattach, cancellation, and progress summaries remain.  
**Expected code reduction:** Approximately 450–800 production LOC, or 1–2% of the focused surface.  
**Confidence:** 0.85.

**Current implementation**

`FinderManager` has an initial reattach poll loop (`reattachToActiveServerRun`, `:2237`) and a second recovery loop after stream failure (`recoverActiveServerRun`, `:2484`). It also consumes separate NDJSON streams for Asset Opportunity, Asset Opportunity batch, and Symbol Universe (`:2700`, `:2961`, `:3234`).

The server contract already makes terminal status authoritative and running status summary-only; the server also keeps the job alive after a disconnected response. This is locked by `tests/finder-server-plugin.spec.ts`, including the “status snapshot is summary-only while running and authoritative when terminal” and disconnect tests.

**Why it is more complex than necessary**

The browser must reconcile stream events, status events, run ownership, provisional rows, terminal slices, and two independent polling state machines. The live stream improves perceived progress, but it is not required to recover a correct final result.

**Simplest alternative**

Use one status-polling client for server-owned Finder runs. The server updates a bounded summary during execution and returns the authoritative candidate/asset slice at terminal state. Keep `runId`, Stop, loopback authorization, and terminal snapshots. Remove the browser stream reconciliation and the second recovery loop. This is a clear state machine with one source of truth.

This is a simplification, not a request to remove server execution. Server ownership is justified for large universes.

### F5 — Genetic Search is a third search algorithm with substantial unique code

**Severity:** Medium  
**Engineering cost:** Medium — 2–4 engineer-days.  
**Maintenance cost:** High relative to likely usage.  
**User impact:** Power users lose population-based optimization; Grid and Random search remain.  
**Expected code reduction:** Approximately 650–900 production LOC plus tests and UI branches, or 1–2% of the focused surface.  
**Confidence:** 0.75 for the code-cost assessment; 0.55 for deletion without telemetry.

**Current implementation**

The UI exposes `Genetic Search` (`html-partials/tab-finder.html:84`). The dispatcher has a dedicated branch (`lib/finder/finder-runner.ts:116-128`). The implementation uses a separate runner (`finder-runner-genetic.ts`, approximately 151 lines) and optimizer (`genetic-optimizer.ts`, approximately 482 lines) with population generation, mutation, crossover, tournament selection, adaptive mutation, fitness scoring, and generation statistics.

**Why it is more complex than necessary**

Grid and Random already cover the core requirement: evaluate parameter sets and rank results. Genetic Search adds a different convergence model, unique progress semantics, parameter restrictions, and a separate test surface. It also has unsupported combinations, such as the explicit Exit Alpha restriction in the dispatcher.

**Simplest alternative**

Remove the mode and optimizer after checking usage. Keep parameter generation explicit and deterministic through Grid/Random. If genetic search is genuinely valuable, isolate it as an offline research command rather than making every Finder change understand it.

### F6 — IBKR and Crypto duplicate the same sync lifecycle in browser services

**Severity:** Medium  
**Engineering cost:** Medium — 2–4 engineer-days.  
**Maintenance cost:** High.  
**User impact:** None intended; provider-specific controls remain.  
**Expected code reduction:** Approximately 250–450 production LOC, or 0.5–0.9% of the focused surface.  
**Confidence:** 0.95 for duplication; 0.80 that a narrow extraction is safe.

**Current implementation**

`CryptoDataService` is approximately 295 lines and explicitly says it mirrors `IbkrDataService` (`lib/crypto-data/crypto-data-service.ts:29-32`). Both services have initialization, 2-second reattach polling, symbol parsing, request construction, busy state, streamed action execution, status rendering, copy behavior, and cache invalidation:

- Crypto: `:62`, `:152-195`, `:276`.
- IBKR: `:65`, `:168-286`, `:462`.

The invalidation body is effectively identical: clear local daily caches, invalidate DataManager series, invalidate Finder caches, clear Batch caches, and clear Rank Pairs caches.

**Why it is more complex than necessary**

Bug fixes to ownership, reattach, stream termination, and invalidation must be applied twice. The separate menu tabs also duplicate the user’s mental model (`strategy-panel-shell.html` and `strategy-panel-tab-markup.ts`).

**Simplest alternative**

First extract only the shared cache invalidation function and, if useful, a small typed “run streamed sync and reattach” helper. Keep provider-specific request parsing and controls explicit. A later product change could replace the two tabs with one Market Data tab and a provider selector, but that is a higher-risk UI change and should not be done just to make the code look symmetrical.

Do not merge the entire services into a generic provider framework. IBKR has gateway status, Resolve, Append Stale, period/source rules, and catalog behavior that Crypto does not.

### F7 — IBKR and Crypto duplicate the server-side serial sync loop

**Severity:** Medium  
**Engineering cost:** Medium — 3–5 engineer-days, including provider-specific tests.  
**Maintenance cost:** High.  
**User impact:** None intended if the provider callback remains the only variable behavior.  
**Expected code reduction:** Approximately 150–250 production LOC, or 0.3–0.5% of the focused surface.  
**Confidence:** 0.85.

**Current implementation**

`processCryptoSyncBatch` (`lib/crypto-data/crypto-data-vite-plugin.ts:613-730`) and `processSyncBatch` (`lib/ibkr-data/ibkr-data-vite-plugin.ts:2020-2190`) both implement an owner-generation lock, abort checks before and after each await, an in-progress snapshot, serial per-symbol execution, successful/failed counters, completed-target retention, NDJSON symbol events, and a terminal event. The exact per-provider fetch and normalization logic is different.

**Why it is more complex than necessary**

The same cancellation and status invariants are maintained in two long functions. A change to reattach semantics or terminal accounting can drift between providers.

**Simplest alternative**

Extract a narrow internal serial-run function whose callback receives a normalized target and returns a normalized success/failure result. Keep source-specific validation, catalog writes, warnings, and fetch functions outside it. If the callback type becomes harder to read than the duplicated loop, leave the loops explicit; a misleading generic runner is worse than 150 duplicated lines.

### F8 — CSV parsing is duplicated between provider plugins and server loaders

**Severity:** Low/Medium  
**Engineering cost:** Low/Medium — 1–2 engineer-days.  
**Maintenance cost:** Medium.  
**User impact:** None.  
**Expected code reduction:** Approximately 80–150 production LOC, or 0.2–0.3% of the focused surface.  
**Confidence:** 0.90.

**Current implementation**

The IBKR plugin defines `parseCsvCandleLines` (`lib/ibkr-data/ibkr-data-vite-plugin.ts:828`), while the server loader has a separate `parseIbkrCsvPayload`. Crypto has `parseCryptoCsvCandleLines` (`lib/crypto-data/crypto-data-vite-plugin.ts:147`) and a separate `parseCryptoCsvPayload`. The implementations all normalize, validate, sort, and deduplicate candle rows, with provider-specific formats.

**Why it is more complex than necessary**

The parser contract can drift between the write path and the server read path. A format change needs multiple edits and tests.

**Simplest alternative**

Move each provider’s parser into a small leaf module and import it from both the plugin and server loader. Keep two parsers—IBKR and Crypto—rather than inventing a generic CSV adapter. The goal is one implementation per format, not an abstraction hierarchy.

### F9 — Finder and Batch server loaders duplicate setup and have an avoidable dependency direction

**Severity:** Medium  
**Engineering cost:** Medium — 2–3 engineer-days.  
**Maintenance cost:** Medium/High.  
**User impact:** None if cache lifetime remains per job/run.  
**Expected code reduction:** Approximately 80–150 production LOC, or 0.2–0.3% of the focused surface.  
**Confidence:** 0.90.

**Current implementation**

Both `server-batch-data-loader.ts` and `server-finder-data-loader.ts` construct `createBatchDatasetLoaderCore` with similar Node fetch, offline-data, fingerprint, and disk-cache hooks. The Finder loader explicitly documents that the two in-memory cores are separate and only disk cache is shared (`lib/finder/server/server-finder-data-loader.ts:113-133`). The Finder loader also imports `resolveAssetOpportunityDatasetCacheCapacity` from the 725-line worker-pool module (`:42`, `:71`, `:181`).

**Why it is more complex than necessary**

The duplicate setup increases parity risk. The loader depending on a worker-pool module for a pure capacity calculation couples data loading to a specialized execution feature.

**Simplest alternative**

Extract only the shared Node fetch/disk-cache wiring and move capacity math to a tiny leaf module. Do not create a process-global loader cache: separate per-job caches are intentional for memory lifetime and isolation. Keep `createBatchDatasetLoaderCore` as the shared behavior seam.

### F10 — Heap guard logic is copied between Finder and Batch

**Severity:** Low  
**Engineering cost:** Low — less than 1 engineer-day.  
**Maintenance cost:** Medium.  
**User impact:** None.  
**Expected code reduction:** Approximately 30–50 production LOC, less than 0.1% of the focused surface.  
**Confidence:** 0.98.

**Current implementation**

`finder-server-heap-guard.ts` says it mirrors `resolveServerBatchHeapWarning`. Both contain the same thresholds: 400/800 symbols and 8,192/12,288 MB heap floors. The only meaningful variation is the scope label in the message.

**Why it is more complex than necessary**

Threshold changes can produce inconsistent admission behavior. The duplicated implementation is small but has no independent value.

**Simplest alternative**

Move the pure threshold calculation and message builder to one leaf with a caller-provided label. Keep the Finder and Batch route-specific checks where they are.

### F11 — `finder-manager.ts` contains a dead synthetic-pair parser copy

**Severity:** Low  
**Engineering cost:** Low — less than 1 engineer-day.  
**Maintenance cost:** Medium today; high risk of future drift.  
**User impact:** None found in this repository.  
**Expected code reduction:** Approximately 20–30 production LOC, less than 0.1% of the focused surface.  
**Confidence:** 0.95.

**Current implementation**

`lib/synthetic-pair-token.ts:48-57` is the leaf parser. `lib/finder-manager.ts:174-196` contains an equivalent private resolver and exported parser. Repository-wide call-site search found consumers importing the leaf (`batch-dataset-loader-core.ts`, `sp500-pair-enumerator.ts`, Finder pair modules, Rank Pairs, and tests), but no production consumer importing the FinderManager export.

The leaf’s comment still says browser consumers import from FinderManager “for backward compat” (`lib/synthetic-pair-token.ts:10-12`), which is stale relative to the current repository.

**Why it is more complex than necessary**

There are two implementations of the same token contract and comments instruct developers to keep them synchronized. That is maintenance debt, not a useful compatibility layer.

**Simplest alternative**

Delete the duplicate function, its local resolver, and the now-unused import from `finder-manager.ts`. Update the stale compatibility comment. Do not merge this parser with `synthetic-pair-parser.ts` without auditing contracts; that second parser intentionally has different normalization and suffix behavior.

This is the only clearly safe deletion identified without product-usage evidence.

### F12 — Crypto’s request builder parses the same input twice

**Severity:** Low  
**Engineering cost:** Low.  
**Maintenance cost:** Low/Medium.  
**User impact:** None.  
**Expected code reduction:** Approximately 10–25 production LOC or one duplicated parse path, less than 0.1% of the focused surface.  
**Confidence:** 0.98.

**Current implementation**

`CryptoDataService.getRequestBody` expands raw symbols with `expandCryptoSymbols` and then calls `buildCryptoSyncRequestPlans` with the same raw input (`lib/crypto-data/crypto-data-service.ts:158-168`). The two functions both split and parse synthetic-pair tokens in `crypto-symbol-plans.ts:15-62`.

**Why it is more complex than necessary**

The service pays for duplicate parsing and maintains two entry points that must agree on normalization. The returned `symbols` value is used only to update `lastSyncedSymbols`; the actual request is generated from a second parse.

**Simplest alternative**

Make the plan builder return the normalized display symbols alongside request plans, or add one small helper that parses raw tokens once. Keep the public exports if tests or external scripts use them; simplify the service call path first.

### F13 — The Crypto DOM contract exists but is not included in the contract test

**Severity:** Low  
**Engineering cost:** Low — less than 1 engineer-day.  
**Maintenance cost:** Medium.  
**User impact:** No immediate impact; future Crypto menu edits can break runtime initialization without the existing DOM test catching it.  
**Expected code reduction:** 0%; this is a reliability/velocity fix, not a deletion.  
**Confidence:** 0.99.

**Current implementation**

`lib/crypto-data/crypto-data-dom.ts:10-21` exports `CRYPTO_DATA_REQUIRED_IDS`, but `tests/feature-dom-contracts.spec.ts` imports and checks `IBKR_DATA_REQUIRED_IDS` and not the Crypto constant. The current DOM suite passes 48 tests, but Crypto is absent from that inventory.

**Why it is more complex than necessary**

The repository already has the correct contract mechanism; one feature is simply outside it. Developers get a false sense that all menu DOM contracts are covered.

**Simplest alternative**

Add the existing Crypto constant to the same test map. Do not add a second test framework or a new abstraction.

### F14 — Lazy tab registration is duplicated, but a new registry would be over-engineering

**Severity:** Low  
**Engineering cost:** Medium if refactored prematurely.  
**Maintenance cost:** Low/Medium.  
**User impact:** None.  
**Expected code reduction:** 0–100 LOC; likely no net reduction after typing and migration.  
**Confidence:** 0.90.

**Current implementation**

Tab/button definitions exist in the HTML shell, lazy feature initialization maps tab IDs to feature IDs (`lib/lazy-feature-init.ts`), and raw partial loading has another tab-loader map (`lib/strategy-panel-tab-markup.ts`).

**Why it is more complex than necessary**

Adding a tab requires touching multiple explicit registries. This is a genuine developer-experience cost.

**Simplest alternative**

Do not build a generic manifest now. The current explicit maps are easy to inspect and preserve startup ordering. Consolidate only when another tab is added or when a test demonstrates drift. A manifest would trade visible duplication for an indirect configuration system, contrary to the simplicity goal.

## What should be deleted first

### Immediate, repository-proven deletion

1. The unused `parseSyntheticPairToken` copy and private resolver in `lib/finder-manager.ts`.

### Highest-ROI conditional deletions

1. `TOP_MEAN` UI, routes, coordinator, workers, archive/artifact support, and service state—after confirming it is not an active workflow.
2. Finder Asset Opportunity batch/OOS—retain single Asset Opportunity Finder if it is used.
3. Genetic Search and its optimizer—retain Grid and Random.
4. Any “diagnostic-only” TOP_MEAN selectors or exports that remain after the main coordinator is removed.

The order matters: delete features before splitting managers or introducing shared orchestration. Otherwise the refactor preserves the same product complexity in more files.

## What should be simplified first

1. Replace Finder’s three browser-consumed server NDJSON result streams with one status-polling/terminal-snapshot path. Preserve server execution, Stop, `runId`, reattach, scalar wire contracts, and terminal authority.
2. Extract the identical IBKR/Crypto cache invalidation function.
3. Move provider CSV parsers into one leaf per format and use each from both writer/plugin and server loader.
4. Move heap thresholds into one shared pure guard.
5. Move Asset Opportunity cache-capacity math out of the worker-pool module.
6. Make Crypto request construction parse its raw symbol input once.
7. Only after the deletions, reassess whether `FinderManager` still needs scope-specific modules. Do not split a 4,321-line manager into five 800-line managers while keeping all four scopes and all execution modes.

## Keep as-is: complexity that is justified

### Server reliability and memory contracts

Keep run ownership and `runId` scoping, loopback authorization, disconnect-safe streams, terminal `/status` snapshots, Stop-before-ownership handling, generation-safe cleanup, artifact submission backpressure, PID-scoped orphan cleanup, artifact TTL, and scalar-only wire contracts. The targeted tests explicitly protect these behaviors. Removing them would trade visible code reduction for lost runs, cross-tab cancellation, remote CPU exposure, or multi-GB heap growth.

### Shared dataset loader core and cache boundaries

Keep `createBatchDatasetLoaderCore` and the browser/server parity tests. Keep bounded per-run cache lifetimes. Do not create a global dataset repository just to remove two loader construction sites.

### Synthetic-pair seed-interval correctness

Keep the 30-minute seed pipeline for IBKR 4H synthetic pairs. Aggregating each leg to 4H before computing a ratio changes the semantics and inflates ranges. This is correctness complexity, not premature optimization.

### IBKR provider-specific behavior

Keep gateway auth/status, contract resolution, catalog writes, incremental sync, stale append, source/interval/period validation, retry/chunk behavior, and Alpaca-specific handling. These are external-system/data-integrity concerns. They should not be forced into a generic market-data provider framework.

### Crypto market and symbol planning

Keep spot/futures selection, synthetic-pair expansion, finer seed planning, and template support. They represent actual product behavior. Remove only the duplicate parse in the service, not the planning rules.

### Normal Batch, balanced generator, and `OPEN_SCORE USD`

Keep normal Batch and balanced pair generation. Keep `OPEN_SCORE USD` because the research notes explicitly retained it after negative validation findings, and its artifact-backed replay is a distinct, bounded analysis capability. Do not reintroduce the removed Mine Prediction, Portfolio Fit, Mine Timing, or Stability Mine surfaces.

### Lazy loading and ordered bootstrap

Keep lazy loading of heavy research tabs and the explicit ordered bootstrap. The startup cost and chart/module dependency graph make this a justified boundary. The registry duplication is a small DX issue, not a reason to introduce a generic plugin system.

## Estimated total reduction

These estimates are not additive across every finding; F2 overlaps the scope deletions, and F6/F7/F8/F9 overlap shared lifecycle/setup code. The practical outcomes are:

| Scenario | Production LOC | Abstractions / specialized modules | Build complexity | Maintenance burden |
|---|---:|---:|---:|---:|
| Safe cleanup only (F10–F12 plus F11) | 100–200 fewer | 2–4 fewer duplicate seams | <1% lower | 2–4% lower |
| Recommended product pruning (F1, F3, F5) plus safe cleanup | 7,500–10,500 fewer | 12–20 fewer specialized modules/entrypoints and feature branches | 10–18% lower in the focused Vite/research build graph | 25–35% lower |
| Add Finder delivery simplification and sync/parser cleanup (F4, F6–F9) | 8,500–12,000 fewer | 18–28 fewer duplicate state machines, parsers, and route/worker seams | 12–22% lower | 30–40% lower |

The last row is the realistic target if usage checks support the three feature deletions. It removes approximately 17–24% of the focused production surface while preserving the core value set: chart Finder, Symbol Universe Finder, normal Batch, balanced generation, `OPEN_SCORE USD`, IBKR data, Crypto data, synthetic pairs, and the server safety contracts.

## Implementation status

The following low-risk findings were implemented in this worktree:

- Removed the dead `parseSyntheticPairToken` implementation and its private resolver from `finder-manager.ts`.
- Updated the synthetic-pair leaf comments so they no longer describe a removed FinderManager compatibility export.
- Added the existing Crypto DOM contract to `tests/feature-dom-contracts.spec.ts`.
- Made Crypto request-body construction derive normalized symbols from the request plans instead of parsing the same raw input twice.
- Centralized the duplicated Finder/Batch heap thresholds in `lib/server-heap-guard.ts` while preserving both public warning functions and their existing messages.
- Centralized identical IBKR/Crypto browser cache invalidation in `lib/local-data-cache-invalidation.ts`.
- Moved Asset Opportunity cache-capacity policy out of the worker-pool module into `finder-asset-opportunity-capacity.ts`; the old worker-pool export remains as a compatibility re-export.

The implemented production diff removes 152 duplicated/dead lines and adds 123 lines of narrowly scoped shared code, for a net reduction of approximately 29 production lines. The larger gain is eliminating duplicate decision points and an invalid module dependency; the conditional feature deletions are where the substantial LOC reduction remains.

The conditional product deletions—TOP_MEAN, Asset Opportunity batch/OOS, and Genetic Search—and the more invasive Finder status-stream simplification were deliberately not applied because this repository has no usage evidence proving those workflows can be removed safely.

## Validation baseline

Executed from the temporary worktree:

- `tsc --noEmit` — pass.
- `esno tests/feature-dom-contracts.spec.ts` — 50 pass, 0 fail.
- `esno tests/crypto-data-vite-plugin.spec.ts` — 26 pass, 0 fail.
- `esno tests/finder-server-plugin.spec.ts` — 73 pass, 0 fail.
- `esno tests/finder-asset-opportunity-batch-parallel.spec.ts` — 14 pass, 0 fail.
- `esno tests/ibkr-data-lifecycle.spec.ts` — 11 pass, 0 fail.
- `esno tests/server-ibkr-csv-loader.spec.ts` — pass.
- Earlier baseline: `esno tests/batch-backtest-server-plugin.spec.ts` — 60 pass, 0 fail.

The original worktree remains clean. This temporary worktree contains the report, the focused production reductions above, and the Crypto DOM test update.
