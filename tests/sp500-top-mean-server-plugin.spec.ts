import assert from "node:assert/strict";
import { debugLogger } from "../lib/debug-logger";
import { TOP_MEAN_RUN_MAX_BODY_BYTES } from "../lib/batch-backtest/sp500-top-mean-request-limits";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildTopMeanAnnualReplayWindows,
    capTopMeanEventDetailsForWire,
    orderTopMeanReplayTargets,
    setActiveTopMeanCoordinatorEngineForTests,
    shouldEmitTopMeanReplayProgress,
    toWireSafeTopMeanResultSummary,
    TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS,
    TOP_MEAN_REPLAY_TARGET_CACHE_MAX_ENTRIES,
    TOP_MEAN_REPLAY_TARGET_PREFETCH_CONCURRENCY,
    TopMeanCoordinatorEngine,
    type TopMeanResultSummary,
    type TopMeanCoordinatorRunRequest,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import {
    computeRunFingerprint,
    getArtifactsRootDir,
    getRunDir,
    iterateRunRawCompactArtifacts,
    loadManifest,
    saveManifest,
    writeShardArtifacts,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import type { EnumerationResult } from "../lib/batch-backtest/sp500-pair-enumerator";
import { clearServerBatchDatasetCaches } from "../lib/batch-backtest/server-batch-data-loader";
import { makeBacktestSettings, makeCapitalSettings } from "./helpers/backtest-settings-fixtures";
import type { CompactPairArtifact, TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { computeCurrentTopMeanSnapshot } from "../lib/batch-backtest/sp500-top-mean-current-snapshot";
import type { Time } from "lightweight-charts";
import {
    handleSp500TopMeanStatusRequest,
    registerSp500TopMeanRoutes,
} from "../lib/batch-backtest/sp500-top-mean-vite-routes";

/**
 * Coordinator + persistence tests for the Phase-1 current snapshot.
 *
 * Two responsibilities locked here:
 *   1. The snapshot is derived from on-disk compact artifacts via the SAME
 *      iterator the coordinator uses at runtime (so a completed run's
 *      snapshot is reproducible from its shards alone).
 *   2. The result.json augmentation is additive: existing replayResult fields
 *      survive, currentSnapshot rides alongside.
 */

async function testEngineValidationAndConflict(): Promise<void> {
    const request = {
        runId: "spec_test_run_1",
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20 },
        backtestSettings: { mode: "long" },
        capitalSettings: { initialCapital: 10000 },
        interval: "4h",
        horizons: [12, 24, 48],
        maxPairs: 2,
        saveArchiveLog: false,
    };

    const engine = new TopMeanCoordinatorEngine(request as any);
    const status = engine.getStatus();

    assert.equal(status.runId, "spec_test_run_1");
    assert.equal(status.status, "running");
    assert.equal(status.phase, "preflight");
    assert.equal(status.archiveRequested, false);
    assert.equal(engine.request.saveArchiveLog, false);

    // Test stop
    engine.stop();
    const stoppedStatus = engine.getStatus();
    assert.equal(stoppedStatus.phase, "interrupted");

    console.log("PASS: engine validation/stop contract unchanged");
}

function testReplayTargetOrderAvoidsLruThrash(): void {
    const targets = ["A", "B", "C"];
    assert.deepEqual(orderTopMeanReplayTargets(targets, 0), ["A", "B", "C"]);
    assert.deepEqual(orderTopMeanReplayTargets(targets, 1), ["C", "B", "A"]);
    assert.deepEqual(orderTopMeanReplayTargets(targets, 2), ["A", "B", "C"]);
    assert.deepEqual(targets, ["A", "B", "C"], "alternating a replay pass must not mutate enumeration order");

    const countHits = (passes: readonly (readonly string[])[], capacity: number): number => {
        const lru: string[] = [];
        let hits = 0;
        for (const pass of passes) {
            for (const target of pass) {
                const existing = lru.indexOf(target);
                if (existing >= 0) {
                    hits += 1;
                    lru.splice(existing, 1);
                }
                lru.push(target);
                if (lru.length > capacity) lru.shift();
            }
        }
        return hits;
    };

    assert.equal(
        countHits([
            orderTopMeanReplayTargets(targets, 0),
            orderTopMeanReplayTargets(targets, 1),
        ], 2),
        2,
        "reverse traversal reuses the prior pass tail when the target universe exceeds the LRU cap",
    );
    assert.equal(
        countHits([targets, targets], 2),
        0,
        "repeating forward traversal would evict the entire useful tail before reaching it",
    );
}

async function testReplayTargetCacheDeduplicatesLoads(): Promise<void> {
    const cache = new Map<string, number[]>();
    let loads = 0;
    const load = async (symbol: string): Promise<number[]> => {
        const cached = cache.get(symbol);
        if (cached !== undefined) return cached;
        loads += 1;
        const data = [loads];
        cache.set(symbol, data);
        return data;
    };

    const firstPass = orderTopMeanReplayTargets(["AAA", "BBB", "CCC"], 0);
    const secondPass = orderTopMeanReplayTargets(["AAA", "BBB", "CCC"], 1);
    for (const symbol of [...firstPass, ...secondPass]) {
        await load(symbol);
    }

    assert.equal(loads, 3, "each replay target is loaded once across full-range and annual passes");
    assert.deepEqual(cache.get("AAA"), [1]);
    assert.deepEqual(cache.get("BBB"), [2]);
    assert.deepEqual(cache.get("CCC"), [3]);
}

function testAnnualReplayWindowsFollowSelectedRange(): void {
    const sec = (value: string): number => Math.floor(Date.parse(value) / 1000);
    const windows = buildTopMeanAnnualReplayWindows(
        sec("2020-04-15T00:00:00.000Z"),
        sec("2022-07-20T23:59:59.000Z"),
        sec("2026-07-29T12:00:00.000Z"),
    );

    assert.deepEqual(windows, [
        {
            year: 2020,
            sampleFromSec: sec("2020-04-15T00:00:00.000Z"),
            sampleToSec: sec("2020-12-31T23:59:59.000Z"),
        },
        {
            year: 2021,
            sampleFromSec: sec("2021-01-01T00:00:00.000Z"),
            sampleToSec: sec("2021-12-31T23:59:59.000Z"),
        },
        {
            year: 2022,
            sampleFromSec: sec("2022-01-01T00:00:00.000Z"),
            sampleToSec: sec("2022-07-20T23:59:59.000Z"),
        },
    ]);

    const throughToday = buildTopMeanAnnualReplayWindows(
        sec("2025-01-01T00:00:00.000Z"),
        undefined,
        sec("2026-07-29T12:00:00.000Z"),
    );
    assert.deepEqual(throughToday, [
        {
            year: 2025,
            sampleFromSec: sec("2025-01-01T00:00:00.000Z"),
            sampleToSec: sec("2025-12-31T23:59:59.000Z"),
        },
        {
            year: 2026,
            sampleFromSec: sec("2026-01-01T00:00:00.000Z"),
            sampleToSec: sec("2026-07-29T12:00:00.000Z"),
        },
    ]);

    assert.deepEqual(
        buildTopMeanAnnualReplayWindows(undefined, undefined, sec("2026-07-29T12:00:00.000Z")),
        [],
        "annual reports require an explicit selected From date",
    );

    console.log("PASS: annual replay windows partition and clip the selected range");
}

/**
 * Write synthetic shards to a temp artifact root, then drive the same
 * iterator + reducer the coordinator uses. Proves the snapshot is fully
 * recoverable from completed shards without re-running backtests.
 */
async function testSnapshotDerivedFromArtifacts(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-snapshot-"));
    const runId = "spec_replay_run_1";
    const endpoint = 1_700_000_000;

    // AAA: 2 long pairs (score 2, activePairs 2, mean 1.0)
    // BBB: 1 long pair  (score 1, activePairs 1, mean 1.0)
    // -> AAA and BBB tie at mean 1.0
    const shardZero: CompactPairArtifact[] = [
        openArtifact(0, "AAA+X1", "long", endpoint),
        openArtifact(1, "AAA+X2", "long", endpoint),
        openArtifact(2, "BBB+Y1", "long", endpoint),
    ];

    writeShardArtifacts(runId, 0, shardZero, baseDir);

    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId,
        status: "completed",
        fingerprint: "test-fingerprint",
        strategyKey: "close_location_median_alignment",
        interval: "4h",
        pairCount: 3,
        shardSize: 50,
        totalShards: 1,
        completedShards: [0],
        failedShards: [],
        completedPairsCount: 3,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    saveManifest(manifest, baseDir);

    // Same path the coordinator uses in run(): iterate raw compact artifacts,
    // drive the bounded multi-pass reducer.
    const result = await computeCurrentTopMeanSnapshot(
        () => iterateRunRawCompactArtifacts(runId, baseDir),
    );

    assert.equal(result.snapshot.asOf, endpoint);
    assert.equal(result.snapshot.openPositions, 3);
    assert.equal(result.snapshot.reason, "tied");
    assert.equal(result.decision?.status, "NO_TRADE");
    assert.equal(result.decision?.reason, "tied");
    assert.deepEqual(
        result.snapshot.winners.map((w) => w.asset).sort(),
        ["AAA", "BBB"],
    );

    // Counter checks: no stale/missing on a clean single-endpoint run.
    assert.equal(result.stats.staleEndpoints, 0);
    assert.equal(result.stats.missingEndpoints, 0);
    assert.equal(result.stats.artifactsProcessed, 3);

    rmSync(baseDir, { recursive: true, force: true });
    console.log("PASS: snapshot derived from on-disk compact artifacts");
}

/**
 * result.json augmentation must be additive. Build a minimal replayResult,
 * spread currentSnapshot onto it the way the coordinator does, and confirm
 * the existing fields are preserved and the new field rides alongside.
 * Also covers the reattach path: handleSp500TopMeanStatusRequest reads this
 * file verbatim, so the field must round-trip through JSON.
 */
async function testResultJsonAugmentationIsAdditive(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-result-json-"));
    const runId = "spec_result_json_1";

    // Minimal manifest so getRunDir()/result.json live in a temp root.
    const manifest: TopMeanRunManifest = {
        schema: "top_mean_run_manifest.v1",
        runId,
        status: "completed",
        fingerprint: "test-fingerprint",
        strategyKey: "close_location_median_alignment",
        interval: "4h",
        pairCount: 1,
        shardSize: 50,
        totalShards: 1,
        completedShards: [0],
        failedShards: [],
        completedPairsCount: 1,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    saveManifest(manifest, baseDir);

    // Stand-in for the historical replay result (existing shape).
    const replayResult = {
        pairs: 3,
        assets: 5,
        complete: true,
        horizons: [
            { bars: 12, topMean: { topMean: 1.5, randomMean: 0.2, delta: 1.3 }, topMeanByAsset: [] },
        ],
        warnings: ["sample warning"],
        reportLines: ["SAMPLE LINE"],
    };
    // Stand-in for the Phase-1 snapshot.
    const currentSnapshot = {
        snapshot: { asOf: 123, artifacts: 3, openPositions: 2, candidates: [], winners: [], reason: "no_positive_candidates" },
        stats: { artifactsProcessed: 3, openPositions: 2, positiveCandidates: 0, staleEndpoints: 0, missingEndpoints: 0, malformedArtifacts: 0, tieCount: 0, durationMs: 5 },
    };

    // Mirror the coordinator's write: spread replayResult first, then attach.
    const resultPath = join(getRunDir(runId, baseDir), "result.json");
    writeFileSync(resultPath, JSON.stringify({ ...replayResult, currentSnapshot }), "utf8");

    // Reattach path reads result.json verbatim via JSON.parse.
    const roundTripped = JSON.parse(
        readFileSync(resultPath, "utf8"),
    ) as Record<string, unknown>;

    // Existing fields preserved verbatim.
    assert.equal(roundTripped.pairs, 3);
    assert.equal(roundTripped.assets, 5);
    assert.equal(roundTripped.complete, true);
    assert.deepEqual(roundTripped.warnings, ["sample warning"]);
    assert.deepEqual(roundTripped.reportLines, ["SAMPLE LINE"]);
    assert.ok(Array.isArray(roundTripped.horizons));
    assert.equal((roundTripped.horizons as Array<{ bars: number }>)[0]!.bars, 12);

    // New additive field present.
    assert.ok(roundTripped.currentSnapshot, "currentSnapshot must ride alongside replayResult");
    assert.equal(
        (roundTripped.currentSnapshot as { snapshot: { asOf: number } }).snapshot.asOf,
        123,
    );

    rmSync(baseDir, { recursive: true, force: true });
    console.log("PASS: result.json augmentation is additive and round-trips");
}

/**
 * The coordinator must still accept an OPTIONAL currentSnapshot on its
 * TopMeanResultSummary — older payloads (and the /status reattach path for
 * pre-Phase-1 runs) omit it. This locks the backward-compat contract.
 */
async function testResultSummaryFieldIsOptional(): Promise<void> {
    // A summary without currentSnapshot must still typecheck and behave as before.
    const legacySummary: TopMeanResultSummary = {
        runId: "legacy",
        completed: true,
        archiveComplete: false,
        counts: { pairCount: 0, sp500AssetsCount: 0, catalogAssetsCount: 0, usable30mSeedCount: 0, usableTargetIntervalCount: 0, excludedAssetsCount: 0, excludedPairsCount: 0 },
        horizons: [],
        warnings: [],
        reportLines: [],
    };
    assert.equal(legacySummary.currentSnapshot, undefined);

    // A summary WITH currentSnapshot must carry it through.
    const withSnapshot = {
        ...legacySummary,
        currentSnapshot: { snapshot: { asOf: 1 }, stats: { durationMs: 0 } },
    };
    assert.ok(withSnapshot.currentSnapshot);

    console.log("PASS: TopMeanResultSummary.currentSnapshot is optional");
}

/** Real coordinator and CSV replay, isolated from local catalogs and user data.
 * This script runs its scenarios sequentially; the loader resolves CSVs from cwd.
 */
async function withCoordinatorFixture(
    run: (baseDir: string, enumeration: EnumerationResult) => Promise<void>,
): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "top-mean-coordinator-"));
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    const assets = ["AAPL", "MSFT", "NVDA", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"];
    const canonicalPairs = [
        "AAPL\u2022+Q1\u2022", "AAPL\u2022+Q2\u2022",
        "MSFT\u2022+Q3\u2022", "MSFT\u2022+Q4\u2022",
        "NVDA\u2022+Q5\u2022", "NVDA\u2022+Q6\u2022",
    ];
    const enumeration: EnumerationResult = {
        canonicalPairs,
        eligibleAssets: assets,
        eligibleTargets: assets.map((asset) => ({ asset, symbol: `${asset}\u2022` })),
        excludedAssets: [],
        skippedPairTokens: [],
        rejectedPairTokens: [],
        counts: {
            sp500AssetsCount: assets.length, catalogAssetsCount: assets.length,
            usable30mSeedCount: assets.length, usableTargetIntervalCount: assets.length,
            pairCount: canonicalPairs.length, excludedAssetsCount: 0, excludedPairsCount: 0,
        },
    };
    try {
        const csvDir = join(baseDir, "price-data", "ibkr", "csv", "4h");
        mkdirSync(csvDir, { recursive: true });
        const rows = Array.from({ length: 400 }, (_, index) => {
            const price = 100 + index * 0.1;
            return `${1_689_000_000 + index * 14_400},${price},${price + 1},${price - 1},${price + 0.5},1000`;
        });
        for (const asset of assets) {
            writeFileSync(join(csvDir, `${asset}.csv`), `time,open,high,low,close,volume\n${rows.join("\n")}\n`);
        }
        process.chdir(baseDir);
        clearServerBatchDatasetCaches();
        globalThis.fetch = async () => {
            networkRequests += 1;
            throw new Error("Unexpected network request in coordinator fixture");
        };
        await run(baseDir, enumeration);
        assert.equal(networkRequests, 0, "coordinator regressions must run entirely on fixture data");
    } finally {
        globalThis.fetch = originalFetch;
        process.chdir(originalCwd);
        clearServerBatchDatasetCaches();
        rmSync(baseDir, { recursive: true, force: true });
    }
}

