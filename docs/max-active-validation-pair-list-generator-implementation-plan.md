# MAX_ACTIVE Validation and Balanced Pair-List Generator

## Goal

Add a deterministic pair-list generator for the Batch Markets section and extend
the existing server-side OPEN_SCORE USD report so the `MAX_ACTIVE` hypothesis
can be tested against submitted-degree, retained-degree, score, and uniform
positive-candidate controls.

`MAX_ACTIVE` means: among assets with a positive signed score at an event,
select the asset contained in the largest number of currently open synthetic
pairs. It is a coverage rule, not a prediction model. The uniform
positive-candidate control is the expected return of randomly selecting one of
the other positive assets at that same event.

The work remains research-only. It does not place orders, change Batch
execution, or build the stateful USD portfolio replay. No implementation code
is changed by this plan.

## Scope and decisions

- Generator input is one asset token per line, including marked stock/IBKR
  tokens such as `AAPL•` or `AAPL♦`.
- The generator emits each non-self relationship once. Reciprocal duplicates
  such as `AAPL•+NVDA•` and `NVDA•+AAPL•` are not both emitted.
- The generator uses the existing `BATCH_MAX_SYMBOLS` ceiling (`2,000`). It
  does not raise the server limit or split OPEN_SCORE into independent chunks.
- When the complete relationship set exceeds the ceiling, a seeded,
  degree-balanced round-robin subset keeps submitted asset degrees within one.
- Pair orientation is a deterministic balanced graph orientation performed
  after relationship selection; every asset's base-minus-quote count remains
  within one.
- Selector ties use one versioned, event-specific seeded asset order shared by
  every selector. Alphabetical asset names and input order are never selector
  tie-breaks. Every selector reports tied-event count and rate.
- Pair degrees are named by their real source: `submittedDegree` comes from the
  canonical Batch request, while `retainedDegree` comes from successfully
  stored replay artifacts. The current ambiguous `MAX_STATIC` label is replaced
  by `MAX_SUBMITTED` and `MAX_RETAINED`.
- Generator aliases are canonicalized to the same loader symbol and scoring
  asset identity used by artifacts. Two provider symbols for the same scoring
  asset are a fatal alias collision, not two assets.
- The primary research horizon is fixed at 72 bars. 36 and 96 bars are
  secondary robustness horizons. The pair list, Batch settings, interval, and
  selector rules are frozen before holdout evaluation.
- Rank Pairs labels are not used to build the validation universe. The current
  Rank Pairs classifier uses a latest-anchored multiyear window and would leak
  future information into a same-history replay.

## Existing architecture and module boundaries

### Pair-list generator boundary

The generator is a browser-side pure helper. It runs before Batch and does not
load candles, call a server route, or persist settings.

- `lib/batch-backtest/batch-run-contract.ts` — reuse symbol normalization and
  `BATCH_MAX_SYMBOLS`.
- `lib/param-math-utils.ts` — reuse `createSeededRandom` for deterministic
  asset ordering/orientation.
- New server-safe leaf: `lib/synthetic-leg-identity.ts` — canonical loader
  symbol, scoring asset, provider kind, alias-collision key, and shared quote
  suffix behavior.
- New pure module: `lib/batch-backtest/balanced-pair-list-generator.ts`.
- `html-partials/tab-batch-backtest.html` — generator controls beside the
  existing `batchBacktestSymbols` textarea.
- `lib/batch-backtest/batch-backtest-dom.ts` — required DOM-id contract.
- `lib/batch-backtest/batch-backtest-service.ts` — button lifecycle, summary,
  Copy, and writing generated pairs into the existing textarea.
- `styles/batch-backtest.css` — compact generator controls/readout only.

The generator must not import `finder-manager`, `dataManager`, or chart modules.
`synthetic-pair-token.ts`, `portfolioLab/portfolio-lab-synthetic.ts`, and the
generator must use the shared canonical leg helper so `BTC`/`BTCUSDT` and
marked-provider aliases cannot disagree between generation, loading, and
artifact scoring. Existing parser behavior needs parity fixtures before the
helper replaces duplicated quote-suffix rules.

### MAX_ACTIVE validation boundary

The existing server path remains the execution boundary:

- `lib/batch-backtest/batch-backtest-vite-plugin.ts` retains artifact loading,
  fingerprint checks, ownership, progress, and local-route authorization. It
  must additionally retain the canonical submitted-universe/provenance record
  and artifact lifecycle counts for the completed run.
- `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` remains the pure
  score reconstruction and USD outcome engine.
