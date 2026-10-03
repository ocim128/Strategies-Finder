import { expect } from "chai";
import { createEmptyRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import { FINDER_CAUSAL_ARMS_V1 } from "../lib/batch-backtest/open-score-replay/causal-arm-constants";
import { describe, it } from "node:test";
import {
    FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
    type FinderArmPerformanceArm,
} from "../lib/finder/finder-arm-performance-metrics";
import {
    FinderArmPerformanceChildError,
    runFinderArmPerformance,
    type FinderArmPerformanceCoordinator,
    type FinderArmPerformanceRunnerInput,
} from "../lib/finder/finder-arm-performance-runner";
import type { TopMeanCoordinatorRunRequest, TopMeanResultSummary, TopMeanStatusResponse } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import type { TopMeanWorkerPool } from "../lib/batch-backtest/sp500-top-mean-worker-pool";
import type { BacktestSettings } from "../lib/types/strategies";
import type { FinderArmPerformanceCandidateDiagnostic } from "../lib/finder/finder-arm-performance-diagnostics";
import type { TopMeanPerformanceDiagnostic } from "../lib/batch-backtest/sp500-top-mean-performance";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    evictRunParsedShardCache, getRunDir, readShardArtifactsAsync, writeShardArtifacts,
} from "../lib/batch-backtest/sp500-top-mean-artifact-store";

function makeInput(signal = new AbortController().signal): FinderArmPerformanceRunnerInput {
    return {
        runId: "finder-arm-test",
        interval: "4h",
        options: {
            mode: "random",
            scope: "arm_performance",
            topN: 10,
            steps: 3,
            rangePercent: 100,
            maxRuns: 2,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            freezeRiskManagement: true,
            armPerformance: { horizon: 5, dateMode: "full" },
        } as FinderArmPerformanceRunnerInput["options"],
        settings: {
            executionModel: "signal_close",
            marketMode: "all",
            tradeDirection: "long",
            disableSignalExits: false,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: "stale_exit",
            exitStrategyParams: { stale: 1 },
        } as BacktestSettings,
        capitalSettings: {} as FinderArmPerformanceRunnerInput["capitalSettings"],
        useRustEnginePreference: false,
        evaluationCutoffSec: 1_700_000_000,
        enumeration: {
            canonicalPairs: ["AAA+BBB", "CCC+DDD"],
            eligibleAssets: [],
            eligibleTargets: [],
            excludedAssets: [],
            skippedPairTokens: [],
            rejectedPairTokens: [],
            counts: {
                sp500AssetsCount: 0,
                catalogAssetsCount: 0,
                usable30mSeedCount: 0,
                usableTargetIntervalCount: 0,
                pairCount: 2,
                excludedAssetsCount: 0,
                excludedPairsCount: 0,
            },
        },
        selectedStrategies: [],
        exitStrategyCandidates: [],
        baseDir: ".",
        signal,
        isCancelled: () => false,
        plans: [
            { params: { period: 2 }, strategyKey: "test_strategy", strategyName: "Test", candidateOrdinal: 0 },
            { params: { period: 3 }, strategyKey: "test_strategy", strategyName: "Test", candidateOrdinal: 1 },
        ],
    };
}

function makeSummary(): TopMeanResultSummary {
    const armComparisons = Object.fromEntries(
        (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[]).map((arm, index) => [arm, {
            events: 2,
            topMean: index + 0.25,
            randomMean: 0.1,
            delta: index + 0.05,
            topMedian: index + 0.2,
            blockMeans: [index + 0.05],
            ciLower: index,
            ciUpper: index + 0.1,
            positiveBlocks: 1,
            totalBlocks: 1,
        }]),
    );
    const armComparisonsExTopContributor = Object.fromEntries(
        (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[]).map((arm, index) => [arm, {
            events: 1,
            topMean: index + 10,
            randomMean: 0.2,
            delta: index + 9,
            topMedian: index + 10,
            blockMeans: [],
            ciLower: index + 8,
            ciUpper: index + 11,
            positiveBlocks: 1,
            totalBlocks: 1,
        }]),
    );
    const armTopContributors = Object.fromEntries(
        (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[]).map((arm) => [arm, {
            asset: "AAA",
            events: 1,
        }]),
    );
    return {
        runId: "child",
        causalArmDefinitions: { ...FINDER_CAUSAL_ARMS_V1 },
        completed: true,
        archiveComplete: false,
        counts: {} as TopMeanResultSummary["counts"],
        horizons: [{
            horizon: 5,
            events: 2,
            topMean: armComparisons.TOP_MEAN!,
            topAssets: [],
            armComparisons,
            armComparisonsExTopContributor,
            armTopContributors,
        } as TopMeanResultSummary["horizons"][number]],
        warnings: [],
        reportLines: [],
    };
}

