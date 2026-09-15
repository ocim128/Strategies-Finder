/**
 * Parallel Finder Symbol Universe strategy sweep.
 *
 * Locks the load-bearing contracts of the worker-pool wiring
 * (`finder-universe-strategy-pool.ts` + `finder-universe-strategy-worker.ts`
 * + the parallel branch of `processFinderUniverseRun`):
 *
 *  - PARITY: the parallel path (in-process fake runners executing the REAL
 *    worker task core with stub datasets) produces the identical terminal
 *    survivor inventory and totals as the sequential in-process loop for the
 *    same seeded run.
 *  - ORDERING: out-of-order worker completions still release strictly
 *    ascending by strategy index (candidates stream grouped per strategy).
 *  - CANCEL: Stop discards the in-flight strategy but keeps completed
 *    survivors, and the job finishes `cancelled`.
 *  - FATAL ISOLATION: an unknown strategy key surfaces the fatal path; the
 *    strategies that already completed keep their survivors.
 *  - SINGLE-STRATEGY JOBS never spawn the pool (the sequential loop runs even
 *    when a worker count > 1 is requested).
 *  - WORKER COUNT POLICY: env override + strategy/cores/memory clamps + the
 *    Rust cap.
 *  - WORKER DATASET CACHE: successful loads are retained, failed/empty loads
 *    are evicted and retryable, and per-strategy delta stats are readable.
 *
 * The runners are in-process fakes (not real worker_threads) so the spec is
 * hermetic: no dev server, no real dataset loads. The real Worker bootstrap
 * is exercised by the manual smoke documented in docs/finder-server-side.md.
 */

import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import { processFinderUniverseRun, __testInternals } from "../lib/finder/server/finder-vite-plugin";
import {
    resolveUniverseStrategyWorkerCount,
    FINDER_UNIVERSE_WORKERS_ENV,
    type FinderUniverseStrategyProgress,
    type FinderUniverseStrategyRunnerFactory,
    type FinderUniverseStrategyTaskRunner,
} from "../lib/finder/server/finder-universe-strategy-pool";
import {
    createUniverseWorkerDatasetCache,
    runFinderUniverseStrategyWorkerTask,
    type FinderUniverseStrategyWorkerResult,
    type FinderUniverseStrategyWorkerTask,
} from "../lib/finder/server/finder-universe-strategy-worker";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import type { FinderStreamEvent } from "../lib/finder/server/finder-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const { setRunOwnerForTests, resetRunStateForTests } = __testInternals;

const GIB = 1024 * 1024 * 1024;

const STRATEGY_A = "universe_parallel_test_a";
const STRATEGY_B = "universe_parallel_test_b";
const STRATEGY_C = "universe_parallel_test_c";

