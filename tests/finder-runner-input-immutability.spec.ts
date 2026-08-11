import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderExecution } from "../lib/finder/finder-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

/**
 * Audit Finding 5: FinderManager.runCurrentChartFinder no longer clones the
 * evaluation dataset up front — `lastFinderEvaluationData` retains the input
 * reference and the defensive copy is made only at the Apply boundary. That
 * is only safe if Finder execution treats the OHLCV input as READ-ONLY. This
 * spec freezes every candle (array + objects) and drives a real current-chart
 * run through `runFinderExecution`; in strict mode any mutation attempt
 * throws, so a passing run is the immutability contract the removed clone
 * depended on.
 */
function makeCandles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_value, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000,
    }));
}

const readOnlyStrategy: Strategy = {
    name: "Immutability Test",
    description: "Deterministic read-only strategy for the input-immutability spec.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data, params) {
        if (params.threshold > 1 || data.length < 3) return [];
        const entryIndex = Math.max(0, Math.min(data.length - 2, 0));
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

const options: FinderOptions = {
    scope: "current_chart",
    mode: "random",
    sortPriority: ["netProfit"],
    useAdvancedSort: false,
    topN: 5,
    steps: 1,
    rangePercent: 0,
    maxRuns: 10,
    tradeFilterEnabled: false,
    minTrades: 0,
    maxTrades: Number.POSITIVE_INFINITY,
    dataSlice: "all",
};

describe("Finder execution input immutability (audit Finding 5)", () => {
    it("does not mutate frozen OHLCV candle objects during a current-chart run", async () => {
        const candles = makeCandles(64);
        // Deep-freeze the input: array + every candle. Any write (property
        // assignment, array push/splice, etc.) throws in strict mode, so a
        // completed run proves the execution path is read-only.
        Object.freeze(candles);
        for (const candle of candles) Object.freeze(candle);

        // The browser Rust toggle is read through `document`; without a DOM
        // it defaults to TypeScript. Stub it so the current-chart path runs.
        const savedDocument = (globalThis as any).document;
        (globalThis as any).document = { getElementById: () => null };

        let output;
        try {
            output = await runFinderExecution(
            {
                ohlcvData: candles,
                symbol: "IMMUT",
                interval: "5m",
                options,
                settings,
                requiresTsEngine: false,
                selectedStrategies: [{ key: "immutability_test", name: readOnlyStrategy.name, strategy: readOnlyStrategy }],
                capitalSettings,
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
                onResultsUpdate: () => {},
            },
        );
        } finally {
            if (savedDocument === undefined) delete (globalThis as any).document;
            else (globalThis as any).document = savedDocument;
        }

        expect(output!.results.length).to.be.greaterThan(0);
        // Spot-check the input is byte-identical to what was passed in.
        expect(candles.length).to.equal(64);
        expect(candles[0]!.close).to.equal(100.5);
        expect(candles[63]!.close).to.equal(163.5);
    });
});
