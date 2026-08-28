import { expect } from "chai";
import { after, before, describe, it } from "node:test";
import {
    runAssetOpportunityIteration,
} from "../lib/finder/server/asset-opportunity-iteration";
import { rustEngine } from "../lib/rust-engine-client";
import { getBuiltInStrategyKeys, ensureBuiltInStrategyLoaded } from "../lib/strategies/built-in-catalog";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderAssetOpportunityResult, FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";

const LIVE_PARITY_ENABLED = process.env.RUN_LIVE_RUST_PARITY === "1";
const BASE_TIME = 1_700_000_000;
const BAR_SECONDS = 14_400;
const BAR_COUNT = 3_600;
const SYMBOLS = ["LIVE_PARITY_A", "LIVE_PARITY_B"];

const settings: BacktestSettings = {
    atrPeriod: 21,
    stopLossPercent: 2,
    takeProfitPercent: 2,
    stopLossEnabled: true,
    takeProfitEnabled: true,
    takeProfitMode: "fixed",
    riskMode: "percentage",
    maxOpenTrades: 1,
    strategyTimeframeMinutes: 120,
    riskMinHoldEnabled: false,
    riskMinHoldBars: 0,
    riskMaxHoldEnabled: true,
    riskMaxHoldBars: 2,
    riskCooldownEnabled: false,
    riskCooldownBars: 0,
    disableSignalExits: false,
    pathExitEnabled: false,
    strategyTimeframeEnabled: false,
    slippageBps: 0,
    tradeDirection: "long",
    executionModel: "next_open",
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "fixed",
    fixedTradeAmount: 1_000,
};

function buildDataset(assetIndex: number): OHLCVData[] {
    return Array.from({ length: BAR_COUNT }, (_value, index) => {
        const time = BASE_TIME + index * BAR_SECONDS;
        const base = 100 + assetIndex * 0.01 + Math.sin(index / 19) * 1.5 + index * 0.02;
        return {
            time: time as Time,
            open: base - 0.1,
            high: base + 0.7,
            low: base - 0.7,
            close: base + Math.cos(index / 7) * 0.12,
            volume: 1_000 + (index % 23),
        };
    });
}

function buildOptions(complementary: boolean): FinderOptions {
    return {
        scope: "asset_opportunity",
        mode: "random",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        dataSlice: complementary ? "half_oldest" : "all",
        oosValidationEnabled: complementary,
        randomSeed: 4242,
        topN: 3,
        steps: 1,
        rangePercent: 0,
        maxRuns: 1,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols: SYMBOLS,
            candidatePoolSize: 3,
            minFreshSupport: 1,
            evalLastBars: 1_000,
            oosMeasurementMode: complementary ? "fixed_horizon" : "next_exit",
            oosIgnoreLastBars: complementary ? 0 : 26,
        },
    };
}

function compareScalars(left: unknown, right: unknown, path: string): void {
    if (typeof left === "number" && typeof right === "number") {
        if (left === right) return;
        if (Number.isNaN(left) || Number.isNaN(right)) {
            expect(Number.isNaN(left) && Number.isNaN(right), path).to.equal(true);
            return;
        }
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            expect(left, path).to.equal(right);
            return;
        }
        expect(left, path).to.be.closeTo(right, 1e-8 * Math.max(1, Math.abs(left), Math.abs(right)));
        return;
    }
    if (left === right) return;
    if (Array.isArray(left) || Array.isArray(right)) {
        expect(left, path).to.be.an("array");
        expect(right, path).to.be.an("array");
        const leftArray = left as unknown[];
        const rightArray = right as unknown[];
        expect(leftArray.length, path).to.equal(rightArray.length);
        for (let index = 0; index < Math.min(leftArray.length, rightArray.length); index += 1) {
            compareScalars(leftArray[index], rightArray[index], `${path}[${index}]`);
        }
        return;
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
            .filter((key) => key !== "exitControlDiagnostics" && key !== "processingTimeMs")
            .sort();
        for (const key of keys) compareScalars(leftRecord[key], rightRecord[key], path ? `${path}.${key}` : key);
        return;
    }
    expect(left, path).to.equal(right);
}

function orderOf(rows: FinderAssetOpportunityResult[]): string[] {
    return rows.map((row) => `${row.symbol}:${row.strategyKey}:${row.historicalRank}`);
}

async function loadStrategies() {
    const keys = getBuiltInStrategyKeys();
    expect(keys).to.have.length(45);
    return Promise.all(keys.map(async (key) => {
        const strategy = await ensureBuiltInStrategyLoaded(key);
        if (!strategy) throw new Error(`Live parity strategy failed to load: ${key}`);
        return { key, name: strategy.name, strategy };
    }));
}

