import assert from "node:assert";
import { describe, it } from "node:test";
import { toSlimSingleResult } from "../lib/backtest-endpoint-contract";
import type { BacktestResult, Trade } from "../lib/types/strategies";

function makeTrade(id: number, isWin: boolean | null, marketEntryPrice = 0.4): Trade {
    return {
        id,
        type: "long",
        entryTime: 1_700_000_000 + id * 300,
        entryPrice: 30_000,
        exitTime: 1_700_000_300 + id * 300,
        exitPrice: 30_100,
        pnl: isWin === false ? -10 : 10,
        pnlPercent: isWin === false ? -0.3 : 0.3,
        size: 1,
        exitReason: "signal",
        polymarketOutcome: isWin === null ? null : {
            eventStartTs: 1_700_000_000 + id * 300,
            eventEndTs: 1_700_000_300 + id * 300,
            eventSlug: `event-${id}`,
            marketSlug: `market-${id}`,
            prediction: "yes",
            actualOutcomeUp: isWin ? 1 : 0,
            isWin,
            marketEntryPrice,
        },
    };
}

describe("backtest endpoint contract helpers", () => {
    it("adds compact polymarket performance to slim single results", () => {
        const result = toSlimSingleResult({
            trades: [
                makeTrade(1, true, 0.4),
                makeTrade(2, false, 0.6),
                makeTrade(3, true, 0.3),
                makeTrade(4, null),
            ],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0.5,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 1,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 4,
            winningTrades: 2,
            losingTrades: 2,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 3,
                scoredTrades: 3,
                missingOutcomeTrades: 1,
                unscoredTrades: 1,
            },
        } satisfies BacktestResult);

        assert.deepStrictEqual(result.polymarketPerformance, {
            wins: 2,
            losses: 1,
            neutralTrades: 0,
            scoredTrades: 3,
            unscoredTrades: 1,
            missingOutcomeTrades: 1,
            scoredTradeShare: 0.75,
            polymarketWinRate: 2 / 3,
            polymarketExpectancy: 0.2333333333333333,
            polymarketProfitFactor: 2.1666666666666665,
            pricedTrades: 3,
            unpricedScoredTrades: 0,
            outcomeRowsLoaded: 3,
            bestBaselineWinRate: 2 / 3,
            baselineDelta: 0,
            longestWinStreak: 1,
            longestLossStreak: 1,
            entryOffset: undefined,
        });
    });

    it("omits polymarket performance when the result has no polymarket scoring", () => {
        const result = toSlimSingleResult({
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        } satisfies BacktestResult);

        assert.strictEqual(result.polymarketPerformance, undefined);
    });
});
