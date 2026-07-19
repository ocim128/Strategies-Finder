# MAX_ACTIVE Validation and Balanced Pair-List Generator

## Goal

Add a deterministic pair-list generator for the Batch Markets section and extend
the existing server-side OPEN_SCORE USD report so the `MAX_ACTIVE` hypothesis
can be tested against static-degree, score, and random controls.

`MAX_ACTIVE` means: among assets with a positive signed score at an event,
select the asset contained in the largest number of currently open synthetic
pairs. It is a coverage rule, not a prediction model.

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
  round-robin subset keeps submitted asset degrees within one where possible.
- Pair orientation is deterministic and balanced separately from relationship
  selection; input or alphabetical order must not make one asset almost always
  the base leg.
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
- New pure module: `lib/batch-backtest/balanced-pair-list-generator.ts`.
- `html-partials/tab-batch-backtest.html` — generator controls beside the
  existing `batchBacktestSymbols` textarea.
- `lib/batch-backtest/batch-backtest-dom.ts` — required DOM-id contract.
- `lib/batch-backtest/batch-backtest-service.ts` — button lifecycle, summary,
  Copy, and writing generated pairs into the existing textarea.
- `styles/batch-backtest.css` — compact generator controls/readout only.

The generator must not import `finder-manager`, `dataManager`, chart modules,
or any server-bound module. It should preserve the existing marker suffixes
used by `isMarkedLocalStockSymbol` and `parseSyntheticPairToken`.

### MAX_ACTIVE validation boundary

The existing server path remains the execution boundary:

- `lib/batch-backtest/batch-backtest-vite-plugin.ts` retains artifact loading,
  fingerprint checks, ownership, progress, and local-route authorization.
- `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` remains the pure
  score reconstruction and USD outcome engine.
- `lib/batch-backtest/batch-open-score-usd-replay-stream-types.ts` continues to
  transport the bounded result in the existing `done` event.
- `lib/batch-backtest/batch-backtest-service.ts` renders and copies the report.

No new endpoint, database table, Worker binding, localStorage schema, or Batch
runner change is required.

## Data flow

```text
single-asset textarea + maxPairs + seed
  -> normalize/reject/dedupe assets
  -> seeded round-robin relationship/orientation generator
  -> generated pair list + degree summary
  -> existing Batch pair textarea and fingerprint gate
  -> Run Batch -> disk-backed synthetic-pair artifacts
  -> POST /api/batch-backtest/open-score-usd
  -> existing event reconstruction and USD target loading
  -> TOP_RAW / TOP_ADJUSTED / TOP_MEAN / MAX_ACTIVE / MAX_STATIC
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
  maxPairs?: number; // defaults to BATCH_MAX_SYMBOLS
  seed?: number;     // deterministic default
}

interface BalancedPairListResult {
  assets: string[];
  pairs: string[];
  candidatePairCount: number;
  omittedPairCount: number;
  seed: number;
  degreeByAsset: Record<string, number>;
  baseDegreeByAsset: Record<string, number>;
  quoteDegreeByAsset: Record<string, number>;
  invalidTokens: string[];
  warnings: string[];
}
```

The UI must not overwrite `batchBacktestSymbols` when there are fewer than two
valid assets or when generation fails. Applying a successful list must trigger
the existing Batch input handler so stale artifacts are invalidated through the
current fingerprint/result lifecycle.

### Replay diagnostics

Extend the existing `OpenScoreUsdReplayResult` horizon entry with:

- `MAX_ACTIVE` selected-asset breakdown and dominant-asset exclusion;
- selector agreement for RAW, ADJUSTED, MEAN, ACTIVE, and STATIC;
- matched `ACTIVE_VS_STATIC`, `ACTIVE_VS_RAW`, and `ACTIVE_VS_MEAN`
  comparisons on events where the selections differ;
- a non-overlapping-event robustness comparison for each selector;
- the existing per-block means, CI, coverage, and omission warnings.

All output remains scalar/bounded: per-asset summaries are limited to the
asset universe, and no OHLCV arrays or per-event candidate arrays cross NDJSON.
The request body and route contract remain unchanged.

## Phase 0 — Freeze the research contract

