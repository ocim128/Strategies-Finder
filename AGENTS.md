# AGENTS.md

## Mission
This repository is a Vite + TypeScript trading strategy playground with a large UI surface, local market-data caching, optional Rust acceleration, and optional Cloudflare Worker alerts.

Use this file as the short operational handbook for making safe changes quickly.

## Start Here

Before editing anything important:
1. Read `README.md` for the repo-level map.
2. Read `index.ts` to understand initialization order.
3. Check `git status --short` so you do not trample unrelated work.
4. Identify which contracts your change touches:
   - UI ids / partials
   - settings schema / localStorage
   - strategy registration
   - backtest engine semantics
   - Rust fallback compatibility
   - Worker compatibility

## Mental Model

This codebase is a collection of tightly-coupled subsystems:
- runtime-injected UI assembled from `html-partials/*`
- id-driven handlers and feature managers
- strategy execution and backtesting
- multi-source data loading and caching
- optional worker-side signal evaluation and subscriptions

Most breakages come from contract drift, not algorithm bugs.

## The Contracts Most Likely To Break

### 1. UI DOM contracts
- Structural ids are defined in `lib/feature-dom-contracts.ts`
- HTML source of truth is `html-partials/*`
- Consumers live in handlers and managers such as:
  - `lib/handlers/ui-event-handlers.ts`
  - `lib/analysis-panel.ts`
  - `lib/finder-manager.ts`
  - `lib/walk-forward-service.ts`

If you rename or remove a structural id:
1. update the partial
2. update `lib/feature-dom-contracts.ts`
3. update the feature code
4. run `feature-dom-contracts.spec.ts`

### 2. Strategy registration split
- Main UI/runtime uses `strategyRegistry.ts`
- Worker uses static built-ins from `lib/strategies/library.ts`

If a built-in strategy is added or renamed and `library.ts` is not updated, worker-side alert evaluation will silently fail.

### 3. Settings compatibility
- Preserve localStorage/backward compatibility unless you add migration logic
- `tradeFilterMode` is canonical
- `entryConfirmation` is legacy compatibility still consumed in some paths

If a new setting is unsupported by Rust, strip it in both:
- `lib/backtest-service.ts`
- `lib/finder-manager.ts`

### 4. Time normalization
This repo accepts multiple time shapes:
- unix seconds
- unix milliseconds
- ISO strings
- `BusinessDay`

Prefer existing helpers:
- `timeKey`
- `timeToNumber`
- existing parse/normalize helpers

Do not introduce new ad hoc time conversion paths unless there is no existing seam.

## First-Tier File Map

### Bootstrap and app wiring
- `index.ts`
- `lib/layout-manager.ts`
- `lib/handlers/*`

### Trading engine
- `lib/strategies/backtest/*`
- `lib/backtest-service.ts`
- `lib/rust-engine-client.ts`
- `lib/rust-settings-sanitizer.ts`

### Data layer
- `lib/data-manager.ts`
- `lib/dataProviders/*`
- `lib/candle-cache.ts`
- `lib/local-sqlite-api.ts`
- `vite.config.ts`

### Research tools
- Finder: `lib/finder-manager.ts`, `lib/finder/*`
- Walk Forward: `lib/walk-forward-service.ts`
- Analysis: `lib/analysis-panel.ts`
- Scanner: `lib/scanner/*`
- Replay: `lib/replay/*`
- Pair Combiner: `lib/pair-combiner-manager.ts`, `lib/pairCombiner/*`
- Data Mining: `lib/data-mining-manager.ts`, `lib/featureLab/*`

### Alerts / Worker
- `workers/entry-signal-worker.ts`
- `workers/migrations/*`
- `lib/alert-service.ts`
- `workers/README.md`

## Safe Change Checklist

### Any UI change
- Confirm whether the element is structural or optional
- If structural, add it to `lib/feature-dom-contracts.ts`
- Update the relevant partial and manager/handler together
- Run:
  - `npm run typecheck`
  - `..\..\..\node_modules\.bin\esno feature-dom-contracts.spec.ts`

### Any backtest behavior change
- Validate:
  - long
  - short
  - both / combined if touched
  - `signal_close`
  - `next_open`
  - `next_close` if touched
- Recheck snapshot filters and entry timing if signals/fills moved

### Any settings change
- Keep key names stable when possible
- Check UI load/save path in `lib/settings-manager.ts`
- Check any resolver/sanitizer path that mirrors those settings

### Any worker-facing change
- Check `lib/alert-service.ts`
- Check `workers/entry-signal-worker.ts`
- If schema changes, add a migration

## Feature-Specific Workflows

### Add a built-in strategy
1. Create `lib/strategies/lib/<strategy-name>.ts`
2. Use helpers from `lib/strategies/strategy-helpers.ts`
3. Export:
   - `name`
   - `description`
   - `defaultParams`
   - `paramLabels`
   - `execute(data, params)`
   - `metadata` when applicable
4. Register in `lib/strategies/library.ts`
5. Verify dropdown + worker compatibility

### Modify Finder
- Expect performance sensitivity
- Avoid expensive per-bar allocations in hot loops
- Preserve cache decisions and deterministic seeded behavior
- If touching robust mode, keep explicit `PASS`/`FAIL` decision semantics

### Modify Walk Forward
- Be careful with UI state versus backtest state handoff
- `walk_forward_oos` snapshots intentionally route through shared result state
- Keep robustness summary / candidate validation panels aligned with actual run data

### Modify trade analysis
- `lib/analysis-panel.ts` is part UI controller, part feature orchestration
- Keep heavy computation in backtest analysis modules, not in DOM rendering code

## Robust Random WF Discipline

Treat `robust_random_wf` as survivability validation, not as a peak-profit optimizer.

Hard expectations:
- deterministic `robustSeed`
- explicit `PASS` or `FAIL`
- pass rate computed from Stage C survivors
- audit event emitted for both passes and fails:
  - `[Finder][robust_random_wf][cell_audit]`

Recommended validation habit:
- hold strategy set, symbols, timeframes, data span, and cost assumptions fixed
- use a fixed seed set such as `1337, 7331, 2026, 4242, 9001`
- do not reroll seeds until the result passes

## Validation Commands

Run from this directory.

Core:
- `npm run typecheck`
- `npm run test`
- `npm run test:e2e`

Useful extras:
- `..\..\..\node_modules\.bin\esno feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno pairCombiner.spec.ts`
- `npm run robust:summary -- run-seed-1337.txt run-seed-7331.txt`

## Current Baseline

Observed baseline as of `2026-03-08`:
- `npm run typecheck`: expected to pass
- `npm run test`: expected to pass
- `npm run test:e2e`: may still be environment-sensitive because of browser timing

Treat unrelated pre-existing failures carefully. Do not assume your change caused them without checking.

## Common Failure Modes
- Renamed UI id in `html-partials/*` but forgot handler or contract update
- Added a strategy to the UI registry but not to `lib/strategies/library.ts`
- Added a new setting but forgot Rust sanitization or finder parity
- Used raw `document.getElementById(...)` for structural UI instead of a typed contract
- Broke time handling by coercing `BusinessDay` like a number
- Changed signal timing semantics without rechecking entry snapshots / execution model behavior

## Documentation Standard

If you change behavior substantially, update the docs that actually carry that contract:
- `README.md` for repo-level usage and architecture
- `AGENTS.md` for safe-change guidance
- `workers/README.md` for worker API and cron behavior

Keep repo-level docs broad and operational. Strategy-specific lore belongs in dedicated docs, not in the main README.
