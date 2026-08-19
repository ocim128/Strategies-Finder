import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { Readable } from "node:stream";
import { strategyRegistry } from "../strategyRegistry";
import {
    processFinderUniverseRun,
    processFinderAssetOpportunityRun,
    processFinderAssetOpportunityBatchRun,
    buildAssetOpportunityBatchHoldoutValues,
    createProgressEventThrottle,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
import {
    runAssetOpportunityIteration,
    type AssetOpportunityIterationResult,
} from "../lib/finder/server/asset-opportunity-iteration";
import type {
    AssetOpportunityBatchRunnerFactory,
    AssetOpportunityBatchRunnerEvents,
    AssetOpportunityBatchTaskRunner,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker-pool";
import { HttpStatusError } from "../lib/vite-http-utils";
import { resolveFinderUniverseHeapWarning } from "../lib/finder/server/finder-server-heap-guard";
import {
    assertAssetResultIsScalar,
    assertCandidateIsScalar,
    toScalarCandidate,
    FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS,
    type FinderStreamEvent,
    type FinderAssetOpportunityBatchStreamEvent,
    type FinderAssetOpportunityStreamEvent,
} from "../lib/finder/server/finder-stream-types";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
import {
    ASSET_OPPORTUNITY_ALL_SORTS,
    getAssetOpportunityResortMetrics,
    type FinderAssetOpportunityArchiveSort,
} from "../lib/finder/finder-asset-opportunity-metrics";
import { runServerAssetIsSearch } from "../lib/finder/server/server-asset-is-search";
import { ensureConfirmationStrategiesLoaded } from "../lib/confirmation-signal-filter";
import { getLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions, FinderUniverseCandidate } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

// The plugin holds module-scope state (runOwner). Each test must reset it via
// the test internals, mirroring the Batch plugin spec.
const {
    setRunOwnerForTests,
    resetRunStateForTests,
    handleStatusRequest,
    handleStopRequest,
    registerFinderRoutesForTests,
    assertUniverseOptions,
    parseStrategyKeys,
    parseRunId,
    consumePendingStopForRun,
    writeStreamEventBestEffort,
    withCanonicalUniverseSymbols,
    getPendingDatasetCacheInvalidation,
    flushPendingDatasetCacheInvalidation,
    acquireRunOwnershipForTests,
} = __testInternals;

type FinderRouteHandler = (req: any, res: any) => Promise<void>;

/** Mirror of `captureBatchRoutes` in the Batch spec: install every Finder
 * route into a map keyed by path so route-level authorization can be tested
 * without booting a Vite server (audit Finding 1). */
function captureFinderRoutes(): Map<string, FinderRouteHandler> {
    const routes = new Map<string, FinderRouteHandler>();
    registerFinderRoutesForTests({ use: (path: string, handler: FinderRouteHandler) => routes.set(path, handler) });
    return routes;
}

function makeRouteResponse(): { statusCode: number; body: string; setHeader: () => void; end: (body: string) => void } {
    const response = {
        statusCode: 0,
        body: "",
        setHeader: () => {},
        end: (body: string) => { response.body = body; },
    };
    return response;
}

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
    name: "Server Finder Test",
    description: "Deterministic strategy for server-plugin tests.",
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

// A second strategy with a DIFFERENT key so multi-strategy sequencing can be
// exercised. Produces survivors for threshold 1 only (narrower than
// testStrategy) so the merged survivor set is distinguishable per strategy.
const testStrategy2: Strategy = {
    name: "Server Finder Test 2",
    description: "Second deterministic strategy for multi-strategy plugin tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data, params) {
        if (params.threshold !== 1 || data.length < 3) return [];
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
    },
};

const assetOpportunityStrategy: Strategy = {
    name: "Asset Opportunity Test",
    description: "Enters on the latest available bar for multi-strategy server tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data) {
        const latest = data[data.length - 1];
        return latest
            ? [{ time: latest.time, type: "buy", price: latest.close }]
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
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

const STRATEGY_KEY = "server_finder_test";
const STRATEGY_KEY_2 = "server_finder_test_2";

/** Build the selectedStrategies list for the multi-strategy plugin input. */
function selectStrategies(keys: string[]): Array<{ key: string; name: string; strategy: Strategy }> {
    const map: Record<string, Strategy> = {
        [STRATEGY_KEY]: testStrategy,
        [STRATEGY_KEY_2]: testStrategy2,
    };
    return keys.map((key) => ({ key, name: map[key]!.name, strategy: map[key]! }));
}

let runIdCounter = 0;
function nextRunId(): string {
    runIdCounter += 1;
    return `test-run-${runIdCounter}`;
}

function makeOptions(symbols: string[]): FinderOptions {
    return {
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
            minActiveSymbols: 2,
            minTotalTrades: 2,
            minProfitableActiveRatio: 0.5,
            sortPriority: ["profitableActiveRatio", "medianExpectancy", "worstNetProfit"],
        },
    };
}

function collectEvents(runner: (events: FinderStreamEvent[]) => Promise<void>): Promise<FinderStreamEvent[]> {
    const events: FinderStreamEvent[] = [];
    return runner(events).then(() => events);
}

/**
 * Run `processFinderUniverseRun` for the given strategies and collect the
 * stream events. Sets a unique owner + runId so cancellation tests can bump
 * the owner independently. Mirrors how the HTTP handler wires the input.
 */
async function runPlugin(args: {
    symbols: string[];
    datasets: Map<string, OHLCVData[]>;
    strategyKeys?: string[];
    owner: number;
    runId?: string;
    generateParamSets?: () => Array<Record<string, number>>;
    /** When true, the input omits generateParamSets entirely (F1 fallback). */
    omitGenerateParamSets?: boolean;
    loadDatasetThrows?: boolean;
    loadDatasetImpl?: (symbol: string) => Promise<OHLCVData[]>;
    onUnderlyingLoad?: (symbol: string) => void;
    options?: FinderOptions;
    onEvent?: (event: FinderStreamEvent, events: FinderStreamEvent[]) => void;
}): Promise<FinderStreamEvent[]> {
    const {
        symbols, datasets, owner,
        runId = nextRunId(),
        strategyKeys = [STRATEGY_KEY],
        generateParamSets = () => [{ threshold: 1 }, { threshold: 2 }],
        omitGenerateParamSets = false,
        loadDatasetThrows = false,
        loadDatasetImpl,
        options,
        onEvent,
        onUnderlyingLoad,
    } = args;
    setRunOwnerForTests(owner);
    const loadDataset = loadDatasetImpl ?? (loadDatasetThrows
        ? () => Promise.reject(new Error("No candles"))
        : (symbol: string) => {
            onUnderlyingLoad?.(symbol);
            const d = datasets.get(symbol);
            if (!d) throw new Error("Dataset missing");
            return Promise.resolve(d);
        });
    return collectEvents(async (events) => {
        await processFinderUniverseRun(
            {
                runId,
                interval: "5m",
                symbols,
                options: options ?? makeOptions(symbols),
                settings,
                capitalSettings,
                selectedStrategies: selectStrategies(strategyKeys),
                loadDataset,
                // Wire the OOS loader whenever OOS is enabled so the plugin
                // exercises the server-owned OOS path. Reuses the same
                // datasets map (the OOS slice is applied inside the plugin).
                ...(options?.oosValidationEnabled ? { loadOosDataset: loadDataset } : {}),
                ...(omitGenerateParamSets ? {} : { generateParamSets }),
            },
            (event) => {
                events.push(event);
                onEvent?.(event, events);
            },
            owner,
        );
    });
}

const upDownDatasets = () => new Map<string, OHLCVData[]>([
    ["UP", makeCandles([100, 105, 110, 115, 120])],
    ["DOWN", makeCandles([100, 95, 90, 85, 80])],
]);

before(() => {
    strategyRegistry.register(STRATEGY_KEY, testStrategy);
    strategyRegistry.register(STRATEGY_KEY_2, testStrategy2);
});

after(() => {
    strategyRegistry.unregister(STRATEGY_KEY);
    strategyRegistry.unregister(STRATEGY_KEY_2);
    resetRunStateForTests();
});

afterEach(() => {
    resetRunStateForTests();
});

describe("finder server plugin processFinderUniverseRun", () => {
    it("emits start, candidate, and done events in order with scalar-only candidates", async () => {
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner: 7001,
            runId: "run-scalar-1",
        });

        // Sequence: start, progress*, candidate*, done.
        expect(events[0]!.type).to.equal("start");
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("done");
        const startEvent = events[0] as Extract<FinderStreamEvent, { type: "start" }>;
        expect(startEvent.totalSymbols).to.equal(2);
        expect(startEvent.runId).to.equal("run-scalar-1");
        expect(startEvent.strategyKeys).to.deep.equal([STRATEGY_KEY]);
        expect(startEvent.strategyCount).to.equal(1);

        const candidateEvents = events.filter((e) => e.type === "candidate") as Array<Extract<FinderStreamEvent, { type: "candidate" }>>;
        // testStrategy emits signals for thresholds 1 and 2; both symbols pass
        // universe filters, so survivors exist.
        expect(candidateEvents.length).to.be.greaterThan(0);

        // D regression: the candidate event's `index` must be a real position
        // in the snapshot (>= 0 for at least one emitted candidate), not the
        // always-(-1) by-reference indexOf() result on a deep-cloned scalar.
        const indices = candidateEvents.map((e) => e.index);
        expect(indices.some((i) => i >= 0), "at least one candidate index must be a real position, not -1").to.equal(true);

        // MEMORY CONTRACT: every streamed candidate must be scalar — no
        // data/signals/trades/equityCurve arrays anywhere on it or its
        // per-symbol results. Deep-scan.
        for (const { candidate } of candidateEvents) {
            assertCandidateIsScalar(candidate);
            const json = JSON.stringify(candidate);
            for (const forbidden of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
                expect(json, `candidate must not serialize forbidden field "${forbidden}"`).to.not.contain(`"${forbidden}"`);
            }
        }

        // F3 regression: the done event MUST carry the terminal survivor slice.
        const doneEvent = done as Extract<FinderStreamEvent, { type: "done" }>;
        expect(Array.isArray(doneEvent.candidates)).to.equal(true);
        expect(doneEvent.candidates.length).to.be.greaterThan(0);
        expect(doneEvent.candidates.length).to.equal(doneEvent.totals.survivors);
        expect(doneEvent.runId).to.equal("run-scalar-1");
        for (const candidate of doneEvent.candidates) {
            assertCandidateIsScalar(candidate);
        }

        // progress events carry the multi-strategy phase + index/count fields.
        const progressEvents = events.filter((e) => e.type === "progress") as Array<Extract<FinderStreamEvent, { type: "progress" }>>;
        expect(progressEvents.length).to.be.greaterThan(0);
        for (const p of progressEvents) {
            expect(p.phase).to.be.oneOf(["loading", "evaluating", "oos", "done", "cancelled"]);
            expect(p.strategyCount).to.equal(1);
            expect(p.strategyIndex).to.equal(0);
        }
    });

    it("F2 regression: streams each candidate identity at most once across updates", async () => {
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner: 7201,
        });

        const candidateEvents = events.filter((e) => e.type === "candidate") as Array<Extract<FinderStreamEvent, { type: "candidate" }>>;
        const identityCounts = new Map<string, number>();
        for (const { candidate } of candidateEvents) {
            const key = `${candidate.strategyKey}|${JSON.stringify(candidate.params)}|${candidate.exitStrategyKey ?? ""}|${JSON.stringify(candidate.exitStrategyParams ?? {})}`;
            identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
        }
        for (const [key, count] of identityCounts) {
            expect(count, `candidate identity "${key}" must be streamed at most once`).to.be.at.most(1);
        }
    });

    it("F1 regression: produces candidates only when generateParamSets is supplied", async () => {
        const datasets = upDownDatasets();

        // WITH a generator: survivors exist.
        const eventsWith = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets,
            owner: 7101,
            generateParamSets: () => [{ threshold: 1 }],
        });
        const doneWith = eventsWith[eventsWith.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(doneWith.type).to.equal("done");
        expect(doneWith.totals.survivors).to.be.greaterThan(0);

        // WITHOUT a generator: the core falls back to () => [], no candidates
        // pass filters, the run completes with zero survivors. This is the
        // state the production HTTP handler would hit if it forgot to pass
        // generateParamSets.
        resetRunStateForTests();
        const eventsWithout = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets,
            owner: 7102,
            omitGenerateParamSets: true,
        });
        // Pass an input that omits generateParamSets entirely.
        const lastWithout = eventsWithout[eventsWithout.length - 1]!;
        expect(["done", "fatal"]).to.include(lastWithout.type);
        if (lastWithout.type === "done") {
            expect((lastWithout as Extract<FinderStreamEvent, { type: "done" }>).totals.survivors).to.equal(0);
        }
    });

    it("reports symbol load failures and still completes for partial loads", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const events = await runPlugin({
            symbols: ["UP", "DOWN", "MISSING"],
            datasets,
            owner: 7002,
        });

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
        expect(done.totals.failedSymbols).to.equal(1);
        expect(done.totals.loadedSymbols).to.equal(2);
    });

    it("counts unique failing symbols across strategies, not the per-strategy sum (audit Finding 9)", async () => {
        // A symbol that fails to load fails for EVERY selected strategy, so
        // summing `failedSymbols.length` per strategy double-counts. With two
        // strategies and one shared failing symbol, the user-facing total must
        // be 1, not 2.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const events = await runPlugin({
            symbols: ["UP", "DOWN", "MISSING"],
            datasets,
            owner: 7004,
            strategyKeys: [STRATEGY_KEY, STRATEGY_KEY_2],
        });

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
        // Unique failing symbols, not 2 * 1.
        expect(done.totals.failedSymbols).to.equal(1);
    });

    it("emits a fatal event when no universe symbols can be loaded", async () => {
        const events = await runPlugin({
            symbols: ["GONE1", "GONE2"],
            datasets: new Map(),
            owner: 7003,
            loadDatasetThrows: true,
        });

        const fatal = events[events.length - 1] as Extract<FinderStreamEvent, { type: "fatal" }>;
        expect(fatal.type).to.equal("fatal");
        expect(fatal.error).to.contain("No universe symbols could be loaded");
        expect(fatal.runId).to.be.a("string");

        // A reattaching browser must receive the fatal reason even after the
        // initiating stream is gone.
        setRunOwnerForTests(0);
        const status = handleStatusRequest(null) as { terminal: boolean; phase: string; error: string | null; summary: string | null };
        expect(status.terminal).to.equal(true);
        expect(status.phase).to.equal("fatal");
        expect(status.error).to.contain("No universe symbols could be loaded");
        expect(status.summary).to.contain("Finder failed");
    });

    it("stops emitting after ownership is lost (Stop semantics)", async () => {
        const owner = 7004;
        let bumped = false;
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner,
            onEvent: (_event, ev) => {
                // Simulate Stop firing after the first event: bump the owner.
                if (!bumped && ev.length === 1) {
                    bumped = true;
                    setRunOwnerForTests(owner + 999);
                }
            },
        });

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.cancelled).to.equal(true);
        expect(done.ok).to.equal(false);
    });

    it("status snapshot is summary-only while running and authoritative when terminal", async () => {
        const owner = 7005;
        const runId = "run-status-1";
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner,
            runId,
        });
        void events;

        // The HTTP handler's finally clears the owner after the run completes,
        // so status reflects the post-run (terminal) snapshot.
        setRunOwnerForTests(0);
        const status = handleStatusRequest(runId) as {
            running: boolean;
            terminal: boolean;
            runId: string;
            candidateCount: number;
            terminalCandidates: { strategyKey: string }[] | null;
            totals: { survivors: number } | null;
        };
        expect(status.running).to.equal(false);
        expect(status.terminal).to.equal(true);
        expect(status.runId).to.equal(runId);
        expect(status.candidateCount).to.be.greaterThanOrEqual(0);
        // Terminal snapshot carries the authoritative candidate slice once.
        expect(status.terminalCandidates).to.be.an("array");
        expect(status.terminalCandidates!.length).to.equal(status.candidateCount);
        expect(status.totals?.survivors).to.equal(status.candidateCount);
    });

    it("status returns 404-style error for a mismatched run id", async () => {
        const owner = 7006;
        await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner,
            runId: "run-real",
        });
        setRunOwnerForTests(0);
        const status = handleStatusRequest("run-different") as { ok: false; error: string };
        expect(status.ok).to.equal(false);
        expect(status.error).to.match(/does not match/);
    });

    // --- Phase 2: multi-strategy orchestration ---

    it("sequences multiple strategies and merges survivors into one authoritative slice", async () => {
        const underlyingLoads: string[] = [];
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner: 7301,
            strategyKeys: [STRATEGY_KEY, STRATEGY_KEY_2],
            runId: "run-multi-1",
            onUnderlyingLoad: (symbol) => underlyingLoads.push(symbol),
        });

        const start = events[0] as Extract<FinderStreamEvent, { type: "start" }>;
        expect(start.strategyKeys).to.deep.equal([STRATEGY_KEY, STRATEGY_KEY_2]);
        expect(start.strategyCount).to.equal(2);

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
        expect(underlyingLoads.sort()).to.deep.equal(["DOWN", "UP"]);
        const loadingProgress = events.filter((event) =>
            event.type === "progress" && event.text.startsWith("Loading ")
        );
        expect(loadingProgress.length).to.be.lessThan(8);
        const jobDatasetCache = done.diagnostics?.universe?.jobDatasetCache;
        expect(jobDatasetCache).to.include({
            requests: 4,
            hits: 2,
            misses: 2,
            successfulLoads: 2,
            failedLoads: 0,
            entries: 2,
            uniqueBarsLoaded: 10,
        });
        expect(jobDatasetCache?.slowestLoads).to.have.length(2);
        expect(jobDatasetCache?.slowestLoads?.every((load) =>
            load.bars === 5 && load.interval === "5m" && Number.isFinite(load.ms)
        )).to.equal(true);
        expect(done.diagnostics?.backtest?.runs).to.be.greaterThan(0);
        expect(done.diagnostics?.backtest?.fastPathRuns).to.be.greaterThanOrEqual(0);
        // Both strategies produce survivors; the merged slice must contain
        // rows from BOTH strategy keys (proves the merge, not just the last).
        const keysInResults = new Set(done.candidates.map((c) => c.strategyKey));
        expect(keysInResults.has(STRATEGY_KEY), "merged slice must include strategy 1 survivors").to.equal(true);
        expect(keysInResults.has(STRATEGY_KEY_2), "merged slice must include strategy 2 survivors").to.equal(true);

        // Progress events must report strategyCount=2 and walk strategyIndex 0->1.
        const progressEvents = events.filter((e) => e.type === "progress") as Array<Extract<FinderStreamEvent, { type: "progress" }>>;
        expect(progressEvents.length).to.be.greaterThan(0);
        for (const p of progressEvents) {
            expect(p.strategyCount).to.equal(2);
            expect(p.strategyIndex).to.be.at.least(0).and.at.most(1);
        }
    });

    it("retries a failed job-cache load for a later strategy", async () => {
        const datasets = upDownDatasets();
        const calls = new Map<string, number>();
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets,
            owner: 7305,
            strategyKeys: [STRATEGY_KEY, STRATEGY_KEY_2],
            loadDatasetImpl: async (symbol) => {
                const count = (calls.get(symbol) ?? 0) + 1;
                calls.set(symbol, count);
                if (symbol === "UP" && count === 1) throw new Error("transient read failure");
                return datasets.get(symbol)!;
            },
        });

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(calls.get("UP")).to.equal(2);
        expect(calls.get("DOWN")).to.equal(1);
        expect(done.diagnostics?.universe?.jobDatasetCache?.failedLoads).to.equal(1);
        expect(done.diagnostics?.universe?.jobDatasetCache?.successfulLoads).to.equal(2);
    });

    it("a candidate evicted from a later top-K update does not remain in runState", async () => {
        // With topN=1 and two strategies each producing multiple survivors,
        // the merged snapshot must NEVER carry more than topN candidates —
        // later strategy merges replace, not append, evicted identities.
        const opts = makeOptions(["UP", "DOWN"]);
        opts.topN = 1;
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner: 7302,
            strategyKeys: [STRATEGY_KEY, STRATEGY_KEY_2],
            options: opts,
        });
        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.candidates.length).to.be.at.most(1);
    });

    it("Stop during a later strategy prevents remaining strategies from starting", async () => {
        const owner = 7303;
        let stoppedAfterSecondStrategyProgress = false;
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets: upDownDatasets(),
            owner,
            strategyKeys: [STRATEGY_KEY, STRATEGY_KEY_2],
            onEvent: (event) => {
                if (stoppedAfterSecondStrategyProgress) return;
                if (event.type === "progress" && event.strategyIndex === 1) {
                    // Stop once the second strategy begins evaluation.
                    stoppedAfterSecondStrategyProgress = true;
                    setRunOwnerForTests(owner + 1);
                }
            },
        });
        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.cancelled).to.equal(true);
    });

    it("Stop is scoped by run id: a stale run id cannot stop the active job", async () => {
        const owner = 7304;
        const activeRunId = "run-active-stop";
        // Plant an active run state (owner set + runState with the active
        // run id) mirroring an in-flight job. handleStopRequest with a
        // DIFFERENT run id must NOT clear the owner.
        setRunOwnerForTests(owner);
        __testInternals.setRunStateForTests({
            runId: activeRunId,
            startedAt: Date.now(),
            finishedAt: null,
            interval: "5m",
            strategyKeys: [STRATEGY_KEY],
            strategyIndex: 0,
            strategyCount: 1,
            phase: "evaluating",
            totalSymbols: 2,
            progressPercent: 30,
            statusText: "running",
            loadedSymbols: 2,
            failedSymbols: 0,
            candidates: [],
            diagnostics: null,
            cancelled: false,
            summary: null,
            error: null,
            totals: null,
        });
        const stopped = await handleStopRequest("run-stale");
        expect(stopped.stopped).to.equal(false);
        // Owner must still be set (the active job is unaffected by the stale
        // stop). setRunOwnerForTests reads back via the same module-scope
        // field.
        setRunOwnerForTests(0); // cleanup
    });

    it("keeps ownership until a matching stopped job reaches teardown", async () => {
        const owner = 7308;
        const activeRunId = "run-stop-teardown";
        setRunOwnerForTests(owner);
        __testInternals.setRunStateForTests({
            runId: activeRunId,
            startedAt: Date.now(),
            finishedAt: null,
            interval: "5m",
            strategyKeys: [STRATEGY_KEY],
            strategyIndex: 0,
            strategyCount: 1,
            phase: "evaluating",
            totalSymbols: 2,
            progressPercent: 30,
            statusText: "running",
            loadedSymbols: 2,
            failedSymbols: 0,
            candidates: [],
            diagnostics: null,
            cancelled: false,
            summary: null,
            error: null,
            totals: null,
        });

        const stopped = await handleStopRequest(activeRunId);
        expect(stopped).to.deep.equal({ ok: true, stopped: true });

        // A second run must not be allowed to acquire the single owner while
        // the stopped job's async teardown is still pending. Before this
        // regression fix, Stop set runOwner to NONE immediately and this
        // stale-id request was incorrectly recorded as a pending Stop.
        const stale = await handleStopRequest("another-run");
        expect(stale).to.deep.equal({ ok: false, stopped: false });
    });

    it("Stop-before-ownership works when an older terminal snapshot exists", async () => {
        __testInternals.setRunStateForTests({
            runId: "older-terminal-run",
            startedAt: Date.now() - 1000,
            finishedAt: Date.now(),
            interval: "5m",
            strategyKeys: [STRATEGY_KEY],
            strategyIndex: 0,
            strategyCount: 1,
            phase: "done",
            totalSymbols: 2,
            progressPercent: 100,
            statusText: "done",
            loadedSymbols: 2,
            failedSymbols: 0,
            candidates: [],
            diagnostics: null,
            cancelled: false,
            summary: "done",
            error: null,
            totals: { loadedSymbols: 2, failedSymbols: 0, survivors: 0, oosRemoved: 0 },
        });
        const stopped = await handleStopRequest("new-run-pending-stop");
        expect(stopped.stopped).to.equal(false);
        expect(consumePendingStopForRun("new-run-pending-stop")).to.equal(true);
    });

    it("Stop-before-ownership records and consumes the matching run id", async () => {
        // Stop arrives before the run acquires ownership. handleStopRequest
        // records the pending run id; a subsequent request with that run id
        // is rejected (the HTTP handler consumes the marker before acquiring
        // ownership). Verified at the handleStopRequest + parseRunId level
        // since the HTTP ownership dance lives in handleRunRequest.
        const pendingRunId = "run-pending-stop";
        const stopped = await handleStopRequest(pendingRunId);
        // No active run, so stopped=false, but the marker is recorded.
        expect(stopped.stopped).to.equal(false);
        // Now a run request with the same run id must be rejected. We
        // simulate the HTTP handler's consumption via the test internals:
        // the run request checks pendingStopRunId === runId. Since that
        // field is module-private, we verify behavior by calling
        // handleStopRequest again with the same id AFTER a run would have
        // consumed it — but the cleanest observable is that a fresh run with
        // a DIFFERENT id is NOT affected by the stale pending marker.
        expect(consumePendingStopForRun("run-other")).to.equal(false);
        expect(consumePendingStopForRun(pendingRunId)).to.equal(true);
        expect(consumePendingStopForRun(pendingRunId)).to.equal(false);
    });

    it("rejects an unscoped Stop instead of cancelling the active owner", async () => {
        setRunOwnerForTests(7305);
        let caught: unknown;
        try {
            await handleStopRequest(undefined);
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceof(HttpStatusError);
        expect((caught as HttpStatusError).status).to.equal(400);
    });

    // --- Phase 3: server-owned OOS ---

    it("runs server-owned OOS when enabled and attaches oosAggregate", async () => {
        const opts = makeOptions(["UP", "DOWN"]);
        opts.oosValidationEnabled = true;
        opts.dataSlice = "half_oldest";
        // Provide enough candles for both IS (first half) and OOS (second half).
        const longCandles = (start: number): OHLCVData[] =>
            makeCandles(Array.from({ length: 20 }, (_v, i) => start + i));
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", longCandles(100)],
            ["DOWN", longCandles(100)],
        ]);
        const events = await runPlugin({
            symbols: ["UP", "DOWN"],
            datasets,
            owner: 7401,
            options: opts,
            runId: "run-oos-1",
        });
        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.totals.oosRemoved).to.be.a("number");
        // At least one candidate must have an oosAggregate attached (proves
        // the OOS pass ran server-side).
        const withOos = done.candidates.filter((c) => c.oosAggregate !== undefined);
        expect(withOos.length, "at least one candidate must carry oosAggregate").to.be.greaterThan(0);
        // Phase progression must include the oos phase.
        const progressEvents = events.filter((e) => e.type === "progress") as Array<Extract<FinderStreamEvent, { type: "progress" }>>;
        expect(progressEvents.some((p) => p.phase === "oos"), "progress must report an oos phase").to.equal(true);
    });

    // --- request validation (Phase 1 contracts) ---

    it("parseStrategyKeys rejects malformed entries without imposing a new UI selection cap", () => {
        expect(() => parseStrategyKeys([], undefined)).to.throw(/at least one strategy/);
        expect(() => parseStrategyKeys(["a", "a"], undefined)).to.throw(/must not contain duplicates/);
        expect(() => parseStrategyKeys(["a", 1 as unknown], undefined)).to.throw(/strategyKeys\[1\] must be a string/);
        expect(() => parseStrategyKeys([""], undefined)).to.throw(/non-empty string/);
        expect(parseStrategyKeys(Array.from({ length: 40 }, (_v, i) => `strategy_${i}`), undefined)).to.have.length(40);
    });

    it("parseStrategyKeys accepts legacy single strategyKey field as a 1-list", () => {
        const keys = parseStrategyKeys(undefined, "legacy_key");
        expect(keys).to.deep.equal(["legacy_key"]);
    });

    it("parseRunId rejects missing, non-string, empty, and oversized values", () => {
        expect(() => parseRunId(undefined)).to.throw(/runId is required/);
        expect(() => parseRunId(42 as unknown)).to.throw(/runId is required/);
        expect(() => parseRunId("  ")).to.throw(/non-empty string/);
        expect(() => parseRunId("x".repeat(129))).to.throw(/at most 128 characters/);
    });

    it("keeps the job authoritative after the response stream disconnects", async () => {
        const runId = "run-disconnected";
        const owner = 7100;
        let writes = 0;
        let writable = true;
        setRunOwnerForTests(owner);

        await processFinderUniverseRun({
            runId,
            interval: "5m",
            symbols: ["UP", "DOWN"],
            options: makeOptions(["UP", "DOWN"]),
            settings,
            capitalSettings,
            selectedStrategies: selectStrategies([STRATEGY_KEY]),
            loadDataset: (symbol) => Promise.resolve(upDownDatasets().get(symbol)!),
            generateParamSets: () => [{ threshold: 1 }],
        }, (event) => {
            if (!writable) return;
            writable = writeStreamEventBestEffort({
                write() {
                    writes += 1;
                    if (writes > 1) throw new Error("socket closed");
                },
            }, event, runId);
        }, owner);

        const status = handleStatusRequest(runId);
        if (!status.ok) throw new Error(status.error);
        expect(status.terminal).to.equal(true);
        expect(status.phase).to.equal("done");
        expect(status.error).to.equal(null);
        expect(status.terminalCandidates).to.be.an("array");
    });

    it("uses the heap-guarded top-level symbol list as the runner source of truth", () => {
        const options = makeOptions(["A", "B", "C"]);
        const canonical = withCanonicalUniverseSymbols(options, ["A"]);
        expect(canonical.universe?.symbols).to.deep.equal(["A"]);
        expect(options.universe?.symbols).to.deep.equal(["A", "B", "C"]);
    });
});