- New server-safe leaf: `lib/batch-backtest/max-active-research-contract.ts`
  contains the versioned tie/bootstrap constants, sufficiency/pass thresholds,
  and the one committed holdout registration.
- `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts` continues to
  transport the bounded result in the existing `done` event.
- `lib/batch-backtest/batch-backtest-service.ts` renders and copies the report.

No new endpoint, database table, Worker binding, or localStorage schema is
required. The existing Batch run request, fingerprint, snapshot, and `done`
event gain an optional versioned provenance field; the existing OPEN_SCORE
route path remains unchanged.

### Affected existing files

- `lib/synthetic-pair-token.ts` (`parseSyntheticPairToken`) and
  `lib/portfolioLab/portfolio-lab-synthetic.ts`
  (`stripKnownQuoteSuffix`, `parsePortfolioSyntheticPairSymbol`) adopt the
  shared identity leaf without changing their public results.
- `lib/batch-backtest/batch-run-contract.ts`
  (`BatchRunFingerprintInput`, `buildBatchRunFingerprint`) and
  `lib/batch-backtest/batch-backtest-stream-types.ts` carry optional bounded
  provenance.
- `lib/batch-backtest/batch-backtest-vite-plugin.ts` (`ArtifactStore.store`,
  run snapshot/status assembly, and `processOpenScoreUsdReplay`) retains and
  verifies provenance, submitted degree, and lifecycle counts.
- `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` and
  `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts` add selectors,
  masks, diagnostics, and verdict fields.
- `lib/batch-backtest/batch-backtest-service.ts` uses the existing
  `clearStaleResults`, `updateSummary`, `beginAnalysisBusy`,
  `finishAnalysisBusy`, and `updateArtifactActionButtons` lifecycle seams for
  generator application and report rendering.
- Focused coverage belongs in
  `tests/batch-balanced-pair-list-generator.spec.ts`,
  `tests/batch-open-score-usd-replay-engine.spec.ts`,
  `tests/batch-backtest-server-plugin.spec.ts`,
  `tests/batch-backtest-server-loader-parity.spec.ts`,
  `tests/batch-backtest-service-lifecycle.browser.spec.ts`, and
  `tests/feature-dom-contracts.spec.ts`.

## Data flow

```text
single-asset textarea + maxPairs + seed
  -> canonicalize loader/scoring identity; reject provider alias collisions
  -> seeded round-robin relationship/orientation generator
  -> generated pair list + versioned provenance + submitted degree summary
  -> existing Batch pair textarea and provenance-aware fingerprint gate
  -> Run Batch -> retained submitted universe + disk-backed artifacts/counts
  -> POST /api/batch-backtest/open-score-usd
  -> existing event reconstruction and USD target loading
  -> TOP_RAW / TOP_ADJUSTED / TOP_MEAN / MAX_ACTIVE
     / MAX_SUBMITTED / MAX_RETAINED
     + pairwise selector comparisons + concentration diagnostics
  -> existing NDJSON done event -> report and Copy
```

## Contracts

### Generator result

The pure helper should expose a bounded scalar result plus the generated symbol
list:

```ts
interface BalancedPairListOptions {
  assets: readonly string[];
  maxPairs?: number; // effective integer clamped to 1..BATCH_MAX_SYMBOLS
  seed?: number;     // effective uint32; non-finite/zero becomes 1
}

type BalancedPairListResult = {
  ok: false;
  errors: string[];
  invalidTokens: string[];
  aliasCollisions: Array<{ scoringAsset: string; tokens: string[] }>;
} | {
  ok: true;
  canonicalAssets: Array<{
    emittedToken: string;
    loaderSymbol: string;
    scoringAsset: string;
    provider: "market" | "ibkr" | "stock";
  }>;
  pairs: string[];
  candidatePairCount: number;
  omittedPairCount: number;
  effectiveSeed: number;
  effectiveMaxPairs: number;
  degreeByAsset: Record<string, number>;
  baseDegreeByAsset: Record<string, number>;
  quoteDegreeByAsset: Record<string, number>;
  invalidTokens: string[];
  aliasCollisions: Array<{ scoringAsset: string; tokens: string[] }>;
  provenance: PairListProvenanceV1;
  warnings: string[];
};

interface PairListProvenanceV1 {
  schema: "batch.pair_list.v1";
  algorithm: "seeded_round_robin_v1";
  effectiveSeed: number;
  effectiveMaxPairs: number;
  canonicalAssetListHash: string;
  emittedPairListHash: string;
  assetCount: number;
  pairCount: number;
  degree: { min: number; median: number; max: number };
  orientationImbalanceMax: number;
}

interface MaxActiveResearchRegistrationV1 {
  schema: "batch.max_active_research.v1";
  registrationId: string;
  implementationCommit: string;
  registeredAtSec: number;
  decisionStartSec: number;
  decisionEndSec: number;
  evaluateNotBeforeSec: number;
  expectedPairListHash: string;
  expectedBatchFingerprint: string;
  interval: "4h";
  horizons: readonly [36, 72, 96];
  slippageBps: number;
  commissionPercent: number;
  tieVersion: "max_active_tie_v1";
  bootstrapVersion: "max_active_bootstrap_v1";
  thresholdVersion: "max_active_thresholds_v1";
}
```

