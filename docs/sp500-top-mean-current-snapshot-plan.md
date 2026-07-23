# S&P 500 TOP_MEAN Current Snapshot and Incremental State Plan

## Goal and boundary

The S&P 500 TOP_MEAN Coordinator currently runs full pair backtests and then
uses `runOpenScoreUsdReplay(...)` to build a historical decision-event
leaderboard. `topAssets[0]` is the asset selected most often in the requested
historical window; it is not the selection at the latest closed candle.

This plan separates two jobs:

1. **Current snapshot:** calculate TOP_MEAN from positions open at the latest
   closed candle.
2. **Incremental refresh:** after an initial full run, process only new data
   while preserving enough state to reproduce the same current snapshot.

The short-term work removes the historical replay cost and exposes the current
decision from the artifacts. It does **not** remove the initial cost of
backtesting every pair. The medium-term work is the part that can avoid that
repeated full backtest.

This remains a local coordinator/research feature. It does not place orders,
add a database, change the Worker alert system, or establish TOP_MEAN as a
validated profitable selector. The existing findings in
[`docs/mine-timing-validation-findings.md`](mine-timing-validation-findings.md)
remain applicable.

## Existing architecture

```text
POST /api/batch-backtest/sp500-top-mean/run
  -> batch-backtest-vite-plugin.ts
  -> TopMeanCoordinatorEngine.run()
  -> TopMeanWorkerPool
  -> sp500-top-mean-worker.ts
  -> artifacts/sp500-top-mean/<runId>/shards/*.json
  -> historical OPEN_SCORE replay
  -> done/status/result payloads and Batch UI
```

Relevant contracts:

- [`sp500-top-mean-coordinator-engine.ts`](../lib/batch-backtest/sp500-top-mean-coordinator-engine.ts)
  owns enumeration, worker execution, replay, and the coordinator result.
- [`compact-pair-artifact.ts`](../lib/batch-backtest/compact-pair-artifact.ts)
  stores pair identity and compact trades, but no OHLCV or continuation state.
- [`sp500-top-mean-artifact-store.ts`](../lib/batch-backtest/sp500-top-mean-artifact-store.ts)
  provides atomic shard writes and `iterateRunCompactArtifacts(...)`.
- [`sp500-top-mean-worker.ts`](../lib/batch-backtest/sp500-top-mean-worker.ts)
  loads the full dataset and calls `executeBacktest(...)` for each pair.
- [`backtest-executor.ts`](../lib/backtest-executor.ts) and the `Strategy` type
  in [`lib/types/strategies.ts`](../lib/types/strategies.ts) expose a full-array
  execution model. There is currently no generic continuation/checkpoint API.
- [`batch-backtest-summary.ts`](../lib/batch-backtest/batch-backtest-summary.ts)
  already implements the intended current `TOP_MEAN NOW` vote semantics for
  ordinary Batch rows.
- Coordinator routes are local-only and run-id/path validated by
  `batch-backtest-vite-plugin.ts` and the artifact store. Those protections
  remain unchanged.

## Current snapshot semantics

The new reducer must match the existing Batch and replay conventions:

- open long pair: base `+1`, quote `-1`;
- open short pair: base `-1`, quote `+1`;
- `activePairs[asset]`: number of open pair legs containing the asset;
- candidate: `rawScore > 0` and `activePairs > 0`;
- selection key: `rawScore / activePairs`.

Return all exact winners. Do not apply an arbitrary asset-name tie-break. A tie
must be shown as a tie/abstention to the caller.

The result is as-of the latest common closed-candle timestamp represented by
the artifacts. It is not an intrabar signal.

## Assumptions and missing information

- The live universe is the canonical S&P 500 synthetic-pair list without
  orientation seeds.
- A final trade with `exitReason === "end_of_data"` represents an open position
  at that pair's data endpoint.
- The current artifact does not record an independent data-end timestamp.
  Phase 1 therefore adds a small optional `dataEndTime` field when the worker
  creates an artifact. Old artifacts without it remain readable but cannot
  prove a precise snapshot timestamp.
- The exact production strategy and settings are not provided. Phase 2 cannot
  be approved until adaptive exits, combined direction, confirmation filters,
  sizing, and Rust/TypeScript engine choice are tested for that configuration.

# Phase 1 — Artifact-based current snapshot

## Objective

Expose current TOP_MEAN from the completed compact artifacts and keep it
separate from the historical asset leaderboard.

## Scope

- Add one pure server-safe artifact reducer.
- Add `dataEndTime` as optional artifact metadata.
- Calculate the snapshot after worker completion from streamed artifacts.
- Add the snapshot to the existing coordinator result and UI.
- Preserve historical replay behavior and existing routes.
- Do not add a new service, database, or speculative current-only API.

## Technical tasks

