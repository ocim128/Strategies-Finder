import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
    buildTopMeanShardTasks,
    buildTopMeanWorkerTaskData,
    resolveTopMeanShardSize,
    resolveTopMeanWorkerCount,
    shouldBypassTopMeanSyntheticPairDiskCache,
    TOP_MEAN_DISK_CACHE_BYPASS_PAIR_THRESHOLD,
    TopMeanWorkerPool,
} from "../lib/batch-backtest/sp500-top-mean-worker-pool";
import type { TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { TOP_MEAN_WORKER_COUNT_MAX } from "../lib/batch-backtest/sp500-top-mean-request-limits";

const testWorkerPath = fileURLToPath(new URL("./helpers/top-mean-test-worker.cjs", import.meta.url));
const dieOnFirstTaskWorkerPath = fileURLToPath(new URL("./helpers/top-mean-die-on-retry-worker.cjs", import.meta.url));

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
    assert.doesNotThrow(() => pool.cancel(), "Pool cancellation should succeed cleanly");
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
        strategyKey: "__test_success__",
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
            strategyKey: "__test_success__",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
            interval: "4h",
            workerCount: 2,
            shardSize: 2,
            useRustEnginePreference: false,
            workerPath: testWorkerPath,
            onProgress: (completed, total, _text) => {
                progressCalls.push({ completed, total });
            },
        });

        // The deterministic worker reports zero-duration TypeScript work, but
        // the pool still aggregates the stable { rust, typescript } shape.
        assert.equal(typeof usage.rust, "number");
        assert.equal(typeof usage.typescript, "number");
    } finally {
        // execute() already calls cancel() internally on success; calling it
        // again here must be a no-op (idempotent) and must not throw.
        pool.cancel();
    }

    // All shards completed and the deterministic worker emitted one empty
    // artifact result per pair.
    assert.equal(manifest.completedShards.length, 5, "All 5 shards must complete even when pairs fail to load");
    assert.equal(
        manifest.shardOrder,
        "leg_affinity_v1",
        "new manifests persist the affinity partition so an interrupted run resumes identically",
    );
    assert.equal(manifest.failedPairsCount, 0, "deterministic worker should not report pair failures");
    assert.equal(progressCalls.length, pairs.length, "every completed pair should emit progress");
}

/**
 * Retry-path termination smoke test.
 *
 * Forces every shard to fail (deterministic worker error) so the pool's retry path
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
    // The test worker posts a deterministic `type: "error"` message while
    // remaining alive for reuse.
    const pairs = [
        "FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•", "FAKE_E•+FAKE_F•",
        "FAKE_G•+FAKE_H•", "FAKE_I•+FAKE_J•",
    ];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_retry_drain",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__test_retry__",
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
                strategyKey: "__test_retry__",
                strategyParams: {},
                backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
                capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
                interval: "4h",
                workerCount: 2,
                shardSize: 1,
                useRustEnginePreference: false,
                workerPath: testWorkerPath,
            });
            executeReturned = true;
        } catch (err) {
            executeThrew = true;
            assert.ok(err instanceof Error, "execute() rejection is an Error");
            assert.match(
                (err instanceof Error ? err.message : String(err)),
                /deterministic retry failure|Operation cancelled/,
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
        strategyKey: "__test_success__",
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
    const progressCalls: Array<{ completed: number; total: number }> = [];
    const pool = new TopMeanWorkerPool();
    try {
        await pool.execute({
            runId: manifest.runId,
            manifest,
            canonicalPairs: pairs,
            strategyKey: "__test_success__",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
            interval: "4h",
            workerCount: 1,
            shardSize: 1,
            useRustEnginePreference: false,
            workerPath: testWorkerPath,
            writeShardArtifacts: async () => {
                writes += 1;
                if (writes === 1) throw new Error("simulated disk failure");
            },
            onProgress: (completed, total, _text) => {
                progressCalls.push({ completed, total });
            },
        });
    } finally {
        pool.cancel();
    }
    assert.equal(writes, 2, "failed durable write uses the existing one-retry path");
    assert.deepEqual(manifest.completedShards, [0], "manifest acknowledges the shard only after the successful retry");
    // Audit (retry-accounting finding): the shard retry re-runs every pair and
    // re-emits "completed" progress. Counters and progress events must be
    // deduped by the stable pairIndex — a one-pair shard retried once must
    // still report exactly one completed pair, never completed > total.
    assert.equal(manifest.completedPairsCount, 1, "retried shard must not double-count the completed pair");
    assert.equal(progressCalls.length, 1, "retried pair must emit progress exactly once");
}

/**
 * Audit (all-workers-dead hang): a retry that is queued in pendingTasks while
 * the LAST worker dies can never settle — nothing will ever call its dispatch
 * callback — so Promise.race(activePromises) used to hang forever and even
 * Stop could not release the coordinator. With the fixture worker (silently
 * exits on its first task), both shards fail in flight, both retries queue,
 * and execute() must REJECT (drain-on-worker-loss / liveness guard) within a
 * bounded time instead of hanging.
 */