Hashes are versioned deterministic FNV-1a 64-bit hex digests over UTF-8 text.
The asset hash input is the sorted newline-delimited sequence
`provider|loaderSymbol|scoringAsset`; the pair hash input is the
newline-delimited, order-preserving output of `normalizeBatchSymbols(pairs)`.
The server uses the same function and normalization. These are reproducibility
identifiers, not security checks. Canonical assets are sorted before seeded
permutation, so the same asset set, options, and algorithm version are
invariant to input order.

The generator accepts at most 500 nonempty input lines before alias collapse.
Larger input is a hard validation failure. Undefined or non-finite `maxPairs`
becomes `BATCH_MAX_SYMBOLS`; otherwise it is floored then clamped to
`1..BATCH_MAX_SYMBOLS`. Undefined/non-finite seed becomes `1`; otherwise it is
normalized to `(floor(seed) >>> 0) || 1`. Both effective values are displayed
and hashed through the provenance record.

The degree-balanced relationship contract is fixed as follows:

- sort canonical loader symbols, then apply seeded Fisher-Yates once;
- for even `N`, use the circle method's `N-1` perfect-matching rounds: keep
  position zero fixed, rotate the other positions one step per round, and pair
  inward positions. Emit full rounds and then the first `r` disjoint pairs of
  the next round;
- for odd `N=2m+1`, use the Walecki Hamiltonian-cycle decomposition. With the
  shuffled first asset as `∞` and the remaining positions modulo `2m`, cycle
  `i` is `∞, i, i-1, i+1, i-2, i+2, ..., i-m, ∞` for
  `i=0..m-1`. Emit full cycles. For a partial cycle of `r<=m` edges, emit
  edges `0,2,...,2(r-1)`; for `r>m`, emit the whole cycle except the first
  `N-r` edges from that same non-adjacent sequence;
- orient the selected undirected graph only after relationship selection. Pair
  odd-degree vertices by shuffled asset index inside each component, add dummy
  edges, run deterministic Hierholzer traversal in relationship-index order,
  orient real edges along the Euler tour, then remove dummy edges;
- require submitted degree max-min `<= 1` and per-asset
  `abs(baseDegree-quoteDegree) <= 1`. A result violating either invariant is an
  internal failure and is not applied.

These constructions emit every unordered relationship exactly once when
uncapped and guarantee the degree bound for every exact `maxPairs`, including
odd asset counts and a partial final layer.

The UI must not overwrite `batchBacktestSymbols` when there are fewer than two
valid assets, any provider alias collision exists, or generation fails.
`BTC`/`BTCUSDT` collapse to one canonical leg; `AAPL•`/`AAPL♦` collide on the
same scoring asset with different providers and fail loudly. Applying a
successful list must trigger the existing Batch input handler so stale
artifacts are invalidated through the current fingerprint/result lifecycle.

### Batch provenance and universe counts

The successful generator provenance is attached to the Batch run only while
the current pair-textarea digest matches `emittedPairListHash`. Manual edits
clear it. Add optional `pairListProvenance` and
`maxActiveResearchRegistration` to the Batch request, `BatchRunSnapshot`, Batch
`done`/status payloads, and retained server run state; add the pair-list
provenance to `BatchRunFingerprintInput`. The registration's expected Batch
fingerprint is computed without the registration itself, avoiding a recursive
hash. The server recomputes the emitted-list hash and validates the registration
against the committed server-safe constant. A mismatch is retained as
`manual/unverified`, never trusted.

The registration is not a UI setting. Phase 4 fills its concrete UTC dates,
commit, hashes, settings, and costs and commits the identical values in
`docs/max-active-preregistration.md` before `decisionStartSec`.
`evaluateNotBeforeSec` must be later than `decisionEndSec` by enough time to
observe the 96-bar outcomes. A report is `HOLDOUT` only when its pair hash,
Batch fingerprint, interval, horizons, costs, and exact decision window equal
that registration and evaluation time has been reached. All other reports are
`EXPLORATORY`.
`implementationCommit` is the last implementation commit before the
registration commit, so the registration does not hash itself recursively.

