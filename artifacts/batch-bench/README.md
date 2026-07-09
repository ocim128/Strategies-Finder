# Batch Benchmark Artifacts

Structured benchmark JSONs copied from the Batch Backtest tab. Use these for before/after comparisons of Batch Backtest performance changes (parallel worker threads, Rust engine, etc.).

## Protocol

1. Start the dev server with extra heap:
   ```bash
   NODE_OPTIONS=--max-old-space-size=16384 npm run dev
   ```
2. In the UI (Batch Backtest tab), configure and run a batch backtest baseline.
3. Once completed (including Mine Timing and Stability Mine if needed), click **Copy Benchmark** to copy the snapshot to your clipboard.
4. Save the clipboard JSON into this directory (e.g. as `baseline.json`).
5. Apply your changes, restart the server, run the exact same batch configuration in the UI, and copy the new benchmark snapshot (e.g. save as `new_run.json`).
6. Diff the two JSON files. Key fields to compare:
   - `phases.run.totalMs` — time taken for the main batch backtest run.
   - `phases.mine.totalMs` — time taken for Mine Timing.
   - `phases.stability.totalMs` — time taken for Stability Mine.
   - `phases.stability.engine` — which stability engine ran (`typescript`, `typescript_parallel`, `rust`, or `rust_fallback`).
   - `cache` — leg, pair, and disk cache hit rates and sizes.
   - `bottlenecks` — auto-derived bottleneck strings pointing at the likely performance culprit.

## Schema

The copied snapshot is a `BatchBenchmarkSnapshot` JSON following the `batch.benchmark.v1` schema defined in [`lib/batch-backtest/batch-benchmark-snapshot.ts`](../../lib/batch-backtest/batch-benchmark-snapshot.ts).
