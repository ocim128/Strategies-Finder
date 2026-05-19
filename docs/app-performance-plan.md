# App Performance Implementation Plan

## Goal

Improve the app's highest-value performance surfaces without changing trading semantics:

- reduce browser startup and app-ready time
- reduce Finder and walk-forward wall-clock time
- keep the strategy library fast even though built-ins are added and deleted frequently
- reduce manual backtest latency by deferring work the UI does not immediately need

This plan is phase-based and execution-oriented. A later AI agent should be able to implement it phase by phase without needing to rediscover the architecture tradeoffs.

## Purpose of This Plan

This repo has two different performance problems:

1. browser runtime startup work is too eager
2. research workloads still repeat avoidable strategy-side computation

Those problems should not be solved with one giant refactor.

This document exists to:

- order the work by ROI instead of by convenience
- keep worker and runtime contracts stable
- make strategy-library churn a first-class constraint instead of an afterthought
- define what "done" means for each phase

## Important Constraint: Strategy Library Churn

The built-in strategy library changes frequently:

- new files are added often
- old files are removed
- existing files keep changing

That means performance work cannot rely on a one-time cleanup pass across the current set of files.

This plan must leave behind:

- generation tooling that stays correct when strategies are added or deleted
- authoring guidance so new strategies follow the fast path by default
- simple audits or tests that catch regressions caused by new strategy files

If a phase only fixes today's strategy set and does not survive daily churn, that phase is incomplete.

## Verified Current State

These observations are from the current code audit:

- [lib/app-bootstrap.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/app-bootstrap.ts) eagerly initializes 34 feature stages before initial data load.
- [strategyRegistry.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/strategyRegistry.ts) loads [lib/strategies/manifest.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategies/manifest.ts), and that manifest eagerly imports 105 built-in strategy modules.
- Finder and walk-forward already support prepared strategy data through:
  - [lib/finder/finder-runner-core.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/finder/finder-runner-core.ts)
  - [lib/finder/finder-runner-shared.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/finder/finder-runner-shared.ts)
  - [lib/strategies/walk-forward.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategies/walk-forward.ts)
- Only one built-in strategy currently implements `prepareFinderData` / `executePrepared`.
- Manual backtest completion always computes edge statistics in:
  - [lib/backtest-service.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-service.ts)
  - [lib/backtest-executor.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/backtest-executor.ts)

## Verified Priority Decisions

| Item | Decision | Why |
| --- | --- | --- |
| Separate strategy metadata from executable module loading | Do first | Biggest startup win and required for strategy churn |
| Keep worker/eager library path intact during browser lazy-loading work | Do first | Avoids broad worker/runtime breakage |
| Lazy-init non-core bootstrap features | Do second | Strong app-ready win after strategy loading is fixed |
| Expand `prepareFinderData` / `executePrepared` and add authoring guardrails | Do second | Biggest research-workload win and must survive daily strategy churn |
| Defer edge statistics until actually needed | Do third | Easy latency win with low semantic risk |
| Micro-optimize renderers or persistence first | Reject for now | Lower ROI than the architectural work above |
| Force Rust by weakening settings checks | Reject | Changes correctness, not just performance |

## Non-Negotiable Invariants

Every phase must preserve these rules:

- Do not change backtest, Finder, or walk-forward result semantics just to run faster.
- Do not break worker compatibility or the eager worker-side strategy library path.
- Do not hand-edit generated manifest files.
- Daily strategy add/delete churn must remain compatible with `npm run strategies:sync-manifest`.
- Saved current-strategy restore must still work after browser lazy-loading changes.
- Lazy-loading in the browser must not break:
  - custom strategies from localStorage
  - Finder strategy selection
  - strategy dropdown rendering
  - worker-side library imports
- `prepareFinderData` must remain an optimization only.
  - `executePrepared(...)` must stay semantically identical to `execute(...)`.
- Edge-statistics deferral must not remove edge statistics from any surface that explicitly asks for them.

## Important Shortcuts to Avoid

These are specifically not the right implementation path:

