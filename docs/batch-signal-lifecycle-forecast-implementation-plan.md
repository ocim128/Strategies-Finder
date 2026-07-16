# Batch Signal-Lifecycle Forecast Implementation Plan

## Goal

Add a Batch post-analysis named **Direction Forecast** that answers:

> Given the asset's active aggregate synthetic-pair state, what return did the
> real asset produce in comparable historical states from observable entry
> until that state invalidated?

The result contains:

- current per-asset forecasts;
- a walk-forward path that repeatedly selects the strongest forecast;
- path performance, forecast quality, and equal-execution benchmarks.

No forecast uses a fixed-bar return target. Bars are only the observation and
execution clock.

## Architecture Fit

- `lib/batch-backtest/batch-backtest-vite-plugin.ts` already stores synthetic
  pair candles, signals, trades, exact leg symbols, and Batch fingerprints.
- `lib/batch-backtest/batch-synthetic-state-miner.ts` already builds aligned
  per-asset state snapshots from active pair trades.
- `lib/batch-backtest/batch-backtest-stream-types.ts` keeps heavy arrays in
  Node.
- `lib/batch-backtest/batch-backtest-service.ts` owns Batch controls, Stop,
  rendering, copy output, and fingerprint checks.
- Mine Timing SQLite persistence and Asset Leadership remain unchanged.

## Decisions

### Target identity

Use the exact leg symbol, not only the stripped asset label:

```text
{ asset: baseAsset, symbol: baseSymbol }
{ asset: quoteAsset, symbol: quoteSymbol }
```

This preserves marked stock providers. Legacy artifacts without exact symbols
may use the existing `<ASSET>USDT` fallback only when the pair token is
unmarked crypto. An unresolved marked or ambiguous stock identity is
`TARGET_UNAVAILABLE`.

### State lifecycle

Reuse the current miner's timestamp alignment, pair direction, majority vote,
and three-bar signal fallback. The fallback only defines how long a recent
signal remains observable when no trade is open; it is not a return horizon.

- For each target timestamp, count all linked pair artifacts, how many data
  ranges cover the timestamp, and how many contain an aligned bar.
- State is observable only when every linked pair artifact is in range and has
  an aligned bar. This keeps the pair cohort constant across current and
  historical states. Partial coverage is unknown state, not a weaker vote.
- Activation: aggregate direction changes from null/opposite to long or short.
- Invalidation: an observable aggregate direction becomes null or opposite.
- Same-bar flip: invalidate the old lifecycle and activate the new lifecycle.
- Left-censored lifecycle: exclude until its first observed invalidation.
- Right-censored lifecycle: never assign an `end_of_data` return.
- Coverage loss does not count as signal invalidation. It marks the lifecycle
  unresolved and excludes it from forecast evidence.

Current lifecycle age is used only to compare states at similar maturity.

### Realized sample

For current lifecycle age `A`, one completed historical lifecycle contributes
at most one sample:

1. It has the same aggregate direction.
2. It survived at least `A` observations.
3. Forecast information is taken at activation plus `A`.
4. Entry is the next target bar open after that close.
5. Exit is the next target bar open after invalidation becomes observable.

Store the state snapshot available at step 3 as the analog input. Compute raw
asset return and maximum upward/downward excursion after exit only as outcome
labels. No state value observed after the forecast cutoff may enter distance,
ranking, or gating. Samples without an executable entry or exit remain
unresolved.

### Analog forecast

Reuse the miner's normalized snapshot distance and stable top-K ordering. Each
lifecycle supplies one age-matched sample, preventing overlapping bars from
inflating evidence.

Each scalar forecast row contains:

- asset, exact symbol, aggregate direction, and as-of price/time;
- bias: `UP`, `DOWN`, or `NEUTRAL`;
- status: `EDGE`, `NO_EDGE`, `NO_ACTIVE_STATE`, `INSUFFICIENT`, or
  `TARGET_UNAVAILABLE`; unobservable state uses `INSUFFICIENT` with reason
  `PAIR_COVERAGE`;
