import { expect } from "chai";
import { describe, it, before, after, afterEach } from "node:test";
import { Readable } from "node:stream";
import { strategyRegistry } from "../strategyRegistry";
import {
    processFinderMonthlyRankReplayRun,
    __testInternals,
} from "../lib/finder/server/finder-vite-plugin";
import {
    assertReplayCheckpointIsScalar,
    assertReplayReportIsScalar,
    type FinderReplayStreamEvent,
} from "../lib/finder/server/finder-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const {
    resetRunStateForTests,
    handleStatusRequest,
    setRunOwnerForTests,
    getRunOwnerForTests,
} = __testInternals;

// Deterministic daily fixtures spanning the 2023-01..02 checkpoints with a
// complete forward horizon. Month boundaries align with UTC-midnight bars.
const BASE_TIME = Date.UTC(2022, 11, 1) / 1000; // 2022-12-01
const DAY = 86400;
const BAR_COUNT = 70; // through 2023-02-09

function makeCloses(kind: "UP" | "DOWN"): number[] {
    return Array.from({ length: BAR_COUNT }, (_, i) => (kind === "UP" ? 50 + i : 100 - i * 0.25));
}

function buildData(kind: "UP" | "DOWN"): OHLCVData[] {
    return makeCloses(kind).map((close, i) => ({
        time: (BASE_TIME + i * DAY) as Time,
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 1000,
    }));
}

const replayStrategy: Strategy = {
    name: "Replay Server Test",
    description: "Deterministic strategy for replay server-job tests.",
    defaultParams: { period: 5 },
    paramLabels: { period: "Period" },
    execute(data, params) {
        const period = Math.max(1, Math.round(Number(params.period ?? 5)));
        const signals = [];
        for (let i = 0; i < data.length; i += 1) {
            if (i % period === 0) {
                signals.push({ barIndex: i, time: data[i]!.time, type: "buy" as const, price: data[i]!.close });
            }
        }
        return signals;
    },
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "fixed",
    fixedTradeAmount: 1_000,
};

const STRATEGY_KEY = "replay_server_test";

function makeOptions(): FinderOptions {
    return {
        scope: "symbol_universe",
        mode: "random",
        sortPriority: ["expectancy"],
        useAdvancedSort: false,
        topN: 5,
        steps: 1,
        rangePercent: 0,
        maxRuns: 2,
        randomSeed: 7,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        monthlyRankReplay: { fromYear: 2023, evalWindowBars: 15, forwardBars: 8 },
        universe: {
            symbols: ["UP", "DOWN"],
            minActiveSymbols: 1,
            minTotalTrades: 0,
            minProfitableActiveRatio: 0,
            sortPriority: ["medianExpectancy"],
        },
    };
}

interface RunResult {
    events: FinderReplayStreamEvent[];
    runId: string;
}

async function runReplayJob(args?: {
    runId?: string;
    abortSignal?: AbortSignal;
    owner?: number;
    options?: FinderOptions;
}): Promise<RunResult> {
    const runId = args?.runId ?? "replay-server-test";
    const owner = args?.owner ?? 9100;
    // The runner's cancellation callback checks the MODULE-SCOPE owner lock;
    // a direct call must install ownership exactly like the HTTP handler.
    setRunOwnerForTests(owner);
    const events: FinderReplayStreamEvent[] = [];
    await processFinderMonthlyRankReplayRun(
        {
            runId,
            interval: "1d",
            symbols: ["UP", "DOWN"],
            options: args?.options ?? makeOptions(),
            settings,
            capitalSettings,
            selectedStrategies: [{ key: STRATEGY_KEY, name: replayStrategy.name, strategy: replayStrategy }],
            loadDataset: async (symbol) => {
                const data = symbol === "UP" ? buildData("UP") : symbol === "DOWN" ? buildData("DOWN") : null;
                if (!data) throw new Error(`unexpected symbol ${symbol}`);
                return data;
            },
            generateParamSets: () => [{ period: 5 }, { period: 10 }],
            abortSignal: args?.abortSignal,
        },
        (event) => events.push(event),
        owner,
    );
    return { events, runId };
}

type FinderRouteHandler = (req: any, res: any) => Promise<void>;