- Do not replace the current manifest with one browser-only lazy format and break worker imports.
- Do not make `Strategy.execute(...)` async.
- Do not force-load all strategy modules during app bootstrap "just once" after building a lazy manifest.
- Do not introduce a custom TypeScript AST/parser layer just to extract strategy metadata in the first pass.
- Do not try to convert every strategy to `prepareFinderData` in one giant pass before adding guardrails.
- Do not compute edge statistics in the background without a stable request boundary or cache key.
- Do not mix lazy bootstrap work with a redesign of tabs, DOM contracts, or feature ownership.

## Phase 0: Baseline and Guardrails

### Purpose

Create enough measurement and regression coverage that later phases can change loading and execution order safely.

### Changes

1. Add structured timing for:
   - app bootstrap total
   - strategy manifest load
   - first data load
   - first backtest run
   - Finder run buckets:
     - signal generation
     - backtest stage
     - total
2. Keep timing under existing debug logging patterns.
3. Add or extend tests for:
   - strategy manifest sync
   - strategy registry loading behavior
   - Finder prepared-path parity where needed later

### Files

- `strategyRegistry.ts`
- `lib/app-bootstrap.ts`
- `lib/finder/finder-runner-single.ts`
- `tests/strategy-manifest-sync.spec.ts`
- new focused tests only where required

### Acceptance Criteria

- There is a stable before/after timing baseline for startup and Finder.
- Existing manifest sync coverage still passes.
- No behavior changes yet.

### Validation

- `npm run typecheck`
- `npm run test`

## Phase 1: Split Strategy Metadata From Browser Module Loading

### Purpose

Reduce startup cost without breaking worker/eager execution paths, and make daily strategy churn safe.

This is the foundation phase. Do this before lazy bootstrap or strategy prepared-data rollout.

### Changes

1. Extend [scripts/strategy-manifest-generator.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/scripts/strategy-manifest-generator.ts) so `npm run strategies:sync-manifest` generates browser-oriented artifacts in addition to the existing eager manifest.
2. Keep the existing eager manifest for worker/library compatibility.
3. Add generated browser artifacts with a minimal split:
   - metadata list
   - lazy loader map
4. Introduce a browser strategy catalog surface that can answer:
   - list of built-in strategy keys
   - display name
   - description
   - default params
   - param labels
   - strategy metadata needed for UI listing
5. Add `ensureBuiltInStrategyLoaded(key)` and `ensureBuiltInStrategiesLoaded(keys)` helpers for browser runtime use.

### Recommended Artifact Shape

Keep the current eager manifest for existing worker/library consumers.

Add generated browser-facing manifest files:

- `lib/strategies/manifest-summary.ts`
- `lib/strategies/manifest-meta.ts`
- `lib/strategies/manifest-loaders.ts`

Recommended contents:

- `manifest-summary.ts`
  - key, name, description, strategy kind flags, and lightweight metadata for browser listing
  - no default params or param labels
- `manifest-meta.ts`
  - full metadata, default params, and param labels for compatibility/admin paths
  - no strategy execute code imported eagerly
- `manifest-loaders.ts`
  - `key -> () => import("./lib/<key>")`

This keeps worker/runtime compatibility simple:

- worker and eager library continue using the existing manifest path
- browser UI uses metadata plus lazy loaders

### Metadata Extraction Rule

This is the main hidden-complexity risk in the original plan.

The first implementation pass must keep metadata generation simple.

Allowed approaches:

- generate metadata during `strategies:sync-manifest` using the simplest stable mechanism already available to the repo
- if full human-readable metadata proves brittle, ship Phase 1 first with:
  - lazy loader map
  - key-based built-in catalog
  - human-friendly metadata filled in only for loaded strategies

Rejected approach for Phase 1:

- building a custom AST parser just to extract `name`, `description`, `defaultParams`, and `paramLabels`

Phase 1 should not be blocked on perfect metadata extraction if the simpler lazy-loading foundation is ready.

### Registry / Catalog Changes

Do not overload the current `strategyRegistry` with metadata-only placeholders.