### Objective

Prevent further post-hoc selector or pair-list changes while the feature is
built.

### Scope

Write the exact tie-break, horizon, pair-list seed, degree target, holdout
window, and comparison rules into tests and the copied report header.

### Technical tasks

- Define deterministic name/seed tie-break behavior for every selector.
- Define `ACTIVE_VS_STATIC` as same-event return difference only when the two
  selected assets differ.
- Define non-overlap as accepting the next event only after the selected
  asset's configured horizon exit time.
- Keep random control as the uniform mean of the other positive candidates.

### Dependencies

Existing replay semantics in `batch-open-score-usd-replay-engine.ts` and the
existing Batch cost settings.

### Risks or blockers

The current historical runs have already been inspected; they are exploratory,
not a fresh holdout. A truly untouched forward period is still required for a
production claim.

### Deliverables

Typed selector/diagnostic contract and fixed research constants.

### Validation and testing criteria

Known-answer fixtures prove tie breaks, same-event comparisons, and non-overlap
selection without using future returns.

### Exit criteria

No selector or horizon can be changed through an untracked implementation
default after this phase.

## Phase 1 — Implement the pure balanced pair generator

### Objective

Generate a reproducible, degree-balanced pair universe without loading data or
exceeding the Batch symbol ceiling.

### Scope

Add `balanced-pair-list-generator.ts` and its unit tests.

### Technical tasks

- Normalize uppercase tokens with existing Batch normalization.
- Reject empty tokens, pair tokens containing `+`, and malformed markers;
  return them in `invalidTokens`.
- Deduplicate assets by exact normalized marked token.
- Use a seeded permutation followed by a round-robin/circle schedule so every
  unordered relationship is generated once in O(assets + emitted pairs).
- Stop at `maxPairs`; report candidate and omitted counts.
- Orient each emitted pair deterministically while minimizing base/quote degree
  imbalance.
- Return degree maps and warnings for fewer than two assets or a capped list.

### Dependencies

`normalizeBatchSymbols`, `BATCH_MAX_SYMBOLS`, `createSeededRandom`, and the
existing marker conventions in `local-daily-datasets.ts`.

### Risks or blockers

Unicode marker normalization, deterministic orientation, odd asset counts,
`maxPairs` of zero/negative values, and accidental reciprocal duplicates.

### Deliverables

- `lib/batch-backtest/balanced-pair-list-generator.ts`
- `tests/batch-balanced-pair-list-generator.spec.ts`

### Validation and testing criteria

- No self-pairs or reciprocal keys.
- Same assets/seed/options produce byte-identical output.
- Full list count equals `N*(N-1)/2` when below the cap.
- Capped list length never exceeds 2,000.
- Submitted degree max-min is at most one for complete rounds and bounded for
  the partial round.
- Base/quote degree imbalance is reported and deterministic.
- 70 assets and 2,000 pairs complete without quadratic sorting or UI blocking.

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
- On success, replace the existing pair textarea, call its existing input
  invalidation path, and update the pair count.
- On failure, leave the existing pair list untouched and show actionable errors.
- Add only the compact CSS required by `styles/batch-backtest.css`.

### Dependencies

Phase 1 helper and existing `clearStaleResults`/`updateSummary` behavior.

### Risks or blockers

Generating while Batch or an analysis is running, accidentally preserving stale
artifacts, and confusing generated asset input with the existing pair input.

### Deliverables

Working browser generator with copied list and degree summary; no new route or
persistence.

### Validation and testing criteria

- `feature-dom-contracts.spec.ts` passes.
- Browser lifecycle test covers generation, invalid input, Copy, and stale-result
  invalidation.
- Manual smoke confirms the generated list can immediately run Batch.

### Exit criteria

A user can enter only assets, generate a capped balanced list, inspect its
degree summary, and run the existing Batch workflow.

## Phase 3 — Extend MAX_ACTIVE diagnostics

### Objective

Determine whether dynamic active-pair breadth adds value beyond static degree
and raw score.

### Scope

Modify only the pure replay engine, its result types, report formatter, and
focused tests. Keep the existing server route and UI lifecycle.

### Technical tasks