The retained run must expose these distinct counts:

- submitted normalized symbols;
- canonical synthetic relationships;
- artifact-eligible rows;
- successfully stored artifacts;
- failed artifact writes;
- successfully loaded replay artifacts;
- failed artifact reads;
- replayed pairs after engine validity checks.

The server also retains the canonical submitted scoring-asset degree map. The
engine receives both submitted degree and retained-artifact degree. Retained
degree counts both legs of every successfully loaded canonical artifact,
including an artifact with zero trades; it is not reconstructed only from
trade deltas. This makes `MAX_SUBMITTED` and `MAX_RETAINED` explicit and
prevents the current artifact degree from being mislabeled as submitted-list
degree.

### Replay diagnostics

Extend the existing `OpenScoreUsdReplayResult` horizon entry with:

- `MAX_ACTIVE` selected-asset breakdown and dominant-asset exclusion;
- selector agreement and tie rates for RAW, ADJUSTED, MEAN, ACTIVE,
  SUBMITTED, and RETAINED;
- matched `ACTIVE_VS_SUBMITTED`, `ACTIVE_VS_RETAINED`, `ACTIVE_VS_RAW`, and `ACTIVE_VS_MEAN`
  comparisons on events where the selections differ;
- a shared-mask non-overlapping-event robustness comparison for each selector;
- the existing per-block means, CI, coverage, and omission warnings.

All output remains scalar/bounded: per-asset summaries are limited to the
asset universe, and no OHLCV arrays or per-event candidate arrays cross NDJSON.
The OPEN_SCORE request body and route path remain unchanged; the report composes
the retained pair-list provenance, retained Batch settings, request window, and
fixed `max_active_v1` research/tie-rule version.

## Phase 0 — Freeze the research contract

### Objective

Prevent further post-hoc selector or pair-list changes while the feature is
built.

### Scope

Write the exact tie-break, horizon, pair-list seed, degree target, fixed holdout
decision window/evaluation date, minimum samples, and comparison rules into
tests and a committed preregistration record before collecting forward
outcomes.

### Technical tasks

- Freeze `max_active_tie_v1`: at each event, rank tied assets by the unsigned
  FNV-1a 64 digest of `tieVersion|tieSeed|truncatedEventTimeSec|scoringAsset`;
  the event time is the integer Unix-second value used by the replay engine and
  the smallest digest wins. `tieSeed=1`, the priority order is shared by every
  selector, and
  input/alphabetical order is irrelevant. Report tie count/rate per selector.
  If two tied assets produce the same digest, use scoring-asset order only to
  keep execution deterministic, report the collision, and make the formal
  verdict `INSUFFICIENT_DATA` rather than silently accepting that fallback.
- Preserve current event timing: apply every entry and exit delta sharing a
  timestamp before scoring, create a decision event only when that timestamp
  contains an entry, and let `MAX_ACTIVE` see the resulting currently-open pair
  counts. Exit-only timestamps do not create admission decisions.
- Define `ACTIVE_VS_SUBMITTED` and other pairwise comparisons as same-event
  return differences only when the selected assets differ.
- Define one selector-independent global one-slot mask per horizon: accept the
  first eligible event, set the embargo boundary to the maximum exit-bar
  timestamp across every positive candidate at that event, then accept the
  next event only when `eventTimeSec > embargoBoundary`. All selectors,
  pairwise controls, and the random arm use that same mask.
- Treat the stored exit bar timestamp as the close boundary because the OHLCV
  contract has no separate close timestamp. Same-timestamp events are already
  one merged decision event. Irregular calendars are handled conservatively by
  the maximum candidate exit; any candidate missing an exit makes the event
  ineligible before mask construction.
- A horizon event is comparable only when at least two distinct positive
  scoring assets exist and every positive candidate has a valid target outcome
  and exit timestamp. All selectors use that same candidate set. For each
  selector, the random control is the uniform mean return of all other positive
  candidates; no seeded random draw is added.
- Add `PASS`, `FAIL`, and `INSUFFICIENT_DATA`; never create a point CI from one
  block for a research verdict.
- Add `max-active-research-contract.ts` with the versioned rules and thresholds
  from Phase 4 and the `MaxActiveResearchRegistrationV1` schema. Do not populate
  a holdout registration until the implementation and generator are verified.