describe("finder server plugin Asset Opportunity multi-strategy execution", () => {
    it("maps worker-chunk progress to the asset index, not the strategy index", async () => {
        const symbols = ["UP", "DOWN"];
        const datasets = upDownDatasets();
        const selectedStrategies = [{
            key: "asset_opportunity_test_a",
            name: "Asset Opportunity A",
            strategy: assetOpportunityStrategy,
        }];
        const createRunner: AssetOpportunityBatchRunnerFactory = (events: AssetOpportunityBatchRunnerEvents): AssetOpportunityBatchTaskRunner => ({
            runTask(task) {
                const abort = new AbortController();
                void runAssetOpportunityIteration(
                    {
                        runId: task.runId,
                        interval: task.interval,
                        symbols: task.symbols,
                        options: task.options,
                        settings: task.settings,
                        capitalSettings: task.capitalSettings,
                        selectedStrategies,
                        useRustEnginePreference: false,
                        abortSignal: abort.signal,
                        loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                        candidatePoolSize: task.candidatePoolSize,
                        minFreshSupport: task.minFreshSupport,
                    },
                    {
                        onProgress: (progress) => events.onProgress(task, progress),
                        onAssetResult: () => undefined,
                    },
                    () => abort.signal.aborted,
                ).then(
                    (iteration: AssetOpportunityIterationResult) => events.onComplete(task, iteration),
                    (error: unknown) => events.onFatal(task, error instanceof Error ? error.message : String(error)),
                );
            },
            stop() { /* test runner is synchronously cancellable through the local controller */ },
            dispose: async () => undefined,
        });
        const options: FinderOptions = {
            ...makeOptions(symbols),
            scope: "asset_opportunity",
            assetOpportunity: {
                symbols,
                candidatePoolSize: 1,
                minFreshSupport: 1,
            },
        };
        const events: FinderAssetOpportunityStreamEvent[] = [];
        setRunOwnerForTests(7099);
        await processFinderAssetOpportunityRun(
            {
                runId: "asset-worker-progress",
                interval: "5m",
                symbols,
                options,
                settings,
                capitalSettings,
                selectedStrategies,
                useRustEnginePreference: false,
                loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                abortSignal: new AbortController().signal,
                candidatePoolSize: 1,
                minFreshSupport: 1,
                batchTaskRunnerFactory: createRunner,
                assetWorkerCount: 2,
            },
            (event) => events.push(event),
            7099,
        );

        const progressAssetIndexes = events
            .filter((event): event is Extract<FinderAssetOpportunityStreamEvent, { type: "asset_progress" }> => event.type === "asset_progress")
            .map((event) => event.assetIndex);
        expect(progressAssetIndexes).to.include(1);
        expect(progressAssetIndexes.every((index) => index >= 0 && index < symbols.length)).to.equal(true);
        expect(events[events.length - 1]!.type).to.equal("asset_done");
    });

    it("evaluates every selected strategy for every asset and returns scalar rows", async () => {
        const selectedStrategies = [
            { key: "asset_opportunity_test_a", name: "Asset Opportunity A", strategy: assetOpportunityStrategy },
            { key: "asset_opportunity_test_b", name: "Asset Opportunity B", strategy: assetOpportunityStrategy },
        ];
        const options: FinderOptions = {
            ...makeOptions(["UP", "DOWN"]),
            scope: "asset_opportunity",
            // Terminal Asset Opportunity results must retain the whole run;
            // topN is a browser display limit so post-run re-sort can inspect
            // rows that default sorting would exclude.
            topN: 1,
            maxRuns: 2,
            dataSlice: "half_oldest",
            assetOpportunity: {
                symbols: ["UP", "DOWN"],
                candidatePoolSize: 2,
                minFreshSupport: 1,
                oosIgnoreLastBars: 2,
                oosHorizons: [1, 3, 5],
            },
        };
        const datasets = upDownDatasets();
        const loaded: string[] = [];
        let inFlightLoads = 0;
        let maxInFlightLoads = 0;
        const events: FinderAssetOpportunityStreamEvent[] = [];
        setRunOwnerForTests(7101);
        await processFinderAssetOpportunityRun(
            {
                runId: "asset-multi-strategy",
                interval: "5m",
                symbols: ["UP", "DOWN"],
                options,
                settings,
                capitalSettings,
                selectedStrategies,
                useRustEnginePreference: false,
                loadDataset: async (symbol) => {
                    loaded.push(symbol);
                    inFlightLoads += 1;
                    maxInFlightLoads = Math.max(maxInFlightLoads, inFlightLoads);
                    await Promise.resolve();
                    inFlightLoads -= 1;
                    return datasets.get(symbol) ?? [];
                },
                abortSignal: new AbortController().signal,
                candidatePoolSize: 2,
                minFreshSupport: 1,
            },
            (event) => events.push(event),
            7101,
        );

        const start = events[0]!;
        expect(start.type).to.equal("asset_start");
        if (start.type === "asset_start") {
            expect(start.strategyKeys).to.deep.equal(["asset_opportunity_test_a", "asset_opportunity_test_b"]);
        }
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_done");
        if (done.type === "asset_done") {
            expect(done.totals.totalAssets).to.equal(2);
            expect(done.totals.failedAssets).to.equal(0);
            expect(done.assets.length).to.be.greaterThan(1);
            expect(
                done.totals.selectGradeAssets
                + done.totals.watchGradeAssets
                + done.totals.rejectGradeAssets,
                ).to.equal(done.totals.assetsWithFreshEntry);
            for (const asset of done.assets) {
                expect(["UP", "DOWN"]).to.include(asset.symbol);
                expect(asset.strategyKey).to.be.oneOf(["asset_opportunity_test_a", "asset_opportunity_test_b"]);
                expect(asset.latestSignalTime).to.equal(datasets.get(asset.symbol)![2]!.time);
                expect(asset.oosHorizonMetrics?.ignoreLastBars).to.equal(2);
                expect(asset.oosHorizonMetrics?.horizons.map((horizon) => horizon.bars)).to.deep.equal([1, 3, 5]);
            }
            expect(done.assetDiagnostics).to.exist;
            expect(done.assetDiagnostics!.work).to.deep.include({
                selectedStrategies: 2,
                candidateEvaluationsEstimated: 16,
                candidateEvaluationFailures: 0,
                freshEntryRechecks: 4,
                oosEvaluations: 4,
                winnerAnalyticsRecomputations: 0,
            });
            expect(done.assetDiagnostics!.work!.candidateEvaluationsAttempted).to.be.greaterThan(0);
            expect(done.assetDiagnostics!.work!.candidateEvaluationsCompleted).to.be.greaterThan(0);
            expect(done.assetDiagnostics!.timingsMs!.inSampleSearch).to.be.at.least(0);
            expect(done.assetDiagnostics!.strategyBreakdown).to.have.length(2);
            expect(done.assetDiagnostics!.slowestAssets).to.have.length(4);
            expect(done.assetDiagnostics!.engineUsage!.rustRequested).to.equal(false);
            expect(done.assetDiagnostics!.engineUsage!.rustAttemptedRuns).to.equal(0);
            expect(done.assetDiagnostics!.engineUsage!.rustCompletedRuns).to.equal(0);
            expect(done.assetDiagnostics!.engineUsage!.typescriptCompletedRuns).to.equal(8);
            expect(done.assetDiagnostics!.engineUsage!.typescriptReasons).to.deep.include({
                reason: "Rust was not requested",
                runs: 8,
            });
        }
        expect(loaded).to.deep.equal(["UP", "DOWN"]);
        expect(maxInFlightLoads).to.be.greaterThan(1);
    });

    it("filters trade counts before applying the Asset Opportunity top-K limit", async () => {
        const strategy: Strategy = {
            name: "Asset Trade Filter",
            description: "Produces a parameter-selected number of completed trades.",
            defaultParams: { tradeCount: 1 },
            paramLabels: { tradeCount: "Trade count" },
            execute(data, params) {
                const tradeCount = Math.max(1, Math.round(Number(params.tradeCount)));
                const signals: Array<{ time: Time; type: "buy" | "sell"; price: number }> = [];
                for (let index = 0; index < tradeCount; index += 1) {
                    const entry = data[index * 2];
                    const exit = data[index * 2 + 1];
                    if (!entry || !exit) return [];
                    signals.push(
                        { time: entry.time, type: "buy", price: entry.close },
                        { time: exit.time, type: "sell", price: exit.close },
                    );
                }
                return signals;
            },
        };
        const options: FinderOptions = {
            ...makeOptions(["FILTER"]),
            scope: "asset_opportunity",
            topN: 1,
            tradeFilterEnabled: true,
            minTrades: 2,
            maxTrades: 4,
        };
        const output = await runServerAssetIsSearch({
            ohlcvData: makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]),
            symbol: "FILTER",
            interval: "5m",
            options,
            settings,
            capitalSettings,
            selectedStrategy: { key: "asset_trade_filter", name: strategy.name, strategy },
            generateParamSets: () => [
                { tradeCount: 1 },
                { tradeCount: 3 },
                { tradeCount: 5 },
            ],
            isCancelled: () => false,
            yieldControl: async () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(output.results[0]!.selectionResult.totalTrades).to.equal(3);
    });

    it("loads configured confirmation strategies before the pre-resolved server candidate loop", async () => {
        const confirmationKey = "ema_confirmation";
        unregisterLoadedBuiltInStrategy(confirmationKey);
        const strategy: Strategy = {
            name: "Confirmed Server Candidate",
            description: "Emits a boundary long entry for confirmation loading coverage.",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const signalCandle = data[data.length - 2];
                return signalCandle
                    ? [{ time: signalCandle.time, type: "buy", price: signalCandle.close }]
                    : [];
            },
        };
        try {
            const output = await runServerAssetIsSearch({
                ohlcvData: makeCandles(Array.from({ length: 40 }, (_, index) => 100 + index)),
                symbol: "CONFIRMATION",
                interval: "5m",
                options: {
                    ...makeOptions(["CONFIRMATION"]),
                    scope: "asset_opportunity",
                    topN: 1,
                },
                settings: {
                    ...settings,
                    executionModel: "next_open",
                    confirmationStrategies: [confirmationKey],
                    confirmationMode: "agree",
                    confirmationWindowBars: 0,
                    confirmationStrategyParams: { [confirmationKey]: { emaPeriod: 10 } },
                },
                capitalSettings,
                selectedStrategy: { key: "confirmed_server_candidate", name: strategy.name, strategy },
                generateParamSets: () => [{}],
                isCancelled: () => false,
                yieldControl: async () => undefined,
                retainSignals: true,
            });
            expect(getLoadedBuiltInStrategy(confirmationKey)).to.exist;
            expect(output.results).to.have.length(1);
            expect(output.signalsByCandidate?.[0]).to.have.length(1);
        } finally {
            await ensureConfirmationStrategiesLoaded({ confirmationStrategies: [confirmationKey] });
        }
    });
    it("retains endpoint-adjusted selection metrics in the candidate pass", async () => {
        const output = await runServerAssetIsSearch({
            ohlcvData: makeCandles([100, 101, 102, 103]),
            symbol: "ENDPOINT",
            interval: "5m",
            options: {
                ...makeOptions(["ENDPOINT"]),
                scope: "asset_opportunity",
                topN: 1,
            },
            settings,
            capitalSettings,
            selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
            generateParamSets: () => [{ threshold: 1 }],
            isCancelled: () => false,
            yieldControl: async () => undefined,
        });

        expect(output.results).to.have.length(1);
        expect(output.results[0]!.result.totalTrades).to.equal(1);
        expect(output.results[0]!.selectionResult.totalTrades).to.equal(0);
        expect(output.results[0]!.endpointAdjusted).to.equal(true);
        expect(output.results[0]!.endpointRemovedTrades).to.equal(1);
    });

    it("caps the in-sample window to assetOpportunity.evalLastBars through the full server run", async () => {
        // The evaluation-window cap must survive the whole server pipeline
        // (route input → iteration → runner → IS search). The strategy records
        // every data length it executes against; the IS pass must see exactly
        // the capped window while the fresh-entry recheck still sees the full
        // closed set.
        const dataset = makeCandles(Array.from({ length: 12 }, (_, i) => 100 + i));
        const executeLengths: number[] = [];
        const strategy: Strategy = {
            name: "Eval Window Capture",
            description: "Records the window length it executes against.",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeLengths.push(data.length);
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const options: FinderOptions = {
            ...makeOptions(["EVALWIN"]),
            scope: "asset_opportunity",
            topN: 1,
            maxRuns: 1,
            assetOpportunity: {
                symbols: ["EVALWIN"],
                candidatePoolSize: 1,
                minFreshSupport: 1,
                evalLastBars: 3,
            },
        };
        const runLogEvents: Array<[string, Record<string, unknown>]> = [];
        const events: FinderAssetOpportunityStreamEvent[] = [];
        setRunOwnerForTests(7150);
        await processFinderAssetOpportunityRun(
            {
                runId: "asset-eval-window",
                interval: "5m",
                symbols: ["EVALWIN"],
                options,
                settings,
                capitalSettings,
                selectedStrategies: [{ key: "eval_window_capture", name: strategy.name, strategy }],
                loadDataset: async () => dataset,
                abortSignal: new AbortController().signal,
                candidatePoolSize: 1,
                minFreshSupport: 1,
                runLog: (event, payload) => { runLogEvents.push([event, payload]); },
            },
            (event) => events.push(event),
            7150,
        );

        // The IS search executed on the 3-bar capped window; the fresh-entry
        // recheck re-executed on the full 12-bar closed set.
        expect(executeLengths).to.include(3);
        expect(executeLengths).to.include(12);
        expect(Math.min(...executeLengths)).to.equal(3);
        const start = runLogEvents.find(([event]) => event === "iteration_start");
        expect(start, "iteration_start run-log event recorded").to.not.equal(undefined);
        expect(start![1]).to.include({ evalLastBars: 3 });
        const progressPercents = events
            .filter((event): event is Extract<FinderAssetOpportunityStreamEvent, { type: "asset_progress" }> => event.type === "asset_progress")
            .map((event) => event.percent);
        expect(progressPercents.length).to.be.greaterThan(0);
        expect(progressPercents.every((percent, index) => index === 0 || percent >= progressPercents[index - 1]!))
            .to.equal(true, "Asset Opportunity progress must not move backwards");
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_done");
    });
});

