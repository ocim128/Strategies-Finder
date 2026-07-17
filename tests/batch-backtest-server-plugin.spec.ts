import { expect } from "chai";
import { describe, it, after, afterEach, before } from "node:test";
import { Readable } from "node:stream";
import { strategyRegistry } from "../strategyRegistry";
import {
    processRunBatch,
    processMine,
    processStabilityMine,
    processMinePrediction,
    resolveServerBatchHeapWarning,
    ArtifactStore,
    type BatchRunSnapshot,
    __testInternals,
} from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type { BatchStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

// The plugin holds module-scope state (runOwner, artifact files, etc.). The
// handlers under test mutate that state, so each test must reset the relevant
// pieces. `releaseLastResults` is the documented reset path.
const {
    releaseLastResults,
    hasMineableArtifacts,
    hasStoredMineArtifacts,
    getParsedArtifactCacheSizeForTests,
    setRunOwnerForTests,
    completeRunForTests,
    setMinerOwnerForTests,
    setMinerAbortControllerForTests,
    setMinerGatesForTests,
    resetMinerGatesForTests,
    getRunStateForTests,
    setRunStateForTests,
    handleStatusRequest,
    handleStopRequest,
    registerBatchRoutesForTests,
    pushPendingArtifactWriteForTests,
    getMineArtifactDirForTests,
    ensureMineArtifactDirForTests,
    parseBatchRunId,
    consumePendingBatchStopForRun,
    setPendingStopRunIdForTests,
    getPendingStopRunIdForTests,
    setRunReservationForTests,
    getRunOwnerForTests,
    shouldSweepOrphanEntryForTests,
    MINE_ARTIFACT_DIR_PREFIX_FOR_TESTS,
    ORPHAN_SWEEP_STALE_MS_FOR_TESTS,
} = __testInternals;

type RouteHandler = (req: any, res: any) => Promise<void>;

function captureBatchRoutes(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    registerBatchRoutesForTests({ use: (path: string, handler: RouteHandler) => routes.set(path, handler) });
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
    name: "Server Batch Test",
    description: "Deterministic strategy for server-plugin tests.",
    defaultParams: { threshold: 1 },
    paramLabels: { threshold: "Threshold" },
    execute(data, params) {
        if (data.length < 3) return [];
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

const STRATEGY_KEY = "server_batch_test";

before(() => {
    strategyRegistry.register(STRATEGY_KEY, testStrategy);
});

after(async () => {
    strategyRegistry.unregister(STRATEGY_KEY);
    await releaseLastResults("test_cleanup");
});

function collectEvents(runner: (events: BatchStreamEvent[]) => Promise<void>): Promise<BatchStreamEvent[]> {
    const events: BatchStreamEvent[] = [];
    return runner(events).then(() => events);
}

describe("batch-backtest server plugin processRunBatch", () => {
    it("emits start, per-symbol, and done events in order", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 9001;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP", "DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );

        // Sequence: start, progress*, symbol x N, done.
        expect(events[0]!.type).to.equal("start");
        const done = events[events.length - 1]!;
        expect(done.type).to.equal("done");
        const symbols = events.filter((e) => e.type === "symbol");
        expect(symbols.length).to.equal(2);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("scalar-only wire transport: row.data and row.signals are undefined", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
        ]);
        const owner = 9002;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        const symbolEvent = events.find((e): e is Extract<BatchStreamEvent, { type: "symbol" }> => e.type === "symbol")!;
        expect(symbolEvent.row.data).to.equal(undefined);
        expect(symbolEvent.row.signals).to.equal(undefined);
        // result is sent (scalars), but its trades array is empty so the
        // wire stays small even for high-trade-count pairs.
        expect(symbolEvent.row.result).to.not.equal(undefined);
        expect(symbolEvent.row.result!.trades).to.deep.equal([]);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("done event carries serverHasArtifacts=false when no synthetic pairs ran", async () => {
        const datasets = new Map<string, OHLCVData[]>([["UP", makeCandles([100, 105, 110, 115, 120])]]);
        const owner = 9003;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        const done = events[events.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        expect(done.serverHasArtifacts).to.equal(false);
        // Non-synthetic run: artifacts released immediately, no TTL scheduled.
        // (hasMineableArtifacts on the global lastResults should be false.)
        expect(hasMineableArtifacts([])).to.equal(false);

        setRunOwnerForTests(0);
    });

    it("done event carries serverHasArtifacts=true for synthetic pairs stored on disk", async () => {
        const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", makeCandles([100, 105, 110, 115, 120])]]);
        const owner = 9006;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP+DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        const done = events[events.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        expect(done.serverHasArtifacts).to.equal(true);
        expect(done.cacheStats?.disk.writes).to.be.a("number");
        expect(hasStoredMineArtifacts()).to.equal(true);
        expect(getParsedArtifactCacheSizeForTests()).to.equal(0);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("done event carries artifactStats and parsedCacheStats (audit artifact-stats + parse-cache findings)", async () => {
        // Intent being locked (AGENTS.md rule 8): the `done` event MUST carry
        // the partial-write + LRU snapshots so a reloaded tab or a benchmark
        // consumer can observe disk-pressure failures and heap-bound behavior
        // without polling. A missing `artifactStats` field would hide partial
        // failures; a missing `parsedCacheStats` would hide an LRU regression
        // that re-introduced unbounded heap retention.
        const datasets = new Map<string, OHLCVData[]>([
            ["AAA+BBB", makeCandles([100, 105, 110, 115, 120])],
            ["CCC+DDD", makeCandles([100, 105, 110, 115, 120])],
        ]);
        const owner = 9906;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["AAA+BBB", "CCC+DDD"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        const done = events[events.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        // Both synthetic pairs passed the gate and wrote successfully.
        expect(done.artifactStats, "artifactStats present on done").to.not.equal(undefined);
        expect(done.artifactStats!.eligible).to.equal(2);
        expect(done.artifactStats!.stored).to.equal(2);
        expect(done.artifactStats!.failed).to.equal(0);
        expect(done.artifactStats!.bytesWritten, "byte counter positive").to.be.greaterThan(0);
        // parsedCacheStats present (size is 0 here because Mine never ran;
        // the cap and counters are still observable for diagnostics).
        expect(done.parsedCacheStats, "parsedCacheStats present on done").to.not.equal(undefined);
        expect(done.parsedCacheStats!.max, "cap is 32").to.equal(32);
        // The summary MUST NOT include the partial-write warning when there
        // were zero failures — only surface it when failed > 0.
        expect(done.summary).to.not.include("Mine will omit");

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("status snapshot can return only rows after the requested offset", async () => {
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
            ["FLAT", makeCandles([100, 100, 100, 100, 100])],
        ]);
        const owner = 9012;
        setRunOwnerForTests(owner);

        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP", "DOWN", "FLAT"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
        );

        const snapshot = handleStatusRequest(2) as { run?: { rows: { symbol: string }[]; rowOffset: number; rowCount: number; nextOffset: number | null } | null };
        expect(snapshot.run?.rowOffset).to.equal(2);
        expect(snapshot.run?.rowCount).to.equal(3);
        expect(snapshot.run?.rows.map((row) => row.symbol)).to.deep.equal(["FLAT"]);
        // Only one row remains past offset 2, so the cursor is exhausted.
        expect(snapshot.run?.nextOffset).to.equal(null);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("status snapshot paginates rows via nextOffset when a limit truncates", async () => {
        // Build a 5-symbol run, then request a small page so the response is
        // truncated and nextOffset points at the remaining rows.
        const datasets = new Map<string, OHLCVData[]>();
        const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
        for (const sym of symbols) {
            datasets.set(sym, makeCandles([100, 105, 110, 115, 120]));
        }
        const owner = 9013;
        setRunOwnerForTests(owner);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols,
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
        );

        // Page 1: after=0, limit=2 → first two symbols, nextOffset=2.
        const page1 = handleStatusRequest(0, 2) as { run?: { rows: { symbol: string }[]; rowOffset: number; rowCount: number; nextOffset: number | null } | null };
        expect(page1.run?.rowOffset).to.equal(0);
        expect(page1.run?.rowCount).to.equal(5);
        expect(page1.run?.rows.map((row) => row.symbol)).to.deep.equal(["AAA", "BBB"]);
        expect(page1.run?.nextOffset).to.equal(2);

        // Page 2: after=2, limit=2 → next two symbols, nextOffset=4.
        const page2 = handleStatusRequest(2, 2) as { run?: { rows: { symbol: string }[]; rowOffset: number; rowCount: number; nextOffset: number | null } | null };
        expect(page2.run?.rows.map((row) => row.symbol)).to.deep.equal(["CCC", "DDD"]);
        expect(page2.run?.nextOffset).to.equal(4);

        // Page 3: after=4, limit=2 → last symbol, cursor exhausted (null).
        const page3 = handleStatusRequest(4, 2) as { run?: { rows: { symbol: string }[]; rowOffset: number; rowCount: number; nextOffset: number | null } | null };
        expect(page3.run?.rows.map((row) => row.symbol)).to.deep.equal(["EEE"]);
        expect(page3.run?.nextOffset).to.equal(null);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("lastRun paginates completed scalar rows + carries strategyKey for recovery (audit findings 3 & 5)", async () => {
        // After a run completes (runOwner -> NONE) but before its artifacts TTL,
        // the server retains the full scalar row list in runState. Recovery from
        // a truncated stream needs both the rows (to reconstruct the result
        // table) and the governing strategyKey (so Mine provenance is correct).
        // Use synthetic pairs so artifacts (and thus lastRun) are retained.
        const datasets = new Map<string, OHLCVData[]>();
        const symbols = ["AAA+BBB", "CCC+DDD", "EEE+FFF"];
        for (const sym of symbols) {
            datasets.set(sym, makeCandles([100, 105, 110, 115, 120]));
        }
        const owner = 9020;
        setRunOwnerForTests(owner);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols,
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
        );
        // Simulate run completion: the HTTP handler's `finally` releases
        // ownership while preserving runState as the lastRun snapshot. Use
        // `completeRunForTests` (NOT `setRunOwnerForTests(0)`, which also
        // nulls runState — a stricter reset that prevents the lastRun branch
        // from being exercised).
        completeRunForTests();

        const status = handleStatusRequest() as {
            running?: boolean;
            lastRun?: {
                rowCount?: number;
                strategyKey?: string | null;
                fingerprint?: string | null;
                rows?: { symbol: string }[];
                rowOffset?: number;
                nextOffset?: number | null;
            } | null;
        };
        // Running is false now; lastRun must carry the completed snapshot.
        expect(status.running).to.equal(false);
        expect(status.lastRun).to.not.equal(null);
        expect(status.lastRun?.strategyKey).to.equal(STRATEGY_KEY);
        expect(status.lastRun?.rowCount).to.equal(3);
        // Default page returns the leading rows with a cursor when truncated.
        expect(status.lastRun?.rows?.map((r) => r.symbol)).to.deep.equal(symbols);
        expect(status.lastRun?.rowOffset).to.equal(0);
        expect(status.lastRun?.nextOffset).to.equal(null); // all rows fit one page

        // Pagination: after=2 returns only the last row.
        const page = handleStatusRequest(2) as {
            lastRun?: { rows?: { symbol: string }[]; rowOffset?: number; nextOffset?: number | null } | null;
        };
        expect(page.lastRun?.rows?.map((r) => r.symbol)).to.deep.equal(["EEE+FFF"]);
        expect(page.lastRun?.nextOffset).to.equal(null);

        // Full reset for test isolation: null runState AND release artifacts.
        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("lastRun pagination cursor returns nextOffset across multiple pages (audit finding 3 regression guard)", async () => {
        // Regression guard for a bug where the browser recovery loop condition
        // was `nextOffset > lastResults.length`, which exited one page early:
        // after fetching rows [N, 2N), nextOffset === 2N === lastResults.length,
        // so `2N > 2N` was false and the loop stopped with rows remaining.
        // The server-side half: with > DEFAULT_STATUS_ROW_LIMIT (250) rows, the
        // first page must carry a non-null nextOffset pointing at the next page.
        const datasets = new Map<string, OHLCVData[]>();
        const symbols: string[] = [];
        // 260 synthetic pairs → first page (default 250) + a second page of 10.
        for (let i = 0; i < 260; i += 1) {
            const sym = `A${i}+B${i}`;
            symbols.push(sym);
            datasets.set(sym, makeCandles([100, 105, 110, 115, 120]));
        }
        const owner = 9021;
        setRunOwnerForTests(owner);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols,
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
        );
        completeRunForTests();

        // Page 1 (default limit 250): nextOffset must point at 250, not null.
        const page1 = handleStatusRequest() as {
            lastRun?: { rowCount?: number; rows?: { symbol: string }[]; rowOffset?: number; nextOffset?: number | null } | null;
        };
        expect(page1.lastRun?.rowCount).to.equal(260);
        expect(page1.lastRun?.rows?.length).to.equal(250);
        expect(page1.lastRun?.nextOffset).to.equal(250);

        // Page 2 (after=250): the final 10 rows, cursor exhausted.
        const page2 = handleStatusRequest(250) as {
            lastRun?: { rows?: { symbol: string }[]; rowOffset?: number; nextOffset?: number | null } | null;
        };
        expect(page2.lastRun?.rows?.length).to.equal(10);
        expect(page2.lastRun?.nextOffset).to.equal(null);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("does not emit a redundant setStatus-driven progress event per symbol", async () => {
        // The runner calls setProgress(real%) then setStatus(symbol text) in
        // the same tick. Previously the server emitted TWO progress writes per
        // symbol (one per callback), and the setStatus one reset percent to 0
        // before the lastPercent fix, then duplicated it after. Now setStatus
        // is a no-op for emission: setProgress already carries both the percent
        // and a status-bearing text line, so exactly one progress event should
        // appear per symbol start (plus the terminal 100% Done) — never a
        // second, redundant one. This is the protocol invariant: N symbols
        // must produce ~N progress events, not ~2N.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 9014;
        setRunOwnerForTests(owner);

        const events = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP", "DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );

        const progressEvents = events.filter((e): e is Extract<BatchStreamEvent, { type: "progress" }> => e.type === "progress");
        // Every progress event must carry a non-negative percent; no event
        // may reset the bar to 0 after a higher percent was seen.
        let maxSeen = 0;
        for (const ev of progressEvents) {
            if (ev.percent > 0) maxSeen = Math.max(maxSeen, ev.percent);
            expect(ev.percent).to.be.at.least(0);
            // After the first non-zero percent, no later event may drop below
            // the running max — that would mean the bar snapped backwards.
            if (maxSeen > 0 && ev.percent < maxSeen && ev.percent !== 100) {
                expect.fail(`progress percent snapped backwards: ${ev.percent} after ${maxSeen}`);
            }
        }
        // The runner emits one setProgress per symbol start (2 symbols) plus a
        // terminal setProgress(100, "Done"). No setStatus-driven duplicates.
        // (Some symbols may also emit a setProgress on the prefetch path, so
        // assert a strict upper bound rather than exact equality: the key
        // invariant is "no second write per symbol".)
        expect(progressEvents.length).to.be.at.most(4);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("onSymbolStart populates currentSymbol in the run snapshot mid-run", async () => {
        // Finding 6: the server plugin wires onSymbolStart to set
        // snapshot.currentSymbol so a reattached tab sees which pair is active.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
            ["DOWN", makeCandles([100, 95, 90, 85, 80])],
        ]);
        const owner = 9015;
        setRunOwnerForTests(owner);

        // Drive the run with a controllable loader so we can observe
        // currentSymbol mid-run (after the first symbol starts, before the
        // second completes). We resolve datasets one at a time via a gate.
        let firstStarted = false;
        const gate = { releaseSecond: false };
        const loader = (symbol: string): Promise<OHLCVData[]> => {
            if (symbol === "UP") {
                firstStarted = true;
                return Promise.resolve(datasets.get(symbol) ?? []);
            }
            // Block the second symbol's load until we snapshot.
            return new Promise<OHLCVData[]>((resolve) => {
                const check = () => {
                    if (gate.releaseSecond) resolve(datasets.get(symbol) ?? []);
                    else setTimeout(check, 5);
                };
                check();
            });
        };

        const runPromise = processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP", "DOWN"],
                loadDataset: loader,
                minUsableBars: 1,
            },
            () => {},
            owner,
        );

        // Wait until the runner has started the first symbol, then poll the
        // snapshot for a non-null currentSymbol before the run finishes.
        await new Promise<void>((resolve) => {
            const tick = () => {
                if (firstStarted) resolve();
                else setTimeout(tick, 5);
            };
            tick();
        });
        // Give the runner a moment to set currentSymbol for whichever symbol
        // is currently atop the loop (UP first, then DOWN).
        await new Promise((resolve) => setTimeout(resolve, 30));
        const midRunSymbol = getRunStateForTests()?.currentSymbol;
        expect(["UP", "DOWN"]).to.include(midRunSymbol, "currentSymbol should be populated mid-run");

        gate.releaseSecond = true;
        await runPromise;

        // After completion, currentSymbol is cleared.
        expect(getRunStateForTests()?.currentSymbol).to.equal(null);

        setRunOwnerForTests(0);
        await releaseLastResults("test_end");
    });

    it("Stop force-bumps the run owner (lost-ownership propagation)", async () => {
        // Mirrors the IBKR sync owner-lock: when `setRunOwnerForTests(0)`
        // (the Stop handler's effect) fires mid-run, processRunBatch observes
        // `runOwner !== owner` and stops emitting per-symbol events. We can't
        // simulate mid-run timing reliably without a controllable loader, so
        // we just assert the post-stop state.
        const owner = 9004;
        setRunOwnerForTests(owner);
        setRunOwnerForTests(0); // Stop.
        // Snapshot is left in place; a new run will replace it.
        expect(getRunStateForTests()).to.equal(null);
    });
});

describe("batch-backtest server plugin releaseLastResults", () => {
    it("is idempotent and safe to call when nothing is retained", async () => {
        await releaseLastResults("test_idempotent_1");
        await releaseLastResults("test_idempotent_2");
        // No throw + heapUsedMb is logged internally; nothing to assert beyond
        // survival, since the retained state is module-private.
        expect(true).to.equal(true);
    });
});

describe("batch-backtest server plugin heap guard", () => {
    it("warns before a 1000-symbol server run on the default small Node heap", () => {
        const warning = resolveServerBatchHeapWarning(1000, 4096);
        expect(warning).to.match(/needs more Node heap/i);
        expect(warning).to.include("set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev");
    });

    it("allows a 1000-symbol server run when the heap is large enough", () => {
        expect(resolveServerBatchHeapWarning(1000, 16384)).to.equal(null);
    });

    it("does not block small server runs on the default heap", () => {
        expect(resolveServerBatchHeapWarning(100, 4096)).to.equal(null);
    });

});

describe("batch-backtest server plugin processMine", () => {
    it("rejects Mine when no prior run artifacts exist on the server", async () => {
        await releaseLastResults("pre_test");
        const events: unknown[] = [];
        await processMine("any-fingerprint", "5m", (event) => events.push(event), 99);
        // The first event is a done (no artifacts) — Mine never started.
        const first = events[0] as { type: string };
        expect(first.type).to.equal("done");
    });

    it("rejects Mine when no synthetic pair artifacts exist (no-mineable-artifacts path)", async () => {
        // Run a non-synthetic batch first so lastResults is populated but
        // hasMineableArtifacts is false (no synthetic pairs). The artifact
        // gate fires before the fingerprint check, producing a `done` event
        // with "no artifacts" summary — Mine never started.
        const datasets = new Map<string, OHLCVData[]>([["UP", makeCandles([100, 105, 110, 115, 120])]]);
        const owner = 9005;
        setRunOwnerForTests(owner);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
        );
        setRunOwnerForTests(0);

        const minerOwner = 200;
        setMinerOwnerForTests(minerOwner);
        const events: unknown[] = [];
        await processMine("any-fingerprint", "5m", (event) => events.push(event), minerOwner);
        setMinerOwnerForTests(0);
        const first = events[0] as { type: string; summary?: string };
        expect(first.type).to.equal("done");
        expect(first.summary).to.match(/no completed synthetic pair artifacts/i);

        await releaseLastResults("test_end");
    });
});

describe("batch-backtest server plugin processStabilityMine", () => {
    it("keeps stored synthetic artifacts available for repeated stability mines", async () => {
        const pairData = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
        const targetData = makeCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122]);
        const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
        const owner = 9010;
        setRunOwnerForTests(owner);

        const runEvents = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP+DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        completeRunForTests();
        const done = runEvents[runEvents.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        expect(done.serverHasArtifacts).to.equal(true);
        expect(hasStoredMineArtifacts()).to.equal(true);

        const minerOwner = 9011;
        setMinerOwnerForTests(minerOwner);
        const mineEvents: unknown[] = [];
        await processStabilityMine(
            done.fingerprint,
            "5m",
            1,
            1,
            1,
            (event) => mineEvents.push(event),
            minerOwner,
            async () => [
                { asset: "UP", symbol: "UP", data: targetData },
                { asset: "DOWN", symbol: "DOWN", data: targetData },
            ],
        );
        setMinerOwnerForTests(0);

        const last = mineEvents[mineEvents.length - 1] as { type: string; ok?: boolean; result?: { rows: unknown[] } };
        expect(last.type).to.equal("done");
        expect(last.ok).to.equal(true);
        expect(last.result?.rows).to.be.an("array");
        expect(hasStoredMineArtifacts()).to.equal(true);
        const firstStatus = handleStatusRequest() as {
            lastRun?: { parsedCacheStats?: { size: number; misses: number; hits: number; peak: number } | null } | null;
        };
        expect(firstStatus.lastRun?.parsedCacheStats?.misses, "status captures post-analysis cache misses").to.be.greaterThan(0);
        expect(firstStatus.lastRun?.parsedCacheStats?.peak, "status captures the analysis working-set peak").to.be.greaterThan(0);

        setMinerOwnerForTests(0);
        const secondMinerOwner = 9012;
        setMinerOwnerForTests(secondMinerOwner);
        const secondMineEvents: unknown[] = [];
        try {
            await processStabilityMine(
                done.fingerprint,
                "5m",
                1,
                1,
                2,
                (event) => secondMineEvents.push(event),
                secondMinerOwner,
                async () => [
                    { asset: "UP", symbol: "UP", data: targetData },
                    { asset: "DOWN", symbol: "DOWN", data: targetData },
                ],
            );
        } finally {
            setMinerOwnerForTests(0);
        }
        const secondLast = secondMineEvents[secondMineEvents.length - 1] as { type: string; ok?: boolean };
        expect(secondLast.type).to.equal("done");
        expect(secondLast.ok).to.equal(true);
        expect(hasStoredMineArtifacts()).to.equal(true);
        const secondStatus = handleStatusRequest() as {
            lastRun?: { parsedCacheStats?: { hits: number } | null } | null;
        };
        expect(secondStatus.lastRun?.parsedCacheStats?.hits, "repeated analysis updates cache-hit telemetry").to.be.greaterThan(0);

        await releaseLastResults("test_end");
    });

    it("parallel Stability Mine (reruns>=4) retains artifacts for a second run (Finding 1 regression)", async () => {
        // Intent being locked (AGENTS.md rule 8): the parallel Stability path
        // (reruns >= PARALLEL_STABILITY_MIN_RERUNS = 4) must NOT release its
        // artifacts on success. The sequential path retains them via the
        // `finally`-block TTL so a second Stability run with different
        // seed/reruns reuses them without recomputing the entire Batch run.
        // The parallel path used to call `releaseLastResults("mine_completed")`
        // immediately after `done`, so `serverHasArtifacts` was true but the
        // artifacts were already deleted — the next Stability click hit
        // "no artifacts on server". The existing one-rerun test never engaged
        // the parallel branch (gate is reruns >= 4), so the regression was
        // invisible. This test turns the gate on with reruns = 4 and asserts
        // artifacts survive a second parallel Stability run.
        setMinerGatesForTests({ parallelStability: true });
        try {
            const pairData = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
            const targetData = makeCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122]);
            const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
            const owner = 9050;
            setRunOwnerForTests(owner);

            const runEvents = await collectEvents((ev) =>
                processRunBatch(
                    {
                        interval: "5m",
                        strategyKey: STRATEGY_KEY,
                        strategy: testStrategy,
                        strategyParams: { threshold: 1 },
                        backtestSettings: settings,
                        capitalSettings,
                        symbols: ["UP+DOWN"],
                        loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                        minUsableBars: 1,
                    },
                    (event) => ev.push(event),
                    owner,
                ),
            );
            setRunOwnerForTests(0);
            const done = runEvents[runEvents.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
            expect(done.serverHasArtifacts).to.equal(true);
            expect(hasStoredMineArtifacts()).to.equal(true);

            // First parallel Stability run (reruns = 4 engages the parallel branch).
            const minerOwner = 9051;
            setMinerOwnerForTests(minerOwner);
            const firstEvents: unknown[] = [];
            await processStabilityMine(
                done.fingerprint,
                "5m",
                1,
                4, // reruns >= PARALLEL_STABILITY_MIN_RERUNS
                1,
                (event) => firstEvents.push(event),
                minerOwner,
                async () => [
                    { asset: "UP", symbol: "UP", data: targetData },
                    { asset: "DOWN", symbol: "DOWN", data: targetData },
                ],
            );
            setMinerOwnerForTests(0);
            const firstLast = firstEvents[firstEvents.length - 1] as { type: string; ok?: boolean };
            expect(firstLast.type).to.equal("done");
            expect(firstLast.ok).to.equal(true);
            // The regression: artifacts MUST still be available after the parallel
            // path's `done`. Before the fix this assertion failed because the
            // parallel branch deleted artifacts before returning.
            expect(hasStoredMineArtifacts()).to.equal(true);

            // Second parallel Stability run reuses the retained artifacts.
            const secondMinerOwner = 9052;
            setMinerOwnerForTests(secondMinerOwner);
            const secondEvents: unknown[] = [];
            try {
                await processStabilityMine(
                    done.fingerprint,
                    "5m",
                    1,
                    4,
                    2,
                    (event) => secondEvents.push(event),
                    secondMinerOwner,
                    async () => [
                        { asset: "UP", symbol: "UP", data: targetData },
                        { asset: "DOWN", symbol: "DOWN", data: targetData },
                    ],
                );
            } finally {
                setMinerOwnerForTests(0);
            }
            const secondLast = secondEvents[secondEvents.length - 1] as { type: string; ok?: boolean };
            expect(secondLast.type).to.equal("done");
            expect(secondLast.ok).to.equal(true);
            expect(hasStoredMineArtifacts()).to.equal(true);

            await releaseLastResults("test_end");
        } finally {
            resetMinerGatesForTests();
        }
    });

    it("Stop aborts in-flight miner target loads via the abort signal (Finding 7)", async () => {
        // Verify the server plugin forwards minerAbortController.signal into
        // loadTargets, and that handleStopRequest aborts it so a Stop click
        // cancels up to TARGET_LOAD_CONCURRENCY target dataset loads instead of
        // letting them run to completion after the user clicked Stop.
        const pairData = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
        const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
        const owner = 9040;
        setRunOwnerForTests(owner);
        const runEvents = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "5m",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP+DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        setRunOwnerForTests(0);
        const done = runEvents[runEvents.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;

        const minerOwner = 9041;
        setMinerOwnerForTests(minerOwner);
        const abortController = new AbortController();
        setMinerAbortControllerForTests(abortController);

        let receivedSignal: AbortSignal | undefined;
        let observedAborted = false;
        try {
            const mineEvents: unknown[] = [];
            const minePromise = processStabilityMine(
                done.fingerprint,
                "5m",
                1,
                1,
                1,
                (event) => mineEvents.push(event),
                minerOwner,
                async (_pairArtifacts, _interval, signal?: AbortSignal) => {
                    receivedSignal = signal;
                    // Block until the signal aborts; the miner should report a
                    // cancellation, not surface the abort as a fatal error.
                    return new Promise<never>((_resolve, reject) => {
                        if (!signal) return reject(new Error("no signal forwarded"));
                        if (signal.aborted) {
                            observedAborted = true;
                            return reject(new Error("aborted"));
                        }
                        signal.addEventListener("abort", () => {
                            observedAborted = true;
                            reject(new Error("aborted"));
                        });
                    });
                },
            );

            // Wait until the stub has captured the signal, then fire Stop.
            await new Promise<void>((resolve) => {
                const tick = () => {
                    if (receivedSignal) resolve();
                    else setTimeout(tick, 5);
                };
                tick();
            });
            expect(receivedSignal).to.not.equal(undefined, "loadTargets should receive an AbortSignal");

            await handleStopRequest();
            expect(abortController.signal.aborted).to.equal(true);

            // The blocked loader should now reject via the abort listener, and
            // the miner should emit a cancelled done event instead of fatal.
            await minePromise;
            expect(observedAborted).to.equal(true, "the forwarded signal should have aborted");
            const last = mineEvents[mineEvents.length - 1] as { type?: string; ok?: boolean; cancelled?: boolean; summary?: string; error?: string };
            expect(last).to.deep.include({
                type: "done",
                ok: false,
                cancelled: true,
                summary: "Stability mining cancelled.",
            });
            expect(last.error).to.equal(undefined);
        } finally {
            setMinerAbortControllerForTests(null);
            setMinerOwnerForTests(0);
            await releaseLastResults("test_end");
        }
    });
});

describe("batch-backtest server plugin route-level authorization", () => {
    it("rejects an unauthenticated non-loopback GET /status with 401", async () => {
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/status");
        expect(handler).to.not.equal(undefined);
        // No Origin/Referer, no Authorization header, no LOCAL_PROXY_TOKEN:
        // this is what a remote poller hitting a tunneled/proxied dev server
        // looks like. Must be rejected, not handed the status payload.
        const prevToken = process.env.LOCAL_PROXY_TOKEN;
        delete process.env.LOCAL_PROXY_TOKEN;
        try {
            const res = makeRouteResponse();
            await handler!({ method: "GET", url: "/api/batch-backtest/status", headers: {} }, res);
            expect(res.statusCode).to.equal(401);
            const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
            expect(payload.ok).to.equal(false);
            expect(payload.error).to.include("local-only");
        } finally {
            if (prevToken !== undefined) process.env.LOCAL_PROXY_TOKEN = prevToken;
        }
    });

    it("allows a loopback same-origin GET /status without Origin/Referer", async () => {
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/status");
        expect(handler).to.not.equal(undefined);
        const res = makeRouteResponse();
        await handler!(
            {
                method: "GET",
                url: "/api/batch-backtest/status",
                socket: { remoteAddress: "127.0.0.1" },
                headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
            },
            res,
        );
        expect(res.statusCode).to.equal(200);
        const payload = JSON.parse(res.body);
        expect(payload).to.be.an("object");
        expect(payload.ok).to.not.equal(false);
    });
});

describe("batch-backtest server plugin run intake size guard", () => {
    it("rejects a run with more than BATCH_MAX_SYMBOLS symbols with 400 before streaming", async () => {
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/run");
        expect(handler).to.not.equal(undefined);
        const prevToken = process.env.LOCAL_PROXY_TOKEN;
        delete process.env.LOCAL_PROXY_TOKEN;
        try {
            // 2001 unique symbols exceeds the 2000-row persistence cap. The
            // handler must reject before allocating the run or opening the
            // NDJSON stream — the response is a single JSON error, not a
            // stream that starts and then aborts.
            const tooMany = Array.from({ length: 2001 }, (_, i) => `SYM${i}`);
            // The route handler calls readJsonBody(req), which iterates the
            // request asynchronously. A Node Readable that emits the JSON
            // body satisfies that contract (IncomingMessage is a Readable).
            const req = Readable.from([JSON.stringify({ symbols: tooMany, interval: "5m", strategyKey: STRATEGY_KEY })]) as any;
            req.method = "POST";
            req.url = "/api/batch-backtest/run";
            req.headers = { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" };
            req.socket = { remoteAddress: "127.0.0.1" };
            const res = makeRouteResponse();
            await handler!(req, res);
            expect(res.statusCode).to.equal(400);
            const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
            expect(payload.ok).to.equal(false);
            expect(payload.error).to.include("exceeds");
            expect(payload.error).to.match(/2[,.]?000/);
        } finally {
            setRunOwnerForTests(0);
            if (prevToken !== undefined) process.env.LOCAL_PROXY_TOKEN = prevToken;
        }
    });
});

describe("batch-backtest server plugin terminal snapshot in /status (audit Finding 6)", () => {
    // Intent being locked: a terminal run snapshot MUST be recoverable from
    // /status even when the run produced no Mine artifacts. Pre-fix the
    // `lastRun` branch was gated on `hasStoredMineArtifacts()`, so a fatal
    // run (or a no-artifact completed run) "vanished" from /status after a
    // reload — making long-running failures undiagnosable. The terminal
    // phase / finishedAt / summary / error must travel on `lastRun`
    // independently of `hasArtifacts`.

    afterEach(async () => {
        setRunOwnerForTests(0);
        await releaseLastResults("finding6_after_each");
    });

    it("exposes lastRun with phase=fatal and the error after a fatal run with no artifacts", async () => {
        // The runner converts most execution errors into per-symbol
        // `load_failed` rows rather than a thrown fatal, so plant the fatal
        // terminal snapshot directly via the test seam to exercise the
        // /status presentation logic (the actual change in audit Finding 6):
        // a terminal snapshot MUST surface on `lastRun` even when
        // `hasArtifacts` is false.
        const fatalSnapshot: BatchRunSnapshot = {
            startedAt: Date.now() - 1000,
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            total: 10,
            completed: 3,
            failed: 0,
            currentSymbol: null,
            cancelled: false,
            rows: [],
            phase: "fatal",
            finishedAt: Date.now(),
            summary: "Fatal — disk on fire",
            error: "disk on fire",
            runId: "finding6-fatal",
        };
        setRunStateForTests(fatalSnapshot);
        // Simulate the production handler's `finally`: release ownership so
        // status treats the run as terminal while `runState` is retained.
        completeRunForTests();

        const status = handleStatusRequest(0, 100) as {
            running: boolean;
            lastRun: {
                phase?: string;
                finishedAt?: number | null;
                summary?: string | null;
                error?: string | null;
                hasArtifacts?: boolean;
            } | null;
        };
        expect(status.running, "fatal run is not in progress").to.equal(false);
        expect(status.lastRun, "lastRun must be present after a fatal run").to.not.equal(null);
        expect(status.lastRun!.phase).to.equal("fatal");
        expect(status.lastRun!.error).to.equal("disk on fire");
        expect(status.lastRun!.summary).to.match(/Fatal/i);
        expect(status.lastRun!.finishedAt, "finishedAt must be set on fatal").to.not.equal(null);
        expect(status.lastRun!.hasArtifacts, "fatal run produced no artifacts").to.equal(false);
    });

    it("exposes lastRun with phase=done even when no synthetic pairs produced artifacts", async () => {
        // A run that completes cleanly but has no synthetic-pair rows (so
        // storeMineArtifact is a no-op) must still surface `lastRun` so a
        // reloaded tab can read the terminal summary.
        const owner = 9102;
        setRunOwnerForTests(owner);
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", makeCandles([100, 105, 110, 115, 120])],
        ]);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => { /* discard */ },
            owner,
        );
        completeRunForTests();

        const status = handleStatusRequest(0, 100) as {
            lastRun: { phase?: string; summary?: string | null; hasArtifacts?: boolean } | null;
        };
        expect(status.lastRun, "lastRun must be present for a no-artifact completed run").to.not.equal(null);
        expect(status.lastRun!.phase).to.equal("done");
        expect(status.lastRun!.summary).to.match(/Done/i);
        expect(status.lastRun!.hasArtifacts).to.equal(false);
    });
});

describe("batch-backtest server plugin artifact lifecycle races (audit Findings 2 & 3)", () => {
    it("releaseLastResults detaches the store synchronously: a new generation installed mid-flush survives (audit Finding 3)", async () => {
        // Intent being locked: cleanup must snapshot THIS generation's state
        // before its first await, so a concurrent new Run that installs its own
        // dir/artifacts during the flush window is NOT clobbered when the old
        // cleanup resumes. Pre-fix the dir was snapshotted AFTER the flush,
        // so a new Run's dir could be rm'd out from under it.
        //
        // Scenario:
        //   1. Plant a blocking pending write so releaseLastResults pauses
        //      inside its flush.
        //   2. While paused, install a NEW generation dir (simulating a new
        //      Run acquiring ownership).
        //   3. Release the blocking write; await cleanup.
        //   4. The new generation's dir must still exist and be reachable via
        //      the module variable.
        let releaseOldWrite: () => void = () => {};
        const oldWrite = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
        pushPendingArtifactWriteForTests(oldWrite);

        // Install the OLD generation dir so releaseLastResults has something
        // to detach + rm. ensureMineArtifactDir creates a real temp dir.
        const oldDir = ensureMineArtifactDirForTests();
        try {
            expect(getMineArtifactDirForTests(), "old gen dir installed").to.equal(oldDir);

            const releasePromise = releaseLastResults("finding3_race");

            // Pump the microtask queue so releaseLastResults runs up to its first
            // await (the flush). At that point the module state MUST already be
            // detached: mineArtifactDir === null.
            await Promise.resolve();
            await Promise.resolve();
            expect(getMineArtifactDirForTests(), "old gen detached synchronously before flush await").to.equal(null);

            // Now a new generation installs its own dir while the old flush waits.
            const newDir = ensureMineArtifactDirForTests();
            expect(getMineArtifactDirForTests()).to.equal(newDir);
            expect(newDir, "new gen dir is distinct from old").to.not.equal(oldDir);

            // Release the old write so the old cleanup finishes.
            releaseOldWrite();
            await releasePromise;

            // The new generation's dir survives — the old cleanup rm'd `oldDir`,
            // not the current `mineArtifactDir`.
            expect(getMineArtifactDirForTests(), "new gen dir not clobbered by old cleanup").to.equal(newDir);

            // Cleanup the new dir from disk so the test doesn't leak.
            const fs = await import("node:fs/promises");
            await fs.rm(newDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
        } finally {
            setRunOwnerForTests(0);
            await releaseLastResults("finding3_finally");
        }
    });
});

describe("batch-backtest server plugin per-run ArtifactStore (audit follow-up R-F1)", () => {
    // Intent being locked: a `storeMineArtifact` submission blocked inside
    // awaitSlot() must NOT contaminate the new generation when Stop + new Run
    // detaches its store while it is waiting. The F3 test only planted a plain
    // pending promise; this test exercises the real submission path:
    // fill the gate to capacity, queue one more (blocked) store(), detach the
    // store, then drain the gate — the blocked store() must bail without
    // creating a dir entry or metadata in the new generation.
    function makeSyntheticRow(): BatchBacktestSymbolResult {
        const candles = makeCandles([100, 105, 110, 115, 120]);
        return {
            symbol: "BTCUSDT+ETHUSDT",
            status: "profitable",
            barCount: candles.length,
            data: candles,
            signals: [{ time: candles[0]!.time, type: "buy", price: 100 }],
            result: {
                totalTrades: 1, netProfit: 10, netProfitPct: 10,
                winRate: 100, profitFactor: 1, maxDrawdown: 0, maxDrawdownPct: 0,
                finalCapital: 110, totalReturn: 10, exposurePct: 100,
                trades: [{ entryTime: candles[0]!.time, exitTime: candles[4]!.time, entryPrice: 100, exitPrice: 120, pnl: 20, pnlPct: 20, side: "long", bars: 4 }],
                equityCurve: [],
            } as any,
        };
    }

    afterEach(async () => {
        setRunOwnerForTests(0);
        await releaseLastResults("rf1_after_each");
    });

    it("a store() blocked at the gate bails after detach without touching state", async () => {
        let releaseWrites!: () => void;
        const writesBlocked = new Promise<void>((resolve) => { releaseWrites = resolve; });
        const store = new ArtifactStore(async () => { await writesBlocked; });
        // Fill the real submission gate through the public store path. The
        // injected writer keeps all eight submissions unresolved without
        // reaching into private implementation state.
        await Promise.all(Array.from({ length: 8 }, (_value, index) =>
            store.store(index, makeSyntheticRow())
        ));

        // Queue one more store(); it must block in awaitSlot().
        const blockedStore = store.store(99, makeSyntheticRow());
        // Yield so the blocked store() actually enters awaitSlot's await.
        for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));

        // Detach the store (simulating releaseLastResults mid-flight).
        store.detach();
        expect(store.isDetached()).to.equal(true);

        // Drain the gate — the blocked store() resumes its post-await check.
        releaseWrites();
        // Also pump to let the blocked store() settle.
        for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));

        // The blocked store() must have bailed: it added no metadata, no
        // pending write, and did not create the dir.
        await blockedStore;
        expect(store.collectMetas().length, "no metadata added post-detach").to.equal(0);
        expect(store.pendingWrites.length, "no pending write added post-detach").to.equal(0);
        expect(store.dir, "no dir created post-detach").to.equal(null);
    });

    it("store() before detach records the artifact normally", async () => {
        const store = new ArtifactStore();
        await store.store(0, makeSyntheticRow());
        expect(store.collectMetas().length).to.equal(1);
        expect(store.dir).to.not.equal(null);
        await store.flush();
    });

    it("does not advertise an artifact when its disk write fails", async () => {
        const store = new ArtifactStore(async () => { throw new Error("disk full"); });
        await store.store(0, makeSyntheticRow());
        await store.flush();

        expect(store.collectMetas().length).to.equal(0);
        const detached = store.detach();
        if (detached.dir) {
            const fs = await import("node:fs/promises");
            await fs.rm(detached.dir, { recursive: true, force: true });
        }
    });
});

describe("batch-backtest server plugin ArtifactStore LRU + artifact stats (audit parse-cache + artifact-stats findings)", () => {
    // Intent being locked (AGENTS.md rule 8): the parsed-artifact cache MUST
    // be bounded so a 1000-pair Mine cannot pull ~5 GB of artifacts back into
    // heap after the disk-backed design went to the trouble of writing them
    // out. A 32-entry LRU keeps the working set hot. The artifact-stats
    // counters MUST surface partial-write outcomes so a run that lost N
    // artifacts to disk pressure is observable from the `done` event instead
    // of silently presenting "artifacts available" while Mine analyzes fewer
    // pairs than expected.
    function makeSyntheticRow(symbol = "BTCUSDT+ETHUSDT"): BatchBacktestSymbolResult {
        const candles = makeCandles([100, 105, 110, 115, 120]);
        return {
            symbol,
            status: "profitable",
            barCount: candles.length,
            data: candles,
            signals: [{ time: candles[0]!.time, type: "buy", price: 100 }],
            result: {
                totalTrades: 1, netProfit: 10, netProfitPct: 10,
                winRate: 100, profitFactor: 1, maxDrawdown: 0, maxDrawdownPct: 0,
                finalCapital: 110, totalReturn: 10, exposurePct: 100,
                trades: [{ entryTime: candles[0]!.time, exitTime: candles[4]!.time, entryPrice: 100, exitPrice: 120, pnl: 20, pnlPct: 20, side: "long", bars: 4 }],
                equityCurve: [],
            } as any,
        };
    }

    afterEach(async () => {
        setRunOwnerForTests(0);
        await releaseLastResults("lru_after_each");
    });

    it("parsedCache stays at or below the cap and counts evictions", async () => {
        // Build 40 artifacts, then load each one. The cache must not exceed
        // the cap; the misses-after-eviction re-reads prove the LRU eviction
        // actually freed entries (a leak would show `size > max`).
        const store = new ArtifactStore();
        for (let i = 0; i < 40; i += 1) {
            await store.store(i, makeSyntheticRow(`A${i}+B${i}`));
        }
        await store.flush();
        const metas = store.collectMetas();
        expect(metas.length).to.equal(40);

        // Load all 40 — every load past the cap evicts the oldest.
        for (const meta of metas) {
            await store.loadStored(meta);
        }
        const stats = store.parsedCacheStats();
        expect(stats.max, "cap is 32").to.equal(32);
        expect(stats.size, "size bounded by cap").to.be.at.most(32);
        expect(stats.evictions, "at least 8 evictions for 40 loads against cap 32").to.be.gte(8);
        expect(stats.misses, "40 first-time loads = 40 misses").to.equal(40);
        expect(stats.hits, "no re-reads yet").to.equal(0);
        // `peak` records the size HIGH-WATER MARK, including the brief
        // overshoot before eviction fires (insert → size=33 → evict → 32).
        // So peak is bounded by cap+1, not cap.
        expect(stats.peak, "peak bounded by cap+1 (overshoot before eviction)").to.be.at.most(33);

        // Re-read the LAST-loaded meta: it must be a hit (LRU recency).
        const lastMeta = metas[metas.length - 1]!;
        await store.loadStored(lastMeta);
        const statsAfterHit = store.parsedCacheStats();
        expect(statsAfterHit.hits, "re-reading the most-recent entry is a hit").to.equal(1);

        store.detach();
    });

    it("artifactStats surfaces eligible/stored/failed/bytesWritten (audit artifact-stats finding)", async () => {
        // Half the writes succeed, half fail. `artifactStats` must report
        // both outcomes so the run-complete `done` event can warn the user
        // "Mine will omit N failed writes" instead of presenting a partial
        // artifact set as complete.
        let call = 0;
        const store = new ArtifactStore(async (_path: string, _data: Uint8Array) => {
            call += 1;
            if (call % 2 === 0) throw new Error("disk pressure");
        });
        for (let i = 0; i < 4; i += 1) {
            await store.store(i, makeSyntheticRow(`A${i}+B${i}`));
        }
        await store.flush();

        const stats = store.artifactStats();
        expect(stats.eligible, "4 synthetic-pair rows passed the gate").to.equal(4);
        // Calls 2 and 4 fail, so 2 stored and 2 failed.
        expect(stats.stored, "alternating writes: 2 succeed").to.equal(2);
        expect(stats.failed, "alternating writes: 2 fail").to.equal(2);
        expect(stats.bytesWritten, "byte counter is positive").to.be.greaterThan(0);
        // The failed writes must NOT be advertised as artifacts.
        expect(store.collectMetas().length, "only successful writes survive as metas").to.equal(2);

        store.detach();
    });
});

describe("batch-backtest server plugin runId-scoped Stop (audit Finding 5)", () => {
    // Intent being locked: Stop is scoped by browser-generated runId so a stale
    // tab cannot cancel a newer run. A mismatched runId MUST be rejected without
    // mutating ownership; a matching runId (or legacy unscoped Stop) cancels.
    // Also covers the Stop-before-ownership race closer.

    function plantActiveRun(runId: string, owner: number): void {
        setRunOwnerForTests(owner);
        setRunStateForTests({
            startedAt: Date.now(),
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            total: 4,
            completed: 1,
            failed: 0,
            currentSymbol: "UP",
            cancelled: false,
            rows: [],
            phase: "running",
            finishedAt: null,
            summary: null,
            error: null,
            runId,
        });
    }

    afterEach(async () => {
        setRunOwnerForTests(0);
        setPendingStopRunIdForTests(null);
        await releaseLastResults("finding5_after_each");
    });

    it("rejects a mismatched runId without mutating ownership", async () => {
        const owner = 9201;
        plantActiveRun("run-active", owner);
        const result = await handleStopRequest("run-from-stale-tab");
        expect(result).to.deep.equal({ ok: false, stopped: false });
        // Ownership is preserved — the active run continues.
        expect(getRunStateForTests(), "active run state preserved").to.not.equal(null);
        expect(getRunStateForTests()!.runId).to.equal("run-active");
    });

    it("cancels the active run when the runId matches", async () => {
        const owner = 9202;
        plantActiveRun("run-active-2", owner);
        const result = await handleStopRequest("run-active-2");
        expect(result).to.deep.equal({ ok: true, stopped: true });
    });

    it("rejects an unscoped Stop when the active run has a runId", async () => {
        const owner = 9203;
        plantActiveRun("run-active-3", owner);
        // No runId argument — a stale browser bundle that predates the contract.
        const result = await handleStopRequest();
        expect(result).to.deep.equal({ ok: false, stopped: false });
        expect(getRunStateForTests()!.runId).to.equal("run-active-3");
    });

    it("also falls back to unscoped Stop when the active run has no runId (legacy server state)", async () => {
        const owner = 9204;
        // Plant a run with an empty runId (the legacy default).
        setRunOwnerForTests(owner);
        setRunStateForTests({
            startedAt: Date.now(),
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            total: 1,
            completed: 0,
            failed: 0,
            currentSymbol: "UP",
            cancelled: false,
            rows: [],
            phase: "running",
            finishedAt: null,
            summary: null,
            error: null,
            runId: "",
        });
        // Even though the browser sends a runId, the server's run has none, so
        // it must fall back to the legacy contract.
        const result = await handleStopRequest("anything");
        expect(result).to.deep.equal({ ok: true, stopped: true });
    });

    it("records a pending stop slot when Stop arrives before ownership", async () => {
        // Stop arrives with a runId but no run is active (request still
        // parsing). The run id must be recorded so the matching /run request
        // finishes cancelled instead of starting heavy work.
        const result = await handleStopRequest("run-not-yet-started");
        expect(result).to.deep.equal({ ok: true, stopped: false });
        expect(getPendingStopRunIdForTests(), "pending stop slot planted").to.equal("run-not-yet-started");

        // The matching run consumes the marker.
        expect(consumePendingBatchStopForRun("run-not-yet-started"), "matching run consumes marker").to.equal(true);
        expect(getPendingStopRunIdForTests(), "slot cleared after consume").to.equal(null);
        // A different runId does NOT consume the marker.
        setPendingStopRunIdForTests("run-not-yet-started");
        expect(consumePendingBatchStopForRun("other-run"), "mismatched run does not consume").to.equal(false);
    });

    it("stops the reserved run before runState switches to the new generation", async () => {
        // A new /run reserves ownership before async strategy resolution, but
        // runState can still describe the previous terminal generation. Stop
        // must match the reservation id, not the stale snapshot id.
        setRunStateForTests({
            startedAt: Date.now() - 1_000,
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            total: 1,
            completed: 1,
            failed: 0,
            currentSymbol: null,
            cancelled: false,
            rows: [],
            phase: "done",
            finishedAt: Date.now(),
            summary: "Done",
            error: null,
            runId: "previous-run",
        });
        setRunReservationForTests(9205, "new-run");

        const result = await handleStopRequest("new-run");

        expect(result).to.deep.equal({ ok: true, stopped: true });
        expect(getRunOwnerForTests(), "pre-start reservation is released").to.equal(0);
        expect(getRunStateForTests()?.runId, "prior terminal snapshot is not mistaken for the owner").to.equal("previous-run");
    });

    it("status snapshot exposes runId on both run and lastRun branches", async () => {
        // In-progress branch.
        plantActiveRun("run-status", 9205);
        const inProgress = handleStatusRequest(0, 100) as {
            run: { runId?: string } | null;
        };
        expect(inProgress.run!.runId).to.equal("run-status");

        // Terminal branch.
        completeRunForTests();
        const terminal = handleStatusRequest(0, 100) as {
            lastRun: { runId?: string; phase?: string } | null;
        };
        expect(terminal.lastRun, "terminal lastRun present").to.not.equal(null);
        expect(terminal.lastRun!.runId).to.equal("run-status");
    });

    it("parseBatchRunId trims, rejects non-strings, and rejects overlong ids", () => {
        expect(parseBatchRunId("  abc  ")).to.equal("abc");
        expect(parseBatchRunId(undefined)).to.equal("");
        expect(() => parseBatchRunId(123)).to.throw("runId must be a string");
        expect(() => parseBatchRunId("x".repeat(200))).to.throw("runId must be at most 128 characters");
    });
});

describe("batch-backtest server plugin PID-scoped orphan sweep (audit Finding 7)", () => {
    // Intent being locked: the orphan-dir sweep must NOT delete a directory
    // belonging to a concurrently-running Vite process. Pre-fix the sweep
    // matched the bare prefix `strategies-finder-batch-mine-` and rm'd every
    // dir unconditionally — clobbering a live sibling process's active
    // multi-GB artifacts. The new dir name embeds `<pid>-<createdAtMs>-` and
    // the sweep reclaims only when the owning PID is provably dead OR the dir
    // is older than the conservative stale threshold.

    const PREFIX = MINE_ARTIFACT_DIR_PREFIX_FOR_TESTS;
    const now = Date.now();

    it("does not classify a legacy bare-prefix entry without filesystem age", () => {
        // Pre-fix mkdtemp output: prefix + random suffix only.
        expect(shouldSweepOrphanEntryForTests(`${PREFIX}ABCDE`, now)).to.equal(false);
    });

    it("never sweeps a directory owned by the current process", () => {
        // A dir created by THIS process (recent) must be retained so the
        // sweep never deletes the active generation.
        const entry = `${PREFIX}${process.pid}-${now}-abc`;
        expect(shouldSweepOrphanEntryForTests(entry, now)).to.equal(false);
    });

    it("retains an old directory while its owning PID is still alive", () => {
        // Even if the PID is the current process's, an entry older than
        // ORPHAN_SWEEP_STALE_MS is reclaimed (age backstop).
        const ancient = now - (ORPHAN_SWEEP_STALE_MS_FOR_TESTS + 60_000);
        const entry = `${PREFIX}${process.pid}-${ancient}-abc`;
        expect(shouldSweepOrphanEntryForTests(entry, now)).to.equal(false);
    });

    it("retains a directory owned by a DIFFERENT live process", () => {
        // Use the test runner's own PID as a stand-in for "a different but
        // alive PID" — wait, that IS this process. Spawn a real child so we
        // have a genuinely different alive pid.
        const { spawn } = require("node:child_process") as typeof import("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
        try {
            const childPid = child.pid!;
            const entry = `${PREFIX}${childPid}-${now}-abc`;
            expect(shouldSweepOrphanEntryForTests(entry, now), "live sibling pid must be retained").to.equal(false);
        } finally {
            child.kill("SIGKILL");
        }
    });

    it("sweeps a directory whose owning PID is no longer alive", async () => {
        // Spawn a child, wait for it to exit, then verify the sweep reclaims
        // a dir stamped with the dead pid + a recent timestamp.
        const { spawn } = require("node:child_process") as typeof import("node:child_process");
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
        const childPid = child.pid!;
        await new Promise<void>((resolve) => child.on("exit", () => resolve()));
        // Give the OS a moment to reap the process record.
        await new Promise((r) => setTimeout(r, 100));
        const recent = Date.now();
        const entry = `${PREFIX}${childPid}-${recent}-abc`;
        expect(shouldSweepOrphanEntryForTests(entry, recent), "dead pid must be swept").to.equal(true);
    });

    it("does not classify an invalid PID stamp without filesystem age", () => {
        const entry = `${PREFIX}notanumber-${now}-abc`;
        // NaN pid → sweep (malformed stamp can't prove ownership).
        expect(shouldSweepOrphanEntryForTests(entry, now)).to.equal(false);
    });
});

describe("batch-backtest server plugin processMinePrediction", () => {
    it("rejects Mine Prediction when no prior run artifacts exist on the server", async () => {
        await releaseLastResults("pre_mine_pred_test");
        const events: unknown[] = [];
        await processMinePrediction("any-fingerprint", "4h", (event) => events.push(event), 99);
        const first = events[0] as { type: string };
        // No artifacts -> fatal (mirrors processPortfolioFit's no-artifacts gate,
        // unlike processMine which emits a cancelled done).
        expect(first.type).to.equal("fatal");
    });

    it("streams a done event with a populated report when artifacts exist, and does NOT release artifacts (read-only)", async () => {
        // Intent being locked: Mine Prediction is READ-ONLY on the artifact
        // store. It MUST leave artifacts intact so Mine/Stability/PortfolioFit
        // can still run after it. A regression that adds releaseLastResults
        // here would break the "run Mine Prediction then Mine" sequence.
        const pairData = makeCandles(Array.from({ length: 60 }, (_, i) => 100 + i));
        const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
        const owner = 9070;
        setRunOwnerForTests(owner);
        const runEvents = await collectEvents((ev) =>
            processRunBatch(
                {
                    interval: "4h",
                    strategyKey: STRATEGY_KEY,
                    strategy: testStrategy,
                    strategyParams: { threshold: 1 },
                    backtestSettings: settings,
                    capitalSettings,
                    symbols: ["UP+DOWN"],
                    loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                    minUsableBars: 1,
                },
                (event) => ev.push(event),
                owner,
            ),
        );
        setRunOwnerForTests(0);
        const done = runEvents[runEvents.length - 1] as Extract<BatchStreamEvent, { type: "done" }>;
        expect(done.serverHasArtifacts, "run must produce artifacts for the test").to.equal(true);
        expect(hasStoredMineArtifacts()).to.equal(true);

        const minerOwner = 9071;
        setMinerOwnerForTests(minerOwner);
        const predEvents: unknown[] = [];
        await processMinePrediction(
            done.fingerprint,
            "4h",
            (event) => predEvents.push(event),
            minerOwner,
            // Inject target candles so the test does not hit the network.
            async () => [
                { asset: "UP", symbol: "UPUSDT", data: pairData },
                { asset: "DOWN", symbol: "DOWNUSDT", data: pairData },
            ],
        );
        setMinerOwnerForTests(0);

        const terminal = predEvents[predEvents.length - 1] as { type: string; ok?: boolean; result?: { reportLines?: string[] } };
        expect(terminal.type).to.equal("done");
        expect(terminal.ok).to.equal(true);
        expect(terminal.result?.reportLines?.length ?? 0, "report must have lines").to.be.greaterThan(0);

        // CRITICAL contract: artifacts still available after Mine Prediction.
        expect(hasStoredMineArtifacts(), "Mine Prediction must NOT release artifacts").to.equal(true);

        await releaseLastResults("mine_pred_test_end");
    });
});

describe("batch-backtest server plugin mine-prediction route-level authorization", () => {
    it("rejects a non-POST /api/batch-backtest/mine-prediction with 405", async () => {
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/mine-prediction");
        expect(handler, "mine-prediction route must be registered").to.not.equal(undefined);
        const res = makeRouteResponse();
        await handler!(
            {
                method: "GET",
                url: "/api/batch-backtest/mine-prediction",
                socket: { remoteAddress: "127.0.0.1" },
                headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
            },
            res,
        );
        expect(res.statusCode).to.equal(405);
        const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
        expect(payload.ok).to.equal(false);
        expect(payload.error).to.include("Method");
    });

    it("rejects an unauthenticated non-loopback POST /mine-prediction with 401 (audit F1 parity)", async () => {
        // Intent: the mine-prediction route must enforce the SAME loopback
        // gate as Mine/Stability/PortfolioFit/status. A tunneled dev server
        // must not expose a CPU-heavy diagnostic to a remote caller.
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/mine-prediction");
        expect(handler).to.not.equal(undefined);
        const prevToken = process.env.LOCAL_PROXY_TOKEN;
        delete process.env.LOCAL_PROXY_TOKEN;
        try {
            const req = Readable.from([JSON.stringify({ fingerprint: "x", interval: "4h" })]) as any;
            req.method = "POST";
            req.url = "/api/batch-backtest/mine-prediction";
            req.headers = {}; // no Origin/Referer/Authorization -> looks remote
            req.socket = { remoteAddress: "203.0.113.9" };
            const res = makeRouteResponse();
            await handler!(req, res);
            expect(res.statusCode).to.equal(401);
            const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
            expect(payload.ok).to.equal(false);
            expect(payload.error).to.include("local-only");
        } finally {
            if (prevToken !== undefined) process.env.LOCAL_PROXY_TOKEN = prevToken;
        }
    });
});

describe("batch-backtest server plugin single-flight /run (audit single-flight finding)", () => {
    // Intent being locked (AGENTS.md rule 8): ownership is claimed BEFORE the
    // first await. Two concurrent /run requests MUST NOT both pass the
    // `runOwner !== NONE` gate and then race to claim — the second must get a
    // 409. Pre-fix the claim was AFTER `resolveStrategy` (async), so two
    // requests could both pass the gate, both await resolveStrategy, then both
    // try to claim; the second stole ownership and the first stream cancelled.
    const validBody = {
        symbols: ["UP+DOWN"],
        interval: "5m",
        strategyKey: STRATEGY_KEY,
        strategyParams: { threshold: 1 },
        backtestSettings: settings,
        capitalSettings,
    };

    afterEach(async () => {
        setRunOwnerForTests(0);
        await releaseLastResults("single_flight_after_each");
    });

    it("rejects a /run with 409 when another run already owns the lock", async () => {
        // Pre-fix the gate was already there but ineffective under concurrency
        // because the claim came after the async resolveStrategy. Post-fix the
        // claim is synchronous-before-await, so once runOwner is non-NONE any
        // subsequent /run (regardless of how far the first has progressed
        // through resolveStrategy) sees the gate immediately and 409s.
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/run")!;
        const owner = 9301;
        setRunOwnerForTests(owner);

        const req = Readable.from([JSON.stringify(validBody)]) as any;
        req.method = "POST";
        req.url = "/api/batch-backtest/run";
        req.headers = { host: "localhost:5173" };
        req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5173 };
        const res = makeRouteResponse();
        await handler(req, res);
        expect(res.statusCode, "second /run while another holds ownership must 409").to.equal(409);
        const payload = JSON.parse(res.body) as { ok?: boolean; error?: string };
        expect(payload.error).to.include("already running");
    });

    it("releases ownership when a post-claim step throws so a retry succeeds", async () => {
        // Audit single-flight finding: the new try/finally around the post-
        // claim block releases ownership on ANY throw (resolveStrategy fails,
        // a 400 sneaks through, etc.). Pre-fix a thrown resolveStrategy would
        // leave runOwner set because the synchronous claim was followed by an
        // unguarded throw, wedging the server until restart.
        const routes = captureBatchRoutes();
        const handler = routes.get("/api/batch-backtest/run")!;
        // Unknown strategy → resolveStrategy throws → the finally must release.
        const badBody = { ...validBody, strategyKey: "definitely_not_a_real_strategy" };
        const req = Readable.from([JSON.stringify(badBody)]) as any;
        req.method = "POST";
        req.url = "/api/batch-backtest/run";
        req.headers = { host: "localhost:5173" };
        req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5173 };
        const res = makeRouteResponse();
        await handler(req, res);
        // The handler emits a 400 (strategy not loaded) via sendCaughtErrorJson.
        expect(res.statusCode).to.equal(400);
        // CRITICAL: runOwner MUST be NONE after the throw so the next /run is
        // not wedged. Pre-fix the synchronous claim was not released on throw.
        const status = handleStatusRequest() as { running?: boolean };
        expect(status.running, "ownership released after a post-claim throw").to.equal(false);
    });
});

describe("batch-backtest server plugin runId-scoped /status (audit runId-scoping finding)", () => {
    // Intent being locked (AGENTS.md rule 8): a paginated /status drain
    // scoped to runId A MUST NOT return rows from a newer run B. When the
    // requested runId no longer matches the retained snapshot, the server
    // returns `{ ok: true, runMismatch: true, run: null, lastRun: null }`
    // (HTTP 200, explicit mismatch) so the browser stops paginating instead
    // of stitching rows from two generations. An empty/absent runId
    // preserves the legacy behavior.

    afterEach(async () => {
        setRunOwnerForTests(0);
        await releaseLastResults("runid_scope_after_each");
    });

    it("returns runMismatch when the requested runId does not match the retained snapshot", async () => {
        const owner = 9401;
        setRunOwnerForTests(owner);
        const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", makeCandles([100, 105, 110, 115, 120])]]);
        await processRunBatch(
            {
                interval: "5m",
                strategyKey: STRATEGY_KEY,
                strategy: testStrategy,
                strategyParams: { threshold: 1 },
                backtestSettings: settings,
                capitalSettings,
                symbols: ["UP+DOWN"],
                loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
                minUsableBars: 1,
            },
            () => {},
            owner,
            "batch-runid-A",
        );
        completeRunForTests();
        // Sanity: an unscoped request returns the retained snapshot.
        const unscoped = handleStatusRequest() as { runMismatch?: boolean; lastRun?: { runId?: string } | null };
        expect(unscoped.runMismatch, "unscoped request never mismatches").to.not.equal(true);
        expect(unscoped.lastRun?.runId).to.equal("batch-runid-A");
        // Matching runId also returns normally.
        const matching = handleStatusRequest(0, undefined, "batch-runid-A") as { runMismatch?: boolean; lastRun?: { runId?: string } | null };
        expect(matching.runMismatch, "matching runId never mismatches").to.not.equal(true);
        expect(matching.lastRun?.runId).to.equal("batch-runid-A");
        // Mismatched runId returns the explicit mismatch shape with no snapshot.
        const mismatched = handleStatusRequest(0, undefined, "batch-runid-OTHER") as { runMismatch?: boolean; lastRun?: unknown; run?: unknown };
        expect(mismatched.runMismatch, "mismatched runId signals mismatch").to.equal(true);
        expect(mismatched.lastRun, "mismatch suppresses lastRun").to.equal(null);
        expect(mismatched.run, "mismatch suppresses run").to.equal(null);

        setRunOwnerForTests(0);
        await releaseLastResults("runid_scope_end");
    });
});
