/**
 * Focused tests for the Timing Surface server plugin integration.
 *
 * Covers:
 *  - scalar-only stream payload (no data/signals/trades/equityCurve arrays)
 *  - fingerprint mismatch emits fatal
 *  - missing artifacts emits fatal
 *  - missing retained Stability context emits STABILITY_CONTEXT_MISSING
 *  - cancellation emits cancelled done
 *  - artifact preservation: does not release artifacts
 *
 * Framework: node:test + chai.
 */
import { expect } from "chai";
import { describe, it, after, before } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processRunBatch,
    processStabilityMine,
    __testInternals,
} from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type {
    BatchStreamEvent,
    BatchTimingSurfaceStreamEvent,
} from "../lib/batch-backtest/batch-backtest-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";
import type { BatchStabilityMineResult } from "../lib/batch-backtest/batch-stability-mine";
import type { TimingSurfaceCostModel } from "../lib/batch-backtest/batch-timing-surface-types";

const TEST_COST_MODEL: TimingSurfaceCostModel = {
    commissionPercent: 0,
    slippageBps: 0,
    executionModel: "signal_close",
};

const {
    releaseLastResults,
    hasStoredMineArtifacts,
    handleStatusRequest,
    setRunOwnerForTests,
    completeRunForTests,
    setMinerOwnerForTests,
    setMinerAbortControllerForTests,
    setMinerGatesForTests,
    resetMinerGatesForTests,
    processTimingSurface,
    setRetainedStabilityContextForTests,
    getRetainedStabilityResultForTests,
    getRetainedTimingCostModelForTests,
    hasArtifactReleaseTimerForTests,
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
    name: "Timing Surface Server Test",
    description: "Deterministic strategy for Timing Surface server-plugin tests.",
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

const STRATEGY_KEY = "timing_surface_server_test";

function makeSyntheticPairCandles(seed: number, count = 40): OHLCVData[] {
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < count; i++) {
        const delta = ((seed * (i + 7)) % 11) - 5;
        price = Math.max(10, price + delta);
        closes.push(price);
    }
    return makeCandles(closes);
}

let cachedSetup: { fingerprint: string | null; interval: string; stability: BatchStabilityMineResult | null } | null = null;

before(() => {
    strategyRegistry.register(STRATEGY_KEY, testStrategy);
    setMinerGatesForTests({ parallelStability: false });
});

after(async () => {
    strategyRegistry.unregister(STRATEGY_KEY);
    resetMinerGatesForTests();
    setRetainedStabilityContextForTests({ stability: null, costModel: null });
    await releaseLastResults("test_cleanup");
});

async function ensureArtifacts(): Promise<{ fingerprint: string | null; interval: string }> {
    if (cachedSetup && hasStoredMineArtifacts()) return { fingerprint: cachedSetup.fingerprint, interval: cachedSetup.interval };
    const setup = await runBatchToPopulateArtifactsUncached();
    if (cachedSetup) {
        cachedSetup.fingerprint = setup.fingerprint;
        cachedSetup.interval = setup.interval;
    } else {
        cachedSetup = { ...setup, stability: null };
    }
    return setup;
}

async function runBatchToPopulateArtifactsUncached(): Promise<{ fingerprint: string | null; interval: string }> {
    const datasets = new Map<string, OHLCVData[]>([
        ["BTC+ETH", makeSyntheticPairCandles(3)],
        ["BTC+SOL", makeSyntheticPairCandles(7)],
    ]);
    const owner = 9300;
    setRunOwnerForTests(owner);
    const events: BatchStreamEvent[] = [];
    await processRunBatch(
        {
            interval: "5m",
            strategyKey: STRATEGY_KEY,
            strategy: testStrategy,
            strategyParams: { threshold: 1 },
            backtestSettings: settings,
            capitalSettings,
            symbols: ["BTC+ETH", "BTC+SOL"],
            loadDataset: (symbol) => Promise.resolve(datasets.get(symbol) ?? []),
            minUsableBars: 1,
        },
        (event: BatchStreamEvent) => events.push(event),
        owner,
    );
    completeRunForTests();
    const doneEvent = events.find((e) => e.type === "done") as Extract<BatchStreamEvent, { type: "done" }> | undefined;
    return { fingerprint: doneEvent?.fingerprint ?? null, interval: "5m" };
}

