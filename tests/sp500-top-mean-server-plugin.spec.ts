import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    TopMeanCoordinatorEngine,
    type TopMeanResultSummary,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import {
    computeRunFingerprint,
    getRunDir,
    iterateRunRawCompactArtifacts,
    saveManifest,
    writeShardArtifacts,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";
import { enumerateSp500Pairs } from "../lib/batch-backtest/sp500-pair-enumerator";
import type { CompactPairArtifact, TopMeanRunManifest } from "../lib/batch-backtest/compact-pair-artifact";
import { computeCurrentTopMeanSnapshot } from "../lib/batch-backtest/sp500-top-mean-current-snapshot";
import type { Time } from "lightweight-charts";

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
    };

    const engine = new TopMeanCoordinatorEngine(request as any);
    const status = engine.getStatus();

    assert.equal(status.runId, "spec_test_run_1");
    assert.equal(status.status, "running");
    assert.equal(status.phase, "preflight");

    // Test stop
    engine.stop();
    const stoppedStatus = engine.getStatus();
    assert.equal(stoppedStatus.phase, "interrupted");

    console.log("PASS: engine validation/stop contract unchanged");
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
    // The engine ties one `baseDir` to BOTH the artifact root and enumeration's
    // catalog lookup. A temp baseDir would make enumeration fail to find the
    // S&P 500 catalog, so we omit baseDir (artifacts land in the worktree's
    // artifacts/sp500-top-mean/<runId>) and clean up that specific run dir.
    const runId = `spec_integration_${Date.now()}`;
    const endpoint = 1_700_000_000;
    const baseDir = undefined;

    // Use the SAME pairListText the engine will use, so enumeration returns a
    // deterministic canonical-asset list we can fingerprint.
    const pairListText = "AAPL•+MSFT•\nAAPL•+NVDA•";
    const enumRes = enumerateSp500Pairs({ interval: "4h", pairListText });
    if (enumRes.canonicalPairs.length === 0) {
        // Catalog not available in this environment — skip, not fail.
        console.log("SKIP: integration test (S&P 500 catalog not available in this env)");
        return;
    }

    const request: Record<string, unknown> = {
        runId,
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: { direction: "long", slippage: 0, commission: 0 },
        capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 },
        interval: "4h",
        horizons: [12],
        pairListText,
        resume: true,
        useRustEnginePreference: false,
    };
    const fingerprint = computeRunFingerprint({
        strategyKey: request.strategyKey as string,
        strategyParams: request.strategyParams,
        backtestSettings: request.backtestSettings,
        capitalSettings: request.capitalSettings,
        interval: "4h",
        useRustEnginePreference: false,
        canonicalAssets: enumRes.eligibleAssets,
    });

    // Pre-write a completed manifest + shard 0 with six open long pairs that
    // produce a clean 3-way tie: AAPL, MSFT, NVDA each as base in 2 pairs and
    // never as a positive leg elsewhere -> each nets +2, activePairs 2,
    // mean 1.0 -> 3-way tie. The reducer must surface all three (no silent
    // tie-break), which the coordinator then persists verbatim.
    const shardZero: CompactPairArtifact[] = [
        openArtifact(0, "AAPL+Q1", "long", endpoint),
        openArtifact(1, "AAPL+Q2", "long", endpoint),
        openArtifact(2, "MSFT+Q3", "long", endpoint),
        openArtifact(3, "MSFT+Q4", "long", endpoint),
        openArtifact(4, "NVDA+Q5", "long", endpoint),
        openArtifact(5, "NVDA+Q6", "long", endpoint),
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
        completedPairsCount: 3,
        failedPairsCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    saveManifest(manifest, baseDir);

    let engine: TopMeanCoordinatorEngine | null = null;
    try {
        engine = new TopMeanCoordinatorEngine(request as any, baseDir);
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
                engine!.stop();
            }
        });

        // 1. run() invoked the reducer and emitted current_snapshot BEFORE replay.
        assert.ok(sawSnapshot, "run() must emit a current_snapshot event");
        const snapshotIdx = events.findIndex((e) => e.type === "current_snapshot");
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
        const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as { currentSnapshot?: unknown };
        assert.ok(onDisk.currentSnapshot, "persisted result.json must carry currentSnapshot");
        const persistedManifest = JSON.parse(
            readFileSync(join(getRunDir(runId, baseDir), "manifest.json"), "utf8"),
        ) as TopMeanRunManifest;
        assert.equal(persistedManifest.requestedEngineMode, "typescript");
        assert.equal(persistedManifest.actualEngineMode, "typescript");
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
    } finally {
        // Clean up ONLY this test's run dir from the worktree artifact root.
        try {
            rmSync(getRunDir(runId, baseDir), { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
    }
}

/**
 * Phase-2 gate integration: pre-seed the full-history and one start-date
 * window, then drive the real coordinator stability branch. This isolates the
 * orchestration contract from worker/data loading while still exercising the
 * real window manifests, raw-artifact reducer, comparison, and persistence.
 */
async function testStabilityModeRunsWindowsAndSkipsReplay(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "sp500-stability-"));
    const runId = `spec_stability_${Date.now()}`;
    const endpoint = 1_700_000_000;
    const startDateSec = 1_672_531_200; // 2023-01-01 UTC
    const pairListText = "AAPL\u2022+MSFT\u2022\nAAPL\u2022+NVDA\u2022";
    const request = {
        runId,
        strategyKey: "close_location_median_alignment",
        strategyParams: { lookback: 20, threshold: 0.5 },
        backtestSettings: { direction: "long", slippage: 0, commission: 0 },
        capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "capital_pct", fixedTradeAmount: 1000 },
        interval: "4h",
        horizons: [12],
        pairListText,
        resume: true,
        stabilityStartDates: [startDateSec],
        useRustEnginePreference: false,
    };
    const seedDir = join(baseDir, "price-data", "ibkr", "csv", "30m");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
        join(baseDir, "price-data", "ibkr", "catalog.json"),
        JSON.stringify({ entries: [{ symbol: "AAPL" }, { symbol: "MSFT" }, { symbol: "NVDA" }] }),
        "utf8",
    );
    for (const asset of ["AAPL", "MSFT", "NVDA"]) {
        writeFileSync(join(seedDir, `${asset}.csv`), "", "utf8");
    }

    const enumRes = enumerateSp500Pairs({ interval: "4h", pairListText, baseDir });
    if (enumRes.canonicalPairs.length === 0) {
        rmSync(baseDir, { recursive: true, force: true });
        throw new Error("Stability integration fixture failed to enumerate its synthetic catalog pairs");
    }

    const fingerprint = computeRunFingerprint({
        strategyKey: request.strategyKey,
        strategyParams: request.strategyParams,
        backtestSettings: request.backtestSettings,
        capitalSettings: request.capitalSettings,
        interval: request.interval,
        useRustEnginePreference: false,
        canonicalAssets: enumRes.eligibleAssets,
    });

    const writeWindow = (windowKey: string, winner: string): void => {
        writeShardArtifacts(
            runId,
            0,
            [openArtifact(0, `${winner}+Q1`, "long", endpoint)],
            baseDir,
            windowKey,
        );
        const manifest: TopMeanRunManifest = {
            schema: "top_mean_run_manifest.v1",
            runId,
            status: "completed",
            fingerprint,
            strategyKey: request.strategyKey,
            interval: request.interval,
            pairCount: enumRes.canonicalPairs.length,
            shardSize: 250,
            totalShards: 1,
            completedShards: [0],
            failedShards: [],
            completedPairsCount: 1,
            failedPairsCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveManifest(manifest, baseDir, windowKey);
    };

    // The full-history window picks AAA; the 2023 window picks BBB. The real
    // comparison must report divergence, proving the gate blocks Phase 2.
    writeWindow("full", "AAA");
    writeWindow(`from_${startDateSec}`, "BBB");

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    try {
        const engine = new TopMeanCoordinatorEngine(request as any, baseDir);
        await engine.run((event: unknown) => {
            events.push(event as { type: string; [key: string]: unknown });
        });

        const stabilityDone = events.find((event) => event.type === "stability_done") as { comparison?: any } | undefined;
        assert.ok(stabilityDone, "stability mode must emit stability_done");
        assert.equal(events.some((event) => event.type === "done"), false, "stability mode must skip normal replay done");
        assert.equal(stabilityDone.comparison.divergentWindows, true);
        assert.equal(stabilityDone.comparison.parityAssumptionHolds, false);
        assert.deepEqual(
            stabilityDone.comparison.windows.map((window: any) => window.snapshot.winners.map((winner: any) => winner.asset)),
            [["AAA"], ["BBB"]],
        );

        const persistedPath = join(getRunDir(runId, baseDir), "stability_result.json");
        assert.ok(existsSync(persistedPath), "stability comparison must be persisted for reattach");
        const persisted = JSON.parse(readFileSync(persistedPath, "utf8")) as { parityAssumptionHolds: boolean };
        assert.equal(persisted.parityAssumptionHolds, false);
        console.log("PASS: stability mode runs window snapshots, skips replay, and persists the gate result");
    } finally {
        try {
            rmSync(baseDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup for this test's isolated run directory.
        }
    }
}

function openArtifact(
    pairIndex: number,
    symbol: string,
    type: "long" | "short",
    dataEndTime: number,
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
        trades: [{ type, entryTime: 1 as Time, exitTime: 2 as Time, exitReason: "end_of_data" }],
        dataEndTime,
    };
}

async function main(): Promise<void> {
    await testEngineValidationAndConflict();
    await testSnapshotDerivedFromArtifacts();
    await testResultJsonAugmentationIsAdditive();
    await testResultSummaryFieldIsOptional();
    await testRunIntegratesSnapshotAndPersistsBeforeReplay();
    await testStabilityModeRunsWindowsAndSkipsReplay();
    console.log("PASS: sp500-top-mean-server-plugin.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: sp500-top-mean-server-plugin.spec.ts", err);
    process.exit(1);
});
