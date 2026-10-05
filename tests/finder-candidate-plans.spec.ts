import { expect } from "chai";
import { describe, it } from "node:test";
import { buildFinderCandidatePlans, type FinderCandidateStrategy } from "../lib/finder/finder-candidate-plans";
import { runFinderExecution } from "../lib/finder/finder-runner";
import { runFinderUniverseExecution } from "../lib/finder/finder-runner-universe";
import { buildFinderArmPerformanceCandidatePlans } from "../lib/finder/finder-arm-performance-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams, Time } from "../lib/types/strategies";

/**
 * Characterization for Finder sampled-exit planning. These cases pin the
 * seeded draw sequences, generator lifetimes, and grouping behavior that the
 * current-chart runner, Universe, and Arm Performance depend on, so the
 * planned reuse of `buildFinderCandidatePlans` inside the current-chart
 * sampled-exit branch cannot silently change which exit strategy or parameter
 * set each entry candidate receives.
 *
 * Baseline captured at 737b8421 before any refactor. The seeded expectations
 * are the point: with seed 1234 the shared helper draws [x1, x1, x2] for a
 * three-candidate entry set, while the current-chart run CONTINUES one RNG
 * across entry strategies (e2 draws [x2, x2, x1]) and shares one exit-set
 * cache across the whole run. Resetting the RNG per entry strategy would
 * repeat [x1, x1, x2] and break reproducibility for saved runs.
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

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
} as BacktestSettings;

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

const baseOptions: FinderOptions = {
    scope: "current_chart",
    mode: "random",
    randomSeed: 1234,
    sortPriority: ["netProfit"],
    useAdvancedSort: false,
    topN: 20,
    steps: 1,
    rangePercent: 0,
    maxRuns: 100,
    tradeFilterEnabled: false,
    minTrades: 0,
    maxTrades: Number.POSITIVE_INFINITY,
    dataSlice: "all",
    exitStrategyOverrideEnabled: true,
} as FinderOptions;

interface EntryExecuteRecord {
    key: string;
    params: StrategyParams;
}

function makeEntryStrategy(key: string, executeLog: EntryExecuteRecord[]): Strategy {
    return {
        name: `Entry ${key}`,
        description: "test",
        defaultParams: { period: 5 },
        paramLabels: { period: "Period" },
        execute: (data: OHLCVData[], params: StrategyParams) => {
            executeLog.push({ key, params: { ...params } });
            return [
                { time: data[0]!.time, type: "buy", price: data[0]!.close },
                { time: data[1]!.time, type: "sell", price: data[1]!.close },
                { time: data[2]!.time, type: "buy", price: data[2]!.close },
                { time: data[3]!.time, type: "sell", price: data[3]!.close },
            ];
        },
    } as unknown as Strategy;
}

function makeExitStrategy(key: string, defaultParams: StrategyParams): Strategy {
    return {
        name: `Exit ${key}`,
        description: "test",
        defaultParams,
        paramLabels: Object.fromEntries(Object.keys(defaultParams).map((name) => [name, name])),
        execute: () => [],
    } as unknown as Strategy;
}

function makeExitCandidates(): FinderCandidateStrategy[] {
    return [
        { key: "x1", name: "Exit x1", strategy: makeExitStrategy("x1", { lookback: 3 }) },
        { key: "x2", name: "Exit x2", strategy: makeExitStrategy("x2", { window: 4 }) },
    ];
}

/** Entry sets [5, 10, 7] (third duplicates the first, exercising dedup). Exit x1 -> [3, 8]; exit x2 -> none (fallback). */
function makeCountingGenerator(calls: string[]) {
    return (defaults: StrategyParams): StrategyParams[] => {
        if ("period" in defaults) {
            calls.push("entry");
            return [{ period: defaults.period as number }, { period: 10 }, { period: 7 }];
        }
        if ("lookback" in defaults) {
            calls.push("x1");
            return [{ lookback: 3 }, { lookback: 8 }];
        }
        calls.push("x2");
        return [];
    };
}

