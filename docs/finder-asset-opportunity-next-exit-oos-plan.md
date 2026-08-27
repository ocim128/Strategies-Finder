# Finder Asset Opportunity Next-Exit OOS — Technical Plan

Status: implemented (2026-08-27)
Date: 2026-08-27

Implementation note: the documented first-exit policy and realized engine
`Trade.pnlPercent` convention were used. The implementation is additive and
keeps fixed horizons as the default.

## Scope and decision

Add a second Asset Opportunity forward-OOS measurement mode while preserving
the current fixed-horizon mode byte-for-byte by default.

The new mode is **Next configured exit**. It measures the first exit generated
by the existing backtest engine after the latest fresh boundary signal. This
includes configured TP/SL, signal exits, exit-strategy overrides, trailing and
path exits, time stops, and the `riskMaxHoldEnabled`/`riskMaxHoldBars` limit.
The engine currently reports both time-stop types as `exitReason: "time_stop"`;
this plan does not change that shared reason contract.

Assumptions to lock before implementation:

- The result is the first recorded exit event for the boundary entry. If
  partial-taking is enabled, `partial` is reported as the first event rather
  than silently aggregating the later full close.
- `end_of_data` is not a configured exit. It becomes a `censored` outcome with
  no PnL observation.
- Next-exit PnL uses the engine's realized `Trade.pnlPercent` (including the
  configured modeled costs). Existing fixed horizons remain price-only
  close-to-entry PnL and are never averaged with next-exit values.
- `OOS Holdout Bars` remains the hidden observation window and maximum wait
  window. A positive holdout is required for either forward measurement.
- Forward measurement remains informational. It does not change candidate
  selection, `decideAssetGrade`, the existing generic `oosResult`, or Finder
  resort ordering.

This is intentionally an Asset Opportunity change only. Current-chart Finder,
Symbol Universe, Strategy Quality, generic OOS validation, Worker routes, and
database/storage schemas are out of scope.

## Current architecture and data flow

- `lib/finder/finder-asset-opportunity-runner.ts` reserves the hidden suffix as
  `fixedOosBars`, detects the fresh boundary entry, selects one winner from the
  top-K pool, and currently calls
  `calculateFinderAssetOosSignalMetrics(...)` for fixed close horizons.
- `lib/finder/finder-asset-opportunity-oos.ts` owns the fixed-horizon metric
  types and normalizers.
- `lib/finder/finder-asset-candidate-execution.ts` and
  `executeBacktest(...)` in `lib/backtest-executor.ts` are the shared candidate
  execution seam. `runBacktest(...)` in
  `lib/strategies/backtest/backtest-engine.ts` applies risk exits, signal exits,
  exit overrides, and forced end-of-data closes.
- Server Asset Opportunity execution enters through
  `lib/finder/server/asset-opportunity-iteration.ts`; browser and server paths
  share the runner but inject different IS-search implementations.
- Scalar results cross the server boundary through
  `lib/finder/server/finder-stream-types.ts`. Browser persistence and archive
  serialization use `lib/finder/finder-result-snapshot.ts` and
  `lib/finder/finder-asset-opportunity-metadata.ts`.

Target flow:

```text
IS search → fresh boundary signal → winner selected
         → full execution-aware timeline replay
         → extract boundary entry's first exit event
         → scalar result/UI/archive
```

The replay must use the full timeline so historical position state, ATR/path
state, adaptive state, future signal exits, and max-hold timing remain
consistent with normal backtesting. It runs only after the winner is selected;
hidden data therefore cannot influence candidate ranking.

## Phase 1 — Add the mode and result contracts

### Objective

Represent next-exit mode explicitly and keep absent/invalid mode values on the
existing fixed-horizon behavior.

### Tasks

- Add an optional `oosMeasurementMode?: "fixed_horizon" | "next_exit"` to
  `FinderAssetOpportunityOptions` in `lib/types/finder.ts`; default to
  `fixed_horizon` at the UI/server boundary.
- Add a dedicated `FinderAssetOosNextExitMetrics` type in
  `lib/finder/finder-asset-opportunity-oos.ts`, containing the normalized hidden
  window, `status: "exited" | "censored" | "unavailable"`, realized
  `pnlPercent`, `exitReason`, `barsHeld`, and exit time where available.
- Add `oosNextExitMetrics?` to `FinderAssetOpportunityResult`; leave
  `oosHorizonMetrics` unchanged.
