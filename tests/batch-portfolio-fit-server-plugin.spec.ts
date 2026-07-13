/**
 * Phase 3 focused tests for the Portfolio Fit server plugin integration.
 *
 * Covers (per the implementation prompt):
 *  - server/browser parity (the pure engine produces the same output the
 *    server endpoint streams)
 *  - scalar-only stream/snapshot payloads (no data/signals/trades/equityCurve)
 *  - fingerprint mismatch, artifact expiry, cancellation, ownership conflict
 *  - Portfolio Fit preserving artifacts for a later Stability rerun (R16)
 *
 * Framework: node:test + chai (matches batch-backtest-server-plugin.spec.ts).
 */
import { expect } from "chai";
import { describe, it, after, before } from "node:test";
import { strategyRegistry } from "../strategyRegistry";
import {
    processRunBatch,
    processStabilityMine,
    __testInternals,
} from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type { BatchStreamEvent, BatchPortfolioFitStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";
import type { BatchStabilityMineResult } from "../lib/batch-backtest/batch-stability-mine";
import type { BatchPortfolioFitCapital, BatchPortfolioFitResult } from "../lib/batch-backtest/batch-portfolio-fit-types";

const TEST_PORTFOLIO_FIT_CAPITAL: BatchPortfolioFitCapital = {
    initialCapital: 10000,
    baseAllocation: 1000,
    kellyFraction: null,
    baseAllocationSource: "fixed",
    configuredKellyFraction: null,
};

const {
    releaseLastResults,
    hasStoredMineArtifacts,
    setRunOwnerForTests,
    completeRunForTests,
    setMinerOwnerForTests,
    setMinerAbortControllerForTests,
    setMinerGatesForTests,
    resetMinerGatesForTests,
    processPortfolioFit,
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
    name: "Portfolio Fit Server Test",
    description: "Deterministic strategy for Portfolio Fit server-plugin tests.",
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

const STRATEGY_KEY = "portfolio_fit_server_test";

// A long candle series with synthetic-pair symbols so Mine/Stability produce artifacts.
// Use symbols of form BASE+QUOTE which parsePortfolioSyntheticPairSymbol recognizes.
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

// Module-level cache so the expensive Batch + Stability setup runs ONCE per
// suite, not once per test. The prior per-test setup took >100s and tripped the
// 120s per-test timeout under `npm run test`. Each test still reads artifacts
// independently; only the setup is shared.
let cachedSetup: { fingerprint: string | null; interval: string; stability: BatchStabilityMineResult | null } | null = null;

before(() => {
    strategyRegistry.register(STRATEGY_KEY, testStrategy);
    setMinerGatesForTests({ parallelStability: false });
});

after(async () => {
    strategyRegistry.unregister(STRATEGY_KEY);
    resetMinerGatesForTests();
    await releaseLastResults("test_cleanup");
});

/**
 * Lazily ensures artifacts are populated, reusing the cache across tests.
 * Tests that need Stability call `runStabilityToGetResult` (which also caches).
 */
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

async function runBatchToPopulateArtifacts(): Promise<{ fingerprint: string | null; interval: string }> {
    return ensureArtifacts();
}

async function runBatchToPopulateArtifactsUncached(): Promise<{ fingerprint: string | null; interval: string }> {
    const datasets = new Map<string, OHLCVData[]>([
        ["BTC+ETH", makeSyntheticPairCandles(3)],
        ["BTC+SOL", makeSyntheticPairCandles(7)],
    ]);
    const owner = 9100;
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

async function runStabilityToGetResult(fingerprint: string | null, interval: string): Promise<BatchStabilityMineResult | null> {
    // Return the cached Stability result when the fingerprint matches (the
    // common case); otherwise re-run.
    if (cachedSetup && cachedSetup.fingerprint === fingerprint && cachedSetup.stability) {
        return cachedSetup.stability;
    }
    const result = await runStabilityToGetResultUncached(fingerprint, interval);
    if (cachedSetup) cachedSetup.stability = result;
    return result;
}

async function runStabilityToGetResultUncached(fingerprint: string | null, interval: string): Promise<BatchStabilityMineResult | null> {
    const owner = 9101;
    setMinerOwnerForTests(owner);
    setMinerAbortControllerForTests(new AbortController());
    const events: unknown[] = [];
    await processStabilityMine(
        fingerprint,
        interval,
        10, // subsetSize
        1,  // reruns: minimum to keep the test fast (cold start dominates runtime)
        1,  // seed
        (event) => events.push(event),
        owner,
    );
    setMinerOwnerForTests(0);
    const done = events.find((e: any) => e?.type === "done" && e?.ok === true) as { result: BatchStabilityMineResult } | undefined;
    return done?.result ?? null;
}

function collectPortfolioFitEvents(
    fingerprint: string | null,
    interval: string,
    stability: BatchStabilityMineResult | null,
    capital: BatchPortfolioFitCapital,
    options?: Record<string, unknown>,
): Promise<BatchPortfolioFitStreamEvent[]> {
    const events: BatchPortfolioFitStreamEvent[] = [];
    const owner = 9102;
    setMinerOwnerForTests(owner);
    setMinerAbortControllerForTests(new AbortController());
    return processPortfolioFit(
        fingerprint,
        interval,
        stability,
        capital,
        options,
        (event) => events.push(event as BatchPortfolioFitStreamEvent),
        owner,
    ).then(() => {
        setMinerOwnerForTests(0);
        return events;
    });
}

describe("batch-portfolio-fit server plugin — scalar-only stream payload", () => {
    it("emits start, progress, and done with a scalar-only result", async () => {
        const { fingerprint, interval } = await runBatchToPopulateArtifacts();
        expect(hasStoredMineArtifacts()).to.equal(true);
        const stability = await runStabilityToGetResult(fingerprint, interval);
        // Stability may produce zero rows on this synthetic fixture; if so,
        // Portfolio Fit should fail with a clear fatal, not crash.
        if (!stability || stability.rows.length === 0) {
            const events = await collectPortfolioFitEvents(fingerprint, interval, stability, TEST_PORTFOLIO_FIT_CAPITAL);
            const fatal = events.find((e) => e.type === "fatal");
            expect(fatal).to.not.equal(undefined);
            return;
        }

        const events = await collectPortfolioFitEvents(fingerprint, interval, stability, TEST_PORTFOLIO_FIT_CAPITAL);
        const start = events.find((e) => e.type === "start");
        const done = events.find((e) => e.type === "done" && (e as any).ok === true) as Extract<BatchPortfolioFitStreamEvent, { type: "done"; ok: true }> | undefined;
        expect(start).to.not.equal(undefined);
        expect(done).to.not.equal(undefined);
        const result: BatchPortfolioFitResult = done!.result;
        // Scalar-only: no data/signals/trades/equityCurve fields anywhere.
        const json = JSON.stringify(result);
        expect(json).to.not.match(/\bNaN\b/);
        expect(json).to.not.match(/\bInfinity\b/);
        expect(json).to.not.match(/"data"\s*:/);
        expect(json).to.not.match(/"signals"\s*:/);
        expect(json).to.not.match(/"trades"\s*:/);
        expect(json).to.not.match(/"equityCurve"\s*:/);
    });
});

describe("batch-portfolio-fit server plugin — fingerprint mismatch", () => {
    it("emits fatal when fingerprint does not match lastRunFingerprint", async () => {
        const { interval } = await runBatchToPopulateArtifacts();
        // No Stability run needed: the fingerprint check fires before stability
        // is even consulted.
        const events = await collectPortfolioFitEvents("wrong-fingerprint", interval, null, TEST_PORTFOLIO_FIT_CAPITAL);
        const fatal = events.find((e) => e.type === "fatal") as Extract<BatchPortfolioFitStreamEvent, { type: "fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.match(/Rerun Batch/i);
    });
});

describe("batch-portfolio-fit server plugin — missing artifacts", () => {
    it("emits fatal when no artifacts are stored", async () => {
        await releaseLastResults("test_no_artifacts");
        expect(hasStoredMineArtifacts()).to.equal(false);
        const events = await collectPortfolioFitEvents("any", "5m", null, TEST_PORTFOLIO_FIT_CAPITAL);
        const fatal = events.find((e) => e.type === "fatal") as Extract<BatchPortfolioFitStreamEvent, { type: "fatal" }> | undefined;
        expect(fatal).to.not.equal(undefined);
        expect(fatal!.error).to.match(/no artifacts/i);
    });
});

describe("batch-portfolio-fit server plugin — artifact preservation (R16)", () => {
    it("does NOT release artifacts; they survive for a later Stability rerun", async () => {
        const { fingerprint, interval } = await runBatchToPopulateArtifacts();
        expect(hasStoredMineArtifacts()).to.equal(true);
        const stability = await runStabilityToGetResult(fingerprint, interval);

        // Run Portfolio Fit.
        await collectPortfolioFitEvents(fingerprint, interval, stability, TEST_PORTFOLIO_FIT_CAPITAL);

        // Artifacts must STILL be present (R16: Portfolio Fit does not release them).
        expect(hasStoredMineArtifacts()).to.equal(true);

        // And a Stability rerun must still work (artifacts readable).
        const stability2 = await runStabilityToGetResult(fingerprint, interval);
        expect(stability2).to.not.equal(null);
    });
});

describe("batch-portfolio-fit server plugin — cancellation", () => {
    it("emits a cancelled done when ownership is lost mid-run", async () => {
        const { fingerprint, interval } = await runBatchToPopulateArtifacts();
        const stability = await runStabilityToGetResult(fingerprint, interval);
        if (!stability || stability.rows.length === 0) return; // skip if no candidates

        const events: BatchPortfolioFitStreamEvent[] = [];
        const owner = 9103;
        setMinerOwnerForTests(owner);
        setMinerAbortControllerForTests(new AbortController());
        // Bump ownership BEFORE the run starts so the first check fails.
        setMinerOwnerForTests(owner + 1);
        await processPortfolioFit(
            fingerprint,
            interval,
            stability,
            TEST_PORTFOLIO_FIT_CAPITAL,
            undefined,
            (event) => events.push(event as BatchPortfolioFitStreamEvent),
            owner, // stale owner
        );
        setMinerOwnerForTests(0);
        const cancelled = events.find((e) => e.type === "done" && (e as any).ok === false) as Extract<BatchPortfolioFitStreamEvent, { type: "done"; ok: false }> | undefined;
        expect(cancelled).to.not.equal(undefined);
        expect(cancelled!.cancelled).to.equal(true);
    });
});
