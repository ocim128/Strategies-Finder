# Complexity and maintainability audit

Date: 2026-10-09. Source revision: `7ac14088`. All archive folders excluded.

## Implementation status

The original findings below describe the baseline revision above. The verified
cleanup has now been implemented: F1–F3, the internal-helper portion of F4,
twenty private Batch forwarding methods from F7, the shared Finder worker
transport in F8, F10–F12, and the runtime/static-deployment documentation from
F17. F5's removed-strategy defaults were replaced with explicit strategy-key
requirements; the commands retain their different report and workflow contracts.

Measured against the baseline, code/config/style changes remove 2,902 net lines
and tests remove 677 net lines: **3,579 net lines**, excluding documentation and
including the new 57-line shared worker transport. Twenty obsolete files were
deleted. Existing renderer/result contracts, saved settings, strategy authoring
indicators, public Batch entry points, and active engines/research modes remain.

The broader facade/test redesign, keyed replay-arm refactor, active-feature
retirements, and Rust removal remain recommendations rather than completed work.
Worker source/sibling fallbacks also remain: the current resolver and its specs
explicitly support those paths, so this cleanup does not change that execution
contract without deployment evidence. The Worker schedule example was not changed.
Links to deleted files have become plain baseline filenames; their source is
available in Git history. Validation results are recorded in `maintenance-log.md`.

The best first move is to delete implementations that the application no longer calls. The largest structural opportunity is the optional Rust simulation backend, but its removal needs a representative performance comparison. Finder and Batch need fewer compatibility surfaces and research variants; they do not need a replacement framework.

I estimate **4,000–6,000 maintained source lines** can disappear through cleanup and behavior-preserving simplification. Including obsolete tests and reduced test scaffolding, that is approximately **5,000–8,000 lines**. A more aggressive, explicitly conditional scope could reach **16,000–23,000 source lines**, primarily by retiring Rust and unused research options. Those estimates are net reductions, not measured patches.

There is no evidence here supporting a Critical maintainability finding. Several issues are High because they multiply the cost of ordinary changes or expose misleading developer workflows.

## Scope, evidence, and limits

- Inventoried 970 maintained code, documentation, and configuration files, approximately 306,080 physical lines. Count includes comments, blank lines, and a trailing split line; it is not executable SLOC.
- The source estimate denominator is 176,163 lines across 551 TS/JS/Rust/Python/batch files, excluding tests, documentation, HTML/CSS, and generated strategy manifests. SQL migrations were separately inspected and inventoried. Maintained tests account for approximately 93,071 lines across 293 files, including fixtures and helpers.
- Finder and Batch directories alone contain 153 files and 67,542 lines. Finder's root manager adds another 984 lines. This is approximately 39% of the source denominator when that manager is included.
- Enumerated maintained files, parsed TS/JS source to inspect imports, exports, dynamic string references and worker entry references, searched candidate symbols and callers, and manually reviewed the major subsystem entry points, guides, contracts, and focused tests. This is a repository-wide static audit with deeper review of hotspots, not a claim that every line received individual manual review.
- Archive contents, market datasets, runtime artifacts, build output, ignored declarations, dependencies, and local agent caches do not contribute to maintained-code savings. No archive folder was read or changed.
- File reachability is insufficient to establish feature use: barrels can retain unused implementations. Conversely, no in-repository callers does not prove that an HTTP endpoint has no external consumers.
- No production usage telemetry or fresh Rust performance matrix was available. Recommendations that remove active options or public routes are conditional; preserving 95% of product value cannot be measured by counting files.
- Confidence is confidence in the recommendation under its stated conditions, not a measured probability of successful deployment. Cost is estimated engineer-days, including focused verification. Maintenance estimates describe the affected area, not project-wide savings that can be added together.

## Findings at a glance

Reduction percentages below apply to the affected code identified in the finding. They are not percentages of the entire repository. Detailed sections provide the current implementation, alternative, justification, and checks.

