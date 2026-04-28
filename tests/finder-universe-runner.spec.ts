import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderUniverseExecution } from "../lib/finder/finder-runner-universe";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
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
    name: "Universe Test",
    description: "Deterministic strategy for universe-runner tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data, params) {
        if (params.threshold > 5 || data.length < 2) {
            return [];
        }
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
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

describe("Finder universe runner", () => {
    it("keeps only surviving candidates and reports symbol load failures", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const partialUpdates: number[] = [];
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 3,
            rangePercent: 35,
            maxRuns: 20,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            universe: {
                symbols: ["UP", "DOWN", "MISSING"],
                minActiveSymbols: 2,
                minTotalTrades: 2,
                minProfitableActiveRatio: 0.5,
                sortPriority: ["profitableActiveRatio", "medianExpectancy", "worstNetProfit"],
            },
        };

        const output = await runFinderUniverseExecution(
            {
                interval: "5m",
                options,
                settings,
                capitalSettings,
                selectedStrategy: {
                    key: "universe_test",
                    name: testStrategy.name,
                    strategy: testStrategy,
                },
                loadDataset: async (symbol) => {
                    const dataset = datasets.get(symbol);
                    if (!dataset) {
                        throw new Error("Dataset missing");
                    }
                    return dataset;
                },
                generateParamSets: () => [{ threshold: 1 }, { threshold: 10 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
                onResultsUpdate: (results) => {
                    partialUpdates.push(results.length);
                },
            }
        );

        expect(output.loadedSymbols).to.equal(2);
        expect(output.failedSymbols).to.deep.equal(["MISSING"]);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.strategyKey).to.equal("universe_test");
        expect(output.results[0]!.activeSymbols).to.equal(2);
        expect(output.results[0]!.profitableSymbols).to.equal(1);
        expect(output.results[0]!.losingSymbols).to.equal(1);
        expect(output.results[0]!.symbols.find((item) => item.symbol === "MISSING")?.status).to.equal("load_failed");
        expect(partialUpdates.length).to.be.greaterThan(0);
    });
});
