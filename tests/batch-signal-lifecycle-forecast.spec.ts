import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildBatchSignalLifecycleAnalyses,
    forecastBatchSignalLifecycleAt,
    runBatchSignalLifecycleForecast,
} from "../lib/batch-backtest/batch-signal-lifecycle-forecast";
import type { BatchSyntheticPairArtifact, BatchSyntheticTargetArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";

function candles(length: number, events: readonly number[], gain = 5): OHLCVData[] {
    return Array.from({ length }, (_, index) => {
        let price = 100;
        for (const event of events) {
            if (index === event + 2) price = 100 + gain;
        }
        return {
            time: (1_700_000_000 + index * 300) as Time,
            open: price,
            high: price + 1,
            low: price - 0.25,
            close: price,
            volume: 1_000,
        };
    });
}

function result(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

function signals(data: readonly OHLCVData[], indexes: readonly number[]): Signal[] {
    return indexes.map((index) => ({ time: data[index]!.time, type: "buy", price: data[index]!.close, barIndex: index }));
}

function pair(symbol: string, target: BatchSyntheticTargetArtifact, indexes: readonly number[]): BatchSyntheticPairArtifact {
    return {
        symbol,
        baseAsset: target.asset,
        quoteAsset: symbol.split("+")[1]!,
        data: target.data.map((bar) => ({ ...bar })),
        signals: signals(target.data, indexes),
        result: result(),
    };
}

describe("Batch signal lifecycle forecast", () => {
    it("labels one sample per completed lifecycle and keeps the current lifecycle open", () => {
        const events = [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 59];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(60, events) };
        const output = runBatchSignalLifecycleForecast({
            interval: "5m",
            targets: [target],
            artifacts: [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)],
            options: { lagBars: 0, minSamples: 4, neighborCountMin: 4, neighborCountMax: 8 },
            nowMs: 1_700_000_000_000,
        });

        expect(output.analyses[0]!.lifecycles.filter((lifecycle) => lifecycle.invalidationIndex !== null)).to.have.length(11);
        expect(output.analyses[0]!.lifecycles.at(-1)!.invalidationIndex).to.equal(null);
        expect(output.rows[0]!.candidateCount).to.equal(11);
        expect(output.rows[0]!.bias).to.equal("UP");
        expect(output.rows[0]!.status).to.equal("EDGE");
    });

    it("does not admit a lifecycle outcome until its next-open exit is observable", () => {
        const events = [2, 7, 12, 17, 22, 27, 32];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(40, events) };
        const analyses = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [target],
            artifacts: [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)],
            options: { lagBars: 0 },
        });
        const beforeLatestExit = forecastBatchSignalLifecycleAt(analyses[0]!, 27, "5m", { lagBars: 0, minSamples: 1, neighborCountMin: 1 });
        const afterLatestExit = forecastBatchSignalLifecycleAt(analyses[0]!, 32, "5m", { lagBars: 0, minSamples: 1, neighborCountMin: 1 });

        expect(beforeLatestExit.candidateCount).to.equal(5);
        expect(afterLatestExit.candidateCount).to.equal(6);
    });

    it("treats a missing linked-pair bar as unknown coverage, not invalidation", () => {
        const events = [2, 7, 12];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(20, events) };
        const complete = pair("AAA+BBB", target, events);
        const gapped = pair("AAA+CCC", target, events);
        gapped.data.splice(8, 1);
        const analysis = buildBatchSignalLifecycleAnalyses({ interval: "5m", targets: [target], artifacts: [complete, gapped], options: { lagBars: 0 } })[0]!;

        expect(analysis.timeline[8]!.observable).to.equal(false);
        const lifecycle = analysis.lifecycles.find((entry) => entry.activationIndex === 7)!;
        expect(lifecycle.invalidationIndex).to.equal(null);
        expect(lifecycle.outcome).to.equal(null);
    });

    it("excludes an active state already present at the left boundary", () => {
        const events = [0, 5, 10, 15];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(20, events) };
        const analysis = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [target],
            artifacts: [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)],
            options: { lagBars: 0 },
        })[0]!;

        expect(analysis.lifecycles.some((entry) => entry.activationIndex === 0)).to.equal(false);
        expect(analysis.lifecycles[0]!.activationIndex).to.equal(5);
    });
});