| ID | Finding | Severity | Engineering cost | Current maintenance cost | User impact | Recommendation | Expected source reduction | Risk | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Five orphaned application modules | Medium | 1–2 days | Medium: stale contracts and tests | No identified application behavior changes | Delete modules and their exclusively obsolete contracts/tests | 698 lines; 100% of modules | Low | 99/100 |
| F2 | Old Monte Carlo implementation behind re-exports | Medium | 1–2 days | Medium: two algorithm surfaces | Current simulations preserved; remove unused perturbation API | Delete four old modules and dormant fields | 400–450 lines; 100% of old modules | Low–Medium | 97/100 |
| F3 | Retired spread-quality engine and incompatible CLI | Medium | 1–2 days | Medium: misleading research support | Loses an obsolete rerun workflow, preserves recorded findings | Delete CLI, engine, package command, and exclusive spec | 951 lines plus small wiring; 100% of feature | Low | 98/100 |
| F4 | Uncalled helper exports and compatibility utilities | Medium | 2–4 days | Medium: large apparent supported API | No change to current callers; author API needs checking | Delete unreferenced functions and exclusive dependencies | 600–1,000 lines; roughly 10–20% of affected helper code | Low–Medium | 92/100 |
| F5 | Overlapping hunt CLIs with missing default strategies | High | 3–5 days | High: repeated argument/config/report changes | Defaults become usable; preserve supported hunt workflows | Keep one sweep command with explicit options | 500–900 lines; roughly 35–65% of three overlapping scripts | Medium | 95/100 |
| F6 | Optional Rust backend duplicates the simulation product | High | 5–10 days plus measurement | Very high: two kernels, protocol, fallback, parity, CI | Results preserved if TS parity holds; performance unknown | Retire if TS is within 5% on representative required workloads | 8,500–11,500 lines; approximately 85–100% of Rust-specific surface | High | 75/100 |
| F7 | Facade forwarding retained to satisfy implementation-coupled tests | Medium | 4–8 days | High: tests freeze private layout | No intended behavior change | Remove redundant forwarding; test owners and observable lifecycle | 350–650 source lines; roughly 20–40% of facade code | Medium | 94/100 |
| F8 | Repeated worker transport lifecycle | Medium | 2–3 days | Medium: duplicate terminal/cancellation fixes | No intended behavior change | Share only the existing single-task worker transport | 120–220 lines; roughly 10–20% of two pool files | Medium | 96/100 |
| F9 | Worker loading silently switches execution mechanisms | Medium | 1–2 days | Medium: environment-dependent debugging | Build errors become direct errors | Keep one explicit bundle path; remove silent source fallback | 30–70 lines; roughly 17–40% of resolver | Medium | 93/100 |
| F10 | Strategy-kind abstraction with one possible value | Low | 0.5–1 day | Low: needless branches and labels | None beyond removing redundant metadata | Delete kind API and constant-valued branches | 25–50 lines; 70–100% of kind-specific code | Low | 99/100 |
| F11 | Settings contract metadata nobody reads | Low | 0.5–1 day | Low–Medium: false source of truth | None; retain real settings migrations | Delete unused `workerSupport` and `legacyAliases` metadata | 40–90 lines; roughly 8–18% of DOM contract | Low | 98/100 |
| F12 | Internal compatibility barrels and unused declaration build | Low | 1–2 days | Low–Medium: navigation/import ambiguity | None for app; check external declaration consumers | Delete redundant barrels and `build:types` if unpublished | 15–30 lines; 100% of selected wrappers/build config | Low–Medium | 91/100 |
| F13 | Parallel flat and keyed representations of replay arms | High | 5–8 days | High: each arm touches many representations | Same metrics and saved results | Keep one keyed runtime shape; flatten only at compatibility boundary | 500–900 lines; roughly 15–25% of targeted mappings/contracts | Medium–High | 88/100 |
| F14 | Research mode multiplication without established retained value | High | 3–6 days after usage review | High: selectors × horizons × modes × reports | Deliberate loss of selected diagnostics; usage unknown | Retire unused arms/report combinations after a 95% value check | 2,000–4,000 lines; roughly 15–30% of replay/research surface | High | 65/100 |
| F15 | Sizing and adaptive-exit option sprawl | High | 5–8 days after usage review | High: engine, MC, settings, worker/Rust support | Expert configurations may change; cannot silently migrate | Retain demonstrated models; retire unused experimental variants | 1,400–2,300 lines; roughly 35–60% of option-specific surface | High | 70/100 |
| F16 | Worker Committee routes with no application client | Medium | 2–4 days after external-use check | Medium: API, state/history, cron, schema support | External tooling may rely on these routes | Retire unused Committee-only behavior, preserve normal alerts | 400–800 lines; roughly 15–30% of worker | Medium–High | 80/100 |
| F17 | Conflicting onboarding and deployment contracts | Medium | 1–2 days | Medium: setup and environment diagnosis | More predictable install and feature availability | Document/pin the tested runtime and align deployment examples | 0–20 lines; approximately 0% of product source | Low | 97/100 |

## F1 — Delete the five orphaned application modules

Source and current behavior:

| Module | Lines | Actual in-repository consumers |
| --- | ---: | --- |
| `strategy-executor.ts` | 44 | None |
| `backtest-result-analysis.ts` | 503 | `tests/backtest-result-analysis.spec.ts` only |
| `backtest-result-context.ts` | 50 | Its focused spec only |
| `latest-entry-export-window.ts` | 21 | Its focused spec only |
| `signal-merge.ts` | 80 | Its focused spec only |

For example, `signal-merge.ts:36` still implements an AND/OR Combo Finder merge:

```ts
export function mergeStrategySignals(primarySignals, secondarySignals, mode) {
    const secondaryMap = new Map();
    // AND filtering or OR merging, time normalization, and sorting...
}
```

The comment describes a Combo Finder, but the current application never calls the function. `StrategyExecutor` similarly retains `new Function(...)` compilation without a caller. The README still advertises `backtest-result-analysis.ts` as part of the renderer architecture; current renderers do not import it.

**Simplest alternative:** delete these five files. Remove the four specs that exclusively validate them, unused result types proven exclusive to the deleted code, and the stale README entry. Preserve current confirmation filtering, exit merging, alert candle selection, and result publication guards; they have independent implementations and callers.

**Maintenance reduction:** eliminate five supported-looking entry points and four test obligations, approximately 100% of this isolated maintenance. Expected visible product degradation is zero based on repository callers. Do not count tree-shaken source deletion as an assured bundle-size or runtime improvement.

**Verification:** typecheck both source and tests, run renderer/Quick View and alert-window focused specs, and inspect all references after deletion. The existing four orphan-module specs passed during this audit; their passing status does not make the modules used.

## F2 — Delete the old Monte Carlo implementation retained by a barrel

[`monte-carlo/index.ts:14`](../lib/strategies/monte-carlo/index.ts) exports a separate library of object-based simulators:

```ts
export { randomizeTradeSequence, generateRandomizedSequences } from './trade-sequence-randomizer';
export { bootstrapResample, generateBootstrapSamples, blockBootstrapResample } from './bootstrap-resampler';
export { perturbParameters, analyzeParameterSensitivity } from './parameter-perturbation';
export { buildEquityCurve, calculateMaxDrawdown, checkRuin, computeRuinProbabilityMetrics } from './path-dependency-analyzer';
```

Those four modules total **388 lines**. The first three have no callers outside their own implementation and the re-export. `path-dependency-analyzer.ts` is additionally imported by `drawdown-percent.spec.ts`, but has no application consumer. The current [`monte-carlo-engine.ts:342`](../lib/strategies/monte-carlo/monte-carlo-engine.ts) already builds seeded simulation orders itself and computes the current path metrics.

[`monte-carlo-service.ts:191`](../lib/monte-carlo-service.ts) always supplies `enableParameterPerturbation: false`. The current engine does not consume that flag or the perturbation module. `analyzeParameterSensitivity` only generates parameter variations; it does not execute strategies and calculate the advertised sensitivity metrics.

