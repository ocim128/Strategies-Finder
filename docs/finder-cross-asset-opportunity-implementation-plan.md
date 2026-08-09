# Finder Cross-Asset Opportunity Search — Implementation Plan

Status: implementation plan only.

## Feature definition

Add a third Finder scope: `asset_opportunity`.

The user supplies:

- one or more selected strategy libraries;
- a symbol list such as `AAPL•`, `MSFT•`, and `NVDA•`;
- the existing Finder random-search settings.

The feature independently searches parameters for every asset/strategy pair.
It does not average performance across assets or combine selected strategies
into a single signal.

The result unit is one asset/strategy opportunity. Each row contains the best
historically ranked candidate for that pair that also has a fresh current entry,
plus evidence describing how strongly the result is supported by other
high-ranking parameter candidates.

Existing modes remain unchanged:

- `current_chart`: search candidates for the current chart;
- `symbol_universe`: search candidates whose performance aggregates across the
  supplied symbols;
- `asset_opportunity`: search candidates independently per symbol, then rank
  symbols by current fresh-entry evidence.

At least one selected strategy library is required. Each selected strategy is
searched independently for every asset; the resulting asset/strategy rows are
ranked together, with the winning strategy recorded on every row. Strategy
failures remain attached to their asset and do not silently become zero
performance.

## Exact algorithm

For each supplied asset:

1. Load the asset using the existing server Finder data loader.
2. Select closed candles using `buildFinderEvaluationData`.
3. Remove the latest closed candle from the historical search data. This candle
   is the application candle and may affect current-signal detection only.
4. Apply the existing Finder data-slice behavior to the historical search data.
5. Run the existing random Finder search independently for each selected
   strategy, using a deterministic seed derived from `(runSeed, canonicalSymbol)`.
6. Run the search with an internal `topN = candidatePoolSize` and keep those
   candidates. The existing `finderTopN` remains the number of final asset rows
   shown to the user. Default candidate pool size: `10`.
7. Re-generate signals for only those candidates on the full closed data,
   including the application candle.
8. Mark a candidate `fresh` only when a new entry transition occurs on the
   latest closed candle. A repeated state signal is `active`, not `fresh`.
9. Select the highest-ranked fresh candidate within the top-K pool.
10. Build one scalar result for the asset/strategy pair.

No candidate outside the top-K historical pool can produce an opportunity in
this mode. This prevents random-search tail candidates from becoming current
signals merely because they happen to trigger today. Support counts describe
only the sampled top-K parameter pool; they are not claims about the full
strategy parameter space.

The current signal is never used to choose the historical candidate rank. It is
only evaluated after historical ranking.

Assets with no fresh latest-bar entry are counted in diagnostics but are not
included in the final ranked opportunity rows. The final `finderTopN` rows may
contain `select`, `watch`, or `reject` grades, but every displayed row has a
fresh entry.

## Asset result and decision rules

Each asset result must include:

- `symbol`;
- selected strategy key/name;
- winning candidate parameters;
- historical candidate rank and total candidates evaluated;
- fresh status, direction, latest closed signal time, signal age, and modeled
  fill timing;
- historical `selectionResult` metrics: expectancy, profit factor, net return,
  drawdown, Sharpe, and completed trade count;
- OOS metrics/verdict when the existing half-window OOS option is enabled;
- top-K support counts:
  - fresh long candidates;
  - fresh short candidates;
  - fresh candidates in the same direction as the winner;
  - best fresh rank;
  - direction agreement ratio;
- decision grade: `select`, `watch`, or `reject`.

Use the existing endpoint-adjusted `selectionResult` for historical ranking and
confidence evidence. Do not count the current forced `end_of_data` result as a
completed historical trade.

Decision rules are explicit:

- `reject`: fresh entry exists but historical expectancy is negative or fewer
  than the configured minimum historical trades;
- `watch`: fresh entry and positive historical expectancy, but insufficient
  same-direction top-K support or OOS is inconclusive;
- `select`: fresh entry, minimum historical trades met, positive historical
  expectancy, same-direction support at least `minFreshSupport`, and OOS pass
  when OOS validation is enabled.

Defaults:

- `candidatePoolSize`: `10`;
- `minFreshSupport`: `2`;
- minimum historical trades: reuse the existing Finder minimum-trades control;
- fresh signal: latest closed candle only.

Asset ranking is lexicographic and transparent:

1. `select` before `watch` before `reject`;
2. best fresh candidate rank, ascending;
3. same-direction support count, descending;
4. historical expectancy, descending;
5. completed trades, descending;
6. symbol, ascending as deterministic tie-breaker.

This is an evidence grade, not a probability that the next trade will win.

## Affected modules