- lifecycle age, agreement/opposition, candidate count, and analog count;
- probability of positive return with Wilson bounds;
- median and interquartile return until invalidation;
- favorable/adverse excursion, analog distance, and concentration warning;
- `FRESH`, `STALE`, or `UNKNOWN` plus one reason code.

`UP` requires a Wilson lower bound above `0.5`, positive median return,
sufficient analogs, acceptable distance, and favorable excursion greater than
adverse excursion. `DOWN` uses the symmetric conditions. Reuse existing miner
sample, distance, and MFE/MAE defaults. Failed gates produce `NEUTRAL`.

Keep raw asset return for display. For ranking and risk ratios, convert it to
forecast-direction return: raw return for `UP`, negated raw return for `DOWN`.
Conservative direction probability is the Wilson lower bound for `UP` and
`1 - Wilson upper bound` for `DOWN`.

Freshness uses `computeStabilityDataLagBars(...)` and
`STABILITY_DATA_STALE_THRESHOLD_BARS` from
`lib/batch-backtest/miner-verdict-format-helpers.ts`, with market type derived
from the exact symbol. This live freshness rule applies only to current rows.
Historical replay uses cutoff-relative target timestamps and pair coverage.

## Walk-Forward Selection Path

### Validation window

Build one common overlap from the latest first timestamp and earliest last
timestamp across path targets. All targets must resolve to the same market-clock
class, and at least two targets must remain. If clocks are mixed, fewer than two
targets remain, or common overlap is insufficient, current forecasts remain
available and the path reports `PATH_UNAVAILABLE`.

Derive market-clock class from existing crypto/local-stock marker helpers. Use
the sorted union of target close timestamps inside common overlap as the replay
clock. An asset is eligible only when it has a target bar and sufficient pair
coverage at that timestamp; never carry its last forecast into a later event.

Use the first 80% of common overlap as initial history and the final 20% as the
untouched path test. Forecast and ranking rules are fixed before the test. At
each replay cutoff, the analog library contains only lifecycles whose exit was
already observable.

### Selection policy

When the path is flat:

1. Reconstruct all active forecasts at the current close.
2. Keep cutoff-observable `EDGE` candidates with complete pair coverage.
3. Rank by conservative direction probability, forecast-direction
   return/adverse-excursion ratio, forecast-direction return, analog distance,
   then exact symbol.
4. Enter the highest-ranked direct asset at its next open.
5. Hold until its aggregate state invalidates.
6. Exit at the next open.

One position may be active. A better forecast does not cause early switching.
A replacement may enter at the same open as an exit when both decisions were
known at the preceding close. Loss of required pair coverage triggers a
next-open `DATA_GAP` risk exit; that lifecycle is not added to forecast evidence.

### Equity rules

- Start normalized equity at `1.0`; use the matching Batch initial capital only
  to display equivalent research dollars.
- Allocate 100% of current equity to the one position without leverage.
- Apply the matching Batch commission to entry and exit notional and its
  `slippageBps` adversely to every buy and sell fill. Use the same costs for
  every policy.
- Ignore Kelly and other sizing modes so sizing cannot determine quality.
- Long return: `(exit / entry) - 1`.
- Short return: `(entry - exit) / entry` before costs.
- If equity reaches zero or below, set equity to zero, mark ruin, and terminate
  that policy path.
- If a position remains active at the final test timestamp, keep it open. Report
  realized equity separately from close-marked equity and unrealized PnL; do not
  create an `end_of_data` exit or include it in closed-trade quality metrics.
- Mark open positions at target closes only to compute unrealized equity and
  drawdown. Marks never change the invalidation exit or become forecast labels.

Displayed dollars are normalized research equity. Mixed-currency FX, stock
borrow, dividends, taxes, and corporate-action adjustment are not modeled.

### Benchmarks

Run with identical entry, exit, capital, and cost rules:

- highest raw aggregate agreement among observable active states, traded in the
  aggregate direction;
- random selection from the same `EDGE` candidates over 100 deterministic
  seeds, traded in each candidate's forecast bias and reported as median and
  5th/95th percentile equity;
- no-trade cash.

Each policy runs its own complete path because different selections produce
different invalidation times and later decision opportunities.

### Output

Keep PnL separate from forecast quality:

```text
PATH
Test Start/End | Start/Realized/Marked Equity | Realized/Unrealized PnL
Return | Max DD
Trades | Win Rate
Profit Factor | Exposure | Turnover | Ruin | Top1/Top3 PnL Concentration

FORECAST QUALITY
Selected Return Percentile | Excess vs Eligible Median | Selection Hit Rate
Mean Opportunity Regret | Rank IC | Abstention Rate | Comparable Decisions

BENCHMARKS
Raw Agreement | Random Median/P05/P95 | Cash
```

Raw PnL is not a forecast-quality score. A path dominated by one trade must show
high concentration even when final equity is large. Cross-sectional quality
metrics include only decisions with at least two ultimately resolved eligible
alternatives. Report excluded unresolved decisions separately. Mark path quality
`INSUFFICIENT` when fewer than 12 closed forecast trades or comparable decisions
exist.

## Data Flow

```text
BatchBacktestService
  POST /api/batch-backtest/direction-forecast
    { fingerprint, interval }
        |
        v
batch-backtest-vite-plugin
  validate -> acquire minerOwner -> derive exact targets
        |
        v
per target
  load direct candles + exact linked artifacts
  -> prepare pair states -> build lifecycles -> current forecast
        |
        v
walk-forward final-window replay
  -> forecast path + benchmarks -> scalar metrics
        |
        v
NDJSON forecast rows + path result -> browser render/copy
```

Candles, signals, trades, per-bar snapshots, samples, and equity curves never
cross the server/browser boundary.

## API and State

Add `POST /api/batch-backtest/direction-forecast`:

```json
{
  "fingerprint": "matching Batch fingerprint",
  "interval": "matching Batch interval"
}
```

Add `BatchDirectionForecastStreamEvent`:

```text
start    { assets, pairs }
progress { phase, completed, total, asset? }
forecast { row }
path     { result }
done     { ok, cancelled, summary, totals }
fatal    { error }
```

The route reuses `minerOwner`, Stop, `minerAbortController`, fingerprint checks,
body limits, and artifact TTL. Artifacts remain available after success or
cancellation.

At Batch completion, retain only `initialCapital`, `commission`, and
`slippageBps` beside the matching server fingerprint. The endpoint uses this
server-owned snapshot, not current browser settings, and clears it whenever the
artifacts or fingerprint are cleared. No new request fields are required.

`BatchBacktestService` keeps the latest rows and path result in memory. Clear
them on new Run, changed fingerprint, Clear, artifact loss, or disposal.

Do not write forecast data to SQLite, Asset Leadership, Mine Timing, or the
latest Batch localStorage snapshot.

## Implementation Phases

### Phase 1: Pure forecast and path engines

**Objective**

Build deterministic lifecycle forecasts and a no-lookahead selection path.

**Scope**

- `lib/batch-backtest/batch-synthetic-state-miner.ts`
- new `lib/batch-backtest/batch-signal-lifecycle-types.ts`
- new `lib/batch-backtest/batch-signal-lifecycle-forecast.ts`
- new `lib/batch-backtest/batch-signal-selection-path.ts`
- focused pure tests

**Technical tasks**

- Expose narrow timeline, distance, and stable top-K helpers from the miner.
- Group targets and linked artifacts by exact symbol.
- Track aligned pair coverage separately from inactive pair state.
- Segment lifecycles and build next-open realized samples.
- Build analog inputs from decision-time state only; keep later return and
  excursion values in outcome labels.
- Compute forecast probability, return distribution, excursions, gates, and
  current-row freshness inputs.
- Implement expanding walk-forward replay and the one-position state machine.
- Add common-overlap/market-clock validation, benchmark policies, and
  path/quality metrics.
- Preserve existing Mine Timing output.

**Dependencies**

- Prepared Batch target/pair artifacts and `timeKey(...)` alignment.
- Existing miner defaults and directional statistics.
- Batch initial capital, commission, and slippage settings.

**Risks or blockers**

- Shared-helper extraction can regress the miner hot path.
- Complete pair coverage may reduce evidence when one linked dataset has gaps.
- Long-lived states may have insufficient age-matched lifecycles.
- Replay may become quadratic in lifecycle count.
- A mixed-market Batch can produce valid current rows but no comparable path.
- One final holdout path can remain regime-specific; its timestamps and
  benchmarks must remain visible with every result.
