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

function directedPair(
    symbol: string,
    target: BatchSyntheticTargetArtifact,
    directions: ReadonlyMap<number, "buy" | "sell">,
): BatchSyntheticPairArtifact {
    return {
        ...pair(symbol, target, []),
        signals: [...directions].map(([index, type]) => ({
            time: target.data[index]!.time,
            type,
            price: target.data[index]!.close,
            barIndex: index,
        })),
    };
}

function rollingTradePair(
    symbol: string,
    target: BatchSyntheticTargetArtifact,
    boundaries: readonly number[],
): BatchSyntheticPairArtifact {
    const artifact = pair(symbol, target, []);
    artifact.result.trades = boundaries.slice(0, -1).map((entryIndex, index) => {
        const exitIndex = boundaries[index + 1]!;
        return {
            id: index + 1,
            type: "long",
            entryTime: target.data[entryIndex]!.time,
            entryPrice: target.data[entryIndex]!.close,
            exitTime: target.data[exitIndex]!.time,
            exitPrice: target.data[exitIndex]!.close,
            pnl: 0,
            pnlPercent: 0,
            size: 1,
            exitReason: "signal",
        };
    });
    return artifact;
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

    it("names the failed edge gate and keeps excursions visible for a neutral row", () => {
        const events = [2, 7, 12, 17, 22, 27, 31];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(32, events, 0) };
        const output = runBatchSignalLifecycleForecast({
            interval: "5m",
            targets: [target],
            artifacts: [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)],
            options: { lagBars: 0, minSamples: 4, neighborCountMin: 4, neighborCountMax: 8 },
            nowMs: 1_700_000_000_000,
        });

        expect(output.rows[0]!.status).to.equal("NO_EDGE");
        expect(output.rows[0]!.reasonCode).to.equal("RETURN_SIGN_GATE");
        expect(output.rows[0]!.medianFavorableExcursionPct).to.not.equal(null);
        expect(output.rows[0]!.medianAdverseExcursionPct).to.not.equal(null);
    });

    it("does not expose a stale current distribution as an actionable edge", () => {
        const events = [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 59];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(60, events) };
        const output = runBatchSignalLifecycleForecast({
            interval: "5m",
            targets: [target],
            artifacts: [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)],
            options: { lagBars: 0, minSamples: 4, neighborCountMin: 4, neighborCountMax: 8 },
            nowMs: 1_800_000_000_000,
        });

        expect(output.rows[0]!.freshness).to.equal("STALE");
        expect(output.rows[0]!.status).to.equal("NO_EDGE");
        expect(output.rows[0]!.bias).to.equal("NEUTRAL");
        expect(output.rows[0]!.reasonCode).to.equal("DATA_STALE");
        expect(output.rows[0]!.medianReturnPct).to.not.equal(null);
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

    it("invalidates when agreement strength decays even while a raw majority remains", () => {
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(8, []) };
        const artifacts = Array.from({ length: 11 }, (_, index) => directedPair(
            `AAA+P${index}`,
            target,
            new Map([
                [2, index < 9 ? "buy" : "sell"],
                [3, index < 6 ? "buy" : "sell"],
                [4, index < 9 ? "buy" : "sell"],
            ]),
        ));
        const analysis = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [target],
            artifacts,
            options: { lagBars: 0 },
        })[0]!;

        expect(analysis.timeline[3]!.snapshot!.direction).to.equal("long");
        expect(analysis.lifecycleDirectionByIndex.slice(2, 5)).to.deep.equal(["long", null, "long"]);
        expect(analysis.lifecycles[0]!.invalidationIndex).to.equal(3);
        expect(analysis.lifecycles[1]!.activationIndex).to.equal(4);
    });

    it("starts a new lifecycle when supporting pair positions reset in the same direction", () => {
        const boundaries = [2, 6, 10, 14, 18, 22];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(24, []) };
        const analysis = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [target],
            artifacts: [
                rollingTradePair("AAA+BBB", target, boundaries),
                rollingTradePair("AAA+CCC", target, boundaries),
            ],
            options: { lagBars: 0 },
        })[0]!;

        expect(analysis.lifecycles.map((entry) => entry.activationIndex)).to.deep.equal([2, 6, 10, 14, 18]);
        expect(analysis.lifecycles.slice(0, -1).map((entry) => entry.invalidationIndex)).to.deep.equal([6, 10, 14, 18]);
        expect(analysis.lifecycleDirectionByIndex.slice(5, 11)).to.deep.equal(["long", "long", "long", "long", "long", "long"]);
    });

    it("uses the nearest observed maturity from shorter completed lifecycles", () => {
        const events = [2, 7, 12, 17, 20];
        const target: BatchSyntheticTargetArtifact = { asset: "AAA", symbol: "AAAUSDT", data: candles(40, events) };
        const artifacts = [pair("AAA+BBB", target, events), pair("AAA+CCC", target, events)];
        for (const artifact of artifacts) {
            artifact.result.trades = [{
                id: 1,
                type: "long",
                entryTime: target.data[20]!.time,
                entryPrice: target.data[20]!.close,
                exitTime: target.data[39]!.time,
                exitPrice: target.data[39]!.close,
                pnl: 0,
                pnlPercent: 0,
                size: 1,
                exitReason: "end_of_data",
            }];
        }
        const output = runBatchSignalLifecycleForecast({
            interval: "5m",
            targets: [target],
            artifacts,
            options: { lagBars: 0, minSamples: 4, neighborCountMin: 4, neighborCountMax: 8 },
            nowMs: 1_700_000_000_000,
        });

        expect(output.rows[0]!.lifecycleAge).to.equal(19);
        expect(output.rows[0]!.candidateCount).to.equal(4);
        expect(output.rows[0]!.analogCount).to.equal(4);
    });
});
