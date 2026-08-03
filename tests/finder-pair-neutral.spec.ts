import { expect } from "chai";
import { describe, it } from "node:test";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestResult, Trade } from "../lib/types/strategies";
import {
    buildFinderPairNeutralMetrics,
    isSyntheticPairFinderSymbol,
} from "../lib/finder/finder-pair-neutral";

function makeTrade(type: Trade["type"], entryPrice: number, exitPrice: number, id: number): Trade {
    return {
        id,
        type,
        entryTime: id,
        entryPrice,
        exitTime: id + 1,
        exitPrice,
        pnl: 0,
        pnlPercent: 0,
        size: 1,
    };
}

function makeResult(trades: Trade[]): BacktestResult {
    return {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

const capital: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 0,
};

describe("Finder synthetic-pair neutral metrics", () => {
    it("recognizes marked synthetic pair symbols without changing plain symbols", () => {
        expect(isSyntheticPairFinderSymbol("NVDA•+MU•")).to.equal(true);
        expect(isSyntheticPairFinderSymbol("NVDA")).to.equal(false);
    });

    it("gives a reciprocal long and short the same net score", () => {
        const longMetrics = buildFinderPairNeutralMetrics(
            makeResult([makeTrade("long", 2, 4, 1)]),
            capital,
        );
        const shortMetrics = buildFinderPairNeutralMetrics(
            makeResult([makeTrade("short", 0.5, 0.25, 1)]),
            capital,
        );

        expect(longMetrics).to.not.equal(null);
        expect(shortMetrics).to.not.equal(null);
        expect(shortMetrics!.netProfit).to.be.closeTo(longMetrics!.netProfit, 1e-9);
        expect(shortMetrics!.profitFactor).to.equal(longMetrics!.profitFactor);
        expect(shortMetrics!.winRate).to.equal(longMetrics!.winRate);
    });

    it("charges commission symmetrically per entry and exit", () => {
        const metrics = buildFinderPairNeutralMetrics(
            makeResult([makeTrade("long", 2, 4, 1)]),
            { ...capital, commission: 1 },
        );

        expect(metrics).to.not.equal(null);
        // Gross 2x, less 1% on the entry notional and 1% on the exit notional.
        const expected = 10_000 * (2 - (0.01 * 3) - 1);
        expect(metrics!.netProfit).to.be.closeTo(expected, 1e-9);
    });
});