async function runStabilityToRetainContext(fingerprint: string | null, interval: string): Promise<BatchStabilityMineResult | null> {
    if (cachedSetup && cachedSetup.fingerprint === fingerprint && cachedSetup.stability) {
        // Re-install the retained context so subsequent timing-surface tests
        // behave the same as a fresh Stability run.
        setRetainedStabilityContextForTests({ stability: cachedSetup.stability, costModel: TEST_COST_MODEL });
        return cachedSetup.stability;
    }
    const owner = 9301;
    setMinerOwnerForTests(owner);
    setMinerAbortControllerForTests(new AbortController());
    const events: unknown[] = [];
    await processStabilityMine(
        fingerprint,
        interval,
        10,
        1,
        1,
        (event) => events.push(event),
        owner,
    );
    setMinerOwnerForTests(0);
    const done = events.find((e: any) => e?.type === "done" && e?.ok === true) as { result: BatchStabilityMineResult } | undefined;
    const result = done?.result ?? null;
    if (cachedSetup) cachedSetup.stability = result;
    return result;
}

function collectTimingSurfaceEvents(
    fingerprint: string | null,
    interval: string,
): Promise<BatchTimingSurfaceStreamEvent[]> {
    const events: BatchTimingSurfaceStreamEvent[] = [];
    const owner = 9302;
    setMinerOwnerForTests(owner);
    setMinerAbortControllerForTests(new AbortController());
    return processTimingSurface(
        fingerprint,
        interval,
        (event) => events.push(event as BatchTimingSurfaceStreamEvent),
        owner,
        async () => ["BTC", "ETH", "SOL"].map((asset, index) => ({
            asset,
            symbol: `${asset}USDT`,
            data: makeSyntheticPairCandles(index + 11),
        })),
    ).then(() => {
        setMinerOwnerForTests(0);
        return events;
    });
}

describe("batch-timing-surface server plugin — scalar-only stream payload", () => {
    it("emits start and done with a scalar-only result", async () => {
        const { fingerprint, interval } = await ensureArtifacts();
        expect(hasStoredMineArtifacts()).to.equal(true);
        const stability = await runStabilityToRetainContext(fingerprint, interval);
        // If Stability produced no rows on this fixture, the timing endpoint
        // should succeed with an empty row list (no fatal) rather than crash.
        const events = await collectTimingSurfaceEvents(fingerprint, interval);
        const start = events.find((e) => e.type === "start");
        const done = events.find((e) => e.type === "done" && (e as any).ok === true) as Extract<BatchTimingSurfaceStreamEvent, { type: "done"; ok: true }> | undefined;
        const fatal = events.find((e) => e.type === "fatal");
        expect(fatal).to.equal(undefined);
        expect(stability).to.not.equal(null);
        expect(start).to.not.equal(undefined);
        expect(done).to.not.equal(undefined);
        const json = JSON.stringify(done!.result);
        expect(json).to.not.match(/\bNaN\b/);
        expect(json).to.not.match(/\bInfinity\b/);
        expect(json).to.not.match(/"data"\s*:/);
        expect(json).to.not.match(/"signals"\s*:/);
        expect(json).to.not.match(/"trades"\s*:/);
        expect(json).to.not.match(/"equityCurve"\s*:/);
        expect(done!.result.evidenceScope).to.equal("historical_conditional");
        expect(done!.result.exploitEligible).to.equal(false);
        expect(done!.result.schemaVersion).to.equal(1);
        expect(getRetainedStabilityResultForTests()).to.not.equal(null);
        expect(getRetainedTimingCostModelForTests()).to.not.equal(null);
        const status = handleStatusRequest() as { timingSurfaceAvailable?: boolean };
        expect(status.timingSurfaceAvailable).to.equal(true);
    });
});