Reuse:

- `lib/finder/finder-runner.ts`;
- `lib/finder/finder-runner-single.ts`;
- `lib/finder/finder-runner-shared.ts`;
- `lib/finder/finder-param-space.ts`;
- `lib/finder/finder-manager-logic.ts`;
- `lib/finder/server/finder-vite-plugin.ts`;
- `lib/finder/server/finder-stream-types.ts`;
- `lib/finder/server/server-finder-data-loader.ts`;
- `lib/batch-backtest/batch-dataset-loader-core.ts`;
- `lib/ndjson-stream.ts`;
- `lib/vite-http-utils.ts`.

Expected changes:

- `lib/types/finder.ts`: add `asset_opportunity`, options, asset result, fresh
  signal, support, and decision types;
- `lib/finder/finder-asset-opportunity-runner.ts`: per-asset orchestration and
  bounded asset reducer;
- `lib/finder/finder-fresh-entry.ts`: closed-candle entry-transition detector;
- `lib/finder/finder-asset-opportunity-metrics.ts`: support counts and decision
  rules;
- `lib/finder/finder-candidate-oos.ts`: server-safe leaf extracted from the
  existing current-chart OOS survivor pass, reused by Current Chart and Asset
  Opportunity paths;
- `lib/finder/server/finder-vite-plugin.ts`: server route and job dispatch;
- `lib/finder/server/finder-stream-types.ts`: asset stream/status union;
- `lib/finder/finder-result-snapshot.ts`: compact/restore support;
- `lib/finder-manager.ts`: scope, run dispatch, state, Apply, and reattach;
- `lib/finder/finder-manager-dom.ts`: new structural controls;
- `lib/finder/finder-ui.ts`: asset-first rendering;
- `html-partials/tab-finder.html`: new scope and controls;
- `tests/*`: focused runner, server, stream, snapshot, and DOM-contract specs.

Do not add a database, Cloudflare service, or Node worker-thread pool. The
existing Vite server job and optional Rust engine are the available execution
path. Add worker threads only as a later, benchmark-driven change.

## Data and OOS semantics

The latest closed candle is always reserved for current-signal detection. The
historical search never sees it.

When OOS validation is enabled, it uses the existing Finder rule: it is active
only for `half_oldest` or `half_newest`, and the complementary half is taken
from the historical search data, not from the application candle. No new OOS
window setting is introduced.

Fresh-entry detection must use the same normalized parameters, confirmation
strategies, exit overrides, execution model, and closed-candle data semantics as
the original Finder candidate. It must handle:

- `signal_close`;
- `next_open`;
- `next_close`;
- long entries;
- short entries;
- reversals;
- repeated state signals;
- `end_of_data` liquidation exclusion.

If a strategy requires a cross-symbol secondary dataset, reuse the existing
cross-symbol provider/context resolution. If the server path cannot resolve the
secondary dataset, return a per-asset failure instead of silently evaluating
with incomplete data.

## Implementation phases

### Phase 1 — Pure per-asset search and reduction

#### Objective

Implement the exact algorithm without UI or server transport changes.

#### Scope

Types, deterministic parameter search per asset, latest-candle separation,
fresh-entry detection, top-K support, and decision grading.

#### Technical tasks

- Add the new types in `lib/types/finder.ts`.
- Add `finder-fresh-entry.ts` as a leaf helper. It must inspect generated
  signals and replay state transitions without retaining full signal arrays in
  the result type.
- Add `finder-asset-opportunity-metrics.ts` with the explicit rules above.
- Extract the current-chart survivor OOS pass from `FinderManager` into
  `finder-candidate-oos.ts` without changing its verdict or half-window
  behavior. The current-chart path must delegate to the extracted leaf before
  the server path uses it.
- Add `finder-asset-opportunity-runner.ts` that invokes the existing Finder
  search core independently for each asset/strategy pair.
- Derive and record a deterministic per-asset seed.
- Use bounded top-K retention and release candidate-heavy data after each
  asset.

#### Dependencies

Existing Finder parameter generation, candidate execution, result ranking,
settings normalization, data-window helpers, and the extracted candidate OOS
leaf.

#### Risks or blockers

- `FinderResult` does not retain signals. The top-K candidates need a bounded
  signal-regeneration pass; do not add signals to persisted or streamed result
  types.
- Persistent strategy state must not be mistaken for a new entry.
- Candidate rank and current signal must remain separate to avoid latest-candle
  selection bias.

#### Deliverables

- Pure runner and result types.
- Fixtures for fresh long, fresh short, reversal, repeated signal, no signal,
  and forced final liquidation.

#### Validation and testing criteria

- Same seed and input produce identical per-asset candidate parameters and
  result ordering.
