import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildAssetOpportunityCandidateFingerprint,
    buildAssetOpportunityForwardOosBaseline,
    buildAssetOpportunityNextExitOosBaseline,
    buildAssetOpportunityPairSummaries,
    buildAssetOpportunityMetadataPayload,
    buildAssetOpportunityPerformancePayload,
} from "../lib/finder/finder-asset-opportunity-metadata";
import type { FinderAssetOpportunityResult } from "../lib/types/finder";
import type { Time } from "../lib/types/strategies";

function makeAssetResult(overrides: Partial<FinderAssetOpportunityResult> = {}): FinderAssetOpportunityResult {
    const backtest = {
        trades: [],
        equityCurve: [],
        netProfit: 10,
        netProfitPercent: 1,
        winRate: 50,
        expectancy: 1,
        avgTrade: 1,
        profitFactor: 1.2,
        maxDrawdown: 2,
        maxDrawdownPercent: 1,
        totalTrades: 2,
        winningTrades: 1,
        losingTrades: 1,
        avgWin: 2,
        avgLoss: 1,
        sharpeRatio: 0.5,
    };
    return {
        symbol: "BTCUSDT",
        strategyKey: "momentum",
        strategyName: "Momentum",
        params: { lookback: 21 },
        exitStrategyKey: "trailing_exit",
        exitStrategyName: "Trailing Exit",
        exitStrategyParams: { trailPercent: 2 },
        historicalRank: 3,
        totalCandidatesEvaluated: 120,
        isHistoricalBest: false,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: 1_700_000_000 as Time,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: backtest,
        oosResult: { ...backtest, totalTrades: 1 },
        oosVerdict: "pass",
        oosHorizonMetrics: {
            ignoreLastBars: 5,
            horizons: [
                { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
            ],
        },
        support: {
            freshLongCandidates: 2,
            freshShortCandidates: 0,
            freshSameDirection: 2,
            poolSize: 10,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
        ...overrides,
    };
}

describe("Asset Opportunity metadata payload serializer", () => {
    it("serializes the full Copy Top Results shape with interval and strategy metadata", () => {
        const payload = buildAssetOpportunityMetadataPayload({
            result: makeAssetResult(),
            rank: 1,
            interval: "15m",
            strategyMetadata: { author: "tester" },
        });
        expect(payload).to.deep.equal({
            scope: "asset_opportunity",
            rank: 1,
            symbol: "BTCUSDT",
            strategyId: "momentum",
            strategyName: "Momentum",
            interval: "15m",
            params: { lookback: 21 },
            metadata: { author: "tester" },
            direction: "long",
            freshStatus: "fresh",
            latestSignalTime: 1_700_000_000,
            signalAgeBars: 0,
            fillTiming: "signal_close",
            historicalRank: 3,
            totalCandidatesEvaluated: 120,
            selectionMetrics: {
                trades: [],
                equityCurve: [],
                netProfit: 10,
                netProfitPercent: 1,
                winRate: 50,
                expectancy: 1,
                avgTrade: 1,
                profitFactor: 1.2,
                maxDrawdown: 2,
                maxDrawdownPercent: 1,
                totalTrades: 2,
                winningTrades: 1,
                losingTrades: 1,
                avgWin: 2,
                avgLoss: 1,
                sharpeRatio: 0.5,
            },
            support: {
                freshLongCandidates: 2,
                freshShortCandidates: 0,
                freshSameDirection: 2,
                poolSize: 10,
                bestFreshRank: 1,
                directionAgreementRatio: 1,
            },
            grade: "select",
            oos: {
                metrics: {
                    trades: [],
                    equityCurve: [],
                    netProfit: 10,
                    netProfitPercent: 1,
                    winRate: 50,
                    expectancy: 1,
                    avgTrade: 1,
                    profitFactor: 1.2,
                    maxDrawdown: 2,
                    maxDrawdownPercent: 1,
                    totalTrades: 1,
                    winningTrades: 1,
                    losingTrades: 1,
                    avgWin: 2,
                    avgLoss: 1,
                    sharpeRatio: 0.5,
                },
                verdict: "pass",
            },
            oosHorizonMetrics: {
                ignoreLastBars: 5,
                horizons: [
                    { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                ],
            },
            oosNextExitMetrics: null,
            exitStrategy: {
                key: "trailing_exit",
                name: "Trailing Exit",
                params: { trailPercent: 2 },
            },
        });
    });

    it("nulls missing OOS, strategy metadata, and exit strategy fields", () => {
        const result = makeAssetResult({
            oosResult: undefined,
            oosVerdict: undefined,
            oosHorizonMetrics: undefined,
            exitStrategyKey: undefined,
            exitStrategyName: undefined,
            exitStrategyParams: undefined,
        });
        const payload = buildAssetOpportunityMetadataPayload({
            result,
            rank: 2,
            interval: "5m",
            strategyMetadata: undefined,
        });
        expect(payload.metadata).to.equal(null);
        expect(payload.oos).to.equal(null);
        expect(payload.oosHorizonMetrics).to.equal(null);
        expect(payload.exitStrategy).to.equal(null);
    });

    it("builds a compact performance-only archive row", () => {
        const payload = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult(),
            rank: 1,
        });
        expect(payload).to.deep.equal({
            scope: "asset_opportunity",
            rank: 1,
            symbol: "BTCUSDT",
            strategyId: "momentum",
            strategyName: "Momentum",
            candidateFingerprint: buildAssetOpportunityCandidateFingerprint(makeAssetResult()),
            signalCandleHourUtc: 22,
            signalCandleHourJakarta: 5,
            selectionPerformance: {
                netProfit: 10,
                netProfitPercent: 1,
                winRate: 50,
                expectancy: 1,
                avgTrade: 1,
                profitFactor: 1.2,
                maxDrawdown: 2,
                maxDrawdownPercent: 1,
                totalTrades: 2,
                winningTrades: 1,
                losingTrades: 1,
                avgWin: 2,
                avgLoss: 1,
                sharpeRatio: 0.5,
            },
            oosPerformance: {
                verdict: "pass",
                metrics: {
                    netProfit: 10,
                    netProfitPercent: 1,
                    winRate: 50,
                    expectancy: 1,
                    avgTrade: 1,
                    profitFactor: 1.2,
                    maxDrawdown: 2,
                    maxDrawdownPercent: 1,
                    totalTrades: 1,
                    winningTrades: 1,
                    losingTrades: 1,
                    avgWin: 2,
                    avgLoss: 1,
                    sharpeRatio: 0.5,
                },
            },
            forwardOosPerformance: {
                ignoreLastBars: 5,
                horizons: [
                    { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                ],
            },
            nextExitOosPerformance: null,
        });
        expect(JSON.stringify(payload)).to.not.contain("lookback");
        expect(JSON.stringify(payload)).to.not.contain("trades");
        expect(JSON.stringify(payload)).to.not.contain("equityCurve");
    });

    it("persists medianBarsToTp when present and leaves legacy rows missing", () => {
        const withMetric = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult({ medianBarsToTp: 4.5 }),
            rank: 1,
        });
        expect(withMetric.selectionPerformance.medianBarsToTp).to.equal(4.5);

        const legacy = buildAssetOpportunityPerformancePayload({
            result: makeAssetResult(),
            rank: 1,
        });
        expect(Object.prototype.hasOwnProperty.call(legacy.selectionPerformance, "medianBarsToTp")).to.equal(false);
        expect(legacy.selectionPerformance.medianBarsToTp).to.not.equal(0);
    });

    it("ranks are passed through 1-based per displayed row", () => {
        const rows = [makeAssetResult(), makeAssetResult({ symbol: "ETHUSDT" })];
        const payloads = rows.map((result, index) => buildAssetOpportunityMetadataPayload({
            result,
            rank: index + 1,
            interval: "1d",
            strategyMetadata: null,
        }));
        expect(payloads.map((payload) => payload.rank)).to.deep.equal([1, 2]);
    });

    it("builds a baseline from all available result rows before top-N slicing", () => {
        const baseline = buildAssetOpportunityForwardOosBaseline([
            makeAssetResult(),
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetrics: {
                    ignoreLastBars: 5,
                    horizons: [
                        { bars: 1, pnlPercent: -2, averagePnlPercent: -2, winRatePercent: 0, sampleSize: 1 },
                    ],
                },
            }),
        ]);
        expect(baseline.eligibleCandidateCount).to.equal(2);
        expect(baseline.horizons).to.deep.equal([{
            bars: 1,
            averagePnlPercent: -0.5,
            sampleWeightedAveragePnlPercent: -0.5,
            positiveResults: 1,
            observedResults: 2,
            totalSamples: 2,
        }]);
    });

    it("keeps next-exit archive metrics separate from fixed horizons", () => {
        const result = makeAssetResult({
            oosHorizonMetrics: undefined,
            oosNextExitMetrics: {
                ignoreLastBars: 5,
                status: "exited",
                pnlPercent: 1.5,
                exitReason: "take_profit",
                unavailableReason: null,
                barsHeld: 2,
                exitTime: 1_700_000_600 as Time,
            },
        });
        const payload = buildAssetOpportunityPerformancePayload({ result, rank: 1 });
        expect(payload.forwardOosPerformance).to.equal(null);
        expect(payload.nextExitOosPerformance).to.deep.equal(result.oosNextExitMetrics);
        expect(buildAssetOpportunityNextExitOosBaseline([
            result,
            makeAssetResult({
                symbol: "ETHUSDT",
                oosHorizonMetrics: undefined,
                oosNextExitMetrics: {
                    ignoreLastBars: 5,
                    status: "censored",
                    pnlPercent: null,
                    exitReason: "end_of_data",
                    unavailableReason: null,
                    barsHeld: 5,
                    exitTime: 1_700_001_500 as Time,
                },
            }),
            makeAssetResult({
                symbol: "BTCUSDT",
                oosHorizonMetrics: undefined,
                oosNextExitMetrics: {
                    ignoreLastBars: 5,
                    status: "unavailable",
                    pnlPercent: null,
                    exitReason: null,
                    unavailableReason: "no_boundary_trade",
                    barsHeld: null,
                    exitTime: null,
                },
            }),
        ])).to.deep.equal({
            eligibleCandidateCount: 3,
            observedExits: 1,
            censoredResults: 1,
            unavailableResults: 1,
            averagePnlPercent: 1.5,
            exitReasonCounts: { take_profit: 1, end_of_data: 1 },
            unavailableReasonCounts: { no_boundary_trade: 1 },
        });
    });

    it("builds sorted per-symbol summaries and keeps forward metrics target-only", () => {
        expect(buildAssetOpportunityPairSummaries([])).to.deep.equal([]);

        const base = makeAssetResult();
        const result = (overrides: Partial<FinderAssetOpportunityResult>): FinderAssetOpportunityResult => ({
            ...base,
            ...overrides,
            selectionResult: {
                ...base.selectionResult,
                ...(overrides.selectionResult ?? {}),
            },
        });
        const summaries = buildAssetOpportunityPairSummaries([
            result({
                symbol: "PAIR_B",
                selectionResult: { ...base.selectionResult, netProfit: 5, netProfitPercent: 5, avgTrade: 2 },
                oosHorizonMetrics: undefined,
            }),
            result({
                symbol: "PAIR_B",
                selectionResult: { ...base.selectionResult, netProfit: 5, netProfitPercent: 5, avgTrade: 2 },
                oosHorizonMetrics: undefined,
            }),
            result({
                symbol: "PAIR_A",
                selectionResult: { ...base.selectionResult, netProfit: 10, netProfitPercent: 10, avgTrade: 3 },
                oosHorizonMetrics: {
                    ignoreLastBars: 12,
                    horizons: [
                        { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                        { bars: 3, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
                    ],
                },
            }),
            result({
                symbol: "PAIR_A",
                selectionResult: { ...base.selectionResult, netProfit: -2, netProfitPercent: 20, avgTrade: 1 },
                oosHorizonMetrics: {
                    ignoreLastBars: 12,
                    horizons: [
                        { bars: 1, pnlPercent: 3, averagePnlPercent: 3, winRatePercent: 100, sampleSize: 1 },
                        { bars: 3, pnlPercent: null, averagePnlPercent: Number.NaN, winRatePercent: null, sampleSize: 1 },
                    ],
                },
            }),
            result({
                symbol: "PAIR_A",
                selectionResult: { ...base.selectionResult, netProfit: 0, netProfitPercent: Number.NaN, avgTrade: Number.POSITIVE_INFINITY },
                oosHorizonMetrics: undefined,
            }),
        ]);

        expect(summaries).to.have.length(2);
        expect(summaries[0]).to.deep.include({
            symbol: "PAIR_A",
            candidateCount: 3,
            profitableShare: 1 / 3,
            medianNetProfitPercent: 15,
            netProfitP75MinusP25: 5,
            medianExpectancy: 2,
            topNetProfit: 10,
        });
        expect(summaries[0]!.forwardPnlPercentByHorizon).to.deep.equal({ 1: 2, 3: null });
        expect(summaries[1]).to.deep.include({
            symbol: "PAIR_B",
            candidateCount: 2,
            profitableShare: 1,
            medianNetProfitPercent: 5,
            netProfitP75MinusP25: 0,
            medianExpectancy: 2,
            topNetProfit: 5,
        });
        expect(summaries[1]!.forwardPnlPercentByHorizon).to.deep.equal({ 1: null, 3: null });
    });
});

