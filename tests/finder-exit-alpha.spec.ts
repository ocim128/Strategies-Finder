import { expect } from "chai";
import { describe, it } from "node:test";
import { runFinderExecution } from "../lib/finder/finder-runner";
import { runStrategyBacktest } from "../lib/finder/finder-runner-shared";
import { runCandidateOosPass } from "../lib/finder/finder-candidate-oos";
import { runUniverseOosPass } from "../lib/finder/finder-universe-oos";
import { runFinderUniverseExecution } from "../lib/finder/finder-runner-universe";
import { computeExitAlpha, finderSortRequiresExitAlpha } from "../lib/finder/finder-exit-alpha";
import { compareFinderResults, sortFinderResults } from "../lib/finder/finder-engine";
import {
    buildFinderUniverseCandidate,
    sortFinderUniverseCandidates,
    updateFinderUniverseOosExitAlpha,
} from "../lib/finder/finder-universe-metrics";
import { compactFinderLatestResults } from "../lib/finder/finder-result-snapshot";
import { toScalarCandidate } from "../lib/finder/server/finder-stream-types";
import { runBacktest, runBacktestCompact } from "../lib/strategies/index";
import type { CapitalSettings } from "../lib/types/backtest";
import type {
    FinderResult,
    FinderUniverseCandidate,
    FinderUniverseSymbolMetrics,
    FinderUniverseSymbolResult,
} from "../lib/types/finder";
import type { BacktestResult, OHLCVData, Signal, Strategy, Time } from "../lib/types/strategies";

function makeData(closes: number[], opens = closes): OHLCVData[] {
    return closes.map((close, index) => {
        const open = opens[index] ?? close;
        return {
            time: (index + 1) as Time,
            open,
            high: Math.max(open, close) + 1,
            low: Math.min(open, close) - 1,
            close,
            volume: 1_000,
        };
    });
}

const capitalSettings: CapitalSettings = {
    initialCapital: 1_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
    advancedSizing: {},
};

const baseSettings = {
    tradeDirection: "long" as const,
    executionModel: "signal_close" as const,
    riskMode: "percentage" as const,
    stopLossEnabled: false,
    takeProfitEnabled: false,
    pathExitEnabled: false,
    riskMaxHoldEnabled: false,
};

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades: [],
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
        equityCurve: [],
        ...overrides,
    };
}

function makeFinderResult(key: string, exitAlpha?: number, oosExitAlpha?: number): FinderResult {
    return {
        key,
        name: key,
        params: {},
        result: makeResult(),
        selectionResult: makeResult(),
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
        ...(exitAlpha === undefined ? {} : { exitAlpha }),
        ...(oosExitAlpha === undefined ? {} : { oosExitAlpha }),
    };
}

function makeUniverseMetrics(exitAlpha?: number, totalTrades = 1): FinderUniverseSymbolMetrics {
    return {
        netProfit: 1,
        netProfitPercent: 1,
        expectancy: 1,
        avgTrade: 1,
        winRate: 100,
        profitFactor: 2,
        totalTrades,
        maxDrawdownPercent: 0,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 1,
        avgLoss: 0,
        sharpeRatio: 1,
        ...(exitAlpha === undefined ? {} : { exitAlpha }),
    };
}

function makeUniverseSymbol(symbol: string, result?: FinderUniverseSymbolMetrics): FinderUniverseSymbolResult {
    return { symbol, status: result ? "profitable" : "no_trades", barCount: 4, result };
}