- Add the exact preregistration field checklist to this plan; Phase 4 creates
  `docs/max-active-preregistration.md` and the matching committed registration
  before its future decision start.

### Dependencies

Existing replay semantics in `batch-open-score-usd-replay-engine.ts` and the
existing Batch cost settings.

### Risks or blockers

The current historical runs have already been inspected; they are exploratory,
not a fresh holdout. A truly untouched forward period is still required for a
production claim.

### Deliverables

Typed selector/diagnostic contract, shared fixed research constants, and the
holdout registration schema.

### Validation and testing criteria

Known-answer fixtures prove shared seeded tie breaks, tie counters, same-event
comparisons, and the shared non-overlap mask without using future returns.

### Exit criteria

No selector, tie policy, threshold, or horizon can be changed through an
untracked implementation default after this phase. Historical reruns are
labeled `EXPLORATORY`; only the exact later registration can be labeled
holdout.

## Phase 1 — Implement the pure balanced pair generator

### Objective

Generate a reproducible, degree-balanced pair universe without loading data or
exceeding the Batch symbol ceiling.

### Scope

Add the shared leg-identity leaf, the generator, parser-parity fixtures, and
focused unit tests. Do not change candle loading or provider selection.

### Technical tasks

- First lock the current leg parsing with parity fixtures for market symbols,
  quote-suffixed crypto symbols, stock markers, IBKR markers, case, and
  whitespace.
- Extract those rules into `synthetic-leg-identity.ts`. It must return the
  canonical loader symbol, scoring asset, provider kind, and emitted token
  without importing browser-bound modules.
- Reject empty input, input containing `+`, malformed or unsupported markers,
  and any semantic self-pair after canonicalization.
- Collapse exact/canonical aliases within one provider, including
  `BTC`/`BTCUSDT`. Fail the whole generation on a cross-provider alias such as
  the stock and IBKR forms of `AAPL`; do not silently choose a data source.
- Enforce the 500-nonempty-line input limit before alias collapse and
  relationship generation.
- Normalize and display the effective `maxPairs` and seed exactly as specified
  in the generator contract.
- Implement the fixed seeded shuffle, even perfect-matching rounds, odd Walecki
  cycles, and partial-layer rules. Stop at `effectiveMaxPairs` without building
  or sorting all `N*(N-1)/2` relationships.
- Apply the deterministic Euler-tour orientation after relationship selection
  and verify degree and orientation invariants before returning success.
- Return the pair list, degree maps, hashes, provenance, omissions, and
  actionable validation errors.

### Dependencies

`normalizeBatchSymbols`, `BATCH_MAX_SYMBOLS`, `createSeededRandom`,
`synthetic-pair-token.ts`, `portfolioLab/portfolio-lab-synthetic.ts`, and the
existing marker conventions in `local-daily-datasets.ts`.

### Risks or blockers

Moving duplicated suffix rules can change existing parsing if the parity
fixtures are incomplete. Unicode lookalikes, odd asset counts, a partial final
round, and provider aliases are the main correctness risks.

### Deliverables

- `lib/batch-backtest/balanced-pair-list-generator.ts`
- `lib/synthetic-leg-identity.ts`
- `tests/batch-balanced-pair-list-generator.spec.ts`
- Parser parity coverage in the existing synthetic-token and Portfolio Lab
  test suites, or one focused shared-identity spec if that is the established
  local pattern.

### Validation and testing criteria

- No syntactic or semantic self-pairs and no reciprocal relationship keys.
- The same canonical asset set/seed/options produces byte-identical pairs,
  degree maps, and hashes regardless of input order, case, whitespace, or
  same-provider aliases; input-validation diagnostics may still name the
  original tokens.
- Fixtures prove `BTC`/`BTCUSDT` collapse and stock/IBKR `AAPL` aliases fail.
- Existing loader and Portfolio Lab parsing results are unchanged for every
  parity fixture.
- Full list count equals `N*(N-1)/2` when below the cap.
- Capped list length never exceeds the normalized effective maximum or 2,000.
- Submitted degree max-min is at most one, including a partial final round.
- Per-asset base/quote imbalance is at most one.
- Golden fixtures cover even/odd asset counts, partial rounds, seed
  normalization, maximum input size, malformed markers, and hash stability.
- 500 assets capped at 2,000 pairs completes in O(assets + emitted pairs)
  without constructing the complete relationship set.

### Exit criteria

The helper produces a valid Batch symbol list and a trustworthy degree summary
without touching network, storage, or server state.

## Phase 2 — Add the generator to Batch Markets