function openCoordinatorArtifact(...args: Parameters<typeof openArtifact>): CompactPairArtifact {
    const artifact = openArtifact(...args);
    return {
        ...artifact,
        symbol: `${artifact.baseAsset}\u2022+${artifact.quoteAsset}\u2022`,
        baseSymbol: `${artifact.baseAsset}\u2022`,
        quoteSymbol: `${artifact.quoteAsset}\u2022`,
    };
}

/**
 * F4 integration test: drives the REAL TopMeanCoordinatorEngine.run() end-to-end
 * and proves the snapshot seam:
 *   - run() invokes the reducer and emits a `current_snapshot` event;
 *   - result.json is persisted with currentSnapshot BEFORE the replay phase;
 *   - the snapshot survives even when the replay never runs (here: the engine
 *     is stopped the moment the snapshot is emitted, so the replay phase is
 *     never reached — exactly the "replay failed / never completed" case).
 *
 * Pre-populates a completed manifest + shard so the worker pool finds nothing
 * pending (resume mode skips worker spawning). This isolates the snapshot +
 * persistence seam from the worker/data-loader stack.
 */
async function testRunIntegratesSnapshotAndPersistsBeforeReplay(): Promise<void> {
    await withCoordinatorFixture(async (baseDir, enumRes) => {
        const runId = "spec_integration";
        const endpoint = 1_700_000_000;
        const request: TopMeanCoordinatorRunRequest = {
            runId,
            strategyKey: "close_location_median_alignment",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: makeBacktestSettings(),
            capitalSettings: makeCapitalSettings(),
            interval: "4h",
            horizons: [12],
            pairListText: enumRes.canonicalPairs.join("\n"),
            resume: true,
            saveArchiveLog: false,
            useRustEnginePreference: false,
            selectionCooldownBars: 5,
        };
        const fingerprint = computeRunFingerprint({
            strategyKey: request.strategyKey,
            strategyParams: request.strategyParams,
            backtestSettings: request.backtestSettings,
            capitalSettings: request.capitalSettings,
            interval: "4h",
            useRustEnginePreference: false,
            canonicalAssets: enumRes.eligibleAssets,
            canonicalPairs: enumRes.canonicalPairs,
        });

        // Pre-write a completed manifest + shard 0 with six open long pairs that
        // produce a clean 3-way tie: AAPL, MSFT, NVDA each as base in 2 pairs and
        // never as a positive leg elsewhere -> each nets +2, activePairs 2,
        // mean 1.0 -> 3-way tie. The reducer must surface all three (no silent
        // tie-break), which the coordinator then persists verbatim.
        const shardZero: CompactPairArtifact[] = [
            openCoordinatorArtifact(0, "AAPL+Q1", "long", endpoint),
            openCoordinatorArtifact(1, "AAPL+Q2", "long", endpoint),
            openCoordinatorArtifact(2, "MSFT+Q3", "long", endpoint),
            openCoordinatorArtifact(3, "MSFT+Q4", "long", endpoint),
            openCoordinatorArtifact(4, "NVDA+Q5", "long", endpoint),
            openCoordinatorArtifact(5, "NVDA+Q6", "long", endpoint),
        ];
        writeShardArtifacts(runId, 0, shardZero, baseDir);

        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "running",
            fingerprint,
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: enumRes.canonicalPairs.length,
            shardSize: 50,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: shardZero.length,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveManifest(manifest, baseDir);

        let engine: TopMeanCoordinatorEngine | null = null;
        engine = new TopMeanCoordinatorEngine(request, baseDir, {
            enumeration: enumRes,
            evaluationNowSec: 1_760_000_000,
        });
        const events: Array<{ type: string; [k: string]: unknown }> = [];
        let sawSnapshot = false;

        await engine.run((event: unknown) => {
            const e = event as { type: string; [k: string]: unknown };
            events.push(e);
            // The moment the snapshot is emitted, stop the engine. This forces
            // run() to take the post-snapshot isStopped branch and skip the
            // replay phase entirely — modeling "replay never runs / fails".
            if (e.type === "current_snapshot" && !sawSnapshot) {
                sawSnapshot = true;
                assert.equal(
                    existsSync(join(getRunDir(runId, baseDir), "phase0b")),
                    false,
                    "explicitly disabled archive must not create Phase 0b staging",
                );
                engine!.stop();
            }
        });

        // 1. run() invoked the reducer and emitted current_snapshot BEFORE replay.
        assert.ok(sawSnapshot, "run() must emit a current_snapshot event");
        const snapshotIdx = events.findIndex((e) => e.type === "current_snapshot");
        assert.equal(events[snapshotIdx]?.selectionCooldownBars, 5);
        const typesAfterSnapshot = events.slice(snapshotIdx + 1).map((e) => e.type);
        // Critically, NO replay fatal follows — proving the snapshot phase ran
        // BEFORE the replay phase and that the replay was unreachable once we
        // stopped. This is the F1 survival contract: the snapshot is independent
        // of, and persists regardless of, the replay outcome.
        assert.ok(
            !typesAfterSnapshot.includes("fatal"),
            "no replay fatal after snapshot (replay never ran)",
        );

        // 2. result.json was persisted with currentSnapshot, even though the
        //    replay never ran.
        const resultPath = join(getRunDir(runId, baseDir), "result.json");
        assert.ok(existsSync(resultPath), "result.json must be persisted before replay");
        const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as { currentSnapshot?: unknown; selectionCooldownBars?: number };
        assert.ok(onDisk.currentSnapshot, "persisted result.json must carry currentSnapshot");
        assert.equal(onDisk.selectionCooldownBars, 5);
        const persistedManifest = JSON.parse(
            readFileSync(join(getRunDir(runId, baseDir), "manifest.json"), "utf8"),
        ) as TopMeanRunManifest;
        assert.equal(persistedManifest.requestedEngineMode, "typescript");
        assert.equal(persistedManifest.actualEngineMode, "typescript");
        assert.equal(persistedManifest.selectionCooldownBars, 5);
        assert.deepEqual(persistedManifest.engineUsage, { rust: 0, typescript: 0 });
        const persistedCurrent = onDisk.currentSnapshot as {
            snapshot: { asOf: number; winners: Array<{ asset: string }> };
            decision?: {
                status: string;
                reason: string;
                asset: string | null;
                decisionTime: number | null;
                entryPairs: number;
                entryRule: string;
                researchNotionalUsd: number;
                researchHoldBars: number;
                researchExitRule: string;
                verification: string;
                configurationAssumption: string;
            };
        };
        const snap = persistedCurrent.snapshot;
        assert.equal(snap.asOf, endpoint);
        // AAPL, MSFT, NVDA each net +2 across 2 pairs (mean 1.0) -> 3-way tie.
        // The reducer surfaces all three (no silent tie-break), and run()
        // persists that verbatim through result.json.
        assert.deepEqual(
            snap.winners.map((w: { asset: string }) => w.asset).sort(),
            ["AAPL", "MSFT", "NVDA"],
        );
        assert.deepEqual(persistedCurrent.decision, {
            status: "NO_TRADE",
            reason: "tied",
            asset: null,
            decisionTime: 1,
            candidates: [
                { asset: "AAPL", score: 2, activePairs: 2, mean: 1 },
                { asset: "MSFT", score: 2, activePairs: 2, mean: 1 },
                { asset: "NVDA", score: 2, activePairs: 2, mean: 1 },
            ],
            winners: [
                { asset: "AAPL", score: 2, activePairs: 2, mean: 1 },
                { asset: "MSFT", score: 2, activePairs: 2, mean: 1 },
                { asset: "NVDA", score: 2, activePairs: 2, mean: 1 },
            ],
            entryPairs: 6,
            entryRule: "first_target_bar_strictly_after_decision",
            researchNotionalUsd: 1000,
            researchHoldBars: 24,
            researchExitRule: "24th_bar_close",
            verification: "algorithmic_endpoint_check",
            configurationAssumption: "one_strategy_configuration",
        });

        console.log("PASS: run() integrates reducer, emits snapshot, persists before replay (F1+F4)");
    });
}