describe("Finder Exit Alpha", () => {
    it("forces signal suppression after normalization in full and compact TypeScript engines", () => {
        const data = makeData([100, 110, 120, 130]);
        const signals: Signal[] = [
            { time: 1 as Time, type: "buy", price: 100 },
            { time: 2 as Time, type: "sell", price: 110 },
        ];
        const settings = { ...baseSettings };
        const normal = runBacktest(data, signals, 1_000, 100, 0, settings);
        const forced = runBacktest(data, signals, 1_000, 100, 0, settings, undefined, undefined, {
            forceDisableSignalExits: true,
        });
        const forcedCompact = runBacktestCompact(data, signals, 1_000, 100, 0, settings, undefined, undefined, {
            forceDisableSignalExits: true,
            includeSharpeRatio: false,
        });

        expect(normal.trades[0]?.exitReason).to.equal("signal");
        expect(forced.trades[0]?.exitReason).to.equal("end_of_data");
        expect(forcedCompact.totalTrades).to.equal(1);
        expect(forcedCompact.netProfitPercent).to.equal(forced.netProfitPercent);
    });

    it("preserves protective, path, max-hold, and end-of-data exits in the control", () => {
        const stopData = makeData([100, 94, 93]);
        const stop = runBacktest(stopData, [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, {
            ...baseSettings,
            stopLossEnabled: true,
            stopLossPercent: 5,
        }, undefined, undefined, { forceDisableSignalExits: true });
        expect(stop.trades[0]?.exitReason).to.equal("stop_loss");

        const takeProfit = runBacktest(makeData([100, 106, 107]), [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, {
            ...baseSettings,
            takeProfitEnabled: true,
            takeProfitPercent: 5,
        }, undefined, undefined, { forceDisableSignalExits: true });
        expect(takeProfit.trades[0]?.exitReason).to.equal("take_profit");

        const pathExit = runBacktest(makeData([100, 109, 105]), [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, {
            ...baseSettings,
            pathExitEnabled: true,
            pathExitMode: "mfe_giveback",
            pathExitMinBars: 1,
            pathExitMinMfePercent: 5,
            pathExitGivebackPercent: 40,
        }, undefined, undefined, { forceDisableSignalExits: true });
        expect(pathExit.trades[0]?.exitReason).to.equal("path_exit");

        const holdData = makeData([100, 101, 102, 103]);
        const timeStop = runBacktest(holdData, [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, {
            ...baseSettings,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        }, undefined, undefined, { forceDisableSignalExits: true });
        expect(timeStop.trades[0]?.exitReason).to.equal("time_stop");

        const eod = runBacktest(makeData([100, 101]), [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, baseSettings, undefined, undefined, {
            forceDisableSignalExits: true,
        });
        expect(eod.trades[0]?.exitReason).to.equal("end_of_data");
    });

    it("captures negative repeated next-open exit/rebuy alpha and positive decline-avoidance alpha", () => {
        const uptrend = makeData([100, 105, 110, 115, 120], [100, 105, 110, 115, 120]);
        const repeatedSignals: Signal[] = [
            { time: 1 as Time, type: "buy", price: 100 },
            { time: 2 as Time, type: "sell", price: 105 },
            { time: 3 as Time, type: "buy", price: 110 },
            { time: 4 as Time, type: "sell", price: 115 },
        ];
        const nextOpenSettings = { ...baseSettings, executionModel: "next_open" as const };
        const normalUptrend = runBacktest(uptrend, repeatedSignals, 1_000, 100, 0, nextOpenSettings);
        const holdUptrend = runBacktest(uptrend, repeatedSignals, 1_000, 100, 0, nextOpenSettings, undefined, undefined, {
            forceDisableSignalExits: true,
        });
        expect(computeExitAlpha(normalUptrend, holdUptrend)).to.be.lessThan(0);

        const decline = makeData([100, 110, 90, 90]);
        const normalDecline = runBacktest(decline, [
            { time: 1 as Time, type: "buy", price: 100 },
            { time: 2 as Time, type: "sell", price: 110 },
        ], 1_000, 100, 0, baseSettings);
        const holdDecline = runBacktest(decline, [
            { time: 1 as Time, type: "buy", price: 100 },
            { time: 2 as Time, type: "sell", price: 110 },
        ], 1_000, 100, 0, baseSettings, undefined, undefined, { forceDisableSignalExits: true });
        expect(computeExitAlpha(normalDecline, holdDecline)).to.be.greaterThan(0);
    });

    it("applies fees and slippage to both arms and remains deterministic for long, short, and both", () => {
        const data = makeData([100, 110, 100, 90]);
        const signals: Signal[] = [
            { time: 1 as Time, type: "buy", price: 100 },
            { time: 2 as Time, type: "sell", price: 110 },
            { time: 3 as Time, type: "sell", price: 100 },
        ];
        const settings = { ...baseSettings, tradeDirection: "both" as const, commissionPercent: 1, slippageBps: 25 };
        const normal = runBacktest(data, signals, 1_000, 100, 1, settings);
        const control = runBacktest(data, signals, 1_000, 100, 1, settings, undefined, undefined, {
            forceDisableSignalExits: true,
        });
        const secondNormal = runBacktest(data, signals, 1_000, 100, 1, settings);
        const secondControl = runBacktest(data, signals, 1_000, 100, 1, settings, undefined, undefined, {
            forceDisableSignalExits: true,
        });

        expect(normal.trades[0]?.fees).to.be.greaterThan(0);
        expect(control.trades[0]?.fees).to.be.greaterThan(0);
        expect(computeExitAlpha(normal, control)).to.equal(computeExitAlpha(secondNormal, secondControl));
        expect(normal.trades.map((trade) => trade.type)).to.deep.equal(secondNormal.trades.map((trade) => trade.type));

        for (const direction of ["long", "short", "both"] as const) {
            const directionSettings = { ...settings, tradeDirection: direction };
            const first = runBacktest(data, signals, 1_000, 100, 1, directionSettings, undefined, undefined, {
                forceDisableSignalExits: true,
            });
            const second = runBacktest(data, signals, 1_000, 100, 1, directionSettings, undefined, undefined, {
                forceDisableSignalExits: true,
            });
            expect(second.netProfitPercent).to.equal(first.netProfitPercent);
        }
    });

    it("removes exit-only override signals only from the control", () => {
        const data = makeData([100, 102, 104, 106]);
        const exitStrategy: Strategy = {
            name: "Exit Demo",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: () => [{ time: 2 as Time, type: "sell", price: 102 }],
        };
        const normal = runStrategyBacktest({
            strategy: exitStrategy,
            data,
            signals: [{ time: 1 as Time, type: "buy", price: 100 }],
            params: {},
            capitalSettings,
            backtestSettings: baseSettings,
            backtestFn: runBacktest,
            exitStrategy,
            exitAlphaEnabled: true,
            onExitAlpha: () => undefined,
        });
        const control = runBacktest(data, [{ time: 1 as Time, type: "buy", price: 100 }], 1_000, 100, 0, baseSettings, undefined, undefined, {
            forceDisableSignalExits: true,
        });
        expect(normal.trades[0]?.exitReason).to.equal("signal");
        expect(control.trades[0]?.exitReason).to.equal("end_of_data");
    });

    it("sorts finite alpha ahead of missing values and preserves secondary priorities", () => {
        const negative = makeFinderResult("negative", -0.5);
        const positive = makeFinderResult("positive", 0.5);
        const missing = makeFinderResult("missing");
        expect(sortFinderResults([missing, negative, positive], ["exitAlpha"]).map((item) => item.key))
            .to.deep.equal(["positive", "negative", "missing"]);
        expect(compareFinderResults(makeFinderResult("a", 1), makeFinderResult("b", 1), ["exitAlpha", "netProfit"]))
            .to.equal(0);
        expect(finderSortRequiresExitAlpha(["expectancy"])).to.equal(false);
        expect(finderSortRequiresExitAlpha(["exitAlpha"])).to.equal(true);
    });

    it("does not calculate the paired metric for ordinary sorts", () => {
        let callbackCount = 0;
        runStrategyBacktest({
            strategy: {
                name: "Entry",
                description: "test",
                defaultParams: {},
                paramLabels: {},
                execute: () => [],
            },
            data: makeData([100, 101]),
            signals: [{ time: 1 as Time, type: "buy", price: 100 }],
            params: {},
            capitalSettings,
            backtestSettings: baseSettings,
            backtestFn: runBacktest,
            exitAlphaEnabled: false,
            onExitAlpha: () => { callbackCount += 1; },
        });
        expect(callbackCount).to.equal(0);
    });

    it("computes Exit Alpha on the real Current Chart Finder path only when selected", async () => {
        const strategy: Strategy = {
            name: "Current Chart Exit Alpha",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[0]!.time, type: "buy", price: data[0]!.close },
                { time: data[1]!.time, type: "sell", price: data[1]!.close },
            ],
        };
        const statuses: string[] = [];
        const output = await runFinderExecution({
            ohlcvData: makeData([100, 110, 90, 90]),
            symbol: "TEST",
            interval: "1m",
            options: {
                mode: "random",
                scope: "current_chart",
                sortPriority: ["exitAlpha"],
                useAdvancedSort: false,
                topN: 1,
                steps: 1,
                rangePercent: 0,
                maxRuns: 1,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Infinity,
            },
            settings: baseSettings,
            requiresTsEngine: true,
            selectedStrategies: [{ key: "current_exit_alpha", name: strategy.name, strategy }],
            capitalSettings,
            generateParamSets: () => [{}],
        }, {
            setProgress: () => undefined,
            setStatus: (status) => statuses.push(status),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        });
        expect(output.results[0]?.exitAlpha).to.be.a("number");
        expect(output.results[0]?.exitAlpha).to.be.greaterThan(0);
        expect(statuses.join(" ")).to.not.contain("Rust");
    });

    it("recomputes current-chart and Universe OOS alpha instead of reusing IS values", async () => {
        const strategy: Strategy = {
            name: "OOS Entry",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[0]!.time, type: "buy", price: data[0]!.close },
                { time: data[1]!.time, type: "sell", price: data[1]!.close },
            ],
        };
        const currentCandidate = makeFinderResult("oos", 99);
        const currentReport = await runCandidateOosPass({
            results: [currentCandidate],
            strategyByKey: new Map([["oos", strategy]]),
            exitStrategyByKey: new Map(),
            settings: baseSettings,
            options: {
                mode: "random",
                scope: "current_chart",
                sortPriority: ["exitAlpha"],
                useAdvancedSort: false,
                dataSlice: "half_oldest",
                oosValidationEnabled: true,
                topN: 1,
                steps: 2,
                rangePercent: 1,
                maxRuns: 1,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Infinity,
            },
            capitalSettings,
            interval: "1m",
            oosData: makeData([100, 90, 80]),
            isCancelled: () => false,
            onProgress: () => undefined,
            yieldControl: async () => undefined,
        });
        expect(currentReport.applied).to.equal(true);
        expect(currentCandidate.oosExitAlpha).to.be.a("number");
        expect(currentCandidate.oosExitAlpha).to.not.equal(99);

        const universeCandidate = buildFinderUniverseCandidate({
            strategyKey: "oos",
            strategyName: "OOS Entry",
            params: {},
            symbols: [makeUniverseSymbol("A", makeUniverseMetrics(99))],
        });
        const universeReport = await runUniverseOosPass({
            results: [universeCandidate],
            strategyByKey: new Map([["oos", strategy]]),
            settings: baseSettings,
            options: {
                mode: "random",
                scope: "symbol_universe",
                sortPriority: [],
                useAdvancedSort: false,
                dataSlice: "half_oldest",
                oosValidationEnabled: true,
                topN: 1,
                steps: 2,
                rangePercent: 1,
                maxRuns: 1,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Infinity,
                universe: {
                    symbols: ["A"],
                    minActiveSymbols: 1,
                    minTotalTrades: 0,
                    minProfitableActiveRatio: 0,
                    sortPriority: ["medianExitAlpha"],
                },
            },
            capitalSettings,
            interval: "1m",
            loadOosData: async () => makeData([100, 90, 80]),
            isCancelled: () => false,
            onProgress: () => undefined,
            yieldControl: async () => undefined,
        });
        expect(universeReport.cancelled).to.equal(false);
        expect(universeCandidate.symbols[0]?.oosResult?.exitAlpha).to.be.a("number");
        expect(universeCandidate.medianOosExitAlpha).to.equal(universeCandidate.symbols[0]?.oosResult?.exitAlpha);
    });

    it("aggregates positive, zero, and negative active-symbol alpha and reranks OOS alpha", () => {
        const symbols = [
            makeUniverseSymbol("A", makeUniverseMetrics(1)),
            makeUniverseSymbol("B", makeUniverseMetrics(0)),
            makeUniverseSymbol("C", makeUniverseMetrics(-1)),
            makeUniverseSymbol("D", makeUniverseMetrics(undefined, 0)),
        ];
        const candidate: FinderUniverseCandidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: {},
            symbols,
        });
        expect(candidate.medianExitAlpha).to.equal(0);

        const other = buildFinderUniverseCandidate({
            strategyKey: "other",
            strategyName: "Other",
            params: {},
            symbols: [makeUniverseSymbol("A", makeUniverseMetrics(0))],
        });
        candidate.symbols[0]!.oosResult = makeUniverseMetrics(-2);
        candidate.symbols[1]!.oosResult = makeUniverseMetrics(-1);
        candidate.symbols[2]!.oosResult = makeUniverseMetrics(-3);
        updateFinderUniverseOosExitAlpha(candidate);
        other.symbols[0]!.oosResult = makeUniverseMetrics(2);
        updateFinderUniverseOosExitAlpha(other);
        expect(candidate.medianOosExitAlpha).to.equal(-2);
        expect(sortFinderUniverseCandidates([candidate, other], ["medianExitAlpha"], { useOosValues: true })[0]?.strategyKey)
            .to.equal("other");
    });

    it("keeps reciprocal synthetic-pair Exit Alpha pair-neutral", async () => {
        const run = async (symbol: string, direction: "long" | "short", closes: number[]) => runFinderUniverseExecution({
            interval: "5m",
            options: {
                mode: "random",
                scope: "symbol_universe",
                sortPriority: ["exitAlpha"],
                useAdvancedSort: false,
                topN: 1,
                steps: 1,
                rangePercent: 0,
                maxRuns: 1,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Infinity,
                universe: {
                    symbols: [symbol],
                    minActiveSymbols: 1,
                    minTotalTrades: 1,
                    minProfitableActiveRatio: 0,
                    sortPriority: ["medianExitAlpha"],
                },
            },
            settings: { ...baseSettings, tradeDirection: direction },
            capitalSettings,
            selectedStrategy: {
                key: "synthetic_exit_alpha",
                name: "Synthetic Exit Alpha",
                strategy: {
                    name: "Synthetic Exit Alpha",
                    description: "test",
                    defaultParams: {},
                    paramLabels: {},
                    execute: (data) => {
                        const entry = direction === "short" ? "sell" : "buy";
                        const exit = direction === "short" ? "buy" : "sell";
                        return [
                            { time: data[0]!.time, type: entry, price: data[0]!.close },
                            { time: data[1]!.time, type: exit, price: data[1]!.close },
                            { time: data[2]!.time, type: entry, price: data[2]!.close },
                        ];
                    },
                },
            },
            loadDataset: async () => makeData(closes),
            generateParamSets: () => [{}],
        }, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
        });
        const long = await run("BASE\u2022+QUOTE\u2022", "long", [2, 4, 8, 16]);
        const short = await run("QUOTE\u2022+BASE\u2022", "short", [0.5, 0.25, 0.125, 0.0625]);
        const longAlpha = long.results[0]?.symbols[0]?.result?.exitAlpha;
        const shortAlpha = short.results[0]?.symbols[0]?.result?.exitAlpha;
        expect(long.results[0]?.symbols[0]?.result?.metricBasis).to.equal("pair_neutral_log");
        expect(short.results[0]?.symbols[0]?.result?.metricBasis).to.equal("pair_neutral_log");
        expect(shortAlpha).to.be.closeTo(longAlpha!, 1e-9);
    });

    it("separates a registered Universe exit override from the control arm", async () => {
        const entryStrategy: Strategy = {
            name: "Universe Entry",
            description: "test",
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[0]!.time, type: "buy", price: data[0]!.close },
            ],
        };
        const registeredExitKey = "cumulative_return_zscore_reversion";
        const output = await runFinderUniverseExecution({
            interval: "5m",
            options: {
                mode: "random",
                scope: "symbol_universe",
                sortPriority: ["exitAlpha"],
                useAdvancedSort: false,
                topN: 1,
                steps: 1,
                rangePercent: 0,
                maxRuns: 1,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Infinity,
                exitStrategyOverrideEnabled: true,
                universe: {
                    symbols: ["TEST"],
                    minActiveSymbols: 1,
                    minTotalTrades: 1,
                    minProfitableActiveRatio: 0,
                    sortPriority: ["medianExitAlpha"],
                },
            },
            settings: { ...baseSettings, disableSignalExits: true },
            capitalSettings,
            selectedStrategy: { key: "universe_entry", name: entryStrategy.name, strategy: entryStrategy },
            exitStrategyCandidates: [{
                key: registeredExitKey,
                name: "Cumulative Return Z-Score Reversion",
                strategy: {
                    name: "Cumulative Return Z-Score Reversion",
                    description: "test",
                    defaultParams: { lookback: 2, zThreshold: 0 },
                    paramLabels: { lookback: "lookback", zThreshold: "zThreshold" },
                    execute: () => [],
                },
            }],
            loadDataset: async () => makeData([100, 101, 102, 90, 90, 90, 90, 90, 90, 90]),
            generateParamSets: (defaults) => [{ ...defaults }],
        }, {
            setProgress: () => undefined,
            setStatus: () => undefined,
            yieldControl: async () => undefined,
            isCancelled: () => false,
        });
        const candidate = output.results[0]!;
        expect(candidate.symbols[0]?.result?.exitAlpha).to.be.greaterThan(0);
        expect(candidate.medianExitAlpha).to.be.greaterThan(0);
    });

    it("preserves alpha scalars through snapshots and server streams without baseline arrays", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: {},
            symbols: [makeUniverseSymbol("A", makeUniverseMetrics(1.25))],
        });
        candidate.medianExitAlpha = 1.25;
        const scalar = toScalarCandidate(candidate);
        expect(scalar.medianExitAlpha).to.equal(1.25);
        expect(scalar.symbols[0]?.result?.exitAlpha).to.equal(1.25);
        expect("trades" in scalar.symbols[0]!).to.equal(false);

        const snapshot = compactFinderLatestResults({ scope: "symbol_universe", results: [candidate] });
        const saved = snapshot.results[0] as FinderUniverseCandidate;
        expect(saved.medianExitAlpha).to.equal(1.25);
        expect(saved.symbols[0]?.result?.exitAlpha).to.equal(1.25);

        const legacy = compactFinderLatestResults({ scope: "current_chart", results: [makeFinderResult("legacy")] });
        expect("exitAlpha" in legacy.results[0]!).to.equal(false);
    });

    it("rejects Exit Alpha for genetic, Polymarket, and unsupported scopes before evaluation", async () => {
        const statuses: string[] = [];
        const baseInput = {
            ohlcvData: makeData([100, 101]),
            symbol: "TEST",
            interval: "1m",
            settings: {} as never,
            requiresTsEngine: true,
            selectedStrategies: [],
            capitalSettings,
            generateParamSets: () => [],
        };
        const callbacks = {
            setProgress: () => undefined,
            setStatus: (status: string) => statuses.push(status),
            yieldControl: async () => undefined,
            isCancelled: () => false,
            onResultsUpdate: () => undefined,
        };
        await runFinderExecution({ ...baseInput, options: {
            mode: "genetic",
            scope: "current_chart",
            sortPriority: ["exitAlpha"],
            useAdvancedSort: false,
            topN: 1,
            steps: 2,
            rangePercent: 1,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Infinity,
        } }, callbacks);
        expect(statuses.at(-1)).to.contain("not supported in genetic");

        statuses.length = 0;
        await runFinderExecution({ ...baseInput, options: {
            mode: "random",
            scope: "asset_opportunity",
            sortPriority: ["exitAlpha"],
            useAdvancedSort: false,
            topN: 1,
            steps: 2,
            rangePercent: 1,
            maxRuns: 1,
            tradeFilterEnabled: false,
            minTrades: 0,
            maxTrades: Infinity,
        } }, callbacks);
        expect(statuses.at(-1)).to.contain("Current Chart and Symbol Universe");
    });
});
