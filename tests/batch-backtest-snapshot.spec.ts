import { expect } from "chai";
import { describe, it } from "node:test";
import {
    BATCH_RESULT_SNAPSHOT_LIMIT,
    compactBatchBacktestResultsSnapshot,
    normalizeBatchBacktestResultsSnapshot,
} from "../lib/batch-backtest/batch-backtest-snapshot";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";

function makeData(): OHLCVData[] {
    return [
        { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { time: 2 as Time, open: 110, high: 111, low: 109, close: 110, volume: 1 },
    ];
}

function makeResult(index: number): BatchBacktestSymbolResult {
    const result: BacktestResult = {
        trades: [
            {
                id: index,
                type: "long",
                entryTime: 1 as Time,
                entryPrice: 100,
                exitTime: 2 as Time,
                exitPrice: 110,
                pnl: 10,
                pnlPercent: 10,
                size: 1,
                exitReason: "end_of_data",
            },
        ],
        netProfit: index,
        netProfitPercent: 10,
        winRate: 100,
        expectancy: 10,
        avgTrade: 10,
        profitFactor: Infinity,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 10,
        avgLoss: 0,
        sharpeRatio: 1,
        equityCurve: [{ time: 1 as Time, value: 1_000 }],
    };
    return {
        symbol: "WLD+BTC",
        status: "profitable",
        barCount: 2,
        firstTime: 1 as Time,
        lastTime: 2 as Time,
        result,
        data: makeData(),
        signals: [{ time: 1 as Time, type: "buy" } as Signal],
    };
}

describe("Batch backtest result snapshots", () => {
    it("keeps snapshots bounded and strips heavy row arrays", () => {
        const snapshot = compactBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "5m",
            fingerprint: "abc",
            serverHasArtifacts: true,
            results: Array.from({ length: BATCH_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeResult(index)),
        });

        expect(snapshot.results).to.have.length(BATCH_RESULT_SNAPSHOT_LIMIT);
        expect(snapshot.results[0]!.data).to.equal(undefined);
        expect(snapshot.results[0]!.signals).to.equal(undefined);
        expect(snapshot.results[0]!.result?.trades).to.deep.equal([]);
        expect(snapshot.results[0]!.result?.equityCurve).to.deep.equal([]);
        expect(snapshot.results[0]!.buyHoldPct).to.be.closeTo(10, 1e-9);
        expect(snapshot.results[0]!.openTradeAssetScores?.map((s) => `${s.asset}:${s.score}`)).to.deep.equal(["BTC:-1", "WLD:1"]);
    });

    it("rejects malformed snapshots", () => {
        expect(normalizeBatchBacktestResultsSnapshot(null)).to.equal(null);
        expect(normalizeBatchBacktestResultsSnapshot({ results: [] })).to.equal(null);
        expect(normalizeBatchBacktestResultsSnapshot({ interval: "5m" })).to.equal(null);
    });

    it("normalizes valid snapshots through the compact path", () => {
        const normalized = normalizeBatchBacktestResultsSnapshot({
            savedAt: 123,
            interval: "1h",
            fingerprint: "abc",
            serverHasArtifacts: false,
            results: [makeResult(1)],
        });

        expect(normalized?.interval).to.equal("1h");
        expect(normalized?.results[0]?.data).to.equal(undefined);
        expect(normalized?.results[0]?.result?.trades).to.deep.equal([]);
    });
});