1. Add `lib/batch-backtest/sp500-top-mean-current-snapshot.ts` with:

   - `CurrentTopMeanCandidate { asset, score, activePairs, mean }`;
   - `CurrentTopMeanSnapshot { asOf, artifacts, openPositions,
     candidates, winners, reason }`;
   - a reducer over `AsyncIterable<CompactPairArtifact>` or an equivalent
     existing adapter;
   - counters for skipped/invalid artifacts and stale endpoint timestamps.

2. In `sp500-top-mean-worker.ts`, write the last closed candle time into the
   artifact as optional `dataEndTime`. Keep the existing artifact reader
   backward-compatible with v1 artifacts that omit the field. Do not store
   candles or signals in the compact artifact.

3. In `TopMeanCoordinatorEngine.run()`, stream the completed artifacts through
   the reducer. Do not call the historical replay engine for this calculation.
   The historical replay remains a separate phase for the existing research
   output.

4. Use the most common `dataEndTime` as the snapshot endpoint. Exclude artifacts
   with a different endpoint from the current vote and report their count as
   stale. If there is no usable common endpoint, return no selection rather
   than mixing states from different dates.

5. Extend `TopMeanResultSummary` with optional `currentSnapshot`. Preserve all
   existing `horizons`, warnings, and report lines.

6. Persist the optional field through the existing coordinator result/status
   payload. The current implementation writes raw replay output to
   `result.json` while the streaming `done` event carries `TopMeanResultSummary`;
   add a focused test for this existing shape before changing it. Do not remove
   or rename existing serialized fields.

7. Update `renderTopMeanResults(...)`, `copySp500TopMeanResults()`, and the
   download payload in `batch-backtest-service.ts` to label the two outputs
   separately:

   ```text
   CURRENT TOP_MEAN | asOf=... | winners=... | mean=... | activePairs=...
   HISTORICAL TOP_MEAN | horizon=... | asset=... | events=...
   ```

   Reuse the existing results container and buttons; no new DOM id is needed.

8. Emit bounded progress/diagnostic data only: artifacts processed, open
   positions, positive candidates, stale endpoints, tie count, and duration.
   Do not emit one event per pair for the 124,000-pair universe.

## Dependencies

- Atomic shard files and the manifest must remain readable while reduction is
  running.
- The worker must use the same closed-candle endpoint for `dataEndTime` that
  `executeBacktest(...)` uses for the actual run.
- Existing result/status consumers must accept an optional field.

## Risks or blockers

- This phase does not make a fresh run cheap; it only avoids the historical
  replay cost and exposes the current state from the completed backtest.
- Missing or mixed endpoint timestamps can create a misleading cross-sectional
  ranking. The reducer must exclude stale artifacts and report the exclusion.
- No open positions means no positive candidate. Do not zero-fill missing
  positions.
- Balanced pair coverage can produce ties. Returning one asset silently would
  turn an unresolved decision into a false trade decision.

## Deliverables

- `lib/batch-backtest/sp500-top-mean-current-snapshot.ts`;
- optional `dataEndTime` artifact metadata and backward-compatible reading;
- `currentSnapshot` in coordinator results;
- current-vs-historical rendering, copy, and download output;
- focused reducer, coordinator, persistence, and UI contract tests.

## Validation and testing criteria

- Unit tests cover long/short signs, closed trades, `end_of_data`, active-pair
  counts, positive filtering, exact ties, empty input, malformed input, and
  mixed timestamps.
- Fixtures prove the reducer matches the existing Batch `TOP_MEAN NOW` output.
- Coordinator tests prove the snapshot comes from artifacts and is independent
  of historical horizon aggregation.
- Result/status tests prove the optional field survives completion and reattach.
- Run:

  ```text
  npm run typecheck
  ..\..\..\node_modules\.bin\esno tests\sp500-top-mean-current-snapshot.spec.ts
  ..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
  ..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
  ```

- A large-run smoke check confirms the reducer retains maps/counters only and
  does not load pair candles or signals.

## Exit criteria

- A completed coordinator run clearly shows current TOP_MEAN separately from
  historical `topAssets`.
- Current winners match existing Batch semantics on shared fixtures.
- Mixed/stale endpoints and ties are visible and cannot produce a silent pick.
- Existing historical output and route contracts remain unchanged.

## Rollback strategy

Disable the reducer call and optional rendering. Keep the optional artifact
field readable and leave existing historical artifacts and replay behavior
untouched. No migration or data deletion is required.

# Phase 2 — Incremental state refresh

## Objective

Avoid rerunning all pair histories on every refresh while preserving the exact
current-snapshot result of a full replay.

## Scope

- Prove continuation parity for the actual production strategy/configuration.
- Add continuation state only if exact parity is demonstrated.
- Persist state in the existing filesystem artifact/shard model.
- Keep full-history replay as the fallback.

## Technical tasks

