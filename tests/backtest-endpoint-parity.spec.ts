import { describe, it } from "node:test";
import assert from "node:assert";
import { executeBacktest, getManifestFingerprint } from "../lib/backtest-executor";
import type { OHLCVData, BacktestSettings, Signal, Strategy, Time } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import { strategyManifest } from "../lib/strategies/manifest-eager";

const defaultStrategyEntry = strategyManifest.find((entry) => !entry.strategy.crossSymbolConfig);
assert.ok(defaultStrategyEntry, "Expected at least one non-cross-symbol strategy in manifest");
const defaultStrategyKey = defaultStrategyEntry!.key;
const defaultStrategyParams = { ...defaultStrategyEntry!.strategy.defaultParams };

function pseudoNoise(index: number, salt = 0): number {
    const raw = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return raw - Math.floor(raw);
}

const sampleCandles: OHLCVData[] = Array.from({ length: 500 }, (_, i) => ({
    time: (1700000000 + i * 300) as Time, // 5m candles
    open: 100 + Math.sin(i * 0.1) * 5,
    high: 105 + Math.sin(i * 0.1) * 5,
    low: 95 + Math.sin(i * 0.1) * 5,
    close: 100 + Math.sin(i * 0.1) * 5 + (pseudoNoise(i) - 0.5),
    volume: 1000 + pseudoNoise(i, 1) * 500,
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

describe("backtest executor", () => {
    it("returns a manifest fingerprint", () => {
        const fp = getManifestFingerprint();
        assert.ok(fp.strategyCount > 0, "Should have at least one strategy");
        assert.ok(fp.strategyKeys.length > 0, "Should have keys");
        assert.ok(fp.hash.length > 0, "Should have a hash");
    });

    it("executes a basic backtest with explicit inputs", async () => {
        const result = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: Math.floor(Date.now() / 1000) + 600, // simulate time past last candle
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.ok(result.engineUsed === "typescript");
        assert.ok(result.result.totalTrades >= 0);
        assert.ok(result.result.equityCurve.length > 0);
    });

    it("returns same result for deterministic inputs", async () => {
        const run1 = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: 1700003000,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const run2 = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: 1700003000,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.strictEqual(run1.result.totalTrades, run2.result.totalTrades);
        assert.strictEqual(run1.result.winRate, run2.result.winRate);
        assert.strictEqual(run1.result.netProfit, run2.result.netProfit);
        assert.strictEqual(run1.engineUsed, run2.engineUsed);
    });

    it("keeps bulk compact backtest summary metrics aligned while omitting chart artifacts", async () => {
        const candles: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1000 },
            { time: 3 as Time, open: 102, high: 104, low: 101, close: 103, volume: 1000 },
            { time: 4 as Time, open: 103, high: 104, low: 100, close: 101, volume: 1000 },
            { time: 5 as Time, open: 101, high: 102, low: 98, close: 99, volume: 1000 },
            { time: 6 as Time, open: 99, high: 100, low: 97, close: 98, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: "buy", price: 100, barIndex: 0 },
            { time: 4 as Time, type: "sell", price: 101, barIndex: 3 },
            { time: 5 as Time, type: "buy", price: 99, barIndex: 4 },
        ];
        const strategy: Strategy = {
            name: "Bulk Compact Executor Test",
            description: "Emits deterministic signals for compact bulk executor parity.",
            defaultParams: {},
            paramLabels: {},
            execute: () => signals,
        };
        const request = {
            ohlcvData: candles,
            interval: "1d",
            strategyKey: "bulk_compact_executor_test",
            strategy,
            strategyParams: {},
            backtestSettings: {
                executionModel: "signal_close" as const,
                tradeDirection: "combined" as const,
                allowSameBarExit: true,
                slippageBps: 0,
            },
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript" as const,
            },
            backtestRunOptions: {
                includeAdvancedAnalytics: false,
                includeSharpeRatio: false,
            },
        };

        const full = await executeBacktest(request);
        const compact = await executeBacktest({
            ...request,
            backtestRunOptions: {
                ...request.backtestRunOptions,
                omitEquityCurve: true,
                skipResultPostProcessing: true,
            },
        });

        assert.strictEqual(compact.result.totalTrades, full.result.totalTrades);
        assert.ok(Math.abs(compact.result.netProfit - full.result.netProfit) < 1e-9);
        assert.ok(Math.abs(compact.result.maxDrawdown - full.result.maxDrawdown) < 1e-6);
        assert.strictEqual(compact.result.sharpeRatio, 0);
        assert.deepStrictEqual(compact.result.equityCurve, []);
        assert.deepStrictEqual(compact.result.trades, []);
    });

    it("uses compact execution when a bulk caller needs scalar Sharpe but not the equity curve", async () => {
        const candles: OHLCVData[] = Array.from({ length: 72 }, (_, index) => {
            const open = 100 + Math.sin(index / 3) * 4;
            const close = open + Math.cos(index / 2) * 1.5;
            return {
                time: (1700000000 + index * 4 * 60 * 60) as Time,
                open,
                high: Math.max(open, close) + 1,
                low: Math.min(open, close) - 1,
                close,
                volume: 1000 + index * 10,
            };
        });
        const signals: Signal[] = [];
        for (let index = 0; index < candles.length; index += 6) {
            signals.push({
                time: candles[index].time,
                type: (index / 6) % 2 === 0 ? "buy" : "sell",
                price: candles[index].close,
                barIndex: index,
            });
        }
        const strategy: Strategy = {
            name: "Bulk Scalar Sharpe Test",
            description: "Produces deterministic alternating signals.",
            defaultParams: {},
            paramLabels: {},
            execute: () => signals,
        };
        const request = {
            ohlcvData: candles,
            interval: "4h",
            strategyKey: "bulk_scalar_sharpe_test",
            strategy,
            strategyParams: {},
            backtestSettings: {
                executionModel: "next_open" as const,
                tradeDirection: "both" as const,
                maxOpenTrades: 1,
                slippageBps: 0,
            },
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript" as const,
            },
            backtestRunOptions: {
                includeAdvancedAnalytics: false,
                includeSharpeRatio: true,
                collectDiagnostics: true,
            },
        };

        const full = await executeBacktest(request);
        const compact = await executeBacktest({
            ...request,
            backtestRunOptions: {
                ...request.backtestRunOptions,
                omitEquityCurve: true,
                skipDrawdown: true,
                skipResultPostProcessing: true,
            },
        });

        assert.ok(Math.abs(compact.result.netProfit - full.result.netProfit) < 1e-9);
        assert.ok(Math.abs(compact.result.sharpeRatio - full.result.sharpeRatio) < 1e-9);
        assert.deepStrictEqual(compact.result.equityCurve, []);
        assert.deepStrictEqual(compact.result.trades, []);
        assert.strictEqual(compact.result.diagnostics?.fastPath?.used, true);
    });

    it("returns an empty bulk result without chart artifacts when a strategy emits no signals", async () => {
        const strategy: Strategy = {
            name: "No Signal Bulk Executor Test",
            description: "Confirms bulk no-signal runs stay lightweight.",
            defaultParams: {},
            paramLabels: {},
            execute: () => [],
        };

        const run = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: "no_signal_bulk_executor_test",
            strategy,
            strategyParams: {},
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: 9999999999,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
            backtestRunOptions: {
                includeAdvancedAnalytics: false,
                includeSharpeRatio: false,
                omitEquityCurve: true,
                skipResultPostProcessing: true,
            },
        });

        assert.deepStrictEqual(run.signals, []);
        assert.strictEqual(run.result.totalTrades, 0);
        assert.deepStrictEqual(run.result.equityCurve, []);
        assert.deepStrictEqual(run.result.trades, []);
    });

    it("requires confirmation strategies to agree with both entry and exit signals", async () => {
        const candles: OHLCVData[] = [
            { time: 1 as Time, open: 10, high: 11, low: 9, close: 10, volume: 1000 },
            { time: 2 as Time, open: 10, high: 12, low: 10, close: 11.8, volume: 1000 },
            { time: 3 as Time, open: 11.8, high: 13, low: 11, close: 12.5, volume: 1000 },
            { time: 4 as Time, open: 12.5, high: 13, low: 8, close: 8.5, volume: 1000 },
            { time: 5 as Time, open: 8.5, high: 9, low: 7, close: 8, volume: 1000 },
        ];
        const primaryStrategy: Strategy = {
            name: "Confirmation Executor Test",
            description: "Emits entries and exits that must be confirmed by a secondary strategy.",
            defaultParams: {},
            paramLabels: {},
            execute: (data): Signal[] => {
                const signals: Signal[] = [
                    { time: data[1].time, type: "buy", price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: "buy", price: data[2].close, barIndex: 2 },
                    { time: data[3].time, type: "sell", price: data[3].close, barIndex: 3 },
                ];
                if (data[4]) {
                    signals.push({ time: data[4].time, type: "sell", price: data[4].close, barIndex: 4 });
                }
                return signals;
            },
        };

        const result = await executeBacktest({
            ohlcvData: candles,
            interval: "1m",
            strategyKey: "__test_confirmation_executor__",
            strategy: primaryStrategy,
            strategyParams: {},
            backtestSettings: {
                ...defaultSettings,
                tradeDirection: "long",
                executionModel: "signal_close",
                confirmationStrategiesToggle: true,
                confirmationStrategies: ["close_location_median_alignment"],
                confirmationStrategyParams: {
                    close_location_median_alignment: { lookback: 2 },
                },
            },
            capitalSettings: defaultCapital,
            context: {
                nowSec: 10,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.deepStrictEqual(
            result.signals.map((signal) => [signal.time, signal.type]),
            [
                [3 as Time, "buy"],
                [4 as Time, "sell"],
            ]
        );
    });

    it("throws on missing strategy", async () => {
        await assert.rejects(
            executeBacktest({
                ohlcvData: sampleCandles,
                interval: "5m",
                strategyKey: "nonexistent_strategy",
                strategyParams: {},
                backtestSettings: defaultSettings,
                capitalSettings: defaultCapital,
                context: {
                    nowSec: 1700003000,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                },
            }),
            /Strategy not found/
        );
    });

    it("respects blockRange filter", async () => {
        // Filter to a small subset of candles
        const midTime = sampleCandles[Math.floor(sampleCandles.length / 2)].time as number;
        const fullResult = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: Math.floor(Date.now() / 1000) + 600,
                blockRange: null, // no block filter
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const narrowResult = await executeBacktest({
            ohlcvData: sampleCandles,
            interval: "5m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: Math.floor(Date.now() / 1000) + 600,
                blockRange: { from: midTime - 1000, to: midTime + 1000 },
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        const fullCount = fullResult.result.marketContext?.candleCount ?? 0;
        const narrowCount = narrowResult.result.marketContext?.candleCount ?? 0;
        assert.ok(fullCount > 0, "Full run should have candles");
        assert.ok(narrowCount < fullCount, `Narrow range (${narrowCount}) should have fewer candles than full (${fullCount})`);
    });

    it("works with 1m interval", async () => {
        const oneMinCandles: OHLCVData[] = Array.from({ length: 1000 }, (_, i) => ({
            time: (1700000000 + i * 60) as Time,
            open: 100 + Math.sin(i * 0.05) * 3,
            high: 103 + Math.sin(i * 0.05) * 3,
            low: 97 + Math.sin(i * 0.05) * 3,
            close: 100 + Math.sin(i * 0.05) * 3 + (pseudoNoise(i, 2) - 0.5) * 0.5,
            volume: 500 + pseudoNoise(i, 3) * 200,
        }));

        const result = await executeBacktest({
            ohlcvData: oneMinCandles,
            interval: "1m",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: Math.floor(Date.now() / 1000) + 120,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.ok(result.result.totalTrades >= 0);
    });

    it("works with 4h interval", async () => {
        const fourHourCandles: OHLCVData[] = Array.from({ length: 500 }, (_, i) => ({
            time: (1700000000 + i * 14400) as Time,
            open: 100 + i * 0.1,
            high: 102 + i * 0.1,
            low: 98 + i * 0.1,
            close: 100 + i * 0.1 + (pseudoNoise(i, 4) - 0.5),
            volume: 2000 + pseudoNoise(i, 5) * 1000,
        }));

        const result = await executeBacktest({
            ohlcvData: fourHourCandles,
            interval: "4h",
            strategyKey: defaultStrategyKey,
            strategyParams: defaultStrategyParams,
            backtestSettings: defaultSettings,
            capitalSettings: defaultCapital,
            context: {
                nowSec: Math.floor(Date.now() / 1000) + 15000,
                blockRange: null,
                annotatePolymarket: false,
                engineMode: "typescript",
            },
        });

        assert.ok(result.result.totalTrades >= 0);
    });
});
