import { expect } from "chai";
import { createEmptyRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import { REPLAY_ARM_FIELDS } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { describe, it } from "node:test";
import {
    FINDER_RESULT_SNAPSHOT_LIMIT,
    compactFinderLatestResults,
    normalizeFinderLatestResultsSnapshot,
} from "../lib/finder/finder-result-snapshot";
import { FINDER_ARM_PERFORMANCE_REPLAY_FIELDS } from "../lib/finder/finder-arm-performance-metrics";
import { toScalarArmPerformanceCandidate } from "../lib/finder/server/finder-stream-types";
import type { FinderArmPerformanceCandidate, FinderAssetOpportunityResult, FinderLatestResults, FinderResult, FinderUniverseCandidate } from "../lib/types/finder";
import type { BacktestResult, Time } from "../lib/types/strategies";
import type { AssetSwitchArmSummary } from "../lib/batch-backtest/open-score-replay/types";

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades: [{ entryTime: 1, exitTime: 2 } as any],
        netProfit: 100,
        netProfitPercent: 10,
        winRate: 60,
        expectancy: 2,
        avgTrade: 1,
        profitFactor: 1.5,
        maxDrawdown: 25,
        maxDrawdownPercent: 5,
        totalTrades: 10,
        winningTrades: 6,
        losingTrades: 4,
        avgWin: 5,
        avgLoss: 3,
        sharpeRatio: 1.2,
        equityCurve: [{ time: 1 as Time, value: 1000 }],
        ...overrides,
    };
}