function captureFinderRoutes(): Map<string, FinderRouteHandler> {
    const routes = new Map<string, FinderRouteHandler>();
    const { registerFinderRoutesForTests } = __testInternals;
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

before(() => {
    strategyRegistry.register(STRATEGY_KEY, replayStrategy);
});

after(() => {
    strategyRegistry.unregister(STRATEGY_KEY);
    resetRunStateForTests();
});

afterEach(() => {
    resetRunStateForTests();
    setRunOwnerForTests(0);
});

describe("finder server Monthly Rank Replay job", () => {
    it("streams replay events, publishes the terminal report, and exposes it via /status", async () => {
        const runId = "replay-status-check";
        const { events } = await runReplayJob({ runId });

        expect(events[0]!.type).to.equal("replay_start");
        expect(events[events.length - 1]!.type).to.equal("replay_done");
        // No ordinary universe events may leak into a replay stream.
        const types = new Set<string>(events.map((event) => event.type));
        expect(types.has("candidate")).to.equal(false);
        expect(types.has("done")).to.equal(false);
        expect(types.has("fatal")).to.equal(false);

        const done = events[events.length - 1]! as Extract<FinderReplayStreamEvent, { type: "replay_done" }>;
        expect(done.ok).to.equal(true);
        expect(done.cancelled).to.equal(false);
        expect(done.report.kind).to.equal("monthly_rank_replay");
        expect(done.report.experiment.engine).to.equal("typescript");
        expect(done.report.sortSummaries.length).to.equal(15);
        expect(done.report.selections.some((selection) => selection.status === "measured")).to.equal(true);
        // The terminal payload passes the same scalar guard the checkpoint
        // events use (defense-in-depth on the done/report transport path).
        expect(() => assertReplayReportIsScalar(done.report)).to.not.throw();

        const start = events[0]! as Extract<FinderReplayStreamEvent, { type: "replay_start" }>;
        expect(start.replayedSortKeys).to.not.include("windowStabilityScore");
        expect(start.excludedSortKeys).to.deep.equal(["windowStabilityScore"]);

        // /status reattach: terminal snapshot carries the report; the universe
        // candidate slice must stay empty for a replay job.
        const snapshot = handleStatusRequest(runId);
        if (!("ok" in snapshot) || snapshot.ok !== true) {
            throw new Error("expected a snapshot");
        }
        expect(snapshot.terminal).to.equal(true);
        expect(snapshot.jobKind).to.equal("monthly_rank_replay");
        expect(snapshot.terminalReplay?.kind).to.equal("monthly_rank_replay");
        expect(snapshot.terminalCandidates).to.equal(null);
        expect(snapshot.summary).to.contain("Done");
    });

    it("completes as cancelled when the abort signal fires", async () => {
        const controller = new AbortController();
        // Cancel after the run has started consuming checkpoints: abort at the
        // first checkpoint emission.
        let checkpointCount = 0;
        const runId = "replay-abort-check";
        setRunOwnerForTests(9100);
        const events: FinderReplayStreamEvent[] = [];
        await processFinderMonthlyRankReplayRun(
            {
                runId,
                interval: "1d",
                symbols: ["UP", "DOWN"],
                options: makeOptions(),
                settings,
                capitalSettings,
                selectedStrategies: [{ key: STRATEGY_KEY, name: replayStrategy.name, strategy: replayStrategy }],
                loadDataset: async (symbol) => buildData(symbol as "UP" | "DOWN"),
                generateParamSets: () => [{ period: 5 }],
                abortSignal: controller.signal,
            },
            (event) => {
                events.push(event);
                if (event.type === "replay_checkpoint" && checkpointCount === 0) {
                    checkpointCount += 1;
                    controller.abort();
                }
            },
            9100,
        );

        const done = events[events.length - 1]! as Extract<FinderReplayStreamEvent, { type: "replay_done" }>;
        expect(done.cancelled).to.equal(true);
        expect(done.ok).to.equal(false);
        expect(done.report.stoppedEarly?.reason).to.equal("cancelled");
        // Cancellation never looks like successful completion.
        const snapshot = handleStatusRequest(runId);
        if (!("ok" in snapshot) || snapshot.ok !== true) throw new Error("expected a snapshot");
        expect(snapshot.phase).to.equal("cancelled");
        expect(snapshot.cancelled).to.equal(true);
    });

    it("rejects a scalar-contract violation on checkpoint payloads", () => {
        const checkpoint = { index: 1, label: "2023-01", timeSec: 1, status: "measured" as const, distinctWinners: 1 };
        expect(() => assertReplayCheckpointIsScalar({ checkpoint, outcomes: [], selections: [] })).to.not.throw();
        expect(() => assertReplayCheckpointIsScalar({
            checkpoint,
            outcomes: [{
                checkpointIndex: 1,
                checkpointLabel: "2023-01",
                identityKey: "x",
                strategyKey: "s",
                strategyName: "S",
                params: {},
                status: "measured",
                windowReturnPercent: 1,
                totalTrades: 1,
                forwardStartSec: 1,
                forwardEndSec: 2,
                symbols: [],
                // Forbidden heavy array smuggled onto the outcome.
                trades: [{ price: 1 }],
            } as never],
            selections: [],
        })).to.throw(/forbidden array field "trades"/);
    });

    it("rejects a scalar-contract violation on the terminal report payload", () => {
        const baseReport = {
            kind: "monthly_rank_replay" as const,
            runId: "r",
            experiment: {
                fromYear: 2023,
                evalWindowBars: 1,
                forwardBars: 1,
                interval: "1d",
                symbols: ["A"],
                strategyKeys: ["s"],
                replayedSorts: [],
                excludedSorts: [],
                engine: "typescript" as const,
                sizingMode: "fixed" as const,
                capitalSettings: {},
                candidatePool: { requestedRunsPerStrategy: 1, actualCandidates: 1, seed: 1 },
                conventions: {
                    checkpoint: "c",
                    historicalWindow: "h",
                    forwardWindow: "f",
                    signalPolicy: "s",
                    accounting: "a",
                },
            },
            checkpoints: [],
            symbolCoverage: [],
            forwardOutcomes: [],
            selections: [],
            sortSummaries: [],
        };
        expect(() => assertReplayReportIsScalar(baseReport)).to.not.throw();
        expect(() => assertReplayReportIsScalar({
            ...baseReport,
            forwardOutcomes: [{
                checkpointIndex: 0,
                checkpointLabel: "2023-01",
                identityKey: "x",
                strategyKey: "s",
                strategyName: "S",
                params: {},
                status: "measured" as const,
                windowReturnPercent: 1,
                totalTrades: 1,
                forwardStartSec: 1,
                forwardEndSec: 2,
                symbols: [],
                equityCurve: [{ time: 1, value: 1 }],
            } as never],
        })).to.throw(/forbidden array field "equityCurve"/);
    });
});

describe("finder server replay route validation", () => {
    function makeRouteRequest(body: Record<string, unknown>): any {
        const req = Readable.from([JSON.stringify(body)]) as any;
        req.method = "POST";
        req.url = "/api/finder/universe-run";
        req.headers = { host: "localhost:5173", "content-type": "application/json" };
        req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5173 };
        return req;
    }

    it("rejects malformed explicit replay options with 400 BEFORE acquiring ownership", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/universe-run")!;
        const res = makeRouteResponse();
        await handler(
            makeRouteRequest({
                runId: "replay-route-invalid",
                symbols: ["UP"],
                interval: "1d",
                options: {
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
                    monthlyRankReplay: { fromYear: "recent", evalWindowBars: 10, forwardBars: 5 },
                    universe: { symbols: ["UP"], minActiveSymbols: 1, minTotalTrades: 0, minProfitableActiveRatio: 0 },
                },
                strategyKeys: [STRATEGY_KEY],
            }),
            res,
        );
        expect(res.statusCode).to.equal(400);
        const payload = JSON.parse(res.body) as { error?: string };
        expect(payload.error).to.match(/fromYear/);
        // Ownership was never acquired: no run state was installed and the
        // module-scope run-owner lock is untouched. A 400 after acquisition
        // would leak the lock and 409-lock every later Finder run.
        expect(__testInternals.getRunStateForTests()).to.equal(null);
        expect(getRunOwnerForTests()).to.equal(0);
    });

    it("rejects non-positive L/H with 400 BEFORE acquiring ownership", async () => {
        const routes = captureFinderRoutes();
        const handler = routes.get("/api/finder/universe-run")!;
        const res = makeRouteResponse();
        await handler(
            makeRouteRequest({
                runId: "replay-route-horizon",
                symbols: ["UP"],
                interval: "1d",
                options: {
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
                    monthlyRankReplay: { fromYear: 2023, evalWindowBars: 0, forwardBars: 5 },
                    universe: { symbols: ["UP"], minActiveSymbols: 1, minTotalTrades: 0, minProfitableActiveRatio: 0 },
                },
                strategyKeys: [STRATEGY_KEY],
            }),
            res,
        );
        expect(res.statusCode).to.equal(400);
        const payload = JSON.parse(res.body) as { error?: string };
        expect(payload.error).to.match(/evalWindowBars/);
        expect(__testInternals.getRunStateForTests()).to.equal(null);
        expect(getRunOwnerForTests()).to.equal(0);
    });
});
