# Batch Backtest module split plan

Status: Proposed; implementation has not started. Inspected 2026-09-28.

This temporary plan is explicitly requested by the user, overriding the
documentation index's default against adding implementation plans. After
implementation, fold the module map and contracts into
[the Batch guide](batch-backtest-server-side.md), then remove this plan.

## Objective and scope

Make Batch changes easier for coding agents to locate, understand, and test
by separating cohesive responsibilities in two existing modules:

- [Replay engine](../lib/batch-backtest/batch-open-score-usd-replay-engine.ts):
  4,388 lines at inspection; `runOpenScoreUsdReplay` contains approximately
  2,875 lines, including five processing phases.
- [Browser service](../lib/batch-backtest/batch-backtest-service.ts):
  4,332 lines; `BatchBacktestService` owns Batch and TOP_MEAN lifecycles,
  standalone replay, rendering, persistence, diagnostics, and form controls.

This is a behavior-preserving extraction. Do not change selectors, execution
math, UI markup/IDs, server routes, settings schemas, archive formats, worker
pool policy, or strategy execution. No database, dependency, infrastructure,
deployment, or authorization changes are needed. Do not revive surfaces
retired in [the research findings](mine-timing-validation-findings.md).

## Existing architecture and boundaries

`lib/app-bootstrap.ts` lazy-loads `batchBacktestService.init()`. The browser
consumes server NDJSON and status snapshots through existing stream types,
`batch-ndjson-post.ts`, and `reattach-backoff.ts`. Heavy per-pair artifacts
remain server-side; the browser receives scalar Batch rows.

The server plugin and `sp500-top-mean-coordinator-engine.ts` call
`runOpenScoreUsdReplay`. Research scripts also call it; Finder consumes replay
comparisons through its TOP_MEAN path. Replay proceeds as follows:

```text
artifact scan -> compact delta streams -> timestamp event sweep
  -> candidate pools / target requests -> target outcomes
  -> gap filtering and reranking / latest selections
  -> horizon aggregation -> report and result
```

Replay accepts injected artifact/target sources, cancellation and phase
callbacks, optional archive sinks, and a caller-owned cross-window outcome
cache. Preserve these APIs and their ownership; extraction does not require
a new service or generic pipeline framework.

## Intended module ownership

Paths below are relative to `lib/batch-backtest/`. New filenames describe
extractions, not additional runtime features. Keep the original entry points
and exports working throughout migration.

### Replay

| Proposed module | Existing responsibility to move |
| --- | --- |
| `open-score-replay/types.ts` | Public result/options/selector types, archive records, target and shared-cache contracts |
| `open-score-replay/internal-types.ts` | Only records shared across stages: score deltas, decision events, candidate views, outcome records |
| `open-score-replay/statistics.ts` | Median/bootstrap/block helpers, comparison and per-asset statistical helpers |
| `open-score-replay/pnl.ts` | `computeSelectorPnl`, `simulateTopMeanPortfolio` |
| `open-score-replay/report.ts` | `buildReportLines` and report-specific formatting |
| `open-score-replay/artifact-scan.ts` | Phase 1 artifact loading, trade deltas, retained degrees, cap-tilt coverage |
| `open-score-replay/event-sweep.ts` | Phase 2 timestamp buckets, score accounting, causal realized-P&L state, snapshots |
| `open-score-replay/candidate-selection.ts` | Candidate construction, strict-past TOP_Z history, ranking/ties, post-outcome gap filtering and latest selections |
| `open-score-replay/target-outcomes.ts` | Target loading/cache reuse, horizon outcomes, gap/censoring diagnostics and archive outcome emission |
| `open-score-replay/aggregation.ts` | Horizon samples, controls, exclusions, event details, final numerical summaries |

The original engine retains `runOpenScoreUsdReplay`, phase sequencing,
cancellation/progress coordination, explicit release points, and compatibility
re-exports. Internal modules import contracts directly, never through that
entry point. Keep private helpers local unless another stage actually needs
them. Archive snapshot emission stays with its consuming stage; avoid a new
diagnostics abstraction spanning all phases.