### Objective

Make the generator usable entirely through the existing Batch UI.

### Scope

Add a small generator control group next to the existing pair textarea.

### Technical tasks

- Add asset textarea, max-pairs input (default 2,000), seed input, Generate,
  Copy, and summary/status IDs to `tab-batch-backtest.html`.
- Register the IDs in `batch-backtest-dom.ts` and add fake-DOM entries to the
  lifecycle test.
- Bind generation/copy handlers in `batch-backtest-service.ts`.
- Treat Generate as Generate-and-Apply. Disable it through the existing Batch
  and analysis busy-state methods, and add an authoritative handler guard that
  rejects the action while a Batch run, analysis, Stop transition, or status
  reattach owns the UI. A rejected action must not mutate either textarea or
  the remembered provenance.
- On success, replace the existing pair textarea, dispatch its existing input
  invalidation path, update the pair count, and remember the result only while
  its pair-list hash still matches the textarea.
- Clear generated provenance on any manual pair-textarea edit. Copy may copy
  the last displayed successful result, but it must never restore cleared
  provenance or change the active pair list.
- Show effective seed/maxPairs, canonical asset and relationship counts,
  degree/orientation ranges, omitted count, hashes, alias errors, and warnings
  in the compact status area.
- On failure, leave the existing pair list untouched and show actionable errors.
- Add only the compact CSS required by `styles/batch-backtest.css`.

### Dependencies

Phase 1 helper and existing `clearStaleResults`/`updateSummary` behavior.

### Risks or blockers

Busy-state drift could allow a list replacement while the server owns a run.
Manual edits can make displayed provenance stale. The handler guard and hash
check are required even when the controls appear disabled.

### Deliverables

Working browser generator with copied list and degree summary; no new route or
persistence.

### Validation and testing criteria

- `feature-dom-contracts.spec.ts` passes.
- Browser lifecycle tests cover generation, invalid input, Copy, stale-result
  invalidation, manual-edit provenance clearing, and every busy/reattach guard.
- Tests prove a rejected or failed generation leaves the current pair list and
  provenance unchanged.
- Tests prove a successful apply follows the same artifact/fingerprint
  invalidation path as a manual pair-list edit.
- Manual smoke confirms the generated list can immediately run Batch.

### Exit criteria

A user can enter only assets, generate a capped balanced list, inspect the
effective options and provenance, and run the existing Batch workflow without
stale-artifact or concurrent-run ambiguity.

## Phase 3 — Preserve universe provenance and extend MAX_ACTIVE diagnostics

### Objective

Estimate whether dynamic active-pair breadth adds value beyond submitted
degree, retained-artifact degree, raw score, and the uniform positive-candidate
control, or report that the run is insufficient.

### Scope

Extend the existing Batch request/fingerprint/snapshot contracts, retained
server state, pure replay engine, stream result, formatter, and focused tests.
Keep the existing Batch and OPEN_SCORE route paths, owner lock, artifact store,
and UI lifecycle.

### Technical tasks

- Add optional `pairListProvenance` to the Batch request, fingerprint, snapshot,
  `done` event, `/status` result, and retained run state. Verify the pair-list
  hash server-side; retain mismatches as manual/unverified metadata.
- At Batch admission, canonicalize every submitted synthetic relationship with
  the shared leg helper. Retain the submitted scoring-asset degree map and the
  normalized-symbol, canonical-relationship, and artifact-eligible counts.
- Track successful artifact writes and write failures without weakening the
  existing artifact submission gate. During replay, separately track artifact
  read success/failure and engine-accepted pair counts.
- Pass submitted degree and universe counts into the pure engine. Compute
  retained degree only from successfully loaded artifacts. Define
  `MAX_SUBMITTED` and `MAX_RETAINED` as the positive candidate with the largest
  respective degree; use the shared tie rule.
- Keep existing selector series and add `MAX_ACTIVE` selected-asset summaries,
  tie rates, agreement rates, and dominant-asset exclusion. The dominant asset
  is the most frequently selected `MAX_ACTIVE` asset within that horizon, with
  ties resolved by the fixed tie rule.
- Compute paired event deltas for `ACTIVE_VS_SUBMITTED`,
  `ACTIVE_VS_RETAINED`, `ACTIVE_VS_RAW`, and `ACTIVE_VS_MEAN` only when both
  selectors are eligible and choose different assets.
- Carry each candidate outcome's target exit-bar timestamp. Build the one
  selector-independent non-overlap mask defined in Phase 0, then reuse that
  exact mask for selectors, uniform control, and pairwise comparisons.
