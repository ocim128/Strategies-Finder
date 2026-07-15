# Finder Server-Owned Universe Run

## Goal

Complete the existing server-side Finder Symbol Universe path so one server
job owns all selected strategies, result merging, optional OOS validation, and
terminal state. The browser remains the control and rendering layer and can
reattach after a tab reload.

This is an infrastructure change only. It must preserve current parameter
generation, strategy execution, filters, ranking, OOS verdicts, result display,
Apply behavior, Rust preference, and current-chart Finder behavior.

## Current state

- `FinderManager.runUniverseFinder(...)` sequences one
  `POST /api/finder/universe-run` request per selected strategy, merges the
  scalar survivors, then runs `applyUniverseOosValidationIfNeeded(...)` in the
  browser.
- `finder-vite-plugin.ts` already provides a single-owner lock, Stop,
  scalar-only NDJSON events, and an in-memory `/api/finder/status` snapshot.
- `/api/finder/status` currently recovers a truncated terminal stream for one
  strategy. Finder does not poll it to reattach after reload.
- `runFinderUniverseExecution(...)` is the shared evaluation core and must
  remain the only implementation of universe candidate evaluation.
- `server-finder-data-loader.ts` reuses the Batch dataset-loader core. This
  preserves the synthetic-pair pipeline, cache limits, and local-data behavior.
- Completed Finder results already persist through
  `playground_finder_latest_results`; this remains the browser-side completed
  snapshot and is separate from an active server job snapshot.

## Assumptions and non-goals

### Assumptions

- The Vite process is a single-user runtime. Only one Finder Universe job may
  run at a time.
- Selected entry strategies may execute sequentially. Parallel strategy
  execution is not required and would multiply retained dataset memory.
- Closing the initiating HTTP connection must not cancel the server job. Stop
  and ownership loss are the only user-driven cancellation paths.
- Reattachment only survives a browser reload or tab close while the same Vite
  process remains alive. A Vite restart loses the in-memory active job.
- The final candidate list and per-symbol OOS fields are scalar-only and are
  safe to retain in `runState` and return from `/status`.

### Non-goals

- No change to current-chart Finder.
- No new ranking, validation, search, or trading behavior.
- No Polymarket support in Symbol Universe.
- No database or persistent server schema.
- No Batch Mine artifacts, temporary artifact directory, or artifact TTL.
- No worker-thread or multi-process parallelism.
- No concurrent viewers or stream fan-out. Reattachment uses status polling.

## Architecture and module boundaries

### Browser boundary

`lib/finder-manager.ts` should:

- submit one request containing all selected entry strategy keys;
- consume live NDJSON progress and scalar candidate snapshots;
- render the server's authoritative merged results;
- poll `/api/finder/status` during reattachment;
- continue to own UI state, persisted completed results, Apply, Copy, and Stop.

It should no longer merge per-strategy server outcomes or load OHLCV data for
Universe OOS validation.

### Server orchestration boundary

`lib/finder/server/finder-vite-plugin.ts` should own the complete job lifecycle:

1. validate the request and resolve all selected strategies;
2. acquire one owner generation and create one job snapshot;
3. run each strategy sequentially through `runFinderUniverseExecution(...)`;
4. merge and sort candidates using `sortFinderUniverseCandidates(...)`;
5. run the existing OOS rules when enabled;
6. publish one authoritative terminal candidate slice and combined diagnostics;
7. retain the scalar terminal snapshot until the next run or Vite restart.

The plugin must not import `finder-manager.ts`, `data-manager.ts`,
`settings-manager.ts`, `ui-manager.ts`, or modules that pull
`lightweight-charts` into the Vite config bundle.

### OOS boundary

Extract the browser-bound Universe OOS loop from `FinderManager` into a leaf
module at `lib/finder/finder-universe-oos.ts`. It should accept all
runtime dependencies as arguments: candidates, resolved strategies, settings,
capital settings, interval, data loader, provider resolver, Rust preference,
cancellation callback, progress callback, and yield callback.

The extracted module should reuse:

- `executeBacktest(...)` and `resolveExecutorBacktestSettings(...)`;
- `computeUniverseSymbolOosVerdict(...)`;
- `computeUniverseOosAggregate(...)`;
- `updateFinderUniverseCandidateScores(...)`;
- `resolveFinderRiskOverrides(...)` and exit-strategy param splitting.

It must not read browser DOM, `state`, `backtestService`, or `dataManager`.