- Asset A and asset B are searched independently; no cross-asset average is
  present in an asset result.
- The latest candle can change fresh status but cannot change historical rank.
- All decision grades match the explicit gates.

#### Exit criteria

The pure runner returns deterministic scalar asset results for a fixed asset
list and can be tested without DOM, Vite, or server state.

### Phase 2 — Server-owned execution

#### Objective

Run the feature efficiently for large symbol lists without holding the work in
the browser.

#### Scope

One server-owned Finder job using the existing Vite plugin patterns.

#### Technical tasks

- Add `POST /api/finder/asset-opportunity-run` to
  `lib/finder/server/finder-vite-plugin.ts`.
- Keep the existing single Finder owner lock. The new job kind must share
  `/api/finder/status?runId=...` and `POST /api/finder/stop` rather than create
  a second owner or cancellation system.
- Add a discriminated `asset_opportunity` stream/status payload with
  `start`, `progress`, `asset`, `done`, and `fatal` events.
- Reuse `registerLocalJsonRoute`, request body limits, runId validation,
  pending-stop handling, and disconnect-safe streaming.
- Resolve all selected strategy keys through the existing strategy registry path.
- Apply OOS to retained per-asset candidates through
  `finder-candidate-oos.ts`; the complementary half is computed from the
  historical search data and never includes the application candle.
- Load one asset at a time through `loadServerFinderDataset`; release its data
  after reduction. Use the existing Finder Rust batching inside each asset.
- Pass `useRustEnginePreference` explicitly to the Node path and report actual
  Rust/TypeScript usage in diagnostics.
- Reuse the shared dataset-loader core and its synthetic-pair disk cache. Do
  not import browser-bound managers into the Vite config bundle.
- Stream only bounded scalar asset/strategy results and retain only the final
  top-N rows in the terminal snapshot.

#### Dependencies

Phase 1 runner and stream types; existing Finder server authorization,
loader, owner, and status utilities.

#### Risks or blockers

- Work is approximately `asset count × random parameter runs`; enforce symbol,
  max-run and top-K limits before ownership.
- CPU evaluation is initially bounded to one active asset. Dataset loading may
  use the existing bounded prefetch pattern only if profiling confirms benefit.
- Static-only deployments cannot run this scope; return the same explicit
  server-runtime error used by Universe Finder.

#### Deliverables

- Server process function, route, stream contract, status union, and scalar
  projection.
- Per-asset progress, cache, engine, failure, cancellation, and duration
  diagnostics.

#### Validation and testing criteria

- Route authorization rejects non-local callers.
- A mismatched runId cannot stop or overwrite another run.
- Disconnecting the initial stream does not cancel the server job; status
  reattach recovers the terminal asset slice.
- Payload tests reject `data`, `signals`, `trades`, and `equityCurve` arrays.
- Server results match Phase 1 fixtures.
- `npm run typecheck` passes and the Vite config still bundles without the
  ESM-only `lightweight-charts` require failure.
- Benchmark small, representative, and large symbol lists with
  `NODE_OPTIONS=--max-old-space-size=16384`; record assets/sec, runs/sec,
  peak heap, and actual engine usage.

#### Exit criteria

The feature completes, stops, and reattaches as a server-owned job while the
browser receives only scalar asset results.

### Phase 3 — UI, Apply, and persistence

#### Objective

Expose the new scope without changing existing Finder modes.

#### Scope

Finder controls, state, rendering, Apply, copy output, and reload recovery.

#### Technical tasks

- Add `asset_opportunity` to `finderScope` in
  `html-partials/tab-finder.html`.
- Reuse the existing symbol-list textarea/helpers. Add only these new controls:
  `candidatePoolSize`, `minFreshSupport`, and the asset-opportunity strategy
  selection validation. Reuse existing `finderTopN` for final asset rows and
  existing random-search, min-trades, data-slice, and OOS controls.
- Add structural ids to `lib/finder/finder-manager-dom.ts` and update the DOM
  contract test.
- Extend `FinderManager` option normalization, server dispatch, active-run
  persistence, status reattach, and terminal result adoption.
- Extend `FinderLatestResults` and `finder-result-snapshot.ts` with the new
  scope. Old snapshots must remain readable.
- Add `FinderUI.renderAssetOpportunityResults` with asset, direction, freshness,
  grade, best rank, support, expectancy, PF, trades, and OOS shown before
  parameters.
- Apply must set the selected asset as current symbol, select the winning
  strategy, apply its parameters through existing state/settings actions, and
  run the normal backtest. Stale stream results must fail the existing runId
  ownership check before applying.
- Extend Copy Top Results and Copy Diagnostics with scalar asset fields.