Recommended split:

- keep `strategyRegistry` as the store of loaded executable strategies
- add a catalog helper for built-in metadata and loader access
- update browser callsites that only need metadata so they do not require a fully loaded strategy

### Required Browser Callsite Adjustments

At minimum, review these areas:

- [strategyRegistry.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/strategyRegistry.ts)
- [lib/app-bootstrap.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/app-bootstrap.ts)
- [lib/finder-manager.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/finder-manager.ts)
- [lib/ui-manager.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/ui-manager.ts)
- any strategy dropdown or Finder-selection UI that currently assumes `strategyRegistry.getAll()` is the source of truth for listing built-ins

### Startup / Restore Constraints

This is the second hidden-complexity risk in the original plan.

Today startup restore assumes built-ins are already in `strategyRegistry`.
That will break if lazy loading is introduced carelessly.

Required rules:

- the default built-in strategy must be loadable before first param render
- a saved built-in `currentStrategyKey` must be loadable before saved settings apply strategy-dependent UI
- custom strategies restored from localStorage must keep working alongside lazy built-ins
- no startup path may silently fall back to the wrong strategy just because the requested built-in has not been loaded yet

Minimal acceptable implementation:

- keep a tiny eager path for:
  - default built-in strategy
  - saved current built-in strategy
- lazy-load all other built-ins on demand

Do not try to make the entire app start with zero built-in strategies loaded if that complicates settings restore.

### Daily-Churn Rules

- All generated files must be fully derived from `lib/strategies/lib/*`.
- Add/delete/rename must be handled only by `npm run strategies:sync-manifest`.
- Do not introduce a manual registry list.

### Acceptance Criteria

- Browser startup no longer eagerly imports every built-in strategy module.
- Worker and eager library consumers still work through the existing manifest path.
- Adding or deleting a strategy file and re-running `npm run strategies:sync-manifest` updates all required generated outputs.
- UI listing surfaces can render built-in strategy metadata without loading execute code for every strategy.
- Refreshing the app with a saved non-default built-in strategy restores the correct strategy and params.

### Validation

- `npm run strategies:sync-manifest`
- `npm run typecheck`
- `npm run test`
- manual smoke check:
  1. app boots
  2. strategy dropdown renders
  3. selecting a built-in strategy loads its full behavior on demand
  4. refresh with a saved non-default built-in strategy
  5. worker-facing paths still resolve built-ins

## Phase 2: Lazy-Initialize Non-Core Bootstrap Features

### Purpose

Reduce app-ready time by removing non-essential feature work from initial bootstrap.

### Changes

1. Keep only core startup features eager:
   - layout
   - global errors
   - strategy metadata bootstrap
   - charts
   - strategy panel shell
   - state subscriptions
   - base UI events
   - settings restore and handlers
   - initial data load
2. Move non-core features to first-use initialization.
3. Use tab-open or direct-control interaction as the trigger.
4. Make every moved feature init idempotent.

### Recommended Lazy Targets

First-wave lazy targets should be tab-owned or clearly user-invoked features:

- `finder`
- `hunt`
- `walk-forward`
- `portfolio-lab`
- `strategy-ensemble`
- `polymarket-panel`
- `monte-carlo`
- `data-mining`
- `quick-view`
- `strategy-library-admin`
- `debug-panel`

Do not move these in the first lazy-bootstrap wave:

- `alert-handlers`
- `live-positions-handlers`
- any global keyboard shortcut or background listener whose value depends on being ready at startup

Those are second-wave candidates only after the tab-owned wave is stable.

### Trigger Rules

Recommended first-use triggers:

- strategy-panel tab open for tab-owned features
- explicit button open for non-tab features
- only initialize once

Use [lib/strategy-panel-controller.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategy-panel-controller.ts) as the main activation seam for tab-driven features.

### Implementation Notes

