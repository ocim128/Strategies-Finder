# OPEN_SCORE USD Replay

## Goal

Add a Batch analysis feature that answers the exact research question:

> At historical synthetic-pair decision events, did selecting the asset with
> the highest positive `OPEN_SCORE` and trading that asset versus USD beat
> selecting another positive-score asset at random?

The feature is research-only. It is launched from the Batch tab, executes in
the existing Vite/Node server, and returns aggregate scalar results to the
browser over NDJSON. It does not place orders, change the Batch result, or
release the retained Batch artifacts.

### Scope boundary

V1 is an event-level selector study using equal-notional, fixed-horizon USD
trades. It answers whether the top-score choice has better conditional return
than another positive candidate at the same decision event. It does not claim
to reproduce a live portfolio's overlapping positions, adaptive exits, or
capital compounding. Those behaviors require the separate stateful phase
defined below and must not be inferred from the v1 report.

## Decisions and assumptions

- The primary treatment is the current raw score: `positiveVotes - negativeVotes`.
- A secondary, predeclared diagnostic is `rawScore / sqrt(activePairCount)`.
  It is coverage-adjusted, not a statistically calibrated z-score.
- A positive score represents a long USD trade. Negative scores are not part
  of this research question.
- A decision event occurs when at least one synthetic pair opens. The score is
  updated with all entries and exits at that timestamp before candidates are
  formed. Exit-only score changes do not create a new signal event.
- The USD entry is the first target-asset bar strictly after the decision
  timestamp, filled at that bar's open. This is a conservative causal rule and
  avoids reusing a price that helped form the score. A fixture must prove that
  same-timestamp exits/entries cannot leak a later target bar's price.
- The default outcome is equal-notional forward USD return for configured
  horizons. The feature applies the Batch slippage and commission settings but
  does not reuse synthetic-pair exits on the USD instrument.
- “Random” means the uniform expected return of the other positive candidates
  at the same event, excluding the treatment asset. Events with fewer than two
  positive candidates are excluded from the top-vs-random comparison.
- The pair universe does **not** need equal pair counts per asset. The report
  must expose static pair degree and active pair count so raw-score coverage
  bias is visible. A balanced-pair sensitivity run is optional research, not a
  prerequisite for the primary answer.
- A stateful one-slot replay, with actual repeated entry/exit and random seeds,
  is a separate gated phase. It must not be conflated with the v1 event-level
  selector test or allowed to change the v1 pass/fail result.

## Unknowns to resolve before implementation

1. The initial UI must require one or more positive bar horizons. It must not
   silently borrow a Mine Prediction horizon or a synthetic-pair exit overlay.
2. Confirm whether every positive asset is tradable or whether the UI should
   restrict candidates to the base leg. The plan assumes both base and quote
   assets are eligible because `OPEN_SCORE` already records both legs.
3. Verify that the marked stock datasets (`NVDA•`, `KO•`, etc.) are adjusted
   consistently for splits and corporate actions. The report must warn when
   the source data cannot establish this; it must not silently winsorize
   extreme returns.
4. Confirm the intended date window. Full history is the default, with optional
   From/To filters for a predeclared development window and a locked final
   holdout.

## Existing architecture to reuse

### Browser boundary

- `html-partials/tab-batch-backtest.html` is the source of truth for the new
  analysis button, controls, and summary panel.
- `lib/batch-backtest/batch-backtest-dom.ts` owns the required DOM-id contract.
- `lib/batch-backtest/batch-backtest-service.ts` owns button lifecycle, Stop,
  `postBatchNdjson`, progress rendering, and Copy behavior.
- `tests/batch-backtest-service-lifecycle.browser.spec.ts` supplies the fake DOM
  and locks analysis-button enable/disable behavior.

### Server boundary

- `lib/batch-backtest/batch-backtest-vite-plugin.ts` owns the analysis owner
  generation, AbortController, artifact fingerprint gate, artifact TTL pause,
  route registration, and server-side target loading.
- `createDisconnectSafeStream` in `lib/vite-http-utils.ts` must wrap the
  response. Disconnect cancels this analysis because its streamed result is not
  recoverable; Stop remains the explicit user cancellation path.
- `isAllowedLocalRequest` in `lib/local-route-authorization.ts` must protect the
  new route exactly like existing Batch analysis routes.
