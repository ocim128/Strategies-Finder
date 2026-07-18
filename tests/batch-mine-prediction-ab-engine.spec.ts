import { expect } from "chai";
import { describe, it } from "node:test";
import { runMineAbTest } from "../lib/batch-backtest/batch-mine-prediction-ab-engine";
import type { BatchSyntheticPairArtifact, BatchSyntheticTargetArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestResult, OHLCVData, Signal, Time, Trade } from "../lib/types/strategies";

function makeCandles(length: number): OHLCVData[] {
    return Array.from({ length }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1_000,
    }));
}

function trade(id: number, pnl: number, entryTime: Time): Trade {
    return {
        id,
        type: "long",
        entryTime,
        entryPrice: 100,
        exitTime: entryTime,
        exitPrice: 100 + pnl,
        pnl,
        pnlPercent: pnl,
        size: 1,
    };
}

function result(trades: Trade[], maxDrawdown = 0): BacktestResult {
    const winners = trades.filter((row) => row.pnl > 0);
    const losers = trades.filter((row) => row.pnl < 0);
    const netProfit = trades.reduce((sum, row) => sum + row.pnl, 0);
    const grossProfit = winners.reduce((sum, row) => sum + row.pnl, 0);
    const grossLoss = Math.abs(losers.reduce((sum, row) => sum + row.pnl, 0));
    return {
        trades,
        netProfit,
        netProfitPercent: netProfit,
        winRate: trades.length > 0 ? (winners.length / trades.length) * 100 : 0,
        expectancy: 0,
        avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
        maxDrawdown,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: winners.length,
        losingTrades: losers.length,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

describe("batch-mine-prediction-ab-engine", () => {
    it("returns a report for an empty artifact set", async () => {
        const output = await runMineAbTest({
            artifacts: [],
            targets: [],
            interval: "5m",
            backtestSettings: { executionModel: "next_open" },
            capitalSettings,
        });
        expect(output.pairs).to.equal(0);
        expect(output.verdict).to.equal("NO_DIFFERENCE");
        expect(output.reportLines.some((line) => line.startsWith("MINE_AB"))).to.equal(true);
    });

    it("gates buy signals on the next-open execution bar and aggregates the real replay result", async () => {
        const candles = makeCandles(260);
        const signals: Signal[] = [
            { time: candles[200]!.time, type: "buy", price: candles[200]!.close },
            { time: candles[210]!.time, type: "sell", price: candles[210]!.close },
            { time: candles[220]!.time, type: "buy", price: candles[220]!.close },
            { time: candles[230]!.time, type: "sell", price: candles[230]!.close },
        ];
        const controlResult = result([
            trade(1, -20, candles[201]!.time),
            trade(2, 10, candles[221]!.time),
        ], 25);
        const treatmentResult = result([trade(1, 10, candles[221]!.time)], 5);
        const artifacts: BatchSyntheticPairArtifact[] = [{
            symbol: "AAA+BBB",
            baseAsset: "AAA",
            quoteAsset: "BBB",
            data: candles,
            signals,
            result: controlResult,
        }];
        const targets: BatchSyntheticTargetArtifact[] = [{ asset: "AAA", symbol: "AAAUSDT", data: candles }];
        const verdictTimes: Time[] = [];
        let replaySignals: Signal[] = [];

        const output = await runMineAbTest({
            artifacts,
            targets,
            interval: "5m",
            strategyKey: "fixture",
            backtestSettings: { executionModel: "next_open", tradeDirection: "long" },
            capitalSettings,
            verdictAtTime: async (_asset, _data, executionTime) => {
                verdictTimes.push(executionTime);
                return executionTime === candles[221]!.time ? "LONG" : "SKIP";
            },
            executeTreatment: async (_data, _interval, filtered) => {
                replaySignals = filtered;
                return treatmentResult;
            },
        });

        expect(verdictTimes).to.deep.equal([candles[201]!.time, candles[221]!.time]);
        expect(replaySignals.filter((signal) => signal.type === "buy")).to.deep.equal([signals[2]]);
        expect(replaySignals.filter((signal) => signal.type === "sell")).to.deep.equal([signals[1], signals[3]]);
        expect(output.control.netPnl).to.equal(-10);
        expect(output.treatment.netPnl).to.equal(10);
        expect(output.control.trades).to.equal(2);
        expect(output.treatment.trades).to.equal(1);
        expect(output.control.profitFactor).to.equal(0.5);
        expect(output.treatment.maxDrawdown).to.equal(5);
        expect(output.perPair[0]!.keptEntries).to.equal(1);
        expect(output.perPair[0]!.droppedEntries).to.equal(1);
        expect(output.verdict).to.equal("TREATMENT_BETTER");
        expect(output.reportLines.some((line) => line.includes("avgTrade=") && line.includes("maxDD="))).to.equal(true);
    });

    it("excludes a pair from both arms when its base-asset verdict cannot be evaluated", async () => {
        const candles = makeCandles(10);
        const controlResult = result([trade(1, 5, candles[1]!.time)]);
        const output = await runMineAbTest({
            artifacts: [{
                symbol: "AAA+BBB",
                baseAsset: "AAA",
                quoteAsset: "BBB",
                data: candles,
                signals: [{ time: candles[0]!.time, type: "buy", price: 100 }],
                result: controlResult,
            }],
            targets: [],
            interval: "5m",
            backtestSettings: { executionModel: "next_open" },
            capitalSettings,
        });
        expect(output.evaluatedPairs).to.equal(0);
        expect(output.control.trades).to.equal(0);
        expect(output.treatment.trades).to.equal(0);
        expect(output.perPair[0]!.error).to.contain("base asset OHLCV unavailable");
        expect(output.reportLines.some((line) => line.startsWith("CAVEAT"))).to.equal(true);
    });
});
