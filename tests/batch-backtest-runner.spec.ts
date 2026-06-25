import { expect } from "chai";
import { describe, it } from "node:test";
import {
    parseBatchSymbols,
    runBatchBacktest,
} from "../lib/batch-backtest/batch-backtest-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

function makeCandles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + (index * 300)) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    }));
}

const testStrategy: Strategy = {
    name: "Batch Test",
    description: "Deterministic strategy for batch-runner tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data, params) {
        if (data.length < 3) return [];
        const entryIndex = Math.max(0, Math.min(data.length - 2, Math.round(params.threshold) - 1));
        return [
            { time: data[entryIndex]!.time, type: "buy", price: data[entryIndex]!.close },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
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
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

describe("parseBatchSymbols", () => {
    it("splits on newlines, commas, and whitespace", () => {
        expect(parseBatchSymbols("BTCUSDT\nETHUSDT, SOLUSDT  PAXGUSDT"))
            .to.deep.equal(["BTCUSDT", "ETHUSDT", "SOLUSDT", "PAXGUSDT"]);
    });

    it("uppercases and trims", () => {
        expect(parseBatchSymbols("  btcusdt  ")).to.deep.equal(["BTCUSDT"]);
    });

    it("preserves synthetic pair tokens", () => {
        expect(parseBatchSymbols("zec+apt")).to.deep.equal(["ZEC+APT"]);
    });

    it("dedupes while preserving first-seen order", () => {
        expect(parseBatchSymbols("BTCUSDT\nETHUSDT\nBTCUSDT")).to.deep.equal(["BTCUSDT", "ETHUSDT"]);
    });

    it("drops empty tokens", () => {
        expect(parseBatchSymbols("\n  \n,\n")).to.deep.equal([]);
    });
});

describe("runBatchBacktest", () => {
    it("runs the current strategy across every pair and reports per-symbol status", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            // uptrend -> profitable
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            // downtrend -> losing
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const statuses = new Map<string, string>();

        const output = await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP", "DOWN", "MISSING"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                onSymbolComplete: (_i, r) => statuses.set(r.symbol, r.status),
                isCancelled: () => false,
            },
        );

        // MISSING returns [] -> load_failed, not a thrown error.
        expect(output.failedSymbols).to.deep.equal(["MISSING"]);
        expect(output.loadedSymbols).to.equal(2);
        expect(output.results.map((r) => r.symbol)).to.deep.equal(["UP", "DOWN", "MISSING"]);

        const up = output.results.find((r) => r.symbol === "UP")!;
        const down = output.results.find((r) => r.symbol === "DOWN")!;
        const missing = output.results.find((r) => r.symbol === "MISSING")!;

        expect(up.status).to.equal("profitable");
        expect(up.result!.totalTrades).to.be.greaterThan(0);
        expect(up.barCount).to.equal(5);
        expect(down.status).to.equal("losing");
        expect(missing.status).to.equal("load_failed");
        expect(missing.barCount).to.equal(0);
        expect(statuses.get("UP")).to.equal("profitable");
        expect(statuses.get("MISSING")).to.equal("load_failed");
    });

    it("stops the loop and fills remaining slots on cancel", async () => {
        let calls = 0;
        const datasets = new Map<string, OHLCVData[]>([
            ["A", makeCandles([100, 105, 110, 115, 120])],
        ]);
        const output = await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["A", "B", "C"],
                loadDataset: (symbol) => {
                    calls += 1;
                    return Promise.resolve(datasets.get(symbol) ?? datasets.get("A")!);
                },
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                isCancelled: () => calls >= 1, // cancel after the first load completes
            },
        );

        // Loop breaks after the first symbol; remaining slots are filled as skipped.
        expect(output.results.length).to.equal(3);
        const skipped = output.results.filter((r) => r.error === "Skipped (cancelled).");
        expect(skipped.length).to.be.greaterThan(0);
    });
});