### Browser

| Proposed module | Existing responsibility to move |
| --- | --- |
| `browser/batch-results-view.ts` | Row creation, sort display, coalesced render queue, summary/progress presentation |
| `browser/top-mean-results-view.ts` | Current snapshot, latest-arm card, display tie breaks, copy text |
| `browser/top-mean-event-details-view.ts` | Detail/year selectors, ongoing/completed rows, truncation notices |
| `browser/batch-browser-store.ts` | Storage reads/writes for settings, active markers, and compact snapshots |
| `browser/top-mean-controller.ts` | TOP_MEAN run/stop/reattach, result ownership, diagnostic ring and debounce lifecycle |
| `browser/batch-run-controller.ts` | Batch run/stop/reattach, status pagination/reconciliation, result and benchmark ownership |
| `browser/open-score-controller.ts` | Standalone replay request, phase events, result and copy action |
| `browser/trade-gate-controls.ts` | Ledger/gate form parsing, catalog selection, validation |
| `browser/balanced-pair-list-controls.ts` | Generate/apply/copy and current pair-list provenance |

`BatchBacktestService` remains the composition root and public facade, including
`createBatchBacktestService` and the exported singleton. It wires the existing
`BatchBacktestDom`, coordinates cross-workflow busy/Stop rules, and disposes
children. Move state with its owner; do not pass the whole service into child
modules or expose its private fields through casts.

Reuse `batch-backtest-summary.ts`, `batch-results-sort.ts`,
`batch-backtest-snapshot.ts`, `batch-benchmark-snapshot.ts`, and
`sp500-top-mean-diagnostic-log.ts`. The browser store wraps existing persisted
JSON/normalization helpers; it does not replace their schemas. Controllers
use narrow typed callbacks for presentation and shared coordination, with no
new global event bus or common controller superclass.

## Contracts that constrain extraction

- Preserve same-timestamp entry/exit accounting, entry-only decision events,
  strict next-bar entry, inclusive sample windows and pre-window carry-in.
  Keep causal and full-window look-ahead profit arms distinct.
- Preserve gap exclusion/reranking separately from missing or censored outcome
  handling. Ranking helpers must not inspect future return values.
- Preserve tie digests, floating-point accumulation order, bootstrap draws,
  null/non-finite conventions, event ordering, and opaque `reportLines` text.
- Retain target loader precedence, `null` versus empty-data semantics, cache
  no-data markers, prefetch order, and immutable cached outcome records.
- Preserve typed snapshots and early release of events/outcomes. Passing stage
  outputs must not copy large arrays or keep them reachable in a shared context.
  Preserve bounded yields, cancellation checks, archive sink awaiting, and
  progress phase names. No new all-artifacts or all-targets materialization.
- Browser imports remain browser-safe; no runtime Vite plugin, Node filesystem,
  or coordinator engine imports. Use type-only imports for server contracts.
- Preserve synchronous single-flight guards, stale run-token rejection,
  artifact-action gating, status row deduplication and terminal queue flushing.
- `requestServerStop` tracks every outstanding Stop; it deliberately does not
  coalesce them. Preserve the second Stop after analysis POST ownership and
  the wait before enabling new work. Batch Stop uses the active run ID when
  available; do not assume all analysis cancellation is operation-scoped.
- Preserve per-workflow reattach timers/backoff, rejected-Stop ownership,
  authoritative server-loss handling, and disposal wakeup order. Keep immediate
  lifecycle diagnostic persistence and debounced progress writes.
- Keep storage keys, versions, legacy reads, wire caps, archive completeness,
  route authorization and error messages unchanged.

## Implementation phases

### Phase 0 - Record the baseline and ownership map

**Objective:** Establish behavior and performance evidence before moving code.