- Add one shared mode normalizer beside the existing OOS normalizers. Invalid,
  missing, or legacy values resolve to `fixed_horizon`.
- Preserve old persisted UI payloads and old scalar snapshots without a
  migration; the new field is optional and additive.

### Dependencies

None.

### Risks or blockers

- Mixing the two metric shapes would make UI averages and archive analysis
  invalid; they must remain separate fields or a clearly discriminated union.
- `exitReason` must reuse the existing `Trade` reason values; do not add a new
  max-hold reason in this feature.

### Deliverables

Typed options/result contracts, one mode normalizer, and backward-compatible
snapshot/stream type updates.

### Validation/testing

- Extend `tests/finder-asset-opportunity-oos.spec.ts` for mode normalization and
  next-exit status/value shape.
- Extend `tests/finder-result-snapshot.spec.ts` and
  `tests/finder-asset-opportunity-stream.spec.ts` to prove the new scalar field
  survives serialization and contains no arrays/trades.
- Run `npm run typecheck`.

### Exit criteria

The new mode can be represented end-to-end in types, while a request with no
mode produces exactly the current fixed-horizon contract.

## Phase 2 — Implement winner-only next-exit replay

### Objective

Measure the boundary opportunity using the existing backtest exit semantics,
without duplicating exit logic or allowing hidden data to affect selection.

### Tasks

- Add a sibling helper in
  `lib/finder/finder-asset-opportunity-runner.ts`, such as
  `runCandidateNextExitOnAsset(...)`, invoked only when the mode is
  `next_exit` and `fixedOosBars.length > 0`.
- Replay the selected candidate on `fullClosed`, using the same candidate
  parameter normalization, Finder risk overrides, exit-strategy candidate,
  `dataFetcher`, and `useRustEnginePreference` already used by
  `executeAssetCandidate(...)`.
- Retain trade history and identify the boundary entry by direction and the
  expected modeled entry time: the visible signal time for `signal_close`, or
  the first hidden candle for `next_open`/`next_close`. Use existing time
  normalization helpers rather than ad-hoc timestamp conversion.
- Select the first recorded exit event for that boundary entry. Preserve the
  engine's execution order and fill behavior for TP/SL, signal exits, path
  exits, trailing exits, time stops, max hold, slippage, and commissions.
- Map a matching `end_of_data` event to `censored`; return `unavailable` for a
  replay or boundary-entry mismatch so an execution failure is not mistaken
  for a genuine no-exit outcome.
- Keep the current `calculateFinderAssetOosSignalMetrics(...)` branch unchanged
  for `fixed_horizon` mode. Keep the separate generic `oosResult` pass
  unchanged.
- Reuse existing OOS diagnostic timing/counters where possible; add only
  scalar next-exit status counts if the existing diagnostics cannot distinguish
  replay failure from censoring.

### Dependencies

Phase 1 contracts. The existing full closed-candle preparation and candidate
execution seams must remain available to both browser and server paths.

### Risks or blockers

- Running only on the hidden suffix would lose historical state and can change
  signal, ATR, adaptive, and path-exit behavior. The full timeline replay is
  required even though only the boundary outcome is retained.
- The replay must not use only retained visible signals; hidden future primary
  signals and exit-strategy signals are needed for signal exits.
- A future entry after the boundary exit must not replace the boundary result.
- Rust and TypeScript outputs must agree on entry/exit timestamps, reason, and
  realized PnL when Rust is eligible. TypeScript remains the fallback for
  unsupported settings.

### Deliverables

A shared runner path that returns one scalar next-exit outcome per selected
Asset Opportunity result, with no new backtest engine or exit-rule duplicate.

### Validation/testing

- Add focused cases to `tests/finder-asset-opportunity-runner.spec.ts` for:
  - TP/SL exit;
  - future opposite signal exit;
  - `riskMaxHoldEnabled` producing the existing `time_stop` reason;
  - exit-strategy override and `disableSignalExits` behavior;
  - `signal_close`, `next_open`, and `next_close` entry timing;
  - no configured exit before the holdout ends producing `censored`;
  - a replay failure producing `unavailable`;
  - a later trade not replacing the boundary trade;
  - fixed-horizon results remaining unchanged.
- Use deterministic OHLCV and signals so tests verify why the outcome is
  selected, not merely that a number is returned.
- Run `npm run typecheck` and the focused runner/OOS specs.

### Exit criteria