describe("batch-timing-surface server plugin — fingerprint mismatch", () => {
    it("emits fatal when fingerprint does not match lastRunFingerprint", async () => {
        const { interval } = await ensureArtifacts();
        const events = await collectTimingSurfaceEvents("wrong-fingerprint", interval);
        const fatal = events.find((e) => e.type === "fatal") as Extract<BatchTimingSurfaceStreamEvent, { type: "fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.match(/Rerun Batch/i);
    });
});

describe("batch-timing-surface server plugin — missing artifacts", () => {
    it("emits fatal when no artifacts are stored", async () => {
        // Clear retained context first so we test the artifacts check alone.
        setRetainedStabilityContextForTests({ stability: null, costModel: null });
        await releaseLastResults("test_no_artifacts");
        expect(hasStoredMineArtifacts()).to.equal(false);
        const events = await collectTimingSurfaceEvents("any", "5m");
        const fatal = events.find((e) => e.type === "fatal") as Extract<BatchTimingSurfaceStreamEvent, { type: "fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.match(/no artifacts/i);
    });
});

describe("batch-timing-surface server plugin — missing retained Stability context", () => {
    it("emits STABILITY_CONTEXT_MISSING when Stability was not retained", async () => {
        const { fingerprint, interval } = await ensureArtifacts();
        expect(hasStoredMineArtifacts()).to.equal(true);
        // Force-clear the retained Stability context to simulate "Mine Timing
        // ran and released artifacts" or "Stability was never run".
        setRetainedStabilityContextForTests({ stability: null, costModel: null });
        expect(getRetainedStabilityResultForTests()).to.equal(null);
        expect(getRetainedTimingCostModelForTests()).to.equal(null);
        const status = handleStatusRequest() as { timingSurfaceAvailable?: boolean };
        expect(status.timingSurfaceAvailable).to.equal(false);
        const events = await collectTimingSurfaceEvents(fingerprint, interval);
        const fatal = events.find((e) => e.type === "fatal") as Extract<BatchTimingSurfaceStreamEvent, { type: "fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.match(/STABILITY_CONTEXT_MISSING/);
    });
});

describe("batch-timing-surface server plugin — artifact preservation", () => {
    it("does NOT release artifacts; they survive for a later Stability rerun", async () => {
        const { fingerprint, interval } = await ensureArtifacts();
        expect(hasStoredMineArtifacts()).to.equal(true);
        await runStabilityToRetainContext(fingerprint, interval);
        // Run Timing Surface.
        await collectTimingSurfaceEvents(fingerprint, interval);
        // Timing Surface must preserve the artifacts used by later Stability reruns.
        expect(hasStoredMineArtifacts()).to.equal(true);
        expect(hasArtifactReleaseTimerForTests()).to.equal(true);
    });
});

describe("batch-timing-surface server plugin — cancellation", () => {
    it("emits a cancelled done when ownership is lost mid-run", async () => {
        const { fingerprint, interval } = await ensureArtifacts();
        await runStabilityToRetainContext(fingerprint, interval);
        setRetainedStabilityContextForTests({
            stability: {
                reruns: 50,
                subsetSize: 2,
                seed: 1,
                totalPairs: 2,
                targetAssets: 1,
                hitEvents: 5,
                rows: [{
                    asset: "BTC",
                    direction: "LONG",
                    hits: 5,
                    high: 5,
                    medium: 0,
                    low: 0,
                    medianRetPct: 1,
                    medianLiftPct: 1,
                    medianRr: 2,
                    medianDist: 1,
                    medianHmaxLiftPct: 1,
                    pairWarnings: 0,
                    timingEdgeScore: 10,
                    medianDiversity: 0.5,
                    asOfTimeKey: String(Math.floor(Date.now() / 1000)),
                    close: 100,
                    medianBarsHeld: 1,
                    agreementTransition: 1,
                    freshHits: 5,
                    dominantPair: "BTC+ETH",
                    dominantPairShare: 0.5,
                }],
            },
            costModel: TEST_COST_MODEL,
        });
        const events: BatchTimingSurfaceStreamEvent[] = [];
        const owner = 9303;
        setMinerOwnerForTests(owner);
        setMinerAbortControllerForTests(new AbortController());
        // Change ownership from a timer while the engine is active. This only
        // fires if the async engine yields to the event loop between bounded
        // work units; the previous synchronous implementation could not
        // observe this until all computation had finished.
        const cancellationTimer = setTimeout(() => setMinerOwnerForTests(owner + 1), 0);
        try {
            await processTimingSurface(
                fingerprint,
                interval,
                (event) => events.push(event as BatchTimingSurfaceStreamEvent),
                owner,
                async () => ["BTC", "ETH", "SOL"].map((asset, index) => ({
                    asset,
                    symbol: `${asset}USDT`,
                    data: makeSyntheticPairCandles(index + 21),
                })),
            );
        } finally {
            clearTimeout(cancellationTimer);
        }
        setMinerOwnerForTests(0);
        const cancelled = events.find((e) => e.type === "done" && (e as any).ok === false) as Extract<BatchTimingSurfaceStreamEvent, { type: "done"; ok: false }> | undefined;
        expect(cancelled).to.not.equal(undefined);
        expect(cancelled!.cancelled).to.equal(true);
    });
});
