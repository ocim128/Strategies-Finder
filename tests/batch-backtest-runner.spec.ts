import { expect } from "chai";
import { describe, it } from "node:test";
import {
    BATCH_MIN_USABLE_BARS,
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

    it("preserves IBKR bullet markers in synthetic pair tokens", () => {
        expect(parseBatchSymbols("nvda\u2022+aapl\u2022")).to.deep.equal(["NVDA\u2022+AAPL\u2022"]);
    });

    it("preserves IBKR bullet markers in single-symbol tokens", () => {
        expect(parseBatchSymbols("nvda\u2022")).to.deep.equal(["NVDA\u2022"]);
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
                // Fixtures are intentionally compact (5 bars); the default
                // threshold would refuse them. The minimum-bars gate itself is
                // exercised by the "refuses stale fragment" test below.
                minUsableBars: 1,
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
        expect(up.tradeSummary?.avgHoldBars).to.equal(4);
        expect(up.tradeSummary?.maxHoldBars).to.equal(4);
        expect(up.tradeSummary?.avgHoldDays).to.be.closeTo(20 / 1440, 0.000001);
        expect(up.tradeSummary?.maxHoldDays).to.be.closeTo(20 / 1440, 0.000001);
        expect(up.tradeSummary?.exposurePercent).to.equal(100);
        expect(up.barCount).to.equal(5);
        expect(down.status).to.equal("losing");
        expect(missing.status).to.equal("load_failed");
        expect(missing.barCount).to.equal(0);
        expect(statuses.get("UP")).to.equal("profitable");
        expect(statuses.get("MISSING")).to.equal("load_failed");
    });

    it("preloads confirmation strategies before replaying the batch", async () => {
        const output = await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 10 },
                backtestSettings: {
                    ...settings,
                    confirmationStrategies: ["ema_confirmation"],
                    confirmationStrategyParams: { ema_confirmation: { emaPeriod: 5 } },
                },
                capitalSettings,
                symbols: ["UP"],
                loadDataset: () =>
                    Promise.resolve(makeCandles(Array.from({ length: 30 }, (_, i) => 100 + i))),
                minUsableBars: 1,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                isCancelled: () => false,
            },
        );

        const result = output.results[0]!;
        expect(output.failedSymbols).to.deep.equal([]);
        expect(result.status).to.equal("profitable");
        expect(result.result!.totalTrades).to.be.greaterThan(0);
    });

    it("can prune returned row artifacts after the completion callback receives them", async () => {
        let callbackRowDataLength = 0;
        let callbackTradeCount = 0;
        const output = await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP+DOWN"],
                loadDataset: () => Promise.resolve(makeCandles([100, 105, 110, 115, 120])),
                minUsableBars: 1,
                pruneResultArtifacts: true,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                onSymbolComplete: (_index, row) => {
                    callbackRowDataLength = row.data?.length ?? 0;
                    callbackTradeCount = row.result?.trades.length ?? 0;
                },
                isCancelled: () => false,
            },
        );

        expect(callbackRowDataLength).to.equal(5);
        expect(callbackTradeCount).to.be.greaterThan(0);
        const stored = output.results[0]!;
        expect(stored.data).to.equal(undefined);
        expect(stored.signals).to.equal(undefined);
        expect(stored.result?.trades).to.deep.equal([]);
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
                minUsableBars: 1,
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

    it("refuses a stale cache fragment below the minimum bar threshold as a load failure", async () => {
        // Reproduces the reported bug: pairs whose offline cache held only a
        // streaming-leftover fragment (e.g. 16 bars over a single day) used to
        // run a degenerate backtest and surface as "No Trades". The runner must
        // refuse such datasets with an explicit, diagnosable load failure.
        const fragment = makeCandles(Array.from({ length: 16 }, (_, i) => 100 + i));
        const full = makeCandles(Array.from({ length: 300 }, (_, i) => 100 + i));

        const output = await runBatchBacktest(
            {
                interval: "15m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["STALE", "HEALTHY"],
                loadDataset: (symbol) =>
                    Promise.resolve(symbol === "STALE" ? fragment : full),
                // Default threshold exercises the production code path.
            },
            { setProgress: () => {}, setStatus: () => {}, isCancelled: () => false },
        );

        expect(output.failedSymbols).to.deep.equal(["STALE"]);
        expect(output.loadedSymbols).to.equal(1);

        const stale = output.results.find((r) => r.symbol === "STALE")!;
        const healthy = output.results.find((r) => r.symbol === "HEALTHY")!;

        expect(stale.status).to.equal("load_failed");
        expect(stale.barCount).to.equal(16);
        expect(stale.error).to.contain("Insufficient bars (16 <");
        expect(stale.result).to.equal(undefined);

        expect(healthy.status).to.equal("profitable");
        expect(healthy.barCount).to.equal(300);
    });

    it("default minimum bar threshold is 200", () => {
        // Guards the production constant against an accidental drift that would
        // either let fragments through (too low) or reject real short datasets
        // (too high). 200 sits above every built-in strategy lookback (~30 max)
        // and well below any real full-length dataset (~65k).
        expect(BATCH_MIN_USABLE_BARS).to.equal(200);
    });

    it("fires onSymbolStart once per attempted symbol before load/backtest", async () => {
        // Finding 6: onSymbolStart must fire exactly once per symbol the runner
        // attempts, in order, including load_failed rows (so the server plugin
        // can surface currentSymbol mid-run). It is skipped for symbols never
        // reached because of a cancel-bail at the loop head.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
            // MISSING -> load_failed; onSymbolStart must still fire for it.
        ]);
        const starts: Array<{ index: number; symbol: string }> = [];

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
                minUsableBars: 1,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                onSymbolStart: (index, symbol) => starts.push({ index, symbol }),
                isCancelled: () => false,
            },
        );

        expect(output.results.map((r) => r.symbol)).to.deep.equal(["UP", "DOWN", "MISSING"]);
        // Fires once per symbol, in order, with the correct index.
        expect(starts).to.deep.equal([
            { index: 0, symbol: "UP" },
            { index: 1, symbol: "DOWN" },
            { index: 2, symbol: "MISSING" },
        ]);
    });

    it("does not fire onSymbolStart for symbols never reached due to cancel", async () => {
        // When isCancelled flips true at the loop head, the iteration breaks
        // before reading its symbol, so onSymbolStart must NOT fire for it.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
            ["FLAT", makeCandles([100, 100, 100, 100, 100])],
        ]);
        const starts: string[] = [];
        let calls = 0;

        await runBatchBacktest(
            {
                interval: "5m",
                strategyKey: "batch_test",
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP", "DOWN", "FLAT"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                onSymbolStart: (_i, symbol) => starts.push(symbol),
                // Cancel at the loop head of the 2nd iteration: the 1st symbol
                // runs (start fires), the 2nd is cancelled at the loop head
                // before its symbol is read (no start), the 3rd never reached.
                isCancelled: () => (calls += 1) >= 2,
            },
        );

        expect(starts).to.deep.equal(["UP"]);
    });
});

