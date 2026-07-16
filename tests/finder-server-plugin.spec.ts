import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processFinderUniverseRun,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
import { HttpStatusError } from "../lib/vite-http-utils";
import { resolveFinderUniverseHeapWarning } from "../lib/finder/server/finder-server-heap-guard";
import {
    assertCandidateIsScalar,
    toScalarCandidate,
    FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS,
    type FinderStreamEvent,
} from "../lib/finder/server/finder-stream-types";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
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
        expect(done.diagnostics?.universe?.jobDatasetCache).to.deep.equal({
            requests: 4,
            hits: 2,
            misses: 2,
            successfulLoads: 2,
            failedLoads: 0,
            entries: 2,
            uniqueBarsLoaded: 10,
        });
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
