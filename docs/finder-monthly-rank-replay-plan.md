# Finder Monthly Rank Replay — Technical Plan

Status: **implemented** (all five phases). See the deviations log at the bottom of this document.

## Scope and decisions

Implement the [Monthly Rank Replay blueprint](finder-monthly-rank-replay-blueprint.md) as a submode of Symbol Universe. At each monthly checkpoint, select rank #1 independently for every existing historical Universe sort, then measure each distinct winner over H forward bars. Changing configurations are expected. Each sort summarizes its own valid checkpoints with explicit coverage counts.

Keep From year, evaluation bars L, and forward bars H as the only new numerical inputs. Use one frozen seeded candidate pool, fixed-dollar sizing, TypeScript execution, and the existing server job lifecycle. Replay all 15 current historical Universe sorts; exclude OOS-dependent Window Stability Score. No new ranking formula, baseline, portfolio simulation, worker pool, database, or service is needed.

The user flow is small. The necessary shared-code change is an opt-in scored-range contract: preserve indicator warmup while starting account state and statistics at the declared boundary. Prove that contract before wiring the UI.

Assumptions carried from the blueprint:

- UTC month boundaries; fully closed historical candles; fixed symbol set; L/H are scored bars per symbol, not calendar durations.
- Both signal origin and resolved execution bar must be in the scored range. Start flat, include idle scored bars in metrics, and liquidate at its final close with commission/slippage.
- Synthetic outcomes use the existing pair-neutral transform. Missing/failed results are unavailable; successfully evaluated no-trade results are zero.
- Unsupported settings are reported explicitly. Engine choice and scored-range controls are runtime inputs, not additions to persisted global backtest settings.

## Existing architecture and affected seams

| Existing location | Relevant behavior and intended change |
| --- | --- |
| [Finder manager](../lib/finder-manager.ts) | Owns UI normalization, `runUniverseFinder`, `runUniverseFinderServer`, active-run persistence, reattach, render/copy dispatch. Add submode/report handling here without reorganizing the manager. |
| [Finder server plugin](../lib/finder/server/finder-vite-plugin.ts) | `handleRunRequest` parses `/api/finder/universe-run`; `acquireFinderRunOwnership`, `withFinderRunStream`, Stop and status already implement job ownership. Add a replay dispatch branch using these same helpers. |
| [Universe runner](../lib/finder/finder-runner-universe.ts) | `buildUniverseCandidatePlans` already samples normalized entry/exit configurations. The evaluation loop has sort-dependent analytics, partial-candidate handling, and bounded survivors; reuse candidate construction, not the ordinary loop's result list. |
| [Universe metrics](../lib/finder/finder-universe-metrics.ts), [Finder constants](../lib/finder/constants.ts) | Reuse metric formulas/labels. Share the existing sort-key list and direction predicate with replay; avoid a second hardcoded registry or changes to ordinary comparator semantics. |
| [Executor](../lib/backtest-executor.ts), [engine](../lib/strategies/backtest/backtest-engine.ts), [signal preparation](../lib/strategies/backtest/signal-preparation.ts) | `executeBacktest` passes one data timeline to signal preparation and simulation. `blockRange` slices before signal generation. Add an explicit scored-range option while preserving the prefix for indicators. |
| [Server Finder loader](../lib/finder/server/server-finder-data-loader.ts), [shared loader core](../lib/batch-backtest/batch-dataset-loader-core.ts) | Reuse `loadServerFinderDataset` and existing cache/data caps. Preserve `buildSyntheticPairFromLegs` from [synthetic-pair utilities](../scripts/lib/synthetic-pair.ts); no separate pair pipeline. |
| [Stream contracts](../lib/finder/server/finder-stream-types.ts), [Finder types](../lib/types/finder.ts) | Add replay-specific report/events and terminal status fields; retain scalar-only transport. |
| [Finder markup](../html-partials/tab-finder.html), [DOM contracts](../lib/finder/finder-manager-dom.ts), [Finder UI](../lib/finder/finder-ui.ts) | Add submode controls and a report-render branch using existing elements/styles where possible. |

Only small feature-local modules are proposed: a pure replay model/calculation module, a monthly runner, and a report renderer/formatter if adding the table directly to Finder UI would obscure it. Do not introduce a runner framework. New names below describe proposed additions, not existing APIs.

Target flow:

```text
Finder controls → existing POST /api/finder/universe-run → existing owner/stream wrapper
  → frozen options/candidates + loaded-range report
  → each month: causal inputs → historical evaluations → one winner per sort
  → distinct winners' forward evaluations → scalar monthly records + per-sort summaries
  → NDJSON / existing status reattach → Finder report and Copy Results
```

