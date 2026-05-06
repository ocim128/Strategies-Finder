import { describe, it } from "node:test";
import assert from "node:assert";
import { executeBacktest, getManifestFingerprint } from "../lib/backtest-executor";
import type { OHLCVData, BacktestSettings, Time } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import { strategyManifest } from "../lib/strategies/manifest";

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
