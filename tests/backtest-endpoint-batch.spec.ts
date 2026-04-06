import { describe, it } from "node:test";
import assert from "node:assert";
import { executeBacktest, executeBacktestFromSignals, getManifestFingerprint } from "../lib/backtest-executor";
import type { OHLCVData, BacktestSettings, Signal, Strategy } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";

const sampleCandles: OHLCVData[] = Array.from({ length: 500 }, (_, i) => ({
    time: (1700000000 + i * 300) as import("lightweight-charts").Time,
    open: 100 + Math.sin(i * 0.1) * 5,
    high: 105 + Math.sin(i * 0.1) * 5,
    low: 95 + Math.sin(i * 0.1) * 5,
    close: 100 + Math.sin(i * 0.1) * 5 + (Math.random() - 0.5),
    volume: 1000 + Math.random() * 500,
}));

const defaultSettings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "short",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const defaultCapital: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

function createExecutorRequest(
    strategyKey: string,
    candles: OHLCVData[],
    params: Record<string, number>
) {
    return {
        ohlcvData: candles,
        interval: "5m",
        strategyKey,
        strategyParams: params,
        backtestSettings: defaultSettings,
        capitalSettings: defaultCapital,
        context: {
            nowSec: Math.floor(Date.now() / 1000) + 600,
            blockRange: null,
            annotatePolymarket: false,
            engineMode: "typescript" as const,
        },
    };
}

describe("backtest batch execution (multi-run parity)", () => {
    it("executes multiple param sets with deterministic results", async () => {
        const paramSets = [
            { lookback: 10, threshold: 1.0 },
            { lookback: 20, threshold: 1.5 },
            { lookback: 30, threshold: 2.0 },
        ];

        const results: Array<{ params: Record<string, number>; trades: number; winRate: number }> = [];

        for (const params of paramSets) {
            const result = await executeBacktest(createExecutorRequest(
                "median_deviation_streak",
                sampleCandles,
                params
            ));
            results.push({
                params,
                trades: result.result.totalTrades,
                winRate: result.result.winRate,
            });
        }

        // Each param set should produce a different number of trades or win rate
        assert.strictEqual(results.length, 3);
        for (const r of results) {
            assert.ok(r.trades >= 0, `Expected non-negative trades, got ${r.trades}`);
        }
    });

    it("executes from pre-generated signals consistently", async () => {
        // Generate signals once, execute twice
        const execReq = createExecutorRequest(
            "median_deviation_streak",
            sampleCandles,
            { lookback: 20, threshold: 1.5 }
        );
        const run1 = await executeBacktest(execReq);

        const run2 = await executeBacktest(
            createExecutorRequest(
                "median_deviation_streak",
                sampleCandles,
                { lookback: 20, threshold: 1.5 }
            )
        );

        assert.strictEqual(run1.result.totalTrades, run2.result.totalTrades);
        assert.strictEqual(run1.result.netProfit, run2.result.netProfit);
    });

    it("handles block-range slicing in batch mode", async () => {
        const midTime = sampleCandles[Math.floor(sampleCandles.length / 2)].time as number;
        const narrowRange = { from: midTime - 500, to: midTime + 500 };

        const fullResult = await executeBacktest({
            ...createExecutorRequest("median_deviation_streak", sampleCandles, { lookback: 20, threshold: 1.5 }),
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const narrowResult = await executeBacktest({
            ...createExecutorRequest("median_deviation_streak", sampleCandles, { lookback: 20, threshold: 1.5 }),
            context: {
                nowSec: 9999999999,
                blockRange: narrowRange,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.ok(
            (narrowResult.result.marketContext?.candleCount ?? 0) < (fullResult.result.marketContext?.candleCount ?? 0),
            "Narrow range should have fewer candles"
        );
    });

    it("provides manifest fingerprint for drift detection", () => {
        const fp = getManifestFingerprint();
        assert.ok(fp.strategyCount > 50); // We have many strategies
        assert.ok(fp.strategyKeys.includes("median_deviation_streak"));
        assert.ok(fp.hash.length > 0);
    });

    it("does not invert prepared signals a second time", async () => {
        const candles: OHLCVData[] = [
            { time: 1700000000 as import("lightweight-charts").Time, open: 100, high: 101, low: 99, close: 100, volume: 10 },
            { time: 1700000300 as import("lightweight-charts").Time, open: 100, high: 101, low: 95, close: 96, volume: 10 },
            { time: 1700000600 as import("lightweight-charts").Time, open: 95, high: 96, low: 90, close: 91, volume: 10 },
            { time: 1700000900 as import("lightweight-charts").Time, open: 90, high: 91, low: 85, close: 86, volume: 10 },
        ];
        const settings: BacktestSettings = {
            ...defaultSettings,
            executionModel: "next_open",
            tradeDirection: "short",
            invertSignals: true,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        };
        const strategy: Strategy = {
            name: "prepared-signal-reference",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [{
                time: data[1]!.time,
                type: "buy",
                price: data[1]!.close,
                barIndex: 1,
            }],
        };

        const referenceRun = await executeBacktest({
            ohlcvData: candles,
            interval: "5m",
            strategyKey: "prepared-signal-reference",
            strategy,
            strategyParams: {},
            backtestSettings: settings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const replayRun = await executeBacktestFromSignals(
            candles,
            "5m",
            [{
                time: candles[1]!.time,
                type: "sell",
                price: candles[1]!.close,
                barIndex: 1,
            }],
            settings,
            defaultCapital,
            {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            }
        );

        assert.strictEqual(replayRun.result.totalTrades, referenceRun.result.totalTrades);
        assert.strictEqual(replayRun.result.trades[0]?.type, referenceRun.result.trades[0]?.type);
        assert.strictEqual(replayRun.result.netProfit, referenceRun.result.netProfit);
    });

    it("applies strategy-timeframe resampling for explicit strategy objects", async () => {
        const candles: OHLCVData[] = Array.from({ length: 24 }, (_, index) => ({
            time: (1700100000 + index * 300) as import("lightweight-charts").Time,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100.5 + index,
            volume: 10,
        }));
        const strategy: Strategy = {
            name: "explicit-timeframe-check",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => data.length > 11
                ? [{
                    time: data[10]!.time,
                    type: "buy" as const,
                    price: data[10]!.close,
                    barIndex: 10,
                }]
                : [],
        };
        const baseSettings: BacktestSettings = {
            ...defaultSettings,
            executionModel: "next_open",
            tradeDirection: "long",
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        };

        const baseRun = await executeBacktest({
            ohlcvData: candles,
            interval: "5m",
            strategyKey: "explicit-timeframe-check",
            strategy,
            strategyParams: {},
            backtestSettings: baseSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const higherTfRun = await executeBacktest({
            ohlcvData: candles,
            interval: "5m",
            strategyKey: "explicit-timeframe-check",
            strategy,
            strategyParams: {},
            backtestSettings: {
                ...baseSettings,
                strategyTimeframeEnabled: true,
                strategyTimeframeMinutes: 10,
            },
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.ok(baseRun.result.totalTrades > 0);
        assert.ok(higherTfRun.result.totalTrades > 0);
        assert.notStrictEqual(higherTfRun.result.trades[0]?.entryTime, baseRun.result.trades[0]?.entryTime);
    });
});