- `ArtifactStore` / `StoredMineArtifactMeta` in the plugin are the only source
  for retained Batch artifacts. New code must load artifacts one at a time and
  release each reference before loading the next.

### Data and execution boundary

- `BatchSyntheticPairArtifact.result.trades` provides the historical open/exit
  intervals needed to reconstruct score deltas.
- `baseAsset`, `quoteAsset`, `baseSymbol`, and `quoteSymbol` provide both the
  normalized asset names and provider-routing hints for marked local stocks.
- `loadServerBatchDataset` and the existing target-symbol resolution in
  `batch-backtest-vite-plugin.ts` must be reused. Do not import browser-bound
  `dataManager`, `finder-manager`, `settings-manager`, or `chart-manager` into
  the Vite config bundle.
- Reuse `timeKey`/`timeToNumber` and `applySlippage` conventions. Do not add an
  ad hoc time conversion or a second slippage interpretation.

## Proposed files

### New files

| File | Purpose |
|---|---|
| `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` | Pure, server-safe score-event reconstruction, USD outcome evaluation, and aggregate statistics. No DOM or `lightweight-charts`. |
| `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts` | NDJSON request/result event union used by the server and browser. |
| `tests/batch-open-score-usd-replay-engine.spec.ts` | Known-answer tests for score signs, timing, candidate selection, degree adjustment, and USD returns. |

### Modified files

| File | Change |
|---|---|
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | Add the read-only process function, bounded target-asset iteration, local-only route, progress phases, cancellation, logging, and TTL handling. |
| `lib/batch-backtest/batch-backtest-service.ts` | Add UI request/stream handling, status text, Copy report, Stop integration, and lifecycle restoration. |
| `lib/batch-backtest/batch-backtest-dom.ts` | Register new structural IDs. |
| `html-partials/tab-batch-backtest.html` | Add the feature button, date/horizon controls, and multiline report panel. |
| `tests/batch-backtest-server-plugin.spec.ts` | Route authorization, artifact retention, stream ordering, cancellation, and bounded loading tests. |
| `tests/batch-backtest-service-lifecycle.browser.spec.ts` | Fake DOM and analysis-button lifecycle coverage. |
| `tests/feature-dom-contracts.spec.ts` | No direct edit expected; it must pass with the new partial/contract IDs. |

No database, Worker, localStorage, strategy manifest, or Batch runner change
is required.

## Data flow

```text
Batch Run
  -> disk-backed ArtifactStore (existing fingerprint/TTL contract)
  -> POST /api/batch-backtest/open-score-usd
  -> sequential pair-artifact scan
       trade entry/exit -> compact per-asset score deltas
  -> sorted event sweep
       raw score, active pair count, candidate set, top raw/adjusted asset
  -> bounded target-asset loads (one target processed then released)
       next-bar-open -> horizon-close USD returns
  -> per-event top-vs-other-positive comparison
  -> chronological block statistics + report lines
  -> NDJSON done event -> Batch summary/Copy panel
```

## API and result contracts

### Request

`POST /api/batch-backtest/open-score-usd`

```ts
{
  fingerprint: string;
  interval: string;
  sampleFrom?: string;  // optional ISO/YYYY-MM-DD date
  sampleTo?: string;
  horizons: number[];   // positive bar counts; required in v1
}
```

The server rejects missing/stale fingerprints, missing artifacts, an active
Batch run, or another active analysis with the same 400/409 behavior as the
existing analysis endpoints.

### NDJSON events

The event contract must make long CPU phases visible:

```ts
type OpenScoreUsdReplayStreamEvent =
  | { type: "start"; pairs: number; assets: number; horizons: number[] }
  | {
      type: "phase";
      phase: "scan" | "events" | "targets" | "outcomes" | "aggregate";
      detail: string;
      completed: number;
      total: number;
      elapsedMs: number;
    }
  | {
      type: "progress";
      phase: string;
      detail: string;
      completed: number;
      total: number;
      elapsedMs: number;
      events?: number;
      omitted?: number;
    }
  | { type: "done"; ok: true; result: OpenScoreUsdReplayResult }
  | { type: "done"; ok: false; cancelled: true; summary: string }
  | { type: "fatal"; error: string };
```