## Phase 1 — Define replay contracts and pure ranking/report calculations

**Objective:** represent the experiment without changing ordinary Finder behavior.

**Tasks**

- Add optional `FinderOptions.monthlyRankReplay = { fromYear, evalWindowBars, forwardBars }`, accepted only with `scope: "symbol_universe"`. Absence means ordinary Universe. Validate integer year and positive integer L/H; reject malformed explicit replay options rather than falling back silently.
- Define a report with frozen experiment metadata, data coverage, per-sort summaries, and monthly selection/outcome records. Each record identifies checkpoint, sort key/direction, complete configuration, historical score/contributor counts, status/reason, and scalar per-symbol bounds/return/trade counts. Record excluded OOS-sort reasons.
- Add a replay variant to `FinderLatestResults`, distinguished by `scope: "symbol_universe", mode: "monthly_rank_replay"`; standard Universe accepts absent/standard mode. Update type guards at affected consumers, not the top-level scope dropdown.
- Move the existing `UNIVERSE_SORT_OPTIONS` list from the browser manager to the existing leaf constants module, importing it back unchanged. Expose the existing ascending-direction predicate or an equivalent shared function beside Universe metrics. Replay removes only OOS-dependent keys.
- In a proposed `lib/finder/finder-monthly-rank-replay.ts`, implement metric-specific availability, one best-candidate slot per sort, stable full-identity ties using existing `stableStringify`, and per-sort summary arithmetic. Preserve Robust Universe Score's ordinary single-sort PF fallback even when CER is computed for another row.
- Reuse `serializeJsonPreservingNonFinite` / `parseJsonPreservingNonFinite` from [JSON utilities](../lib/json-utils.ts). The existing HTTP/NDJSON helpers already use them. No new infinity encoding is needed; the blueprint's tag example is satisfied by this codec.

**Deliverables / dependencies:** typed options/report and pure ranking/summary functions. No execution dependency.

**Risks:** unavailable analytics currently appear as zero in some ordinary aggregates; replay must carry availability separately. Do not introduce an all-sort common-month intersection.

**Validation / exit criteria:** new focused replay spec proves every historical sort's direction/formula, missing-value handling, infinity round-trip, full-identity ties, deduplicated winners, equal-symbol/equal-window arithmetic, losses/zeros, and per-sort denominators. Existing Finder constants/metrics specs remain unchanged in meaning. `npm run typecheck` passes.

## Phase 2 — Prove and add the scored-range execution contract

**Objective:** run warmed indicators with a fresh account over exactly L or H scored bars.

**Tasks**

- Add an optional runtime scored range to executor `backtestRunOptions` and engine `BacktestRunOptions`. Resolve its boundaries against the cleaned/aligned timeline using existing time helpers. Reject unresolved boundaries; do not silently shift them after cross-symbol trimming.
- Pass only the causal prefix ending at the scored end into strategy/confirmation/exit preparation. Preserve its earlier bars for `resolveIndicatorsFromConfig`; filter original merged signals by the scored start before `prepareSignals` shifts execution. Check resolved fills against the range too.
- Keep array indices on that same timeline and start the existing standard simulation loop at the scored-start index. Initialize capital, positions, learning state and statistics there; retain flat scored equity samples. Do not simulate historical positions and subtract their PnL afterwards.
- Initially route scored-range calls through `runBacktest` with `useCompactBacktest: false` and explicitly bypass `getSinglePositionFinderFastPathBlockers`' fast path when a range is present. This avoids adding the range to every optimized loop. Preserve normal fast/compact behavior when absent. Thread the range through combined-direction execution if supported; otherwise reject that specific mode explicitly before search.
- Apply direction-correct terminal slippage and commission only for the new range path. Keep ordinary end-of-data defaults intact. Collect the full scored trade history needed for pair-neutral/edge metrics, then release it after scalar reduction.
- Force `context.engineMode: "typescript"` on replay calls. Do not add Rust range support or mutate shared settings/sanitizers to disguise an unsupported request.

**Dependencies / deliverable:** Phase 1 boundary/report definitions; an opt-in range implementation through the existing engine, not another engine.

**Risks / blockers:** signal shifts, strategy-timeframe resampling, indicator indices, risk/exit learning and combined execution can retain the wrong history. No universal warmup-readiness contract exists in `Strategy`; enforce actual declared alignment/minimum requirements and report available warmup, without inventing a blanket guarantee. Establish the supported settings matrix with fixtures before proceeding.