function makeSwitchSummary(): TopMeanResultSummary {
    const arm = {
        status: "complete", enteredCount: 1, completedTrades: 0,
        realizedNetPnl: 0, openPositionNetPnl: 4, totalNetPnl: 4,
        partialRealizedNetPnl: 0, completedHoldingDurationSec: 0,
        averageCompletedHoldingDurationSec: null, totalCosts: 1,
        openPosition: null, pendingOrder: null,
        diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
    };
    return {
        runId: "child-switch",
        causalArmDefinitions: { ...FINDER_CAUSAL_ARMS_V1 },
        replayMode: "asset_switch",
        completed: true,
        archiveComplete: false,
        counts: {} as TopMeanResultSummary["counts"],
        horizons: [],
        assetSwitch: {
            semanticsVersion: "asset_switch.v1",
            decisionCount: 1,
            windowStartSec: null,
            windowEndSec: 1_700_000_000,
            independentWindow: false,
            sizing: "fixed_entry_notional_non_compounding",
            notionalPerEntry: 1_000,
            slippageRate: 0,
            commissionRate: 0,
            valuation: "last_closed_candle_close_at_or_before_window_end",
            coverage: { requestedAssets: 4, loadedAssets: 4, missingAssets: 0, invalidSeries: 0 },
            arms: Object.fromEntries(Object.values(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((field) => [field, arm])) as any,
        },
        warnings: [],
        reportLines: [],
    };
}

function makeCoordinator(
    request: TopMeanCoordinatorRunRequest,
    status: Partial<TopMeanStatusResponse>,
    run: (emit: (event: unknown) => void) => Promise<void>,
    order: string[],
): FinderArmPerformanceCoordinator {
    return {
        request,
        async run(emit) {
            order.push(`run:${request.runId}`);
            await run(emit);
        },
        stop() {},
        async waitForTeardown() { order.push(`teardown:${request.runId}`); },
        getStatus() {
            return {
                runId: request.runId,
                status: "completed",
                phase: "completed",
                pairTotals: 2,
                completedPairs: 2,
                failedPairs: 0,
                progressText: "done",
                workerCount: 1,
                requestedEngineMode: "typescript",
                actualEngineMode: "typescript",
                engineUsage: { rust: 0, typescript: 2 },
                ...status,
            } as TopMeanStatusResponse;
        },
    };
}

describe("Finder Arm Performance runner", () => {
    for (const mode of ["horizon", "asset_switch"] as const) {
        it("collects requested " + mode + " ranking summaries before cleanup", async () => {
            const input = makeInput();
            input.options.armPerformance = { replayMode: mode, horizon: 5, rankingHorizon: 20, measurement: "ranking_consistency", dateMode: "full" };
            const summary = mode === "asset_switch" ? makeSwitchSummary() : makeSummary();
            summary.rankingMeasurement = createEmptyRankingMeasurement(mode === "horizon" ? 5 : 20, true);
            const order: string[] = [];
            const candidates = await runFinderArmPerformance(input, {
                onProgress() {}, setActiveCoordinator() {},
                onCandidate(candidate) { expect(candidate.rankingMeasurement).to.deep.equal(summary.rankingMeasurement); order.push("collected"); },
            }, {
                createCoordinator(request, _baseDir, deps) {
                    expect(request.rankingHorizon).to.equal(mode === "horizon" ? 5 : 20);
                    expect(deps.executionProfile).to.equal("finder_arm");
                    return makeCoordinator(request, { result: summary }, async (emit) => { emit({ type: "done", result: summary }); }, order);
                },
                async removeChildArtifacts() { expect(order).to.include("collected"); order.push("removed"); },
            });
            expect(candidates).to.have.length(2);
            if (mode === "asset_switch") expect(candidates[0]).not.to.have.any.keys("horizon", "metrics");
        });
        it("treats a missing requested " + mode + " ranking section as a child contract error", async () => {
            const input = makeInput();
            input.options.armPerformance = { replayMode: mode, horizon: 5, rankingHorizon: 20, measurement: "ranking_consistency", dateMode: "full" };
            const summary = mode === "asset_switch" ? makeSwitchSummary() : makeSummary();
            let removed = 0, collected = 0, error: unknown;
            try {
                await runFinderArmPerformance(input, { onProgress() {}, setActiveCoordinator() {}, onCandidate() { collected += 1; } }, {
                    createCoordinator(request) { return makeCoordinator(request, { result: summary }, async (emit) => { emit({ type: "done", result: summary }); }, []); },
                    async removeChildArtifacts() { removed += 1; },
                });
            } catch (caught) { error = caught; }
            expect(error).to.be.instanceOf(FinderArmPerformanceChildError);
            expect(String(error)).to.contain("required valid ranking measurement section");
            expect(removed).to.equal(1);
            expect(collected).to.equal(0);
        });
        for (const failure of ["missing_arm", "invalid_arm", "missing_definition"] as const) {
            it(`rejects ${failure} on a newly enabled ${mode} child before collecting it`, async () => {
                const input = makeInput();
                input.options.armPerformance = { replayMode: mode, horizon: 5, rankingHorizon: 20, measurement: "return", dateMode: "full" };
                const summary = mode === "asset_switch" ? makeSwitchSummary() : makeSummary();
                if (failure === "missing_definition") delete summary.causalArmDefinitions;
                else if (mode === "asset_switch") {
                    if (failure === "missing_arm") delete summary.assetSwitch!.arms.topCoverage;
                    else summary.assetSwitch!.arms.topCoverage = { ...summary.assetSwitch!.arms.topCoverage!, enteredCount: -1 };
                } else {
                    if (failure === "missing_arm") delete summary.horizons[0]!.armComparisons!.TOP_COVERAGE;
                    else summary.horizons[0]!.armComparisons!.TOP_COVERAGE!.events = -1;
                }
                let removed = 0, collected = 0, error: unknown;
                try {
                    await runFinderArmPerformance(input, { onProgress() {}, setActiveCoordinator() {}, onCandidate() { collected++; } }, {
                        createCoordinator(request) { return makeCoordinator(request, { result: summary }, async (emit) => { emit({ type: "done", result: summary }); }, []); },
                        async removeChildArtifacts() { removed++; },
                    });
                } catch (caught) { error = caught; }
                expect(error).to.be.instanceOf(FinderArmPerformanceChildError);
                expect(removed).to.equal(1);
                expect(collected).to.equal(0);
            });
        }
    }
    it("flushes compact success and failure diagnostics before deleting each child", async () => {
        const order: string[] = [];
        const diagnostics: FinderArmPerformanceCandidateDiagnostic[] = [];
        let created = 0;
        const performance: TopMeanPerformanceDiagnostic = {
            schema: "sp500_top_mean_performance.v1", startedAt: "fixture",
            totalMs: 100, pairCount: 2, completedPairs: 2, failedPairs: 0, workerCount: 1, pairsPerSecond: 20,
            phases: { preflightMs: 1, backtestingMs: 60, snapshotMs: 0, replayMs: 39, resultWriteMs: 0 },
            replay: {
                scanMs: 10, eventsMs: 1, targetsMs: 1, outcomesMs: 20, aggregateMs: 7,
                targetLoadMs: 5, targetDatasets: 2, targetCacheHits: 1, targetCacheMisses: 2, targetCachePeakEntries: 2,
            },
        };
        let error: unknown;
        try {
            await runFinderArmPerformance(makeInput(), {
                onProgress() {}, onCandidate() {}, setActiveCoordinator() {},
                async onCandidateDiagnostic(diagnostic) {
                    diagnostics.push(diagnostic);
                    await Promise.resolve();
                    order.push(`logged:${diagnostic.candidateOrdinal}`);
                },
            }, {
                createCoordinator(request) {
                    const ordinal = created++;
                    return makeCoordinator(request, { performance, result: makeSummary() }, async (emit) => {
                        if (ordinal === 0) emit({ type: "done", result: makeSummary() });
                        else emit({ type: "fatal", error: "replay failed" });
                    }, order);
                },
                async removeChildArtifacts() { order.push(`removed:${created - 1}`); },
            });
        } catch (caught) { error = caught; }
        expect(error).to.be.instanceOf(FinderArmPerformanceChildError);
        expect(diagnostics.map((item) => item.outcome)).to.deep.equal(["completed", "failed"]);
        expect(diagnostics[1]!.error).to.equal("replay failed");
        expect(diagnostics[0]!.performance?.phases.backtestingMs).to.equal(60);
        expect(diagnostics[0]!.performance?.replay.targetCacheHits).to.equal(1);
        expect(diagnostics[0]!.actualEngineMode).to.equal("typescript");
        expect(diagnostics[0]!.requestedPairs).to.equal(2);
        expect(diagnostics[0]).to.not.have.property("result");
        expect(JSON.stringify(diagnostics[0]).length).to.be.lessThan(2_000);
        performance.phases.backtestingMs = 999;
        expect(diagnostics[0]!.performance?.phases.backtestingMs).to.equal(60);
        for (const index of [0, 1]) expect(order.indexOf(`logged:${index}`)).to.be.lessThan(order.indexOf(`removed:${index}`));
    });

    it("keeps diagnostic failures from skipping cleanup or stopping the sweep", async () => {
        let cleaned = 0;
        const results = await runFinderArmPerformance(makeInput(), {
            onProgress() {}, onCandidate() {}, setActiveCoordinator() {},
            async onCandidateDiagnostic() { throw new Error("log unavailable"); },
        }, {
            createCoordinator(request) {
                return makeCoordinator(request, {}, async (emit) => emit({ type: "done", result: makeSummary() }), []);
            },
            async removeChildArtifacts() { cleaned += 1; },
        });
        expect(results).to.have.length(2);
        expect(cleaned).to.equal(2);
    });

    it("evicts parsed shards when the production cleanup deletes a child", async () => {
        const root = await mkdtemp(join(tmpdir(), "finder-arm-cache-cleanup-"));
        const input = makeInput();
        input.baseDir = root;
        input.plans = input.plans!.slice(0, 1);
        let childRunId = "";
        try {
            await runFinderArmPerformance(input, {
                onProgress() {}, onCandidate() {}, setActiveCoordinator() {},
            }, {
                createCoordinator(request) {
                    childRunId = request.runId;
                    return makeCoordinator(request, {}, async (emit) => {
                        writeShardArtifacts(childRunId, 0, [{
                            schema: "compact_pair_artifact.v1", pairIndex: 0, symbol: "AAA+BBB",
                            baseAsset: "AAA", quoteAsset: "BBB", baseSymbol: "AAA", quoteSymbol: "BBB", trades: [],
                        }], root);
                        expect(await readShardArtifactsAsync(childRunId, 0, root)).to.not.equal(null);
                        emit({ type: "done", result: makeSummary() });
                    }, []);
                },
            });
            expect(existsSync(getRunDir(childRunId, root))).to.equal(false);
            expect(evictRunParsedShardCache(childRunId, root)).to.equal(0, "cleanup already removed cached entries");
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("runs configurations sequentially, retains compact all-arm rows, then cleans each child", async () => {
        const order: string[] = [];
        const candidates: any[] = [];
        let created = 0;
        const results = await runFinderArmPerformance(makeInput(), {
            onProgress: () => {},
            onCandidate: (candidate) => candidates.push(candidate),
            setActiveCoordinator: (coordinator, childRunId) => {
                order.push(`active:${childRunId ?? "none"}`);
                if (coordinator) expect(childRunId).to.be.a("string");
            },
        }, {
            createCoordinator(request) {
                const ordinal = created++;
                order.push(`create:${ordinal}`);
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, order);
            },
            async removeChildArtifacts(_childRunId, _baseDir) {
                order.push(`remove:${created - 1}`);
            },
        });

        expect(results).to.have.length(2);
        expect(candidates).to.have.length(2);
        const first = results[0]!;
        if (first.replayMode !== "horizon") throw new Error("expected horizon arm result");
        expect(first.pairCoverage).to.deep.equal({
            requestedPairs: 2,
            completedPairs: 2,
            failedPairs: 0,
            replayTargetLoadFailures: 0,
            noTradePairs: 0,
        });
        expect(first.metrics.TOP_RAW_PROFIT_NOW.topMean).to.equal(0.25);
        expect(first.metricsExTopContributor?.TOP_RAW_PROFIT_NOW?.topMean).to.equal(10);
        expect(first.contributorExclusions?.TOP_RAW_PROFIT_NOW).to.deep.equal({ asset: "AAA", events: 1 });
        expect(first.backtestSettings.exitStrategyOverrideEnabled).to.equal(false);
        expect(first.backtestSettings.exitStrategyKey).to.equal("");
        expect(first.backtestSettings.exitStrategyParams).to.deep.equal({});
        expect(order.indexOf("remove:0")).to.be.greaterThan(order.findIndex((item) => item.startsWith("teardown:")));
        expect(order.indexOf("create:1")).to.be.greaterThan(order.indexOf("remove:0"));
    });

    it("threads horizon-free switch requests and builds scalar switch-only candidates", async () => {
        const input = makeInput();
        input.options.armPerformance = { replayMode: "asset_switch", dateMode: "full" };
        const requests: TopMeanCoordinatorRunRequest[] = [];
        const cutoffTimes: number[] = [];
        const candidates: any[] = [];
        const results = await runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: (candidate) => candidates.push(candidate),
            setActiveCoordinator: () => {},
        }, {
            createCoordinator(request, _baseDir, deps) {
                requests.push(request);
                cutoffTimes.push(deps.evaluationNowSec!);
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSwitchSummary() });
                }, []);
            },
            async removeChildArtifacts() {},
        });

        expect(requests).to.have.length(2);
        expect(requests[0]?.replayMode).to.equal("asset_switch");
        expect(requests[0]?.horizons).to.equal(undefined);
        expect(requests[0]?.sampleToSec).to.equal(undefined);
        expect(cutoffTimes).to.deep.equal([input.evaluationCutoffSec, input.evaluationCutoffSec]);
        expect(results).to.have.length(2);
        expect(candidates[0]?.replayMode).to.equal("asset_switch");
        expect(candidates[0]).not.to.have.property("horizon");
        expect(candidates[0]).not.to.have.property("metrics");
        expect(candidates[0].assetSwitchMetrics.TOP_RAW.totalNetPnl).to.equal(4);
    });

    it("rejects a completed child that omits the switch result section", async () => {
        const input = makeInput();
        input.options.armPerformance = { replayMode: "asset_switch", dateMode: "full" };
        let error: unknown;
        try {
            await runFinderArmPerformance(input, {
                onProgress: () => {}, onCandidate: () => {}, setActiveCoordinator: () => {},
            }, {
                createCoordinator(request) {
                    return makeCoordinator(request, {}, async (emit) => {
                        emit({ type: "done", result: { ...makeSummary(), replayMode: "asset_switch", horizons: [] } });
                    }, []);
                },
                async removeChildArtifacts() {},
            });
        } catch (caught) {
            error = caught;
        }
        expect(error).to.be.instanceOf(FinderArmPerformanceChildError);
        expect((error as Error).message).to.contain("required asset-switch result section");
    });

    it("threads the effective cooldown through every Finder child coordinator request", async () => {
        const input = makeInput();
        input.options.armPerformance = {
            horizon: 5,
            dateMode: "full",
            selectionCooldownEnabled: true,
            selectionCooldownBars: 7,
        };
        const requests: TopMeanCoordinatorRunRequest[] = [];
        await runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: () => {},
        }, {
            createCoordinator(request) {
                requests.push(request);
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []);
            },
            async removeChildArtifacts() {},
        });
        expect(requests).to.have.length(2);
        expect(requests.map((request) => request.selectionCooldownBars)).to.deep.equal([7, 7]);
    });

    it("keeps prior rows and cleans the failed child before reporting a fatal child", async () => {
        const order: string[] = [];
        const candidates: any[] = [];
        let created = 0;
        let caught: unknown;
        try {
            await runFinderArmPerformance(makeInput(), {
                onProgress: () => {},
                onCandidate: (candidate) => candidates.push(candidate),
                setActiveCoordinator: () => {},
            }, {
                createCoordinator(request) {
                    const ordinal = created++;
                    return makeCoordinator(request, ordinal === 0 ? {} : { status: "failed" }, async (emit) => {
                        if (ordinal === 0) emit({ type: "done", result: makeSummary() });
                        else emit({ type: "fatal", error: "replay failed" });
                    }, order);
                },
                async removeChildArtifacts(_childRunId, _baseDir) {
                    order.push(`remove:${created - 1}`);
                },
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(FinderArmPerformanceChildError);
        expect((caught as Error).message).to.contain("replay failed");
        expect(candidates).to.have.length(1);
        expect(order).to.include("remove:1");
    });

    it("continues a candidate when some pairs are unavailable and retains their diagnostics", async () => {
        const order: string[] = [];
        const failures: any[] = [];
        const results = await runFinderArmPerformance(makeInput(), {
            onProgress: () => {},
            onCandidate: () => {},
            onPairFailures: (items) => failures.push(...items),
            setActiveCoordinator: () => {},
        }, {
            createCoordinator(request) {
                return {
                    ...makeCoordinator(request, { completedPairs: 1, failedPairs: 1 }, async (emit) => {
                        emit({ type: "done", result: { ...makeSummary(), replayTargetLoadFailureCount: 1 } });
                    }, order),
                    getFailedPairDetails: () => [{
                        pairIndex: 1,
                        symbol: "CCC+DDD",
                        error: "Insufficient candles or load failure",
                        failureKind: "missing_data" as const,
                    }],
                };
            },
            async removeChildArtifacts() {},
        });

        expect(results).to.have.length(2);
        expect(results[0]!.pairCoverage).to.deep.equal({
            requestedPairs: 2,
            completedPairs: 1,
            failedPairs: 1,
            replayTargetLoadFailures: 1,
            noTradePairs: 0,
        });
        expect(failures).to.have.length(2);
        expect(failures[0]).to.deep.equal({
            pairIndex: 1,
            symbol: "CCC+DDD",
            error: "Insufficient candles or load failure",
            failureKind: "missing_data",
        });
    });

    it("keeps actual backtest failures fatal even when another pair completed", async () => {
        const order: string[] = [];
        let caught: unknown;
        try {
            await runFinderArmPerformance(makeInput(), {
                onProgress: () => {},
                onCandidate: () => {},
                onPairFailures: () => {},
                setActiveCoordinator: () => {},
            }, {
                createCoordinator(request) {
                    return {
                        ...makeCoordinator(request, { completedPairs: 1, failedPairs: 1 }, async (emit) => {
                            emit({ type: "done", result: makeSummary() });
                        }, order),
                        getFailedPairDetails: () => [{
                            pairIndex: 1,
                            symbol: "CCC+DDD",
                            error: "strategy execution failed",
                            failureKind: "backtest" as const,
                        }],
                    };
                },
                async removeChildArtifacts() {},
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(FinderArmPerformanceChildError);
        expect((caught as Error).message).to.contain("Pair coverage failed (1/2 completed, 1 failed)");
    });

    it("does not retain a child after Stop and waits for worker teardown before cleanup", async () => {
        const controller = new AbortController();
        const order: string[] = [];
        const candidates: any[] = [];
        const diagnostics: FinderArmPerformanceCandidateDiagnostic[] = [];
        let caught: unknown;
        try {
            await runFinderArmPerformance(makeInput(controller.signal), {
                onProgress: () => {},
                onCandidate: (candidate) => candidates.push(candidate),
                onCandidateDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
                setActiveCoordinator: () => {},
            }, {
                createCoordinator(request) {
                    return makeCoordinator(request, {}, async (emit) => {
                        controller.abort();
                        emit({ type: "done", result: makeSummary() });
                    }, order);
                },
                async removeChildArtifacts() {
                    order.push("remove");
                },
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(FinderArmPerformanceChildError);
        expect((caught as Error).message).to.contain("interrupted");
        expect(candidates).to.have.length(0);
        expect(diagnostics.map((item) => item.outcome)).to.deep.equal(["cancelled"]);
        expect(order.indexOf("remove")).to.be.greaterThan(order.findIndex((item) => item.startsWith("teardown:")));
    });

    it("keeps the child Stop id routed through artifact cleanup so the next candidate cannot start", async () => {
        const controller = new AbortController();
        let trackedChildId: string | null = null;
        let created = 0;
        const candidates = await runFinderArmPerformance(makeInput(controller.signal), {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: (_coordinator, childRunId) => { trackedChildId = childRunId; },
        }, {
            createCoordinator(request) {
                created += 1;
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []);
            },
            async removeChildArtifacts() {
                expect(trackedChildId).to.be.a("string");
                // Models the parent abort callback called by the matching
                // /sp500-top-mean/stop request during child cleanup.
                controller.abort();
            },
        });

        expect(candidates).to.have.length(1);
        expect(created).to.equal(1);
        expect(trackedChildId).to.equal(null);
    });

    it("supplies the finder_arm execution profile and sweep context to child coordinators", async () => {
        const seenDeps: unknown[] = [];
        const input = makeInput();
        input.sampleFromSec = 1_700_000_000;
        input.sampleToSec = 1_730_000_000;
        await runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: () => {},
        }, {
            createCoordinator(_request, _baseDir, deps) {
                seenDeps.push(deps);
                return makeCoordinator(_request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []);
            },
            async removeChildArtifacts() {},
        });

        expect(seenDeps).to.have.length(2);
        for (const deps of seenDeps) {
            expect((deps as { executionProfile?: string }).executionProfile).to.equal("finder_arm");
            expect((deps as { enumeration?: { canonicalPairs: string[] } }).enumeration?.canonicalPairs.length).to.be.greaterThan(0);
            expect((deps as { evaluationNowSec?: number }).evaluationNowSec).to.equal(1_700_000_000);
        }
    });

    it("reuses one sweep-scoped worker pool across candidates and disposes it once at the end", async () => {
        let cancelCount = 0;
        let disposeCount = 0;
        // dispose() mirrors the real pool: it cancels internally.
        const fakePool = {
            cancel() { cancelCount += 1; },
            dispose: async () => { cancelCount += 1; disposeCount += 1; },
        } as unknown as TopMeanWorkerPool;
        const input = makeInput();
        input.enableWorkerReuse = true;
        const results = await runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: () => {},
        }, {
            createWorkerPool: () => fakePool,
            createCoordinator(request) {
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []);
            },
            async removeChildArtifacts() {},
        });

        expect(results).to.have.length(2);
        expect(disposeCount).to.equal(1);
        // Success path never cancels the pool mid-sweep; only dispose() does.
        expect(cancelCount).to.equal(1);
    });

    it("stops lending the pool after a failed candidate and still disposes it", async () => {
        let disposeCount = 0;
        const fakePool = {
            cancel() {},
            dispose: async () => { disposeCount += 1; },
        } as unknown as TopMeanWorkerPool;
        let created = 0;
        let caught: unknown;
        try {
            const input = makeInput();
            input.enableWorkerReuse = true;
            await runFinderArmPerformance(input, {
                onProgress: () => {},
                onCandidate: () => {},
                setActiveCoordinator: () => {},
            }, {
                createWorkerPool: () => fakePool,
                createCoordinator(request) {
                    created += 1;
                    return makeCoordinator(request, {}, async (emit) => {
                        if (created === 1) emit({ type: "done", result: makeSummary() });
                        else emit({ type: "fatal", error: "replay failed" });
                    }, []);
                },
                async removeChildArtifacts() {},
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(FinderArmPerformanceChildError);
        expect(created).to.equal(2);
        expect(disposeCount).to.equal(1);
    });

    it("drives a PROTOTYPE-BACKED coordinator through the sweep-stop adapter (P0)", async () => {
        // Regression: { ...coordinator } drops class prototype methods, so the
        // adapter must bind run/waitForTeardown/getStatus explicitly. This
        // coordinator keeps run() on the prototype like the real engine.
        const runCalls: string[] = [];
        class ProtoBackedCoordinator {
            constructor(private readonly inner: FinderArmPerformanceCoordinator) {}
            get request() { return this.inner.request; }
            run(emit: (event: unknown) => void): Promise<void> {
                runCalls.push("run");
                return this.inner.run(emit);
            }
            stop(): void { this.inner.stop(); }
            async waitForTeardown(): Promise<void> { return this.inner.waitForTeardown(); }
            getStatus() { return this.inner.getStatus(); }
        }
        const input = makeInput();
        input.enableWorkerReuse = true;
        const results = await runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: () => {},
        }, {
            createCoordinator(request) {
                return new ProtoBackedCoordinator(makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []));
            },
            async removeChildArtifacts() {},
        });

        expect(results).to.have.length(2);
        expect(runCalls).to.have.length(2);
    });

    it("cancels the borrowed pool when Stop lands in the artifact-cleanup gap (P2)", async () => {
        const controller = new AbortController();
        const events: string[] = [];
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        const input = makeInput(controller.signal);
        input.enableWorkerReuse = true;
        const fakePool = {
            cancel() { events.push("cancel"); },
            dispose: async () => { events.push("dispose"); },
        } as unknown as TopMeanWorkerPool;
        const sweep = runFinderArmPerformance(input, {
            onProgress: () => {},
            onCandidate: () => {},
            setActiveCoordinator: () => {},
        }, {
            createWorkerPool: () => fakePool,
            createCoordinator(request) {
                return makeCoordinator(request, {}, async (emit) => {
                    emit({ type: "done", result: makeSummary() });
                }, []);
            },
            async removeChildArtifacts() {
                events.push("cleanup-start");
                // Stop lands while cleanup is in flight: no active coordinator
                // exists, so only the runner's abort listener can cancel the
                // pool - and it must happen BEFORE cleanup resolves.
                controller.abort();
                await cleanupGate;
                events.push("cleanup-end");
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        releaseCleanup();
        await sweep;

        expect(events.indexOf("cancel")).to.be.greaterThanOrEqual(0);
        expect(events.indexOf("cancel")).to.be.lessThan(events.indexOf("cleanup-end"));
        expect(events[events.length - 1]).to.equal("dispose");
    });

    it("cancels the borrowed pool when parent Stop reaches the active coordinator", async () => {
        const controller = new AbortController();
        let cancelCount = 0;
        let disposeCount = 0;
        const fakePool = {
            cancel() { cancelCount += 1; },
            dispose: async () => { disposeCount += 1; },
        } as unknown as TopMeanWorkerPool;
        let caught: unknown;
        try {
            const input = makeInput(controller.signal);
            input.enableWorkerReuse = true;
            await runFinderArmPerformance(input, {
                onProgress: () => {},
                onCandidate: () => {},
                setActiveCoordinator: (coordinator) => {
                    // Models a TOP_MEAN child Stop (or Batch Stop delegating
                    // to Finder) arriving mid-child: it must reach the pool.
                    controller.abort();
                    coordinator?.stop();
                },
            }, {
                createWorkerPool: () => fakePool,
                createCoordinator(request) {
                    return makeCoordinator(request, {}, async (emit) => {
                        emit({ type: "done", result: makeSummary() });
                    }, []);
                },
                async removeChildArtifacts() {},
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(FinderArmPerformanceChildError);
        expect(cancelCount).to.be.greaterThan(0);
        expect(disposeCount).to.equal(1);
    });
});




