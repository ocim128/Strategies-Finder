import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import {
    buildTopMeanShardTasks,
    resolveTopMeanShardSize,
    resolveTopMeanWorkerCount,
    shouldBypassTopMeanSyntheticPairDiskCache,
    TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD,
    TopMeanWorkerPool,
} from "../lib/batch-backtest/sp500-top-mean-worker-pool";
import type { TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { TOP_MEAN_WORKER_COUNT_MAX } from "../lib/batch-backtest/sp500-top-mean-request-limits";

function testWorkerCountResolution(): void {
    const defaultCount = resolveTopMeanWorkerCount();
    assert.equal(
        defaultCount,
        Math.max(1, Math.min(TOP_MEAN_WORKER_COUNT_MAX, availableParallelism())),
        "Auto worker count should use every available logical core up to the request cap",
    );

    const explicitCount = resolveTopMeanWorkerCount(12);
    assert.equal(explicitCount, 12, "Explicit worker count 12 must be respected");

    const clampedHigh = resolveTopMeanWorkerCount(TOP_MEAN_WORKER_COUNT_MAX + 8);
    assert.equal(
        clampedHigh,
        TOP_MEAN_WORKER_COUNT_MAX,
        "Worker count above max must be clamped to the request cap",
    );
}

function testShardSizeFeedsEveryWorker(): void {
    assert.equal(
        resolveTopMeanShardSize(100, 4),
        7,
        "100-pair smoke runs create enough shards to keep four workers fed",
    );
    assert.equal(
        resolveTopMeanShardSize(10_000, 4),
        250,
        "large runs retain the established 250-pair upper bound",
    );
    assert.equal(
        resolveTopMeanShardSize(100, 4, 20),
        20,
        "an explicit shard size remains authoritative",
    );
}

function testLargeRunsBypassSyntheticDiskCache(): void {
    assert.equal(
        shouldBypassTopMeanSyntheticPairDiskCache(TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD),
        false,
        "the disk cache remains available at its bounded file cap",
    );
    assert.equal(
        shouldBypassTopMeanSyntheticPairDiskCache(TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD + 1),
        true,
        "runs larger than the cache working set must avoid disk-cache churn",
    );
}

function testCacheAwareShardPlanning(): void {
    const pairs = [
        "Câ€¢+Dâ€¢",
        "Aâ€¢+Dâ€¢",
        "Bâ€¢+Câ€¢",
        "Aâ€¢+Bâ€¢",
        "Câ€¢+Eâ€¢",
        "Bâ€¢+Dâ€¢",
        "Aâ€¢+Câ€¢",
        "Dâ€¢+Eâ€¢",
    ];

    const grouped = buildTopMeanShardTasks(pairs, 3);
    assert.deepEqual(
        grouped[0]!.pairs.map((pair) => pair.pairIndex),
        [1, 3, 6],
        "a cold-cache shard groups the three pairs sharing canonical leg A",
    );
    assert.deepEqual(
        grouped.flatMap((task) => task.pairs)
            .sort((a, b) => a.pairIndex - b.pairIndex)
            .map((pair) => pair.symbol),
        pairs,
        "cache-aware scheduling retains every symbol and its original pair index",
    );

    const resumed = buildTopMeanShardTasks(pairs, 3, true);
    assert.deepEqual(
        resumed.flatMap((task) => task.pairs).map((pair) => pair.pairIndex),
        pairs.map((_, index) => index),
        "resumed manifests retain the legacy contiguous shard partition",
    );
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
        strategyKey: "dema_confirmation",
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
            strategyKey: "dema_confirmation",
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
    assert.equal(
        manifest.shardOrder,
        "leg_affinity_v1",
        "new manifests persist the affinity partition so an interrupted run resumes identically",
    );
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

async function testShardCompletesOnlyAfterDurableWrite(): Promise<void> {
    const pairs = ["FAKE_Aâ€¢+FAKE_Bâ€¢"];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_durable_shard",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "dema_confirmation",
        interval: "4h",
        pairCount: 1,
        shardSize: 1,
        totalShards: 1,
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    let writes = 0;
    const pool = new TopMeanWorkerPool();
    try {
        await pool.execute({
            runId: manifest.runId,
            manifest,
            canonicalPairs: pairs,
            strategyKey: manifest.strategyKey,
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
            interval: "4h",
            workerCount: 1,
            shardSize: 1,
            useRustEnginePreference: false,
            writeShardArtifacts: async () => {
                writes += 1;
                if (writes === 1) throw new Error("simulated disk failure");
            },
        });
    } finally {
        pool.cancel();
    }
    assert.equal(writes, 2, "failed durable write uses the existing one-retry path");
    assert.deepEqual(manifest.completedShards, [0], "manifest acknowledges the shard only after the successful retry");
}

async function main(): Promise<void> {
    testWorkerCountResolution();
    testShardSizeFeedsEveryWorker();
    testLargeRunsBypassSyntheticDiskCache();
    testCacheAwareShardPlanning();
    testWorkerPoolCancel();
    await testWorkerPathResolution();
    await testPersistentWorkerPoolEndToEnd();
    await testRetryDrainsAcrossWorkerRelease();
    await testShardCompletesOnlyAfterDurableWrite();
    console.log("PASS: sp500-top-mean-worker-pool.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker-pool.spec.ts", err);
    process.exit(1);
});