- Do not hide missing initialization behind fragile null checks.
- Add explicit `init()` guards on feature services if they do not already exist.
- If a feature needs loaded strategies to render its UI, load only the required strategies at that time.
- Land lazy bootstrap in small batches.
  - Do not move every candidate feature in one patch.
  - Recommended order:
    1. `quick-view`, `data-mining`, `debug-panel`
    2. `walk-forward`, `portfolio-lab`, `strategy-ensemble`, `monte-carlo`
    3. `finder`, `hunt`, `polymarket-panel`

### Acceptance Criteria

- Initial app bootstrap performs only core setup.
- Non-core feature setup runs only when the user opens that feature.
- Tab behavior remains correct after first-use initialization.
- No feature initializes twice.

### Validation

- `npm run typecheck`
- `npm run test`
- manual smoke check:
  1. app boots with chart and settings working
  2. opening each lazy tab initializes it on first use
  3. reopening the tab does not reinitialize it

## Phase 3: Make Prepared Strategy Execution the Default Fast Path

### Purpose

Reduce repeated signal-generation work in Finder and walk-forward, and make that improvement survive daily strategy churn.

This phase must not be implemented as one library-wide conversion pass.
The original plan was too open-ended here.

### Changes

1. Add a repeatable audit that identifies heavy built-ins missing the prepared path.
2. Define a simple prepared-execution pattern and use it consistently:
   - `prepareFinderData(data, settings, context?)`
   - `executePrepared(preparedData, params, data, context?)`
3. Add authoring guardrails so new strategies use the prepared path when they should.
4. Convert built-ins in batches, starting with strategies that build reusable arrays or rolling statistics.
5. Add parity tests for converted strategies.

### First Conversion Targets

Start with strategy families identified by the audit as repeatedly building reusable arrays:

- rolling median / z-score / percentile families
- VWAP and session-VWAP families
- entropy / kurtosis / skewness rolling-stat families
- cross-symbol spread / relative-value families

Do not start with tiny strategies that have no meaningful reusable precompute.

### Recommended Pattern

Use [lib/strategies/lib/entropy_ratio_regime_alignment.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/strategies/lib/entropy_ratio_regime_alignment.ts) as the reference shape:

- prepare raw reusable arrays once
- keep window-keyed caches inside the prepared object
- let `executePrepared(...)` read from that prepared object
- keep `execute(...)` as a compatibility wrapper

### Authoring Guardrails

Because the strategy library changes daily, this phase is incomplete without guardrails.

Required follow-up changes:

1. Update [docs/strategy-authoring.md](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/docs/strategy-authoring.md) so the prepared pattern is the default recommendation for any strategy that builds reusable arrays.
2. Update any AI strategy-generation guidance that creates built-ins so it does not keep producing heavy `execute(...)`-only files.
3. Add a light audit surface:
   - either a script
   - or a test/report
   that flags strategies using heavy rolling helpers or indicator helpers without the prepared path

Do not make the first audit overly clever. A simple report is enough if it is stable and easy to run.

### Bounded Rollout Rule

Do not define success for this phase as "every strategy converted."

This phase is complete when:

- the audit exists
- authoring guidance is updated
- the highest-cost strategy families from the audit are converted
- new strategy churn is pushed toward the prepared path by default

If later profiling shows more conversion work is still worth it, that can be a follow-up phase.

### Parity Rules

For every converted strategy:

- `executePrepared(...)` output must match `execute(...)`
- Finder and walk-forward behavior must stay identical
- normalization behavior must stay identical

### Files

- `lib/strategies/lib/*` for converted strategies
- `docs/strategy-authoring.md`
- AI generation guidance files if they are the source of new built-ins
- new audit script or test/report for heavy strategies missing the prepared path
- new or updated strategy parity tests

### Acceptance Criteria

- Converted strategies use the prepared path and keep behavior identical.
- New strategy authoring guidance explicitly covers the prepared path.
- There is a simple repeatable audit for heavy strategies missing the prepared path.
- Strategy-library churn no longer pushes the codebase back toward repeated signal-generation waste by default.
- Phase success does not depend on 100% library conversion.

### Validation

- `npm run typecheck`
- `npm run test`
- any focused strategy parity specs added in this phase
- manual smoke check:
  1. Finder still ranks the same for a fixed seed and config
  2. walk-forward output remains stable for converted strategies