`progress` must be emitted at least every two seconds during a non-trivial
phase and after every bounded work chunk. The browser must update both the
feature summary and the shared Batch progress bar with the phase and current
asset/pair, not only a percentage.

### Result shape

The result remains scalar and bounded for the browser:

```ts
interface OpenScoreUsdReplayResult {
  pairs: number;
  assets: number;
  complete: boolean;
  omittedPairs: number;
  omittedAssets: number;
  totalEvents: number;
  eligibleEvents: number;
  horizons: Array<{
    bars: number;
    topRaw: ReplayComparison;
    topAdjusted: ReplayComparison;
    candidateDegree: DegreeSummary;
  }>;
  degree: DegreeSummary;
  warnings: string[];
  reportLines: string[];
}
```

Do not send event-level candidate arrays or target OHLCV over the wire. Keep
only aggregate counts, deltas, confidence intervals, degree summaries, and a
bounded top-assets table if needed for the report.

## Score-event algorithm

### Phase 1: scan artifacts

1. Collect metadata and compute static pair degree per asset before any heavy
   artifact load.
2. Load one stored artifact at a time. Use a bounded timeout and count failures
   instead of retaining all decoded artifacts.
3. For every actual trade interval, emit compact score deltas:
   - long pair: base `+1`, quote `-1` at entry; inverse deltas at exit;
   - short pair: base `-1`, quote `+1` at entry; inverse deltas at exit.
4. Mark whether the timestamp contains at least one pair entry. Do not create
   decision events from exits alone.
5. Sort deltas by normalized timestamp and asset index, then sweep once. At a
   timestamp, apply all deltas before forming the candidate set.

The engine should use flat numeric records or typed arrays after benchmarking;
an object per trade must not be retained if a very large run demonstrates
avoidable heap growth.

### Phase 2: form candidates

For each eligible entry event:

- `rawScore[a] = signed active-pair vote total`;
- `activePairCount[a] = active positive + active negative votes`;
- `adjustedScore[a] = rawScore[a] / sqrt(activePairCount[a])` when the count is
  positive;
- positive candidates are assets with `rawScore > 0`;
- `topRaw` is the highest raw score, with deterministic asset-name tie-break;
- `topAdjusted` is the highest adjusted score, with the same tie-break;
- the random control is the mean of all other positive candidates.

An event is eligible for a comparison only when it has at least two positive
candidates and every candidate has valid target data for the requested
horizon. If the raw or adjusted winner has missing data, omit the event from
both treatment and control; do not substitute a different winner after seeing
data availability. The result must report all skipped-event reasons.

### Phase 3: evaluate USD outcomes

Build a per-asset list of requested event IDs, then load each unique target
dataset with bounded concurrency. Process the target and release its OHLCV
reference before moving on; do not call the existing `loadMinerTargets` in a
way that retains every target dataset simultaneously.

For each requested event/horizon:

- locate the first target bar strictly after the decision timestamp;
- fill a long USD trade at that bar's open;
- close at the configured horizon's close;
- apply the existing slippage direction and round-trip commission convention;
- accumulate the selected asset's return and the random-control sum/count.

Right-censored events near the target dataset end are excluded before metric
aggregation. A missing target dataset is counted and surfaced as incomplete;
it must never silently become a zero return or cause the candidate ranking to
be recomputed.

### Phase 4: statistics

For each horizon and treatment:

- event count and coverage;
- mean/median net USD return;
- top-minus-random delta;
- chronological block means;
- deterministic block-bootstrap confidence interval;
- positive-block count;
- selected-asset concentration and static/active pair-degree summary.

The report must label `TOP_RAW` and `TOP_ADJUSTED` separately. It must not
choose whichever score looks better after seeing the result.

## Pair-list balance policy

Equal pair counts are not required for the primary test. The primary raw-score
arm must use the actual user-provided pair list so the report answers the real
workflow.

The report must include:

- minimum/median/maximum static pair degree;
- minimum/median/maximum active pair count at decision events;
- the share of selected events attributable to the most-covered assets;
- raw versus coverage-adjusted results.

Sixty NVDA pairs are not sixty independent votes: they share NVDA and may be
highly correlated. Equalizing counts would discard data without fixing that
dependence. A later sensitivity run may create deterministic degree-capped
pair subsets, but it is not part of v1 and must not replace the actual-universe
result.