async function testTopMeanRouteRejectsNonBooleanArchiveFlag(): Promise<void> {
    const routes = new Map<string, (req: any, res: any) => void | Promise<void>>();
    registerSp500TopMeanRoutes({
        use(path, handler) {
            routes.set(path, handler);
        },
    }, {
        maxBodyBytes: 1024 * 1024,
        rememberLocalApiOriginFromRequest: () => undefined,
        ownerLocks: {
            isBusy: () => false,
            acquire: () => ({ runOwner: 1, analysisOwner: 1 }),
            releaseIfStillOwner: () => undefined,
        },
    });

    const response: any = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader(name: string, value: string) { this.headers[name] = value; },
        end(body: string) { this.body = body; },
    };
    const request: any = Readable.from([JSON.stringify({ saveArchiveLog: "false" })]);
    request.method = "POST";
    request.url = "/api/batch-backtest/sp500-top-mean/run";
    request.headers = { host: "127.0.0.1:5173" };
    request.socket = { remoteAddress: "127.0.0.1" };

    await routes.get("/api/batch-backtest/sp500-top-mean/run")!(request, response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
        ok: false,
        error: "saveArchiveLog must be a boolean when provided.",
    });
    console.log("PASS: TOP_MEAN route rejects non-boolean saveArchiveLog");
}

