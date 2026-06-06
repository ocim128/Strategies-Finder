import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildBacktestPolymarketPerformanceSummary,
    rankPolymarketFeatureSuggestions,
    resolvePolymarketSelectedEntryOffset,
} from "../lib/polymarket-diagnostics-utils";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import type { PolymarketFeatureAnalysis } from "../lib/types/polymarket-outcomes";

function makeTrade(id: number, entryOffset?: number): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 60,
        entryPrice: 30_000,
        exitTime: 1_700_000_060 + id * 60,
        exitPrice: 30_100,
        pnl: 5,
        pnlPercent: 0.5,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: entryOffset === undefined ? null : {
            eventStartTs: 1_700_000_000 + id * 300,
            eventEndTs: 1_700_000_300 + id * 300,
            eventSlug: `event-${id}`,
            marketSlug: `market-${id}`,
            prediction: "yes",
            actualOutcomeUp: 1,
            isWin: true,
            marketEntryPrice: 0.45,
            entryOffset,
        },
    };
}

function makeResult(trades: Trade[], entryOffset?: number): BacktestResult {
    return {
        trades,
        netProfit: trades.reduce((sum, trade) => sum + trade.pnl, 0),
        netProfitPercent: 0,
        winRate: 100,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: trades.length,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        polymarketTradeSummary: entryOffset === undefined ? undefined : {
            seriesId: "btc-5m",
            outcomeRowsLoaded: 1,
            scoredTrades: trades.length,
            missingOutcomeTrades: 0,
            unscoredTrades: 0,
            entryOffset,
        },
    };
}

function makeFeature(
    label: string,
    overrides: Partial<PolymarketFeatureAnalysis>
): PolymarketFeatureAnalysis {
    return {
        feature: "rsi",
        label,
        winStats: { mean: 60, median: 60, stddev: 5, count: 6 },
        lossStats: { mean: 45, median: 45, stddev: 5, count: 6 },
        separationScore: 0.5,
        suggestedFilter: { direction: "above", threshold: 50 },
        winRateIfFiltered: 60,
        expectancyIfFiltered: 0.02,
        tradesRemovedPercent: 20,
        ...overrides,
    };
}

describe("polymarket diagnostics utils", () => {
    it("prefers the result summary offset, then inferred trade offsets, then UI fallback", () => {
        const summaryResult = makeResult([makeTrade(1, 1)], 3);
        const inferredResult = makeResult([makeTrade(1, 2), makeTrade(2, 2)]);
        const fallbackResult = makeResult([makeTrade(1)]);

        expect(resolvePolymarketSelectedEntryOffset(summaryResult, 1)).to.equal(3);
        expect(resolvePolymarketSelectedEntryOffset(inferredResult, 4)).to.equal(2);
        expect(resolvePolymarketSelectedEntryOffset(fallbackResult, 4)).to.equal(4);
    });

    it("ranks displayed feature suggestions by PM outcome quality before separation", () => {
        const ranked = rankPolymarketFeatureSuggestions([
            makeFeature("High separation", {
                separationScore: 0.95,
                expectancyIfFiltered: 0.03,
                winRateIfFiltered: 61,
                tradesRemovedPercent: 24,
            }),
            makeFeature("Higher expectancy", {
                separationScore: 0.4,
                expectancyIfFiltered: 0.08,
                winRateIfFiltered: 58,
                tradesRemovedPercent: 18,
            }),
            makeFeature("Higher win rate tiebreak", {
                separationScore: 0.6,
                expectancyIfFiltered: 0.08,
                winRateIfFiltered: 63,
                tradesRemovedPercent: 21,
            }),
        ]);

        expect(ranked.map((feature) => feature.label)).to.deep.equal([
            "Higher win rate tiebreak",
            "Higher expectancy",
            "High separation",
        ]);
    });

    it("uses binary resolve-hold outcomes for streaks when entry prices are unavailable", () => {
        const result = makeResult([
            {
                ...makeTrade(1),
                polymarketOutcome: {
                    eventStartTs: 1_700_000_000,
                    eventEndTs: 1_700_000_900,
                    eventSlug: "native-15m-1",
                    marketSlug: "native-15m-1",
                    prediction: "yes",
                    actualOutcomeUp: 1,
                    isWin: true,
                    marketEntryPrice: null,
                    evaluationMode: "resolve_hold",
                },
            },
            {
                ...makeTrade(2),
                polymarketOutcome: {
                    eventStartTs: 1_700_000_900,
                    eventEndTs: 1_700_001_800,
                    eventSlug: "native-15m-2",
                    marketSlug: "native-15m-2",
                    prediction: "yes",
                    actualOutcomeUp: 1,
                    isWin: true,
                    marketEntryPrice: null,
                    evaluationMode: "resolve_hold",
                },
            },
            {
                ...makeTrade(3),
                polymarketOutcome: {
                    eventStartTs: 1_700_001_800,
                    eventEndTs: 1_700_002_700,
                    eventSlug: "native-15m-3",
                    marketSlug: "native-15m-3",
                    prediction: "yes",
                    actualOutcomeUp: 0,
                    isWin: false,
                    marketEntryPrice: null,
                    evaluationMode: "resolve_hold",
                },
            },
        ]);

        const summary = buildBacktestPolymarketPerformanceSummary(result);

        expect(summary?.longestWinStreak).to.equal(2);
        expect(summary?.longestLossStreak).to.equal(1);
        expect(summary?.polymarketExpectancy).to.equal(null);
    });
});