- Retain the existing selector series and add MAX_ACTIVE asset summaries and
  dominant-asset exclusion.
- Add selection-agreement counts and matched ACTIVE-vs-control comparisons.
- Record selected-asset exit times and add a non-overlapping-event robustness
  pass without reloading target datasets.
- Print primary/secondary horizon coverage and individual chronological block
  means for MAX_ACTIVE and pairwise comparisons.
- Keep report memory bounded by scalar arrays and the existing target-by-target
  loader; do not retain OHLCV or artifact arrays.

### Dependencies

`OpenScoreUsdReplayResult`, existing deterministic bootstrap helpers, and the
server-safe target loader in `batch-backtest-vite-plugin.ts`.

### Risks or blockers

Overlapping horizons reduce effective sample size; missing target bars can make
selectors appear different if eligibility is not shared; pairwise comparisons
must use the same event and cost conventions for both selectors.

### Deliverables

Extended report lines and result fields for MAX_ACTIVE concentration,
agreements, pairwise differences, and non-overlapping robustness.

### Validation and testing criteria

- Engine fixtures force different winners for RAW, MEAN, ACTIVE, and STATIC.
- Fixtures prove pairwise comparisons exclude same-selection events as
  specified.
- Fixtures prove non-overlap uses exit timing, not future winner information.
- Existing engine, server-plugin, lifecycle, and DOM tests remain green.

### Exit criteria

One OPEN_SCORE USD run answers whether MAX_ACTIVE beats random and whether it
beats static degree on the same events.

## Phase 4 — Locked validation run

### Objective

Run the research without changing the universe or selector after seeing results.

### Scope

UI-only execution using the generator, Batch, and existing OPEN_SCORE USD
button; no new research API or CLI.

### Technical tasks

- Generate and record the pair-list seed, list hash, asset count, degree range,
  Batch fingerprint, interval, costs, and horizons.
- Run the fixed 4h configuration with 72 as primary and 36/96 as secondary.
- Repeat over predeclared chronological windows using the same generated list.
- Save copied reports, including MAX_ACTIVE-vs-static, non-overlap, block, and
  concentration lines.
- Reserve a genuinely future forward period for the final confirmation.

### Dependencies

Local market data coverage through the requested horizons and a Node heap large
enough for the chosen Batch size; no server limit increase is part of this
phase.

### Risks or blockers

The current full-history results are already known and cannot serve as the sole
unseen holdout. Corporate-action discontinuities and missing future bars must
remain explicit omissions.

### Deliverables

Frozen validation reports and a pass/fail research decision.

### Validation and testing criteria

Require, at minimum: positive 72-bar MAX_ACTIVE-vs-random CI, positive
MAX_ACTIVE-vs-static CI, at least 7/10 positive chronological blocks, positive
non-overlapping lift, and positive lift after removing the dominant asset.

### Exit criteria

Only a successful untouched holdout permits planning a stateful USD portfolio
replay. Otherwise retain the generator as a research-balance tool and use
neutral admission with exposure limits.

## Logging, security, and failure handling

- Generator failures are local UI validation messages; no external input is
  sent until the user runs Batch.
- Existing Batch/OpenScore loopback authorization, fingerprint gates, owner
  lock, artifact TTL, and disconnect-safe streaming remain unchanged.
- No secrets, database writes, Worker calls, or persistent settings are added.
- Large generated lists must use bounded strings and the existing 2,000-symbol
  ceiling; do not render one DOM node per pair.
- Invalid assets, duplicate relationships, self-pairs, capped omissions, and
  missing target data must be visible in the generator/replay summaries.

## Rollback strategy

Remove the generator controls/helper and revert the replay result/report fields.
The existing Batch pair textarea, Batch server route, artifact format, and
stored settings remain compatible because this plan adds no schema or API
requirement.

## Documentation deliverables

- Update `docs/mine-timing-validation-findings.md` with the shipped generator
  behavior and final MAX_ACTIVE validation result.
- Add the implementation-plan link to `docs/README.md` while this work is in
  progress.
- After implementation is accepted, replace this plan with current behavior in
  the durable findings or Batch guide, following the documentation maintenance
  rule.