## Phase 4: Defer Edge Statistics Until a Surface Actually Needs Them

### Purpose

Reduce manual backtest latency by removing expensive post-processing from the unconditional completion path.

The original plan was too vague about what would trigger edge-stat computation.

### Changes

1. Stop computing edge statistics inside the unconditional result finalization path in:
   - `lib/backtest-service.ts`
   - `lib/backtest-executor.ts`
2. Add an explicit on-demand compute path for edge statistics.
3. Cache the computed result on the backtest result or behind a stable request boundary so it is not recalculated repeatedly during one UI session.
4. Keep Finder composite-edge-ratio behavior unchanged.
   - Finder already computes composite edge only when required by ranking.

### Recommended Trigger

Minimal allowed trigger for this phase:

- compute edge statistics on first explicit reveal of the edge-analysis section for the current result

Allowed fallbacks only if the UI has no reveal seam today:

- add a minimal collapsed/reveal control for edge analysis
- or defer this phase until that seam exists

Rejected trigger for this phase:

- unconditional background computation after every backtest "just in case"

Do not compute edge statistics just because a backtest finished.

### Files

- `lib/backtest-service.ts`
- `lib/backtest-executor.ts`
- `lib/strategies/backtest/edge-statistics.ts`
- [lib/renderers/resultsRenderer.ts](/c:/Users/user/Documents/Repo/Experimental/lightweight-charts/debug/playground/Strategies-Finder/lib/renderers/resultsRenderer.ts) or the service that owns result rendering

### Acceptance Criteria

- A manual backtest can complete without computing edge statistics immediately.
- Opening the edge-analysis UI still computes and shows the same values.
- Edge statistics are not recomputed repeatedly during one stable result view.
- The trigger for computing edge statistics is explicit and testable.

### Validation

- `npm run typecheck`
- `npm run test`
- manual smoke check:
  1. run backtest
  2. confirm results appear faster
  3. open edge-analysis section
  4. confirm values still render correctly

## Phase 5: Re-Profile and Decide on Second-Order Work

### Purpose

Avoid adding complexity before measuring the effect of the first four phases.

### Changes

1. Re-measure startup timing.
2. Re-measure Finder timing on representative heavy strategies.
3. Re-measure manual backtest completion timing.
4. Only then decide whether more work is justified in:
   - UI rendering details
   - strategy result rendering
   - persistence hot paths
   - deeper Rust payload changes

### Explicitly Deferred

These are not part of the first correct implementation pass:

- background worker execution redesign
- Rust contract redesign
- broad renderer rewrites
- speculative caching of every candidate signal array
- feature-level state-management redesign

### Acceptance Criteria

- There is a measured before/after record for startup, Finder, and manual backtest.
- Any new performance phase is justified by those measurements.

### Validation

- same timing instrumentation used in Phase 0

## Suggested Delivery Order

Land this work in this order:

1. Phase 0 baseline and guardrails
2. Phase 1 strategy metadata + lazy-loader foundation
3. Phase 2 lazy bootstrap
4. Phase 3 prepared strategy execution + authoring guardrails
5. Phase 4 lazy edge statistics
6. Re-profile
7. Only then consider second-order work

Do not start by mass-converting strategies before the manifest and bootstrap work is stable. Do not start by redesigning Rust paths before the core browser/runtime waste is removed.

## Definition of Done

This plan is complete only when all of the following are true:

- browser startup no longer eagerly imports every built-in strategy module
- worker-side eager library behavior still works
- non-core feature init is removed from initial bootstrap
- prepared strategy execution is the default path for heavy built-ins and the authoring docs enforce that direction
- strategy-library churn is handled by generation tooling and simple audits, not by manual review alone
- manual backtest completion no longer pays for edge statistics unless a consumer actually requests them
- `npm run strategies:sync-manifest`, `npm run typecheck`, and `npm run test` all pass
- manual smoke checks confirm the app still behaves correctly across startup, strategy selection, Finder, walk-forward, and results rendering
