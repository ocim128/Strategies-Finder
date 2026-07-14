# Counterfactual Timing Surface — Design Note

## What this feature is

Timing Surface is a Batch post-analysis that converts a fresh Stability
`ENTER` row into a tested entry-timing policy. For each eligible asset it
evaluates a fixed grid of entry delays (`0..3` bars) × hold horizons and
emits one decision: `ENTER_NOW`, `WAIT_1..3`, `WATCH`, `SKIP`, or
`INVALID`.

It is **research and decision support only**. It does not place orders,
schedule evaluations, change strategy settings, create Worker alerts, or
claim causal proof. Every Phase 1–4 result carries
`evidenceScope: "historical_conditional"` and `exploitEligible: false`.

## Architecture

```
Batch Run → retained pair artifacts
         → Stability Mine → server-retained Stability result + cost model
         → POST /api/batch-backtest/timing-surface (fingerprint + interval only)
         → load target OHLCV + reconstruct exact Stability subsets
         → pure engine evaluates the delay×horizon grid per rerun
         → bounded scalar NDJSON result → browser UI + Copy
```

- **Server-side only.** The workload is too heavy for the browser; a Vite
  server runtime (`vite dev` or `vite preview`) is required.
- **Single miner ownership lock.** Timing Surface shares `minerOwner` with
  Mine Timing, Stability Mine, and Portfolio Fit — they are mutually exclusive.
- **Does NOT release artifacts.** Re-arms the 10-minute TTL in `finally` so a
  later Stability rerun can reuse them.
- **Retained server context.** A successful Stability run stores its scalar
  result + normalized cost model under the active fingerprint. The timing
  endpoint accepts only `fingerprint` and `interval` — never browser-supplied
  Stability rows, cost overrides, or subset seeds. If the retained context is
  missing, the endpoint returns `STABILITY_CONTEXT_MISSING`.

## Research contract

### Chronological windows

Each target is split by target-bar position into 60% discovery, 20%
selection, 20% validation. The horizon grid is calibrated ONCE per target
from discovery-only closed linked-pair trades (rounded `[0.5x, 1x, 2x]` of
the discovery median hold; fallback `[6, 12, 24]`). Selection and validation
cannot change the grid.

### Per-rerun evaluation

The engine reconstructs the exact Stability subsets via
`sampleItems(preparedPairs, subsetSize, seed + runIndex)`. A rerun contributes
cell metrics only when its miner verdict for the target matches the retained
Stability row direction. Historical episodes duplicated across reruns are
never pooled as independent observations — metrics are computed per cell per
rerun, then aggregated as median + 10th percentile across reruns.

### Nearest-analog selection

Per rerun, the engine builds the current-state snapshot at the most recent
target bar, then selects top-K nearest analogs SEPARATELY in each window
(discovery, selection, validation) using frozen discovery-calibrated distance
scales. One window cannot consume another's neighbor quota. Neighbor limits
mirror Mine Timing (`neighborCountMin = 4`, `neighborCountMax = 24`).

### Boundary isolation

A sample is purged when its actual fill indexes (after the execution shift)
cross the window boundary. For `signal_close` the fill is at the candle
close; for `next_open`/`next_close` it shifts one bar forward. Both the
entry fill AND the exit fill must satisfy `windowStart <= fillIndex <
windowEnd`.

### Delayed-state reconstruction

For delay > 0, the engine reconstructs the synthetic state at
`barIndex + delay` (NOT the original analog bar) and requires its direction
to still match. A `WAIT_n` recommendation means "if the state at the delayed
bar still matches this pattern" — it is a revalidation instruction, not a
scheduled order.

### Cost-aware returns

Net return applies entry commission on entry notional and exit commission on
exit notional after adverse entry/exit slippage. `commissionRate =
commissionPercent / 100`, `slippageRate = slippageBps / 10000`. Entry/exit
fills mirror the Batch execution-model semantics and reuse `applySlippage`.
Missing execution bars are excluded, not zero-filled.

### Gates

- A rerun/cell/window metric requires ≥4 independent episodes.
- A cell must qualify independently in discovery, selection, and validation in
  ≥5 reruns AND ≥10% of configured reruns.
- Delay-zero cells require positive median net return in discovery and
  selection. Delayed cells additionally require positive median lift over
  immediate entry.
- Plateau requires ≥2 strictly adjacent orthogonal neighbors (same delay +
  horizon ±1 step, OR same horizon + delay ±1 step) with positive selection
  median net return.
- Selection ranking: selection positive-rerun **rate** (not raw count),
  median lift, median net return, lower delay, shorter horizon.
- Validation passes only when ≥60% of validation-evaluable matching-direction
  reruns are net positive, median validation net is positive, and (delay > 0)
  median validation lift is positive.
- Negative validation net expectancy or non-positive delayed lift → `SKIP`
  (preserving the frozen cell's evidence). Insufficient evidence → `WATCH`.

## Failure handling

- Missing/expired artifacts, fingerprint mismatch, missing retained Stability
  context → fatal with a clear error.
- Stop aborts target loads and the engine between bounded work units
  (per-target and per-cell). The engine yields to the event loop between
  cells so the HTTP Stop handler can run.
- `finally` re-arms the artifact TTL; artifacts are never released by Timing
  Surface.
- Browser requires exactly one terminal NDJSON event and restores button
  states on success, cancellation, parse failure, HTTP error, or premature
  stream end.

## Stream contract

`POST /api/batch-backtest/timing-surface` — NDJSON stream. Request body:
`{ fingerprint, interval }`. Events: `start` → `done`/`fatal` (no `progress`
events — the engine is a single grid evaluation with no meaningful per-rerun
progress). The `done` event carries a single scalar-only `TimingSurfaceResult`.

The result, rows, and per-row cell summaries are scalar-only and bounded.
No OHLCV, signals, trades, equity curves, selected samples, or per-sample
timestamps cross to the browser.

## Status

Phases 1–4 are shipped. Phase 5 (frozen-policy shadow evaluation with SQLite
persistence, future-run reconciliation, and qualification gating) is **not
implemented** — it was removed as speculative architecture with no production
caller. It should be reintroduced only when a freeze/evaluate workflow is
explicitly authorized.

## Performance expectations

- Pair artifacts are loaded and prepared ONCE per request.
- Per-rerun analog selection and delayed-state reconstruction are hoisted out
  of the cell grid — the cell loop is pure cost math.
- The engine is async and yields between cells so Stop is reachable.
- The profile exposes `targetLoadMs`, `subsetReconstructionMs`,
  `analogReconstructionMs`, `engineMs`, `aggregationMs`, plus counts for
  targets/reruns/cells/boundary-purged samples.