**Validation / exit criteria:** a proposed scored-range executor spec proves historical and forward boundaries for long/short/both and all three fill modes; last warmup signals excluded; pre-trade flat bars included; terminal costs/open losses included; no fill after H; full-range execution unchanged with range absent. Run existing backtesting-engine and compact-parity specs plus cancellation/cross-symbol specs when those seams change. This phase must pass before the monthly search is wired.

## Phase 3 — Implement causal monthly evaluation and data coverage

**Objective:** produce the complete report server-side from one frozen candidate pool.

**Tasks**

- Add proposed `lib/finder/finder-monthly-rank-replay-runner.ts` with injected dataset/provider access, cancellation/progress callbacks, and strategy inputs, matching the existing runner style. Expose/reuse the current pure `buildUniverseCandidatePlans` and its normalization/risk helpers with minimal export changes; generate and deduplicate plans once per run.
- Use the existing loader to determine actual target/auxiliary coverage and checkpoint feasibility before expensive evaluation. If seed coverage is not exposed, add optional source-range metadata to the existing loader result/context; do not create a second loader or raise caps. Expose insufficient history, alignment failures and incomplete H horizons.
- Build separate immutable historical and forward views per month, using explicit close-boundary times. Reuse existing interval/time helpers. For cached synthetic targets, prove closed-bucket truncation matches truncating seeds before the existing aggregation. If that proof fails for a supported path, add the necessary cutoff to the existing load/build context, include it in cache identity, and keep ordinary loading unchanged.
- Keep raw reuse within job/loader budgets. Any prepared-data reuse must be scoped to phase/month, effective settings and auxiliary identity; the existing `getPreparedFinderData` array-key cache alone does not establish that. Start with ordinary strategy execution where prepared reuse cannot be proven safe.
- For each month, evaluate candidates across all fixed symbols; reject incomplete candidates and disable ordinary early exits. Compute required analytics from each shared base run. Reuse the existing `forceDisableSignalExits` control-run pattern and `computeExitAlpha` for Exit Alpha, within the same scored range. Preserve metric-specific availability and optional-diagnostic failure handling.
- Select one winner per sort, forward-test distinct identities only, and reduce through `buildFinderPairNeutralMetrics` where required. Freeze identities before reading outcomes. Keep valid losses/no-trades; expose failures without replacing winners. Release trades, equity and phase views as soon as their calculations finish.

**Dependencies / deliverable:** Phases 1–2; a testable monthly runner returning only report scalars and bounded diagnostics.

**Risks:** current target caps may exclude the requested year; mutable source reloads can spoil reproducibility. Freeze loaded arrays/source fingerprints for the job and surface changed sources if evicted data must be reloaded. Optional edge/Exit Alpha calculations add real cost; shared execution does not make all sorts free.

**Validation / exit criteria:** runner fixtures mutate post-checkpoint primary, auxiliary and seed data without changing historical winners; find a winner outside another sort's top-N; reject partial candidates; retain losers; reuse identical forward winners; verify pair-neutral accounting and missing/incomplete windows. Extend loader parity tests only if loader contracts change. Report matches independently computed fixtures for at least two months and multiple sorts, including drawdown and a composite metric.

## Phase 4 — Integrate with the existing Finder server lifecycle

**Objective:** make replay cancellable and reload-recoverable through existing local routes.

**Tasks / contracts**

| Surface | Additive change |
| --- | --- |
| `POST /api/finder/universe-run` | Detect validated `options.monthlyRankReplay` in `handleRunRequest`; dispatch the new runner inside existing ownership/`withFinderRunStream`. Reuse canonical top-level symbols and heap checks. Bypass ordinary data-slice/OOS processing and Rust capability probing for replay. |
| NDJSON | Add typed replay start/progress/checkpoint/done events to `AnyFinderStreamEvent`. Checkpoint records are scalar only; done carries the authoritative report, including partial completion status when stopped. Reuse fatal handling. |
| `GET /api/finder/status?runId=...` | Add job kind `monthly_rank_replay` and optional `terminalReplay`. Running polls return counts/progress; terminal done/cancelled/fatal snapshots retain the available report and error. Never put replay records in `terminalCandidates`. |
| `POST /api/finder/stop` | Reuse existing runId ownership, abort controller and pending-stop race handling. No new stop route. |

Extend the module-scoped run snapshot and status serializer alongside stream types. Reuse existing research-workload reservation/release, `finally` cleanup, disconnect-safe writes and run ownership. A browser disconnect leaves a recoverable run executing. Completed scalar records remain accessible through status until normal state replacement/process shutdown; do not add an artifact store.

