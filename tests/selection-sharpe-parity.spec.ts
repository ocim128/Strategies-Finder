import { expect } from "chai";
import { describe, it } from "node:test";
import { buildSelectionResult } from "../lib/finder/endpoint";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";

const BASE_TIME = 1_700_006_400;
const DAY_SECONDS = 86_400;

function makeTrade(id: number, exitTime: number, pnl: number): Trade {
    return {
        id,
        type: "long",
        entryTime: (exitTime - 3_600) as Time,
        entryPrice: 100,
        exitTime: exitTime as Time,
        exitPrice: 100,
        pnl,
        pnlPercent: pnl / 100,
        size: 1,
        exitReason: "signal",
    };
}

function selectionSharpe(times: number[], pnls: number[]): number {
    const trades = pnls.map((pnl, index) => makeTrade(index, times[index]!, pnl));
    const terminal = makeTrade(trades.length, times.at(-1)! + 1, 0);
    const raw: BacktestResult = {
        trades: [...trades, terminal],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length + 1,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
    return buildSelectionResult(raw, terminal.exitTime, 10_000).result.sharpeRatio;
}

describe("TypeScript/Rust selection Sharpe golden cases", () => {
    it("matches the Rust route's intraday collapse and final-sample annualization contract", () => {
        const times = Array.from({ length: 6 }, (_value, day) => [
            BASE_TIME + day * DAY_SECONDS + 3_600,
            BASE_TIME + day * DAY_SECONDS + 7_200,
        ]).flat();
        expect(selectionSharpe(times, [0, 10, 0, -10, 0, 5, 0, -5, 0, 2, 0, 0]))
            .to.be.closeTo(-5.14196462274892, 1e-10);
    });

    it("averages an even number of source deltas before non-collapsed annualization", () => {
        const times = [0, 1, 3, 4, 6, 7, 9].map((days) => BASE_TIME + days * DAY_SECONDS);
        expect(selectionSharpe(times, [100, -50, 200, -100, 150, -75, 125]))
            .to.be.closeTo(5.019908766701721, 1e-10);
    });

    it("returns zero for fewer than five valid returns", () => {
        const times = [0, 1, 2, 3, 4].map((days) => BASE_TIME + days * DAY_SECONDS);
        expect(selectionSharpe(times, [100, -50, 100, -50, 100])).to.equal(0);
    });

    it("preserves the bounded Sharpe clamp", () => {
        const times = [0, 1, 2, 3, 4, 5, 6].map((days) => BASE_TIME + days * DAY_SECONDS);
        expect(selectionSharpe(times, [1_000, 2_000, 1_000, 2_000, 1_000, 2_000, 1_000]))
            .to.equal(8);
    });

    it("keeps non-collapsed samples on their observed cadence", () => {
        const times = [0, 2, 4, 6, 8, 10].map((days) => BASE_TIME + days * DAY_SECONDS);
        expect(selectionSharpe(times, [50, -25, 100, -40, 60, -20]))
            .to.be.closeTo(3.3246899796067604, 1e-10);
    });

    it("uses the legacy pnlPercent fallback when fewer than two finite equity samples remain", () => {
        const times = [0, 1, 2, 3, 4, 5].map((days) => BASE_TIME + days * DAY_SECONDS);
        const trades = times.map((time, index) => {
            const trade = makeTrade(index, time, 0);
            trade.pnl = Number.NaN;
            trade.pnlPercent = [0.01, -0.005, 0.02, -0.01, 0.015, -0.0075][index]!;
            return trade;
        });
        const terminal = makeTrade(trades.length, times.at(-1)! + 1, 0);
        const raw: BacktestResult = {
            trades: [...trades, terminal],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: trades.length + 1,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        };
        expect(buildSelectionResult(raw, terminal.exitTime, 10_000).result.sharpeRatio)
            .to.be.closeTo(0.29249159098763694, 1e-12);
    });
});