async function testManifestBackedStatusPreservesArchiveOutcome(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-top-mean-status-"));
    const runId = "spec_archive_status_1";
    try {
        saveManifest({
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "completed",
            fingerprint: "archive-status-fingerprint",
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: 1,
            shardSize: 50,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: 1,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archiveComplete: true,
            archiveRequested: true,
            archiveDir: "C:\\archive\\spec_archive_status_1",
        }, baseDir);

        const status = await handleSp500TopMeanStatusRequest(runId, baseDir);
        assert.equal("ok" in status, false);
        if ("ok" in status) return;
        assert.equal(status.archiveComplete, true);
        assert.equal(status.archiveRequested, true);
        assert.equal(status.archiveDir, "C:\\archive\\spec_archive_status_1");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
    console.log("PASS: manifest-backed TOP_MEAN status preserves archive outcome");
}

function openArtifact(
    pairIndex: number,
    symbol: string,
    type: "long" | "short",
    dataEndTime: number,
    trades?: CompactPairArtifact["trades"],
): CompactPairArtifact {
    const [baseAsset = symbol, quoteAsset = symbol] = symbol.split("+");
    return {
        schema: "compact_pair_artifact.v1",
        pairIndex,
        symbol,
        baseAsset,
        quoteAsset,
        baseSymbol: `${baseAsset}USDT`,
        quoteSymbol: `${quoteAsset}USDT`,
        trades: trades ?? [{ type, entryTime: 1 as Time, exitTime: 2 as Time, exitReason: "end_of_data" }],
        dataEndTime,
    };
}

/**
 * Audit (restart-reattach finding): a manifest left "running" by a previous
 * process must not keep the browser reattach loop polling forever. The
 * status route observes it with no active engine, reconciles it to
 * "interrupted", persists that, and returns the terminal state.
 */
async function testStaleRunningManifestReconcilesToInterrupted(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-top-mean-stale-"));
    const runId = "spec_stale_reattach_1";
    try {
        saveManifest({
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "running",
            fingerprint: "stale-fingerprint",
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: 2,
            shardSize: 50,
            totalShards: 1,
            completedShards: [],
            failedShards: [],
            completedPairsCount: 1,
            failedPairsCount: 0,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now() - 60_000,
        }, baseDir);

        const status = await handleSp500TopMeanStatusRequest(runId, baseDir);
        assert.equal("ok" in status, false, "a persisted manifest must resolve, not 404");
        if ("ok" in status) return;
        assert.equal(status.status, "interrupted", "stale running manifest must surface as terminal interrupted");
        assert.equal(status.phase, "interrupted");
        assert.equal(status.pairTotals, 2);

        const onDisk = loadManifest(runId, baseDir);
        assert.equal(onDisk?.status, "interrupted", "the reconcile must be persisted so other surfaces agree");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
    console.log("PASS: stale running manifest reconciles to interrupted on status");
}


/**
 * finder_arm profile (Finder Arm Performance optimization plan, phases 1-2):
 * a coordinator built with deps.executionProfile === "finder_arm" runs ONLY
 * the full-window replay — no annual calendar passes (even across a
 * multi-year From/To), no current_snapshot event, no per-row event details,
 * and no result.json on disk. Finder children delete their run directory
 * after each candidate and the parent retains only scalar state, so nothing
 * can consume those outputs. Standalone behavior stays the default (the F4
 * test above locks the snapshot path for engines without the profile).
 */
async function testFinderArmProfileSkipsAnnualSnapshotAndResultJson(): Promise<void> {
    await withCoordinatorFixture(async (baseDir, enumRes) => {
        const runId = "spec_finder_arm";
        const request: TopMeanCoordinatorRunRequest = {
            runId,
            strategyKey: "close_location_median_alignment",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: makeBacktestSettings(),
            capitalSettings: makeCapitalSettings(),
            interval: "4h",
            horizons: [12],
            pairListText: enumRes.canonicalPairs.join("\n"),
            // Spans 2022-2024: WITHOUT the profile this derives three annual
            // replay passes on top of the full-window pass (their progress text
            // is asserted absent below).
            sampleFromSec: 1_660_000_000,
            sampleToSec: 1_730_000_000,
            resume: true,
            saveArchiveLog: false,
            useRustEnginePreference: false,
        };
        const fingerprint = computeRunFingerprint({
            strategyKey: request.strategyKey,
            strategyParams: request.strategyParams,
            backtestSettings: request.backtestSettings,
            capitalSettings: request.capitalSettings,
            interval: "4h",
            useRustEnginePreference: false,
            canonicalAssets: enumRes.eligibleAssets,
            canonicalPairs: enumRes.canonicalPairs,
        });

        // Trade entries INSIDE the 2022-2024 sample window (entryTime 1 would
        // predate sampleFromSec and the full-window replay would legitimately
        // report zero decision events -> empty horizons).
        const inWindowTrades = [{
            type: "long" as const,
            entryTime: 1_690_000_000 as Time,
            exitTime: 1_690_003_600 as Time,
            exitReason: "end_of_data" as const,
        }];
        const shardZero: CompactPairArtifact[] = [
            openCoordinatorArtifact(0, "AAPL+Q1", "long", 1_700_000_000, inWindowTrades),
            openCoordinatorArtifact(1, "AAPL+Q2", "long", 1_700_000_000, inWindowTrades),
            openCoordinatorArtifact(2, "MSFT+Q3", "long", 1_700_000_000, inWindowTrades),
            openCoordinatorArtifact(3, "MSFT+Q4", "long", 1_700_000_000, inWindowTrades),
            openCoordinatorArtifact(4, "NVDA+Q5", "long", 1_700_000_000, inWindowTrades),
            openCoordinatorArtifact(5, "NVDA+Q6", "long", 1_700_000_000, inWindowTrades),
        ];
        writeShardArtifacts(runId, 0, shardZero, baseDir);

        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "running",
            fingerprint,
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: enumRes.canonicalPairs.length,
            shardSize: 50,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: shardZero.length,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveManifest(manifest, baseDir);

        const engine = new TopMeanCoordinatorEngine(request, baseDir, {
            enumeration: enumRes,
            evaluationNowSec: 1_760_000_000,
            executionProfile: "finder_arm",
        });
        const events: Array<{ type: string; [k: string]: unknown }> = [];
        await engine.run((event: unknown) => {
            events.push(event as { type: string; [k: string]: unknown });
        });

        const types = events.map((e) => e.type);
        assert.equal(
            types.filter((type) => type === "current_snapshot").length,
            0,
            "finder_arm must not emit a current_snapshot event",
        );
        assert.equal(
            events.filter((e) => String(e.text ?? "").includes("OPEN_SCORE USD replay for 20")).length,
            0,
            "finder_arm must not run annual calendar replay passes",
        );
        const done = events.find((e) => e.type === "done" && e.interrupted !== true) as
            | { result?: TopMeanResultSummary }
            | undefined;
        assert.ok(done?.result?.completed, "the finder_arm run must complete");
        const result = done.result!;
        assert.ok(result.horizons.length > 0, "the full-window replay must still run");
        assert.equal(result.replayTargetLoadFailureCount, 0, "the fixture supplies all replay targets");
        assert.equal(result.annualReports?.length ?? 0, 0, "finder_arm returns no annual reports");
        assert.equal(result.openScoreEventDetails, undefined, "finder_arm omits per-row event details");
        assert.equal(result.ongoingEventDetails, undefined, "finder_arm omits ongoing event details");
        assert.equal(result.currentSnapshot, undefined, "finder_arm omits the current snapshot");
        assert.equal(
            existsSync(join(getRunDir(runId, baseDir), "result.json")),
            false,
            "finder_arm must not write result.json",
        );
        console.log("PASS: finder_arm profile runs the full-window replay only");
    });
}

/**
 * Shared POST /run harness for route-boundary validation tests (mirrors the
 * saveArchiveLog rejection test below).
 */
async function postTopMeanRunBody(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
    const routes = new Map<string, (req: any, res: any) => void | Promise<void>>();
    registerSp500TopMeanRoutes({
        use(path: string, handler: any) {
            routes.set(path, handler);
        },
    }, {
        maxBodyBytes: 1024 * 1024,
        rememberLocalApiOriginFromRequest: () => undefined,
        ownerLocks: {
            isBusy: () => false,
            acquire: () => ({ runOwner: 1, analysisOwner: 1 }),
            releaseIfStillOwner: () => undefined,
        },
    });

    const response: any = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader(name: string, value: string) { this.headers[name] = value; },
        end(body: string) { this.body = body; },
    };
    const request: any = Readable.from([JSON.stringify(body)]);
    request.method = "POST";
    request.url = "/api/batch-backtest/sp500-top-mean/run";
    request.headers = { host: "127.0.0.1:5173", ...headers };
    request.socket = { remoteAddress: "127.0.0.1" };

    await routes.get("/api/batch-backtest/sp500-top-mean/run")!(request, response);
    return {
        statusCode: response.statusCode,
        payload: response.body ? JSON.parse(response.body) as Record<string, unknown> : {},
    };
}

/**
 * Audit (POST run-id + date-window findings): the run route must reject
 * path-like run ids at the boundary (the structural containment check alone
 * lets `foo/../existing` alias another run's artifact directory) and must
 * reject malformed non-blank From/To dates and reversed windows with a 400 —
 * they used to become "no filter" (full-history replay) or an empty
 * "successful" report. All before any owner lock is acquired.
 */
async function testTopMeanRouteRejectsInvalidRunIdsAndDates(): Promise<void> {
    // Any eagerly-manifested built-in satisfies the route's strategy gate.
    const baseRequest = {
        strategyKey: "entropy_ratio_regime_alignment",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: { direction: "long", slippage: 0, commission: 0 },
        capitalSettings: { initialCapital: 10000 },
        interval: "4h",
        horizons: [12],
        pairListText: "BTCUSDT+ETHUSDT",
    };

    for (const pairListText of [undefined, "", "   ", 123]) {
        const missingPairs = await postTopMeanRunBody({ ...baseRequest, runId: "spec_missing_pairs", pairListText });
        assert.equal(missingPairs.statusCode, 400);
        assert.match(String(missingPairs.payload.error), /explicit pair list/);
    }

    const pathLike = await postTopMeanRunBody({
        ...baseRequest,
        runId: "spec_evil/../spec_result_json_1",
    });
    assert.equal(pathLike.statusCode, 400);
    assert.equal(pathLike.payload.error, "Invalid runId.");

    const spaces = await postTopMeanRunBody({ ...baseRequest, runId: "spec evil id" });
    assert.equal(spaces.statusCode, 400);
    assert.equal(spaces.payload.error, "Invalid runId.");

    const invalidReplayMode = await postTopMeanRunBody({
        ...baseRequest,
        runId: "spec_invalid_replay_mode",
        replayMode: "future_mode",
    });
    assert.equal(invalidReplayMode.statusCode, 400);
    assert.match(String(invalidReplayMode.payload.error), /replayMode/i);

    const malformedDate = await postTopMeanRunBody({
        ...baseRequest,
        runId: "spec_date_guard_run",
        sampleFrom: "not-a-date",
    });
    assert.equal(malformedDate.statusCode, 400);
    assert.match(String(malformedDate.payload.error), /Invalid sampleFrom date/);
    for (const sampleFrom of ["2024-02-30", "2024-2-01", 123, {}, []]) {
        const rejected = await postTopMeanRunBody({ ...baseRequest, runId: "spec_date_guard_run", sampleFrom });
        assert.equal(rejected.statusCode, 400);
        assert.match(String(rejected.payload.error), /sampleFrom/);
    }

    const reversed = await postTopMeanRunBody({
        ...baseRequest,
        runId: "spec_date_guard_run",
        sampleFrom: "2026-01-02",
        sampleTo: "2026-01-01",
    });
    assert.equal(reversed.statusCode, 400);
    assert.match(String(reversed.payload.error), /reversed/);

    console.log("PASS: TOP_MEAN route rejects invalid run ids and date windows with 400");
}

async function testTopMeanLargePairListAdmission(): Promise<void> {
    const body = {
        runId: "spec_large_pair_list",
        strategyKey: "missing_strategy_for_admission_test",
        interval: "4h",
        horizons: [12, 20],
        pairListText: "IBKR:AAPL/IBKR:MSFT\n".repeat(173_166),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024);
    const admitted = await postTopMeanRunBody(body);
    assert.equal(admitted.statusCode, 400);
    assert.match(String(admitted.payload.error), /not a built-in strategy/,
        "large list must reach semantic validation rather than fail with 413");

    const oversized = await postTopMeanRunBody({}, {
        "content-length": String(TOP_MEAN_RUN_MAX_BODY_BYTES + 1),
    });
    assert.equal(oversized.statusCode, 413);
    assert.match(String(oversized.payload.error), new RegExp(String(TOP_MEAN_RUN_MAX_BODY_BYTES)));
}

/** POST a body to the registered stop route and capture the raw response. */
async function postTopMeanStopBody(
    body: Record<string, unknown>,
): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
    const routes = new Map<string, (req: any, res: any) => void | Promise<void>>();
    registerSp500TopMeanRoutes({
        use(path: string, handler: any) {
            routes.set(path, handler);
        },
    }, {
        maxBodyBytes: 1024 * 1024,
        rememberLocalApiOriginFromRequest: () => undefined,
        ownerLocks: {
            isBusy: () => false,
            acquire: () => ({ runOwner: 1, analysisOwner: 1 }),
            releaseIfStillOwner: () => undefined,
        },
    });

    const response: any = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader(name: string, value: string) { this.headers[name] = value; },
        end(body: string) { this.body = body; },
    };
    const request: any = Readable.from([JSON.stringify(body)]);
    request.method = "POST";
    request.url = "/api/batch-backtest/sp500-top-mean/stop";
    request.headers = { host: "127.0.0.1:5173" };
    request.socket = { remoteAddress: "127.0.0.1" };

    await routes.get("/api/batch-backtest/sp500-top-mean/stop")!(request, response);
    return {
        statusCode: response.statusCode,
        payload: response.body ? JSON.parse(response.body) as Record<string, unknown> : {},
    };
}

