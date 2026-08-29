import { expect } from "chai";
import { describe, it } from "node:test";
import assert from "node:assert";
import { runFinderExecution } from "../lib/finder/finder-runner";
import { rustEngine } from "../lib/rust-engine-client";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const candles: OHLCVData[] = Array.from({ length: 8 }, (_value, index) => ({
    time: (1_700_000_000 + index * 300) as Time,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000,
}));

const strategy: Strategy = {
    name: "Rust Batch Cancellation",
    description: "Generates one deterministic candidate for cancellation coverage.",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        const first = data[0];
        const last = data.at(-1);
        return first && last
            ? [
                { time: first.time, type: "buy", price: first.close },
                { time: last.time, type: "sell", price: last.close },
            ]
            : [];
    },
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

const options: FinderOptions = {
    scope: "current_chart",
    mode: "random",
    sortPriority: ["netProfit"],
    useAdvancedSort: false,
    topN: 1,
    steps: 1,
    rangePercent: 0,
    maxRuns: 1,
    tradeFilterEnabled: false,
    minTrades: 0,
    maxTrades: Number.POSITIVE_INFINITY,
    dataSlice: "all",
};

describe("Finder generic Rust batch cancellation", () => {
    it("passes the run signal to Rust and does not fall back after cancellation", async () => {
        const controller = new AbortController();
        const savedDocument = (globalThis as any).document;
        const originalCheckHealth = rustEngine.checkHealth;
        const originalRunBatch = rustEngine.runBatchBacktestWithStatus;
        let observedSignal: AbortSignal | undefined;
        let resolveObserved!: () => void;
        const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });

        (globalThis as any).document = { getElementById: () => ({ checked: true }) };
        rustEngine.checkHealth = async () => true;
        rustEngine.runBatchBacktestWithStatus = async (...args) => {
            observedSignal = args[8]?.signal;
            resolveObserved();
            return new Promise((resolve) => {
                observedSignal?.addEventListener(
                    "abort",
                    () => resolve({ ok: false, reason: "cancelled" as const }),
                    { once: true },
                );
            });
        };

        try {
            const run = runFinderExecution(
                {
                    ohlcvData: candles,
                    symbol: "TEST",
                    interval: "5m",
                    options,
                    settings,
                    requiresTsEngine: false,
                    selectedStrategies: [{ key: "rust_cancel", name: strategy.name, strategy }],
                    capitalSettings,
                    generateParamSets: () => [{}],
                    signal: controller.signal,
                },
                {
                    setProgress: () => undefined,
                    setStatus: () => undefined,
                    yieldControl: async () => undefined,
                    isCancelled: () => false,
                    onResultsUpdate: () => undefined,
                },
            );

            await observed;
            expect(observedSignal).to.equal(controller.signal);
            controller.abort();

            await assert.rejects(run, /Finder cancelled/);
        } finally {
            rustEngine.checkHealth = originalCheckHealth;
            rustEngine.runBatchBacktestWithStatus = originalRunBatch;
            if (savedDocument === undefined) delete (globalThis as any).document;
            else (globalThis as any).document = savedDocument;
        }
    });
});
