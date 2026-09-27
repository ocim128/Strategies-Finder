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
    TOP_MEAN_SHARD_TILE_ASSETS,
    TOP_MEAN_WORKER_FOOTPRINT_BYTES,
    TopMeanWorkerPool,
} from "../lib/batch-backtest/sp500-top-mean-worker-pool";
import type { TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { TOP_MEAN_WORKER_COUNT_MAX } from "../lib/batch-backtest/sp500-top-mean-request-limits";
import { readShardArtifactsAsync, writeShardArtifactsAsync } from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import assert from "node:assert/strict";

const testWorkerPath = fileURLToPath(new URL("./helpers/top-mean-test-worker.cjs", import.meta.url));
const dieOnFirstTaskWorkerPath = fileURLToPath(new URL("./helpers/top-mean-die-on-retry-worker.cjs", import.meta.url));
const exitZeroOnFirstTaskWorkerPath = fileURLToPath(new URL("./helpers/top-mean-exit-zero-worker.cjs", import.meta.url));
const flakyOnceWorkerPath = fileURLToPath(new URL("./helpers/top-mean-flaky-once-worker.cjs", import.meta.url));

function testWorkerCountResolution(): void {
    const hugeRam = Number.MAX_SAFE_INTEGER;
    const defaultCount = resolveTopMeanWorkerCount(undefined, hugeRam);
    assert.equal(
        defaultCount,
        Math.max(1, Math.min(TOP_MEAN_WORKER_COUNT_MAX, availableParallelism())),
        "Auto worker count should use every available logical core up to the request cap when RAM is not binding",
    );

    const explicitCount = resolveTopMeanWorkerCount(12);
    assert.equal(explicitCount, 12, "Explicit worker count 12 must be respected");

    const clampedHigh = resolveTopMeanWorkerCount(TOP_MEAN_WORKER_COUNT_MAX + 8);
    assert.equal(
        clampedHigh,
        TOP_MEAN_WORKER_COUNT_MAX,
        "Worker count above max must be clamped to the request cap",
    );

    // Audit (parse-thrash finding): each worker keeps a whole-universe parsed
    // seed cache, so the AUTO count is bounded by 75% of actual RAM over the
    // sum of per-worker footprints. An explicit count bypasses the ceiling
    // (operator judgment); the floor never drops below one worker.
    const budgetBytes = 4 * TOP_MEAN_WORKER_FOOTPRINT_BYTES;
    assert.equal(
        resolveTopMeanWorkerCount(undefined, budgetBytes),
        3,
        "auto count must be capped at floor(75% RAM / per-worker footprint)",
    );
    assert.equal(
        resolveTopMeanWorkerCount(undefined, 1),
        1,
        "the memory ceiling must never resolve below one worker",
    );
    assert.equal(
        resolveTopMeanWorkerCount(24, 1),
        24,
        "an explicit worker count bypasses the memory ceiling (operator judgment)",
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

    // Cache-locality finding: the default layout is asset_tile_v1 — every
    // pair's BOTH legs must belong to its shard's combined leg set so a
    // worker's 24-leg LRU warms once per shard instead of churning one new
    // second leg per pair.
    const tiled = buildTopMeanShardTasks(pairs, 3);
    const legsOf = (symbol: string): string[] => symbol.split("+").map((leg) => leg.trim().toUpperCase());
    for (const task of tiled) {
        const legs = new Set<string>();
        for (const { symbol } of task.pairs) {
            for (const leg of legsOf(symbol)) legs.add(leg);
        }
        assert.ok(
            legs.size <= 2 * TOP_MEAN_SHARD_TILE_ASSETS,
            `shard ${task.shardIndex} must keep its combined leg set within the worker LRU budget`,
        );
    }
    assert.deepEqual(
        tiled.flatMap((task) => task.pairs)
            .sort((a, b) => a.pairIndex - b.pairIndex)
            .map((pair) => pair.symbol),
        pairs,
        "tile scheduling retains every symbol and its original pair index",
    );
    assert.deepEqual(
        buildTopMeanShardTasks(pairs, 3),
        tiled,
        "tile partitioning is deterministic so resumed runs recompute identical shard indexes",
    );

    // With more legs than one tile holds, shards are one (groupA, groupB)
    // combination each and never mix a foreign leg into a shard's leg set.
    const wideLegs = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}•`);
    const widePairs: string[] = [];
    for (let i = 0; i < wideLegs.length; i += 1) {
        for (let j = i + 1; j < wideLegs.length; j += 1) {
            widePairs.push(`${wideLegs[i]!}+${wideLegs[j]!}`);
        }
    }
    const wideTiled = buildTopMeanShardTasks(widePairs, 250);
    for (const task of wideTiled) {
        const legs = new Set<string>();
        for (const { symbol } of task.pairs) {
            for (const leg of legsOf(symbol)) legs.add(leg);
        }
        assert.ok(
            legs.size <= 2 * TOP_MEAN_SHARD_TILE_ASSETS,
            "every tile shard stays inside the combined leg budget",
        );
    }
    assert.deepEqual(
        wideTiled.flatMap((task) => task.pairs)
            .sort((a, b) => a.pairIndex - b.pairIndex)
            .map((pair) => pair.symbol),
        widePairs,
        "the dense matrix keeps every pair exactly once with its original index",
    );

    // Legacy affinity layout stays reachable for manifests pinned to it.
    const grouped = buildTopMeanShardTasks(pairs, 3, false, "leg_affinity_v1");
    assert.deepEqual(
        grouped[0]!.pairs.map((pair) => pair.pairIndex),
        [1, 3, 6],
        "a leg_affinity_v1 shard groups the three pairs sharing canonical leg A",
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
    // 27 legs spanning three 12-asset tiles → six non-empty (groupA, groupB)
    // shard combinations; with workerCount 2 at least one worker MUST process
    // more than one shard (exercises the reuse path repeatedly).
    const legs = Array.from({ length: 27 }, (_, i) => `FAKE_L${String(i).padStart(2, "0")}•`);
    const pairs = [
        `${legs[0]!}+${legs[1]!}`,   // (0,0)
        `${legs[0]!}+${legs[12]!}`,  // (0,1)
        `${legs[0]!}+${legs[24]!}`,  // (0,2)
        `${legs[12]!}+${legs[13]!}`, // (1,1)
        `${legs[12]!}+${legs[24]!}`, // (1,2)
        `${legs[24]!}+${legs[25]!}`, // (2,2)
    ];
    // Introduce every remaining leg so the leg universe really spans three
    // tiles; each filler pair stays inside its own group.
    for (let i = 2; i < legs.length; i += 1) {
        if (i === 12 || i === 13 || i === 24 || i === 25) continue;
        pairs.push(`${legs[i]!}+${legs[i - (i % 12)]!}`);
    }
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_persistent_pool",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__test_success__",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 2,
        totalShards: 6,
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
    assert.equal(manifest.completedShards.length, 6, "All 6 tile shards must complete even when pairs fail to load");
    assert.equal(
        manifest.shardOrder,
        "asset_tile_v1",
        "new manifests persist the tile partition so an interrupted run resumes identically",
    );
    assert.equal(manifest.failedPairsCount, 0, "deterministic worker should not report pair failures");
    assert.equal(progressCalls.length, pairs.length, "every completed pair should emit progress");
}

async function testFailedPairsRemainVisibleInProgress(): Promise<void> {
    const pairs = ["FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•"];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_failed_progress",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__test_failed_progress__",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 2,
        totalShards: 1,
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const progressText: string[] = [];
    const pool = new TopMeanWorkerPool();
    try {
        await pool.execute({
            runId: manifest.runId,
            manifest,
            canonicalPairs: pairs,
            strategyKey: "__test_failed_progress__",
            strategyParams: {},
            backtestSettings: { direction: "long", slippage: 0, commission: 0 } as any,
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 } as any,
            interval: "4h",
            workerCount: 1,
            shardSize: 2,
            useRustEnginePreference: false,
            workerPath: testWorkerPath,
            onProgress: (_completed, _total, text) => progressText.push(text),
        });
    } finally {
        pool.cancel();
    }
    assert.equal(manifest.failedPairsCount, 2);
    assert.match(progressText[0]!, /Backtesting pair 1\/2 \(0 completed, 1 failed\)/);
    assert.match(progressText[1]!, /Backtesting pair 2\/2 \(0 completed, 2 failed\)/);
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
        // Pin the legacy layout: this test locks retry-drain semantics that
        // assume one pair per shard, not the tile partition.
        shardOrder: "leg_affinity_v1",
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
            writeShardArtifactsBytes: async () => {
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
            // Pin the legacy layout so both pairs are separate shards and
            // both workers die mid-task (worker-loss semantics fixture).
            shardOrder: "leg_affinity_v1",
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

/**
 * Audit (exit-code-0 hang finding): onExit used to reject an in-flight task
 * only when the exit code was non-zero, so a worker calling process.exit(0)
 * mid-shard left its promise pending forever. With 2 workers / 2 shards both
 * workers die mid-task while the OTHER is still alive, so the all-workers-
 * dead drain cannot help — the stuck promises are IN FLIGHT, not queued — and
 * Promise.race(activePromises) hung forever. execute() must instead reject
 * within a bounded time ("Worker exited while processing shard N (code 0)"),
 * turning worker loss into the existing retry path.
 */
async function testWorkerExitCodeZeroFailsInFlightTask(): Promise<void> {
    const pairs = ["FAKE_A•+FAKE_B•", "FAKE_C•+FAKE_D•"];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_exit_zero",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__test_success__",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 1,
        // Pin the legacy layout so both pairs are separate shards and both
        // workers die mid-task (worker-loss semantics fixture).
        shardOrder: "leg_affinity_v1",
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
                workerPath: exitZeroOnFirstTaskWorkerPath,
            }),
            new Promise<never>((_resolve, reject) => {
                setTimeout(
                    () => reject(new Error(
                        "execute() hung: a worker exiting with code 0 mid-task must fail its in-flight shard, not wait forever",
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
            /Worker exited while processing shard|No worker available|All TOP_MEAN workers died|Operation cancelled/,
            `execute() must reject with a worker-loss diagnostic, got: ${message}`,
        );
        // The shard failed in flight on BOTH attempts — the manifest must not
        // claim it completed.
        assert.equal(manifest.completedShards.length, 0, "a shard whose worker exited mid-task must not be acknowledged as completed");
    } finally {
        pool.cancel();
    }
    console.log("PASS: worker exit with code 0 rejects the in-flight task");
}

/**
 * Audit (retry-success finding): a shard that errored once was recorded in
 * failedShards; when its retry succeeded it was ALSO recorded in
 * completedShards and never removed from failedShards, so the manifest
 * claimed the same shard both failed and completed. Resume survives (the
 * pending filter keeps completed shards), but diagnostics and status counts
 * lie. The flaky-once fixture errors the first attempt and completes the
 * retry; the final manifest must list the shard ONLY as completed.
 */
async function testRetrySuccessClearsFailedShard(): Promise<void> {
    const pairs = ["FAKE_A•+FAKE_B•"];
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId: "smoke_test_retry_clears_failed",
        status: "running",
        fingerprint: "smoke",
        strategyKey: "__test_success__",
        interval: "4h",
        pairCount: pairs.length,
        shardSize: 1,
        totalShards: 1,
        completedShards: [],
        failedShards: [],
        completedPairsCount: 0,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
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
            workerPath: flakyOnceWorkerPath,
        });
    } finally {
        pool.cancel();
    }
    assert.deepEqual(manifest.completedShards, [0], "the retry must complete the shard");
    assert.deepEqual(
        manifest.failedShards,
        [],
        "a shard whose retry succeeded must be removed from failedShards — it cannot be both failed and completed",
    );
    assert.equal(manifest.completedPairsCount, 1);
    console.log("PASS: successful retry removes the shard from failedShards");
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

/**
 * Phase 1 persistence baseline (top-mean coordinator optimization plan):
 * lock the current JSON.stringify semantics of persisted shard artifacts —
 * optional fields stay absent when not set, nonfinite numbers serialize to
 * null, and Unicode symbols survive the round trip byte-for-byte. The
 * byte-transfer phase must keep these exact semantics.
 */
async function testShardArtifactPersistenceShape(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-pool-shard-shape-"));
    try {
        const artifacts = [
            {
                schema: "compact_pair_artifact.v1",
                pairIndex: 0,
                symbol: "STRÜM•A+STRÜM•B",
                baseAsset: "STRÜM•A",
                quoteAsset: "STRÜM•B",
                baseSymbol: "STRÜM•A",
                quoteSymbol: "STRÜM•B",
                trades: [
                    { type: "long", entryTime: 1700000000, exitTime: 1700003600, pnl: 12.5 },
                    { type: "short", entryTime: 1700003600, exitTime: Number.NaN, pnl: Number.POSITIVE_INFINITY },
                ],
                netProfit: Number.NaN,
                dataEndTime: 1701038400,
            },
            {
                schema: "compact_pair_artifact.v1",
                pairIndex: 1,
                symbol: "AAA+BBB",
                baseAsset: "AAA",
                quoteAsset: "BBB",
                baseSymbol: "AAA",
                quoteSymbol: "BBB",
                trades: [],
            },
        ];
        await writeShardArtifactsAsync("spec_shard_shape", 0, artifacts, baseDir);
        const parsed = await readShardArtifactsAsync("spec_shard_shape", 0, baseDir);
        assert.ok(parsed, "the persisted shard must be readable");
        assert.equal(parsed.length, 2);
        // Unicode identity survives the round trip.
        assert.equal(parsed[0]!.symbol, "STRÜM•A+STRÜM•B");
        // Optional fields present stay present.
        assert.equal(parsed[0]!.dataEndTime, 1701038400);
        // Nonfinite numbers serialize to null (JSON.stringify semantics).
        assert.equal((parsed[0] as any).netProfit, null);
        assert.equal((parsed[0]!.trades[1] as any).exitTime, null);
        assert.equal((parsed[0]!.trades[1] as any).pnl, null);
        // Optional fields absent stay absent (no zero-filling).
        assert.equal("netProfit" in parsed[1]!, false);
        assert.equal("dataEndTime" in parsed[1]!, false);
        console.log("PASS: shard artifact persistence shape (optional/Unicode/nonfinite)");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
}

/**
 * Shard byte-transfer contract (top-mean coordinator optimization plan,
 * idea #3): the REAL worker bundle posts shard_complete with a TRANSFERRED
 * owned ArrayBuffer of UTF-8 JSON — not structured-cloned artifact objects.
 * A regression to a plain-object payload shows up here as a non-ArrayBuffer
 * artifactsBytes. The written file must parse back to the artifacts the
 * worker produced.
 */
async function testRealWorkerTransfersSerializedBytes(): Promise<void> {
    const { resolveTopMeanWorkerPath } = await import("../lib/batch-backtest/sp500-top-mean-worker-pool");
    const { serializeShardArtifacts } = await import("../lib/batch-backtest/sp500-top-mean-worker");
    const { Worker } = await import("node:worker_threads");
    const workerPath = await resolveTopMeanWorkerPath();
    assert.equal(serializeShardArtifacts([]).byteLength, 2, "empty shard serializes to the JSON array literal");
    const worker = new Worker(workerPath);
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-pool-bytes-"));
    try {
        const done = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("real worker did not emit shard_complete in time")), 30_000);
            worker.on("message", (msg: any) => {
                if (msg.type !== "shard_complete") return;
                clearTimeout(timeout);
                try {
                    assert.ok(msg.artifactsBytes instanceof ArrayBuffer, "artifactsBytes must be a transferred ArrayBuffer");
                    const parsed = JSON.parse(Buffer.from(msg.artifactsBytes).toString("utf8"));
                    assert.ok(Array.isArray(parsed), "the transferred bytes decode to the artifact array");
                    assert.equal(typeof msg.performance.signalGenerationMs, "number");
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
            worker.on("error", (err: Error) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        worker.postMessage({
            shardIndex: 0,
            pairs: [{ pairIndex: 0, symbol: "AAPL•+MSFT•" }],
            strategyKey: "dema_confirmation",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: { direction: "long", slippage: 0, commission: 0 },
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 },
            interval: "4h",
            useRustEnginePreference: false,
        });
        await done;
        console.log("PASS: real worker transfers serialized shard bytes");
    } finally {
        await worker.terminate();
        rmSync(baseDir, { recursive: true, force: true });
    }
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
    await testFailedPairsRemainVisibleInProgress();
    await testRetryDrainsAcrossWorkerRelease();
    await testShardCompletesOnlyAfterDurableWrite();
    await testAllWorkersDyingDuringQueuedRetryRejects();
    await testWorkerExitCodeZeroFailsInFlightTask();
    await testRetrySuccessClearsFailedShard();
    await testShardArtifactPersistenceShape();
    await testRealWorkerTransfersSerializedBytes();
    console.log("PASS: sp500-top-mean-worker-pool.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-worker-pool.spec.ts", err);
    process.exit(1);
});
