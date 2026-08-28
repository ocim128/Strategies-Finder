import assert from "node:assert";
import { describe, it } from "node:test";
import { executeBacktest } from "../lib/backtest-executor";
import { rustEngine } from "../lib/rust-engine-client";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const candles: OHLCVData[] = [
    { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
    { time: 2 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1_000 },
];

const capital: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "fixed",
    fixedTradeAmount: 1_000,
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
};

const strategy: Strategy = {
    name: "Cancellation executor test",
    description: "Produces one deterministic signal for cancellation coverage.",
    defaultParams: {},
    paramLabels: {},
    execute: (data) => [{ time: data[0]!.time, type: "buy", price: data[0]!.close }],
};

describe("backtest executor cancellation", () => {
    it("does not start TypeScript fallback after Rust reports cancellation", async () => {
        const original = rustEngine.runBacktestWithStatus;
        let rustCalls = 0;
        rustEngine.runBacktestWithStatus = async (..._args) => {
            rustCalls += 1;
            return { ok: false, reason: "cancelled" as const };
        };

        let caught: unknown;
        try {
            await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol: "CANCEL",
                strategyKey: "cancellation_executor_test",
                strategy,
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "rust_preferred",
                },
            });
        } catch (error) {
            caught = error;
        } finally {
            rustEngine.runBacktestWithStatus = original;
        }

        assert.ok(caught instanceof Error);
        assert.strictEqual((caught as Error).name, "AbortError");
        assert.strictEqual(rustCalls, 1);
    });

    it("honors an explicit TypeScript engine mode even when Rust is available", async () => {
        const original = rustEngine.runBacktestWithStatus;
        let rustCalls = 0;
        rustEngine.runBacktestWithStatus = async (..._args) => {
            rustCalls += 1;
            throw new Error("explicit TypeScript execution must not call Rust");
        };

        try {
            const result = await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol: "TYPESCRIPT_ONLY",
                strategyKey: "typescript_only_test",
                strategy,
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "typescript",
                    useRustEnginePreference: true,
                },
            });

            assert.strictEqual(result.engineUsed, "typescript");
            assert.strictEqual(rustCalls, 0);
        } finally {
            rustEngine.runBacktestWithStatus = original;
        }
    });

    it("preserves Polymarket exit reasons on the required TypeScript path", async () => {
        for (const exitReason of ["polymarket_take_profit", "polymarket_stop_loss"] as const) {
            const result = await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol: "POLYMARKET_REASON",
                strategyKey: "polymarket_reason_test",
                strategy: {
                    ...strategy,
                    execute: (data) => [
                        { time: data[0]!.time, type: "buy" as const, price: data[0]!.close },
                        { time: data[1]!.time, type: "sell" as const, price: data[1]!.close, reason: exitReason },
                    ],
                },
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "auto",
                    useRustEnginePreference: true,
                    rustCapabilities: [],
                },
            });

            assert.strictEqual(result.engineUsed, "typescript");
            assert.strictEqual(result.result.trades[0]?.exitReason, exitReason);
        }
    });
});