## Implementation phases

### Phase 0: lock semantics and build fixtures

**Objective**

Freeze the decision timing, eligible-leg rule, horizons, fee convention, and
pair-degree reporting before running historical results.

**Scope**

Pure test fixtures and a short contract section in the new engine/stream types.

**Technical tasks**

- Define event timestamp ordering and next-bar-open lookup.
- Define raw/adjusted score tie handling.
- Define “other positive candidate” and right-censoring rules.
- Confirm marked-symbol target resolution with local-stock fixtures.
- Add synthetic artifacts with known long/short entries, exits, ties, and
  unequal asset degrees.

**Dependencies**

Existing `BatchSyntheticPairArtifact`, `timeKey`, and target OHLCV types.

**Risks or blockers**

The actual desired USD exit horizon is currently unspecified. Do not silently
reuse a synthetic-pair exit overlay; resolve the horizon input before Phase 2.

**Deliverables**

Engine option/result types and deterministic fixtures in
`tests/batch-open-score-usd-replay-engine.spec.ts`.

**Validation and testing criteria**

- Long and short sign mapping matches `computeOpenTradeAssetScores` tests.
- Entry and exit deltas produce the expected score at each timestamp.
- Same-timestamp pair exits and entries produce the post-execution score, and
  USD return lookup starts on the following target bar.
- Same-score ties choose the same asset every run.
- Events with one positive candidate are omitted from top-vs-random counts.

**Exit criteria**

The event contract is documented and known-answer tests pass.

### Phase 1: pure score-event engine

**Objective**

Reconstruct historical OPEN_SCORE events from artifacts without loading the
full pair universe into memory.

**Scope**

`lib/batch-backtest/batch-open-score-usd-replay-engine.ts` artifact iterator,
delta sweep, candidate formation, degree metrics, and cooperative progress.

**Technical tasks**

- Accept an async artifact iterator rather than an artifact array.
- Process one artifact, extract compact trade deltas, and release it.
- Store each pair's compact entry/exit delta stream in timestamp order, then
  k-way merge those streams with a binary min-heap. At a timestamp, apply all
  deltas before forming the candidate set. This avoids one unbounded object
  `Array.sort` blocking the Node event loop for a large pair list.
- Expose phase/progress callbacks and `shouldStop`.
- Keep all intermediate structures scalar and bounded by trades/events, not
  OHLCV dataset retention.

**Dependencies**

Phase 0; existing disk ArtifactStore and miner ownership callback.

**Risks or blockers**

The k-way merge still performs substantial synchronous work. Yield after a
bounded number of heap pops and emit phase progress; do not emit progress from
a synchronous loop without yielding. Retained streams should use flat numeric
records or typed arrays, not one object per trade.

**Deliverables**

Pure engine implementation and engine unit tests.

**Validation and testing criteria**

- Sequential loader is respected; no `Promise.all` over artifacts.
- Cancellation stops before the next load and during event sweep.
- A fixture with `A+B` and `A+C` produces the expected shared-asset score.
- Unequal pair degree appears in the result but does not alter raw-score math.

**Exit criteria**

The engine produces deterministic event/candidate counts and remains responsive
under a synthetic large-delta fixture.

### Phase 2: USD outcome evaluator and statistics

**Objective**

Convert candidate events into real target-asset/USD forward returns and compute
top-versus-random comparisons.

**Scope**

Target-asset callback boundary, fixed-horizon return evaluator, coverage
accounting, block statistics, and report construction.

**Technical tasks**

- Use marked target symbols from artifact metadata.
- Process target datasets one at a time or with a measured bounded concurrency;
  release each dataset after all event requests for that asset are consumed.
- Reuse existing slippage and commission conventions.
- Compute exact per-event random means rather than simulating random choices in
  the event-level report.
- Add deterministic chronological block bootstrap and per-horizon summaries.
- Distinguish `complete`, omitted pairs/assets, censored events, and no-data
  events in the result.

**Dependencies**

Phase 1; `loadServerBatchDataset`; existing target symbol routing; last-run
interval and capital/backtest settings retained by the plugin.

**Risks or blockers**

