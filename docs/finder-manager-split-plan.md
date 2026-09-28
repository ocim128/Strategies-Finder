# Finder manager decomposition plan

Status: Proposed; implementation has not started. Created at the user's explicit
request as a temporary exception to the documentation index's no-new-plans rule.
After implementation, fold the ownership map into [finder.md](finder.md) and
delete this plan. No behavior changes are intended.

## Scope and current architecture

Split the 5,063-line [FinderManager](../lib/finder-manager.ts) into cohesive
browser modules so an agent can identify the owner, dependencies, and focused
tests for a change without reading the entire manager. File length is a review
signal, not an acceptance criterion.

The manager currently owns settings normalization/persistence, DOM wiring,
strategy selection, Run/Stop, five scope workflows, server streams and reattach,
result inventories/re-sort, diagnostics, Apply, and clipboard exports.
Execution is already separated into `lib/finder/finder-runner*.ts`,
`finder-strategy-quality.ts`, metric/OOS helpers, and `lib/finder/server/`.
`FinderUI` in `lib/finder/finder-ui.ts` already renders cards and progress.
Reuse these boundaries; do not repartition engines or enlarge the renderer.

Preserve the exported `FinderManager` class, `finderManager` singleton, and
public methods: `init`, `runFinder`, `invalidateLocalDataCaches`,
`getLatestResults`, `getLatestCandidate`, and `getLastRunBacktestSettings`.
Known production callers are lazy initialization in
[app-bootstrap.ts](../lib/app-bootstrap.ts) and cache invalidation in
[local-data-cache-invalidation.ts](../lib/local-data-cache-invalidation.ts).

Read [finder.md](finder.md), [finder-server-side.md](finder-server-side.md), and
the [Asset Opportunity re-sort guide](finder-asset-opportunity-resort-guide.md)
before moving their corresponding behavior.

## Proposed ownership

New browser-only modules belong in `lib/finder/browser/`. These paths are
proposed; create them incrementally when extracting the matching responsibility.
Keep existing shared leaves and server files in place.

| Proposed file | Source responsibilities / symbols |
| --- | --- |
| `finder-settings.ts` | `FinderPersistedUiState`, defaults, `normalizeFinderUiState` and its local normalization helpers |
| `finder-persistence.ts` | Storage descriptors; `loadUiState`/`saveUiState`, result snapshot reads/writes, active-run record reads/writes |
| `finder-export.ts` | Metadata/configuration/diagnostic copy payloads, `copyTextToClipboard`; reuse existing metadata and config-capture leaves |
| `finder-run-diagnostics.ts` | `buildStrategyQualityDiagnostics`, `buildFailureDiagnostics`, `buildFallbackDiagnostics`, engine-mode reporting |
| `finder-result-store.ts` | Full inventories, display limits, original order, Arm run/apply context and completeness; result adoption and `applyResort` data transformations |
| `finder-result-actions.ts` | `runFinderApply`, candidate Apply methods, `loadAssetForApply`, `applyFinderBacktestSettings` |
| `finder-strategy-selection.ts` | Selection sets, toggle maps, search/filter, bulk selection, shift-click ranges and selected-key access |
| `finder-server-session.ts` | Active run ownership, scoped Stop, status timeout, poll timers/abort cleanup, reattach/recovery transport |
| `workflows/current-chart.ts` | `runCurrentChartFinder`, `applyOosValidationIfNeeded` integration with existing execution/OOS leaves |
| `workflows/symbol-universe.ts` | `runUniverseFinder`, `runUniverseFinderServer`, Universe request/event interpretation |
| `workflows/asset-opportunity.ts` | Single and batch Asset Opportunity requests, events, diagnostics and completion interpretation |
| `workflows/arm-performance.ts` | Arm request/events, run context, terminal inventory restoration |
| `workflows/strategy-quality.ts` | `runStrategyQualityFinder` and its existing audit runner integration |
| `finder-controls.ts` | Form binding/capture, `readOptions`, scope visibility, sorting controls, reset and persistence lifecycle wiring |
| `finder-run-controller.ts` | `runFinder` lifecycle, startup exclusion, dispatch, browser cancellation and finalization |

