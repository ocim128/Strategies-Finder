# Fresh-Window Research Infrastructure (3 Experiments, One Batch) — Implementation Plan

Status: PLANNING, REVISED (amendment pass after audit)
Revised: 2026-08-23 — incorporates all seven required amendments from
`archive/asset opportunity/Decision Rule Research/agent-plan-audit-2026-08-23.md`.
Authoritative research spec: `archive/asset opportunity/Decision Rule Research/research-agenda-2026-08-23.md`
Predecessor (implemented): `docs/finder-asset-opportunity-pair-summaries.md`

## Goal and separation contract

Run the agenda's three pre-registered experiments — time-to-TP, cross-fold
recurrence, and the strategy-coverage gate — from captured data on the fresh
window, with all fresh-program artifacts written to a SEPARATE archive
namespace so nothing mixes with legacy `archive/asset opportunity` outputs.

## Corrected architecture facts (audit-verified; supersedes prior draft)

1. **The full evaluated candidate pool never reaches the archive tail.** Each
   strategy's IS search returns only `topKRanker.toSortedArray(options.topN)`
   (`lib/finder/server/server-asset-is-search.ts:1074-1085`); the full
   `paramSets.length` is reported as `totalCandidatesEvaluated` and discarded.
   `iteration.results` are retained rows only. Any "full-pool" control,
   identity set, or path scalar MUST be captured inside the IS search, before
   the ranker discards.
2. **`oosHorizonMetrics` is optional and winner-only**
   (`lib/types/finder.ts:424-430`; attached at
   `lib/finder/finder-asset-opportunity-runner.ts:1191` in the winner path).
   There are no forward outcomes for the full pool today.
3. **The in-search candidate loop runs `compact: true, trades: false`**
   (`lib/finder/finder-asset-candidate-execution.ts` via
   `server-asset-is-search.ts:448-482`). Trade-path scalars (time-to-TP) must
   be computed there, with trades requested at that call or derived from a
   compact path summary the executor already produces — verify which, then
   reduce to scalars before returning from the search.
4. **`calculateFinderAssetOosSignalMetrics` lacks the execution contract** —
   no TP/SL levels, costs, same-bar policy, or exit semantics
   (`lib/finder/finder-asset-opportunity-oos.ts:59-83`). A censored outcome
   must be derived from the resolved run settings through a seam shared with
   the engine (see Phase 3), not bolted onto this function's current args.
5. **Folds are NOT point-in-time today.** A holdout sweep changes
   `oosIgnoreLastBars` at one current data end; it is not a sequence of
   historical calendar snapshots. Recurrence from unsliced sweeps is invalid
   by definition (agenda + audit A5).
6. **`researchProgram` has no production path.** The browser POST
   (`lib/finder-manager.ts` batch request) sends no such field; unknown body
   fields are ignored server-side. A reachable path must be built (Phase 0).
7. **Counts**: holdouts 12..300 inclusive = **289 folds**; judged stride-12
   windows = **25**. Prior draft's 294/45 MB figures were wrong; identity-file
   size must be benchmarked, not estimated (Phase 2 exit criterion).

## Phases

### Phase 0 — program separation WITH a reachable production path

Objective: the operator can start a fresh-program batch from the browser; its
artifacts land in a separate namespace.

Tasks:
1. Minimal UI: one checkbox in the Finder AO panel ("Fresh-window research
   mode"). Follow the full DOM contract procedure from AGENTS.md (partial +
   feature-local `*-dom.ts` contract + handler + `feature-dom-contracts.spec.ts`).
   The checkbox persists in Finder UI state like neighboring toggles.
2. Thread `researchProgram` through `FinderManager`'s batch POST body; validate
   server-side in `prepareAssetOpportunityRunPayload` against a fixed
   allowlist (`"fresh-window"` initially); invalid → 400 BEFORE ownership.
3. Archive namespace: `resolveAssetOpportunityArchiveDir(root, program?)` —
   absent program = exact legacy behavior; allowlisted program →
   `<root>/archive/<program>`. Legacy analyzers keep pointing at the legacy
   root (no `root` reinterpretation).
4. Terminal snapshot + config record the program so `/status` reattach and
   post-hoc audit can identify the program after reload.

Dependencies: none. Risks: UI change obligations (DOM contracts) — accounted.
Deliverables: toggle + threading + resolver + tests (legacy default, fresh
path, invalid name, path-traversal attempt rejected).
Validation: typecheck; feature-dom-contracts spec; finder-server-plugin spec
additions. Exit criteria: a fixture batch from the UI-flagged request writes
ONLY to the program namespace.

### Phase 1 — point-in-time fold contract (prerequisite, not deferred)

Objective: a fold is a declared calendar boundary; runs can be executed AS OF
a historical or current boundary.

Tasks:
1. Add a validated `foldEnd` (last usable candle timestamp) to the run
   contract; the loader serves data truncated at `foldEnd` for BOTH search and
   candidate metrics; forward outcomes begin strictly after it. Reuse the
   dataset-slicing mechanism the Universe path already has
   (`sliceFinderDataWindow`) — do not invent a second slicer.