- Raw stock data may contain split/corporate-action discontinuities.
- Target calendars may not align with synthetic-pair timestamps.
- Advanced sizing modes are not appropriate for an isolated selector test;
  v1 must report equal-notional returns or explicitly reject unsupported sizing
  inputs rather than silently emulate them.

**Deliverables**

`OpenScoreUsdReplayResult`, report lines, and outcome/statistics tests.

**Validation and testing criteria**

- Known candles produce expected next-open/horizon-close returns.
- Commission and slippage change both treatment and control identically.
- End-of-data events are omitted, not assigned zero.
- A synthetic event where the top asset wins beats the expected random mean by
  the known amount.

**Exit criteria**

The pure engine can answer the research question from injected artifacts and
target data without browser or server globals.

### Phase 3: server-side process, route, and observability

**Objective**

Run the evaluator only through the UI-facing Vite server with visible progress,
safe cancellation, and high-pair-count memory behavior.

**Scope**

`batch-backtest-vite-plugin.ts`, stream types, route registration, logging, and
artifact/target orchestration.

**Technical tasks**

- Add `processOpenScoreUsdReplay(...)` beside the existing read-only analysis
  process functions.
- Gate on `hasStoredMineArtifacts`, `lastRunFingerprint`, and the shared miner
  owner. Clear/schedule the artifact TTL around the process.
- Wrap the response with `createDisconnectSafeStream` and cancel on disconnect.
- Register `POST /api/batch-backtest/open-score-usd` with 405 and
  `isAllowedLocalRequest` checks.
- Emit `start`, phase transitions, progress at least every two seconds, and a
  terminal done/fatal event.
- Yield with `setImmediate` after every bounded artifact/event/asset chunk so
  progress writes and Stop can be observed.
- Log only phase boundaries and aggregate counters through `debugLogger`:
  `batch.server.open_score_usd.start`, `.phase`, `.complete`, `.cancel`, and
  `.fatal`. Do not log every event.
- Record pair/asset omissions, elapsed time, peak phase counters, and target
  load/cache counts in the final diagnostic summary.

**Dependencies**

Phases 1 and 2; existing `minerOwner`, `minerAbortController`, artifact store,
local authorization, and NDJSON helpers.

**Risks or blockers**

- An analysis must not call `releaseLastResults`; Mine and Exposure must remain
  runnable afterward.
- A disconnected browser cannot recover a partial aggregate in this v1 stream;
  cancellation is safer than retaining an orphaned job.
- A fatal partial-data run must remain visibly incomplete, not look like a
  successful zero-edge result.

**Deliverables**

Server process, stream contract, route, debug events, and server-plugin tests.

**Validation and testing criteria**

- No-artifact, stale-fingerprint, concurrent-analysis, non-POST, and
  non-loopback requests fail as expected.
- Artifacts remain available after success, cancellation, and fatal paths.
- Event ordering is `start` -> phases/progress -> `done` or `fatal`.
- A large fixture receives progress while CPU work is ongoing and Stop exits
  without a hung request.
- `runState`/TTL behavior matches existing analyses.

**Exit criteria**

The server can complete a fixture run entirely without browser-held OHLCV or
array-heavy NDJSON payloads, and the route is authorization-tested.

### Phase 4: Batch UI integration

**Objective**

Expose the research run as a clear, cancellable Batch-tab operation.

**Scope**

HTML partial, DOM contract, service lifecycle, summary/report, and Copy.

**Technical tasks**

- Add `OPEN_SCORE USD A/B` and `Copy OPEN_SCORE USD` controls near the other
  Batch analysis actions.
- Add From/To and horizon inputs without persisting a new settings schema.
- Gate the button on `serverHasArtifacts && lastRunFingerprint`.
- Use `beginAnalysisBusy`/`finishAnalysisBusy` and the existing Stop/reissue
  flow.
- Render phase, current asset/pair, completed/total, elapsed time, and omitted
  counts in `batchBacktestOpenScoreUsdSummary`.
- Update the shared progress bar during analysis and restore it on every
  terminal/error/cancel path.
- Keep Copy disabled until a complete or explicitly incomplete report exists.
- Clear the report when Batch settings/symbols invalidate the fingerprint.

**Dependencies**

Phases 3 and the existing Batch DOM/lifecycle patterns.