For the same candidate and data, next-exit mode reports the same first exit
event as the normal backtest engine, while fixed-horizon mode produces the
existing values and candidate grades/ranks remain unchanged.

## Phase 3 — Wire UI, server options, snapshots, and archives

### Objective

Expose the mode in Asset Opportunity single and batch runs without changing
routes, ownership, security, or storage infrastructure.

### Tasks

- Add an Asset Opportunity-only select in `html-partials/tab-finder.html`:
  `Fixed horizons` and `Next configured exit`. Hide or disable the horizons
  input in next-exit mode, and dynamically describe `OOS Holdout Bars` as the
  maximum observation window.
- Add the DOM contract and fake-DOM field in
  `lib/finder/finder-manager-dom.ts` and
  `tests/helpers/fake-finder-manager-dom.ts`.
- Add persisted UI state/default/load/save/request handling in
  `lib/finder-manager.ts`. Keep the existing horizon string intact for users
  switching back to fixed mode.
- Normalize and pass the mode through both Asset Opportunity HTTP paths in
  `lib/finder/server/finder-vite-plugin.ts`; preserve it in the batch
  `buildIterationOptions(...)` clone. Do not add a route or schema.
- Update `lib/finder/finder-ui.ts` with a separate next-exit row/panel and an
  aggregate summary showing observed, censored, unavailable, average realized
  PnL, and exit-reason counts. Never combine it with fixed-horizon averages.
- Extend `lib/finder/finder-result-snapshot.ts` and scalar stream assertions to
  retain the new field.
- Extend `lib/finder/finder-asset-opportunity-metadata.ts` and
  `lib/finder/server/finder-asset-opportunity-archive.ts` with explicit
  `nextExitOosPerformance` and a mode-specific all-result baseline/pair-summary
  payload. Preserve existing fixed-horizon archive fields and filenames so old
  archive blocks remain readable; include the mode in new config/payload data.
- Keep batch holdout filenames and run-id/loopback authorization unchanged.
  The batch values represent maximum observation windows in next-exit mode.

### Dependencies

Phases 1 and 2. Existing scalar stream, snapshot, archive, and DOM contract
tests must remain the source of truth for their respective boundaries.

### Risks or blockers

- A next-exit batch archive without its mode or baseline would be ambiguous;
  new fields must be explicit and optional for legacy readers.
- Forgetting the fake DOM or structural ID contract will break browser tests.
- Existing archive analyzers expect horizon-shaped data; they must ignore or
  separately consume next-exit fields rather than treating exit outcomes as
  bar horizons.

### Deliverables

Persisted UI control, server/browser pass-through, scalar rendering, reload
restore, and archive payloads for both measurement modes.

### Validation/testing

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-metadata.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-asset-opportunity-archive.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-manager-lifecycle.browser.spec.ts`
- Verify a server batch emits scalar next-exit fields, survives status/reattach,
  and appends a mode-labelled archive block.

### Exit criteria

Users can run either mode in single or batch Asset Opportunity, reload/reattach
without losing the result, and inspect/copy unambiguous metrics. Existing
fixed-mode UI, archives, snapshots, and tests remain compatible.

## Cross-cutting technical constraints

### Performance

The new replay is winner-only, not candidate-pool-wide. It adds at most one
full-timeline candidate execution per asset/strategy/holdout iteration and
retains only scalar output. It must use the existing compact/no-equity options
where compatible and preserve Rust preference threading. No process-global
dataset or signal cache should be introduced.

### Error handling

No exit before the hidden window is a valid `censored` observation. A thrown
replay, missing boundary entry, or malformed result is `unavailable` and should
remain distinguishable in diagnostics and UI. Invalid mode input falls back to
fixed horizons; invalid horizon input keeps the existing normalizer behavior.

### Security and infrastructure

No new endpoint, credential, database, migration, worker, or deployment
configuration is needed. Existing Finder loopback authorization, run-id
ownership, scalar-only stream contract, and archive path validation remain
unchanged.

### Rollback

The feature is additive with a fixed-horizon default. Rollback can remove the
mode control and next-exit branch while leaving existing `oosHorizonMetrics`,
legacy snapshots, and archive blocks intact. No persisted-data migration or
destructive archive operation is required.

## Final implementation gate

Completed using the documented first-exit policy and realized engine PnL
convention. A future change to wait for the full position close would require
revisiting Phase 2, partial-exit aggregation, and archive baselines.
