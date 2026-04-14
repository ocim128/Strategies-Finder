import { describe, it } from "node:test";
import assert from "node:assert";
import type { Time } from "lightweight-charts";
import { createBuySignal, createSellSignal } from "../lib/strategies/strategy-helpers";
import { executeBacktest } from "../lib/backtest-executor";
import {
    canComputeBacktestEdgeAnalysis,
    ensureBacktestEdgeAnalysis,
    transferBacktestEdgeAnalysisInput,
} from "../lib/backtest-edge-analysis";
import type { BacktestResult, OHLCVData, Strategy } from "../lib/types/strategies";

const sampleCandles: OHLCVData[] = Array.from({ length: 16 }, (_, i) => ({
    time: (1700000000 + i * 300) as Time,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000,
}));

const flippingStrategy: Strategy = {
    name: "edge-analysis-test",
    description: "Produces alternating entry and exit signals for deferred edge-analysis tests.",
    defaultParams: {},
    paramLabels: {},
    execute: (data) => {
        const signals = [];
        for (let i = 1; i < data.length - 1; i += 2) {
            signals.push(createBuySignal(data, i, "enter"));
            signals.push(createSellSignal(data, i + 1, "exit"));
        }
        return signals;
    },
};

async function runBacktestWithTrades(): Promise<BacktestResult> {
    const run = await executeBacktest({
        ohlcvData: sampleCandles,
        interval: "5m",
        strategyKey: "edge-analysis-test",
        strategy: flippingStrategy,
        strategyParams: {},
        backtestSettings: {
            executionModel: "signal_close",
            tradeDirection: "long",
            allowSameBarExit: true,
            marketMode: "all",
        },
        capitalSettings: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0.1,
            sizingMode: "percent",
            fixedTradeAmount: 1000,
        },
        context: {
            nowSec: 1700000000 + sampleCandles.length * 300 + 300,
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "typescript",
        },
    });

    assert.ok(run.result.totalTrades >= 3, `expected at least 3 trades, got ${run.result.totalTrades}`);
    return run.result;
}

describe("backtest edge analysis", () => {
    it("keeps edge statistics deferred until explicitly requested", async () => {
        const result = await runBacktestWithTrades();

        assert.strictEqual(result.edgeStatistics, undefined);
        assert.strictEqual(canComputeBacktestEdgeAnalysis(result), true);

        const computed = await ensureBacktestEdgeAnalysis(result);
        assert.ok(computed, "expected computed edge analysis");
        assert.strictEqual(result.edgeStatistics, computed);

        const cached = await ensureBacktestEdgeAnalysis(result);
        assert.strictEqual(cached, computed);
    });

    it("can transfer deferred edge-analysis input to a cloned result object", async () => {
        const original = await runBacktestWithTrades();
        const cloned: BacktestResult = {
            ...original,
            trades: [...original.trades],
            equityCurve: [...original.equityCurve],
        };

        transferBacktestEdgeAnalysisInput(original, cloned);

        assert.strictEqual(cloned.edgeStatistics, undefined);
        assert.strictEqual(canComputeBacktestEdgeAnalysis(cloned), true);

        const computed = await ensureBacktestEdgeAnalysis(cloned);
        assert.ok(computed, "expected transferred edge-analysis input to compute");
        assert.strictEqual(cloned.edgeStatistics, computed);
    });
});