**Tasks / deliverables:** Recheck the worktree and callers. Map closure inputs
and last consumers for each replay stage; map service fields to controller,
view, or shared coordinator ownership. Run the relevant existing tests below.
Use `scripts/bench-finder-arm-replay.ts` to save before-results with fixed
inputs, including ordinary, tie-heavy, missing/gapped-target, and interleaved
profit-pool cases. Its full-result fingerprint is preferable to a partial
selector metric hash. Record phase timings and memory observations.

**Risks / validation:** Existing browser tests use `svc(): any` to access
private methods. Identify these migration points without weakening behavioral
assertions. Add characterization only for an uncovered boundary needed by an
extraction. Investigate baseline failures separately from this refactor.

**Exit:** Reproducible reference outputs, recorded test status, and explicit
ownership/release points. No implementation change required for this phase.

### Phase 1 - Extract replay contracts and leaf calculations

**Objective:** Reduce entry-point bulk with low-coupling moves.

**Tasks / deliverables:** Move public types, statistics, P&L, and report helpers
into the mapped modules. Keep existing imports valid through explicit
re-exports; preserve report and result shape exactly. Leave scan/sweep logic
in place. Do not redesign repeated selector calculations in this phase.

**Dependencies / risks:** Phase 0. Avoid circular imports through compatibility
exports and accidental runtime imports from type consumers.

**Validation:** Replay and selector-P&L specs, dependent typechecks, full-result
fingerprint comparison. Include signed-zero/bootstrap parity assertions.

**Exit:** Existing callers compile without migration and deterministic outputs
match the baseline.

### Phase 2 - Extract browser views and persistence

**Objective:** Remove presentation/storage bulk before changing lifecycle state.

**Tasks / deliverables:** Extract the three views and browser store. Reuse the
existing DOM contract and snapshot/diagnostic helpers. Give the result view
ownership of its render queue/scheduling; keep run-token authorization with
the run owner and pass the necessary token check. Keep lifecycle state in the
service during this phase. Preserve public formatting exports.

**Dependencies / risks:** Phase 0; follows Phase 1 for simpler review. Event
delegation on generated arm controls, final queue flushing, snapshot caps,
and current versus historical result presentation are regression points.

**Validation:** Browser lifecycle, copy, snapshot, diagnostic-log and DOM specs.
Retain facade integration tests; move rendering-specific cases to the extracted
views where useful. No tests solely asserting the new file layout.

**Exit:** UI actions, displayed/copied content and saved-state restoration are
unchanged; service delegates rendering/storage without sharing mutable internals.

### Phase 3 - Extract replay stages one at a time

**Objective:** Make `runOpenScoreUsdReplay` readable as orchestration.

**Tasks / deliverables:** Extract scan, event sweep, candidate construction,
target outcomes, post-outcome selection, then aggregation in separate reviewable
changes. Define small typed stage inputs/results based on Phase 0's consumer
map. Keep candidate selection callable before and after outcome loading; it
must not import the loader. Keep large-data release points visible and ensure
returned closures do not retain obsolete arrays. Keep aggregation cohesive
even if larger than other modules.

**Dependencies / risks:** Phase 1. Main risks are changed accumulation order,
causal history ordering, diagnostic backpressure, retained arrays, cancellation
latency, and loss of annual cache reuse. Do not add a selector framework,
streaming rewrite, or numerical optimization alongside extraction.

**Validation:** Run replay specs and baseline fingerprint comparisons after
each stage; include diagnostics on/off, annual cache reuse, gaps, missing data,
carry-in, ties, and cancellation. Reuse the benchmark for before/after timings
and heap/external-memory observations at the same fixture size.

**Exit:** Full deterministic result parity, unchanged load counts and release
semantics, and no unexplained reproducible time/memory regression. Timing noise
is not numerical parity; record measurements rather than promise a speedup.

### Phase 4 - Extract browser workflow owners

**Objective:** Give each run lifecycle one owner while retaining shared guards.