**Risks or blockers**

Too many report lines can make the browser slow. Render a bounded summary and
keep the full scalar report available through Copy only.

**Deliverables**

UI controls, DOM contract entries, service handlers, and lifecycle fake-DOM
coverage.

**Validation and testing criteria**

- `feature-dom-contracts.spec.ts` confirms every new ID exists in the partial.
- Button enable/disable behavior matches the other artifact actions.
- Phase progress is visibly updated before expensive scan/evaluation work.
- Stop, fatal, and cancellation restore the Batch controls.
- Copy contains raw, adjusted, random, coverage, and warning sections.

**Exit criteria**

The user can run, stop, and copy the analysis from the Batch tab without opening
DevTools or running a CLI command.

### Phase 5: large-run performance and research validation gate

**Objective**

Prove the server feature remains responsive and that its result is statistically
usable before adding any stateful capacity selector.

**Scope**

Benchmarks, chronological validation, and documentation of the result.

**Technical tasks**

- Benchmark 50, 276, 600, and 1000+ pair runs with the recommended
  `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`.
- Record wall time, peak RSS/heap where available, artifact loads, target loads,
  event count, and skipped-data counts.
- Verify UI progress updates during artifact scan, event sweep, and target
  evaluation; no phase may appear frozen for more than two seconds.
- Run the primary raw treatment, adjusted treatment, and exact random control
  over chronological blocks with a locked final holdout.
- Report event-level top-minus-random delta and block-bootstrap interval. Do not
  select the better formula after seeing the holdout.

**Dependencies**

Phases 1-4 and a known data window that has not been used to tune the rule.

**Risks or blockers**

- The existing research has already inspected prior history; that history may
  be used for implementation debugging but not as an uncontaminated final
  confirmation.
- If target-data adjustment or time alignment is unresolved, the output must be
  marked exploratory and must not receive a tradeable verdict.

**Deliverables**

Benchmark notes, copied reports, and a findings section in
`docs/mine-timing-validation-findings.md` only after the run is complete.

**Validation and testing criteria**

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-server-plugin.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\batch-backtest-service-lifecycle.browser.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\batch-open-score-usd-replay-engine.spec.ts`
- Manual UI smoke with a small fixture and a large pair list, including Stop
  during each phase.

**Exit criteria**

The feature either produces a complete, reproducible raw/adjusted versus
random report on the locked holdout or is explicitly documented as
`INSUFFICIENT_DATA`/`NO_EDGE`. No UI trade recommendation is added on a
point estimate alone.

## Optional follow-up: stateful one-slot replay

Do not implement this before the event-level selector test completes. If the
event-level result shows a credible advantage, add a separate server process
that consumes the compact event/outcome representation and simulates one USD
position at a time. Compare the raw and adjusted treatments with a fixed,
seeded random-path distribution. It must define exit timing, slot-free timing,
fixed notional, and overlap handling explicitly; it must not reuse Mine A/B's
synthetic-pair replay.

## Performance and memory rules

- Never use `Promise.all(artifactMetas.map(loadStoredMineArtifact))`.
- Do not retain pair OHLCV after extracting score deltas.
- Do not retain every target OHLCV dataset; process a target and release it.
- Keep NDJSON scalar-only and bounded; no candidate/event arrays over the wire.
- Yield to the Node event loop after bounded CPU/I/O chunks.
- Preserve existing LRU/cache caps; do not add a process-global unbounded cache.
- Document the 16 GB Node heap recommendation for very large runs.

## Security and failure handling

- The route is local-only and POST-only.
- Fingerprint and artifact gates prevent analysis of stale settings/symbols.
- One miner owner prevents simultaneous analyses from racing artifact state.
- Stop and disconnect abort the active process; terminal cancellation is explicit.
- Missing pair artifacts, missing target assets, right-censored bars, and invalid
  prices are counted and shown in the report. They are never silently treated
  as zero returns.
- No external service, database migration, Worker binding, or secret is added.

## Rollback strategy

All changes are isolated to the new engine/stream/test files plus one Batch
route, UI controls, and lifecycle wiring. Removing the route and controls
restores the current Batch behavior. The Batch runner, artifact schema,
settings persistence, and existing Mine/Exposure analyses remain unchanged.
