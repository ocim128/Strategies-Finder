import assert from "node:assert/strict";
import { resolveTopMeanWorkerCount, TopMeanWorkerPool } from "../lib/batch-backtest/sp500-top-mean-worker-pool";
import type { TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";

function testWorkerCountResolution(): void {
    const defaultCount = resolveTopMeanWorkerCount();
    assert.ok(defaultCount >= 1 && defaultCount <= 24, "Default worker count must be within [1, 24]");

    const explicitCount = resolveTopMeanWorkerCount(12);
    assert.equal(explicitCount, 12, "Explicit worker count 12 must be respected");

    const clampedHigh = resolveTopMeanWorkerCount(32);
    assert.equal(clampedHigh, 24, "Worker count above max must be clamped to 24");
}

function testWorkerPoolCancel(): void {
    const pool = new TopMeanWorkerPool();
    pool.cancel();
    assert.ok(true, "Pool cancellation should succeed cleanly");
}

async function testWorkerPathResolution(): Promise<void> {
    const { resolveTopMeanWorkerPath } = await import("../lib/batch-backtest/sp500-top-mean-worker-pool");
    const path = await resolveTopMeanWorkerPath();
    assert.ok(typeof path === "string" && path.length > 0, "Worker path must be resolved");
}

/**
 * F3 smoke test: persistent worker pool. Spawn N workers, dispatch M > N
 * shards (forcing reuse — each worker must process more than one shard over
 * its lifetime), and verify the pool terminates cleanly on completion.
 *
 * Uses synthetic symbols that will fail candle loading (the worker's
 * per-pair try/catch turns "no data" into a `progress.failed` and continues
 * to the next pair). This exercises the FULL worker pool lifecycle — spawn,
 * dispatch, message handler, free-list return, reuse, terminate — without
 * depending on real market data being present.
 *
 * Without F3, the original per-shard spawn would also pass this test (since
 * it terminates the worker after one shard_complete). The intent of this
 * test is to lock the END-TO-END contract that survives the refactor: the
 * pool processes all shards, surfaces per-pair progress, and leaves no
 * workers active when execute() returns. A regression in worker lifecycle
 * (e.g. a worker not released back to the free-list, or not terminated at
 * the end) shows up here as either a hang or a stale-worker assertion.
 */
async function testPersistentWorkerPoolEndToEnd(): Promise<void> {
    // 9 pairs, shardSize 2 → 5 shards; with workerCount 2, at least one
    // worker MUST process three shards (exercises the reuse path repeatedly).
    const pairs = [
        "FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•", "FAKE_E•+FAKE_F•",
        "FAKE_G•+FAKE_H•", "FAKE_I•+FAKE_J•", "FAKE_K•+FAKE_L•",
        "FAKE_M•+FAKE_N•", "FAKE_O•+FAKE_P•", "FAKE_Q•+FAKE_R•",
    ];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_persistent_pool",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "close_location_median_alignment",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 2,
        totalShards: 5,
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const progressCalls: Array<{ completed: number; total: number }> = [];
    const pool = new TopMeanWorkerPool();
    try {
        const usage = await pool.execute({
            runId: manifest.runId,
            manifest,
            canonicalPairs: pairs,
            strategyKey: "close_location_median_alignment",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
            interval: "4h",
            workerCount: 2,
            shardSize: 2,
            useRustEnginePreference: false,
            onProgress: (completed, total, _text) => {
                progressCalls.push({ completed, total });
            },
        });

        // No real data → no engine use, but the type is { rust, typescript }.
        assert.equal(typeof usage.rust, "number");
        assert.equal(typeof usage.typescript, "number");
    } finally {
        // execute() already calls cancel() internally on success; calling it
        // again here must be a no-op (idempotent) and must not throw.
        pool.cancel();
    }

    // All shards completed (manifest.completedShards reflects the 5 shards
    // even though every pair inside failed to load — the worker's per-pair
    // failure path still allows the shard to complete with empty artifacts).
    assert.equal(manifest.completedShards.length, 5, "All 5 shards must complete even when pairs fail to load");
    // Pair-level failures are recorded. Each fake pair yields < 200 candles,
    // so each contributes one failedPairsCount increment.
    assert.ok(
        manifest.failedPairsCount >= pairs.length,
        `Expected at least ${pairs.length} failed pairs; got ${manifest.failedPairsCount}`,
    );
    // onProgress only fires on per-pair SUCCESS (not failure); with fake
    // symbols nothing loads, so the callback count is 0 by design. The
    // contract this locks is that execute() RETURNS — a stuck free-list or a
    // worker not released would hang here and time out. The progress
    // counter is captured for diagnostic inspection but not asserted > 0.
    assert.ok(Array.isArray(progressCalls), "progress callback list is an array");
    void progressCalls;
}

/**
 * F2 contract test: workers persist across execute() calls when
 * `keepWorkersAlive: true`. Stability mode relies on this — the workers'
 * in-memory dataset LRU caches survive across windows, eliminating the disk
 * JSON re-parse cost per window per pair.
 *
 * The observable contract we lock here is lifecycle correctness, not the
 * cache hit rate (which would require real data and be flaky):
 *   - Two sequential execute() calls on the same pool both complete
 *   - After the final execute() returns with keepWorkersAlive, cancel()
 *     cleanly terminates all workers (no leak)
 *   - The pool can be reused: manifest state from each call is independent
 */
async function testKeepWorkersAliveAcrossExecutes(): Promise<void> {
    const makeManifest = (runId: string, pairs: string[]): TopMeanRunManifest => ({
        schema: "top_mean_run_manifest.v1",
        runId,
        status: "running",
        fingerprint: "smoke",
        strategyKey: "close_location_median_alignment",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 2,
        totalShards: Math.ceil(pairs.length / 2),
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });

    const pairs1 = ["FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•", "FAKE_E•+FAKE_F•"];
    const pairs2 = ["FAKE_G•+FAKE_H•", "FAKE_I•+FAKE_J•", "FAKE_K•+FAKE_L•", "FAKE_M•+FAKE_N•"];
    const manifest1 = makeManifest("f2_window_1", pairs1);
    const manifest2 = makeManifest("f2_window_2", pairs2);

    const baseExecute = {
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
        capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
        interval: "4h",
        workerCount: 2,
        shardSize: 2,
        useRustEnginePreference: false,
    };

    const pool = new TopMeanWorkerPool();
    try {
        // Window 1: keep alive
        const usage1 = await pool.execute({
            ...baseExecute,
            runId: manifest1.runId,
            manifest: manifest1,
            canonicalPairs: pairs1,
            keepWorkersAlive: true,
        });
        assert.equal(manifest1.completedShards.length, 2, "Window 1: both shards complete");

        // Window 2: SAME pool, keepWorkersAlive absorbed the workers from
        // window 1. Without the absorb path, this would either spawn fresh
        // workers (correctness OK but slower) or — if the lifecycle regressed —
        // try to use stale listeners and hang/fail.
        const usage2 = await pool.execute({
            ...baseExecute,
            runId: manifest2.runId,
            manifest: manifest2,
            canonicalPairs: pairs2,
            keepWorkersAlive: true,
        });
        assert.equal(manifest2.completedShards.length, 2, "Window 2: both shards complete");
        assert.equal(typeof usage1.rust, "number");
        assert.equal(typeof usage2.rust, "number");
    } finally {
        // Critical: cancel() must release all workers — both those kept alive
        // from window 1 AND any in-flight from window 2. A leak here would
        // hang the test process.
        pool.cancel();
    }
}

/**
 * Retry-path termination smoke test.
 *
 * Forces every shard to fail (unknown strategy key) so the pool's retry path
 * runs under contention: 5 shards, 2 workers, every shard errors on both the
 * initial attempt and the retry. The contract locked here is that execute()
 * TERMINATES (success or failure) rather than hanging — a stuck free-list /
 * pendingTasks interaction would surface as a test timeout. The current
 * message-handler ordering (reject before releaseWorker) means the retry's
 * runShardOnWorker call always finds the just-released worker in freeWorkers,
 * so this test passes today regardless of the releaseWorker implementation.
 * It remains valuable as a future-proofing smoke against any refactor that
 * inverts that ordering.
 */
async function testRetryDrainsAcrossWorkerRelease(): Promise<void> {
    // Use an unknown strategy to force every shard to post `error`. The
    // worker's per-shard catch turns this into a `type: "error"` message
    // (the worker itself stays alive for reuse).
    const pairs = [
        "FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•", "FAKE_E•+FAKE_F•",
        "FAKE_G•+FAKE_H•", "FAKE_I•+FAKE_J•",
    ];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_retry_drain",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__nonexistent_strategy_for_retry_test__",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 1,   // force one pair per shard → 5 shards, each errors + retries
        totalShards: pairs.length,
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const pool = new TopMeanWorkerPool();
    let executeReturned = false;
    let executeThrew = false;
    try {
        // If releaseWorker() ever fails to drain pendingTasks, execute() hangs
        // and the test times out (the outer `timeout` wrapper kills it).
        //
        // Every shard errors on both the initial attempt AND the retry (same
        // unknown strategy), so execute() ultimately throws. The assertion
        // we care about is that it TERMINATES (settle either way) rather than
        // hanging.
        try {
            await pool.execute({
                runId: manifest.runId,
                manifest,
                canonicalPairs: pairs,
                strategyKey: "__nonexistent_strategy_for_retry_test__",
                strategyParams: {},
                backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
                capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
                interval: "4h",
                workerCount: 2,
                shardSize: 1,
                useRustEnginePreference: false,
            });
            executeReturned = true;
        } catch (err) {
            executeThrew = true;
            assert.ok(err instanceof Error, "execute() rejection is an Error");
            assert.match(
                (err instanceof Error ? err.message : String(err)),
                /not found in manifest|Operation cancelled/,
                `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    } finally {
        pool.cancel();
    }
    assert.ok(executeReturned || executeThrew, "execute() terminated (success or failure) rather than hanging");
}

async function main(): Promise<void> {
    testWorkerCountResolution();
    testWorkerPoolCancel();
    await testWorkerPathResolution();
    await testPersistentWorkerPoolEndToEnd();
    await testKeepWorkersAliveAcrossExecutes();
    await testRetryDrainsAcrossWorkerRelease();
    console.log("PASS: sp500-top-mean-worker-pool.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker-pool.spec.ts", err);
    process.exit(1);
});