**Simplest alternative:** keep the current engine, random-number utilities, current sizing replay, and actual result contracts. Delete the four old modules, their re-exports, unused perturbation types/settings, and only the obsolete portion of the drawdown test. Continue testing current-engine drawdown semantics.

**Maintenance reduction:** roughly 20–30% of the Monte Carlo algorithm/API surface, with no change to current sequence, bootstrap, combined, or ruin simulations. Re-export reachability explains why a simple unused-file scan misses this deletion.

**Verification:** `monte-carlo` focused specs, `drawdown-percent.spec.ts` after preserving active-engine assertions, DOM-contract spec, and the existing E2E Monte Carlo scenario. Check for out-of-repository use before treating exported helper names as a guaranteed private API.

## F3 — Remove the retired spread-quality implementation and incompatible rerun CLI

`validate-spread-quality.ts:97` admits only artifacts containing candles:

```ts
if (artifact && artifact.data && artifact.data.length > 0 && artifact.result?.trades) {
    artifacts.push({ data: artifact.data, trades: artifact.result.trades /* ... */ });
}
```

The current [`batch-synthetic-artifact.ts:17`](../lib/batch-backtest/batch-synthetic-artifact.ts) contract explicitly says temporary Batch replay artifacts have empty candle, signal, and equity arrays. The CLI therefore cannot run on artifacts produced by the documented current Batch workflow. It also duplicates ADF/half-life calculations internally instead of importing the 508-line spread-quality engine. That engine is called only by its spec.

There is a second reason to stop maintaining this path: [`mine-timing-validation-findings.md`](mine-timing-validation-findings.md) records the negative research result. The CLI still contains stale statistical code: it fits changes in ADF but calculates residuals using levels at lines 141–145, and its quantile label ordering at lines 393–396 conflicts with the stated more-negative-is-better ranking. These observations concern the current script; they do not invalidate or freshly reproduce the historical study.

**Simplest alternative:** retain the findings document, delete the 443-line script, 508-line engine, `validate:spread-quality` package command and exclusive spec, and update documentation that promises current rerun support. If another study is commissioned, use a fresh, reviewed study against the current data contract.

**Maintenance reduction:** 100% of a disconnected research feature. User loss is obsolete rerun support, not an active UI tool. Reproducibility of historical research is a legitimate reason to retain source in Git history; it is not a reason to advertise a broken current command.

**Verification:** no references remain outside historical prose; source/test typechecks and validation routing still work. Do not reconstruct or inspect archive contents for this removal.

## F4 — Shrink the supported-looking helper API

The static scan found **59 exported functions whose identifier has no occurrence outside its own source file and appears only once inside that file**. This is a candidate list, not 59 automatically authorized deletions. Comments, API consumers outside this repository, and generated/dynamic access must be considered.

Strong internal candidates include:

- [`finder-runner-core.ts:566`](../lib/finder/finder-runner-core.ts): `extractRustFinderCandidates`, a 38-line alternate payload adapter accepting `params`, `parameters`, or `bestParams` and `result`, `backtestResult`, or `metrics`.
- [`finder-runner-shared.ts:586`](../lib/finder/finder-runner-shared.ts): a 43-line `maybeUpdateFinderProgress` abstraction with thirteen context fields and no caller.
- [`take-profit-settings.ts:35`](../lib/take-profit-settings.ts): unused adaptive settings resolution and extraction functions. Live settings use the current resolver/coercion path.
- [`settings-dom.ts`](../lib/settings-dom.ts): six unused numeric/checkbox/select read/write helpers; retain `triggerSettingsChangeEvents`.
- [`bar-metrics.ts:326`](../lib/strategies/backtest/bar-metrics.ts): four unused volume metric implementations; retained metrics have different callers.
- Unused formatting functions and historical indicator variants. Current built-ins do not reference several of the exported RSI/CCI/Bollinger/Aroon/MFI/OBV/TRIX functions, but strategy authoring exports deserve a deliberate compatibility decision.

Current example:

```ts
const rawParams = source.params ?? source.parameters ?? source.bestParams;
const rawResult = source.result ?? source.backtestResult ?? source.metrics ?? source;
```

**Simplest alternative:** delete the uncalled adapter rather than improving its tolerant parser. Delete unused helpers and then any constants, types, and imports exclusively supporting them. For functions used inside their own module but never externally, make them private instead of deleting working behavior.

**Maintenance reduction:** estimated 20–35% of the affected helper/API maintenance. Avoid adding a permanent dead-code framework just for this cleanup. Preserve documented authoring APIs until compatibility is checked, and do not remove unused-looking disposal functions solely because current callers never remount a singleton.

**Verification:** source/test typechecks, built-in strategy smoke, Finder focused specs, and tests owning each retained helper family. Generate manifests only if strategy source changes require it.

## F5 — Consolidate overlapping hunt commands and eliminate broken defaults

[`alpha-sweep.ts:70`](../scripts/alpha-sweep.ts), [`massive-alpha-sweep.ts:102`](../scripts/massive-alpha-sweep.ts), and [`surgical-optimization.ts:47`](../scripts/surgical-optimization.ts) default to:

```ts
const DEFAULT_STRATEGIES = ['bear_hunter_v5', 'meta_harvest_v2'];
```

Neither key exists in the current generated 41-strategy manifest. Their execution paths select keys from the current eager library and throw when nothing remains. The commands therefore fail with their defaults before the main research work. Supplying current strategy keys can still make these tools useful.

The three scripts total **1,387 lines** and repeat CLI parsing, capital/execution capture, genetic config assembly, seeded runs and report shapes. `surgical-optimization.ts` also repeats number/boolean parsing already available in `scripts/lib/cli-args.ts`. Genetic hunt, walk-forward hunt and quality hunt extend the surrounding CLI surface; they should be assessed by workflow, not all declared equivalent.