**Tasks / deliverables:** Extract TOP_MEAN first, including its run ID, timers,
backoff, result and diagnostics. Then extract Batch with its run token, results,
benchmark, status recovery and polling. Extract standalone replay and form
controls last. Keep `isBatchUiBusy`, cross-action preflight coordination and
pending-Stop sequencing in the facade initially; expose narrow operations to
controllers rather than duplicating locks. Document which owner updates each
busy flag before moving it. Preserve factory/singleton/public facade methods.

**Dependencies / risks:** Phase 2. Batch and standalone replay share cancellation
coordination; they are not independent lifecycles. TOP_MEAN polling and
diagnostic debounces must be disposed by their new owner. Avoid converting
existing synchronous guards into checks that occur after an await.

**Validation:** Browser lifecycle regressions for rapid Run clicks, Stop during
preflight/POST, rejected Stop, stale callbacks, reload/reattach, terminal status
pagination, transient errors, server restart, and dispose. Verify balanced-list
provenance and ledger versus replay date independence. Keep cross-workflow
tests exercising the public facade even when focused tests move to controllers.

**Exit:** No duplicated mutable run ownership; existing race/recovery tests
pass, public entry points remain compatible, and children release timers and
render/debounce work on disposal.

### Phase 5 - Validate integration and publish the module map

**Objective:** Finish with a navigable architecture and confirmed integration.

**Tasks / deliverables:** Update the Batch guide with behavior -> owner ->
focused spec routing, dependency direction, and memory ownership. Audit imports
from Finder, server plugins, coordinator, archive writers and research scripts.
Keep compatibility exports; do not create unrelated import churn. Remove this
temporary plan once its implemented decisions are recorded in the guide.

**Dependencies / validation:** Phases 1-4. Run `npm run verify` and
`npm run build:check`. Smoke-test Batch run/stop/reload, standalone replay, and
TOP_MEAN results/details/copy/diagnostic restoration using available local data.
Use the existing Batch benchmark protocol for equivalent configurations if
browser lifecycle/render performance changed.

**Exit:** Checks pass, or external-data limitations are explicitly recorded;
all planned extractions are complete, behavior is unchanged, and the durable
guide tells an agent where to implement and test each affected behavior.

## Focused validation commands

Run from the project directory. Use the repository test wrapper, which bundles
`.browser.spec.ts` files; do not run those directly with a plain TypeScript
runner. These commands are planned checks, not results from writing this doc.

```bash
npm run typecheck
npm run typecheck:tests
npm run test -- batch-open-score-usd
npm run test -- batch-backtest-service-lifecycle.browser.spec.ts batch-backtest-copy.spec.ts batch-backtest-snapshot.spec.ts feature-dom-contracts.spec.ts
npm run test -- batch-backtest-server-plugin.spec.ts batch-ndjson-post.spec.ts batch-benchmark-snapshot.spec.ts
npm run test -- sp500-top-mean top-mean-rule-checker finder-arm-performance
```

Run only relevant groups per extraction, then the integration checks in Phase
5. Existing replay tests already cover many numerical/causal boundaries; add
tests for missing behavior, not for every moved function.

## Assumptions, unknowns, and rollback

- Baseline inspection found a clean worktree. Recheck before implementation;
  concurrent feature work may alter stage boundaries and public types.
- Module filenames and exact signatures are proposed. Resolve parameter sets
  from actual closure consumers; do not force a line-count target or introduce
  a giant mutable context merely to reduce argument count.
- Existing comments mention some historical selectors and paths. Preserve
  executable behavior and tested contracts; do not restore behavior from stale
  comments. Correct comments only where directly relevant to extraction.
- Large-data performance and local IBKR/market-cap availability were not
  measured for this planning task. Establish them in Phase 0; deterministic
  fixtures remain the parity gate when full data is unavailable.
- Commit each extraction separately. On regression, revert the responsible
  extraction while retaining prior validated phases. Stable entry points and
  unchanged persistence/wire formats allow rollback without data migration,
  cache deletion, feature flags, or deployment changes.