function makeFinderResult(index: number): FinderResult {
    return {
        key: `strategy_${index}`,
        name: `Strategy ${index}`,
        params: { lookback: index },
        result: makeBacktestResult({ netProfit: index }),
        selectionResult: makeBacktestResult({ netProfit: index }),
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

function makeUniverseCandidate(index: number): FinderUniverseCandidate {
    return {
        strategyKey: `strategy_${index}`,
        strategyName: `Strategy ${index}`,
        params: { lookback: index },
        symbols: Array.from({ length: 250 }, (_, symbolIndex) => ({
            symbol: `SYM${symbolIndex}`,
            status: "profitable",
            barCount: 100,
            result: {
                netProfit: symbolIndex,
                netProfitPercent: 1,
                expectancy: 1,
                avgTrade: 1,
                winRate: 55,
                profitFactor: 1.2,
                totalTrades: 5,
                maxDrawdownPercent: 2,
                winningTrades: 3,
                losingTrades: 2,
                avgWin: 4,
                avgLoss: 2,
                sharpeRatio: 0.8,
            },
        })),
        activeSymbols: 250,
        profitableSymbols: 250,
        losingSymbols: 0,
        flatSymbols: 0,
        noTradeSymbols: 0,
        totalTrades: 1250,
        profitableActiveRatio: 1,
        averageWinRate: 68,
        tradeWeightedWinRate: 71.2,
        winReliabilityQ25: 58.4,
        medianExpectancy: 1,
        medianSharpe: 0.8,
        medianSharpeAvailable: false,
        medianProfitFactor: 1.2,
        medianNetProfit: 10,
        worstNetProfit: 1,
        bestNetProfit: 100,
        medianCompositeEdgeRatio: 0,
        drawdownMetricsAvailable: true,
        worstMaxDrawdownPercent: 4,
        medianMaxDrawdownPercent: 2,
        medianReturnDrawdownRatio: 0.5,
        robustUniverseScore: 90,
        windowStabilityScore: 0,
    };
}

function makeAssetOpportunityResult(index: number): FinderAssetOpportunityResult {
    return {
        symbol: `ASSET${index}`,
        strategyKey: "strategy_1",
        strategyName: "Strategy 1",
        params: { lookback: index },
        historicalRank: 1,
        totalCandidatesEvaluated: 10,
        isHistoricalBest: true,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: 100 as Time,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: makeBacktestResult(),
        medianBarsToTp: 3.5,
        support: {
            freshLongCandidates: 2,
            freshShortCandidates: 0,
            freshSameDirection: 2,
            poolSize: 10,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
    };
}

function makeArmPerformanceCandidate(index: number): FinderArmPerformanceCandidate {
    const metrics = Object.fromEntries(Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => [arm, {
        events: 1,
        topMean: index,
        randomMean: 0,
        delta: index,
        topMedian: index,
        ciLower: index,
        ciUpper: index,
        positiveBlocks: 1,
        totalBlocks: 1,
        blockMeans: [index],
        eventDetails: [{ trade: true }],
    }]));
    return {
        candidateId: `arm-${index}`,
        candidateOrdinal: index,
        strategyKey: "strategy_1",
        strategyName: "Strategy 1",
        replayMode: "horizon",
        horizon: 5,
        params: { lookback: index },
        backtestSettings: { executionModel: "signal_close" },
        pairCoverage: {
            requestedPairs: 500,
            completedPairs: 500,
            failedPairs: 0,
            replayTargetLoadFailures: 0,
            noTradePairs: 2,
        },
        metrics: metrics as unknown as NonNullable<FinderArmPerformanceCandidate["metrics"]>,
        metricsExTopContributor: metrics as FinderArmPerformanceCandidate["metricsExTopContributor"],
        contributorExclusions: Object.fromEntries(Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => [arm, {
            asset: "AAA",
            events: 1,
        }])) as FinderArmPerformanceCandidate["contributorExclusions"],
        requestedEngineMode: "typescript",
        actualEngineMode: "typescript",
    };
}

function makeSwitchArmSummary(status: AssetSwitchArmSummary["status"] = "complete"): AssetSwitchArmSummary {
    return {
        status,
        enteredCount: status === "no_entry" ? 0 : 1,
        completedTrades: 0,
        realizedNetPnl: status === "no_entry" ? null : 0,
        openPositionNetPnl: status === "no_entry" ? null : -2,
        totalNetPnl: status === "complete" ? -2 : null,
        partialRealizedNetPnl: 0,
        completedHoldingDurationSec: 0,
        averageCompletedHoldingDurationSec: null,
        totalCosts: 1,
        openPosition: null,
        pendingOrder: null,
        diagnosticCounts: {
            missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0,
            dataGap: 0, staleMark: 0, unvaluedPosition: 0,
        },
    };
}

describe("Finder result snapshots", () => {
    it("keeps current-chart snapshots bounded and strips heavy backtest arrays", () => {
        const compact = compactFinderLatestResults({
            scope: "current_chart",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeFinderResult(index)),
        });

        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.scope).to.equal("current_chart");
        if (compact.scope !== "current_chart") throw new Error("unexpected scope");
        expect(compact.results[0]!.result.trades).to.deep.equal([]);
        expect(compact.results[0]!.result.equityCurve).to.deep.equal([]);
        expect(compact.results[0]!.selectionResult.netProfit).to.equal(0);
    });

    it("keeps universe snapshots bounded at result and symbol levels", () => {
        const compact = compactFinderLatestResults({
            scope: "symbol_universe",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeUniverseCandidate(index)),
        });

        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.scope).to.equal("symbol_universe");
        if (compact.scope !== "symbol_universe") throw new Error("unexpected scope");
        expect(compact.results[0]!.symbols).to.have.length(200);
    });

    it("rejects malformed snapshots", () => {
        expect(normalizeFinderLatestResultsSnapshot(null)).to.equal(null);
        expect(normalizeFinderLatestResultsSnapshot({ scope: "current_chart" })).to.equal(null);
        expect(normalizeFinderLatestResultsSnapshot({ scope: "other", results: [] })).to.equal(null);
    });

    it("normalizes valid snapshots through the same compact path", () => {
        const normalized = normalizeFinderLatestResultsSnapshot({
            scope: "current_chart",
            results: [makeFinderResult(1)],
        }) as FinderLatestResults;

        expect(normalized.scope).to.equal("current_chart");
        if (normalized.scope !== "current_chart") throw new Error("unexpected scope");
        expect(normalized.results[0]!.result.trades).to.deep.equal([]);
    });

    it("keeps asset-opportunity snapshots scalar and bounded", () => {
        const compact = compactFinderLatestResults({
            scope: "asset_opportunity",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => ({
                ...makeAssetOpportunityResult(index),
                oosHorizonMetrics: {
                    ignoreLastBars: 20,
                    horizons: [
                        { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                        { bars: 3, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
                        { bars: 5, pnlPercent: -2, averagePnlPercent: -2, winRatePercent: 0, sampleSize: 1 },
                    ],
                },
                oosNextExitMetrics: {
                    ignoreLastBars: 20,
                    status: "censored",
                    pnlPercent: null,
                    exitReason: "end_of_data",
                    unavailableReason: null,
                    barsHeld: 4,
                    exitTime: 200 as Time,
                },
            })),
        });

        expect(compact.scope).to.equal("asset_opportunity");
        if (compact.scope !== "asset_opportunity") throw new Error("unexpected scope");
        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.results[0]!.selectionResult.trades).to.deep.equal([]);
        expect(compact.results[0]!.selectionResult.equityCurve).to.deep.equal([]);
        expect(compact.results[0]!.medianBarsToTp).to.equal(3.5);
        expect(compact.results[0]!.oosHorizonMetrics?.ignoreLastBars).to.equal(20);
        expect(compact.results[0]!.oosHorizonMetrics?.horizons[2]?.pnlPercent).to.equal(-2);
        expect(compact.results[0]!.oosNextExitMetrics).to.deep.equal({
            ignoreLastBars: 20,
            status: "censored",
            pnlPercent: null,
            exitReason: "end_of_data",
            unavailableReason: null,
            barsHeld: 4,
            exitTime: 200,
        });
    });

    it("defaults new drawdown aggregates when restoring an older universe snapshot", () => {
        const legacyCandidate = makeUniverseCandidate(1) as unknown as Record<string, unknown>;
        delete legacyCandidate.drawdownMetricsAvailable;
        delete legacyCandidate.worstMaxDrawdownPercent;
        delete legacyCandidate.medianMaxDrawdownPercent;
        delete legacyCandidate.medianReturnDrawdownRatio;

        const normalized = normalizeFinderLatestResultsSnapshot({
            scope: "symbol_universe",
            results: [legacyCandidate],
        });

        expect(normalized?.scope).to.equal("symbol_universe");
        if (!normalized || normalized.scope !== "symbol_universe") throw new Error("unexpected scope");
        expect(normalized.results[0]!.drawdownMetricsAvailable).to.equal(false);
        expect(normalized.results[0]!.worstMaxDrawdownPercent).to.equal(0);
        expect(normalized.results[0]!.medianMaxDrawdownPercent).to.equal(0);
        expect(normalized.results[0]!.medianReturnDrawdownRatio).to.equal(0);
    });

    it("round-trips scalar ranking sections in both modes and preserves return data for unknown or malformed semantics", () => {
        for (const replayMode of ["horizon", "asset_switch"] as const) {
            const original = makeArmPerformanceCandidate(0);
            const ranking = createEmptyRankingMeasurement(20);
            Object.assign(ranking.arms.topRaw, { scoredEvents: 100, eligibleEvents: 100, comparisons: 1000, meanAccuracy: 0.6, top1Superiority: 0.65,
                ciLower: 0.5, ciUpper: 0.7, blockCount: 12, measurementWindowSec: 10, timeBlockWidthSec: 20, timeCoverageSec: 250, soleFirstPlaceCount: 20, sharedFirstPlaceCount: 10, soleFirstPlaceRate: 0.2, sharedFirstPlaceRate: 0.1, status: "available" });
            const candidate = replayMode === "horizon" ? { ...original, rankingMeasurement: ranking } : {
                ...original, replayMode, horizon: undefined, metrics: undefined, rankingMeasurement: ranking,
                assetSwitchMetrics: Object.fromEntries(Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => [arm, makeSwitchArmSummary()])),
            } as FinderArmPerformanceCandidate;
            Object.assign(ranking, { eventRows: [{ candles: [1, 2] }] });
            Object.assign(ranking.arms.topRaw, { eventRows: [1, 2, 3] });
            const scalar = toScalarArmPerformanceCandidate(candidate);
            expect(scalar.rankingMeasurement).not.to.have.property("eventRows");
            expect(scalar.rankingMeasurement?.arms.topRaw).not.to.have.property("eventRows");
            const restored = normalizeFinderLatestResultsSnapshot({ scope: "arm_performance", results: [scalar], runContext: null, inventoryComplete: true });
            if (restored?.scope !== "arm_performance") throw new Error("missing snapshot");
            expect(restored.results[0]!.rankingMeasurement).to.deep.equal(scalar.rankingMeasurement);
            expect(restored.results[0]!.rankingMeasurement?.arms.topRaw).to.include({ soleFirstPlaceCount: 20, sharedFirstPlaceCount: 10, soleFirstPlaceRate: 0.2, sharedFirstPlaceRate: 0.1 });
            const missingFrequencies = structuredClone(scalar.rankingMeasurement!);
            delete missingFrequencies.arms.topRaw.soleFirstPlaceCount; delete missingFrequencies.arms.topRaw.sharedFirstPlaceCount;
            delete missingFrequencies.arms.topRaw.soleFirstPlaceRate; delete missingFrequencies.arms.topRaw.sharedFirstPlaceRate;
            const oldV2 = normalizeFinderLatestResultsSnapshot({ scope: "arm_performance", results: [{ ...scalar, rankingMeasurement: missingFrequencies }], runContext: null });
            if (oldV2?.scope !== "arm_performance") throw new Error("legacy v2 result lost");
            expect(oldV2.results[0]!.rankingMeasurement).to.deep.equal(missingFrequencies);
            expect(oldV2.results[0]!.rankingMeasurement?.arms.topRaw).not.to.have.property("soleFirstPlaceCount");
            expect(oldV2.results[0]!.metrics ?? oldV2.results[0]!.assetSwitchMetrics).to.deep.equal(scalar.metrics ?? scalar.assetSwitchMetrics);
            for (const bad of [
                { ...ranking, semanticsVersion: "future-v3" },
                { ...ranking, semanticsVersion: "top-five-ranking-v1" },
                { ...ranking, arms: { ...ranking.arms, topRaw: { ...ranking.arms.topRaw, timeBlockWidthSec: 1 } } },
                { ...ranking, arms: { ...ranking.arms, topRaw: { ...ranking.arms.topRaw, blockCount: 9 } } },
                { ...ranking, horizonBars: -1 },
                { ...ranking, arms: { ...ranking.arms, topRaw: { ...ranking.arms.topRaw, meanAccuracy: NaN } } },
                { ...ranking, arms: { ...ranking.arms, topRaw: { ...ranking.arms.topRaw, ciLower: 2 } } },
                { ...ranking, arms: Object.fromEntries(REPLAY_ARM_FIELDS.slice(1).map((field) => [field, ranking.arms[field]])) },
            ]) {
                const legacy = normalizeFinderLatestResultsSnapshot({ scope: "arm_performance", results: [{ ...scalar, rankingMeasurement: bad }], runContext: null });
                if (legacy?.scope !== "arm_performance") throw new Error("original data lost");
                expect(legacy.results[0]!.rankingMeasurement).to.equal(undefined);
                expect(legacy.results[0]!.replayMode).to.equal(replayMode);
                expect(legacy.results[0]!.metrics ?? legacy.results[0]!.assetSwitchMetrics).to.deep.equal(scalar.metrics ?? scalar.assetSwitchMetrics);
            }
        }
    });

    it("restores Arm Performance only as a bounded incomplete preview", () => {
        const runContext = {
            runId: "arm-run",
            startedAt: 1,
            strategyKeys: ["strategy_1"],
            pairs: ["AAA+BBB"],
            interval: "4h",
            horizon: 5,
            dateMode: "full" as const,
            evaluationCutoffSec: 100,
            plannedCandidateCount: 30,
            actualEngineModes: ["typescript"],
            capTiltWeight: "off" as const,
            searchOptions: { mode: "random" } as any,
            backtestSettings: {} as any,
            uiBacktestSettings: { riskSettingsToggle: true, stopLossEnabled: true, takeProfitEnabled: true } as any,
            capitalSettings: {} as any,
            requestedEngineMode: "typescript" as const,
        };
        const rows = Array.from({ length: 30 }, (_, index) => makeArmPerformanceCandidate(index));
        Object.assign(rows[0]!, {
            data: [{ close: 10 }],
            signals: ["buy"],
            trades: [{ pnl: 1 }],
            eventDetails: [{ asset: "AAA" }],
            poolSnapshots: [{ asset: "AAA" }],
            candidateOutcomes: [{ asset: "AAA" }],
        });
        const compact = compactFinderLatestResults({
            scope: "arm_performance",
            results: rows,
            runContext,
            inventoryComplete: true,
        });

        expect(compact.scope).to.equal("arm_performance");
        if (compact.scope !== "arm_performance") throw new Error("unexpected scope");
        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.inventoryComplete).to.equal(false);
        expect(compact.runContext?.pairs).to.deep.equal(["AAA+BBB"]);
        expect(compact.runContext?.uiBacktestSettings?.riskSettingsToggle).to.equal(true);
        const compactRow = compact.results[0]!;
        if (compactRow.replayMode !== "horizon") throw new Error("expected horizon candidate");
        expect(compactRow.metrics.TOP_RAW_PROFIT_NOW).not.to.have.property("blockMeans");
        expect(compactRow.metrics.TOP_RAW_PROFIT_NOW).not.to.have.property("eventDetails");
        expect(compact.results[0]!.metricsExTopContributor?.TOP_RAW_PROFIT_NOW?.events).to.equal(1);
        expect(compact.results[0]!.contributorExclusions?.TOP_RAW_PROFIT_NOW).to.deep.equal({ asset: "AAA", events: 1 });
        expect(Object.keys(compact.results[0]!)).not.to.include.members([
            "data", "signals", "trades", "eventDetails", "poolSnapshots", "candidateOutcomes",
        ]);

        const wireCandidate = toScalarArmPerformanceCandidate(rows[0]! as any);
        if (wireCandidate.replayMode !== "horizon") throw new Error("expected horizon wire candidate");
        expect(Object.keys(wireCandidate)).not.to.include.members([
            "data", "signals", "trades", "eventDetails", "poolSnapshots", "candidateOutcomes",
        ]);
        expect(wireCandidate.metrics.TOP_RAW_PROFIT_NOW).not.to.have.property("blockMeans");

        const restored = normalizeFinderLatestResultsSnapshot(compact);
        expect(restored?.scope).to.equal("arm_performance");
        if (!restored || restored.scope !== "arm_performance") throw new Error("unexpected restored scope");
        expect(restored.inventoryComplete).to.equal(false);
        expect(restored.runContext?.uiBacktestSettings?.stopLossEnabled).to.equal(true);
        expect(restored.results[0]!.metricsExTopContributor?.TOP_RAW_PROFIT_NOW?.topMean).to.equal(0);
        expect(normalizeFinderLatestResultsSnapshot({
            ...compact,
            results: [{ ...compact.results[0], metrics: {} }],
        })).to.equal(null);
    });

    it("restores older Arm Performance snapshots without inventing adjusted metrics", () => {
        const legacy = makeArmPerformanceCandidate(1) as unknown as Record<string, unknown>;
        delete legacy.metricsExTopContributor;
        delete legacy.contributorExclusions;
        const restored = normalizeFinderLatestResultsSnapshot({
            scope: "arm_performance",
            results: [legacy],
            runContext: null,
            inventoryComplete: false,
        });

        expect(restored?.scope).to.equal("arm_performance");
        if (!restored || restored.scope !== "arm_performance") throw new Error("unexpected restored scope");
        expect(restored.results[0]!.metricsExTopContributor).to.equal(undefined);
        expect(restored.results[0]!.contributorExclusions).to.equal(undefined);
    });

    it("round-trips switch summaries without horizon comparison fields and rejects unknown or mixed modes", () => {
        const { horizon: _horizon, metrics: _metrics, metricsExTopContributor: _adjusted, contributorExclusions: _exclusions, ...base } = makeArmPerformanceCandidate(7);
        const switchCandidate = {
            ...base,
            replayMode: "asset_switch" as const,
            assetSwitchMetrics: Object.fromEntries(
                Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => [arm, makeSwitchArmSummary()]),
            ),
        } as FinderArmPerformanceCandidate;
        const compact = compactFinderLatestResults({
            scope: "arm_performance",
            results: [switchCandidate],
            runContext: null,
            inventoryComplete: true,
        });
        if (compact.scope !== "arm_performance") throw new Error("expected Arm Performance snapshot");
        const compactRow = compact.results[0]!;
        expect(compactRow.replayMode).to.equal("asset_switch");
        expect(compactRow).not.to.have.property("horizon");
        expect(compactRow).not.to.have.property("metrics");
        expect(compactRow).not.to.have.property("metricsExTopContributor");
        const restored = normalizeFinderLatestResultsSnapshot(compact);
        if (!restored || restored.scope !== "arm_performance") throw new Error("expected restored Arm Performance snapshot");
        expect(restored.results[0]!.replayMode).to.equal("asset_switch");
        expect(restored.results[0]!.assetSwitchMetrics?.TOP_RAW.totalNetPnl).to.equal(-2);

        const legacy = makeArmPerformanceCandidate(8) as unknown as Record<string, unknown>;
        delete legacy.replayMode;
        const restoredLegacy = normalizeFinderLatestResultsSnapshot({ scope: "arm_performance", results: [legacy] });
        if (!restoredLegacy || restoredLegacy.scope !== "arm_performance") throw new Error("expected legacy Arm Performance snapshot");
        expect(restoredLegacy.results[0]!.replayMode).to.equal("horizon");

        expect(normalizeFinderLatestResultsSnapshot({
            scope: "arm_performance",
            results: [{ ...compactRow, replayMode: "future_mode" }],
        })).to.equal(null);
        expect(normalizeFinderLatestResultsSnapshot({
            scope: "arm_performance",
            results: [compactRow, legacy],
        })).to.equal(null);
    });
});
