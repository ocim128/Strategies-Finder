# Batch Benchmark Artifacts

The **Copy Benchmark** button in the Batch Backtest tab produces a compact,
versioned JSON snapshot for before/after performance comparisons.

## Protocol

1. Start the dev server with enough heap for the workload:

   ```bash
   NODE_OPTIONS=--max-old-space-size=16384 npm run dev
   ```

2. Run the same Batch configuration before and after the code change.
3. Click **Copy Benchmark** after each terminal run and save the JSON here,
   for example as `baseline.json` and `new-run.json`.
4. Diff the files. Keep the strategy, interval, symbol list, and engine choice
   identical when measuring a performance change.

The snapshot records the run mode, strategy, interval, engine mode, terminal
outcome, one run-phase timing, loader cache counters, and automatically derived
bottleneck notes. The `phases.run` counters distinguish attempted, completed,
failed, cancelled, and skipped rows.

## Schema

The JSON follows the `batch.benchmark.v2` schema defined in
[`lib/batch-backtest/batch-benchmark-snapshot.ts`](../../lib/batch-backtest/batch-benchmark-snapshot.ts).
`cacheSource` identifies whether counters came from the browser loader, the
server stream, or were unavailable. Server-side synthetic-pair disk-cache
statistics are present in `cache.disk`; they are zero in browser-only runs.
