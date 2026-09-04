import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    archiveCompletedTopMeanRun,
    resolveTopMeanArchiveLogDir,
} from "../lib/batch-backtest/sp500-top-mean-archive-log";
import type {
    TopMeanCoordinatorRunRequest,
    TopMeanResultSummary,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import type { TopMeanArchiveManifest } from "../lib/batch-backtest/sp500-top-mean-archive-log";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

function makeRequest(runId = "top_mean_archive_test_1"): TopMeanCoordinatorRunRequest {
    return {
        runId,
        strategyKey: "test_strategy",
        strategyParams: {},
        backtestSettings: {},
        capitalSettings: {},
        interval: "4h",
        horizons: [12, 24],
        workerCount: 2,
        maxPairs: 10,
        saveArchiveLog: true,
        useRustEnginePreference: true,
        sampleFromSec: 1_700_000_000,
        sampleToSec: 1_700_086_400,
    } as unknown as TopMeanCoordinatorRunRequest;
}

function makeManifest(): TopMeanArchiveManifest {
    return {
        strategy: {
            key: "test_strategy",
            params: { lookback: 20 },
            normalizeApplied: true,
        },
        settings: {
            backtest: { interval: "4h", slippageBps: 10 },
            capital: { commission: 0.1 },
        },
        pairs: {
            pairs: ["AAPLUSDT+MSFTUSDT"],
            executionOrderSha256: "execution-hash",
            sortedSetSha256: "sorted-hash",
            source: { kind: "sp500_default", poolVersion: null },
            construction: { algorithm: null, seed: null },
        },
        catalog: {
            assets: ["AAPL", "MSFT"],
            sha256: "catalog-hash",
            warmup: null,
            dataCutoff: "2026-08-24T00:00:00.000Z",
        },
        costs: {
            slippageRate: 0.001,
            commissionRate: 0.001,
            slippageBps: 10,
            commissionPercent: 0.1,
        },
        windowDesignation: "other",
        researchContract: {
            tieVersion: "max_active_tie_v1",
            blockCount: 10,
            bootstrapSamples: 10_000,
            bootstrapSeed: 1,
        },
    };
}

function makeSummary(completed = true): TopMeanResultSummary {
    const event = {
        decisionTime: 1_700_000_000,
        entryTime: 1_700_000_001,
        exitTime: 1_700_000_100,
        horizonBars: 12,
        selector: "TOP_MEAN" as const,
        direction: "long" as const,
        asset: "AAPL",
        selectedReturn: 0.1,
        controlReturn: 0.02,
        delta: 0.08,
        eligibleCandidates: 3,
    };
    const poolSnapshot: PoolSnapshotRecord = {
        eventId: "4h:1700000000",
        decisionTimeSec: 1_700_000_000,
        interval: "4h",
        poolVersion: null,
        asset: "AAPL",
        inPool: true,
        activePairCount: 2,
        signedVotes: 1,
        score: 0.5,
        longEligible: true,
        shortEligible: false,
        ema200Above: true,
        breadth: 0.75,
        regime: "bullish",
    };
    const candidateOutcome: CandidateOutcomeRecord = {
        eventId: "4h:1700000000",
        decisionTimeSec: 1_700_000_000,
        horizonBars: 12,
        direction: "long",
        asset: "AAPL",
        inPool: true,
        eligible: true,
        return: 0.1,
        entryTimeSec: 1_700_000_001,
        exitTimeSec: 1_700_000_100,
        status: "ok",
    };
    return {
        runId: "top_mean_archive_test_1",
        completed,
        archiveComplete: false,
        counts: {
            sp500AssetsCount: 2,
            catalogAssetsCount: 2,
            usable30mSeedCount: 2,
            usableTargetIntervalCount: 2,
            pairCount: 1,
            excludedAssetsCount: 0,
            excludedPairsCount: 0,
        },
        horizons: [],
        annualReports: [{
            year: 2023,
            sampleFromSec: 1_700_000_000,
            sampleToSec: 1_731_254_399,
            horizons: [],
            eventDetails: [event],
            warnings: [],
            reportLines: ["annual report"],
        }],
        openScoreEventDetails: [event],
        poolSnapshots: [poolSnapshot],
        candidateOutcomes: [candidateOutcome],
        warnings: [],
        reportLines: ["TOP_MEAN report", "line 2"],
        latestSelections: null,
        performance: {
            engine: {
                requested: "rust",
                actual: "typescript",
                typescriptRequirementReasons: ["slippage is enabled"],
            },
        } as TopMeanResultSummary["performance"],
    };
}

async function testCompletedRunWritesArchive(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "top-mean-archive-"));
    try {
        const request = makeRequest();
        const summary = makeSummary();
        let metaWriteObserved = false;
        const outcome = await archiveCompletedTopMeanRun(summary, request, {
            root,
            canonicalAssets: ["AAPL", "MSFT"],
            fingerprint: "fingerprint-test",
            completedAt: "2026-08-24T00:00:00.000Z",
            manifest: makeManifest(),
            beforeMetaWrite: (filenames) => {
                const runDir = join(root, "archive", "batch-open-score", request.runId);
                assert.equal(existsSync(join(runDir, "meta.json")), false);
                assert.ok(filenames.length > 0);
                assert.ok(filenames.every((filename) => existsSync(join(runDir, filename))));
                metaWriteObserved = true;
            },
        });

        assert.equal(outcome.reason, "saved");
        assert.equal(metaWriteObserved, true);
        assert.equal(outcome.archiveDir, join(root, "archive", "batch-open-score", request.runId));
        summary.archiveComplete = outcome.reason === "saved";
        assert.equal(summary.archiveComplete, true);
        const runDir = join(root, "archive", "batch-open-score", request.runId);
        assert.equal(readFileSync(join(runDir, "report.txt"), "utf8"), summary.reportLines.join("\n"));
        const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as Record<string, any>;
        assert.equal(meta.schema, "top_mean_archive.v3");
        assert.equal(meta.runId, request.runId);
        assert.equal(meta.completedAt, "2026-08-24T00:00:00.000Z");
        assert.equal(meta.fingerprint, "fingerprint-test");
        assert.equal(meta.runFingerprint, "fingerprint-test");
        assert.equal(meta.fingerprintVersion, "top_mean_ledger_fingerprint.v2");
        assert.deepEqual(meta.manifest, makeManifest());
        assert.equal(meta.featureSet.schema, "top_mean_candidate_features.v1");
        assert.equal(meta.featureSet.contractVersion, "top_mean_feature_set.v2");
        assert.equal(meta.featureSet.formulaVersion, "tm_feature_formulas.v1");
        assert.equal(meta.featureSet.availabilityPolicy, "strict_prior_exit_v1");
        assert.equal(meta.featureSet.file, "candidate-features.jsonl");
        assert.equal(meta.featureSet.rowCount, 1);
        assert.equal(meta.files["pool-snapshots.jsonl"], meta.featureSet.sources.poolSnapshotsSha256);
        assert.equal(meta.files["candidate-outcomes.jsonl"], meta.featureSet.sources.candidateOutcomesSha256);
        assert.equal(meta.files["candidate-features.jsonl"], meta.featureSet.sha256);
        const event = summary.openScoreEventDetails![0];
        assert.equal(
            readFileSync(join(runDir, "events-full.jsonl"), "utf8"),
            `${JSON.stringify({ ...event, eventId: "4h:1700000000", poolVersion: null })}\n`,
        );
        assert.equal(
            readFileSync(join(runDir, "events-annual-2023.jsonl"), "utf8"),
            `${JSON.stringify({ ...summary.annualReports![0]!.eventDetails![0], eventId: "4h:1700000000", poolVersion: null })}\n`,
        );
        assert.equal(
            readFileSync(join(runDir, "pool-snapshots.jsonl"), "utf8"),
            `${JSON.stringify(summary.poolSnapshots![0])}\n`,
        );
        assert.equal(
            readFileSync(join(runDir, "candidate-outcomes.jsonl"), "utf8"),
            `${JSON.stringify(summary.candidateOutcomes![0])}\n`,
        );
        const featureRows = readFileSync(join(runDir, "candidate-features.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
        assert.deepEqual(featureRows, [{
            eventId: "4h:1700000000",
            decisionTimeSec: 1_700_000_000,
            asset: "AAPL",
            priorCoverageSlope5: null,
            priorSignedVoteDelta3: null,
            priorScoreStdDev5: null,
            priorTopMeanReturnMean3: null,
        }]);
        assert.equal(resolveTopMeanArchiveLogDir(root, { TOP_MEAN_ARCHIVE_LOG_DIR: "" }), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

async function testDisabledAndFailedWritesAreBestEffort(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "top-mean-archive-disabled-"));
    try {
        const offRequest = { ...makeRequest(), saveArchiveLog: false };
        const notRequested = await archiveCompletedTopMeanRun(makeSummary(), offRequest, {
            root,
            manifest: makeManifest(),
        });
        assert.equal(notRequested.reason, "not_requested");
        assert.equal(existsSync(join(root, "archive")), false);

        const request = makeRequest();
        const summary = makeSummary();
        const disabled = await archiveCompletedTopMeanRun(summary, request, {
            root,
            env: { TOP_MEAN_ARCHIVE_LOG_DIR: "" },
            manifest: makeManifest(),
        });
        assert.equal(disabled.reason, "disabled");
        assert.equal(existsSync(join(root, "archive")), false);
        assert.equal(existsSync(join(root, "pool-snapshots.jsonl")), false);
        assert.equal(existsSync(join(root, "candidate-outcomes.jsonl")), false);

        const blocked = join(root, "blocked");
        writeFileSync(blocked, "not a directory", "utf8");
        const warnings: string[] = [];
        const failed = await archiveCompletedTopMeanRun(summary, request, {
            root: blocked,
            warn: (event) => warnings.push(event),
            manifest: makeManifest(),
        });
        summary.archiveComplete = failed.reason === "saved";
        assert.equal(failed.reason, "failed");
        assert.equal(typeof failed.error, "string");
        assert.equal(summary.completed, true);
        assert.equal(summary.archiveComplete, false);
        assert.deepEqual(warnings, ["sp500_top_mean.archive_log_failed"]);

        const invalid = await archiveCompletedTopMeanRun(summary, makeRequest("../evil"), {
            root: blocked,
            warn: (event) => warnings.push(event),
            manifest: makeManifest(),
        });
        assert.equal(invalid.reason, "failed");
        assert.deepEqual(warnings, [
            "sp500_top_mean.archive_log_failed",
            "sp500_top_mean.archive_log_failed",
        ]);

        const incompleteRoot = join(root, "incomplete-feature-build");
        const incompleteRunDir = join(incompleteRoot, "archive", "batch-open-score", request.runId);
        mkdirSync(incompleteRunDir, { recursive: true });
        writeFileSync(join(incompleteRunDir, "meta.json"), "stale complete metadata", "utf8");
        const stagedPool = join(root, "staged-pool.jsonl");
        const stagedOutcomes = join(root, "staged-outcomes.jsonl");
        writeFileSync(stagedPool, `${JSON.stringify(makeSummary().poolSnapshots![0])}\n`, "utf8");
        writeFileSync(stagedOutcomes, "{malformed jsonl\n", "utf8");
        const featureFailed = await archiveCompletedTopMeanRun(summary, request, {
            root: incompleteRoot,
            phase0bFiles: { poolSnapshotsPath: stagedPool, candidateOutcomesPath: stagedOutcomes },
            manifest: makeManifest(),
        });
        assert.equal(featureFailed.reason, "failed");
        assert.equal(existsSync(join(incompleteRunDir, "meta.json")), false);
        assert.equal(existsSync(join(incompleteRunDir, "candidate-features.jsonl")), false);

        const cancelledRoot = join(root, "cancelled");
        const cancelled = await archiveCompletedTopMeanRun(makeSummary(false), request, {
            root: cancelledRoot,
            manifest: makeManifest(),
        });
        assert.equal(cancelled.reason, "not_completed");
        assert.equal(existsSync(cancelledRoot), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

async function testMarkedRegistryPoolMatch(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "top-mean-archive-pool-match-"));
    try {
        const registryDir = join(root, "docs", "pairlist-pools");
        mkdirSync(registryDir, { recursive: true });
        writeFileSync(
            join(registryDir, "BAL679.v1.json"),
            readFileSync(join(process.cwd(), "docs", "pairlist-pools", "BAL679.v1.json")),
        );
        const markedPairText = readFileSync(
            join(process.cwd(), "docs", "pairlist-pools", "BAL679.v1.txt"),
            "utf8",
        );
        const markedPairs = markedPairText.trim().split(/\r?\n/);
        const request = makeRequest("top_mean_archive_pool_match_1");
        request.pairListText = markedPairText;
        const manifest = makeManifest();
        manifest.pairs = {
            ...manifest.pairs,
            pairs: markedPairs,
            source: { kind: "custom_pair_list" },
        };
        const completed = await archiveCompletedTopMeanRun(makeSummary(), request, {
            root,
            manifest,
        });
        assert.equal(completed.reason, "saved");
        const meta = JSON.parse(readFileSync(
            join(root, "archive", "batch-open-score", request.runId, "meta.json"),
            "utf8",
        )) as { manifest: TopMeanArchiveManifest };
        assert.equal(meta.manifest.pairs.source.poolVersion, "BAL679.v1");
        assert.equal(meta.manifest.pairs.construction.algorithm, "seeded_round_robin_v1");
        assert.equal(meta.manifest.pairs.construction.seed, 1);
        const event = JSON.parse(readFileSync(
            join(root, "archive", "batch-open-score", request.runId, "events-full.jsonl"),
            "utf8",
        )) as { eventId: string; poolVersion: string | null };
        assert.equal(event.eventId, "4h:1700000000");
        assert.equal(event.poolVersion, "BAL679.v1");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testCompletedRunWritesArchive();
    await testDisabledAndFailedWritesAreBestEffort();
    await testMarkedRegistryPoolMatch();
    console.log("PASS: sp500-top-mean-archive-log.spec.ts");
}

main().catch((error: unknown) => {
    console.error("FAIL: sp500-top-mean-archive-log.spec.ts", error);
    process.exit(1);
});