- Sort each eligible analysis sample by event time and split it into exactly
  ten count-balanced chronological blocks using boundaries
  `floor(block*n/10)..floor((block+1)*n/10)`. Report all ten block means.
- Define `max_active_bootstrap_v1` as 10,000 seeded resamples with replacement
  of those ten block means (`seed=1`). A CI is unavailable unless all ten
  nonempty blocks exist; never substitute an event-level or one-block CI.
- Add separate `dataStatus`, `researchMode`, and `researchVerdict` fields.
  `dataStatus` reports replay coverage, `researchMode` is `EXPLORATORY` unless
  the verified pair/run provenance and exact registered decision window match
  after `evaluateNotBeforeSec`, and
  `researchVerdict` is `NOT_EVALUATED` for exploratory runs, otherwise
  `PASS`, `FAIL`, or `INSUFFICIENT_DATA`.
- Keep report memory bounded by scalar per-event outcomes needed for the fixed
  horizons and the existing target-by-target loader. Do not retain OHLCV,
  signal, trade, or candidate-object arrays across NDJSON.

### Dependencies

Phases 0 and 1, `BatchRunFingerprintInput`, `BatchRunSnapshot`,
`OpenScoreUsdReplayResult`, existing artifact lifecycle/serialization gates,
deterministic bootstrap helpers, and the server-safe target loader in
`batch-backtest-vite-plugin.ts`.

### Risks or blockers

The server-side import graph must remain free of browser/chart modules.
Missing artifacts can distort retained degree even when aggregate coverage
looks high. Provenance fields must remain bounded scalars so `/status` cannot
become a second pair-list transport.

### Deliverables

Verified Batch provenance/counts and extended report fields for submitted and
retained degree, MAX_ACTIVE concentration, ties, agreements, pairwise deltas,
non-overlap, completeness, research mode, and verdict.

### Validation and testing criteria

- Engine fixtures force different winners for RAW, MEAN, ACTIVE, SUBMITTED, and
  RETAINED.
- Fixtures prove pairwise comparisons exclude same-selection events as
  specified.
- Fixtures prove all selectors share one non-overlap mask based on the maximum
  candidate exit timestamp, including irregular calendars and missing exits.
- Fixtures prove alphabetical/input order cannot change a tied winner and that
  every selector reports the correct tie rate.
- Server-plugin tests cover verified, absent, and mismatched provenance;
  submitted-vs-retained degree divergence; partial artifact writes; artifact
  read tombstones; and every universe count.
- Ten-block fixtures lock chronological boundaries, the seeded bootstrap, and
  the refusal to create a CI from fewer than ten blocks.
- Existing engine, server-plugin, lifecycle, and DOM tests remain green.

### Exit criteria

One OPEN_SCORE USD run estimates MAX_ACTIVE lift against every control on
shared eligible events, or explicitly reports which completeness, sample-size,
or provenance gate made the result insufficient.

## Phase 4 — Locked validation run

### Objective

Run the research without changing the universe or selector after seeing results.

### Scope

UI-only execution using the generator, Batch, and existing OPEN_SCORE USD
button; no new research API or CLI.

### Technical tasks

- After implementation validation, generate and verify the proposed pair-list
  seed, list hash, asset count, submitted degree/orientation range, Batch
  fingerprint, interval, costs, and horizons. Any historical smoke run remains
  exploratory.
- Choose a future UTC decision start/end and a later evaluation date that
  allows all 96 target bars to exist, then commit both
  `docs/max-active-preregistration.md` and the matching
  `MaxActiveResearchRegistrationV1` before that start. Include the
  implementation commit, generator/list hashes, settings, selector versions,
  thresholds below, and the exploratory-history statement.
- At or after the registered evaluation date, run the exact 4h decision window
  with 72 bars as primary and 36/96 as secondary using the same list and Batch
  settings. Do not introduce extra chronological windows after observing the
  holdout.
- Save copied reports, including MAX_ACTIVE-vs-static, non-overlap, block, and
  concentration lines.
- Do not extend the decision end or evaluation date after inspecting forward
  results. Evaluate only at or after the preregistered evaluation date.

### Dependencies

Local market data coverage through the requested horizons and a Node heap large
enough for the chosen Batch size; no server limit increase is part of this
phase.

### Risks or blockers

The current full-history results are already known and cannot serve as the sole
unseen holdout. Corporate-action discontinuities and missing future bars must
remain explicit omissions.

### Deliverables

Frozen validation reports and a `PASS`, `FAIL`, or `INSUFFICIENT_DATA` research
decision with every failed gate named.

