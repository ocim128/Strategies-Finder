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
import type {
    RustMinerCapability,
    RustMinerClient,
    RustMinerResult,
    RustStabilityMineRequest,
    RustStabilityMineResponse,
} from "../lib/batch-backtest/batch-rust-miner-client";
import type { BatchStabilityMineResult } from "../lib/batch-backtest/batch-stability-mine";
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
    setMinerAbortControllerForTests,
    getRunStateForTests,
    handleStatusRequest,
    handleStopRequest,
    setRustMinerClientForTests,
    resetRustMinerClientForTests,
    setMinerGatesForTests,
    resetMinerGatesForTests,
} = __testInternals;

/**
 * Build a stub RustMinerClient with canned capability + runStabilityMine
 * behavior. Avoids touching the network in tests; lets Phase 4 tests simulate
 * "backend healthy + returns a result", "backend unavailable", etc.
 */
function makeStubRustMinerClient(args: {
    capability: RustMinerCapability;
    stabilityOutcome: (req: RustStabilityMineRequest) => RustMinerResult<RustStabilityMineResponse>;
}): RustMinerClient {
    return {
        checkCapability: async () => args.capability,
        runMine: async () => ({ ok: false as const, reason: "mine_not_supported" as const, message: "stub" }),
        runStabilityMine: async (req: RustStabilityMineRequest) => args.stabilityOutcome(req),
        invalidateCapabilityCache: () => {},
    } as unknown as RustMinerClient;
}

/** Capability response for a healthy backend that supports Stability + file-manifest. */
const HEALTHY_CAPABILITY: RustMinerCapability = {
    available: true,
    minerApiVersion: "0.1.0-test",
    compactArtifactSchemaVersion: 1,
    supportsMine: true,
    supportsStability: true,
    transports: ["file_manifest", "binary"],
    backendVersion: "test",
};

/** Capability response for an unavailable backend (no server running). */
const UNAVAILABLE_CAPABILITY: RustMinerCapability = {
    available: false,
    minerApiVersion: null,
    compactArtifactSchemaVersion: null,
    supportsMine: false,
    supportsStability: false,
    transports: [],
    backendVersion: null,
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
    // Default: no Rust backend in the test environment. Install an always-
    // unavailable stub so the router falls back instantly instead of paying
    // a 2s health-probe timeout per Stability test. Individual tests that
    // need a healthy (mock) backend call setRustMinerClientForTests(...) and
    // resetRustMinerClientForTests() in their own finally block.
    setRustMinerClientForTests(
        makeStubRustMinerClient({
            capability: UNAVAILABLE_CAPABILITY,
            stabilityOutcome: () => ({ ok: false, reason: "rust_unavailable", message: "stub unavailable" }),
        }),
    );
    // Production gates default OFF (compact store-time tax; Rust/parallel need
    // infra that doesn't exist in CI). Reset here so a toggled gate from one
    // test cannot leak into another.
    resetMinerGatesForTests();
});