describe("finder server plugin Asset Opportunity batch execution", () => {
    const batchStrategy = {
        key: "asset_batch_test",
        name: "Asset Batch Test",
        strategy: assetOpportunityStrategy,
    };

    function makeBatchOptions(symbols: string[], _start: number, _end: number): FinderOptions {
        return {
            ...makeOptions(symbols),
            scope: "asset_opportunity",
            topN: 2,
            maxRuns: 2,
            assetOpportunity: {
                symbols,
                candidatePoolSize: 2,
                minFreshSupport: 1,
                oosHorizons: [1, 3, 5],
            },
        };
    }

    // The batch sweep reserves up to N trailing bars; the 5-candle fixture is
    // too short for holdouts >= 4, so batch tests use a longer series.
    const longUpDownDatasets = () => new Map<string, OHLCVData[]>([
        ["UP", makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i))],
        ["DOWN", makeCandles(Array.from({ length: 40 }, (_, i) => 100 - i))],
    ]);

    function runAssetBatch(args: {
        runId?: string;
        owner: number;
        start: number;
        end: number;
        archiveSort?: FinderAssetOpportunityArchiveSort | null;
        datasets?: Map<string, OHLCVData[]>;
        append?: (dir: string, filename: string, content: string) => Promise<void>;
    }): Promise<{ events: FinderAssetOpportunityBatchStreamEvent[]; appended: string[]; contents: string[] }> {
        const datasets = args.datasets ?? longUpDownDatasets();
        const events: FinderAssetOpportunityBatchStreamEvent[] = [];
        const appended: string[] = [];
        const contents: string[] = [];
        setRunOwnerForTests(args.owner);
        const run = (async () => {
            await processFinderAssetOpportunityBatchRun(
                {
                    runId: args.runId ?? "batch-run",
                    interval: "5m",
                    symbols: ["UP", "DOWN"],
                    options: makeBatchOptions(["UP", "DOWN"], args.start, args.end),
                    settings,
                    capitalSettings,
                    selectedStrategies: [batchStrategy],
                    useRustEnginePreference: true,
                    loadDataset: async (symbol) => datasets.get(symbol) ?? [],
                    abortSignal: new AbortController().signal,
                    candidatePoolSize: 2,
                    minFreshSupport: 1,
                    archiveSort: args.archiveSort ?? null,
                    batch: { startHoldoutBars: args.start, endHoldoutBars: args.end },
                },
                (event) => events.push(event),
                args.owner,
                "/virtual/archive-root",
                async (dir, filename, content) => {
                    appended.push(filename);
                    contents.push(content);
                    if (args.append) await args.append(dir, filename, content);
                },
            );
        })();
        return run.then(() => ({ events, appended, contents }));
    }

    it("builds ascending holdout values for a validated range", () => {
        expect(buildAssetOpportunityBatchHoldoutValues(2, 4)).to.deep.equal([2, 3, 4]);
        expect(buildAssetOpportunityBatchHoldoutValues(7, 7)).to.deep.equal([7]);
    });

    it("runs every holdout once in ascending order, archives per-N files, and emits scalar rows", async () => {
        const { events, appended } = await runAssetBatch({ owner: 7301, start: 2, end: 4, runId: "batch-order" });

        const start = events[0]!;
        expect(start.type).to.equal("asset_batch_start");
        if (start.type === "asset_batch_start") {
            expect(start.runId).to.equal("batch-order");
            expect(start.startHoldoutBars).to.equal(2);
            expect(start.endHoldoutBars).to.equal(4);
            expect(start.totalIterations).to.equal(3);
            expect(start.totalAssets).to.equal(2);
            expect(start.strategyKeys).to.deep.equal(["asset_batch_test"]);
            expect(start.archiveSort).to.equal(ASSET_OPPORTUNITY_ALL_SORTS);
        }

        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_batch_done");
        if (done.type === "asset_batch_done") {
            expect(done.completedIterations).to.equal(3);
            expect(done.failedIterations).to.equal(0);
            expect(done.assets.length).to.be.greaterThan(0);
            expect(done.holdoutBars).to.equal(4);
            expect(done.totals).to.not.equal(null);
            expect(done.assetDiagnostics).to.not.equal(null);
        }

        const iterations = events.filter(
            (event) => event.type === "asset_batch_iteration_done",
        ) as Array<Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_iteration_done" }>>;
        expect(iterations.map((event) => event.holdoutBars)).to.deep.equal([2, 3, 4]);
        expect(iterations.map((event) => event.iterationIndex)).to.deep.equal([0, 1, 2]);
        // Every iteration carries ONLY its own full scalar rows; the batch
        // contract forbids prior iterations' arrays.
        for (const iteration of iterations) {
            expect(iteration.assets.length).to.be.greaterThan(0);
            for (const asset of iteration.assets) {
                assertAssetResultIsScalar(asset);
                expect(asset.oosHorizonMetrics?.ignoreLastBars).to.equal(iteration.holdoutBars);
            }
        }
        // One block per archive sort for each N, in ascending N order.
        const archiveBlockCount = 1 + getAssetOpportunityResortMetrics().length;
        expect(appended).to.deep.equal([2, 3, 4].flatMap((holdout) =>
            Array.from({ length: archiveBlockCount }, () => `oos-holdout-${holdout}-bars.txt`),
        ));

        // Terminal status carries the batch counts and the LAST iteration rows.
        const status = handleStatusRequest("batch-order");
        if (!status.ok) throw new Error(status.error);
        expect(status.jobKind).to.equal("asset_opportunity_batch");
        expect(status.batch).to.deep.equal({
            startHoldoutBars: 2,
            endHoldoutBars: 4,
            currentHoldoutBars: 4,
            currentIteration: 3,
            totalIterations: 3,
            completedIterations: 3,
            failedIterations: 0,
        });
        expect(status.terminalAssets?.length).to.equal(iterations[2]!.assets.length);
        expect(status.assetTotals).to.not.equal(null);
        expect(status.assetDiagnostics).to.not.equal(null);
    });

    it("always archives the default order and every resort metric", async () => {
        const { events, contents } = await runAssetBatch({
            owner: 7306,
            start: 2,
            end: 3,
            runId: "batch-selected-sort",
            archiveSort: "netProfit",
        });

        const start = events[0]!;
        expect(start.type).to.equal("asset_batch_start");
        if (start.type === "asset_batch_start") {
            expect(start.archiveSort).to.equal(ASSET_OPPORTUNITY_ALL_SORTS);
        }
        const expectedSortLabels = [
            "run_default",
            ...getAssetOpportunityResortMetrics(),
        ];
        expect(contents).to.have.length(2 * expectedSortLabels.length);
        for (const sortLabel of expectedSortLabels) {
            expect(contents.filter((content) => content.includes(`Archive sort: ${sortLabel}\n`))).to.have.length(2);
        }
        expect(contents.every((content) => !content.includes("equityCurve"))).to.equal(true);
        expect(contents.every((content) => !content.includes("selectionMetrics"))).to.equal(true);
    });

    it("appends the default and every resort metric when All Sorts is selected", async () => {
        const { events, contents } = await runAssetBatch({
            owner: 7307,
            start: 2,
            end: 3,
            runId: "batch-all-sorts",
            archiveSort: ASSET_OPPORTUNITY_ALL_SORTS,
        });

        const expectedSortLabels = [
            "run_default",
            ...getAssetOpportunityResortMetrics(),
        ];
        expect(contents).to.have.length(2 * expectedSortLabels.length);
        for (const sortLabel of expectedSortLabels) {
            expect(contents.filter((content) => content.includes(`Archive sort: ${sortLabel}\n`))).to.have.length(2);
        }
        const start = events[0]!;
        expect(start.type).to.equal("asset_batch_start");
        if (start.type === "asset_batch_start") {
            expect(start.archiveSort).to.equal(ASSET_OPPORTUNITY_ALL_SORTS);
        }
    });

    it("stops after the current iteration when ownership is lost mid-batch", async () => {
        // The injected append runs AFTER the first iteration completes; losing
        // ownership there must prevent the next iteration from starting and
        // report partial completion.
        const { events, appended } = await runAssetBatch({
            owner: 7302,
            start: 1,
            end: 3,
            runId: "batch-stop",
            append: async () => {
                setRunOwnerForTests(0);
            },
        });
        const iterations = events.filter(
            (event) => event.type === "asset_batch_iteration_done",
        ) as Array<Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_iteration_done" }>>;
        expect(iterations.map((event) => event.holdoutBars)).to.deep.equal([1]);
        expect(appended).to.deep.equal(Array.from({ length: 1 + getAssetOpportunityResortMetrics().length }, () => "oos-holdout-1-bars.txt"));
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_batch_done");
        if (done.type === "asset_batch_done") {
            expect(done.cancelled).to.equal(true);
            expect(done.completedIterations).to.equal(1);
            expect(done.failedIterations).to.equal(0);
        }
        const status = handleStatusRequest("batch-stop");
        if (!status.ok) throw new Error(status.error);
        expect(status.phase).to.equal("cancelled");
        expect(status.batch?.completedIterations).to.equal(1);
        // The terminal view still adopts the last completed iteration.
        expect(status.terminalAssets?.length).to.be.greaterThan(0);
    });

    it("stops the batch with a visible fatal when the archive append fails, leaving prior files intact", async () => {
        const { events, appended } = await runAssetBatch({
            owner: 7303,
            start: 1,
            end: 2,
            runId: "batch-archive-fail",
            append: async () => {
                throw new Error("disk full");
            },
        });
        // The first iteration's append throws; the batch must not start the
        // second iteration and must emit asset_batch_fatal.
        expect(appended).to.deep.equal(["oos-holdout-1-bars.txt"]);
        const fatal = events.find((event) => event.type === "asset_batch_fatal") as
            Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.contain("disk full");
        expect(fatal!.holdoutBars).to.equal(1);
        expect(fatal!.completedIterations).to.equal(0);
        const status = handleStatusRequest("batch-archive-fail");
        if (!status.ok) throw new Error(status.error);
        expect(status.phase).to.equal("fatal");
        expect(status.batch?.completedIterations).to.equal(0);
        expect(status.batch?.failedIterations).to.equal(1);
        expect(status.terminalAssets).to.deep.equal([]);
    });

    it("archives an empty result block for every holdout value", async () => {
        const { events, appended, contents } = await runAssetBatch({
            owner: 7305,
            start: 2,
            end: 3,
            datasets: new Map([["UP", []], ["DOWN", []]]),
            runId: "batch-empty-results",
        });

        expect(appended).to.deep.equal([2, 3].flatMap((holdout) =>
            Array.from({ length: 1 + getAssetOpportunityResortMetrics().length }, () => `oos-holdout-${holdout}-bars.txt`),
        ));
        expect(contents).to.have.length(2 * (1 + getAssetOpportunityResortMetrics().length));
        expect(contents.every((content) => content.includes("\n[]\n"))).to.equal(true);

        const iterations = events.filter(
            (event) => event.type === "asset_batch_iteration_done",
        ) as Array<Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_iteration_done" }>>;
        expect(iterations).to.have.length(2);
        expect(iterations.every((event) => event.assets.length === 0)).to.equal(true);
        expect(iterations.every((event) => typeof event.archiveFilename === "string")).to.equal(true);

        const done = events[events.length - 1]!;
        expect(done.type).to.equal("asset_batch_done");
        if (done.type === "asset_batch_done") {
            expect(done.completedIterations).to.equal(2);
            expect(done.failedIterations).to.equal(0);
            expect(done.assets).to.deep.equal([]);
            expect(done.assetDiagnostics).to.not.equal(null);
        }
    });

    it("single-value ranges execute exactly one iteration", async () => {
        const { events, appended } = await runAssetBatch({ owner: 7304, start: 5, end: 5 });
        const iterations = events.filter(
            (event) => event.type === "asset_batch_iteration_done",
        ) as Array<Extract<FinderAssetOpportunityBatchStreamEvent, { type: "asset_batch_iteration_done" }>>;
        expect(iterations).to.have.length(1);
        expect(iterations[0]!.holdoutBars).to.equal(5);
        expect(appended).to.deep.equal(Array.from({ length: 1 + getAssetOpportunityResortMetrics().length }, () => "oos-holdout-5-bars.txt"));
    });

    function makeBatchRouteRequest(body: Record<string, unknown>): any {
        const req = Readable.from([JSON.stringify(body)]) as any;
        req.method = "POST";
        req.url = "/api/finder/asset-opportunity-batch-run";
        req.headers = { host: "localhost:5173", "content-type": "application/json" };
        req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5173 };
        return req;
    }

    it("route rejects an invalid range with 400 BEFORE acquiring ownership", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/asset-opportunity-batch-run")!;
        const req = makeBatchRouteRequest({
            runId: "batch-route-range",
            symbols: ["UP"],
            interval: "5m",
            options: {
                scope: "asset_opportunity",
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
                assetOpportunity: { symbols: ["UP"], candidatePoolSize: 2, minFreshSupport: 1 },
            },
            strategyKeys: ["asset_batch_test"],
            batch: { startHoldoutBars: 5, endHoldoutBars: 2 },
        });
        const res = makeRouteResponse();
        await handler(req, res);
        expect(res.statusCode).to.equal(400);
        const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
        expect(payload.error).to.match(/must not exceed/);
        // Ownership was never acquired, so no run is running.
        expect(__testInternals.getRunStateForTests()).to.equal(null);
    });

    it("route rejects an invalid archive sort with 400 BEFORE acquiring ownership", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/asset-opportunity-batch-run")!;
        const req = makeBatchRouteRequest({
            runId: "batch-route-sort",
            symbols: ["UP"],
            interval: "5m",
            options: {
                scope: "asset_opportunity",
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
                assetOpportunity: { symbols: ["UP"], candidatePoolSize: 2, minFreshSupport: 1 },
            },
            strategyKeys: ["asset_batch_test"],
            archiveSort: "not-a-real-metric",
            batch: { startHoldoutBars: 1, endHoldoutBars: 1 },
        });
        const res = makeRouteResponse();
        await handler(req, res);
        expect(res.statusCode).to.equal(400);
        const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
        expect(payload.error).to.match(/archive sort metric/);
        expect(__testInternals.getRunStateForTests()).to.equal(null);
    });

    it("route returns 409 when another run already owns the server", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/asset-opportunity-batch-run")!;
        setRunOwnerForTests(9305);
        const req = makeBatchRouteRequest({
            runId: "batch-route-conflict",
            symbols: ["UP"],
            interval: "5m",
            options: {
                scope: "asset_opportunity",
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
                assetOpportunity: { symbols: ["UP"], candidatePoolSize: 2, minFreshSupport: 1 },
            },
            strategyKeys: ["asset_batch_test"],
            batch: { startHoldoutBars: 1, endHoldoutBars: 3 },
        });
        const res = makeRouteResponse();
        await handler(req, res);
        expect(res.statusCode).to.equal(409);
        const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
        expect(payload.error).to.include("already running");
    });
});

