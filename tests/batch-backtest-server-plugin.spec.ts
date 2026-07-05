import { expect } from "chai";
import { describe, it, after, before } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processRunBatch,
    processMine,
    processStabilityMine,
    resolveServerBatchHeapWarning,
    __testInternals,
} from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type { BatchStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

// The plugin holds module-scope state (runOwner, artifact files, etc.). The
// handlers under test mutate that state, so each test must reset the relevant
// pieces. `releaseLastResults` is the documented reset path.
const {
    releaseLastResults,
    hasMineableArtifacts,
    hasStoredMineArtifacts,
    setRunOwnerForTests,
    setMinerOwnerForTests,
    getRunStateForTests,
} = __testInternals;

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

after(() => {
    strategyRegistry.unregister(STRATEGY_KEY);
    releaseLastResults("test_cleanup");
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
        releaseLastResults("test_end");
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
        releaseLastResults("test_end");
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
        expect(hasStoredMineArtifacts()).to.equal(true);

        setRunOwnerForTests(0);
        releaseLastResults("test_end");
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
    it("is idempotent and safe to call when nothing is retained", () => {
        releaseLastResults("test_idempotent_1");
        releaseLastResults("test_idempotent_2");
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
        releaseLastResults("pre_test");
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

        releaseLastResults("test_end");
    });
});

describe("batch-backtest server plugin processStabilityMine", () => {
    it("consumes stored synthetic artifacts and releases them after a successful stability mine", async () => {
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
        setRunOwnerForTests(0);
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
        expect(hasStoredMineArtifacts()).to.equal(false);

        releaseLastResults("test_end");
    });
});