/**
 * Audit (exact stop runId finding): the Stop route used to stop the ACTIVE
 * run whenever the posted runId was missing or blank — a stale or malformed
 * local client could cancel an unrelated run. Missing/blank/invalid ids must
 * be a 400, a well-formed mismatch must be a no-op { stopped: false }, and
 * only the exact active run id may stop the engine.
 */
async function testStopRouteRequiresExactRunId(): Promise<void> {
    const engine = new TopMeanCoordinatorEngine({
        runId: "spec_stop_exact_run",
        strategyKey: "close_location_median_alignment",
        strategyParams: {},
        backtestSettings: {},
        capitalSettings: {},
        interval: "4h",
    } as any);
    setActiveTopMeanCoordinatorEngineForTests(engine);
    try {
        const missing = await postTopMeanStopBody({});
        assert.equal(missing.statusCode, 400);
        assert.match(String(missing.payload.error), /runId/);

        const blank = await postTopMeanStopBody({ runId: "   " });
        assert.equal(blank.statusCode, 400);

        const invalid = await postTopMeanStopBody({ runId: "spec_evil/../spec_stop_exact_run" });
        assert.equal(invalid.statusCode, 400);
        assert.equal(invalid.payload.error, "Invalid runId.");

        assert.equal(engine.getStatus().status, "running", "rejections must not stop the active engine");

        const stale = await postTopMeanStopBody({ runId: "spec_stop_stale_run" });
        assert.equal(stale.statusCode, 200);
        assert.deepEqual(stale.payload, { ok: true, stopped: false });
        assert.equal(engine.getStatus().status, "running", "a mismatched runId must not stop the active engine");

        const exact = await postTopMeanStopBody({ runId: "spec_stop_exact_run" });
        assert.equal(exact.statusCode, 200);
        assert.deepEqual(exact.payload, { ok: true, stopped: true, runId: "spec_stop_exact_run" });
        assert.equal(engine.getStatus().phase, "interrupted", "only the exact active run id stops the engine");
    } finally {
        // Never leak the active engine into other tests in this file.
        setActiveTopMeanCoordinatorEngineForTests(null);
    }
    console.log("PASS: TOP_MEAN stop route requires the exact active runId");
}

