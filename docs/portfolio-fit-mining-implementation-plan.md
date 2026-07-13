# Portfolio Fit

Portfolio Fit is a diagnostic Batch post-analysis. It answers which current
Stability `ENTER` candidates can be combined without exceeding simple portfolio
risk limits. It does not read real holdings, place orders, or independently
validate Stability evidence.

## Inputs

- the latest Stability result for the matching Batch fingerprint;
- target-asset close-to-close return series from retained Batch artifacts;
- initial capital and the base allocation resolved from current sizing settings.

Only fresh `ENTER` rows are evaluated. Stability already explains `WATCH`,
`WAIT`, `REJECT`, and `INVALID` rows, so Portfolio Fit does not repeat them.

## Allocation rule

Candidates are ranked deterministically by uncertainty-adjusted Stability edge
relative to standalone downside risk. For each candidate, the engine tries:

1. the smaller of its resolved base allocation and the per-candidate cap;
2. half that allocation when the full allocation violates a constraint.

An allocation is rejected when it breaches gross exposure, net capital,
positive-correlation, or marginal expected-shortfall limits. Accepted full-size
positions are `ADD`; accepted half-size positions are `ADD_SMALL`; otherwise the
candidate is `DEFER`.

The engine uses target-asset returns. A Stability dominant synthetic pair is
supporting evidence, not a portfolio position, so it is not converted into
artificial shared-leg exposure.

## Sizing provenance

Portfolio Fit never recalculates Kelly. Post-analysis does not retain the rolling
trade history required to reproduce a Kelly fraction. When Kelly, Optimal-f, or
Secure-f is selected, the output reports the configured mode separately from the
fixed/percent fallback actually used for the base allocation.

## Runtime contract

- Server-side Batch is the supported execution path.
- `POST /api/batch-backtest/portfolio-fit` streams bounded scalar progress and a
  scalar result through the existing Batch NDJSON transport.
- The operation shares the Batch miner ownership lock and retained-artifact TTL.
- Portfolio Fit does not release artifacts.
- Results are not restored from local snapshots because recommendations are
  time-sensitive; rerun Portfolio Fit after reload.

## Output and limitations

Each row includes the allocation, historical per-bar risk metrics, acceptance
reasons, and the constraint that prevented a full allocation. Results are always
labelled experimental and diagnostic-only. Independent historical validation is
not implemented; current Stability evidence must not be replayed at past cutoffs
and described as validation.

No OHLCV, signal, trade, or equity arrays cross the server/browser boundary.

## Required validation

- `npm run typecheck`
- `npm run typecheck:tests`
- Portfolio Fit engine, copy, statistics, and server-plugin focused specs
- `npm test`