- Wilson bounds do not remove serial regime dependence; the untouched path is
  the system-level validation.
- Existing strategy parameters may already be overfit; this validates the
  selection overlay, not how the strategy was chosen.

**Deliverables**

- Pure forecast and path modules.
- Lifecycle, forecast, replay, benchmark, and Mine-parity tests.

**Validation and testing criteria**

- Long, short, null, flip, left-censored, and right-censored fixtures pass.
- Missing aligned pair bars never become signal invalidation.
- Entry and exit use the first executable open after each observed decision.
- One lifecycle contributes at most one sample.
- No unresolved future lifecycle enters an analog library.
- Outcome-period state changes never enter analog distance or ranking inputs.
- Ambiguous stock identities never fall back to a crypto symbol.
- Replay eligibility uses the common timestamp clock without carrying stale
  forecasts forward.
- One path position is active and replacement timing is exact.
- A policy terminates at zero equity after ruin.
- A final open position remains unrealized and is never converted into a closed
  lifecycle result.
- All policies use identical capital and costs.
- Random benchmarks are reproducible.
- Mixed market clocks and insufficient common overlap return `PATH_UNAVAILABLE`.
- Single-target paths and quality samples below 12 are not reported as validated.
- Existing `tests/batch-synthetic-state-miner.spec.ts` values do not change.

**Exit criteria**

- Fixed fixtures reproduce the same forecast, path, and benchmarks without
  future data, fixed-bar labels, or changed Mine verdicts.

### Phase 2: Server and Batch UI integration

**Objective**

Run analysis on retained server artifacts and expose scalar results in Batch.

**Scope**

- `lib/batch-backtest/batch-backtest-vite-plugin.ts`
- `lib/batch-backtest/batch-backtest-stream-types.ts`
- `lib/batch-backtest/batch-backtest-service.ts`
- `lib/batch-backtest/batch-backtest-dom.ts`
- `html-partials/tab-batch-backtest.html`

**Technical tasks**

- Register the endpoint and stream phases.
- Retain the three execution assumptions with the matching Batch fingerprint.
- Load exact targets and linked artifacts sequentially.
- Use uncached or bounded per-target artifact reads.
- Add `Direction Forecast`, `Copy Forecast`, summary, and results elements.
- Reuse Batch analysis busy state, Stop, artifact status, and fingerprint gates.
- Reuse existing Batch miner row styles.
- Render current forecasts, path performance, quality, and benchmarks
  separately.
- Add deterministic pipe-delimited copy output.
- Re-arm artifact TTL after completion or cancellation.

**Dependencies**

- Phase 1 engines.
- Existing Batch NDJSON, owner lock, DOM contract, and clipboard patterns.

**Risks or blockers**

- Walk-forward replay may be materially slower than current Mine.
- The Batch action row and result area are already dense.
- Reload during analysis has generic miner status but no retained forecast
  result.

**Deliverables**

- Server-owned Direction Forecast with current and path results.
- Batch controls, rendering, copy, Stop, and integration tests.

**Validation and testing criteria**

- Missing artifacts, bad fingerprints, malformed requests, and 409 conflicts
  follow existing contracts.
- Path costs come from the retained matching-run assumptions even if current UI
  settings have changed.
- Stop aborts loads or replay and keeps artifacts reusable.
- Stream events contain no heavy arrays or internal paths.
- Stability and Portfolio Fit still run after a forecast.
- Buttons clear and gate after Run, Clear, TTL expiry, and settings changes.
- `tests/feature-dom-contracts.spec.ts` passes.

**Exit criteria**

- Users can run, stop, inspect, and copy the analysis without browser-held
  artifacts or stale-fingerprint results.

### Phase 3: Performance, documentation, and release validation

**Objective**

Verify stock/crypto correctness, bounded memory, and honest interpretation.

**Scope**

- focused tests and manual stock/crypto runs
- `docs/batch-backtest-server-side.md`
- `docs/synthetic-pairs.md`
- `docs/README.md`
- `README.md` where the Batch feature list changes

**Technical tasks**

