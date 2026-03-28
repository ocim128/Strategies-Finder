import { describe, it } from "node:test";
import { expect } from "chai";
import { resolveBacktestResultMarketContext } from "../lib/backtest-result-context";
import { state } from "../lib/state";
import type { BacktestResult } from "../lib/types/strategies";

function makeResult(): BacktestResult {
    return {
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
    };
}

describe("backtest result market context", () => {
    it("prefers the result snapshot over current app state", () => {
        const previousSymbol = state.currentSymbol;
        const previousInterval = state.currentInterval;
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "15m";

        const context = resolveBacktestResultMarketContext({
            ...makeResult(),
            marketContext: {
                symbol: "XRPUSDT",
                interval: "5m",
                candleCount: 100,
                firstCandleTime: null,
                lastCandleTime: null,
            },
        });

        expect(context).to.deep.equal({ symbol: "XRPUSDT", interval: "5m" });

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
    });

    it("falls back to current app state when no snapshot exists", () => {
        const previousSymbol = state.currentSymbol;
        const previousInterval = state.currentInterval;
        state.currentSymbol = "SOLUSDT";
        state.currentInterval = "30m";

        const context = resolveBacktestResultMarketContext(makeResult());

        expect(context).to.deep.equal({ symbol: "SOLUSDT", interval: "30m" });

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
    });
});
