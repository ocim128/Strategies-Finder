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

    it("falls back to TypeScript when Rust rejects the request size", async () => {
        const original = rustEngine.runBacktestWithStatus;
        rustEngine.runBacktestWithStatus = async () => ({
            ok: false as const,
            reason: "request_too_large" as const,
            message: "request exceeded 4 bytes",
        });

        try {
            const result = await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol: "SIZE_FALLBACK",
                strategyKey: "size_fallback_test",
                strategy,
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    engineMode: "rust_preferred",
                },
            });

            assert.strictEqual(result.engineUsed, "typescript");
            assert.strictEqual(result.engineDiagnostics?.rustAttempted, true);
            assert.strictEqual(result.engineDiagnostics?.typescriptReason, "request_too_large");
            assert.ok(result.result.totalTrades >= 0);
        } finally {
            rustEngine.runBacktestWithStatus = original;
        }
    });

    it("falls back to TypeScript when Rust rejects the response size", async () => {
        const original = rustEngine.runBacktestWithStatus;
        rustEngine.runBacktestWithStatus = async () => ({
            ok: false as const,
            reason: "response_too_large" as const,
            message: "response exceeded 64 bytes",
        });

        try {
            const result = await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol: "RESPONSE_SIZE_FALLBACK",
                strategyKey: "response_size_fallback_test",
                strategy,
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    engineMode: "rust_preferred",
                },
            });

            assert.strictEqual(result.engineUsed, "typescript");
            assert.strictEqual(result.engineDiagnostics?.typescriptReason, "response_too_large");
        } finally {
            rustEngine.runBacktestWithStatus = original;
        }
    });

    it("falls back to TypeScript when the real client rejects a malformed HTTP result", async () => {
        // The executor no longer re-validates Rust output: the concrete
        // client's malformed_response rejection must be the acceptance
        // boundary that sends this run to TypeScript.
        await expectMalformedHttpFallback(
            "MALFORMED_HTTP_FALLBACK",
            "malformed_http_fallback_test",
            { trades: "not-an-array" },
        );
    });

    it("falls back to TypeScript when a malformed trade or equity entry slips past the summary metrics", async () => {
        // Audit repro: every summary metric reconciles, but the returned
        // history entries are garbage. The validator must reject the whole
        // result so the executor replays the run in TypeScript.
        await expectMalformedHttpFallback(
            "MALFORMED_ENTRIES_FALLBACK",
            "malformed_entries_fallback_test",
            {
                trades: [{ exitReason: "signal" }],
                equityCurve: [{ time: 1, value: "invalid-equity" }],
                netProfit: 0,
                netProfitPercent: 0,
                winRate: 0,
                expectancy: 0,
                avgTrade: 0,
                profitFactor: 0,
                maxDrawdown: 0,
                maxDrawdownPercent: 0,
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                avgWin: 0,
                avgLoss: 0,
                sharpeRatio: 0,
            },
        );
    });

    async function expectMalformedHttpFallback(
        primarySymbol: string,
        strategyKey: string,
        malformedBody: Record<string, unknown>,
    ): Promise<void> {
        const originalCheckHealth = rustEngine.checkHealth;
        const clientInternals = rustEngine as unknown as { fetchImpl: typeof fetch };
        const originalFetchImpl = clientInternals.fetchImpl;
        rustEngine.checkHealth = async () => true;
        clientInternals.fetchImpl = (async () => new Response(
            JSON.stringify(malformedBody),
            { status: 200 },
        )) as typeof fetch;

        try {
            const result = await executeBacktest({
                ohlcvData: candles,
                interval: "1h",
                primarySymbol,
                strategyKey,
                strategy,
                strategyParams: {},
                backtestSettings: settings,
                capitalSettings: capital,
                context: {
                    nowSec: 9_999_999_999,
                    blockRange: null,
                    engineMode: "rust_preferred",
                },
            });

            assert.strictEqual(result.engineUsed, "typescript");
            assert.strictEqual(result.engineDiagnostics?.rustAttempted, true);
            assert.strictEqual(result.engineDiagnostics?.typescriptReason, "malformed_response");
            assert.ok(result.result.totalTrades >= 0);
        } finally {
            rustEngine.checkHealth = originalCheckHealth;
            clientInternals.fetchImpl = originalFetchImpl;
        }
    }
});
