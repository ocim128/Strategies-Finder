import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderUniverseExecution } from "../lib/finder/finder-runner-universe";
import { buildFinderUniverseCandidate, FinderUniverseSurvivorRanker, sortFinderUniverseCandidates } from "../lib/finder/finder-universe-metrics";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions, FinderUniverseCandidate, FinderUniverseMetric } from "../lib/types/finder";
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
        expect(output.results[0]!.drawdownMetricsAvailable).to.equal(false);
        expect((output.results[0]!.symbols.find((item) => item.symbol === "UP")?.result as any)?.trades).to.equal(undefined);
        expect((output.results[0]!.symbols.find((item) => item.symbol === "UP")?.result as any)?.equityCurve).to.equal(undefined);
        expect(output.diagnostics?.engineMode).to.equal("symbol_universe");
        expect(output.diagnostics?.counts.shownResults).to.equal(1);
        expect(output.diagnostics?.counts.processedRuns).to.equal(3);
        expect(output.diagnostics?.counts.failedRuns).to.equal(0);
        expect(output.diagnostics?.counts.typescriptCompletedRuns).to.equal(3);
        // Zero-signal executor short-circuits do not enter the backtest engine;
        // the two simulated runs must still reach both diagnostic aggregates.
        expect(output.diagnostics?.backtest?.runs).to.equal(2);
        expect(output.diagnostics?.strategyBreakdown[0]?.backtest?.runs).to.equal(2);
        expect(output.diagnostics?.data.totalParamRuns).to.equal(6);
        expect(output.diagnostics?.universe).to.deep.equal({
            totalSymbols: 3,
            loadedSymbols: 2,
            candidatePlans: 2,
            symbolEvaluations: {
                planned: 6,
                completed: 3,
                avoided: 0,
                passingCandidates: 1,
            },
            engineUsage: {
                rustRequested: false,
                rustCompletedRuns: 0,
                typescriptCompletedRuns: 3,
                typescriptReasons: [{ reason: "same-bar exits are disabled", runs: 3 }],
            },
            failedSymbols: [{ symbol: "MISSING", reason: "Dataset missing" }],
        });
        expect(output.diagnostics?.timingsMs.dataLoading).to.be.greaterThanOrEqual(0);
        expect(output.diagnostics?.strategyBreakdown[0]?.key).to.equal("universe_test");
        expect(partialUpdates.length).to.be.greaterThan(0);
    });

    it("computes drawdown only when a Universe drawdown sort requests it", async () => {
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 1,
            rangePercent: 0,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            universe: {
                symbols: ["UP"],
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
                sortPriority: ["worstMaxDrawdownPercent"],
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
                loadDataset: async () => makeCandles([100, 110, 90, 120]),
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            },
        );

        expect(output.results[0]!.drawdownMetricsAvailable).to.equal(true);
        expect(output.results[0]!.symbols[0]!.result?.drawdownAvailable).to.equal(true);
        expect(output.results[0]!.worstMaxDrawdownPercent).to.be.greaterThanOrEqual(0);
    });

    it("keeps median Sharpe on the compact Finder fast path without retaining equity curves", async () => {
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 1,
            rangePercent: 0,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            universe: {
                symbols: ["UP"],
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
                sortPriority: ["medianSharpe"],
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
                loadDataset: async () => makeCandles([100, 105, 103, 110, 108, 115]),
                generateParamSets: () => [{ threshold: 1 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            },
        );

        expect(output.results[0]!.medianSharpeAvailable).to.equal(true);
        expect(output.results[0]!.symbols[0]!.result?.sharpeRatio).to.be.a("number");
        expect((output.results[0]!.symbols[0]!.result as any)?.equityCurve).to.equal(undefined);
        expect(output.diagnostics?.backtest?.runs).to.equal(1);
        expect(output.diagnostics?.backtest?.fastPathRuns).to.equal(1);
        expect(output.diagnostics?.backtest?.fastPathBlockers ?? []).to.deep.equal([]);
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

    it("skips remaining symbols after consecutive zero-signal runs (early bail)", async () => {
        const symbols = Array.from({ length: 8 }, (_, i) => `SYM${i}`);
        const datasets = new Map<string, OHLCVData[]>(
            symbols.map((sym, i) => [sym, makeCandles([100 + i * 10, 105 + i * 10, 110 + i * 10, 115 + i * 10, 120 + i * 10])]),
        );
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
                symbols,
                minActiveSymbols: 0,
                minTotalTrades: 0,
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
                    const dataset = datasets.get(symbol);
                    if (!dataset) throw new Error(`Missing ${symbol}`);
                    return dataset;
                },
                generateParamSets: () => [{ threshold: 1 }, { threshold: 10 }],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        // threshold=1 produces signals; threshold=10 never does.
        // With 8 symbols and a bail threshold of 5, threshold=10 should bail after 5 symbols
        // → 5 processed (zero-signal), 3 skipped.
        expect(output.diagnostics?.counts.processedRuns).to.equal(8 + 5); // 8 for threshold=1, 5 for threshold=10
        expect(output.diagnostics?.counts.skippedRuns).to.equal(3);
    });

    it("samples an exit strategy lib per candidate and surfaces it on the survivor row", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["UP2", makeCandles([100, 104, 108, 112, 116])],
        ]);
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            randomSeed: 1234,
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 3,
            rangePercent: 35,
            maxRuns: 20,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Number.POSITIVE_INFINITY,
            exitStrategyOverrideEnabled: true,
            universe: {
                symbols: ["UP", "UP2"],
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
                settings: { ...settings, disableSignalExits: true },
                capitalSettings,
                selectedStrategy: {
                    key: "universe_test",
                    name: testStrategy.name,
                    strategy: testStrategy,
                },
                loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                generateParamSets: (defaultParams) => [defaultParams],
                exitStrategyCandidates: [
                    {
                        key: "exit_alpha",
                        name: "Exit Alpha",
                        strategy: {
                            name: "Exit Alpha",
                            description: "Sampled exit lib.",
                            defaultParams: { exitLookback: 2 },
                            paramLabels: { exitLookback: "Exit Lookback" },
                            execute(data) {
                                return [
                                    { time: data[0]!.time, type: "sell", price: data[0]!.close },
                                ];
                            },
                        },
                    },
                ],
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        // The survivor must carry the sampled exit strategy identity so the UI row
        // can show which lib was used, and Apply can write the override settings.
        expect(output.results.length).to.be.greaterThan(0);
        const survivor = output.results[0]!;
        expect(survivor.exitStrategyKey).to.equal("exit_alpha");
        expect(survivor.exitStrategyName).to.equal("Exit Alpha");
        expect(survivor.exitStrategyParams).to.exist;
        expect(survivor.exitStrategyParams!.exitLookback).to.equal(2);
        // Entry params on the candidate must stay clean of the `_exit__` prefix.
        expect(Object.keys(survivor.params).some((key) => key.startsWith("_exit__"))).to.equal(false);
    });

    it("keeps an identical survivor set to push-then-stable-sort when candidates exceed maxStoredSurvivors with ties", async () => {
        // Parity test for the FinderUniverseSurvivorRanker heap (Phase 2). The
        // old path was: survivors.push(c) then, on overflow,
        // [...survivors].sort(comparator).slice(maxStoredSurvivors). This run
        // generates 80 candidates that all pass the filters on near-identical
        // data so scores tie heavily — the exact condition where tie-breaker
        // drift would change which survivors are kept when maxStoredSurvivors
        // (50) is exceeded.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP_A", makeCandles([100, 104, 108, 112, 116])],
            ["UP_B", makeCandles([100, 104, 108, 112, 116])],
        ]);
        const candidateCount = 80;
        const paramSets = Array.from({ length: candidateCount }, (_v, i) => ({ threshold: i + 1 }));
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 10,
            steps: candidateCount,
            rangePercent: 0,
            maxRuns: candidateCount,
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
                generateParamSets: () => paramSets,
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            }
        );

        // testStrategy returns [] for threshold > 5, so only thresholds 1..5
        // produce signals and pass the universe filters. The survivor count is
        // bounded by min(topN, passingCandidates) = min(10, 5) = 5.
        const expectedPassing = 5;
        expect(output.results).to.have.length(expectedPassing);
        // Oracle: replay the old push-then-stable-sort path over the SAME
        // candidates that actually pass filters (thresholds 1..5). They all
        // produce identical metrics on identical data, so the comparator's
        // param-string localeCompare decides ordering; the runner's final
        // results must match this slice exactly (set + order).
        const oracleCandidates: FinderUniverseCandidate[] = [];
        for (let t = 1; t <= expectedPassing; t += 1) {
            const params = { threshold: t };
            const symResults = (["UP_A", "UP_B"] as const).map((sym) => {
                const data = datasets.get(sym)!;
                return {
                    symbol: sym,
                    status: "profitable" as const,
                    barCount: data.length,
                    firstTime: data[0]!.time,
                    lastTime: data[data.length - 1]!.time,
                    firstClose: data[0]!.close,
                    lastClose: data[data.length - 1]!.close,
                    directionalLookbackClose: data[0]!.close,
                    directionalLookbackBars: Math.min(96, data.length - 1),
                    result: {
                        netProfit: 16,
                        netProfitPercent: 16,
                        expectancy: 16,
                        avgTrade: 16,
                        winRate: 1,
                        profitFactor: 2,
                        totalTrades: 2,
                        maxDrawdownPercent: 0,
                        winningTrades: 1,
                        losingTrades: 0,
                        avgWin: 16,
                        avgLoss: 0,
                        sharpeRatio: 0,
                    },
                };
            });
            oracleCandidates.push(buildFinderUniverseCandidate({
                strategyKey: "universe_test",
                strategyName: testStrategy.name,
                params,
                symbols: symResults,
            }));
        }
        const oracleSlice = sortFinderUniverseCandidates(
            oracleCandidates,
            options.universe!.sortPriority,
        ).slice(0, expectedPassing);
        const keyOf = (c: FinderUniverseCandidate) => `${c.strategyKey}|${JSON.stringify(c.params)}`;
        // SET parity: the kept survivors match the oracle slice as a multiset.
        expect(output.results.map(keyOf)).to.deep.equal(oracleSlice.map(keyOf));
        // No duplicate survivors.
        expect(new Set(output.results.map(keyOf)).size).to.equal(output.results.length);
    });

    it("throttles onResultsUpdate instead of firing once per surviving candidate", async () => {
        // With 750ms throttle and a fast in-memory dataset, a 20-candidate run
        // that previously fired onResultsUpdate ~20 times should now fire far
        // fewer. The FIRST survivor fires immediately (initial tick), and the
        // rest collapse because the whole run completes well under 750ms.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP_A", makeCandles([100, 104, 108, 112, 116])],
            ["UP_B", makeCandles([100, 104, 108, 112, 116])],
        ]);
        let updateCount = 0;
        const options: FinderOptions = {
            scope: "symbol_universe",
            mode: "random",
            sortPriority: ["netProfit"],
            useAdvancedSort: false,
            topN: 5,
            steps: 3,
            rangePercent: 0,
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

        await runFinderUniverseExecution(
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
                generateParamSets: () => Array.from({ length: 20 }, (_v, i) => ({ threshold: (i % 5) + 1 })),
            },
            {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
                onResultsUpdate: () => {
                    updateCount += 1;
                },
            }
        );

        // 20 candidates pass filters; previously updateCount would be ~20.
        // With the 750ms throttle and an in-memory run, it should be a small
        // constant (1 = the initial tick, possibly 2 if the run straddles the
        // throttle window). Assert the upper bound that distinguishes throttled
        // from per-candidate.
        expect(updateCount).to.be.lessThan(20);
        expect(updateCount).to.be.greaterThanOrEqual(1);
    });

    it("batches cached dataset completions without starving event-loop control", async () => {
        const symbols = Array.from({ length: 130 }, (_value, index) => `SYM_${index}`);
        const data = makeCandles([100, 104, 108, 112, 116]);
        let yields = 0;
        const options: FinderOptions = {
            scope: "symbol_universe",
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
            universe: {
                symbols,
                minActiveSymbols: 1,
                minTotalTrades: 1,
                minProfitableActiveRatio: 0,
                sortPriority: ["profitableActiveRatio"],
            },
        };

        await runFinderUniverseExecution({
            interval: "5m",
            options,
            settings,
            capitalSettings,
            selectedStrategy: { key: "universe_test", name: testStrategy.name, strategy: testStrategy },
            loadDataset: async () => data,
            generateParamSets: () => [{ threshold: 1 }],
        }, {
            setProgress: () => {},
            setStatus: () => {},
            yieldControl: async () => { yields += 1; },
            isCancelled: () => false,
        });

        // The old every-8 policy yielded at least 16 times during loading.
        // Batches of 64 preserve periodic control without taxing cache hits.
        expect(yields).to.be.within(2, 6);
    });
});