describe("finder server plugin progress event throttle", () => {
    it("collapses rapid same-phase/same-percent writes into one stream event", () => {
        const throttle = createProgressEventThrottle();
        let writes = 0;
        const write = (): void => { writes += 1; };
        for (let index = 0; index < 200; index += 1) {
            throttle({ percent: 42, phase: "evaluating", write });
        }
        expect(writes).to.equal(1);
    });

    it("emits on phase transitions and meaningful percent deltas immediately", () => {
        const throttle = createProgressEventThrottle();
        const emitted: Array<{ percent: number; phase: string }> = [];
        const record = (percent: number, phase: string): void => {
            throttle({ percent, phase, write: () => emitted.push({ percent, phase }) });
        };
        record(0, "loading");
        record(0.2, "loading");        // same phase, small delta: suppressed
        record(0.3, "evaluating");     // phase change: emitted even though <1%
        record(0.4, "evaluating");     // suppressed
        record(2.5, "evaluating");     // >=1% delta: emitted
        expect(emitted).to.deep.equal([
            { percent: 0, phase: "loading" },
            { percent: 0.3, phase: "evaluating" },
            { percent: 2.5, phase: "evaluating" },
        ]);
    });

    it("emits again once the time threshold elapses (monotonic clock not mocked; uses large threshold)", () => {
        // With a 0ms threshold every write is older than the threshold, so
        // nothing is ever time-suppressed; the percent/phase gates still work.
        const throttle = createProgressEventThrottle(0);
        let writes = 0;
        const write = (): void => { writes += 1; };
        throttle({ percent: 1, phase: "loading", write });
        throttle({ percent: 1.05, phase: "loading", write });
        expect(writes).to.equal(2);
    });
});