**Simplest alternative:** keep one explicit sweep implementation and one documented output shape. Supply strategies explicitly and expose the few real distinctions—symbols, seed count, verification—as ordinary options. Delete the extra alpha/surgical entry points after moving supported behavior. Retain a separate walk-forward command if it implements a materially different validation workflow.

**Maintenance reduction:** approximately 40–60% in the overlapping sweep workflow. Three independently maintained argument/config surfaces become one. Prefer deleting commands over introducing a plugin system or universal command registry.

**Verification:** execute small offline fixtures with current strategy keys, confirm deterministic outputs and execution settings, and test argument errors before market loading. Current default failure is statically established; this audit did not fetch market data to run a hunt.

## F6 — Require the Rust backend to justify its entire ownership cost

Current flow, documented in [`backtest-engines-typescript-rust.md`](backtest-engines-typescript-rust.md):

```text
TypeScript generates strategy signals
  -> choose compatible backend
  -> serialize/upload/cache/request Rust over loopback HTTP
  -> validate/normalize results
  -> fall back to TypeScript if unavailable or unsupported
```

The Rust source contains roughly 7,045 lines, including a 3,177-line simulation engine and 1,889-line route implementation. The TS side adds a 1,025-line client, capability checks, setting sanitization, result validation, transport caches, executor branches, benchmarks and parity tests. CI maintains a separate Rust format/test/clippy job. Cargo has eight runtime dependencies plus two direct test dependencies.

The guide explicitly states the measured Rust-preferred Finder path is slower and that specialized paths were already removed. That does not prove every generic batch workload is slower. It establishes that "Rust is faster" is insufficient justification for the remaining system.

**Simplest alternative if the gate passes:** use the existing TS engine for all calls, remove the loopback service and Rust-specific branches/settings/UI, retire its protocol and dedicated parity maintenance, and remove the Rust CI job. Persisted Rust preference can become an ignored legacy setting; retain result/execution semantics.

**Gate:** compare identical signals, settings and candles on cold/warm single runs, large Batch runs, Finder universe, AO holdouts and required replay workloads. Include completion time, failures, peak memory and numerical parity. Recommend removal if TS preserves results and required workloads degrade by less than 5%, or if no current users need the backend. A language-level microbenchmark does not pass this gate.

**Maintenance reduction:** eliminate the second simulation ownership surface, HTTP protocol and Rust toolchain; approximately 60–85% of engine-integration maintenance in this area. Source savings are conditional and exclude retained TS behavior. No fresh speedup/degradation claim is made here.

**Verification:** long/short and affected execution-model regressions, endpoint/UI parity, Finder/Batch coverage, Rust preference settings compatibility, full CI and representative performance measurements before retiring the backend.

## F7 — Stop preserving private facade layouts just to keep tests unchanged

[`batch-backtest-service.ts:62`](../lib/batch-backtest/batch-backtest-service.ts) contains forwarding getters/setters and [`:454`](../lib/batch-backtest/batch-backtest-service.ts) contains one-line forwarding methods:

```ts
private get lastResults() { return this.batchRun.getLastResults(); }
private set lastResults(results) { this.batchRun.setLastResults(results); }
private async reattachToInProgressServerRun() {
    await this.batchRun.reattachToInProgressServerRun();
}
```

Comments explicitly mention keeping the regression-suite surface intact. [`batch-backtest-service-lifecycle.browser.spec.ts:90`](../tests/batch-backtest-service-lifecycle.browser.spec.ts) uses `function svc(): any { return currentService as any; }`. Tests assign internals, patch global DOM/fetch/storage, and invoke private wiring. The Finder lifecycle spec uses similar patterns. Finder's manager also wires a large callback bag into a controller whose dependencies include status, strategy selection, retention, diagnostics and DOM reads.

Splitting result stores, run lifecycle, and views is useful. Keeping a second private API that mirrors every owner is not.

**Simplest alternative:** call the owner directly within the composition root and delete forwarding that has no coordination logic. Test pure payload/selection functions directly, test controllers with their existing narrow dependencies, and keep a smaller integration suite for Run/Stop/reattach/disposal behavior. Use existing browser E2E coverage for actual DOM identity and focus. Do not rebuild Finder or Batch as another giant manager.

**Maintenance reduction:** approximately 25–40% of facade/test-layout coupling. Estimated additional test-scaffolding reduction is 800–1,500 lines; retain the behavioral assertions rather than deleting regression coverage to meet a line target.

**Verification:** Finder/Batch lifecycle specs, stale-tab Stop, Stop during preflight, persisted reattach, result publication, balanced-list busy gating, teardown, and browser smoke. Review forwarding one member at a time; some accessors perform real coordination and should stay.

## F8 — Share the repeated worker transport, not every scheduler

[`finder-universe-strategy-pool.ts:237`](../lib/finder/server/finder-universe-strategy-pool.ts) and [`finder-asset-opportunity-batch-worker-pool.ts:246`](../lib/finder/server/finder-asset-opportunity-batch-worker-pool.ts) repeat:

```ts
const worker = new Worker(workerPath, {});
let currentTask = null;
let termination = null;
const terminateWorker = () => termination ??= worker.terminate();
// matching task progress, one terminal callback, error/exit, stop, dispose
```

The roughly 90–105-line lifecycle implementations differ mainly in progress/completion payload conversion and run logging. They already share a sweep mechanism, so this is a concrete repeated implementation rather than a hypothetical generalization.

**Simplest alternative:** one small single-task worker runner with task-id matching and termination ownership. Leave strategy/holdout progress conversion and resource policy explicit in each caller. Do not unify TOP_MEAN scan pools, backtest pools, and trade-ledger pools just because all use workers; their reuse, reset, affinity and shard semantics differ.

**Maintenance reduction:** one place for worker crash/clean-exit/termination fixes, approximately 30–45% of transport maintenance. Add the shared helper only if total lines decrease and its contract stays smaller than the removed duplication.

**Verification:** worker fatal/exit, exactly one terminal result, cancellation inside synchronous simulation, termination drain, bounded concurrency, and existing Finder universe/AO parallel specs.