**Dependencies / deliverable:** Phase 3 runner; replay available through the existing local server API.

**Risks:** dispatch must happen before ordinary Universe slicing/Rust setup; adding a new result kind can break reattach/terminal-failure handling. Bound retained report size by checkpoint/sort/symbol counts and deduplicate per-symbol outcomes shared by sorts. Preserve existing heap admission checks; measure report memory as well as OHLCV memory.

**Validation / exit criteria:** extend `tests/finder-server-plugin.spec.ts` for authorized/unauthorized replay requests, invalid options, canonical symbols, concurrent run rejection, Stop-before-ownership, cancellation, disconnect/status recovery, terminal failure and forbidden arrays. Test infinity through actual NDJSON/status helpers. Ordinary Universe/Asset Opportunity server tests pass, and Vite starts without browser-bound import errors.

## Phase 5 — Add Finder controls, report display, copy and recovery

**Objective:** expose the experiment with a small UI and consistent output.

**Tasks**

- Add submode, From year, L and H controls to the Finder partial and typed DOM contracts; hide irrelevant ordinary controls without modifying saved ordinary values. Default the submode to ordinary Universe. Extend `normalizeFinderUiState` and the existing `finder.ui` persisted JSON normalization with optional/defaulted replay fields.
- Add manager dispatch/events and report adoption. Persist the replay job kind with the active run before fetch; extend active-run migration, `reattachToActiveServerRun`, recovery and terminal handlers. Every callback retains the existing active-runId guard.
- Render one summary row per historical sort and simple monthly details, using existing labels/styles. Expose unavailable-sort reasons, each row's denominator, coverage and actual engine. Share a feature-local formatter between displayed details and existing Copy Results; no new Apply behavior.
- Extend result-snapshot handling deliberately: ordinary compaction truncates candidate/symbol counts and must not truncate a replay silently. Persist only replay metadata/summary and server runId in the existing latest-results envelope; recover full detail from the existing status snapshot after reload. If that server state is gone, label detail unavailable and allow copying only the identified summary. Do not promise permanent report storage or put the full multi-month symbol report in localStorage.
- Update `docs/finder-server-side.md` with the submode/contract and add a short usage entry in README when implementation lands. No Worker/deployment documentation changes are needed.

**Dependencies / deliverable:** Phase 4 transport; usable submode, summary/detail, Copy Results and reload recovery.

**Risks:** a legacy result snapshot must restore ordinary mode; summaries must not imply identical-month comparisons across sorts with different coverage. Controls must disclose fixed sizing/TypeScript requirements before Run.

**Validation / exit criteria:** update feature DOM, result-snapshot and Finder lifecycle browser tests; add report-render/copy fixtures. Run `npm run typecheck` and `npm run typecheck:tests`, then the focused replay, engine, Universe, server, loader, snapshot and DOM specs. Manual smoke: small dataset with two independently checked months; confirm all historical sorts, copy parity, incomplete coverage, Stop and reload during/after run. Repeat with a representative larger universe to confirm cancellation and bounded memory. No skipped or failed required check may be reported as passing.

## Operations, security and rollback

- Runtime remains the local Vite Node server. Static-only deployment remains unsupported. No database/schema migration, Cloudflare Worker, background service, scheduler, thread pool or deployment resource is added. Persistence changes are additive normalization of existing localStorage envelopes.
- Keep `registerLocalJsonRoute` authorization/body limits, shared workload ownership and canonical-symbol/heap validation. Validate replay options on the server even though controls validate them. Use existing scalar stripping/assertion patterns for all report paths.
- Preserve existing data/cache caps. For large server runs retain the repository's `NODE_OPTIONS=--max-old-space-size=16384` guidance; this is not permission to enlarge caches. Track base evaluations, Exit Alpha control work, distinct forward evaluations, and peak retained report/data footprint.
- Validation errors fail before execution where possible. Missing coverage produces unavailable checkpoints; candidate-specific failures exclude that candidate; optional metric failures affect only dependent sorts; infrastructure failures retain an explicit fatal/partial report. Cancellation never becomes successful completion.
- Rollback by disabling/removing the replay dispatch and UI submode. Absent replay options and absent scored ranges keep existing behavior. No data migration needs reversal; legacy readers can ignore new optional settings. Revert the opt-in engine change only if it regresses ordinary paths, using the engine regression fixtures as evidence.

This document was the implementation plan. Implementation status and deviations:

## Implementation notes and justified deviations

- **Moved sort registry**: `UNIVERSE_SORT_OPTIONS` now lives in `lib/finder/constants.ts` (the leaf module the plan targeted); the browser manager imports it back unchanged.
- **Cross-symbol strategies rejected in v1**: the plan allowed threading causal auxiliary views; the smallest correct decision was to reject cross-symbol entry/exit strategies explicitly (auxiliary fetches cannot be checkpoint-truncated without loader changes), per the blueprint's "fail explicitly before search" rule.
- **Combined trade direction rejected** with a scored range (as the plan allowed), long/short/both supported.
- **Forward outcomes are deduplicated per (checkpoint, identity)** and stored once in `report.forwardOutcomes`; per-sort `selections` reference them by index — this is the plan's "deduplicate per-symbol outcomes shared by sorts".
- **Identity key** covers entry strategy + normalized params + exit identity. Resolved risk overrides are excluded because they are a pure function of the frozen settings plus those params within one run.
- **Synthetic pairs**: the runner truncates the loaded pair series at complete aggregate buckets; commutation with truncating seeds before aggregation is proven by a fixture against `aggregateSyntheticBars` (fixed epoch-grid buckets read only in-bucket seeds).
- **Snapshot envelope** persists experiment metadata + per-sort summaries only (detail flagged `detailUnavailable`); full detail recovers from `/status` while the server retains the run.

## External-audit fixes (post-implementation)

- **F1**: replay option validation moved BEFORE run-ownership acquisition — a malformed request 400s without touching the owner lock (previously it leaked the lock and 409-bricked all Finder runs until restart). Route tests now pin the placement via `getRunOwnerForTests`.
- **F2**: the Robust Universe Score row is recomputed with its ordinary single-sort dependency (PF fallback, `computeReplayRobustUniverseScore`) so always-computing CER for the edge sort cannot silently change this row's ranking formula. The previously tautological test was replaced with a discriminating fixture.
- **F3**: the terminal `replay_done` report and `/status` `terminalReplay` are scalar-asserted (`assertReplayReportIsScalar`), matching the checkpoint-event guard.
- **F4**: a fatal escaping the monthly loop carries the partial report (fatal-flagged, summaries finalized) on the error; the plugin adopts it onto the snapshot so `/status` recovery keeps completed checkpoints.
- **F5**: forward window bounds are the min/max union across symbols instead of the first symbol's bounds.
- **F6**: the forward-window convention now discloses that on intervals not aligned to the month boundary the first forward bar may open before the boundary (no pre-boundary fill price is used).
- **F9/F11/F12**: scored backtests skip advanced performance analytics; selection `exitStrategyParams` is the params object (matching outcomes); empty summary rows say "no valid observations".
- F7/F8 noted as documented behavior (the discarded Rust-mirror argument; zero-signal runs skip boundary validation by construction).
- **Exact random-choice baseline (user-directed addition, 2026-09-11)**: for
  each sort, every historically eligible configuration is measured forward at
  each checkpoint (each distinct configuration once, outcome shared across
  sorts); random mean = equal-weight pool mean (winner included); excess =
  top-1 − random, computed from paired monthly observations. Comparisons are
  unavailable when any required outcome is missing (pools never shrink to
  survivors) and uninformative below two eligible configurations. Nonwinner
  outcomes are reduced to transient server-side scalars and never shipped.
  This supersedes the blueprint's "no all-candidate forward baseline in v1"
  line for this implementation. Forward-evaluation cost grows from distinct
  winners to the union of all sorts' eligible pools per checkpoint.
- **Point-in-time symbol membership (user-directed override of blueprint §5's
  strict fixed-symbol rule, 2026-09-11)**: symbols with insufficient scored
  history, an incomplete forward horizon, or a failed load are excluded from
  a checkpoint instead of making it unavailable, and the schedule spans the
  overall data extent. Fully disclosed, never silent: each checkpoint record
  carries `retainedSymbols` plus named `excludedSymbols` with reasons; Copy
  Results and the UI's Data coverage section repeat them; the report's
  accounting convention states that window means use the checkpoint's
  retained set. Window-return composition can therefore vary across months —
  the per-checkpoint counts exist precisely to make that visible.
- New tests cover the previously untested load-bearing paths: per-symbol run-failure → completeness-gate exclusion, forward no-trade windows at exactly zero, forward-failed with the winner preserved, a synthetic pair exercised end-to-end against an independent prefix backtest, insufficient-history From years, and a fatal mid-run partial report.