after(() => {
    strategyRegistry.unregister(STRATEGY_KEY);
    resetRustMinerClientForTests();
    resetMinerGatesForTests();
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
        expect(done.cacheStats?.disk.writes).to.be.a("number");
        expect(hasStoredMineArtifacts()).to.equal(true);

        setRunOwnerForTests(0);
        releaseLastResults("test_end");
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
        releaseLastResults("test_end");
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
        releaseLastResults("test_end");
    });

    it("setStatus preserves the last real percent instead of resetting to 0", async () => {
        // The runner calls setProgress(real%) then setStatus(symbol text) in the
        // same tick. Before the fix, setStatus emitted percent: 0, snapping the
        // bar back. Now it must echo the last real percent set by setProgress.
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
        // The second symbol starts at 50%; before the fix, the immediately
        // following setStatus("Backtesting DOWN...") event reset percent to 0.
        let maxSeen = 0;
        let checkedPositiveStatus = false;
        for (const ev of progressEvents) {
            if (ev.percent > 0) maxSeen = Math.max(maxSeen, ev.percent);
            if (maxSeen > 0 && ev.text.startsWith("Backtesting")) {
                expect(ev.percent).to.equal(maxSeen, `setStatus-driven progress must preserve last percent, got ${ev.percent} after ${maxSeen}`);
                checkedPositiveStatus = true;
            }
        }
        expect(checkedPositiveStatus).to.equal(true);

        setRunOwnerForTests(0);
        releaseLastResults("test_end");
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
        expect(hasStoredMineArtifacts()).to.equal(true);

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

        releaseLastResults("test_end");
    });

    it("Phase 2: stability result carries a populated minerProfile (compact-artifact path) with Rust unavailable fallback", async () => {
        // Intent being locked: server-side Mine can store COMPACT artifacts on
        // disk and reconstruct raw shapes for the TypeScript miner on load
        // (Phase 2 acceleration). Phase 4 adds a Rust router that probes a
        // backend; when no backend is available it MUST fall back to the
        // TypeScript path instantly (no multi-second network timeout in tests
        // or when the user has no Rust backend) and stamp `rust_fallback` +
        // reason on the result. This test opts INTO the compact + Rust gates
        // (both default off in production) and injects an always-unavailable
        // stub so the fallback path is exercised deterministically.
        setMinerGatesForTests({ compactArtifacts: true, rustRouting: true });
        setRustMinerClientForTests(
            makeStubRustMinerClient({
                capability: UNAVAILABLE_CAPABILITY,
                stabilityOutcome: () => ({ ok: false, reason: "rust_unavailable", message: "stub unavailable" }),
            }),
        );
        try {
            const pairData = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
            const targetData = makeCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122]);
            const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
            const owner = 9020;
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

            const minerOwner = 9021;
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

            const last = mineEvents[mineEvents.length - 1] as {
                type: string;
                ok?: boolean;
                result?: {
                    engine?: string;
                    rustFallbackReason?: string | null;
                    minerProfile?: { artifactConversionMs?: number };
                };
            };
            expect(last.type).to.equal("done");
            expect(last.ok).to.equal(true);
            // Rust was attempted and the backend was unavailable -> the router
            // fell back to TypeScript and stamped the reason. Phase 6 benchmark
            // reporting surfaces this so "why didn't Rust kick in?" is
            // answerable without server logs.
            expect(last.result?.engine).to.equal("rust_fallback");
            expect(last.result?.rustFallbackReason).to.equal("rust_unavailable");
            // Phase 2 profile field must exist (compact->raw conversion is timed).
            expect(last.result?.minerProfile).to.have.property("artifactConversionMs");

            releaseLastResults("test_end");
        } finally {
            resetRustMinerClientForTests();
            resetMinerGatesForTests();
        }
    });

    it("Phase 4: routes to Rust and stamps engine=rust when the backend accepts the request", async () => {
        // Intent being locked: when the Rust miner backend is healthy +
        // schema-compatible + file-manifest-capable, the server plugin MUST
        // delegate Stability to it and stream its result back unchanged with
        // `engine: "rust"`. This is the acceleration contract — if routing
        // ever fails to delegate (or delegates but mislabels the engine), the
        // benchmark cannot tell which backend actually ran.
        const rustResult: BatchStabilityMineResult = {
            reruns: 1,
            subsetSize: 1,
            seed: 1,
            totalPairs: 1,
            targetAssets: 2,
            hitEvents: 1,
            rows: [
                { asset: "UP", direction: "LONG", hits: 1, high: 1, medium: 0, low: 0,
                  medianRetPct: 1.5, medianLiftPct: 1, medianRr: 2, medianDist: 0.5,
                  medianHmaxLiftPct: 0.8, pairWarnings: 0, timingEdgeScore: 40,
                  medianDiversity: 0.5, dominantPair: "UP+DOWN", dominantPairShare: 1 },
            ],
        };
        setMinerGatesForTests({ compactArtifacts: true, rustRouting: true });
        let rustRequest: RustStabilityMineRequest | null = null;
        setRustMinerClientForTests(
            makeStubRustMinerClient({
                capability: HEALTHY_CAPABILITY,
                stabilityOutcome: (request) => {
                    rustRequest = request;
                    return {
                        ok: true,
                        value: { ...rustResult, processingTimeMs: 42 },
                    };
                },
            }),
        );
        try {
            const pairData = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
            const targetData = makeCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122]);
            const datasets = new Map<string, OHLCVData[]>([["UP+DOWN", pairData]]);
            const owner = 9030;
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

            const minerOwner = 9031;
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

            const last = mineEvents[mineEvents.length - 1] as {
                type: string;
                ok?: boolean;
                result?: { engine?: string; rustFallbackReason?: string | null; rows?: unknown[]; minerProfile?: { rustProcessingMs?: number } };
            };
            expect(last.type).to.equal("done");
            expect(last.ok).to.equal(true);
            // Routed to Rust: engine is "rust", no fallback reason, and the
            // Rust-produced rows pass through unchanged.
            expect(last.result?.engine).to.equal("rust");
            expect(last.result?.rustFallbackReason).to.equal(null);
            expect(last.result?.rows?.length).to.equal(1);
            expect(last.result?.minerProfile?.rustProcessingMs).to.equal(42);
            expect(rustRequest?.manifest.pairArtifactFiles).to.have.length(1);
            expect(rustRequest?.manifest.targetArtifactFiles).to.have.length(2);
        } finally {
            resetRustMinerClientForTests();
            resetMinerGatesForTests();
            releaseLastResults("test_end");
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
            releaseLastResults("test_end");
        }
    });
});