describe("finder server plugin heap guard", () => {
    it("returns null for small universes regardless of heap", () => {
        expect(resolveFinderUniverseHeapWarning(50, 4096)).to.equal(null);
        expect(resolveFinderUniverseHeapWarning(0, 4096)).to.equal(null);
    });

    it("warns when a large universe exceeds the heap floor", () => {
        const warning = resolveFinderUniverseHeapWarning(500, 4096);
        expect(warning).to.not.equal(null);
        expect(warning).to.contain("500 symbols");
        expect(warning).to.contain("8192 MB");
    });

    it("warns at the very-large floor for 800+ symbols", () => {
        const warning = resolveFinderUniverseHeapWarning(900, 8192);
        expect(warning).to.not.equal(null);
        expect(warning).to.contain("900 symbols");
        expect(warning).to.contain("12288 MB");
    });

    it("passes silently when heap is sufficient", () => {
        expect(resolveFinderUniverseHeapWarning(500, 16384)).to.equal(null);
        expect(resolveFinderUniverseHeapWarning(900, 16384)).to.equal(null);
    });

    it("names the actual job kind via the scope label (Asset Opportunity reuses the thresholds)", () => {
        const warning = resolveFinderUniverseHeapWarning(500, 4096, "Asset Opportunity");
        expect(warning).to.not.equal(null);
        expect(warning).to.contain("Server-side Asset Opportunity needs more Node heap");
        // Default label keeps the historical Universe wording.
        expect(resolveFinderUniverseHeapWarning(500, 4096)).to.contain("Server-side Finder Universe");
    });
});