## F9 — Make worker execution failure explicit

[`server-worker-entry.ts:66`](../lib/server-worker-entry.ts) prefers a sibling JS file, otherwise bundles TS, and silently returns raw TS on failure:

```ts
try {
    return await bundleWorkerEntryWithEsbuild(sourcePath, options);
} catch {
    return sourcePath;
}
```

Its comments also document that source-file mtime/size memoization does not inspect imported dependency changes. A sibling JS file or process memo can therefore hide which source version a worker runs. Returning raw TS after a bundle error changes execution mechanism and tends to move the error farther from its cause.

**Simplest alternative:** retain content-addressed esbuild output and explicit pool lifetime pinning. Propagate bundle errors with the source path. Unless a supported deployment needs sibling JS selection, remove that path too. Simplify development memoization by resolving once per pool; measure before keeping another source-version cache. Update affected imported source between two fresh pools as a correctness check.

**Maintenance reduction:** fewer environment-specific startup/debugging branches, approximately 20–35% of resolver maintenance. Do not remove worker reuse itself: the maintained reuse benchmark reports 10–21% improvements, substantially beyond the proposed 5% deletion threshold.

**Verification:** fresh pool after entry and dependency changes, repeated candidates within one pool, standalone deployment fixture, readable bundling failure, and disposal after failed startup.

## F10 — Delete the single-valued strategy-kind abstraction

[`strategyRegistry.ts:51`](../strategyRegistry.ts) and [`:351`](../strategyRegistry.ts):

```ts
export type StrategyKind = 'standard';
export function getStrategyKind(_key, _strategy) { return 'standard'; }
export function getStrategyKindTitle(_kind) { return 'Standard strategy'; }
```

[`ui-manager.ts:199`](../lib/ui-manager.ts) still branches on whether kind is standard. Finder still attaches a kind value to every checkbox row. This is extensibility for categories that do not currently exist.

**Simplest alternative:** use the strategy description directly and remove kind-specific branching and unnecessary data attributes. Retain any still-needed styling as ordinary classes. Delete the type and both functions once callers and selectors are updated together.

**Maintenance reduction:** 100% of kind-specific logic. There is no current requirement for a category registry.

**Verification:** strategy dropdown/list rendering, selectors/styles referring to `strategyKind`, built-in loading, and DOM smoke.

## F11 — Delete metadata that is not an enforced contract

[`backtest-settings-dom-contract.ts:62`](../lib/backtest-settings-dom-contract.ts) includes:

```ts
interface BacktestDomSettingContract {
    legacyAliases: readonly string[];
    workerSupport: SettingSupportLevel;
    rustSupport: SettingSupportLevel;
    // actual DOM mapping, coercion, and read/write behavior...
}
```

Repository searches found `legacyAliases` and `workerSupport` only being defined and populated in this module; no consumer reads them. Real persisted settings compatibility is handled elsewhere. `rustSupport` is different: parity specs read it and enforce useful consistency with sanitization.

**Simplest alternative:** remove the two unused metadata properties and their assignments. Keep the DOM contract, parsers, `readFromSettings`, Rust parity metadata, and real migrations. Do not replace useful explicit mappings with a larger schema/configuration framework.

**Maintenance reduction:** less metadata to update or mistakenly trust, approximately 15–25% of metadata maintenance. Removing declared aliases is not permission to remove the real compatibility behavior.

**Verification:** settings compatibility/handler specs, Rust settings parity and DOM contracts.

## F12 — Remove internal compatibility import hops and the unused declaration-build surface

`strategies/backtest.ts` contains:

```ts
// Re-export from the new modular structure to maintain backwards compatibility
export * from './backtest/index';
```

`quick-view.ts` similarly just re-exports a service. The chain `strategies/index -> backtest.ts -> backtest/index` obscures the owner of runtime functions. Internal imports can be updated atomically. Some barrels are genuine feature entry points; those should remain.

`tsconfig.types.json` emits declarations for the whole app, scripts and workers. `build:types` is not part of CI, production build or deployment instructions, and package metadata does not declare a published type entry. It can leave stale declarations for removed features under the ignored `typings` directory. Those generated files are not maintained-source deletion savings.

**Simplest alternative:** import owner modules directly for selected redundant compatibility hops. Remove `build:types` and its tsconfig if no external consumer exists. Preserve the lazy metadata/loaders/eager manifests: they solve actual browser/server loading differences and are generated from one source.

**Maintenance reduction:** fewer navigation hops and one less undocumented build output. This is low ROI relative to F1–F7; do it while touching imports, not as a sweeping architecture campaign.

**Verification:** application/tests typecheck, built-in strategy smoke, browser build and entry-bundle budget, and Node-safe server imports. Do not count all tiny utilities or feature-local DOM contracts as redundant wrappers.

## F13 — Keep one runtime representation of each replay arm

[`arm-contract.ts`](../lib/batch-backtest/open-score-replay/arm-contract.ts) already defines the canonical arm map. Yet [`aggregation.ts:1538`](../lib/batch-backtest/open-score-replay/aggregation.ts) and the 902-line public types retain separate per-arm fields:

```ts
topRawProfitNow: buildComparison(topRawProfitNow.deltas, topRawProfitNow.returns, topRawProfitNow.times),
topMeanProfitNow: buildComparison(topMeanProfitNow.deltas, topMeanProfitNow.returns, topMeanProfitNow.times),
// many more arm-specific fields, breakdowns, and contributor fields
```

Other paths already build `comparisons[field]` and then copy them into legacy flat names. The same arm is represented through runtime arrays, keyed maps, historical flat fields, result serializers, snapshot compactors and Finder mappings. A new arm or metric requires changes in several places.

**Simplest alternative:** use one keyed internal object:

```ts
type ArmSummary = { comparison: ReplayComparison; /* retained breakdowns */ };
type ReplaySummary = { arms: Partial<Record<ReplayArmField, ArmSummary>> };
```

