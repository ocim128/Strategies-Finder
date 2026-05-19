import { describe, it } from "node:test";
import { expect } from "chai";
import { backtestResultMatchesCurrentMarket, resolveBacktestResultMarketContext } from "../lib/backtest-result-context";
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
        const previousBinanceMarketType = state.binanceMarketType;
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "15m";
        state.binanceMarketType = "spot";

        const context = resolveBacktestResultMarketContext({
            ...makeResult(),
            marketContext: {
                symbol: "XRPUSDT",
                interval: "5m",
                binanceMarketType: "futures",
                candleCount: 100,
                firstCandleTime: null,
                lastCandleTime: null,
            },
        });

        expect(context).to.deep.equal({ symbol: "XRPUSDT", interval: "5m", binanceMarketType: "futures" });

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
        state.binanceMarketType = previousBinanceMarketType;
    });

    it("falls back to current app state when no snapshot exists", () => {
        const previousSymbol = state.currentSymbol;
        const previousInterval = state.currentInterval;
        const previousBinanceMarketType = state.binanceMarketType;
        state.currentSymbol = "SOLUSDT";
        state.currentInterval = "30m";
        state.binanceMarketType = "futures";

        const context = resolveBacktestResultMarketContext(makeResult());

        expect(context).to.deep.equal({ symbol: "SOLUSDT", interval: "30m", binanceMarketType: "futures" });

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
        state.binanceMarketType = previousBinanceMarketType;
    });

    it("treats spot and futures results as different market contexts", () => {
        const previousSymbol = state.currentSymbol;
        const previousInterval = state.currentInterval;
        const previousBinanceMarketType = state.binanceMarketType;
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "1s";
        state.binanceMarketType = "futures";

        const spotResult = {
            ...makeResult(),
            marketContext: {
                symbol: "BTCUSDT",
                interval: "1s",
                binanceMarketType: "spot",
                candleCount: 100,
                firstCandleTime: null,
                lastCandleTime: null,
            },
        } satisfies BacktestResult;

        expect(backtestResultMatchesCurrentMarket(spotResult)).to.equal(false);

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
        state.binanceMarketType = previousBinanceMarketType;
    });

    it("normalizes legacy futures storage symbols into the market context", () => {
        const previousSymbol = state.currentSymbol;
        const previousInterval = state.currentInterval;
        const previousBinanceMarketType = state.binanceMarketType;
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "1s";
        state.binanceMarketType = "futures";

        const result = {
            ...makeResult(),
            marketContext: {
                symbol: "BINANCE-FUTURES:BTCUSDT",
                interval: "1s",
                candleCount: 100,
                firstCandleTime: null,
                lastCandleTime: null,
            },
        } satisfies BacktestResult;

        expect(resolveBacktestResultMarketContext(result)).to.deep.equal({
            symbol: "BTCUSDT",
            interval: "1s",
            binanceMarketType: "futures",
        });
        expect(backtestResultMatchesCurrentMarket(result)).to.equal(true);

        state.currentSymbol = previousSymbol;
        state.currentInterval = previousInterval;
        state.binanceMarketType = previousBinanceMarketType;
    });
});