describe("finder server plugin toScalarCandidate (Phase 4 wire contract)", () => {
    function makeCandidate(): FinderUniverseCandidate {
        return buildFinderUniverseCandidate({
            strategyKey: "k",
            strategyName: "S",
            params: { a: 1 },
            symbols: [{
                symbol: "X",
                status: "profitable",
                barCount: 10,
                result: {
                    netProfit: 5, netProfitPercent: 5, expectancy: 5, avgTrade: 5,
                    winRate: 1, profitFactor: 2, totalTrades: 2, maxDrawdownPercent: 0,
                    winningTrades: 1, losingTrades: 0, avgWin: 5, avgLoss: 0, sharpeRatio: 0,
                },
            }],
        });
    }

    it("strips forbidden array fields defensively attached to a candidate", () => {
        const leaked: FinderUniverseCandidate & { data?: unknown; trades?: unknown } = {
            ...makeCandidate(),
            // Simulate a future code path leaking a heavy array.
            data: [1, 2, 3] as unknown as undefined,
            trades: [{ p: 1 }] as unknown as undefined,
        };
        const scalar = toScalarCandidate(leaked);
        expect("data" in scalar).to.equal(false);
        expect("trades" in scalar).to.equal(false);
        // assertCandidateIsScalar must pass on the stripped result.
        expect(() => assertCandidateIsScalar(scalar)).to.not.throw();
    });

    it("assertCandidateIsScalar throws on a forbidden field", () => {
        const leaked = { ...makeCandidate(), signals: [] } as FinderUniverseCandidate & { signals?: unknown };
        expect(() => assertCandidateIsScalar(leaked)).to.throw(/forbidden array field "signals"/);
    });

    it("preserves scalar metrics + symbols array (allowed) through the strip", () => {
        const candidate = makeCandidate();
        const scalar = toScalarCandidate(candidate);
        expect(scalar.activeSymbols).to.equal(candidate.activeSymbols);
        expect(scalar.totalTrades).to.equal(candidate.totalTrades);
        expect(scalar.symbols).to.have.length(1);
        expect(scalar.symbols[0]!.symbol).to.equal("X");
    });
});