`lib/finder-manager.ts` becomes the composition point and public facade. Keep
render dispatch and small wiring there if extracting them adds indirection.
Do not introduce a plugin registry, inheritance hierarchy, event bus, generic
workflow framework, broad barrel export, or a shared mutable manager context.
Asset single/batch workflows can be separated later if the combined module is
still difficult to change independently.

### State and data flow

```text
persisted settings -> controls + strategy selection -> existing option builders
    -> run controller -> scope workflow -> existing browser runner / server job
    -> provisional or terminal update -> result store -> FinderUI
    -> compact persisted snapshot / copy output / Apply

persisted active-run record -> server session -> scoped status polling
    -> scope-specific terminal interpretation -> same result adoption path
```

- Controls own editable UI state; selection owns selected keys and toggle state.
  Capture inputs at the existing run boundaries. Do not silently change when
  settings, interval, capital or strategy selection are sampled during awaits.
- The run controller owns browser lifecycle flags and execution cancellation.
  The server session exclusively owns server run ID, polling and transport aborts.
  Stop coordinates both; aborting browser transport alone is not server Stop.
- The result store owns inventories and derives display views using existing
  comparators. It does not render, fetch, or access localStorage. Persistence
  serializes supplied state rather than retaining another mutable inventory.
- Workflows accept explicit inputs and narrow capabilities. Return existing
  scope-specific outcomes or small typed local outcomes; do not force unrelated
  terminal payloads into one universal result type. Use typed callbacks for
  progress/results where needed, not a callback for every private field.
- Pure builders receive explicit data. Inject fetch/storage/timer capabilities
  only where needed for independent lifecycle tests. Do not wrap every existing
  application service merely to introduce dependency injection.

## Contracts to preserve

- Keep `FinderLatestResults` and existing domain types in `lib/types/finder.ts`;
  keep wire events/status in `lib/finder/server/finder-stream-types.ts`.
- Preserve all existing HTTP paths, request fields, Rust preference forwarding,
  scalar-only payloads and server authorization. Server/Vite modules must never
  import new browser modules or transitively import browser-bound managers.
- Preserve run-ID checks after asynchronous boundaries, persist-before-start,
  scoped Stop (including rejection responses), missing-job handling, and recovery
  after broken streams. Success, fatal and cancelled outcomes remain distinct.
- Full terminal inventories drive re-sort before display limits. Preserve each
  scope's current retention rules, Run Sort restoration, Asset grouping, and Arm
  preview completeness. Provisional events are not authoritative final results.
- Preserve version-1 storage contracts: `playground_finder_ui` / `finder.ui`,
  `playground_finder_latest_results` / `finder.latest_results`, and
  `playground_finder_active_server_run` / `finder.active_server_run`.
  Continue using `lib/persisted-json.ts` and `finder-result-snapshot.ts`, including
  legacy reads and non-finite number handling. No schema migration is planned.
- Preserve settings debounce/page lifecycle flushes, terminal-only result
  persistence, bounded snapshots, provisional render coalescing, and lazy symbol
  breakdown rendering. Do not add full-inventory clones per progress event or
  retain candles/trades in server result inventories.
- Preserve Apply guards, frozen risk settings, exit override behavior, saved Arm
  run-context fallback, normal chart backtest execution, and copy payload meaning.
- Keep failure diagnostics copyable, existing user-visible errors/toasts, storage
  error handling, abort/timer cleanup and cache invalidation return behavior.

No database, infrastructure, deployment, dependency, worker-pool, engine,
strategy-manifest, route-security or markup changes are required.

## Implementation phases

Each phase is a separately reviewable change after its predecessor. Run
`git status --short` before edits and preserve unrelated work. Run application
and test typechecks plus the listed focused specs after each extraction. Commands
and final checks are below. The deliverable for each phase includes its migrated
tests; do not leave tests relying on removed manager-private fields.

### Phase 0 — Establish behavior coverage