describe("Finder candidate planning characterization", () => {
    it("builds deduplicated entry-only plans when no exit candidates are selected", () => {
        const entryStrategy = makeEntryStrategy("e1", []);
        const generatorDefaults: StrategyParams[] = [];
        Object.freeze(entryStrategy.defaultParams);
        const plans = buildFinderCandidatePlans({
            selectedStrategy: { key: "e1", name: "Entry e1", strategy: entryStrategy },
            exitStrategyCandidates: [],
            settings,
            options: baseOptions,
            generateParamSets: (defaults) => {
                generatorDefaults.push({ ...defaults });
                return [{ period: defaults.period as number }, { period: 10 }, { period: defaults.period as number }];
            },
        });

        expect(plans).to.deep.equal([{ params: { period: 5 } }, { params: { period: 10 } }],
            "duplicate generated entry sets are deduplicated");
        for (const plan of plans) {
            expect("exitStrategyKey" in plan).to.equal(false);
            expect("exitStrategyName" in plan).to.equal(false);
            expect("exitStrategyParams" in plan).to.equal(false);
        }
        expect(generatorDefaults).to.deep.equal([{ period: 5 }],
            "the generator receives a fresh copy of the strategy defaults");
        // The received defaults are a copy: mutating them must not touch the
        // frozen strategy defaults.
        expect(entryStrategy.defaultParams).to.deep.equal({ period: 5 });
    });

    it("samples seeded exits lazily with an empty-generator fallback and per-call state", () => {
        const calls: string[] = [];
        const entryStrategy = makeEntryStrategy("e1", []);
        const exitCandidates = makeExitCandidates();
        Object.freeze(entryStrategy);
        for (const candidate of exitCandidates) Object.freeze(candidate);
        const run = () => buildFinderCandidatePlans({
            selectedStrategy: { key: "e1", name: "Entry e1", strategy: entryStrategy },
            exitStrategyCandidates: exitCandidates,
            settings,
            options: baseOptions,
            generateParamSets: makeCountingGenerator(calls),
        });

        const plans = run();
        expect(plans).to.deep.equal([
            {
                params: { period: 5, _exit__lookback: 3 },
                exitStrategyKey: "x1",
                exitStrategyName: "Exit x1",
                exitStrategyParams: { lookback: 3 },
            },
            {
                params: { period: 10, _exit__lookback: 3 },
                exitStrategyKey: "x1",
                exitStrategyName: "Exit x1",
                exitStrategyParams: { lookback: 3 },
            },
            {
                params: { period: 7, _exit__window: 4 },
                exitStrategyKey: "x2",
                exitStrategyName: "Exit x2",
                exitStrategyParams: { window: 4 },
            },
        ], "seed 1234 draws exit keys [x1, x1, x2]; x2 has no generated sets and falls back to copied defaults");
        expect(calls).to.deep.equal(["entry", "x1", "x2"],
            "exit sets are generated lazily, once per first-sampled exit key");

        // State does not carry between helper calls: a second identical call
        // re-creates the RNG and the exit-set cache, so the pattern repeats
        // and every generator target runs again. Universe and Arm's
        // per-strategy lifetimes depend on this.
        calls.length = 0;
        const second = run();
        expect(second).to.deep.equal(plans);
        expect(calls).to.deep.equal(["entry", "x1", "x2"]);

        // Returned exit params are copies: mutating a plan cannot poison the
        // internal cache of a later call.
        (second[0]!.exitStrategyParams as StrategyParams).lookback = 999;
        calls.length = 0;
        expect(run()[0]!.exitStrategyParams).to.deep.equal({ lookback: 3 });
    });

    it("groups current-chart sampled exits per entry strategy with a run-wide rng and exit-set cache", async () => {
        const executeLog: EntryExecuteRecord[] = [];
        const calls: string[] = [];
        const planStarts: Array<{ index: number; total: number; key: string; name: string }> = [];
        const savedDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = { getElementById: () => null };
        try {
            const output = await runFinderExecution({
                ohlcvData: makeCandles(64),
                symbol: "PLAN",
                interval: "5m",
                options: baseOptions,
                settings,
                requiresTsEngine: false,
                selectedStrategies: [
                    { key: "e1", name: "Entry e1", strategy: makeEntryStrategy("e1", executeLog) },
                    { key: "e2", name: "Entry e2", strategy: makeEntryStrategy("e2", executeLog) },
                ],
                capitalSettings,
                generateParamSets: makeCountingGenerator(calls),
                exitStrategyCandidates: makeExitCandidates(),
            }, {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
                onStrategyPlanStart: (info) => planStarts.push({ ...info }),
                onResultsUpdate: () => {},
            });

            expect(planStarts).to.deep.equal([
                { index: 1, total: 4, key: "e1", name: "Entry e1" },
                { index: 2, total: 4, key: "e1", name: "Entry e1" },
                { index: 3, total: 4, key: "e2", name: "Entry e2" },
                { index: 4, total: 4, key: "e2", name: "Entry e2" },
            ], "plans are grouped by exit key in first-seen order per entry strategy");

            // One RNG continues across both entry strategies: e1 draws
            // [x1, x1, x2] and e2 CONTINUES with [x2, x2, x1] instead of
            // repeating e1's pattern. Exit sets are generated once per run,
            // not once per entry strategy.
            expect(calls).to.deep.equal(["entry", "x1", "x2", "entry"]);

            // Jobs execute in grouped order; the TypeScript fallback repeats
            // the whole sequence after the Rust attempt, so pin the first pass.
            expect(executeLog.slice(0, 6)).to.deep.equal([
                { key: "e1", params: { period: 5, _exit__lookback: 3 } },
                { key: "e1", params: { period: 10, _exit__lookback: 3 } },
                { key: "e1", params: { period: 7, _exit__window: 4 } },
                { key: "e2", params: { period: 5, _exit__window: 4 } },
                { key: "e2", params: { period: 7, _exit__window: 4 } },
                { key: "e2", params: { period: 10, _exit__lookback: 3 } },
            ]);

            // Results carry the split view: entry params without the exit
            // prefix, plus the sampled exit identity and copied params.
            const resultIndex = new Map(output.results.map((result) => [
                `${result.key}|${result.params.period}`,
                { exitStrategyKey: result.exitStrategyKey, exitStrategyParams: result.exitStrategyParams },
            ]));
            expect([...resultIndex.keys()].sort()).to.deep.equal(
                ["e1|10", "e1|5", "e1|7", "e2|10", "e2|5", "e2|7"],
            );
            expect(resultIndex.get("e1|5")).to.deep.equal({ exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } });
            expect(resultIndex.get("e1|7")).to.deep.equal({ exitStrategyKey: "x2", exitStrategyParams: { window: 4 } });
            expect(resultIndex.get("e2|5")).to.deep.equal({ exitStrategyKey: "x2", exitStrategyParams: { window: 4 } });
            expect(resultIndex.get("e2|10")).to.deep.equal({ exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } });
        } finally {
            if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document;
            else (globalThis as { document?: unknown }).document = savedDocument;
        }
    });

    it("keeps the fixed exit override branch outside sampled planning", async () => {
        const executeLog: EntryExecuteRecord[] = [];
        const planStarts: Array<{ index: number; total: number; key: string; name: string }> = [];
        const savedDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = { getElementById: () => null };
        try {
            const output = await runFinderExecution({
                ohlcvData: makeCandles(64),
                symbol: "FIXED",
                interval: "5m",
                options: {
                    ...baseOptions,
                    exitStrategyKey: "fixed_exit",
                    exitStrategyBaseParams: { lookback: 3 },
                } as FinderOptions,
                settings,
                requiresTsEngine: false,
                selectedStrategies: [
                    { key: "e1", name: "Entry e1", strategy: makeEntryStrategy("e1", executeLog) },
                ],
                capitalSettings,
                generateParamSets: (defaults) => [{ ...defaults }, { period: 10, _exit__lookback: 6 }],
                exitStrategy: makeExitStrategy("fixed_exit", { lookback: 3 }),
            }, {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
                onStrategyPlanStart: (info) => planStarts.push({ ...info }),
                onResultsUpdate: () => {},
            });

            expect(planStarts).to.deep.equal([{ index: 1, total: 1, key: "e1", name: "Entry e1" }]);
            // No sampling: every entry candidate keeps its own prefixed exit
            // params and reports the fixed override key.
            expect(executeLog.slice(0, 2)).to.deep.equal([
                { key: "e1", params: { period: 5, _exit__lookback: 3 } },
                { key: "e1", params: { period: 10, _exit__lookback: 6 } },
            ]);
            expect(output.results.map((result) => ({
                period: result.params.period,
                exitStrategyKey: result.exitStrategyKey,
                exitStrategyParams: result.exitStrategyParams,
            }))).to.deep.equal([
                { period: 5, exitStrategyKey: "fixed_exit", exitStrategyParams: { lookback: 3 } },
                { period: 10, exitStrategyKey: "fixed_exit", exitStrategyParams: { lookback: 6 } },
            ]);
        } finally {
            if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document;
            else (globalThis as { document?: unknown }).document = savedDocument;
        }
    });

    it("universe planning starts a fresh rng per run and matches a fresh helper call", async () => {
        const calls: string[] = [];
        const savedDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = { getElementById: () => null };
        try {
            const output = await runFinderUniverseExecution({
                interval: "5m",
                options: {
                    ...baseOptions,
                    scope: "symbol_universe",
                    universe: {
                        symbols: ["UP"],
                        minActiveSymbols: 1,
                        minTotalTrades: 0,
                        minProfitableActiveRatio: 0,
                        sortPriority: ["medianExpectancy"],
                    },
                },
                settings,
                capitalSettings,
                selectedStrategy: {
                    key: "e1",
                    name: "Entry e1",
                    strategy: {
                        name: "Entry e1",
                        description: "test",
                        defaultParams: { period: 5 },
                        paramLabels: { period: "Period" },
                        execute: (data: OHLCVData[]) => [
                            { time: data[0]!.time, type: "buy", price: data[0]!.close },
                            { time: data[1]!.time, type: "sell", price: data[1]!.close },
                            { time: data[2]!.time, type: "buy", price: data[2]!.close },
                            { time: data[3]!.time, type: "sell", price: data[3]!.close },
                        ],
                    } as unknown as Strategy,
                },
                exitStrategyCandidates: makeExitCandidates(),
                loadDataset: async () => makeCandles(64),
                generateParamSets: makeCountingGenerator(calls),
            }, {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => false,
            });

            const sampledByKey = new Map(output.results.map((candidate) => [
                candidate.params.period as number,
                { exitStrategyKey: candidate.exitStrategyKey, exitStrategyParams: candidate.exitStrategyParams },
            ]));
            // The universe run's draw pattern equals a fresh helper call with
            // the same seed: [x1, x1, x2]. A run-carried RNG would differ.
            expect(sampledByKey.get(5)).to.deep.equal({ exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } });
            expect(sampledByKey.get(10)).to.deep.equal({ exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } });
            expect(sampledByKey.get(7)).to.deep.equal({ exitStrategyKey: "x2", exitStrategyParams: { window: 4 } });
            expect(calls).to.deep.equal(["entry", "x1", "x2"]);
        } finally {
            if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document;
            else (globalThis as { document?: unknown }).document = savedDocument;
        }
    });

    it("arm performance planning restarts the rng and exit cache for every entry strategy", () => {
        // steps/rangePercent widen the param space so each strategy plans
        // three entry sets [5, 6, 4] and draws six times per strategy pair.
        const options: FinderOptions = { ...baseOptions, steps: 2, rangePercent: 20 };
        const plans = buildFinderArmPerformanceCandidatePlans({
            selectedStrategies: [
                { key: "e1", name: "Entry e1", strategy: makeEntryStrategy("e1", []) },
                { key: "e2", name: "Entry e2", strategy: makeEntryStrategy("e2", []) },
            ],
            exitStrategyCandidates: makeExitCandidates(),
            settings,
            options,
        });

        expect(plans.map((plan) => plan.candidateOrdinal)).to.deep.equal([0, 1, 2, 3, 4, 5],
            "candidate ordinals run continuously across strategies");
        const patternFor = (strategyKey: string) => plans
            .filter((plan) => plan.strategyKey === strategyKey)
            .map((plan) => ({ period: plan.params.period, exitStrategyKey: plan.exitStrategyKey, exitStrategyParams: plan.exitStrategyParams }));
        expect(patternFor("e1")).to.deep.equal(patternFor("e2"),
            "every entry strategy restarts from the seeded RNG: identical exit patterns");
        expect(patternFor("e1")).to.deep.equal([
            { period: 5, exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } },
            { period: 6, exitStrategyKey: "x1", exitStrategyParams: { lookback: 3 } },
            { period: 4, exitStrategyKey: "x2", exitStrategyParams: { window: 4 } },
        ]);
    });
});
