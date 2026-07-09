import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processFinderUniverseRun,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
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
const { setRunOwnerForTests, resetRunStateForTests, handleStatusRequest } = __testInternals;

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

before(() => {
    strategyRegistry.register(STRATEGY_KEY, testStrategy);
});

after(() => {
    strategyRegistry.unregister(STRATEGY_KEY);
    resetRunStateForTests();
});

afterEach(() => {
    resetRunStateForTests();
});

describe("finder server plugin processFinderUniverseRun", () => {
    it("emits start, candidate, and done events in order with scalar-only candidates", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 7001;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processFinderUniverseRun(
                {
                    interval: "5m",
                    symbols: ["UP", "DOWN"],
                    options: makeOptions(["UP", "DOWN"]),
                    settings,
                    capitalSettings,
                    selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    generateParamSets: () => [{ threshold: 1 }, { threshold: 2 }],
                },
                (event) => ev.push(event),
                owner,
            ),
        );

        // Sequence: start, progress*, candidate*, done.
        expect(events[0]!.type).to.equal("start");
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("done");
        const startEvent = events[0] as Extract<FinderStreamEvent, { type: "start" }>;
        expect(startEvent.totalSymbols).to.equal(2);
        expect(startEvent.strategyKey).to.equal(STRATEGY_KEY);

        const candidateEvents = events.filter((e) => e.type === "candidate") as Array<Extract<FinderStreamEvent, { type: "candidate" }>>;
        // testStrategy emits signals for thresholds 1 and 2; both symbols pass
        // universe filters, so survivors exist.
        expect(candidateEvents.length).to.be.greaterThan(0);

        // D regression: the candidate event's `index` must be a real position
        // in the snapshot (>= 0 for at least one emitted candidate), not the
        // always-(-1) by-reference indexOf() result on a deep-cloned scalar.
        const indices = candidateEvents.map((e) => e.index);
        expect(indices.some((i) => i >= 0), "at least one candidate index must be a real position, not -1").to.equal(true);

        // MEMORY CONTRACT (Phase 4): every streamed candidate must be scalar —
        // no data/signals/trades/equityCurve arrays anywhere on it or its
        // per-symbol results. Deep-scan.
        for (const { candidate } of candidateEvents) {
            assertCandidateIsScalar(candidate);
            const json = JSON.stringify(candidate);
            for (const forbidden of FINDER_CANDIDATE_FORBIDDEN_ARRAY_FIELDS) {
                expect(json, `candidate must not serialize forbidden field "${forbidden}"`).to.not.contain(`"${forbidden}"`);
            }
        }

        // F3 regression: the done event MUST carry the terminal survivor slice.
        // The 750ms results throttle can skip the final passers, so the browser
        // finalizes from done.candidates (not the incremental candidate stream).
        const doneEvent = done as Extract<FinderStreamEvent, { type: "done" }>;
        expect(Array.isArray(doneEvent.candidates)).to.equal(true);
        expect(doneEvent.candidates.length).to.be.greaterThan(0);
        expect(doneEvent.candidates.length).to.equal(doneEvent.totals.survivors);
        for (const candidate of doneEvent.candidates) {
            assertCandidateIsScalar(candidate);
        }
    });

    it("F1 regression: produces candidates only when generateParamSets is supplied", async () => {
        // The core falls back to () => [] when generateParamSets is missing,
        // producing zero candidates ("No valid parameter combinations
        // generated."). The HTTP handler must pass a real generator. This test
        // locks both sides of that contract: with a generator -> survivors;
        // without -> the run ends with zero survivors (not a crash).
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 7101;
        setRunOwnerForTests(owner);

        // WITH a generator: survivors exist.
        const eventsWith = await collectEvents((ev) =>
            processFinderUniverseRun(
                {
                    interval: "5m",
                    symbols: ["UP", "DOWN"],
                    options: makeOptions(["UP", "DOWN"]),
                    settings,
                    capitalSettings,
                    selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    generateParamSets: () => [{ threshold: 1 }],
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        const doneWith = eventsWith[eventsWith.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(doneWith.type).to.equal("done");
        expect(doneWith.totals.survivors).to.be.greaterThan(0);

        // WITHOUT a generator: the core falls back to () => [], no candidates
        // pass filters, the run completes with zero survivors. This is the
        // state the production HTTP handler would hit if it forgot to pass
        // generateParamSets — the test documents that fallback so the handler
        // wiring (which supplies a real FinderParamSpace) is clearly load-bearing.
        resetRunStateForTests();
        setRunOwnerForTests(owner + 1);
        const eventsWithout = await collectEvents((ev) =>
            processFinderUniverseRun(
                {
                    interval: "5m",
                    symbols: ["UP", "DOWN"],
                    options: makeOptions(["UP", "DOWN"]),
                    settings,
                    capitalSettings,
                    selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    // generateParamSets intentionally omitted
                },
                (event) => ev.push(event),
                owner + 1,
            ),
        );
        const lastWithout = eventsWithout[eventsWithout.length - 1]!;
        // Either a `done` with zero survivors, or a `fatal` from the runner's
        // "No valid parameter combinations generated." short-circuit. Both
        // prove the fallback produced no candidates.
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
        const owner = 7002;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processFinderUniverseRun(
                {
                    interval: "5m",
                    symbols: ["UP", "DOWN", "MISSING"],
                    options: makeOptions(["UP", "DOWN", "MISSING"]),
                    settings,
                    capitalSettings,
                    selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                    loadDataset: (symbol) => {
                        const d = datasets.get(symbol);
                        if (!d) throw new Error("Dataset missing");
                        return Promise.resolve(d);
                    },
                    generateParamSets: () => [{ threshold: 1 }],
                },
                (event) => ev.push(event),
                owner,
            ),
        );

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.ok).to.equal(true);
        expect(done.totals.failedSymbols).to.equal(1);
        expect(done.totals.loadedSymbols).to.equal(2);
    });

    it("emits a fatal event when no universe symbols can be loaded", async () => {
        const owner = 7003;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processFinderUniverseRun(
                {
                    interval: "5m",
                    symbols: ["GONE1", "GONE2"],
                    options: makeOptions(["GONE1", "GONE2"]),
                    settings,
                    capitalSettings,
                    selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                    loadDataset: () => Promise.reject(new Error("No candles")),
                    generateParamSets: () => [{ threshold: 1 }],
                },
                (event) => ev.push(event),
                owner,
            ),
        );

        const fatal = events[events.length - 1] as Extract<FinderStreamEvent, { type: "fatal" }>;
        expect(fatal.type).to.equal("fatal");
        expect(fatal.error).to.contain("No universe symbols could be loaded");
    });

    it("stops emitting after ownership is lost (Stop semantics)", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 7004;
        setRunOwnerForTests(owner);

        const events: FinderStreamEvent[] = [];
        await processFinderUniverseRun(
            {
                interval: "5m",
                symbols: ["UP", "DOWN"],
                options: makeOptions(["UP", "DOWN"]),
                settings,
                capitalSettings,
                selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                generateParamSets: () => [{ threshold: 1 }],
            },
            (event) => {
                events.push(event);
                // Simulate Stop firing after the first event: bump the owner.
                if (events.length === 1) {
                    setRunOwnerForTests(owner + 999);
                }
            },
            owner,
        );

        const done = events[events.length - 1] as Extract<FinderStreamEvent, { type: "done" }>;
        expect(done.type).to.equal("done");
        expect(done.cancelled).to.equal(true);
        expect(done.ok).to.equal(false);
    });

    it("handleStatusRequest reflects in-flight run state", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 7005;
        setRunOwnerForTests(owner);

        await processFinderUniverseRun(
            {
                interval: "5m",
                symbols: ["UP", "DOWN"],
                options: makeOptions(["UP", "DOWN"]),
                settings,
                capitalSettings,
                selectedStrategy: { key: STRATEGY_KEY, name: testStrategy.name, strategy: testStrategy },
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                generateParamSets: () => [{ threshold: 1 }],
            },
            () => {},
            owner,
        );

        // Simulate the HTTP handler's finally (which clears the owner after
        // the run completes) so status reflects the post-run snapshot.
        setRunOwnerForTests(0);
        const status = handleStatusRequest() as {
            running: boolean;
            lastRun: { candidateCount: number; diagnostics: { engineMode: string } | null } | null;
        };
        expect(status.running).to.equal(false);
        expect(status.lastRun).to.not.equal(null);
        expect(status.lastRun!.candidateCount).to.be.greaterThanOrEqual(0);
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