// Three registered keys with the same deterministic execution shape so the
// parallel sweep has genuinely independent per-strategy work to schedule.
// Single module-scope instances: the registry, the main-thread
// selectedStrategies, and the worker-side key resolution must all agree on
// the strategy NAME (it flows into every candidate row).
const strategyA = makeTestStrategy("A");
const strategyB = makeTestStrategy("B");
const strategyC = makeTestStrategy("C");
function makeTestStrategy(label: string): Strategy {
    return {
        name: `Universe Parallel Test ${label}`,
        description: "Deterministic strategy for parallel universe tests.",
        defaultParams: { threshold: 1 },
        paramLabels: { threshold: "Threshold" },
        execute(data, params) {
            if (params.threshold > 5 || data.length < 3) return [];
            const entryIndex = Math.max(0, Math.min(data.length - 2, Math.round(params.threshold) - 1));
            return [
                { time: data[entryIndex]!.time, type: "buy", price: data[entryIndex]!.close },
                { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
            ];
        },
    };
}

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

const threeSymbolDatasets = () => new Map<string, OHLCVData[]>([
    ["UP", makeCandles([100, 105, 110, 115, 120])],
    ["DOWN", makeCandles([100, 95, 90, 85, 80])],
    ["FLAT", makeCandles([100, 100, 100, 100, 100])],
]);

const SYMBOLS = ["UP", "DOWN", "FLAT"];

function makeOptions(symbols: string[]): FinderOptions {
    return {
        scope: "symbol_universe",
        mode: "random",
        randomSeed: 4242,
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        topN: 5,
        steps: 3,
        rangePercent: 35,
        maxRuns: 4,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        universe: {
            symbols,
            minActiveSymbols: 2,
            minTotalTrades: 2,
            // UP trades profitably, DOWN trades at a loss, FLAT trades flat:
            // 1/3 of active symbols are profitable.
            minProfitableActiveRatio: 0.3,
            sortPriority: ["profitableActiveRatio", "medianExpectancy", "worstNetProfit"],
        },
    } as unknown as FinderOptions;
}

// The parallel path always generates params through the worker-local
// FinderParamSpace, so BOTH sides of the parity comparison inject the SAME
// real (seeded) generator — that is exactly what production wires.
const realGenerateParamSets = (defaultParams: Record<string, number>, options: FinderOptions) =>
    new FinderParamSpace().generateParamSets(defaultParams, options);

interface FakeRunnerOptions {
    datasets: Map<string, OHLCVData[]>;
    onTaskStart?: (task: FinderUniverseStrategyWorkerTask, runnerIndex: number) => void;
    /** Per-task completion delay; later completions force out-of-order arrival. */
    delayMs?: (taskIndex: number) => number;
    /** Task indexes that surface as strategy fatals. */
    fatalTasks?: Set<number>;
    /** Task indexes that park in-flight until stop() (like a real worker mid-run). */
    parkUntilStopTasks?: Set<number>;
    /** Set when a runner is created; lets tests prove the pool never spawned. */
    runnerCreations?: { count: number };
}

/**
 * In-process stand-in for a real worker runner. Executes the REAL worker task
 * core (`runFinderUniverseStrategyWorkerTask`) with a stub dataset loader and
 * a persistent per-runner dataset cache, mirroring the real worker isolate.
 */
function createInProcessUniverseRunnerFactory(options: FakeRunnerOptions): FinderUniverseStrategyRunnerFactory {
    let nextRunnerIndex = 0;
    return (events) => {
        const runnerIndex = nextRunnerIndex++;
        if (options.runnerCreations) options.runnerCreations.count += 1;
        let abort: AbortController | null = null;
        const parked = new Set<() => void>();
        // Persistent worker-lifetime cache: each runner loads every symbol at
        // most once, no matter how many strategies it processes.
        const cache = createUniverseWorkerDatasetCache({
            dataSlice: "all",
            loadDataset: async (symbol) => {
                const data = options.datasets.get(symbol);
                if (!data) throw new Error(`Dataset missing: ${symbol}`);
                return data;
            },
        });
        const runCore = (task: FinderUniverseStrategyWorkerTask, signal: AbortSignal): void => {
            runFinderUniverseStrategyWorkerTask({
                task,
                loadDataset: async (symbol, interval) => cache.load(symbol, interval),
                datasetCache: cache,
                abortSignal: signal,
                isCancelled: () => signal.aborted,
                onProgress: (progress: FinderUniverseStrategyProgress) => {
                    events.onProgress(task, progress);
                },
            }).then(
                (result: FinderUniverseStrategyWorkerResult) => events.onComplete(task, result),
                (error) => events.onFatal(task, error instanceof Error ? error.message : String(error)),
            );
        };
        const runner: FinderUniverseStrategyTaskRunner = {
            runTask: (task) => {
                options.onTaskStart?.(task, runnerIndex);
                abort = new AbortController();
                if (options.parkUntilStopTasks?.has(task.taskIndex)) {
                    parked.add(() => {
                        runCore(task, AbortSignal.abort());
                    });
                    return;
                }
                const delay = options.delayMs?.(task.taskIndex) ?? 0;
                const start = (): void => {
                    if (options.fatalTasks?.has(task.taskIndex)) {
                        events.onFatal(task, `simulated fatal for strategy ${task.strategyKey}`);
                        return;
                    }
                    runCore(task, abort!.signal);
                };
                if (delay <= 0) {
                    start();
                    return;
                }
                setTimeout(() => {
                    if (abort?.signal.aborted) {
                        runCore(task, AbortSignal.abort());
                        return;
                    }
                    start();
                }, delay);
            },
            stop: () => {
                abort?.abort();
                const resume = [...parked];
                parked.clear();
                for (const fn of resume) fn();
            },
            dispose: async () => {
                abort?.abort();
            },
        };
        return runner;
    };
}

let runIdCounter = 0;
function nextRunId(): string {
    runIdCounter += 1;
    return `universe-parallel-run-${runIdCounter}`;
}

async function runUniverseJob(args: {
    strategyKeys: string[];
    owner: number;
    strategyWorkerCount?: number;
    factory?: FinderUniverseStrategyRunnerFactory;
    onEvent?: (event: FinderStreamEvent, events: FinderStreamEvent[]) => void;
    options?: FinderOptions;
    /** OOS loader spy; wired into the input so OOS-pass behavior is observable. */
    loadOosDataset?: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
}): Promise<FinderStreamEvent[]> {
    const events: FinderStreamEvent[] = [];
    setRunOwnerForTests(args.owner);
    const datasets = threeSymbolDatasets();
    const strategiesByKey: Record<string, Strategy> = {
        [STRATEGY_A]: strategyA,
        [STRATEGY_B]: strategyB,
        [STRATEGY_C]: strategyC,
    };
    await processFinderUniverseRun(
        {
            runId: nextRunId(),
            interval: "5m",
            symbols: SYMBOLS,
            options: args.options ?? makeOptions(SYMBOLS),
            settings,
            capitalSettings,
            selectedStrategies: args.strategyKeys.map((key) => {
                // Unknown keys get a placeholder object: the parallel worker
                // resolves strategies BY KEY and fatal-fails on the unknown
                // key before any candidate could exist.
                const strategy = strategiesByKey[key] ?? makeTestStrategy(key);
                return {
                    key,
                    // The real name, mirroring the production resolveSelectedStrategies:
                    // the worker resolves the SAME strategy object by key, so the
                    // candidate rows carry this name on both paths.
                    name: strategy.name,
                    strategy,
                };
            }),
            loadDataset: async (symbol) => {
                const data = datasets.get(symbol);
                if (!data) throw new Error("Dataset missing");
                return data;
            },
            generateParamSets: realGenerateParamSets,
            ...(args.loadOosDataset ? { loadOosDataset: args.loadOosDataset } : {}),
            ...(args.strategyWorkerCount !== undefined ? { strategyWorkerCount: args.strategyWorkerCount } : {}),
            ...(args.factory ? { strategyRunnerFactory: args.factory } : {}),
        },
        (event) => {
            events.push(event);
            args.onEvent?.(event, events);
        },
        args.owner,
    );
    return events;
}

function doneEventOf(events: FinderStreamEvent[]): Extract<FinderStreamEvent, { type: "done" }> {
    const done = events[events.length - 1]!;
    if (done.type !== "done") {
        throw new Error(`expected terminal done event, got ${done.type}`);
    }
    return done;
}

describe("finder universe parallel strategy sweep", () => {
    before(() => {
        strategyRegistry.register(STRATEGY_A, strategyA);
        strategyRegistry.register(STRATEGY_B, strategyB);
        strategyRegistry.register(STRATEGY_C, strategyC);
    });
    after(() => {
        strategyRegistry.unregister(STRATEGY_A);
        strategyRegistry.unregister(STRATEGY_B);
        strategyRegistry.unregister(STRATEGY_C);
        resetRunStateForTests();
    });
    afterEach(() => {
        resetRunStateForTests();
    });

    it("PARITY: parallel survivors and totals are identical to the sequential loop", async () => {
        const sequentialEvents = await runUniverseJob({
            strategyKeys: [STRATEGY_A, STRATEGY_B, STRATEGY_C],
            owner: 8101,
            strategyWorkerCount: 1,
        });
        const sequentialDone = doneEventOf(sequentialEvents);
        expect(sequentialDone.cancelled).to.equal(false);

        const parallelEvents = await runUniverseJob({
            strategyKeys: [STRATEGY_A, STRATEGY_B, STRATEGY_C],
            owner: 8102,
            strategyWorkerCount: 3,
            factory: createInProcessUniverseRunnerFactory({ datasets: threeSymbolDatasets() }),
        });
        const parallelDone = doneEventOf(parallelEvents);
        expect(parallelDone.cancelled).to.equal(false);

        // The terminal candidate inventories must be byte-identical: same
        // candidates, same params, same medians, same ordering.
        expect(JSON.stringify(parallelDone.candidates)).to.equal(JSON.stringify(sequentialDone.candidates));
        expect(parallelDone.totals.survivors).to.equal(sequentialDone.totals.survivors);
        expect(parallelDone.totals.loadedSymbols).to.equal(sequentialDone.totals.loadedSymbols);
        expect(parallelDone.totals.failedSymbols).to.equal(sequentialDone.totals.failedSymbols);
        expect(parallelDone.totals.oosRemoved).to.equal(sequentialDone.totals.oosRemoved);

        // Three distinct strategies contributed survivors (the job really ran
        // all three, not just the first).
        const strategyKeys = new Set(sequentialDone.candidates.map((candidate) => candidate.strategyKey));
        expect(strategyKeys.size).to.equal(3);
    });

    it("ORDERING: out-of-order completions still release ascending by strategy index", async () => {
        // Strategy 2 finishes first, strategy 0 last; releases must still be
        // 0, 1, 2 so candidate events appear grouped in strategy order.
        const events = await runUniverseJob({
            strategyKeys: [STRATEGY_A, STRATEGY_B, STRATEGY_C],
            owner: 8103,
            strategyWorkerCount: 3,
            factory: createInProcessUniverseRunnerFactory({
                datasets: threeSymbolDatasets(),
                delayMs: (taskIndex) => (taskIndex === 2 ? 0 : taskIndex === 1 ? 20 : 60),
            }),
        });
        const done = doneEventOf(events);
        expect(done.cancelled).to.equal(false);

        const candidateEvents = events.filter(
            (event): event is Extract<FinderStreamEvent, { type: "candidate" }> => event.type === "candidate",
        );
        expect(candidateEvents.length).to.be.greaterThan(0);
        const keyOrder = [STRATEGY_A, STRATEGY_B, STRATEGY_C];
        let lastIndex = -1;
        for (const { candidate } of candidateEvents) {
            const index = keyOrder.indexOf(candidate.strategyKey);
            expect(index, `candidate from ${candidate.strategyKey} released out of order`).to.be.at.least(lastIndex);
            lastIndex = index;
        }
    });

    it("CANCEL: Stop discards the in-flight strategy and finishes cancelled, keeping completed survivors", async () => {
        const owner = 8104;
        let stopFired = false;
        const events = await runUniverseJob({
            strategyKeys: [STRATEGY_A, STRATEGY_B, STRATEGY_C],
            owner,
            strategyWorkerCount: 2,
            factory: createInProcessUniverseRunnerFactory({
                datasets: threeSymbolDatasets(),
                // Strategy 1 parks in flight like a real worker mid-simulation.
                parkUntilStopTasks: new Set([1]),
            }),
            onEvent: (event) => {
                // Simulates Stop deterministically: bump the owner while
                // strategy 1 is parked, at the moment strategy 0's first
                // survivor streams (inside its ordered release, before any
                // further task assignment).
                if (stopFired) return;
                if (event.type === "candidate" && event.candidate.strategyKey === STRATEGY_A) {
                    stopFired = true;
                    setRunOwnerForTests(owner + 1);
                }
            },
        });
        const done = doneEventOf(events);
        expect(done.cancelled).to.equal(true);
        // Strategy 0 completed before the Stop, so its survivors survive.
        const keys = new Set(done.candidates.map((candidate) => candidate.strategyKey));
        expect(keys.has(STRATEGY_A)).to.equal(true);
        // The parked strategy 1 was aborted and can never contribute.
        expect(keys.has(STRATEGY_B)).to.equal(false);
    });

    it("FATAL: an unknown strategy key surfaces the fatal path after earlier strategies merged", async () => {
        const events = await runUniverseJob({
            strategyKeys: [STRATEGY_A, "missing_strategy_key", STRATEGY_C],
            owner: 8105,
            strategyWorkerCount: 2,
            factory: createInProcessUniverseRunnerFactory({ datasets: threeSymbolDatasets() }),
        });
        const fatal = events[events.length - 1]!;
        expect(fatal.type).to.equal("fatal");
        if (fatal.type === "fatal") {
            expect(fatal.error).to.contain("missing_strategy_key");
        }
        // Strategy 0 completed and streamed before the fatal.
        const candidateEvents = events.filter(
            (event): event is Extract<FinderStreamEvent, { type: "candidate" }> => event.type === "candidate",
        );
        expect(candidateEvents.length).to.be.greaterThan(0);
        for (const { candidate } of candidateEvents) {
            expect(candidate.strategyKey).to.equal(STRATEGY_A);
        }
    });

    it("single-strategy jobs never spawn the pool", async () => {
        const runnerCreations = { count: 0 };
        const events = await runUniverseJob({
            strategyKeys: [STRATEGY_A],
            owner: 8106,
            strategyWorkerCount: 3,
            factory: createInProcessUniverseRunnerFactory({
                datasets: threeSymbolDatasets(),
                runnerCreations,
            }),
        });
        const done = doneEventOf(events);
        expect(done.cancelled).to.equal(false);
        expect(done.candidates.length).to.be.greaterThan(0);
        expect(runnerCreations.count).to.equal(0);
    });

    it("resolves the worker count from env override, strategy count, cores, and the memory ceiling", () => {
        // Env override wins outright, bypasses the memory ceiling (operator
        // judgment call), and clamps at the hard cap.
        expect(resolveUniverseStrategyWorkerCount(3, 10, { [FINDER_UNIVERSE_WORKERS_ENV]: "2" }, 16 * GIB)).to.equal(2);
        expect(resolveUniverseStrategyWorkerCount(3, 10, { [FINDER_UNIVERSE_WORKERS_ENV]: "99" }, 16 * GIB)).to.equal(32);
        // Invalid overrides (0, negative, non-numeric) fall back to auto.
        const auto = resolveUniverseStrategyWorkerCount(3, 10, {}, 64 * GIB);
        expect(auto).to.be.at.most(3);
        expect(auto).to.be.at.least(1);
        expect(resolveUniverseStrategyWorkerCount(3, 10, { [FINDER_UNIVERSE_WORKERS_ENV]: "0" }, 64 * GIB)).to.equal(auto);
        // The memory ceiling budgets 75% of ACTUAL system RAM for one dataset
        // copy per worker (~9MB/symbol): 1000 symbols on a 64 GB host -> 5
        // workers, but only 1 on a 16 GB host (the documented heap-guidance
        // host must not auto-OOM).
        expect(resolveUniverseStrategyWorkerCount(45, 1000, {}, 64 * GIB)).to.equal(5);
        expect(resolveUniverseStrategyWorkerCount(45, 1000, {}, 16 * GIB)).to.equal(1);
        // The Rust HTTP server serializes: the AUTO pool is capped (never the
        // env override).
        const rustCapped = resolveUniverseStrategyWorkerCount(45, 10, {}, 64 * GIB, { rustEngine: true });
        expect(rustCapped).to.be.at.most(4);
        expect(resolveUniverseStrategyWorkerCount(45, 10, { [FINDER_UNIVERSE_WORKERS_ENV]: "16" }, 16 * GIB, { rustEngine: true })).to.equal(16);
    });

    it("worker dataset cache retains successful loads, evicts failed ones, and reports delta stats", async () => {
        let loadCalls = 0;
        const cache = createUniverseWorkerDatasetCache({
            dataSlice: "all",
            loadDataset: async (symbol) => {
                loadCalls += 1;
                if (symbol === "BAD") return [];
                if (symbol === "THROW") throw new Error("read failure");
                return makeCandles([100, 101, 102]);
            },
        });
        expect(await cache.load("GOOD", "5m")).to.have.lengthOf(3);
        expect(await cache.load("BAD", "5m")).to.have.lengthOf(0);
        await cache.load("THROW", "5m").then(
            () => { throw new Error("expected rejection"); },
            () => undefined,
        );
        // Failed/empty loads are evicted so a later strategy can retry.
        expect(await cache.load("BAD", "5m")).to.have.lengthOf(0);
        await cache.load("THROW", "5m").then(
            () => { throw new Error("expected rejection"); },
            () => undefined,
        );
        expect(loadCalls).to.equal(5);
        // Successful loads are served from the retained set without a re-load.
        expect(cache.get("GOOD", "5m")).to.have.lengthOf(3);
        expect(loadCalls).to.equal(5);

        const delta = cache.consumeDeltaStats();
        expect(delta.requests).to.equal(6);
        expect(delta.misses).to.equal(5);
        expect(delta.successfulLoads).to.equal(1);
        expect(delta.failedLoads).to.equal(4);
        expect(delta.uniqueBarsLoaded).to.equal(3);
        expect(delta.cacheEntries).to.equal(1);
        // Deltas are consumed: the next window starts empty.
        const emptyDelta = cache.consumeDeltaStats();
        expect(emptyDelta.requests).to.equal(0);
        expect(emptyDelta.cacheEntries).to.equal(1);
    });

    it("a date-range window without `To` reaches the latest data and skips the OOS pass", async () => {
        // `From` only means "to the latest data": the IS window is valid, but
        // no forward OOS window can exist. The job must complete WITHOUT
        // loading a single OOS dataset (the sequential path's earlier
        // behavior — slicing into empty rows per symbol — would burn a full
        // universe data load for nothing).
        let oosLoads = 0;
        const options = {
            ...makeOptions(SYMBOLS),
            dataSlice: "date_range",
            dataRangeFrom: "2020-01-01",
            oosValidationEnabled: true,
        } as unknown as FinderOptions;
        const events = await runUniverseJob({
            strategyKeys: [STRATEGY_A],
            owner: 8107,
            options,
            loadOosDataset: async () => {
                oosLoads += 1;
                return [];
            },
        });
        const done = doneEventOf(events);
        expect(done.cancelled).to.equal(false);
        expect(done.candidates.length).to.be.greaterThan(0);
        expect(oosLoads).to.equal(0);
    });
});
