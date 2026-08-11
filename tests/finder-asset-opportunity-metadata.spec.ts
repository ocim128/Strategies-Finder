import { expect } from "chai";
import { describe, it } from "node:test";
import {
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
        });
        expect(JSON.stringify(payload)).to.not.contain("lookback");
        expect(JSON.stringify(payload)).to.not.contain("trades");
        expect(JSON.stringify(payload)).to.not.contain("equityCurve");
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
});