## Target data flow

```text
FinderManager
  POST /api/finder/universe-run
    { runId, strategyKeys[], symbols, interval, options, settings, capitalSettings,
      exitStrategyKeys?, providerBySymbol, useRustEnginePreference }
        |
        v
finder-vite-plugin
  validate runId -> resolve strategies -> acquire owner -> initialize job snapshot
        |
        v
for each strategy, sequentially
  runFinderUniverseExecution -> replace current bounded survivors -> snapshot
        |
        v
optional server-side Universe OOS
  load complementary data -> executeBacktest -> attach scalar OOS metrics
        |
        v
sort + topN -> done event + terminal status snapshot
        |
        v
FinderManager renders and persists completed scalar results

Reload during run:
FinderManager init -> read active runId -> GET /api/finder/status?runId=...
  -> restore progress -> poll bounded status until terminal -> adopt final candidates
```

## API and contracts

### `POST /api/finder/universe-run`

Replace the single `strategyKey` request field with `strategyKeys: string[]`
and require a browser-generated `runId`. Persist the run ID before starting the
request so a reload can identify the same job even if the initiating stream was
not consumed. Validate its type and bounded length before acquiring ownership.
The browser and server are deployed from the same repository, so no permanent
dual request format is required. Request validation must reject an empty list,
duplicates after normalization, unknown keys, and non-string entries with a
400 response before acquiring ownership.

The endpoint remains an NDJSON stream. Extend `FinderStreamEvent` only where
needed:

- `start`: echo the run ID and include total strategy count and ordered keys;
- `progress`: include the current phase and strategy index/count so browser and
  status rendering use the same information;
- `candidate`: candidates are merged job-level survivors, not per-request
  survivors;
- `done`: remains authoritative and includes combined totals, final candidates,
  diagnostics, and OOS removed count;
- `fatal`: remains terminal.

Every streamed and snapshotted candidate must pass
`toScalarCandidate(...)` and `assertCandidateIsScalar(...)`.

### `GET /api/finder/status`

Define a named, shared response type in `finder-stream-types.ts` rather than
using an untyped object in the client. Query status with the active run ID. A
different run ID returns 404 and must never be adopted. A request without a run
ID may retain the existing ad-hoc introspection response, but the browser must
not use that unscoped form for reattachment.
The in-progress snapshot should contain:

- `running`, `runId`, `startedAt`, and phase;
- interval, ordered strategy keys, current strategy index/count;
- total symbols, progress percent, and status text;
- current candidate count, but not the full candidate payload;
- loaded/failed symbol totals available so far;
- cancellation state.

The matching terminal snapshot additionally contains the summary, diagnostics,
totals, completion time, and authoritative final candidates. Reattach polling
therefore remains small while a large universe is running and transfers the
per-symbol candidate payload once, at completion.

The terminal candidate slice is authoritative. An in-progress snapshot is
provisional and must never be persisted as a completed Finder result.

### `POST /api/finder/stop`

Keep the current endpoint and owner-generation cancellation, but require the
run ID in the request body. A mismatched run ID must not stop the active job.
Stop must abort an in-flight data load, make all strategy and OOS loops observe
lost ownership, mark the matching snapshot cancelled, and prevent late writes
from changing the final browser state.

Use one module-scoped `pendingStopRunId: string | null` when Stop arrives before
that run acquires ownership. The matching run request consumes the marker and
finishes cancelled instead of starting heavy work. This closes the
Stop-before-ownership race without retaining an unbounded cancellation set.

## State, failure handling, and observability

- Expand `FinderRunSnapshot` to represent the complete multi-strategy job and
  retain the latest phase/progress/status, totals, candidates, diagnostics, and
  terminal outcome.
- Persist the browser-generated active run ID in a small versioned
  `persisted-json` record (`playground_finder_active_server_run`, schema
  `finder.active_server_run`, version 1) before `fetch`. Clear it only after a
  matching terminal response, explicit Stop, or a confirmed missing server job.
  The client must ignore stream or poll updates whose run ID differs.
- Update the snapshot before emitting the corresponding stream event so
  `/status` never lags an event already shown by the browser.
- Separate snapshot mutation from response writing. A guarded emitter must
  stop writing after the response closes without throwing into the job loop;
  the active job promise continues updating `runState` until Stop, ownership
  loss, fatal failure, or completion.