/**
 * Audit (terminal-manifest finding): stop() used to call saveManifest
 * unprotected, so a final filesystem failure threw past the interrupted
 * transition — the Stop route returned an error and the run looked hung
 * instead of terminal. The same wrapper guards the completed/fatal/interrupted
 * paths. With an injected failing manifest writer, stop() must still deliver
 * the terminal state.
 */
async function testStopSurvivesManifestPersistenceFailure(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-top-mean-persist-"));
    try {
        const engine = new TopMeanCoordinatorEngine({
            runId: "spec_persist_fail_run",
            strategyKey: "close_location_median_alignment",
            strategyParams: {},
            backtestSettings: {},
            capitalSettings: {},
            interval: "4h",
        } as any, baseDir, {
            saveManifest: () => {
                throw new Error("simulated terminal manifest write failure");
            },
        });
        (engine as any).manifest = {
            schema: "top_mean_run_manifest.v1",
            runId: "spec_persist_fail_run",
            status: "running",
            fingerprint: "spec",
            strategyKey: "close_location_median_alignment",
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
        assert.doesNotThrow(() => engine.stop(), "a manifest persistence failure must not break the Stop transition");
        assert.equal(engine.getStatus().phase, "interrupted");
        assert.equal(engine.getStatus().status, "interrupted");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
    console.log("PASS: stop survives a terminal manifest persistence failure");
}

/**
 * Audit (single-year dedupe): the coordinator rebuilds the annual report from
 * the full-window replay INSTEAD of re-running an identical replay when the
 * explicit From/To bounds produce exactly one annual window whose bounds
 * EQUAL the request bounds (strict equality). These assertions lock the
 * window-derivation preconditions that the engine's dedupe keys on.
 */
function testSingleYearWindowDedupePreconditions(): void {
    const sec = (value: string): number => Math.floor(Date.parse(value) / 1000);
    const nowSec = sec("2026-07-29T12:00:00.000Z");

    // Explicit bounds inside ONE calendar year: exactly one window, bounds
    // identical to the request bounds -> dedupe fires.
    const from = sec("2021-03-10T00:00:00.000Z");
    const to = sec("2021-11-05T23:59:59.000Z");
    const windows = buildTopMeanAnnualReplayWindows(from, to, nowSec);
    assert.equal(windows.length, 1, "explicit bounds within one year must derive exactly one annual window");
    assert.equal(windows[0]!.sampleFromSec, from, "the single window's From must equal the explicit full-window From");
    assert.equal(windows[0]!.sampleToSec, to, "the single window's To must equal the explicit full-window To");

    // Bounds spanning a year boundary -> two windows -> no dedupe.
    const spanning = buildTopMeanAnnualReplayWindows(
        sec("2021-11-01T00:00:00.000Z"),
        sec("2022-02-01T23:59:59.000Z"),
        nowSec,
    );
    assert.equal(spanning.length, 2, "bounds crossing a year boundary must stay two distinct replay windows");

    // A future-dated To is clipped to the run cutoff, so the window bound can
    // never equal the request bound -> no dedupe (the replays differ).
    const futureTo = nowSec + 365 * 24 * 3600;
    const clipped = buildTopMeanAnnualReplayWindows(sec("2026-01-01T00:00:00.000Z"), futureTo, nowSec);
    assert.ok(clipped.length >= 1);
    assert.notEqual(
        clipped[clipped.length - 1]!.sampleToSec,
        futureTo,
        "a To beyond the run cutoff is clipped, so the dedupe precondition must not fire",
    );
    console.log("PASS: single-year replay dedupe preconditions (exact-bound equality only)");
}

/**
 * Audit (replay-progress finding): same-phase replay progress is throttled to
 * 250 ms OR >=1% of the phase total; phase transitions always emit (the
 * caller handles those). The LRU bound constant locks the replay target cache
 * working set (~64 x 5–10 MB datasets).
 */
function testReplayProgressThrottleAndCacheBound(): void {
    assert.equal(shouldEmitTopMeanReplayProgress(0, 0, 500), false, "no elapsed time and no progress must suppress the event");
    assert.equal(shouldEmitTopMeanReplayProgress(100, 4, 500), false, "sub-1% progress inside the time window must suppress the event");
    assert.equal(shouldEmitTopMeanReplayProgress(100, 5, 500), true, ">=1% progress must emit even inside the time window");
    assert.equal(shouldEmitTopMeanReplayProgress(251, 0, 500), true, ">=250ms must emit regardless of progress");
    assert.equal(shouldEmitTopMeanReplayProgress(0, 0, 0), false, "zero-total phases must gate on time only");
    assert.equal(
        TOP_MEAN_REPLAY_TARGET_CACHE_MAX_ENTRIES,
        512,
        "the replay target LRU must stay bounded (~560 MB at ~1.1 MB per 4h-aggregated target)",
    );
    assert.equal(
        TOP_MEAN_REPLAY_TARGET_PREFETCH_CONCURRENCY,
        16,
        "replay target I/O must be bounded while overlapping loads ahead of deterministic consumption",
    );
    console.log("PASS: replay progress throttle and target cache bound contract");
}

/**
 * Audit (stop-during-archive finding): Stop fired while the archive
 * finalization is awaiting disk work must win — the run ends interrupted
 * (manifest + done event), never "completed" with a successful result.
 *
 * Uses the archive test seam: the injected archive function calls stop() and
 * then resolves successfully, reproducing the exact race. The pair list and
 * pre-completed empty-trades shard let the pipeline reach the archive phase
 * without market data (the replay short-circuits on zero trade deltas).
 */
async function testStopDuringArchiveStaysInterrupted(): Promise<void> {
    await withCoordinatorFixture(async (baseDir, enumRes) => {
        const runId = "spec_stop_archive";
        const request: TopMeanCoordinatorRunRequest = {
            runId,
            strategyKey: "close_location_median_alignment",
            strategyParams: { lookback: 20, threshold: 0.5 },
            backtestSettings: makeBacktestSettings(),
            capitalSettings: makeCapitalSettings(),
            interval: "4h",
            horizons: [12],
            pairListText: enumRes.canonicalPairs.join("\n"),
            resume: true,
            saveArchiveLog: true,
            useRustEnginePreference: false,
        };
        const fingerprint = computeRunFingerprint({
            strategyKey: request.strategyKey,
            strategyParams: request.strategyParams,
            backtestSettings: request.backtestSettings,
            capitalSettings: request.capitalSettings,
            interval: "4h",
            useRustEnginePreference: false,
            canonicalAssets: enumRes.eligibleAssets,
            canonicalPairs: enumRes.canonicalPairs,
        });

        // One completed shard with EMPTY trades: the replay scan finds zero
        // trade deltas and returns an empty result instead of failing on
        // missing target datasets.
        writeShardArtifacts(runId, 0, [openCoordinatorArtifact(0, "AAPL+Q1", "long", 1_700_000_000, [])], baseDir);
        saveManifest({
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "running",
            fingerprint,
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: enumRes.canonicalPairs.length,
            shardSize: 50,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: 1,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }, baseDir);

        let engine: TopMeanCoordinatorEngine | null = null;
        let archiveCalls = 0;
        engine = new TopMeanCoordinatorEngine(request, baseDir, {
            enumeration: enumRes,
            evaluationNowSec: 1_760_000_000,
            archiveCompletedRun: async () => {
                archiveCalls += 1;
                // Stop DURING the archive await — the completion commit below
                // must observe it and stay interrupted.
                engine!.stop();
                await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
                return { reason: "saved", archiveDir: "archive-unused" };
            },
        });

        const events: Array<{ type: string; interrupted?: unknown; result?: unknown; error?: unknown }> = [];
        await engine.run((event: unknown) => {
            events.push(event as { type: string });
        });

        assert.equal(
            archiveCalls,
            1,
            `the injected archive phase must have run; events=${JSON.stringify(events.map((e) => ({ ...e, result: undefined })))}`,
        );
        const lastEvent = events[events.length - 1]!;
        assert.equal(lastEvent.type, "done", "the run must terminate with a done event");
        assert.equal(lastEvent.interrupted, true, "Stop during the archive await must win: interrupted done event");
        assert.equal(lastEvent.result, undefined, "no successful result may follow a Stop");

        const persisted = loadManifest(runId, baseDir);
        assert.equal(persisted?.status, "interrupted", "manifest must remain interrupted after Stop");
        console.log("PASS: stop during archive finalization stays interrupted");
    });
}

/**
 * Browser-OOM wire-safety contract (20k-pair runs): the terminal done result
 * (and the /status reattach result) must never carry uncapped per-row detail
 * arrays or the coordinator-only poolSnapshots/candidateOutcomes. The cap is
 * a PER-PASS TOTAL (a per-selector cap never bound: a 20k-pair run shipped
 * 53,967 full-window rows — 30.7 MB — because no single arm exceeded 20k).
 * Per-year rows do not ride the wire at all. Full rows stay on disk
 * (result.json) and in the archive path's summary — the input object must NOT
 * be mutated.
 */
function testWireSafetyCapsEventDetailsAndStripsDiagnostics(): void {
    const detailRow = (selector: string, i: number): any => ({
        decisionTime: 1_700_000_000 + i,
        entryTime: 1_700_003_600,
        exitTime: 1_700_176_400,
        horizonBars: 12,
        selector,
        direction: "long",
        asset: `${selector}_ASSET`,
        selectedReturn: 0.01,
        controlReturn: 0.02,
        delta: -0.01,
        eligibleCandidates: 3,
    });

    // capTopMeanEventDetailsForWire: most recent N rows OVERALL, order preserved.
    const rows = [
        ...Array.from({ length: 35 }, (_, i) => detailRow("TOP_MEAN", i)),
        ...Array.from({ length: 35 }, (_, i) => detailRow("TOP_RAW", 100 + i)),
    ];
    const capped = capTopMeanEventDetailsForWire(rows, 40);
    assert.equal(capped.length, 40, "the cap is a per-pass total, not per selector");
    assert.deepEqual(
        capped.map((r) => r.decisionTime),
        [...capped.map((r) => r.decisionTime)].sort((a, b) => a - b),
        "capping must preserve the original row order",
    );
    assert.equal(
        capped[capped.length - 1]!.decisionTime,
        1_700_000_000 + 134,
        "the newest row must survive the cap",
    );
    assert.equal(
        capped[0]!.decisionTime,
        1_700_000_000 + 30,
        "the oldest capped-out rows are dropped (last 40 of 70 start at index 30)",
    );
    assert.equal(rows.length, 70, "capping must not mutate the source array");

    // Below the cap nothing is dropped and the clone is independent.
    const small = [detailRow("TOP_MEAN", 0)];
    const cappedSmall = capTopMeanEventDetailsForWire(small, 20);
    assert.equal(cappedSmall.length, 1);
    assert.notEqual(cappedSmall, small);

    // toWireSafeTopMeanResultSummary: strip archive-only diagnostics, drop
    // per-year rows (counts only), keep bounded full-window rows + the exact
    // pre-cap total, and leave the input untouched (the archive path reads
    // the FULL arrays from the same object).
    const fullSummary = {
        runId: "spec_wire_safety",
        completed: true,
        archiveComplete: false,
        counts: { pairCount: 1, usableTargetIntervalCount: 1, sp500AssetsCount: 1, excludedAssetsCount: 0 },
        horizons: [],
        openScoreEventDetails: Array.from({ length: 5 }, (_, i) => detailRow("TOP_MEAN", i)),
        poolSnapshots: [{ eventId: "p0" }] as any[],
        candidateOutcomes: [{ eventId: "c0" }] as any[],
        warnings: [],
        reportLines: ["report"],
        annualReports: [{
            year: 2026,
            sampleFromSec: 1,
            sampleToSec: 2,
            horizons: [],
            eventDetails: Array.from({ length: 5 }, (_, i) => detailRow("TOP_RAW", i)),
            warnings: [],
            reportLines: [],
        }],
    } as unknown as TopMeanResultSummary;

    const wire = toWireSafeTopMeanResultSummary(fullSummary);
    assert.equal(wire.poolSnapshots, undefined, "poolSnapshots must never ride the wire");
    assert.equal(wire.candidateOutcomes, undefined, "candidateOutcomes must never ride the wire");
    assert.equal(wire.openScoreEventDetails?.length, 5);
    assert.equal(wire.openScoreEventDetailCount, 5);
    assert.equal(
        wire.annualReports?.[0]!.eventDetails,
        undefined,
        "per-year detail rows must not ride the wire",
    );
    assert.equal(wire.annualReports?.[0]!.eventDetailCount, 5, "the per-year pre-cap total rides as a count");
    assert.equal(fullSummary.poolSnapshots?.length, 1, "input summary must keep diagnostics for the archive");
    assert.equal(fullSummary.openScoreEventDetails?.length, 5, "input summary must keep full rows");
    assert.equal(fullSummary.annualReports?.[0]!.eventDetails?.length, 5, "input summary keeps per-year rows");

    // A summary above the production cap is truncated with the honest total.
    const hugeSummary = {
        ...fullSummary,
        openScoreEventDetails: Array.from(
            { length: TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55 },
            (_, i) => detailRow("TOP_MEAN", i),
        ),
    } as unknown as TopMeanResultSummary;
    const wireHuge = toWireSafeTopMeanResultSummary(hugeSummary);
    assert.equal(wireHuge.openScoreEventDetails?.length, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS);
    assert.equal(
        wireHuge.openScoreEventDetailCount,
        TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55,
        "count reports the PRE-cap total",
    );

    const switchTrade = {
        arm: "topRaw", asset: "AAA", decisionTimeSec: 1_700_000_000,
        entryTimeSec: 1_700_000_001, entryPrice: 100,
        exitTimeSec: 1_700_000_100, exitPrice: 99,
        holdingDurationSec: 99, netPnl: -10, entryCost: 0, exitCost: 0,
        status: "closed",
    };
    const fullSwitchTrades = Array.from(
        { length: TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55 },
        () => switchTrade,
    );
    const switchSummary = {
        ...fullSummary,
        replayMode: "asset_switch",
        horizons: [],
        assetSwitch: {
            semanticsVersion: "asset_switch.v1",
            trades: fullSwitchTrades,
            tradeCount: fullSwitchTrades.length,
        },
        annualReports: [{
            year: 2026, sampleFromSec: 1, sampleToSec: 2, replayMode: "asset_switch",
            horizons: [], warnings: [], reportLines: [],
            assetSwitch: {
                semanticsVersion: "asset_switch.v1",
                trades: fullSwitchTrades.slice(0, 10),
                tradeCount: 10,
            },
        }],
    } as unknown as TopMeanResultSummary;
    const wireSwitch = toWireSafeTopMeanResultSummary(switchSummary);
    assert.equal(wireSwitch.assetSwitch?.trades?.length, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS);
    assert.equal(wireSwitch.assetSwitch?.tradeCount, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55);
    assert.equal(wireSwitch.annualReports?.[0]?.assetSwitch?.trades?.length, 10);
    assert.equal(wireSwitch.annualReports?.[0]?.assetSwitch?.tradeCount, 10);
    assert.equal(fullSwitchTrades.length, TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 55, "wire capping does not mutate archived trades");

    console.log("PASS: wire safety caps event details and strips archive-only diagnostics");
}

async function testManifestBackedStatusCapsWireResult(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-top-mean-wire-"));
    const runId = "spec_wire_status_1";
    try {
        saveManifest({
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "completed",
            fingerprint: "wire-safety-fingerprint",
            strategyKey: "close_location_median_alignment",
            interval: "4h",
            pairCount: 1,
            shardSize: 50,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: 1,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }, baseDir);

        // result.json on disk carries FULL rows (the research contract); the
        // reattach status response must cap them exactly like the live done
        // event.
        const detailRow = (i: number): any => ({
            decisionTime: 1_700_000_000 + i,
            entryTime: 1_700_003_600,
            exitTime: 1_700_176_400,
            horizonBars: 12,
            selector: "TOP_MEAN",
            direction: "long",
            asset: "ASSET",
            selectedReturn: 0.01,
            controlReturn: 0.02,
            delta: -0.01,
            eligibleCandidates: 3,
        });
        const runDir = getRunDir(runId, baseDir);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "result.json"), JSON.stringify({
            runId,
            completed: true,
            horizons: [],
            openScoreEventDetails: Array.from(
                { length: TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 40 },
                (_, i) => detailRow(i),
            ),
            poolSnapshots: [{ eventId: "p0" }],
            candidateOutcomes: [],
            warnings: [],
            reportLines: [],
            annualReports: [{
                year: 2026,
                sampleFromSec: 1,
                sampleToSec: 2,
                horizons: [],
                eventDetails: Array.from({ length: 30 }, (_, i) => detailRow(i)),
                warnings: [],
                reportLines: [],
            }],
        }));

        const status = await handleSp500TopMeanStatusRequest(runId, baseDir);
        assert.equal("ok" in status, false);
        if ("ok" in status) return;
        const result = status.result as any;
        assert.ok(result, "completed manifest reattach must surface the result");
        assert.equal(
            result.openScoreEventDetails.length,
            TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS,
            "wire result rows must be capped to the most recent",
        );
        assert.equal(
            result.openScoreEventDetailCount,
            TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 40,
            "wire result count reports the pre-cap total",
        );
        assert.equal(result.poolSnapshots, undefined, "wire result must drop archive-only diagnostics");
        assert.equal(result.candidateOutcomes, undefined);
        assert.equal(
            result.annualReports[0].eventDetails,
            undefined,
            "per-year detail rows must not ride the wire",
        );
        assert.equal(result.annualReports[0].eventDetailCount, 30, "per-year pre-cap total rides as a count");

        // Disk fidelity: result.json still holds every row.
        const disk = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
        assert.equal(
            disk.openScoreEventDetails.length,
            TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 40,
            "result.json on disk keeps FULL rows",
        );
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
    console.log("PASS: manifest-backed status caps the wire result like the done event");
}

async function testStatusSurfacesUnreadableResults(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "top-mean-result-errors-"));
    const runId = "spec_result_errors";
    try {
        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1", runId, status: "completed",
            fingerprint: "result-errors", strategyKey: "test", interval: "4h",
            pairCount: 1, shardSize: 1, totalShards: 1,
            completedShards: [0], failedShards: [],
            completedPairsCount: 1, failedPairsCount: 0,
            createdAt: Date.now(), updatedAt: Date.now(),
        };
        saveManifest(manifest, baseDir);
        const cases: Array<{ kind: string; read: (path: string) => Promise<string> }> = [
            { kind: "missing", read: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } },
            { kind: "invalid_json", read: async () => "{" },
            { kind: "invalid_shape", read: async () => '{"horizons":"bad"}' },
            { kind: "io_error", read: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
        ];
        for (const scenario of cases) {
            const status = await handleSp500TopMeanStatusRequest(runId, baseDir, scenario.read);
            assert.ok(!("ok" in status));
            assert.equal(status.status, "completed");
            assert.equal(status.result, undefined);
            assert.ok(status.resultError);
            const entry = debugLogger.getEntries().filter((item) => item.message === "sp500_top_mean.result_load_failed").at(-1);
            assert.equal((entry?.data as { failureKind: string }).failureKind, scenario.kind);
            assert.equal((entry?.data as { runId: string }).runId, runId);
        }
        manifest.status = "interrupted";
        saveManifest(manifest, baseDir);
        const status = await handleSp500TopMeanStatusRequest(runId, baseDir, cases[0]!.read);
        assert.ok(!("ok" in status));
        assert.equal(status.resultError, undefined, "missing incomplete result is expected");
    } finally {
        assert.ok(baseDir.startsWith(join(tmpdir(), "top-mean-result-errors-")));
        rmSync(baseDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testFullResultDownloadRoute();
    await testStatusSurfacesUnreadableResults();
    testAnnualReplayWindowsFollowSelectedRange();
    testReplayTargetOrderAvoidsLruThrash();
    await testReplayTargetCacheDeduplicatesLoads();
    await testEngineValidationAndConflict();
    await testSnapshotDerivedFromArtifacts();
    await testResultJsonAugmentationIsAdditive();
    await testResultSummaryFieldIsOptional();
    await testRunIntegratesSnapshotAndPersistsBeforeReplay();
    await testFinderArmProfileSkipsAnnualSnapshotAndResultJson();
    await testTopMeanRouteRejectsNonBooleanArchiveFlag();
    await testStaleRunningManifestReconcilesToInterrupted();
    await testTopMeanRouteRejectsInvalidRunIdsAndDates();
    await testTopMeanLargePairListAdmission();
    await testStopRouteRequiresExactRunId();
    await testStopSurvivesManifestPersistenceFailure();
    testSingleYearWindowDedupePreconditions();
    testReplayProgressThrottleAndCacheBound();
    await testStopDuringArchiveStaysInterrupted();
    await testManifestBackedStatusPreservesArchiveOutcome();
    testWireSafetyCapsEventDetailsAndStripsDiagnostics();
    await testManifestBackedStatusCapsWireResult();
    console.log("PASS: sp500-top-mean-server-plugin.spec.ts");
}

async function testFullResultDownloadRoute(): Promise<void> {
    const runId = `spec_download_${process.pid}_${Date.now().toString(36)}`;
    const runDir = getRunDir(runId);
    assert.equal(runDir, join(getArtifactsRootDir(), runId));
    assert.equal(existsSync(runDir), false, "download fixture must not replace existing artifacts");
    const resultPath = join(runDir, "result.json");
    const full = {
        eventDetails: Array.from({ length: TOP_MEAN_EVENT_DETAILS_WIRE_MAX_ROWS + 1 }, (_, i) => ({ i })),
        annualReports: [{ eventDetails: [{ asset: "ANNUAL_DETAIL" }] }],
        poolSnapshots: [{ archiveOnly: true }],
    };
    const routes = new Map<string, (req: any, res: any) => void | Promise<void>>();
    registerSp500TopMeanRoutes({ use(path, handler) { routes.set(path, handler); } }, {
        maxBodyBytes: 1024, rememberLocalApiOriginFromRequest: () => undefined,
        ownerLocks: { isBusy: () => false, acquire: () => ({ runOwner: 1, analysisOwner: 1 }), releaseIfStillOwner: () => undefined },
    });
    const get = async (id: string, remoteAddress = "127.0.0.1") => {
        const req: any = Readable.from([]);
        req.method = "GET";
        req.url = `/api/batch-backtest/sp500-top-mean/result?runId=${encodeURIComponent(id)}`;
        req.headers = { host: "127.0.0.1:5173" };
        req.socket = { remoteAddress };
        const res: any = { statusCode: 0, body: "", headers: {} as Record<string, string>,
            setHeader(name: string, value: string) { this.headers[name] = value; },
            end(body: string) { this.body = body; },
        };
        await routes.get("/api/batch-backtest/sp500-top-mean/result")!(req, res);
        return res;
    };
    try {
        mkdirSync(runDir, { recursive: true });
        writeFileSync(resultPath, JSON.stringify(full));
        const response = await get(runId);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), full, "download must retain uncapped and archive-only rows");
        assert.equal(response.headers["Content-Disposition"], `attachment; filename="sp500_top_mean_${runId}.json"`);
        assert.equal(response.headers["Cache-Control"], "no-store");
        for (const [id, remote, status] of [["../escape", "127.0.0.1", 400], [runId, "198.51.100.1", 401]] as const) {
            const rejected = await get(id, remote);
            assert.equal(rejected.statusCode, status);
            assert.equal(rejected.headers["Content-Disposition"], undefined);
        }
        rmSync(resultPath);
        const missing = await get(runId);
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.headers["Content-Disposition"], undefined);
        writeFileSync(resultPath, "{");
        const invalid = await get(runId);
        assert.equal(invalid.statusCode, 500);
        assert.equal(invalid.headers["Content-Disposition"], undefined);
    } finally {
        assert.equal(runDir, join(getArtifactsRootDir(), runId));
        rmSync(runDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-server-plugin.spec.ts", err);
    process.exit(1);
});
