import { expect } from "chai";
import { describe, it } from "node:test";
import { markIbkrSymbol } from "../lib/local-daily-datasets";
import { buildBatchSignalLifecycleAnalyses } from "../lib/batch-backtest/batch-signal-lifecycle-forecast";
import { runBatchSignalSelectionPath } from "../lib/batch-backtest/batch-signal-selection-path";
import type { BatchSyntheticPairArtifact, BatchSyntheticTargetArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";

function result(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

function target(asset: string, symbol: string, gain: number, events: readonly number[]): BatchSyntheticTargetArtifact {
    const data: OHLCVData[] = Array.from({ length: 120 }, (_, index) => {
        const eventExit = events.includes(index - 2);
        const price = eventExit ? 100 + gain : 100;
        return { time: (1_700_000_000 + index * 300) as Time, open: price, high: price + 1, low: price - 0.25, close: price, volume: 1_000 };
    });
    return { asset, symbol, data };
}

function pairs(targetArtifact: BatchSyntheticTargetArtifact, events: readonly number[], type: Signal["type"] = "buy"): BatchSyntheticPairArtifact[] {
    return ["X", "Y"].map((quote) => {
        const signals: Signal[] = events.map((index) => ({
            time: targetArtifact.data[index]!.time,
            type,
            price: targetArtifact.data[index]!.close,
            barIndex: index,
        }));
        return {
            symbol: `${targetArtifact.asset}+${quote}`,
            baseAsset: targetArtifact.asset,
            quoteAsset: quote,
            data: targetArtifact.data.map((bar) => ({ ...bar })),
            signals,
            result: result(),
        };
    });
}

function shortPathTarget(asset: string, ruinInTest: boolean, events: readonly number[]): BatchSyntheticTargetArtifact {
    const data: OHLCVData[] = Array.from({ length: 120 }, (_, index) => {
        const exitEvent = events.find((event) => index === event + 2);
        const price = exitEvent === undefined ? 100 : ruinInTest && exitEvent >= 96 ? 300 : 90;
        const hasPreExitDownside = events.some((event) => index === event + 1);
        return {
            time: (1_700_000_000 + index * 300) as Time,
            open: price,
            high: price + 1,
            low: hasPreExitDownside ? 80 : price - 0.25,
            close: price,
            volume: 1_000,
        };
    });
    return { asset, symbol: `${asset}USDT`, data };
}

function persistentPair(targetArtifact: BatchSyntheticTargetArtifact, quote: string): BatchSyntheticPairArtifact {
    const first = targetArtifact.data[0]!;
    const last = targetArtifact.data[targetArtifact.data.length - 1]!;
    return {
        symbol: `${targetArtifact.asset}+${quote}`,
        baseAsset: targetArtifact.asset,
        quoteAsset: quote,
        data: targetArtifact.data.map((bar) => ({ ...bar })),
        signals: [{ time: first.time, type: "buy", price: first.close, barIndex: 0 }],
        result: {
            ...result(),
            trades: [{
                id: 1,
                type: "long",
                entryTime: first.time,
                entryPrice: first.close,
                exitTime: last.time,
                exitPrice: last.close,
                pnl: 0,
                pnlPercent: 0,
                size: 1,
                exitReason: "end_of_data",
            }],
        },
    };
}

describe("Batch signal selection path", () => {
    const events = Array.from({ length: 29 }, (_, index) => 2 + index * 4);
    const execution = { initialCapital: 10_000, commissionPercent: 0.1, slippageBps: 5 };
    const options = { lagBars: 0, minSamples: 4, neighborCountMin: 4, neighborCountMax: 8 };

    it("runs one deterministic next-open position path and separates path quality", () => {
        const strong = target("AAA", "AAAUSDT", 8, events);
        const weak = target("BBB", "BBBUSDT", 3, events);
        const analyses = buildBatchSignalLifecycleAnalyses({ interval: "5m", targets: [strong, weak], artifacts: [...pairs(strong, events), ...pairs(weak, events)], options });
        const first = runBatchSignalSelectionPath({ analyses, interval: "5m", execution, options, randomSeeds: 10 });
        const second = runBatchSignalSelectionPath({ analyses, interval: "5m", execution, options, randomSeeds: 10 });

        expect(first.status).to.equal("EXPLORATORY");
        expect(first.reasonCode).to.equal("QUALITY_INSUFFICIENT");
        expect(first.path.trades).to.be.greaterThan(0);
        expect(first.path.returnPct).to.be.greaterThan(0);
        expect(first.quality.status).to.equal("INSUFFICIENT");
        expect(second).to.deep.equal(first);
    });

    it("rejects mixed market clocks without suppressing per-asset forecasts", () => {
        const crypto = target("AAA", "AAAUSDT", 8, events);
        const stock = target("BBB", markIbkrSymbol("BBB"), 3, events);
        const analyses = buildBatchSignalLifecycleAnalyses({ interval: "5m", targets: [crypto, stock], artifacts: [...pairs(crypto, events), ...pairs(stock, events)], options });
        const path = runBatchSignalSelectionPath({ analyses, interval: "5m", execution, options });

        expect(path.status).to.equal("PATH_UNAVAILABLE");
        expect(path.reasonCode).to.equal("MIXED_MARKET_CLOCKS");
        expect(path.path.trades).to.equal(0);
    });

    it("holds a persistent left-censored raw state instead of churning every bar", () => {
        const first = target("AAA", "AAAUSDT", 0, []);
        const second = target("BBB", "BBBUSDT", 0, []);
        const analyses = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [first, second],
            artifacts: [persistentPair(first, "X"), persistentPair(second, "Y")],
            options: { lagBars: 0 },
        });
        const path = runBatchSignalSelectionPath({ analyses, interval: "5m", execution, options });

        expect(path.benchmarks.rawAgreement.turnover).to.equal(1);
        expect(path.benchmarks.rawAgreement.trades).to.equal(0);
        expect(path.benchmarks.rawAgreement.exposurePct).to.be.greaterThan(0);
    });

    it("attributes ruin when a full-notional short more than doubles before invalidation", () => {
        const ruinTarget = shortPathTarget("AAA", true, events);
        const controlTarget = shortPathTarget("BBB", false, events);
        const analyses = buildBatchSignalLifecycleAnalyses({
            interval: "5m",
            targets: [ruinTarget, controlTarget],
            artifacts: [...pairs(ruinTarget, events, "sell"), ...pairs(controlTarget, events, "sell")],
            options,
        });
        const path = runBatchSignalSelectionPath({ analyses, interval: "5m", execution, options, randomSeeds: 10 });

        expect(path.status).to.equal("FAILED");
        expect(path.reasonCode).to.equal("PATH_RUIN");
        expect(path.path.ruin).to.equal(true);
        expect(path.path.markedEquity).to.equal(0);
        expect(path.path.worstTradeSymbol).to.equal("AAAUSDT");
        expect(path.path.worstTradeBias).to.equal("DOWN");
        expect(path.path.worstTradeReturnPct).to.be.lessThan(-100);
        expect(path.path.worstTradePnl).to.equal(-10_000);
    });
});