// Audit Finding 4: a malformed nested options object used to dereference
// `.universe.symbols.length` after only a truthy check on `universe`, throwing
// a TypeError that surfaced as a 500. Each malformed shape must now throw a
// deliberate 400.
describe("assertUniverseOptions nested validation", () => {
    function expect400(partial: unknown, messageMatch: RegExp): void {
        // The function reads `options.scope` and `options.universe` only; cast
        // the partial through the same path production uses (FinderOptions).
        let caught: unknown;
        try {
            assertUniverseOptions(partial as FinderOptions);
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceof(HttpStatusError);
        expect((caught as HttpStatusError).status).to.equal(400, "must be 400, not a 500");
        expect((caught as HttpStatusError).message).to.match(messageMatch);
    }

    it("rejects a non-symbol_universe scope with 400", () => {
        expect400(
            { scope: "current_chart", universe: { symbols: ["X"] } },
            /symbol_universe/,
        );
    });

    it("rejects a missing universe with 400 (not 500 TypeError)", () => {
        expect400({ scope: "symbol_universe" }, /options\.universe must be an object/);
    });

    it("rejects an empty universe object with 400", () => {
        expect400({ scope: "symbol_universe", universe: {} }, /symbols must be an array/);
    });

    it("rejects a non-array symbols with 400", () => {
        expect400(
            { scope: "symbol_universe", universe: { symbols: 42 } },
            /symbols must be an array/,
        );
    });

    it("rejects an empty symbols array with 400", () => {
        expect400(
            { scope: "symbol_universe", universe: { symbols: [] } },
            /non-empty array/,
        );
    });

    it("rejects a non-string symbol member with 400", () => {
        expect400(
            { scope: "symbol_universe", universe: { symbols: ["OK", 42] } },
            /symbols\[1\] must be a string/,
        );
    });

    it("accepts a well-formed universe options object without throwing", () => {
        expect(() => assertUniverseOptions({
            scope: "symbol_universe",
            universe: { symbols: ["BTCUSDT", "ETHUSDT"] },
        } as FinderOptions)).to.not.throw();
    });
});

describe("finder server plugin route-level authorization (audit Finding 1)", () => {
    // Every Finder route must reject an unauthenticated non-loopback caller —
    // what a remote poller hitting a tunneled / `--host`ed dev server looks
    // like. The CPU-heavy `universe-run` route is the headline, but stop,
    // status (discloses inputs/diagnostics), and invalidate-cache (thrashes
    // caches) must all gate on the same loopback/bearer policy the Batch
    // routes enforce.
    const ROUTES = [
        { path: "/api/finder/universe-run", method: "POST" },
        { path: "/api/finder/asset-opportunity-run", method: "POST" },
        { path: "/api/finder/asset-opportunity-batch-run", method: "POST" },
        { path: "/api/finder/stop", method: "POST" },
        { path: "/api/finder/status", method: "GET" },
        { path: "/api/finder/invalidate-cache", method: "POST" },
    ];

    for (const route of ROUTES) {
        it(`rejects an unauthenticated non-loopback ${route.method} ${route.path} with 401`, async () => {
            const routes = captureFinderRoutes();
            const handler = routes.get(route.path);
            expect(handler).to.not.equal(undefined);
            // No Origin/Referer, no Authorization header, no LOCAL_PROXY_TOKEN:
            // a remote caller cannot satisfy the tokenless path (its socket is
            // not loopback and its Host header is not loopback either).
            const prevToken = process.env.LOCAL_PROXY_TOKEN;
            delete process.env.LOCAL_PROXY_TOKEN;
            try {
                const res = makeRouteResponse();
                await handler!({ method: route.method, url: route.path, headers: { host: "example.com:5173" }, socket: { remoteAddress: "203.0.113.10" } }, res);
                expect(res.statusCode).to.equal(401);
                const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
                expect(payload.ok).to.equal(false);
                expect(payload.error).to.include("local-only");
            } finally {
                if (prevToken !== undefined) process.env.LOCAL_PROXY_TOKEN = prevToken;
            }
        });
    }

    it("allows a loopback same-origin GET /status without Origin/Referer", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/status");
        expect(handler).to.not.equal(undefined);
        const res = makeRouteResponse();
        await handler!(
            {
                method: "GET",
                url: "/api/finder/status",
                socket: { remoteAddress: "127.0.0.1" },
                headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
            },
            res,
        );
        // No active run → handleStatusRequest returns `{ ok:false }` snapshot
        // → handler sends 404. The point of this assertion is that the loopback
        // caller is NOT rejected at the auth gate (401); it passes through and
        // reaches the snapshot logic.
        expect(res.statusCode).to.not.equal(401);
    });

    it("allows a loopback same-origin POST /invalidate-cache", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/invalidate-cache");
        expect(handler).to.not.equal(undefined);
        const res = makeRouteResponse();
        await handler!(
            {
                method: "POST",
                socket: { remoteAddress: "127.0.0.1" },
                headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
            },
            res,
        );
        expect(res.statusCode).to.equal(200);
        const payload = JSON.parse(res.body) as { ok?: boolean };
        expect(payload.ok).to.equal(true);
    });

    it("rejects a loopback socket with a spoofable cross-origin Host header", async () => {
        // Defense against the documented `--host`/tunnel spoof: even from a
        // loopback socket, a non-loopback Host header must be rejected.
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/status");
        const prevToken = process.env.LOCAL_PROXY_TOKEN;
        delete process.env.LOCAL_PROXY_TOKEN;
        try {
            const res = makeRouteResponse();
            await handler!(
                {
                    method: "GET",
                    url: "/api/finder/status",
                    socket: { remoteAddress: "127.0.0.1" },
                    headers: { host: "tunneled.example.com" },
                },
                res,
            );
            expect(res.statusCode).to.equal(401);
        } finally {
            if (prevToken !== undefined) process.env.LOCAL_PROXY_TOKEN = prevToken;
        }
    });
});

