import { expect } from "chai";
import { describe, it } from "node:test";
import type { BacktestResult, Time, Trade } from "./lib/strategies/index";
import { runWalkForwardPermutationTest } from "./lib/strategies/backtest/permutation-test";
import type { WalkForwardResult } from "./lib/strategies/walk-forward";

function makeTrade(id: number, pnl: number, pnlPercent: number): Trade {
    return {
        id,
        type: "long",
        entryTime: id as Time,
        entryPrice: 100,
        exitTime: (id + 1) as Time,
        exitPrice: 100 * (1 + pnlPercent / 100),
        pnl,
        pnlPercent,
        size: 1,
        exitReason: "signal",
    };
}

function makeBacktestResult(trades: Trade[]): BacktestResult {
    const winningTrades = trades.filter(trade => trade.pnl > 0);
    const totalProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const totalLoss = Math.abs(trades.filter(trade => trade.pnl <= 0).reduce((sum, trade) => sum + trade.pnl, 0));
    const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);

    return {
        trades,
        netProfit,
        netProfitPercent: 0,
        winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
        expectancy: trades.length > 0 ? netProfit / trades.length : 0,
        avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Number.POSITIVE_INFINITY : 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: winningTrades.length,
        losingTrades: trades.length - winningTrades.length,
        avgWin: winningTrades.length > 0 ? totalProfit / winningTrades.length : 0,
        avgLoss: trades.length > winningTrades.length ? totalLoss / (trades.length - winningTrades.length) : 0,
        sharpeRatio: 0.9,
        equityCurve: [],
    };
}

function makeWalkForwardResult(trades: Trade[]): WalkForwardResult {
    return {
        windows: [],
        combinedOOSTrades: makeBacktestResult(trades),
        avgInSampleSharpe: 1.1,
        avgOutOfSampleSharpe: 0.9,
        walkForwardEfficiency: 0.82,
        robustnessScore: 76,
        totalWindows: 4,
        optimizationTimeMs: 100,
        parameterStability: 70,
    };
}

describe("Walk-forward permutation test", () => {
    it("is deterministic for the same seed and config", () => {
        const trades = [
            makeTrade(1, 80, 1.2),
            makeTrade(2, 60, 0.9),
            makeTrade(3, -30, -0.4),
            makeTrade(4, 70, 1.1),
            makeTrade(5, 55, 0.8),
            makeTrade(6, -20, -0.3),
        ];
        const result = makeWalkForwardResult(trades);

        const first = runWalkForwardPermutationTest(result, {
            permutations: 250,
            seed: 1337,
            metric: "expectancy",
        });
        const second = runWalkForwardPermutationTest(result, {
            permutations: 250,
            seed: 1337,
            metric: "expectancy",
        });

        expect(first.status).to.equal("ok");
        expect(second.status).to.equal("ok");
        expect(first.pValue).to.equal(second.pValue);
        expect(first.nullMean).to.equal(second.nullMean);
        expect(first.nullMedian).to.equal(second.nullMedian);
    });

    it("returns insufficient sample below the conservative trade threshold", () => {
        const result = makeWalkForwardResult([
            makeTrade(1, 50, 1),
            makeTrade(2, -20, -0.4),
            makeTrade(3, 35, 0.7),
            makeTrade(4, 25, 0.5),
        ]);

        const permutation = runWalkForwardPermutationTest(result, {
            permutations: 200,
            seed: 1337,
            metric: "net_profit",
        });

        expect(permutation.status).to.equal("insufficient_sample");
        expect(permutation.pValue).to.equal(null);
    });

    it("finds strong evidence against luck for a uniformly positive OOS sample", () => {
        const result = makeWalkForwardResult([
            makeTrade(1, 90, 1.4),
            makeTrade(2, 75, 1.1),
            makeTrade(3, 60, 0.9),
            makeTrade(4, 85, 1.3),
            makeTrade(5, 70, 1.0),
            makeTrade(6, 95, 1.5),
        ]);

        const permutation = runWalkForwardPermutationTest(result, {
            permutations: 500,
            seed: 1337,
            metric: "net_profit",
        });

        expect(permutation.status).to.equal("ok");
        expect(permutation.pValue).to.not.equal(null);
        expect((permutation.pValue ?? 1) <= 0.05).to.equal(true);
        expect(
            permutation.interpretation === "Strong evidence against luck" ||
            permutation.interpretation === "Evidence against luck"
        ).to.equal(true);
    });

    it("reports all-zero samples as inconclusive", () => {
        const result = makeWalkForwardResult([
            makeTrade(1, 0, 0),
            makeTrade(2, 0, 0),
            makeTrade(3, 0, 0),
            makeTrade(4, 0, 0),
            makeTrade(5, 0, 0),
        ]);

        const permutation = runWalkForwardPermutationTest(result, {
            permutations: 100,
            seed: 1337,
            metric: "trade_sharpe",
        });

        expect(permutation.status).to.equal("all_zero");
        expect(permutation.pValue).to.equal(null);
    });

    it("uses realized trade returns for trade_sharpe instead of the stored result sharpe field", () => {
        const result = makeWalkForwardResult([
            makeTrade(1, 80, 1.2),
            makeTrade(2, 60, 0.9),
            makeTrade(3, -30, -0.4),
            makeTrade(4, 70, 1.1),
            makeTrade(5, 55, 0.8),
            makeTrade(6, -20, -0.3),
        ]);

        result.combinedOOSTrades.sharpeRatio = -7;

        const permutation = runWalkForwardPermutationTest(result, {
            permutations: 100,
            seed: 1337,
            metric: "trade_sharpe",
        });

        expect(permutation.status).to.equal("ok");
        expect((permutation.observedValue ?? 0) > 0).to.equal(true);
    });
});