Iterate the existing canonical ordered arm list. Preserve historical flat wire/storage shapes in one boundary adapter until their compatibility window ends. Use fixed explicit stage functions; this proposal does not need an arm plugin/factory framework.

**Maintenance reduction:** approximately 30–45% of arm-shape mapping maintenance. Preserve floating-point accumulation order, tie resolution, seeded bootstrap order, scalar-only browser payloads, and deterministic output. Avoid merely moving duplicated mappings into another module.

**Verification:** replay deterministic fingerprint fixtures, independent ranking-sort parity, stream/snapshot round trips, Finder scoring and all relevant `sp500-top-mean-*` checks. If arms are retired under F14, do that first and reduce this refactor's scope.

## F14 — Put a maintenance budget on research variants

[`arm-contract.ts:2`](../lib/batch-backtest/open-score-replay/arm-contract.ts) defines seventeen primary arms, including six BOT variants, historical-profit look-ahead arms, and two newer support arms. Asset-switch adds a directional variant. [`aggregation.ts`](../lib/batch-backtest/open-score-replay/aggregation.ts) additionally maintains per-horizon controls, contributor exclusions, per-asset breakdowns, ongoing picks, portfolio experiments, ranking measurements and annual reports.

Current structure resembles:

```text
selector × horizon × replay mode × measurement × annual/global report × persistence recovery
```

Each distinction may be useful to research, but maintaining every combination indefinitely is an expensive product decision. The negative-findings guide explicitly retains OPEN_SCORE as a descriptive diagnostic, not a validated selector. That is a reason to bound the diagnostic product, not proof that every retained arm lacks value.

**Simplest alternative:** choose the currently used causal arms, one comparison control, and the report modes needed for ongoing studies. Remove unused combinations and their computation, contracts, UI, serializers and tests together. Preserve the selected study's counterfactual controls and leakage separation; deleting controls to make code shorter would undermine the diagnostic's purpose.

**Gate:** identify current workflows and consumers, compare the proposed smaller output against those tasks, and retire a variant when its loss accounts for less than 5% of required product value. No usage measurement in this audit supports an unconditional list of specific arm removals.

**Maintenance reduction:** estimated 25–40% of replay/research maintenance if the usage gate passes. This is an alternative to part of F13, not an additive savings claim. Keep study results and historical semantics; old result readers can preserve summaries and request a rerun for retired detail.

**Verification:** all retained-arm parity and scoring checks, archived-format compatibility through fixtures outside archive folders, full report/UI contracts and browser E2E. Do not reintroduce retired Mine/selection features.

## F15 — Require demonstrated use for every sizing and adaptive-exit model

The backtest types expose nine sizing modes. [`take-profit-settings.ts:15`](../lib/take-profit-settings.ts) accepts fixed plus eight nonfixed take-profit modes. These are implemented features, not dead code.

Examples of ongoing complexity:

- [`optimal-f.ts:47`](../lib/strategies/sizing/optimal-f.ts) searches 100 fractions, and secure-f bootstraps up to 500 samples. State updates can recompute those searches after trades.
- [`risk-parity.ts:26`](../lib/strategies/sizing/risk-parity.ts) takes one candle series and computes an inverse-risk sizing multiplier. It does not allocate a multi-asset portfolio; its name promises more architecture than its implementation supplies.
- [`adaptive-take-profit.ts`](../lib/strategies/backtest/adaptive-take-profit.ts) is 535 lines of histories, entry contexts, regime buckets and per-position state, coupled into entry/exit simulation.
- Sizing state is also replayed by Monte Carlo; UI, saved settings and backend-support policies add more representations.

Current secure-f example:

```ts
for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
    const resampled = sequence.map(value => trades[value % trades.length]);
    bootstrapFs.push(calculateOptimalF(resampled));
}
```

**Simplest alternative:** preserve fixed and percent sizing, standard ATR/percentage exits, and additional models with demonstrated current use. Retire unused experimental martingale/optimal-f/secure-f/risk variants and adaptive targets. If inverse-risk sizing is used, name it for its actual behavior rather than building a portfolio engine to justify the name.

**Gate:** inspect active saved configurations and research requirements with user authorization; do not assume model count measures value. Removal must preserve at least 95% of required workflows. Existing configurations must not silently acquire a different sizing or exit model; retain a compatible execution path until an explicit retirement/migration policy is established.

**Maintenance reduction:** approximately 30–50% of option-specific maintenance if the gate passes. Execution realism, normal stops/targets, and long/short behavior remain core requirements.

**Verification:** advanced sizing, Monte Carlo sizing, settings compatibility, long/short engine regressions, execution models, and remaining Worker/Rust support contracts.

## F16 — Retire Committee-only Worker behavior if its external consumers are gone

[`entry-signal-worker.ts:2646`](../workers/entry-signal-worker.ts) retains Committee alert rule routes, and its scheduled pass always attempts Committee processing after normal subscription evaluation:

```ts
if (request.method === 'POST' && pathname === '/api/committee-alert/rules') {
    return handleCommitteeAlertRulesUpsert(request, env);
}
// after normal subscription processing
await runCommitteeAlertPass(env);
```

It also serves batched cached state for a Committee overlay. Searches found no application client calling the rule routes or batched states route. The current live-positions client uses the single-subscription state endpoint. Committee upsert fields are absent from the current alert client's upsert type. Worker specs still validate Committee behavior, and Worker documentation labels the rule endpoint as internal tooling.

**Simplest alternative:** if that tooling is unused, delete Committee rules, Committee-only history/state projection and cron work. Keep ordinary entry/exit alerts, Telegram delivery, individual subscription state, authentication and deduplication. Retain existing deployed schema columns and historical migrations; avoid a destructive schema cleanup just to save a few lines.

**Maintenance reduction:** approximately 20–35% of Worker feature maintenance. This is an external-use check, not a dead-code conclusion. Endpoint callers and deployed rule usage must be established before deletion; do not send messages, query remote accounts, or deploy changes as part of this audit.

