import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeScanPair, scanEndpointVote } from "../lib/batch-backtest/top-raw-scan-execution";
import { executeBacktest } from "../lib/backtest-executor";
import { strategies } from "../lib/strategies/library";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";
import type { ScanRequest } from "../lib/batch-backtest/top-raw-scan-contract";
import { makeBacktestSettings, makeCapitalSettings } from "./helpers/backtest-settings-fixtures";
import { rustEngine } from "../lib/rust-engine-client";
import { processScanWorkerTask } from "../lib/batch-backtest/top-raw-scan-worker";
import { buildSyntheticPairFromLegs } from "../scripts/lib/synthetic-pair";

const pair = { key: "AAPL•|MSFT•", base: "AAPL•", quote: "MSFT•", symbol: "AAPL•+MSFT•" };
const candles: OHLCVData[] = Array.from({ length: 341 }, (_, i) => {
    const close = 100 + 12 * Math.sin(i / 12) + i * 0.02;
    return { time: (1700000000 + i * 14400) as Time, open: close - 0.1, close, high: close + 1, low: close - 1, volume: 1000 };
});
const asOf = Number(candles[339]!.time), cutoff = asOf + 14400;
const request = (settings: BacktestSettings = {}): ScanRequest => ({ runId: "execution", strategyKey: "dema_confirmation", strategyParams: { lookback: 20 }, backtestSettings: makeBacktestSettings(settings), capitalSettings: makeCapitalSettings(), interval: "4h", assetListText: "AAPL•\nMSFT•", opponentsPerAsset: 1, finalistCount: 2, seed: 1, useRustEnginePreference: false });
describe("TOP_RAW endpoint execution", () => {
    it("sums every forced endpoint close and excludes real exits", () => {
        assert.deepEqual(scanEndpointVote([{ type: "long", exitReason: "end_of_data" }, { type: "long", exitReason: "end_of_data" }, { type: "short", exitReason: "end_of_data" }, { type: "long", exitReason: "signal" }, { type: "short", exitReason: "stop_loss" }]), { vote: 1, active: 3 });
        assert.deepEqual(scanEndpointVote([]), { vote: 0, active: 0 });
        assert.deepEqual(scanEndpointVote([{ type: "long", exitReason: "time_stop" }]), { vote: 0, active: 0 });
    });
    it("matches ordinary full configured backtests across directions, exits, sizing and execution models", async () => {
        let referencesWithPositions = 0, referencesWithExits = 0, multiplePositions = 0;
        for (const executionModel of ["signal_close", "next_open", "next_close"] as const) {
            for (const tradeDirection of ["long", "short", "both", "combined"] as const) {
                for (const variant of [
                    { disableSignalExits: true, maxOpenTrades: 3 },
                    { timeStopBars: 2, disableSignalExits: false, maxOpenTrades: 1 },
                    { disableSignalExits: true, exitStrategyOverrideEnabled: true, exitStrategyKey: "dema_confirmation", exitStrategyParams: { lookback: 7 }, takeProfitEnabled: true, takeProfitPercent: 1 },
                ]) {
                    const req = request({ executionModel, tradeDirection, ...variant });
                    const reference = await executeBacktest({ ohlcvData: candles, interval: req.interval, primarySymbol: pair.symbol, strategyKey: req.strategyKey, strategy: strategies[req.strategyKey]!, strategyParams: req.strategyParams, backtestSettings: req.backtestSettings, capitalSettings: req.capitalSettings, context: { blockRange: null, engineMode: "auto", useRustEnginePreference: false, nowSec: cutoff } });
                    let vote = 0, active = 0;
                    for (const trade of reference.result.trades) {
                        if (trade.exitReason === "end_of_data") { vote += trade.type === "long" ? 1 : -1; active++; }
                        else referencesWithExits++;
                    }
                    if (active) referencesWithPositions++; if (active > 1) multiplePositions++;
                    const actual = await executeScanPair(pair, req, asOf, cutoff, async () => candles);
                    assert.equal(actual.vote, vote, `${executionModel}/${tradeDirection}/${JSON.stringify(variant)}`); assert.equal(actual.active, active);
                    assert.equal(actual.engine, "typescript");
                }
            }
        }
        assert.ok(referencesWithPositions > 0); assert.ok(referencesWithExits > 0); assert.ok(multiplePositions > 0);
    });
    it("rejects stale/missing endpoints and preserves Rust preference fallback", async () => {
        await assert.rejects(executeScanPair(pair, request(), asOf, cutoff, async () => candles.slice(0, 339)), /frozen endpoint/);
        const req = request({ executionModel: "signal_close", tradeDirection: "long" });
        const ts = await executeScanPair(pair, req, asOf, cutoff, async () => candles);
        const preferred = await executeScanPair(pair, { ...req, useRustEnginePreference: true }, asOf, cutoff, async () => candles);
        assert.equal(preferred.vote, ts.vote); assert.equal(preferred.active, ts.active);
        assert.ok(["typescript", "rust"].includes(preferred.engine));
        console.log(`Rust preference executed ${preferred.engine}; endpoint votes match TypeScript.`);
        const health = rustEngine.checkHealth;
        try {
            rustEngine.checkHealth = async () => false;
            const fallback = await executeScanPair(pair, { ...req, useRustEnginePreference: true }, asOf, cutoff, async () => candles);
            assert.equal(fallback.engine, "typescript"); assert.equal(fallback.vote, ts.vote); assert.equal(fallback.active, ts.active);
        } finally { rustEngine.checkHealth = health; }
    });
    it("uses aligned 30m ratios before 4h aggregation", async () => {
        const base = Array.from({ length: 1608 }, (_, i) => ({ time: (1700006400 + i * 1800) as Time, open: 100 + i % 8, high: 109 + i % 4, low: 95, close: 101 + i % 8, volume: 1000 }));
        const quote = base.map((bar, i) => ({ ...bar, open: 20 + i % 3, high: 25, low: 18, close: 21 + i % 3 }));
        const result = await buildSyntheticPairFromLegs({ baseSymbol: "AAPL•", quoteSymbol: "MSFT•", interval: "4h", targetBars: 201, fetchLeg: async (symbol, sourceInterval) => { assert.equal(sourceInterval, "30m"); return symbol === "AAPL•" ? base : quote; } });
        assert.ok(result.bars.length >= 200);
        const first = result.bars[0]!; assert.equal(first.open, base[0]!.open / quote[0]!.open);
    });
    it("allows Rust availability fallback while rejecting a changed live producer", async () => {
        const health = rustEngine.checkHealth, version = Object.getOwnPropertyDescriptor(rustEngine, "version");
        try {
            rustEngine.checkHealth = async () => true;
            const identity = await processScanWorkerTask({ type: "engine_identity", useRust: true }) as string;
            const task = { type: "pairs" as const, pairs: [], request: { ...request(), useRustEnginePreference: true }, asOf, cutoff, sources: [], engineIdentity: identity };
            rustEngine.checkHealth = async () => false;
            assert.deepEqual(await processScanWorkerTask(task), []);
            rustEngine.checkHealth = async () => { throw new Error("Frozen TypeScript must not depend on Rust availability."); };
            assert.deepEqual(await processScanWorkerTask({ ...task, engineIdentity: "typescript_only" }), []);
            rustEngine.checkHealth = async () => true;
            Object.defineProperty(rustEngine, "version", { configurable: true, get: () => "changed-version" });
            await assert.rejects(processScanWorkerTask(task), /version\/capability changed/);
        } finally {
            rustEngine.checkHealth = health;
            if (version) Object.defineProperty(rustEngine, "version", version); else Reflect.deleteProperty(rustEngine, "version");
        }
    });
});