async function runCase(
    selectedStrategies: Awaited<ReturnType<typeof loadStrategies>>,
    datasets: Map<string, OHLCVData[]>,
    complementary: boolean,
    useRust: boolean,
) {
    const capabilities = useRust
        ? (await rustEngine.checkHealth() ? rustEngine.capabilities : undefined)
        : undefined;
    if (useRust && !capabilities) {
        throw new Error("Live Rust parity requires a healthy Rust service; no fallback is permitted");
    }
    return runAssetOpportunityIteration({
        runId: `live-rust-parity-${complementary ? "complementary" : "next-exit"}-${useRust ? "rust" : "typescript"}`,
        interval: "4h",
        symbols: SYMBOLS,
        options: buildOptions(complementary),
        settings,
        capitalSettings,
        selectedStrategies,
        useRustEnginePreference: useRust,
        rustCapabilities: capabilities,
        abortSignal: new AbortController().signal,
        loadDataset: async (symbol) => datasets.get(symbol)!,
        candidatePoolSize: 3,
        minFreshSupport: 1,
        generateParamSets: (defaults) => [defaults],
    }, {
        onProgress: () => undefined,
        onAssetResult: () => undefined,
    }, () => false);
}

function assertEngineDiagnostics(
    typescript: Awaited<ReturnType<typeof runCase>>,
    rust: Awaited<ReturnType<typeof runCase>>,
): void {
    const tsUsage = typescript.totals.engineUsage!;
    const rustUsage = rust.totals.engineUsage!;
    expect(tsUsage.rustAttemptedRuns).to.equal(0);
    expect(tsUsage.rustFallbackRuns).to.equal(0);
    expect(rustUsage.rustAttemptedRuns).to.be.greaterThan(0);
    expect(rustUsage.rustCompletedRuns).to.be.greaterThan(0);
    expect(rustUsage.rustFallbackRuns).to.equal(0);
    expect((rustUsage.typescriptReasons ?? []).some(({ reason }) => reason === "signal_shape_unsupported")).to.equal(false);
    expect(typescript.assetDiagnostics.work!.candidateEvaluationsAttempted).to.equal(
        typescript.assetDiagnostics.work!.candidateEvaluationsCompleted
        + typescript.assetDiagnostics.work!.candidateEvaluationFailures,
    );
    expect(rust.assetDiagnostics.work!.candidateEvaluationsAttempted).to.equal(
        rust.assetDiagnostics.work!.candidateEvaluationsCompleted
        + rust.assetDiagnostics.work!.candidateEvaluationFailures,
    );
}

function assertParity(
    typescript: Awaited<ReturnType<typeof runCase>>,
    rust: Awaited<ReturnType<typeof runCase>>,
): void {
    expect(orderOf(rust.results), "result ordering").to.deep.equal(orderOf(typescript.results));
    expect(rust.results.length).to.equal(typescript.results.length);
    for (let index = 0; index < typescript.results.length; index += 1) {
        compareScalars(typescript.results[index], rust.results[index], `rows[${index}]`);
    }
    const tsWork = typescript.assetDiagnostics.work!;
    const rustWork = rust.assetDiagnostics.work!;
    expect(rustWork.candidateEvaluationsAttempted).to.equal(tsWork.candidateEvaluationsAttempted);
    expect(rustWork.nextExitEvaluations ?? 0).to.equal(tsWork.nextExitEvaluations ?? 0);
    expect(rustWork.complementaryOosEvaluations ?? 0).to.equal(tsWork.complementaryOosEvaluations ?? 0);
    expect(rustWork.winnerAnalyticsRecomputations).to.equal(tsWork.winnerAnalyticsRecomputations);
    assertEngineDiagnostics(typescript, rust);
}

describe("live Asset Opportunity TypeScript/Rust parity", () => {
    const originalBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
    before(() => {
        if (LIVE_PARITY_ENABLED) process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
    });
    after(() => {
        if (originalBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = originalBatchFlag;
    });

    if (!LIVE_PARITY_ENABLED) {
        it.skip("requires RUN_LIVE_RUST_PARITY=1 and a live Rust service", () => undefined);
        return;
    }

    it("compares next_exit and complementary OOS using the actual Rust protocol-v2 service", async () => {
        const healthy = await rustEngine.checkHealth();
        if (!healthy) {
            throw new Error("Rust service unavailable for live parity; start the isolated service and rerun this test");
        }
        const selectedStrategies = await loadStrategies();
        const datasets = new Map(SYMBOLS.map((symbol, index) => [symbol, buildDataset(index)]));
        const nextExitTypescript = await runCase(selectedStrategies, datasets, false, false);
        const nextExitRust = await runCase(selectedStrategies, datasets, false, true);
        assertParity(nextExitTypescript, nextExitRust);
        expect(nextExitTypescript.assetDiagnostics.work!.nextExitEvaluations ?? 0).to.be.greaterThan(0);
        expect(nextExitRust.assetDiagnostics.work!.nextExitEvaluations ?? 0).to.be.greaterThan(0);
        expect(nextExitTypescript.assetDiagnostics.work!.complementaryOosEvaluations ?? 0).to.equal(0);
        expect(nextExitRust.assetDiagnostics.work!.complementaryOosEvaluations ?? 0).to.equal(0);

        const complementaryTypescript = await runCase(selectedStrategies, datasets, true, false);
        const complementaryRust = await runCase(selectedStrategies, datasets, true, true);
        assertParity(complementaryTypescript, complementaryRust);
        expect(complementaryTypescript.assetDiagnostics.work!.complementaryOosEvaluations ?? 0).to.be.greaterThan(0);
        expect(complementaryRust.assetDiagnostics.work!.complementaryOosEvaluations ?? 0).to.equal(
            complementaryTypescript.assetDiagnostics.work!.complementaryOosEvaluations,
        );
    });
});