**Objective/tasks:** Review `tests/finder-manager-lifecycle.browser.spec.ts`,
which casts the singleton to `any` and resets private state, and its helper
`tests/helpers/fake-finder-manager-dom.ts`. Record baseline results. Identify
coverage gaps for settings restore, Apply, selection, and copy before moving
those responsibilities; add characterization tests only for meaningful gaps.

**Validation/exit:** Existing lifecycle, result-snapshot, config-capture,
manager-logic and DOM-contract specs pass, or pre-existing failures are recorded
and distinguished from extraction regressions. No production behavior changes.

### Phase 1 — Extract settings and persistence

**Objective/tasks:** Move defaults/types/normalizers to `finder-settings.ts` and
storage operations to `finder-persistence.ts`. Keep DOM application and result
adoption in their current owners until later phases. Reuse the existing persisted
JSON and snapshot helpers; preserve write timing and lifecycle flush wiring.

**Risk:** Accidentally changing defaults, sharing mutable default arrays, clearing
an active-run record too early, or treating a compact preview as a full inventory.

**Validation/deliverables:** Add a focused Finder settings/persistence spec for
legacy/malformed state, round-trip normalization, and write timing. Run
`finder-result-snapshot.spec.ts`, `finder-manager-lifecycle.browser.spec.ts`,
`settings-compat.spec.ts`, and `finder-date-range.spec.ts`.

**Exit:** Manager delegates serialization; storage keys, versions, payload
interpretation and reload behavior remain unchanged.

### Phase 2 — Extract exports and diagnostic assembly

**Objective/tasks:** Move copy payload construction and diagnostic builders to
their modules. Reuse `finder-config-capture.ts`,
`finder-asset-opportunity-metadata.ts` and `finder-diagnostics.ts`. Keep clipboard
fallback and success/error presentation equivalent. Supply run context explicitly.

**Risk:** Reading current controls instead of retained run context, dropping
non-finite fields, or losing failure diagnostics when no candidates survive.

**Validation/deliverables:** Focused payload assertions in the relevant existing
`finder-config-capture.spec.ts`, `finder-diagnostics.spec.ts`,
`finder-asset-opportunity-metadata.spec.ts` and lifecycle specs. Cover clipboard
failure/fallback if its control flow changes.

**Exit:** Equivalent payload fields and errors; builders no longer require the
manager instance or access DOM to assemble their data.

### Phase 3 — Extract result ownership and re-sort

**Objective/tasks:** Move inventory fields and adoption/sort transformations to
`finder-result-store.ts`. Preserve provisional versus terminal updates and saved
preview hydration. Keep re-sort dropdown population/rendering in the browser UI
layer, using the store's scope and metric availability information.

**Risk:** Applying top-N too early, mutating original order, duplicating large
arrays, or incorrectly marking an Arm preview complete.

**Validation/deliverables:** Direct store tests using existing lifecycle fixtures:
promote an initially hidden Universe candidate, repeatedly change Arm sort,
restore Run Sort, retain Asset strategy-level rows and group by symbol, and load
an incomplete preview. Run lifecycle, snapshot, Asset all-resorts and Arm metrics
specs. Keep terminal-persistence count assertions.

**Exit:** One owner per result inventory; repeated re-sort and reload behavior
match baseline without extra persistence or raw server data retention.

### Phase 4 — Extract Apply and strategy selection

**Objective/tasks:** Move Apply methods and `applyInFlight` together. Move strategy
toggle maps, range/filter/bulk operations and selection sets together. Preserve
`usesUniverseStrategySelection` semantics across scopes. Leave strategy loading
with workflow preparation unless sharing the existing code is necessary.

**Validation/deliverables:** Focused tests for scope selection restoration,
filtered/range selection, duplicate Apply exclusion, frozen risk/exit settings,
and Arm saved-context/legacy fallback. Reuse `finder-arm-performance-settings.spec.ts`
and `finder-freeze-randomize-path-exit.spec.ts`; manually Apply a candidate on the
chart and exercise selection controls.

**Exit:** Selection and Apply can be exercised without resetting unrelated
manager lifecycle fields; strategy/settings/interval behavior remains equivalent.

### Phase 5 — Extract server sessions and scope workflows