#### Dependencies

Phase 2 route/status contract and existing Finder state/action/rendering paths.

#### Risks or blockers

- The shared `finderList` must not retain Universe detail DOM when switching
  scopes.
- The best historical candidate may not be fresh. Render and apply the best
  fresh candidate only; show the historical-best rank as evidence.
- Applying a local stock/IBKR symbol must preserve the existing provider
  classification and data-loading path.

#### Deliverables

- New scope controls, asset-first table, Apply flow, copy output, persistence,
  and reload recovery.

#### Validation and testing criteria

- `tests/feature-dom-contracts.spec.ts` passes.
- Scope switching does not alter Current Chart or Universe options/results.
- Snapshot tests cover legacy scopes and the new scope.
- Apply loads the selected asset and winning parameters only.
- Manual smoke test covers run, Stop, reload, Copy, Apply, and terminal error.

#### Exit criteria

Users can run the new mode from Finder and make an asset decision from one
asset-first result table without changing existing Finder behavior.

### Phase 4 — Release validation and operational hardening

#### Objective

Prove the implementation is reproducible, bounded, and not falsely claiming
that historical confidence guarantees the next trade.

#### Scope

Regression tests, representative benchmarks, diagnostics, and a bounded
historical selector check. No new production service or worker architecture.

#### Technical tasks

- Add a deterministic historical-cutoff fixture that runs the selector at
  several prior timestamps and verifies that the selected asset uses only data
  available before each timestamp.
- Compare selected fresh assets with all eligible fresh assets in the fixture;
  report the comparison in tests or an existing diagnostic workflow, not as a
  live profitability guarantee.
- Emit `finder.asset_opportunity.start`, `.asset.complete`, `.run.complete`,
  `.run.cancelled`, `.run.failed`, and engine-fallback events with bounded
  scalars only.
- Surface warnings for stale data, thin samples, no fresh assets, all-failed
  loads, and OOS inconclusive results.
- Document server heap and runtime expectations near the existing Finder
  server-side documentation.

#### Dependencies

Completed phases and deterministic fixture data.

#### Risks or blockers

- A full historical replay of random searches is computationally expensive.
  Release validation should use bounded timestamps and candidate counts; it
  must not be presented as exhaustive unless it is exhaustive.
- Mixed-provider and synthetic-pair datasets may fail independently. Preserve
  per-asset failure reasons and never convert failure into zero performance.

#### Deliverables

- Regression suite, benchmark results, bounded historical-cutoff validation,
  and operational documentation.

#### Validation and testing criteria

- Required Finder server, loader parity, runner, stream, snapshot, and DOM
  tests pass.
- The same seed reproduces the same asset order and candidate parameters.
- No future candle reaches historical candidate ranking in cutoff fixtures.
- Large runs stay within the documented heap and request limits.

#### Exit criteria

The feature is ready only when its result is reproducible, its confidence fields
are traceable to historical evidence, its current-signal semantics are
unambiguous, and its server runtime is bounded.

## Failure and edge-case policy

- Empty/invalid pair list: reject before server ownership.
- Zero selected strategies: reject before server ownership. Multiple selected
  strategies are allowed; evaluate each asset/strategy pair independently.
- Asset load failure: continue other assets and retain the reason in diagnostics.
- No historical trades or below minimum: `reject`; never zero-fill metrics.
- No fresh latest-bar transition: exclude from opportunity rows and increment
  the no-fresh diagnostic count.
- Repeated state signal: `active`, not `fresh`.
- Open latest candle: use the latest closed candle only.
- Forced `end_of_data` exit: exclude from confidence sample.
- OOS fail: `reject` when OOS is enabled.
- OOS inconclusive: no `select`; at most `watch`.
- Stop, disconnect, or newer run: existing owner/runId rules apply.
- Server unavailable: explicit Vite-server requirement; no silent browser
  fallback for this scope.

## Security and infrastructure

- Use `registerLocalJsonRoute` and the existing loopback/bearer authorization.
- Enforce existing request body limits plus bounded symbols, max runs, top-K,
  and support count.
- Accept strategy registry keys only; never accept module paths from the client.
- Persist only UI state, active run id, and compact scalar results through
  `persisted-json`. No database migration is needed.
- Keep the existing Rust preference threading because Node has no DOM toggle.
- Do not add a worker service or worker-thread pool in the first release.

## Rollback strategy

The scope is additive and isolated behind `asset_opportunity`.

1. Remove or disable the new scope option and route.
2. Leave `current_chart` and `symbol_universe` branches untouched.
3. Continue accepting old persisted Finder snapshots.
4. Ignore unknown asset-opportunity snapshots rather than interpreting them as
   Universe candidates.