### Validation and testing criteria

Before statistical evaluation, require all of these fixed sufficiency gates:

- verified `seeded_round_robin_v1` provenance, exact registered decision
  window/settings, and execution at or after `evaluateNotBeforeSec`;
- submitted relationship count equals the provenance pair count, submitted
  degree max-min is at most one, and orientation imbalance is at most one;
- artifact-eligible relationships are at least 95% of submitted canonical
  relationships, with zero artifact-write failures and zero artifact-read
  failures;
- replay-accepted pairs are at least 95% of submitted canonical relationships;
- for every asset, retained/submitted degree is at least 90%, and the maximum
  minus minimum asset retention ratio is at most 10 percentage points;
- horizon coverage is at least 95%, primary eligible events are at least 1,000,
  `ACTIVE_VS_SUBMITTED` differing-selection events are at least 200, shared-mask
  non-overlap events are at least 100, and primary events remaining after the
  dominant-asset exclusion are at least 500;
- no tie-digest collision occurred;
- every formal 72-bar CI comparison produces exactly ten nonempty chronological
  blocks. Diagnostics with smaller samples show `CI=n/a` but do not create a
  substitute interval. Any unmet formal gate yields `INSUFFICIENT_DATA`, not
  `FAIL`.

Given sufficient data, require all of these preregistered pass conditions:

- at 72 bars, the 95% block-bootstrap CI lower bound is above zero for
  MAX_ACTIVE minus the uniform positive-candidate control and for
  `ACTIVE_VS_SUBMITTED`;
- at least 7 of 10 chronological block means are positive for both primary
  comparisons;
- the 72-bar shared-mask non-overlap and dominant-asset-excluded comparisons
  each have a 95% CI lower bound above zero;
- the 36- and 96-bar MAX_ACTIVE-minus-uniform point estimates are positive.

`ACTIVE_VS_RETAINED`, RAW/MEAN comparisons, tie/agreement rates, and asset
concentration remain reported diagnostics; they cannot rescue a failed primary
condition. Any failed pass condition with sufficient data yields `FAIL`.

### Exit criteria

Only `PASS` on the untouched preregistered holdout permits planning a stateful
USD portfolio replay. `INSUFFICIENT_DATA` permits only another prospectively
preregistered collection period; `FAIL` keeps the generator as a
research-balance tool and uses neutral admission with exposure limits.

## Logging, security, and failure handling

- Generator failures are local UI validation messages; no external input is
  sent until the user runs Batch.
- Generator status moves through validation, relationship selection,
  orientation, and applied/failed states. The 500-line/2,000-pair limits and
  O(assets + emitted pairs) construction keep each phase bounded on the UI
  thread.
- Existing Batch/OpenScore loopback authorization, fingerprint gates, owner
  lock, artifact TTL, and disconnect-safe streaming remain unchanged.
- Preserve the existing OPEN_SCORE `scan`, `events`, `targets`, `outcomes`, and
  `aggregate` progress phases. New submitted-universe work reports bounded
  current/total counts, yields through the existing loop helper, and checks
  Stop/ownership in long loops.
- Treat all client provenance as untrusted bounded scalar input. Accept a
  holdout registration only by exact comparison with the committed constant;
  malformed, oversized, or unknown versions become unverified metadata and
  cannot produce `PASS` or `FAIL`.
- No secrets, database writes, Worker calls, or persistent settings are added.
- Large generated lists must use bounded strings and the existing 2,000-symbol
  ceiling; do not render one DOM node per pair.
- Invalid assets, aliases, duplicate relationships, self-pairs, capped
  omissions, provenance mismatch, partial artifact writes/reads, missing target
  data, and every insufficiency reason must be visible in the generator/replay
  summaries.

## Rollback strategy

Revert the generator UI/helper and its shared-parser call sites together, then
remove the optional provenance/count/result fields. The Batch and OPEN_SCORE
route paths, disk artifact format, and stored settings remain unchanged; older
clients remain compatible because every wire addition is optional and unknown
provenance is never required for exploratory replay. If only the research gate
must be disabled, leave generation and diagnostics in place and set the
committed registration to absent so every report stays `EXPLORATORY`.

## Documentation deliverables

- Update `docs/mine-timing-validation-findings.md` with the shipped generator
  behavior and final MAX_ACTIVE validation result.
- Add the implementation-plan link to `docs/README.md` while this work is in
  progress.
- After implementation is accepted, replace this plan with current behavior in
  the durable findings or Batch guide, following the documentation maintenance
  rule.