async function testAllWorkersDyingDuringQueuedRetryRejects(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-pool-die-"));
    try {
        const pairs = ["FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•"];
        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId: "smoke_test_all_workers_die",
            status: "running",
            fingerprint: "smoke",
            strategyKey: "__test_success__",
            interval: "4h",
            pairCount: pairs.length,
            shardSize: 1,
            totalShards: 2,
            completedShards: [],
            failedShards: [],
            completedPairsCount: 0,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const pool = new TopMeanWorkerPool();
        try {
            await Promise.race([
                pool.execute({
                    runId: manifest.runId,
                    manifest,
                    canonicalPairs: pairs,
                    strategyKey: "__test_success__",
                    strategyParams: { lookback: 20, threshold: 0.5 },
                    backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
                    capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
                    interval: "4h",
                    workerCount: 2,
                    shardSize: 1,
                    useRustEnginePreference: false,
                    workerPath: dieOnFirstTaskWorkerPath,
                    baseDir,
                }),
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () => reject(new Error(
                            "execute() hung: worker death with queued retries must terminate the run, not wait forever",
                        )),
                        15_000,
                    );
                }),
            ]);
            assert.fail("execute() must not resolve: the fixture workers never produce shard_complete");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            assert.match(
                message,
                /No worker available|All TOP_MEAN workers died|Worker stopped with exit code|Operation cancelled/,
                `execute() must reject with a worker-loss diagnostic, got: ${message}`,
            );
        } finally {
            pool.cancel();
        }
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
    console.log("PASS: all-workers-die during queued retries rejects instead of hanging");
}

function testRunLevelNowSecThreadsIntoWorkerTasks(): void {
    const options = {
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20 },
        backtestSettings: { direction: "long" } as any,
        capitalSettings: { initialCapital: 10000 } as any,
        interval: "4h",
        useRustEnginePreference: false,
        nowSec: 1_760_000_000,
    };
    const task = { shardIndex: 3, pairs: [{ pairIndex: 7, symbol: "AAPL•+MSFT•" }] };
    const data = buildTopMeanWorkerTaskData(options, task, true);
    // Audit (wall-clock-cutoff finding): the coordinator captures ONE cutoff
    // per run and every worker task must carry it verbatim so all shards
    // share the same closed-candle semantics.
    assert.equal(data.nowSec, 1_760_000_000);
    assert.equal(data.shardIndex, 3);
    assert.deepEqual(data.pairs, task.pairs);
    assert.equal(data.preferInMemorySyntheticPairs, true);

    const noNowSec = buildTopMeanWorkerTaskData({ ...options, nowSec: undefined }, task, false);
    assert.equal(
        "nowSec" in noNowSec,
        false,
        "a run without an injected cutoff must keep the worker's own Date.now() fallback",
    );
    assert.equal(noNowSec.preferInMemorySyntheticPairs, false);
}

async function main(): Promise<void> {
    testWorkerCountResolution();
    testShardSizeFeedsEveryWorker();
    testLargeRunsBypassSyntheticDiskCache();
    testCacheAwareShardPlanning();
    testWorkerPoolCancel();
    testRunLevelNowSecThreadsIntoWorkerTasks();
    await testWorkerPathResolution();
    await testPersistentWorkerPoolEndToEnd();
    await testRetryDrainsAcrossWorkerRelease();
    await testShardCompletesOnlyAfterDurableWrite();
    await testAllWorkersDyingDuringQueuedRetryRejects();
    console.log("PASS: sp500-top-mean-worker-pool.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker-pool.spec.ts", err);
    process.exit(1);
});