- Document lifecycle outcomes, next-open execution, normalized PnL, omitted
  costs, and benchmark meaning.
- Profile target loading, artifact reads, lifecycle construction, replay, path
  simulation, elapsed time, and peak heap.
- Verify no SQLite or localStorage writes.
- Compare Mine output before and after helper extraction.
- Label all dollar output as normalized research equity.

**Dependencies**

- Phases 1 and 2.

**Risks or blockers**

- Large lifecycle counts may require measured optimization.
- Mixed-currency paths are not account PnL.
- Sparse evidence may correctly produce high abstention and few trades.

**Deliverables**

- Updated runtime documentation and recorded validation results.

**Validation and testing criteria**

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\batch-synthetic-state-miner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-signal-lifecycle-forecast.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-signal-selection-path.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-direction-forecast-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-service-lifecycle.browser.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- Manual crypto and marked-stock runs with forecast, Stop, Copy, Stability
  rerun, TTL expiry, and fingerprint mismatch.
- Manual 50-pair and 400-pair profiles before a 1000-pair run, using
  `NODE_OPTIONS=--max-old-space-size=16384`.

**Exit criteria**

- Checks pass without skips, no-lookahead fixtures pass, Mine parity is
  preserved, targets resolve correctly, artifacts remain reusable, and heap
  does not retain all parsed artifacts.

## Failure Handling

- No or expired synthetic artifacts: require a new Batch run.
- Missing direct target candles: `TARGET_UNAVAILABLE`; continue other assets.
- No active state: `NO_ACTIVE_STATE`.
- Insufficient aligned pair coverage: `INSUFFICIENT | PAIR_COVERAGE`.
- Too few resolved lifecycles: `INSUFFICIENT`.
- Weak/conflicting evidence: `NO_EDGE` and `NEUTRAL`.
- Stale data: retain as-of evidence and mark `STALE`.
- Missing next-open entry/exit: leave sample or trade unresolved.
- Invalid prices: exclude and count a data-quality failure.
- Timestamp gaps: do not treat missing observations as null state; exclude the
  affected lifecycle and use `DATA_GAP` for an open path position.
- Mixed market clocks or insufficient common overlap: current rows remain
  available; path is `PATH_UNAVAILABLE`.
- Fewer than 12 closed forecast trades or comparable decisions: report path
  values with quality status `INSUFFICIENT`.
- Cancellation: release ownership and re-arm artifact TTL.

## Affected Files

| Area | Files |
|---|---|
| Forecast/path | `batch-synthetic-state-miner.ts`, new `batch-signal-lifecycle-types.ts`, new `batch-signal-lifecycle-forecast.ts`, new `batch-signal-selection-path.ts` |
| Server | `batch-backtest-vite-plugin.ts`, `batch-backtest-stream-types.ts` |
| Browser | `batch-backtest-service.ts`, `batch-backtest-dom.ts`, Batch partial |
| Tests | existing miner/server/browser/DOM/copy specs plus forecast, path, and endpoint specs |
| Documentation | Batch server guide, synthetic-pair guide, docs index, root README |

No strategy, manifest, Finder, Worker, SQLite schema, Asset Leadership, or
shared application-state file is affected.

## Performance and Observability

- Process targets sequentially.
- Prepare state indexes once per target.
- Store lifecycle summaries, not per-bar result arrays.
- Keep artifact reads uncached or explicitly bounded.
- Use stable top-K selection rather than full sorting.
- Check cancellation between loads, targets, replay decisions, and benchmarks.
- Log elapsed time and workload counts by load, lifecycle, replay, and path
  phase.
- Keep `batch.benchmark.v1` unchanged; use server diagnostics initially.

## Security and Deployment

The route remains local to the Vite dev/preview server. It derives symbols and
artifact paths from server-owned metadata, returns no internal paths, and keeps
the scalar-only wire boundary. No Cloudflare, Vercel, Worker, credential,
database, or deployment change is required.

## Rollback

1. Remove Direction Forecast controls and browser state.
2. Remove stream events and the Vite route.
3. Remove forecast/path modules and tests.
4. Revert narrow miner helper exports after Mine parity tests pass.

No data migration or cleanup is required.