- A thrown strategy-level orchestration error terminates the job, matching the
  current behavior where a failed per-strategy request aborts the browser loop.
  Per-symbol load/run failures remain ordinary candidate diagnostics.
- If OOS loading or execution fails for one symbol, preserve current behavior:
  mark that symbol OOS result inconclusive and continue.
- Log job start, phase changes, strategy completion/failure, OOS completion,
  cancellation, reattach, terminal completion, and stream-write loss through
  `debugLogger`. Include run ID, strategy counts, symbol counts, elapsed time,
  and candidate counts; do not log full datasets or parameter arrays.

No authentication or secret handling changes are required. The endpoints
remain local Vite runtime surfaces. Existing request-size limits, loopback
origin handling, heap guard, and provider-map validation remain mandatory.

## Performance requirements

- Keep strategy evaluation sequential.
- Preserve bounded top-K survivor storage. Incremental runner updates contain
  the current survivor set; replace that strategy's prior set and recompute the
  merged topN. Do not append every candidate ever observed, because candidates
  later evicted from top-K would otherwise remain in `runState`.
- Keep OHLCV, signals, trades, and equity curves server-side.
- Run OOS with `omitEquityCurve`, skipped advanced analytics, and the current
  lightweight result options.
- Load complementary OOS datasets through `loadServerFinderDataset(...)` and
  slice at the caller. Do not fork the Batch/Finder loader core.
- Measure whether raw datasets can be safely reused between IS and OOS. Until
  proven, prefer the existing bounded loader cache and per-symbol OOS loading
  over adding an unbounded full-universe retention structure.
- Preserve the documented Node heap guard and 16 GB recommendation for large
  universes.
- Keep `/status` polls free of per-symbol candidate arrays while running. The
  terminal response may contain at most the final topN candidate payload.

## Implementation phases

### Phase 1: Lock the job-level wire and snapshot contracts

**Objective**

Define the complete multi-strategy request, event, and status shapes before
moving execution ownership.

**Scope**

`lib/finder/server/finder-stream-types.ts`, request parsing in
`lib/finder/server/finder-vite-plugin.ts`, and focused server-plugin tests.

**Technical tasks**

- Add named job phase and status snapshot types.
- Change the request parser to accept and validate ordered `strategyKeys`.
- Add the required `runId`, strategy progress, phase, and current totals to
  stream/status contracts.
- Keep in-progress status payloads summary-only and terminal status candidates
  authoritative.
- Keep scalar assertions on incremental, terminal, and status candidates.
- Update test fixtures without changing execution behavior yet.

**Dependencies**

- Existing `FinderStreamEvent`, `FinderRunSnapshot`, request limits, and
  strategy registry loading.

**Risks or blockers**

- Contract drift between NDJSON events and `/status` could produce different UI
  states after reattach.
- Loading a large invalid strategy list must fail before the owner lock is set.

**Deliverables**

- Typed request/event/status contracts and parser tests.

**Validation and testing criteria**

- Typecheck production and tests.
- Tests reject empty, duplicate, malformed, and unknown strategy keys.
- Tests reject malformed/oversized run IDs and mismatched status run IDs.
- Tests prove forbidden arrays cannot enter events or snapshots.

**Exit criteria**

- The server and browser can compile against one unambiguous job-level
  contract, with no execution behavior change.

### Phase 2: Move multi-strategy orchestration to the server

**Objective**

Make one server owner execute and merge all selected strategies.

**Scope**

`lib/finder/server/finder-vite-plugin.ts`,
`lib/finder/finder-universe-metrics.ts`, and server-plugin/universe-runner tests.

**Technical tasks**

- Resolve all selected strategies before starting the stream.
- Add a job-level orchestration loop around the unchanged
  `runFinderUniverseExecution(...)` core.
- Scale progress across strategies and expose the active strategy in status.
- Merge candidates by the existing strategy/params/exit identity.
- Replace the active strategy's prior incremental survivor set, then sort with
  `sortFinderUniverseCandidates(...)` and bound the merged snapshot to topN.
- Combine diagnostics using a server-safe leaf helper. Do not import
  `FinderManager`; extract only the existing deterministic combination logic if
  it cannot be reused directly.
- Build `providerBySymbol` for every universe symbol and every cross-symbol
  secondary required by any selected entry strategy or exit-strategy
  candidate.
- Guard response writes so disconnecting the initiating stream does not reject
  the active job promise or release ownership.
- Preserve Rust preference, exit-strategy sampling, provider mapping, data
  slicing, early stops, and cancellation.