**Verification:** Worker/alert specs, current client endpoint behavior, migration-on-empty-database checks, and confirmed external API compatibility. Normal alerting requires an independent scheduled runtime and should not be collapsed into a laptop-only dev server.

## F17 — Make the supported setup and deployment product explicit

Current contracts conflict:

- README recommends Node 20+, while the eagerly registered SQLite plugin imports `node:sqlite`. CI actually tests Node 22.16.0. The package has no runtime engine declaration.
- [`vite.config.ts`](../vite.config.ts) registers server APIs in Vite plugins. A static Vercel build cannot supply Finder universe, Batch and local data routes merely by serving `dist`.
- [`DEPLOY_TO_VERCEL.md`](../DEPLOY_TO_VERCEL.md) explains a general app deployment without a prominent capability boundary. The Batch guide explains its server requirement, but that is a different onboarding path.
- [`workers/wrangler.example.toml`](../workers/wrangler.example.toml) schedules hourly, while the root config schedules every minute and the Worker comments describe minute-level execution. The example also omits the root config's explicit migration directory.

**Simplest alternative:** state the tested local runtime, pin/document it consistently, and document two actual deployment capabilities: local/server research and static chart/backtest UI. Align the Worker example with the intended supported schedule/migration path. Keep one canonical example; do not add a deployment configuration generator.

**Maintenance reduction:** setup/debugging burden rather than substantial LOC savings. Explicit metadata may add a few lines while removing ambiguity. This is justified because it prevents engineers debugging unsupported environments.

**Verification:** clean install/start on the documented runtime, static build behavior and clear unavailable-feature feedback, example config/documentation consistency. Do not claim a static deploy has server capabilities that are not built.

## Dependency decisions

The JS package is already small: two runtime and eight development dependencies. Dependency count is not the dominant complexity problem.

| Dependency or toolchain | Decision | Reason |
| --- | --- | --- |
| `lightweight-charts` | Keep | Core chart capability; replacing it adds ownership. |
| `undici` | Keep while Alpaca transport remains | Dynamically required for the IPv4/DNS dispatcher workaround; lack of a static import does not make it unused. |
| `vite` | Keep | Frontend build, local API host, lazy assets, development server. Ten plugins are mostly route modules in one Node process, not ten deployed microservices. |
| `typescript`, `@types/node` | Keep; align runtime expectations | Actual source/test safety. The Node type version and supported runtime deserve consistent expectations. |
| `esno` | Keep | Existing script/spec execution; removal needs an equivalent supported TS execution path. |
| `esbuild` | Keep | Directly used by the test runner and worker bundling, not merely a redundant transitive dependency. |
| `puppeteer` | Keep | Existing E2E exercises real DOM identity, focus and lazy features that fake DOM tests cannot establish. |
| `chai`, `@types/chai` | Keep existing coverage; avoid expanding dependency surface | Node assertions could remove these two dependencies, but a broad assertion rewrite is low ROI and does not itself reduce source or product complexity. Reassess during substantial test changes. |
| Rust crates/toolchain | Conditional removal with F6 | Useful only while the optional second backend earns its maintenance. Removing one incidental crate does not solve the duplicated backend. |

## Feature and architecture decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Chart, current backtest, trade/results views | Keep | Main product path. |
| Built-in strategy catalog | Keep current strategies; delete unused helpers | 41 current strategy keys, not an uncontrolled thousands-strategy source tree. Lazy and eager manifests are generated from the same authoring source. |
| Current-chart Finder, random/grid search | Keep | Central strategy exploration workflow. |
| Genetic search | Keep the algorithm; consolidate entry points | Actual Finder and CLI callers; duplication is around orchestration. |
| Server Finder, AO holdouts, Batch | Keep execution boundaries | Browser OOM history, scalar wire shapes, parallel work and reload recovery are concrete requirements. |
| TOP_MEAN / OPEN_SCORE | Keep a bounded descriptive workflow | Challenge variants, not the existence of every research diagnostic. |
| Opportunity Explorer / Rank Pairs | Keep pending usage evidence | Current routes/UI/callers exist. Feature names alone do not establish low value. |
| Walk Forward | Keep | OOS evaluation is a different task from in-sample optimization. |
| Current Monte Carlo | Keep | Seeded sequence/bootstrap/ruin diagnostics; remove unused old algorithm surface. |
| Data Mining / synthetic-pair generation | Keep current import/export/generation | Do not confuse this manager with retired Mine prediction features. |
| IBKR/Alpaca and crypto sync | Keep | Data source provenance, offline research and aggregation are real requirements. |
| SQLite, IndexedDB and bounded in-memory caches | Keep current ownership/budgets | Different storage/runtime purposes. Simplifying by deleting memory bounds can reintroduce crashes. |
| Normal alerts and live positions | Keep | Scheduled execution must survive browser/laptop inactivity. |
| Committee-specific Worker extensions | Conditional deletion | No current app client; possible external tooling. |
| Full test runner and validation routing | Keep | Per-spec isolation, complete failure logs, focused selection and timing history solve actual workflow needs. Remove tests for removed behavior, not evidence for retained behavior. |

The app is fundamentally a modular local application plus an optional scheduled alert worker and an optional Rust backend. It is not a conventional microservice estate. Replacing the many Vite route plugins with new network services would increase complexity.

## Delete First — highest ROI

1. **F1: five orphaned modules — 698 source lines.** Delete their exclusively obsolete specs and remove stale advertised contracts.
2. **F2: old Monte Carlo library — 388 module lines plus dormant types/settings.** Preserve the current engine and its behavioral coverage.
3. **F3: spread-quality engine/CLI — 951 source lines.** Preserve the negative research record and stop advertising an incompatible command.
4. **F4: internal uncalled adapters/helpers.** Start with Finder payload/progress adapters, duplicated settings extractors and unused volume metrics; decide authoring API compatibility before deleting exported indicators.
5. **F10/F11: one-valued kind API and unread metadata.** Small, low-risk deletions that remove misleading abstractions.
6. **F12: obsolete declaration build and selected compatibility barrels.** Do this alongside nearby changes; do not spend weeks reorganizing imports.
7. **F6: optional Rust backend, conditional.** Highest structural payoff if representative TS performance stays within the 5% tolerance.