**Objective/tasks:** Extract session ownership, status timeout, Stop and polling
as one unit. Move scope-dependent event interpretation into the corresponding
workflow, including reattach terminal interpretation. Migrate one server scope
at a time, then Current Chart and Quality Audit orchestration. Continue using
`consumeNdjsonStream` and existing runners; share transport only where behavior
already matches. Keep terminal adoption consistent between stream and polling.

**Risk/blocker:** This is the highest-risk phase: callbacks currently mix DOM,
session and inventory writes. If a proposed module still needs the whole manager,
finish identifying its inputs/ownership before extracting it. Do not bypass
race tests or merge distinct batch/Arm terminal semantics to simplify signatures.

**Validation/deliverables:** Migrate lifecycle cases to fresh session instances
with controlled fetch/timers where practical; retain facade integration tests.
Cover stale initial probes, ownership changes during awaits, Stop aborting a
status fetch, HTTP-200 Stop rejection, fatal recovery, missing jobs, batch
diagnostics and Arm inventory restore. Run lifecycle, server-plugin,
server-loader-parity, asset-stream, runner-input-immutability and relevant
scope runner/OOS specs. Manually test Run/Stop, stream recovery and reload
reattach for Universe, Asset single/batch and Arm.

**Exit:** Scope workflows are independent of the facade; no late response can
adopt results after ownership loss. Existing server/browser import boundaries,
event throttling and terminal semantics are preserved.

### Phase 6 — Finish controls and coordinator; document ownership

**Objective/tasks:** Move form binding/capture and `readOptions` into controls,
reusing `finder-manager-logic.ts` builders and `finder-manager-dom.ts`. Move
Run/Stop orchestration into the run controller, including the Stop listener
currently wired in `init`. Keep the facade responsible for construction,
initialization and public delegation; do not duplicate running state across it
and the controller. Preserve listener/subscription registration order and lazy
initialization. Inspect `index.ts` and `app-bootstrap.ts` before touching startup.

**Validation/deliverables:** Run final checks below and manually verify all five
scopes' controls, Run/Stop, Apply, Copy, Reset and re-sort. Update the source map
in `finder.md` with task-to-owner-to-test routing; update any moved-symbol
references in `finder-server-side.md` and `README.md` only where necessary.

**Exit:** The facade contains no settings normalizer, stream consumer, per-scope
search body or large copy builder. Each mutable state category has one owner,
focused tests use typed interfaces, and the maintained guide points to the new
owners. A roughly 200–400-line facade is an aspiration, not a reason to create
more abstraction. Remove this temporary plan when its content is incorporated.

## Validation commands and rollback

From the project directory:

```powershell
npm run typecheck
npm run typecheck:tests
npm run test -- finder-manager-lifecycle.browser.spec.ts
npm run test -- feature-dom-contracts.spec.ts
# Run each phase's additional specs with the same filename-filter syntax.
# After all extractions:
npm run verify
npm run build:check
```

Run checks once per meaningful change; broaden after a failure or unresolved
concern. Add browser end-to-end coverage only if the existing test harness and
manual smoke cannot validate changed wiring. This is a maintainability change;
do not claim a runtime speedup. Compare persistence counts, retained inventories
and render coalescing behavior rather than introducing a benchmark project.

Keep phases in separate commits with passing checks. Roll back a faulty
extraction by reverting its commit and dependent later phases in reverse order.
Unchanged storage/wire contracts allow the prior implementation to read saved
state; no migration, dual execution path or feature flag is needed.

## Assumptions and remaining decisions

- This plan assumes behavior preservation. Any discovered bug should be
  characterized and fixed separately, not silently bundled into extraction.
- Proposed module names and narrow interfaces may be adjusted during extraction
  based on actual callers; the ownership boundaries are the intended outcome.
- Existing tests have been inspected, not executed for this planning task.
  Phase 0 must establish the baseline and availability of manual server datasets.
- Keep current settings capture timing. Standardizing all scopes onto a new
  immutable run-context model is outside this plan unless proven equivalent.
- Keep scope-specific retention and error policies; this plan does not assert
  that all scopes currently behave identically.