describe("finder server plugin deferred dataset-cache invalidation (audit Finding 3)", () => {
    const postInvalidateCache = async (): Promise<{ ok: boolean; deferred?: boolean }> => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/invalidate-cache");
        expect(handler).to.not.equal(undefined);
        const res = makeRouteResponse();
        await handler!(
            {
                method: "POST",
                socket: { remoteAddress: "127.0.0.1" },
                headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
            },
            res,
        );
        expect(res.statusCode).to.equal(200);
        return JSON.parse(res.body) as { ok: boolean; deferred?: boolean };
    };

    it("defers invalidation while a run owns the server instead of clearing mid-run caches", async () => {
        setRunOwnerForTests(1);
        const payload = await postInvalidateCache();
        expect(payload.ok).to.equal(true);
        expect(payload.deferred).to.equal(true);
        // A bounded boolean, not a queue: the flag is set, not a counter.
        expect(getPendingDatasetCacheInvalidation()).to.equal(true);
    });

    it("keeps the bounded boolean collapsed across repeated deferred requests", async () => {
        setRunOwnerForTests(1);
        await postInvalidateCache();
        await postInvalidateCache();
        expect(getPendingDatasetCacheInvalidation()).to.equal(true);
        // One flush clears it completely.
        flushPendingDatasetCacheInvalidation();
        expect(getPendingDatasetCacheInvalidation()).to.equal(false);
    });

    it("flushes immediately when no run owns the server", async () => {
        // resetRunStateForTests in afterEach guarantees runOwner === RUN_OWNER_NONE.
        const payload = await postInvalidateCache();
        expect(payload.ok).to.equal(true);
        expect(payload.deferred).to.equal(undefined);
        expect(getPendingDatasetCacheInvalidation()).to.equal(false);
    });

    it("flushes a deferred invalidation at ownership acquisition (Stop → new run boundary)", async () => {
        // Sync completes mid-run: deferred.
        setRunOwnerForTests(1);
        await postInvalidateCache();
        expect(getPendingDatasetCacheInvalidation()).to.equal(true);

        // The old run releases (Stop / terminal), then a NEW run acquires
        // ownership: the deferred clear must flush BEFORE the new run loads
        // any dataset so it cannot read pre-sync data.
        setRunOwnerForTests(0);
        const owner = acquireRunOwnershipForTests();
        expect(owner).to.be.greaterThan(0);
        expect(getPendingDatasetCacheInvalidation(), "deferred clear flushed at acquisition").to.equal(false);
    });

    it("resetRunStateForTests clears a pending deferred invalidation", async () => {
        setRunOwnerForTests(1);
        const payload = await postInvalidateCache();
        expect(payload.deferred).to.equal(true);
        expect(getPendingDatasetCacheInvalidation()).to.equal(true);
        resetRunStateForTests();
        expect(getPendingDatasetCacheInvalidation()).to.equal(false);
        expect(acquireRunOwnershipForTests()).to.be.greaterThan(0);
    });
});