1. Build a parity fixture using several historical cut dates. For each cut
   date, compare:

   - one full run through date `T`;
   - a run through `T-1` plus an incremental update through `T`.

   Compare final positions, trade direction, raw scores, active-pair counts,
   current winners, and endpoint timestamps.

2. Identify the minimum state required by the production configuration. This may
   include open positions, bars held, exit-learning state, sizing/risk state,
   indicator rolling state, confirmation state, and strategy-prepared state.
   Do not assume that a strategy lookback alone is sufficient.

3. If the engine cannot expose that state deterministically, do not ship an
   approximation as current TOP_MEAN. Keep using full replay and record the
   blocker. A bounded tail-window mode is allowed only as a separately labeled
   approximation after it has been measured against the full-history fixture.

4. If parity succeeds, add a narrowly scoped continuation input/output around
   the existing backtest engine. Avoid changing every strategy unless the
   production strategy requires it. The continuation must be versioned and
   include:

   - strategy key and normalized parameter fingerprint;
   - backtest/capital settings fingerprint;
   - interval and pair identity;
   - last processed closed-candle time;
   - open position and path-dependent engine state;
   - state schema and engine mode.

5. Decide Rust support explicitly. No Rust continuation contract exists today.
   Incremental mode must either support both engines with parity tests or use
   TypeScript explicitly and fall back to full replay when Rust is required.
   Never silently continue TypeScript state from a Rust run, or vice versa.

6. Store checkpoints in bounded shard-level files or optional artifact fields,
   written atomically with the existing artifact-store functions. Do not create
   one unbounded file per pair and do not add a database.

7. Add dataset freshness checks using the stored endpoint timestamp and the
   existing strategy/settings/universe fingerprint. Reject state when data is
   revised, has gaps, moves backward, or no longer matches the run contract.

8. Add an explicit incremental worker mode. Do not overload the current
   `resume` behavior, which skips completed shards. Incremental mode must load
   new candles, apply the checkpoint, and replace the shard atomically.

9. Preserve cancellation and failure behavior. A failed shard keeps its last
   valid checkpoint and is reported through the existing manifest counters.
   Unsupported or stale checkpoints fall back to full replay.

10. Feed both full and incremental outputs into the Phase 1 current snapshot
    reducer so the output contract remains identical.

## Dependencies

- The exact production strategy and settings profile.
- A deterministic continuation design for enabled exits, sizing,
  confirmations, and trade directions.
- Closed-candle and endpoint metadata from the server loader.
- A decision on Rust continuation support.
- Existing worker-pool retry, cancellation, manifest, and atomic-write paths.

## Risks or blockers

- `Strategy.execute(...)` is currently full-array based and does not serialize
  indicator or strategy state.
- Adaptive exits, learning exits, combined direction, smart sizing, and
  confirmation filters may make generic continuation unsafe.
- A warmup window can reproduce indicators while still losing prior position or
  risk state.
- 124,000 checkpoints can create substantial disk and serialization overhead.
- Revised or missing market data can invalidate an otherwise valid checkpoint.

## Deliverables

- Full-vs-incremental parity tests for the actual production configuration;
- a versioned continuation contract only if parity succeeds;
- incremental worker/coordinator support with full-replay fallback;
- endpoint/fingerprint invalidation;
- restart, cancellation, partial-shard, and stale-state handling;
- benchmark results for runtime, heap, artifact bytes, checkpoint bytes, and
  current-snapshot latency.

## Validation and testing criteria

- Multiple historical cut dates produce identical full and incremental current
  snapshots.
- Duplicate, missing, out-of-order, and revised candles are handled safely.
- Changing strategy, normalized parameters, settings, interval, or engine mode
  invalidates state.
- Restarting after completed shards does not duplicate or lose votes.
- Cancellation preserves the last valid checkpoint.
- Unsupported continuation visibly falls back to full replay.
- Run:

  ```text
  npm run typecheck
  ..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker.spec.ts
  ..\..\..\node_modules\.bin\esno tests\sp500-top-mean-worker-pool.spec.ts
  ..\..\..\node_modules\.bin\esno tests\sp500-top-mean-server-plugin.spec.ts
  ```

- Benchmark with fixtures, a few thousand pairs, and then a representative
  large run before attempting the full 124,000-pair universe. Record wall time,
  peak heap, checkpoint size, and snapshot latency.

## Exit criteria

- Incremental output matches full replay at several historical cut dates.
- Incremental refresh is materially faster without unbounded memory or disk
  growth.
- Stale or unsupported state cannot produce an unmarked current decision.
- Full replay remains a deterministic recovery path.

## Rollback strategy

Keep incremental mode opt-in. On any parity or freshness failure, invalidate the
checkpoint and run the existing full-history path. Keep old compact artifacts
readable and do not delete them during rollback.