**Dependencies**

- Phase 1 contracts.
- Existing universe runner and scalar candidate ranker.

**Risks or blockers**

- The current `processFinderUniverseRun(...)` initializes per-strategy global
  state; orchestration must prevent later strategies from overwriting the job
  snapshot.
- Combined diagnostics must preserve per-strategy failures and accurate totals.

**Deliverables**

- One server request executes all selected strategies sequentially and returns
  the same merged IS survivors as the current browser sequence for a fixed
  seed and fixtures.

**Validation and testing criteria**

- Structural parity test compares old sequential merge semantics with the new
  server job for multiple strategies.
- Stop during a later strategy prevents remaining strategies from starting.
- Stop is scoped by run ID, and Stop-before-ownership prevents the matching
  request from beginning evaluation.
- A stale tab cannot stop a newer run with a different run ID.
- Disconnecting the NDJSON response does not stop execution; status reaches a
  terminal snapshot.
- A candidate evicted from a later top-K update does not remain in `runState`.
- A second run receives 409 while the job is active.
- Rust preference and provider-map tests continue to pass.

**Exit criteria**

- Browser-side per-strategy sequencing is no longer required for correct IS
  results.

### Phase 3: Move existing Universe OOS execution to the server

**Objective**

Keep the current OOS behavior while removing browser OHLCV loading and
backtesting from Symbol Universe Finder.

**Scope**

New leaf module `lib/finder/finder-universe-oos.ts`,
`lib/finder/server/finder-vite-plugin.ts`, `lib/finder-manager.ts`, and focused
OOS tests.

**Technical tasks**

- Extract the current per-symbol OOS loop and its backtest-to-universe-metrics
  conversion from `FinderManager`.
- Keep separate injected loaders for IS and raw data. Apply the IS slice only in
  the IS wrapper; apply `resolveOosDataSlice(...)` and
  `sliceFinderDataWindow(...)` exactly once in the OOS wrapper.
- Resolve entry and exit strategies once and preserve risk-override and
  cross-symbol execution semantics.
- Attach per-symbol `oosResult`/`oosVerdict`, compute `oosAggregate`, update
  existing scores, remove aggregate failures, re-sort, and slice to topN.
- Publish OOS phase progress and `oosRemoved` in the authoritative snapshot.
- Remove the browser invocation only after server/browser parity is locked.

**Dependencies**

- Phase 2 server orchestration.
- Existing OOS metric functions and `executeBacktest(...)` Node compatibility.

**Risks or blockers**

- Importing a browser-bound dependency into the Vite plugin transitively causes
  the `lightweight-charts` ESM/CJS bundle failure.
- Cross-symbol OOS must use the same provider map and secondary-data loader as
  IS.
- Reloading complementary data can increase server cache pressure; no new
  unbounded cache is allowed.

**Deliverables**

- Server-owned OOS with scalar final results and no Universe OOS data loaded by
  the browser.

**Validation and testing criteria**

- Fixture parity covers pass, fail, inconclusive, load failure, execution
  failure, exit override, and cancellation.
- Final sorting, `windowStabilityScore`, and OOS removed counts match the
  current browser implementation.
- Server loader parity and import-hygiene tests pass.

**Exit criteria**

- The server's `done.candidates` is the complete authoritative Universe output,
  including OOS fields when enabled.

### Phase 4: Add browser reattachment and ownership guards

**Objective**

Allow Finder to recover an active or completed server job after reload without
duplicating or restarting work.

**Scope**

`lib/finder-manager.ts`, the existing persisted-JSON seam, and Finder
manager/server integration tests. Finder remains lazy-loaded; global bootstrap
does not change.

**Technical tasks**

- Replace per-strategy requests with one job request.
- Generate and persist the active run ID before `fetch`, and use it as the token
  guard so stale stream and poll callbacks cannot mutate newer Finder state.
- On Finder initialization, query `/api/finder/status`. If running, restore
  progress and Stop state, then poll summary-only status at a bounded interval
  following Batch's reattach pattern. Existing rendered/persisted results stay
  visible until the new run completes.
- On terminal status, adopt final candidates and diagnostics, render, persist
  through the existing Finder result snapshot, clear the matching active-run
  record, and stop polling.
- Treat transient status errors as connection interruption, keep the last good
  view, and use bounded retry/backoff. Do not report completion without a
  terminal snapshot.
- Ensure Run and Stop cancel any stale reattach polling before changing UI
  ownership.