Do not begin by deleting data caches, simulation guards, OOS evaluation, authorization, cancellation, or replay controls.

## Simplify First — highest ROI

1. **F5: one sweep CLI**, explicit current strategy keys, one output/config surface.
2. **F7: remove facade forwarding and implementation-coupled test scaffolding**, preserve controller ownership and observable regressions.
3. **F13: one keyed replay-arm runtime shape**, one compatibility boundary; perform after any arm retirements.
4. **F8/F9: one small worker transport, explicit bundle failures**, retain bounded pools and measured reuse.
5. **F17: one supported runtime/setup story**, explicit local/server versus static deployment capabilities and consistent Worker example.
6. **F14/F15/F16: reduce active feature variants only after usage review**, migrate intentionally and preserve current results and deployed schema.

## Keep As-Is — justified complexity

- **Shared TS full/compact simulation kernel.** The guide documents a shared loop; do not propose merging two already-merged kernels. Full versus compact result policy addresses actual allocation differences.
- **Execution realism and publication ownership.** Next-open timing, gap fills, stop/target ordering, cooldowns and stale-request rejection protect results. A revision counter that prevents change-away-and-back races is useful explicit state, not gratuitous architecture.
- **Server-owned long-running jobs.** Scoped run ownership, Stop handling, reattach polling, retention and artifact release are justified by long jobs and reloads. Batch's standalone analysis still has a distinct legacy Stop contract; do not erase its race protection while simplifying facades.
- **Worker reuse and memory-aware parallelism.** Maintained measurements report 10–21% faster reuse. Shard affinity, cache reset and worker termination protect performance and freshness.
- **Bounded candle/indicator caches, compact artifacts and columnar storage.** These are supported responses to browser/server memory limits. No recommendation assumes they can be removed within a 5% performance tolerance.
- **Pure server-safe data utilities and provider provenance.** Browser-bound imports into Vite's CJS configuration are a known failure mode. Existing shared loaders already removed concrete duplication.
- **Saved-settings envelopes and narrow compatibility readers.** Real users have saved configurations; delete obsolete behavior but keep intentional read compatibility and nonfinite-value handling.
- **Feature-local DOM contracts and real browser tests.** They bind runtime-injected partials to consumers and verify identity/focus. A single global DOM registry or full UI-framework rewrite is not justified.
- **Generated lazy/eager strategy manifests.** They provide different loading behavior from one authoring source and are only 628 generated lines. Do not replace them with handwritten registries.
- **Minimal shared state store.** `state.ts` is only 79 lines. A third-party state framework would increase the ownership surface; typed actions with actual invariants should remain.
- **Core scheduled alerts.** A remote scheduler has a concrete availability requirement independent of the local research app.

## Estimated total reduction

These are engineering estimates after overlap, not a sum of every finding's upper bound. Abstractions means removed named functions/classes/interfaces/factory or facade surfaces; it is an estimate, not a measured universal complexity unit. Build complexity refers to maintained build/test/deployment mechanisms, not promised elapsed-time improvements.

| Metric | Cleanup and retained-behavior simplification | Conditional feature/backend retirement, including cleanup |
| --- | --- | --- |
| Maintained source lines | **4,000–6,000**, about **2–3.5%** of 176,163 | **16,000–23,000**, about **9–13%** |
| Additional obsolete/test scaffolding lines | **1,000–2,000** | **4,000–8,000** |
| Total source + test lines | **5,000–8,000** | **20,000–31,000** |
| Named abstractions removed | **30–55** | **65–110** |
| Build complexity | **0–5%**; remove unused declaration output and redundant worker-loading paths | **25–40%** estimated; Rust CI jobs go from three total jobs to two, and the Rust compiler/protocol lifecycle disappears |
| Maintenance burden | **8–15%** estimated across affected workflows; fewer APIs/test-coupled seams | **20–30%** estimated, especially simulation integration and research option changes |
| Product preservation evidence | Current caller analysis supports no intended application behavior loss | Must demonstrate **95%+ required workflow value** and pass stated performance/API/configuration gates |

F1 and F3 provide an exact **1,649-line** source-module deletion opportunity. F2 adds **388** exact old-module lines, bringing the identified module total to **2,037**, before their exclusive tests, unused types, or further helpers. The larger cleanup estimate includes net refactors and is deliberately approximate.

Do not double count F4's unused Rust helpers if the entire backend is removed. F14 replaces part of F13, rather than adding its whole savings to the refactor. Shared helpers and tests are retained when any current feature still needs them. Generated files, archive folders and market data contribute zero maintained-code savings to these totals.

## Validation performed and follow-through

Baseline checks completed successfully:

- `rtk --version`: 0.51.0. Execution runtime: Node 22.16.0.
- `rtk git status --short`: clean at audit start.
- `rtk proxy npm.cmd run validate:changes`: clean initial worktree, no checks selected.
- `rtk proxy npm.cmd run typecheck`: passed.
- `rtk proxy npm.cmd run typecheck:tests`: passed.
- Focused specs for backtest result analysis/context, latest entry export window, signal merge and spread quality: **5 passed, 0 failed, 0 skipped**.

The initial audit changed no production code and added only this report. Its
baseline checks did not include the full JS suite, browser E2E, Rust suite,
production build, or fresh performance/usage studies. The implementation status
above and maintenance log record the subsequent cleanup and checks. No
dependencies were installed, manifests regenerated, or external actions taken.

Execute removals in small batches following the owning guide and `validate:changes`, adding semantic checks beyond its advisory selection. For retained behavior, verify deterministic outputs and lifecycle boundaries. For conditional removals, establish usage, compatibility and performance first. Finish implementation with the repository's required CI/E2E/Rust policy for the remaining product.