2. Record `foldEnd`, search window end, OOS start/end, data-sync snapshot
   reference, and git commit (injectable; fixed value in tests) in every
   block envelope and in `config.txt`.
3. Leakage test: a fixture fold whose data contains candles after `foldEnd`
   must fail loudly (loader or iteration guard), not silently truncate.

Dependencies: none (parallel with Phase 0).
Risks: highest engineering risk in the plan; loader semantics must not change
legacy behavior when `foldEnd` is absent.
Deliverables: fold contract + guard + tests.
Validation: unit + fixture tests incl. the leakage case.
Exit criteria: two fixture runs at different `foldEnd` values produce provably
disjoint forward windows from identical raw data.

### Phase 2 — full-pool capture at the IS-search source + bounded worker protocol

Objective: identity + scalar fields for EVERY evaluated candidate survive to
an archive artifact, without unbounded arrays crossing the worker boundary.

Tasks:
1. Inside `server-asset-is-search.ts`, before the ranker, reduce each
   evaluated candidate to a fixed scalar summary row: identity hash of
   `(symbol, strategyId, candidateFingerprint)`, the path scalars
   (`tpHitCount`, `medianBarsToTP` with ≥3-TP floor, `medianBarsToTerminal`,
   `tpFirstShare`), in-search `netProfitPercent`, and — once Phase 3 lands —
   the censored forward scalars. No arrays retained.
2. Bounded transport: worker tasks emit scalar summary CHUNKS (fixed size,
   ordered) to the main thread alongside existing messages; the ordered writer
   assembles them. Alternative (worker-local artifact + validated handoff) is
   explicitly the fallback if benchmarks disprefer clones. Either way this is
   a worker-protocol change — planned, tested, and budgeted, not denied.
3. Archive artifact: `oos-fold-identities-<N>-bars.txt` with the SAME block
   envelope discipline as existing files (Timestamp, Batch run id, fold id,
   declared row count, then rows; single atomic append; fatal on failure;
   a re-run block supersedes by latest-timestamp like every other file).
4. Memory/size gate: benchmark a real-shape fold (row width × evaluated
   count) BEFORE committing to the transport shape; record the number in this
   doc. 289 folds per batch at the benchmarked size must fit the documented
   AO memory budget (AGENTS.md).

Dependencies: Phase 1 (fold identity in the envelope), Phase 3 for censored
fields (can land in two steps: identities first, censored second).
Risks: structured-clone volume; ordering across workers; Rust-engine path
parity — decide up front: implement equivalent scalars in the Rust batch path
or PREREGISTER that fresh-window runs disable Rust (config-recorded).
Deliverables: capture + protocol + artifact + benchmarks + tests (chunk
order, collision resistance via tuple hash, atomic append, supersede).
Validation: typecheck; worker-pool spec extension; archive spec extension.
Exit criteria: a fixture batch's identity file round-trips the exact evaluated
tuple set with the declared row count, and the benchmark is recorded here.

### Phase 3 — execution contract for censored (execution-unit) forward outcomes

Objective: the recorded forward outcome IS the declared trade, computed with
engine semantics — not a second simulator that drifts.

Tasks:
1. Define the contract in one place: resolved TP/SL levels (after Finder risk
   overrides), direction, `next_open` entry, `allowSameBarExit=false`
   same-bar ordering, stop overshoot fill treatment, slippage + commission
   charged exactly once, missing-bar policy, and exit-reason naming reused
   from the engine (`take_profit`/`stop_loss`/`end_of_data`) — normalized to
   the agenda's `tp`/`sl`/`horizon` labels ONLY at the analyzer edge.
2. Implement as a pure function sharing the engine's exit rules (extract or
   reuse the engine's exit evaluation rather than re-deriving it), fed by the
   resolved settings; call it for every candidate summary row at capture time
   (Phase 2 site) so the FULL pool carries censored outcomes, and the
   deterministic seed-42 random control draws from it.
3. Fixture tests (all mandatory, executable, hand-computed): next-open entry
   price/time; TP-first and SL-first on separate bars; TP and SL touched in
   the SAME bar under the locked ordering; stop overshoot and exact fill/cost;
   horizon censoring and missing bars; costs charged once; long/short parity;
   parity with the actual TS engine (and the Rust path per the Phase 2
   decision).
4. Keep the price-only horizon fields untouched (regression-locked) so old
   analyzers and archives stay valid.

Dependencies: Phase 1 (fold boundary), Phase 2 (capture site).
Risks: engine-semantics extraction is the delicate part; if a clean seam is
impossible, fall back to invoking the real executor in a one-trade mode and
recording its result — slower but semantics-identical; benchmark.
Deliverables: contract module + outcomes on summary rows + fixture suite.
Validation: fixture suite green; typecheck.
Exit criteria: every fixture matches hand calculations; a fixture candidate's
censored outcome equals the engine's own one-trade backtest on the same
candles.

