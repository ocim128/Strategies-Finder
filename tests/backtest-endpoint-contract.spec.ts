import assert from "node:assert";
import { describe, it } from "node:test";
import { toSlimSingleResult } from "../lib/backtest-endpoint-contract";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";

function makeTrade(id: number, isWin: boolean | null): Trade {
    return {
        id,
        type: "long",
        entryTime: (1_700_000_000 + id * 300) as Time,
        entryPrice: 30_000,
        exitTime: (1_700_000_300 + id * 300) as Time,
        exitPrice: 30_100,
        pnl: isWin === false ? -10 : 10,
        pnlPercent: isWin === false ? -0.3 : 0.3,
        size: 1,
        exitReason: "signal",
    };
}

describe("backtest endpoint contract helpers", () => {
    it("projects slim single results with market context and compact metrics", () => {
        const result: BacktestResult = {
            trades: [
                makeTrade(1, true),
                makeTrade(2, false),
                makeTrade(3, true),
            ],
            netProfit: 10,
            netProfitPercent: 3.3,
            winRate: 66.7,
            expectancy: 3.33,
            avgTrade: 3.33,
            profitFactor: 2,
            maxDrawdown: 10,
            maxDrawdownPercent: 3.3,
            totalTrades: 3,
            winningTrades: 2,
            losingTrades: 1,
            avgWin: 10,
            avgLoss: 10,
            sharpeRatio: 1.2,
            equityCurve: [],
            marketContext: {
                symbol: "BTCUSDT",
                interval: "5m",
                candleCount: 100,
                firstCandleTime: 1_700_000_000 as Time,
                lastCandleTime: 1_700_001_500 as Time,
            },
        };

        const slim = toSlimSingleResult(result);

        assert.strictEqual(slim.marketContext?.symbol, "BTCUSDT");
        assert.strictEqual(slim.marketContext?.interval, "5m");
        assert.strictEqual(slim.totalTrades, 3);
        assert.strictEqual(slim.netProfit, 10);
    });
});