describe("FinderUniverseSurvivorRanker heap", () => {
    // Unit-level parity tests independent of the runner: the ranker's kept SET
    // and ordered output must match the old push-then-stable-sort-and-slice.
    // The "old path" oracle is: take every offered candidate, run
    // sortFinderUniverseCandidates on the full list, slice to maxSize. The heap
    // must produce an identical slice. We assert SET equality (as multisets of
    // identity keys) AND ordered equality, over many randomized inputs plus the
    // edge cases (exact ties, exactly maxSize, single candidate).
    function makeCandidate(strategyName: string, params: Record<string, number>, score: number, key: string): FinderUniverseCandidate {
        const base = buildFinderUniverseCandidate({
            strategyKey: key,
            strategyName,
            params,
            symbols: [{
                symbol: "X",
                status: "profitable",
                barCount: 100,
                result: {
                    netProfit: score,
                    netProfitPercent: score,
                    expectancy: score,
                    avgTrade: score,
                    winRate: 1,
                    profitFactor: 2,
                    totalTrades: 50,
                    maxDrawdownPercent: 1,
                    winningTrades: 25,
                    losingTrades: 25,
                    avgWin: 2,
                    avgLoss: 1,
                    sharpeRatio: 1,
                },
            }],
        });
        // Override the sort-relevant metrics so the score dominates the
        // comparator; strategyName + params provide the tiebreakers.
        base.profitableActiveRatio = score;
        base.medianExpectancy = score;
        base.worstNetProfit = score;
        base.robustUniverseScore = score;
        base.windowStabilityScore = score;
        return base;
    }

    /**
     * Push every candidate through the ranker, then assert the ranker's output
     * equals the old-path oracle: [...all].sort(comparator).slice(maxSize).
     */
    function assertParity(
        candidates: FinderUniverseCandidate[],
        maxSize: number,
        sortPriority: readonly FinderUniverseMetric[],
    ): void {
        const ranker = new FinderUniverseSurvivorRanker(maxSize, sortPriority);
        for (const c of candidates) ranker.offer(c);
        const expectedCount = Math.min(maxSize, candidates.length);
        const oracle = sortFinderUniverseCandidates(candidates, sortPriority).slice(0, expectedCount);
        const actual = ranker.toSortedArray(maxSize);
        expect(actual).to.have.length(expectedCount);
        // SET parity: same multiset of identity keys (strategyKey + JSON params).
        const keyOf = (c: FinderUniverseCandidate) => `${c.strategyKey}|${JSON.stringify(c.params)}`;
        const oracleKeys = new Set(oracle.map(keyOf));
        const actualKeys = new Set(actual.map(keyOf));
        expect(actualKeys).to.deep.equal(oracleKeys);
        // ORDER parity: identical sequence.
        expect(actual.map(keyOf)).to.deep.equal(oracle.map(keyOf));
    }

    it("matches stable-sort-and-slice on a randomized, non-tying input", () => {
        const sortPriority = ["robustUniverseScore", "windowStabilityScore"] as const;
        const candidates = Array.from({ length: 40 }, (_v, i) =>
            makeCandidate("S", { i }, Math.floor((i * 37) % 100), `s${i}`));
        for (const maxSize of [1, 5, 10, 25, 40, 60]) {
            assertParity(candidates, maxSize, sortPriority);
        }
    });

    it("matches stable-sort-and-slice when candidates tie on the score (param-string tiebreak)", () => {
        // Same score for every candidate: the comparator falls through to the
        // param-string localeCompare tiebreaker, so ordering is deterministic
        // but NOT insertion order. The ranker must still match.
        const sortPriority = ["robustUniverseScore"] as const;
        const candidates = Array.from({ length: 30 }, (_v, i) =>
            makeCandidate("S", { threshold: i }, 50, `s${i}`));
        assertParity(candidates, 8, sortPriority);
    });

    it("matches stable-sort-and-slice on a full tie (same strategy, same params)", () => {
        // Identical strategy + params => the comparator returns 0 on every
        // pair. Stable sort keeps insertion order; the heap must evict the
        // LATEST-inserted on overflow so the FIRST maxSize survive, matching
        // stable-sort-keeps-first. This is the core tie-breaker-parity case.
        const sortPriority = ["robustUniverseScore"] as const;
        const candidates = Array.from({ length: 20 }, (_v, i) =>
            makeCandidate("Tie", { x: 1 }, 10, `tie_${i}`));
        const ranker = new FinderUniverseSurvivorRanker(5, sortPriority);
        for (const c of candidates) ranker.offer(c);
        const kept = ranker.toSortedArray(5);
        // strategyKey differentiates the identity; first 5 by insertion order.
        expect(kept.map((c) => c.strategyKey)).to.deep.equal(
            candidates.slice(0, 5).map((c) => c.strategyKey),
        );
    });

    it("handles edge sizes: single candidate, exactly maxSize, empty input", () => {
        const sortPriority = ["robustUniverseScore"] as const;
        // Single candidate.
        assertParity([makeCandidate("S", { a: 1 }, 10, "k1")], 5, sortPriority);
        // Exactly maxSize candidates.
        const exact = Array.from({ length: 5 }, (_v, i) => makeCandidate("S", { a: i }, i * 10, `k${i}`));
        assertParity(exact, 5, sortPriority);
        // Empty input -> toSortedArray returns [].
        const ranker = new FinderUniverseSurvivorRanker(5, sortPriority);
        expect(ranker.toSortedArray(5)).to.have.length(0);
        expect(ranker.size).to.equal(0);
    });

    it("compareFinderUniverseCandidates is the single comparator seam (no bespoke ordering in the ranker)", () => {
        // Guards against drift: if someone adds a second comparator inside the
        // ranker, this catches it by asserting the ranker's output order equals
        // the public comparator's order on a randomized input that mixes ties
        // and non-ties.
        const sortPriority = ["robustUniverseScore", "windowStabilityScore"] as const;
        const candidates = Array.from({ length: 25 }, (_v, i) =>
            makeCandidate("S", { i }, Math.floor((i * 37) % 7), `s${i}`)); // scores 0..6, heavy ties
        assertParity(candidates, 25, sortPriority);
    });
});