### Phase 4 — identity gate + remaining archive fields

Objective: a run is verifiably WHAT it claims, or it cannot be judged.

Tasks:
1. Extend the auto `config.txt` block: full symbol list digest + strategy
   list digest (lists already recorded; add digests for cheap diffing),
   provider/engine identity, `researchProgram`, `foldEnd`, data-sync snapshot,
   git commit.
2. Pre-flight gate (research verdicts only): the S0 checklist rejects a batch
   whose identity fields are absent/mismatched or whose `evalLastBars != 1000`
   / `oosIgnoreLastBars != 26` / horizons != [12,18,24] for fresh-window
   program runs. The batch still archives (append-only) but is marked
   INVALID for judgment — matching the agenda's invalidity semantics.
3. Pair-summary context scalars (`distinctStrategyCount`, `strategyCoverage`,
   `strategyIdEntropy`, pair-level path means) — documented caveat: these
   aggregate the retained subset unless fed from Phase 2 capture; wire them
   to the Phase 2 source so the agenda's full-pool definitions hold.

Dependencies: Phases 0–2. Deliverables: extended config + gate + S0 checks.
Validation: config/Archive spec assertions; two fixture runs distinguishable
from archives alone. Exit criteria: gate demonstrably rejects a drifted config.

### Phase 5 — the three judgments (analyzer)

Objective: one analyzer enforces every locked rule; nothing is a soft report.

Tasks: `scripts/analyze-fresh-window-research.ts` (existing analyzer
conventions) reads the program namespace and emits:
1. S0 sentinel FIRST — window count (25), fold/disjointness, full-pool
   denominators (finite counts; never zero-filled), cost symmetry, identity
   completeness, and one hand-check row per exit class. Failure = pipeline
   failure; no verdicts printed.
2. Time-to-TP: top-1 `medianBarsToTP` vs full-pool censored control; kill on
   non-positive mean, <55% windows, not WEAK+, or EITHER chronological half
   non-positive (enforced, not reported).
3. Recurrence: `priorRecurrenceCount` from STRICTLY EARLIER fold snapshots
   (Phase 1 artifacts only — never current-sweep holdout integers);
   `INSUFFICIENT DATA` below 5% density; the three-batch budget (collection →
   judged → replication) with decision gates.
4. Strategy gate: PF top-1 within `distinctStrategyCount >= 3` pairs vs
   same-gate full-pool control; kill below 10% pair coverage or on negative
   ungated increment in either half; ungated increment reported but never
   promotion-sufficient alone.
5. Legacy visible-pool numbers emitted ONLY as a clearly labeled diagnostic.
Missing data exclusion rules pre-set and reported; deterministic seed 42.

Dependencies: Phases 1–4. Deliverables: analyzer + bat in the program folder.
Validation: golden fixtures (incl. both-halves kill, coverage kill, 5%
insufficiency, identity rejection). Exit criteria: S0 section runs end-to-end
on a fixture batch and every kill path is exercised by a test.

### Phase 6 — first real batch (S0), then judgments

One program batch at the first valid fresh snapshot; S0 checklist must pass
before any judgment section is read. Max 2 judged batches per experiment
(recurrence: 3 including collection). Until Phases 1–3 are complete, any
program batch is a TOOLING SMOKE TEST and must not be called a rule test.

## Cross-cutting notes

- **Files touched**: `server-asset-is-search.ts` (capture), the worker/pool
  protocol files (bounded chunks), `asset-opportunity-iteration.ts` (envelope
  threading), `finder-asset-opportunity-oos.ts` or a new shared exit module
  (contract), archive leaf (namespace + new artifact), plugin (program
  threading + new appends + identity), `finder-manager.ts` + one partial +
  one dom-contract (toggle), one analyzer + bat, specs throughout.
- **Import hygiene**: the plugin bundle must only gain Node/leaf imports; the
  new exit-contract module must not import browser-bound modules.
- **Security**: `researchProgram` allowlist; identity rows are content hashes;
  filenames stay validated-integer; traversal tests required.
- **Error handling**: new research-primary artifacts fatal (pair-summary
  precedent); missing identity → batch marked INVALID for verdicts (S0 gate),
  archive remains append-only.
- **Rollback**: additive; legacy namespace and behavior unchanged when the
  program field is absent; revert commits to remove.

## Assumptions resolved / remaining unknowns

Resolved by audit (2026-08-23): full pool not at the tail; winner-only horizon
metrics; `trades:false` on the selection path; no program request path;
fold counts 289/25.
Remaining: (a) whether the compact executor exposes enough path data for
`medianBarsToTP` without requesting trades (inspect
`finder-asset-candidate-execution.ts` first in Phase 2 — if not, request
trades on that call and reduce immediately); (b) Rust-path parity vs
preregistered disable (decide before Phase 2 merges); (c) chunk size vs clone
cost benchmark (Phase 2 exit criterion); (d) engine exit-rule extraction
feasibility (Phase 3 fallback: one-trade executor invocation, benchmarked).
