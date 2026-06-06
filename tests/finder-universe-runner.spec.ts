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
        if (params.threshold > 5 || data.length < 3) {
            return [];
        }
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
        expect((output.results[0]!.symbols.find((item) => item.symbol === "UP")?.result as any)?.trades).to.equal(undefined);
        expect((output.results[0]!.symbols.find((item) => item.symbol === "UP")?.result as any)?.equityCurve).to.equal(undefined);
        expect(output.diagnostics?.engineMode).to.equal("symbol_universe");
        expect(output.diagnostics?.counts.shownResults).to.equal(1);
        expect(output.diagnostics?.counts.processedRuns).to.equal(3);
        expect(output.diagnostics?.counts.failedRuns).to.equal(0);
        expect(output.diagnostics?.data.totalParamRuns).to.equal(6);
        expect(output.diagnostics?.universe).to.deep.equal({
            totalSymbols: 3,
            loadedSymbols: 2,
            failedSymbols: [{ symbol: "MISSING", reason: "Dataset missing" }],
        });
        expect(output.diagnostics?.timingsMs.dataLoading).to.be.greaterThanOrEqual(0);
        expect(output.diagnostics?.strategyBreakdown[0]?.key).to.equal("universe_test");
        expect(partialUpdates.length).to.be.greaterThan(0);
    });

    it("counts backtest execution failures separately from symbol load failures", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["OK", makeCandles([100, 105, 110, 115, 120])],
            ["BROKEN", makeCandles([100, 101, 102, 103, 104])],
        ]);
        const failingStrategy: Strategy = {
            name: "Universe Failing Test",
            description: "Throws on one symbol so diagnostics can classify run failures.",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                if (data[1]?.close === 101) {
                    throw new Error("Broken symbol execution");
                }
                return [
                    { time: data[0]!.time, type: "buy", price: data[0]!.close },
                    { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
                ];
            },
        };
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
                symbols: ["OK", "BROKEN", "MISSING"],
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
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
                    key: "universe_failing_test",
                    name: failingStrategy.name,
                    strategy: failingStrategy,
                },
                loadDataset: async (symbol) => {
                    const dataset = datasets.get(symbol);
                    if (!dataset) {
                        throw new Error("Dataset missing");
                    }
                    return dataset;
                },
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        expect(output.diagnostics?.counts.processedRuns).to.equal(2);
        expect(output.diagnostics?.counts.failedRuns).to.equal(1);
        expect(output.diagnostics?.universe?.failedSymbols).to.deep.equal([
            { symbol: "MISSING", reason: "Dataset missing" },
        ]);
        expect(output.diagnostics?.failureBreakdown?.[0]?.reason).to.equal("Broken symbol execution");
    });

    it("keeps only the ranked top N survivors in memory and output", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP_A", makeCandles([100, 104, 108, 112, 116])],
            ["UP_B", makeCandles([120, 123, 126, 129, 132])],
        ]);
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 1,
            steps: 3,
            rangePercent: 35,
            maxRuns: 20,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            universe: {
                symbols: ["UP_A", "UP_B"],
                minActiveSymbols: 2,
                minTotalTrades: 2,
                minProfitableActiveRatio: 1,
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
                loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                generateParamSets: () => [{ threshold: 1 }, { threshold: 2 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]!.params.threshold).to.equal(1);
    });

    it("loads universe datasets concurrently so large symbol lists do not serialize I/O", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["AAA", makeCandles([100, 104, 108, 112, 116])],
            ["BBB", makeCandles([110, 114, 118, 122, 126])],
            ["CCC", makeCandles([120, 124, 128, 132, 136])],
            ["DDD", makeCandles([130, 134, 138, 142, 146])],
        ]);
        let inFlightLoads = 0;
        let maxInFlightLoads = 0;
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
                symbols: ["AAA", "BBB", "CCC", "DDD"],
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
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
                    inFlightLoads += 1;
                    maxInFlightLoads = Math.max(maxInFlightLoads, inFlightLoads);
                    await Promise.resolve();
                    inFlightLoads -= 1;
                    return datasets.get(symbol) ?? [];
                },
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        expect(output.loadedSymbols).to.equal(4);
        expect(maxInFlightLoads).to.be.greaterThan(1);
    });

    it("runs cross-symbol strategies in Symbol Universe mode", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["AAA", makeCandles([100, 103, 106, 109, 112])],
            ["BBB", makeCandles([80, 82, 84, 86, 88])],
            ["HEDGE", makeCandles([50, 51, 52, 53, 54])],
        ]);
        const seenPrimarySymbols = new Set<string>();
        const seenSecondarySymbols = new Set<string>();
        const crossSymbolStrategy: Strategy = {
            name: "Universe Cross Symbol Test",
            description: "Uses secondary context so the universe runner must provide it.",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            crossSymbolConfig: {
                defaultSymbol: "HEDGE",
                minBars: 3,
            },
            execute(data, _params, context) {
                if (!context?.crossSymbol || context.crossSymbol.secondaryData.length !== data.length) {
                    return [];
                }
                seenPrimarySymbols.add(context.crossSymbol.primarySymbol);
                seenSecondarySymbols.add(context.crossSymbol.secondarySymbol);
                return [
                    { time: data[0]!.time, type: "buy", price: data[0]!.close },
                    { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
                ];
            },
        };
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
                symbols: ["AAA", "BBB"],
                minActiveSymbols: 2,
                minTotalTrades: 2,
                minProfitableActiveRatio: 1,
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
                    key: "universe_cross_symbol_test",
                    name: crossSymbolStrategy.name,
                    strategy: crossSymbolStrategy,
                },
                loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                getProvider: () => "test",
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        expect(output.results).to.have.length(1);
        expect(output.results[0]!.activeSymbols).to.equal(2);
        expect(output.results[0]!.profitableSymbols).to.equal(2);
        expect(seenPrimarySymbols).to.deep.equal(new Set(["AAA", "BBB"]));
        expect(seenSecondarySymbols).to.deep.equal(new Set(["HEDGE"]));
    });
});