- Keep current-chart Finder unaffected and do not let a Universe status
  snapshot overwrite current-chart results unless the active/restored scope is
  Symbol Universe.

**Dependencies**

- Phases 1-3 authoritative status snapshot.
- Existing Finder lazy initialization and completed-result persistence.

**Risks or blockers**

- Finder is lazy-loaded, so reattachment begins when Finder initializes. This
  avoids adding Finder work to global startup.
- A completed `lastRun` is adopted only when it matches the locally persisted
  active run ID. An unrelated prior server snapshot is ignored.
- Stream completion and the first poll may race; run ID guards must make both
  idempotent.

**Deliverables**

- Reload-safe progress, results, diagnostics, and Stop for Symbol Universe.

**Validation and testing criteria**

- Reload simulation during strategy evaluation and OOS restores progress for
  the same run, then receives final candidates once.
- Poll responses during an active run contain no candidate symbol arrays.
- Reload after completion restores authoritative candidates once.
- Stop after reattach cancels server work and leaves no active poll.
- Starting a new run cannot receive late updates from the prior stream/status.
- Current-chart Finder behavior and persisted results remain unchanged.

**Exit criteria**

- A 400-symbol multi-strategy run can survive tab reload and complete without
  browser-side evaluation.

### Phase 5: Documentation, observability, and release validation

**Objective**

Lock operational expectations and verify memory-bounded behavior end to end.

**Scope**

`docs/finder-server-side.md`, `README.md` if its runtime summary changes,
`AGENTS.md` Finder validation notes, diagnostics tests, and manual smoke checks.

**Technical tasks**

- Update the runtime contract from per-strategy requests/browser OOS/no
  reattach to one server-owned job/server OOS/reattach.
- Document that reattachment depends on the same Vite process and that
  static-only deployment remains unsupported.
- Add phase and reattach events to compact diagnostics or server logs only
  where they help diagnose runtime failures.
- Measure status response size, browser heap, Node peak heap, and elapsed time
  against the current implementation for 50 and 400 symbols.
- Confirm no disk artifacts remain after completion and no dataset lifetime is
  extended beyond existing bounded caches.

**Dependencies**

- Phases 1-4.

**Risks or blockers**

- Moving OOS to Node may shift, not eliminate, memory pressure. Heap and cache
  measurements are required before claiming improvement.
- Dev-server restart remains a hard terminal loss and must be reported clearly.

**Deliverables**

- Updated operational documentation, diagnostics, and benchmark notes.

**Validation and testing criteria**

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-metrics.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-manager-logic.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual: one and multiple strategies over 50 symbols; confirm progress,
  sorting, diagnostics, OOS, Stop, reload reattach, and Apply.
- Manual with `NODE_OPTIONS=--max-old-space-size=16384`: 400 symbols; record
  browser/Node heap, reload during IS and OOS, and verify final result parity.

**Exit criteria**

- All automated checks pass without skips, manual reattach works in both IS and
  OOS phases, scalar-wire assertions remain active, and documentation matches
  the shipped lifecycle.

## Affected files

Expected changes are limited to:

- `lib/finder-manager.ts`
- `lib/finder/server/finder-vite-plugin.ts`
- `lib/finder/server/finder-stream-types.ts`
- `lib/finder/finder-universe-oos.ts` (new leaf module)
- `lib/finder/finder-universe-metrics.ts` only if a server-safe existing helper
  must be exposed
- `tests/finder-server-plugin.spec.ts`
- `tests/finder-server-loader-parity.spec.ts`
- `tests/finder-universe-runner.spec.ts`
- a focused new OOS or reattach spec if the existing specs cannot express those
  boundaries cleanly
- `docs/finder-server-side.md`
- `README.md` and `AGENTS.md` only where their runtime contract becomes stale

`html-partials/tab-finder.html` and Finder DOM contracts should not change;
this proposal does not add UI controls.

## Rollback strategy

Implement phases behind the existing `/api/finder/universe-run` boundary and
keep each phase behaviorally parity-tested. If reattachment is unstable, the
client polling portion can be reverted while retaining one server-owned job;
the initiating NDJSON stream still completes normally. If server-side OOS has
parity or memory regressions, restore the browser OOS call and keep the
multi-strategy server orchestration until the leaf OOS module is corrected.

Do not maintain permanent duplicate execution paths. After validation, remove
the superseded browser orchestration/OOS code so there is one owner for each
stage.
