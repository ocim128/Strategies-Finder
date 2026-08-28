import { expect } from "chai";
import { after, before, describe, it } from "node:test";
import {
    resolveAssetOpportunityRustAllPathEligibility,
    runAssetOpportunityIteration,
} from "../lib/finder/server/asset-opportunity-iteration";
import { hasUnsupportedRustSignalShape, rustEngine } from "../lib/rust-engine-client";
import { getBuiltInStrategyKeys, ensureBuiltInStrategyLoaded } from "../lib/strategies/built-in-catalog";
import type {
    RustAssetOpportunityBatchResponse,
    RustBacktestTransportResult,
    RustBatchTransportResult,
} from "../lib/rust-engine-client";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyExecutionContext,
    StrategyParams,
    Time,
} from "../lib/types/strategies";
import type { AssetOpportunityRustBatchFeatureConfig } from "../lib/finder/server/finder-asset-opportunity-rust-batch";

const RUST_CAPABILITIES = new Set([
    "backtest.next_open.v1",
    "backtest.risk_max_hold.v1",
    "backtest.exit_reason.v1",
]);

const settings: BacktestSettings = {
    executionModel: "next_open",
    tradeDirection: "long",
    maxOpenTrades: 1,
    riskMaxHoldEnabled: true,
    riskMaxHoldBars: 2,
    riskMinHoldEnabled: false,
    riskCooldownEnabled: false,
    disableSignalExits: false,
    pathExitEnabled: false,
    strategyTimeframeEnabled: false,
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

const RUST_BATCH_FEATURE_CONFIG: AssetOpportunityRustBatchFeatureConfig = {
    enabled: true,
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 128 * 1024 * 1024,
};

function makeCandles(): OHLCVData[] {
    return Array.from({ length: 40 }, (_value, index) => {
        const close = 100 + index;
        return {
            time: (1_700_000_000 + index * 300) as Time,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1_000,
        };
    });
}

function makeLongCandles(length = 3_600): OHLCVData[] {
    return Array.from({ length }, (_value, index) => {
        const close = 100 + index * 0.02 + Math.sin(index / 19) * 1.5;
        return {
            time: (1_700_000_000 + index * 14_400) as Time,
            open: close - 0.1,
            high: close + 0.7,
            low: close - 0.7,
            close,
            volume: 1_000 + (index % 23),
        };
    });
}

function makeStrategy(key: string): { key: string; name: string; strategy: Strategy } {
    const strategy: Strategy = {
        name: `Rust routing ${key}`,
        description: "Emits the latest long signal for routing coverage.",
        defaultParams: { threshold: 1 },
        paramLabels: { threshold: "Threshold" },
        execute(data) {
            const latest = data.at(-1);
            return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
        },
    };
    return { key, name: strategy.name, strategy };
}

function makeOptions(): FinderOptions {
    return {
        scope: "asset_opportunity",
        mode: "random",
        randomSeed: 4242,
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        topN: 3,
        steps: 3,
        rangePercent: 35,
        maxRuns: 1,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols: ["ASSET_A", "ASSET_B"],
            candidatePoolSize: 3,
            minFreshSupport: 1,
            evalLastBars: 1_000,
            oosMeasurementMode: "next_exit",
            oosIgnoreLastBars: 26,
        },
    };
}

function makeRustBatchResponse(items: Array<{ id: string }>): RustBatchTransportResult {
    const summary: RustAssetOpportunityBatchResponse["results"][number]["result"] = {
        netProfit: 10,
        netProfitPercent: 0.1,
        winRate: 100,
        expectancy: 10,
        avgTrade: 10,
        profitFactor: 2,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 10,
        avgLoss: 0,
        sharpeRatio: 0,
    };
    return {
        ok: true,
        response: {
            processingTimeMs: 0,
            results: items.map((item) => ({
                id: item.id,
                result: summary,
                selectionResult: summary,
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            })),
        },
        requestBytes: 1,
        elapsedMs: 0,
    };
}

function makeRustGenericResult(data: OHLCVData[], signals: Signal[]): BacktestResult {
    const latest = data.at(-1);
    const latestSignal = signals.at(-1);
    const entryTime = latestSignal?.time ?? latest?.time ?? (0 as Time);
    if (!latest || !latestSignal) {
        return {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        };
    }
    return {
        trades: [{
            id: 1,
            type: "long",
            entryTime,
            entryPrice: latest.close,
            exitTime: entryTime,
            exitPrice: latest.close + 10,
            pnl: 10,
            pnlPercent: 0.1,
            size: 1,
            exitReason: "end_of_data",
        }],
        netProfit: 10,
        netProfitPercent: 0.1,
        winRate: 100,
        expectancy: 10,
        avgTrade: 10,
        profitFactor: 2,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 10,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function instrumentRealStrategies(
    loaded: Array<{ key: string; strategy: Strategy }>,
    seenSignals: Map<string, Signal[][]>,
): Array<{ key: string; name: string; strategy: Strategy }> {
    return loaded.map(({ key, strategy }) => {
        const record = (signals: Signal[]): Signal[] => {
            const entries = seenSignals.get(key) ?? [];
            entries.push(signals);
            seenSignals.set(key, entries);
            return signals;
        };
        const wrapped: Strategy = {
            ...strategy,
            execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
                record(strategy.execute(data, params, context)),
        };
        if (strategy.executePrepared) {
            wrapped.executePrepared = (
                preparedData: unknown,
                params: StrategyParams,
                data: OHLCVData[],
                context?: StrategyExecutionContext,
            ) => record(strategy.executePrepared!(preparedData, params, data, context));
        }
        return { key, name: strategy.name, strategy: wrapped };
    });
}

describe("Asset Opportunity Rust routing and concurrency flow", () => {
    const originalBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
    before(() => {
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
    });
    after(() => {
        if (originalBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = originalBatchFlag;
    });

    it("enables multi-asset fan-out only when every execution path is Rust-compatible", () => {
        const resolve = (
            overrides: Partial<BacktestSettings> = {},
            selectedStrategies = [makeStrategy("eligible")],
        ) => resolveAssetOpportunityRustAllPathEligibility({
            featureConfig: RUST_BATCH_FEATURE_CONFIG,
            useRustEnginePreference: true,
            settings: { ...settings, ...overrides },
            capitalSettings,
            selectedStrategies,
            rustCapabilities: RUST_CAPABILITIES,
        });

        expect(resolve()).to.equal(true, "requested next_open/max-hold/next_exit configuration should fan out");
        expect(resolve({}, [makeStrategy("first"), makeStrategy("second")])).to.equal(true);
        const crossSymbol = makeStrategy("cross-symbol");
        expect(resolve({}, [
            makeStrategy("eligible"),
            { ...crossSymbol, strategy: { ...crossSymbol.strategy, crossSymbolConfig: { defaultSymbol: "SECONDARY" } } },
        ])).to.equal(false, "one statically incompatible strategy must disable fan-out");
    });

    it("requires all protocol capabilities before enabling multi-asset fan-out", () => {
        const resolve = (capabilities: Set<string>) => resolveAssetOpportunityRustAllPathEligibility({
            featureConfig: RUST_BATCH_FEATURE_CONFIG,
            useRustEnginePreference: true,
            settings,
            capitalSettings,
            selectedStrategies: [makeStrategy("eligible")],
            rustCapabilities: capabilities,
        });

        expect(resolve(new Set(["backtest.risk_max_hold.v1", "backtest.exit_reason.v1"]))).to.equal(false);
        expect(resolve(new Set(["backtest.next_open.v1", "backtest.risk_max_hold.v1"]))).to.equal(false);
        expect(resolve(RUST_CAPABILITIES as Set<string>)).to.equal(true);
    });

    it("keeps next-exit follow-up fan-out conservative for generic-only settings", () => {
        expect(resolveAssetOpportunityRustAllPathEligibility({
            featureConfig: RUST_BATCH_FEATURE_CONFIG,
            useRustEnginePreference: true,
            settings: { ...settings, slippageBps: 1 },
            capitalSettings,
            selectedStrategies: [makeStrategy("slippage")],
            rustCapabilities: RUST_CAPABILITIES,
        })).to.equal(false, "next_exit with slippage must not rely on the fallback gate for fan-out");
        expect(resolveAssetOpportunityRustAllPathEligibility({
            featureConfig: RUST_BATCH_FEATURE_CONFIG,
            useRustEnginePreference: true,
            settings: { ...settings, riskCooldownEnabled: true, riskCooldownBars: 1 },
            capitalSettings,
            selectedStrategies: [makeStrategy("cooldown")],
            rustCapabilities: RUST_CAPABILITIES,
        })).to.equal(false, "next_exit with cooldown must not rely on the fallback gate for fan-out");
    });

    it("coalesces hermetic multi-strategy work and preserves Rust-only follow-up routing", async () => {
        const selectedStrategies = Array.from({ length: 4 }, (_value, index) => makeStrategy(`strategy_${index}`));
        const data = makeCandles();
        const originalBatch = rustEngine.runAssetOpportunityBatchBacktestWithStatus;
        const originalMultiBatch = rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus;
        const originalMultiFresh = rustEngine.runMultiAssetFreshEntryBatchBacktestWithStatus;
        const originalGeneric = rustEngine.runBacktestWithStatus;
        const originalCacheData = rustEngine.cacheData;
        const originalMultiCacheData = rustEngine.cacheMultiAssetDataWithStatus;
        let directBatchCalls = 0;
        const multiBatchWorkloadSizes: number[] = [];
        let multiFreshCalls = 0;
        let genericCalls = 0;
        let activeGenericCalls = 0;
        let maxActiveGenericCalls = 0;
        let activeTypescriptSimulations = 0;
        let maxTypescriptSimulations = 0;
        const requestSignals: Array<AbortSignal | undefined> = [];
        let forceRustFallback = false;

        rustEngine.runAssetOpportunityBatchBacktestWithStatus = async (_data, items): Promise<RustBatchTransportResult> => {
            directBatchCalls += 1;
            return makeRustBatchResponse(items);
        };
        rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus = async (workloads, _initialCapital, _positionSizePercent, _commissionPercent, _baseSettings, _sizing, requestOptions): Promise<RustBatchTransportResult> => {
            multiBatchWorkloadSizes.push(workloads.length);
            requestSignals.push(requestOptions?.signal);
            if (forceRustFallback) return { ok: false, reason: "network_error", requestBytes: 1 };
            return makeRustBatchResponse(workloads.flatMap((workload) => workload.items));
        };
        rustEngine.runMultiAssetFreshEntryBatchBacktestWithStatus = async (workloads, _initialCapital, _positionSizePercent, _commissionPercent, _baseSettings, _sizing, requestOptions): Promise<RustBatchTransportResult> => {
            multiFreshCalls += 1;
            requestSignals.push(requestOptions?.signal);
            return makeRustBatchResponse(workloads.flatMap((workload) => workload.items));
        };
        rustEngine.cacheData = async () => null;
        rustEngine.cacheMultiAssetDataWithStatus = async () => ({ ok: false, reason: "network_error" as const });
        rustEngine.runBacktestWithStatus = async (
            replayData,
            signals,
            initialCapital,
            positionSize,
            commission,
            replaySettings,
            sizing,
            _outputOptions,
            requestOptions,
        ): Promise<RustBacktestTransportResult> => {
            genericCalls += 1;
            requestSignals.push(requestOptions?.signal);
            activeGenericCalls += 1;
            maxActiveGenericCalls = Math.max(maxActiveGenericCalls, activeGenericCalls);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeGenericCalls -= 1;
            void initialCapital;
            void positionSize;
            void commission;
            void replaySettings;
            void sizing;
            return { ok: true, result: makeRustGenericResult(replayData, signals) };
        };

        try {
            const abortController = new AbortController();
            const emittedAssetIndexes: number[] = [];
            const output = await runAssetOpportunityIteration(
                {
                    runId: "rust-routing-flow",
                    interval: "5m",
                    symbols: ["ASSET_A", "ASSET_B"],
                    options: makeOptions(),
                    settings,
                    capitalSettings,
                    selectedStrategies,
                    useRustEnginePreference: true,
                    rustCapabilities: RUST_CAPABILITIES,
                    typescriptSimulationConcurrency: {
                        enter: () => {
                            activeTypescriptSimulations += 1;
                            maxTypescriptSimulations = Math.max(maxTypescriptSimulations, activeTypescriptSimulations);
                        },
                        leave: () => {
                            activeTypescriptSimulations -= 1;
                        },
                    },
                    abortSignal: abortController.signal,
                    loadDataset: async () => data,
                    candidatePoolSize: 3,
                    minFreshSupport: 1,
                    generateParamSets: () => [{ threshold: 1 }],
                },
                {
                    onProgress: () => undefined,
                    onAssetResult: ({ assetIndex }) => emittedAssetIndexes.push(assetIndex),
                },
                () => false,
            );

            expect(directBatchCalls).to.equal(0);
            expect(multiBatchWorkloadSizes.length).to.be.greaterThan(0);
            expect(Math.max(...multiBatchWorkloadSizes)).to.be.greaterThan(1);
            expect(multiFreshCalls).to.equal(0);
            expect(genericCalls).to.be.greaterThan(0);
            expect(maxActiveGenericCalls).to.be.greaterThan(1);
            expect(requestSignals.length).to.be.greaterThan(0);
            expect(requestSignals.every((signal) => signal === abortController.signal)).to.equal(true);
            expect(emittedAssetIndexes).to.deep.equal([...emittedAssetIndexes].sort((a, b) => a - b));
            const engineUsage = output.totals.engineUsage!;
            const work = output.assetDiagnostics.work!;
            expect(engineUsage.rustAttemptedRuns).to.equal(engineUsage.rustCompletedRuns);
            expect(engineUsage.rustFallbackRuns).to.equal(0);
            expect(engineUsage.typescriptCompletedRuns).to.equal(0);
            expect(engineUsage.typescriptReasons).to.deep.equal([]);
            expect(work.freshEntryRechecks).to.equal(8);
            expect(work.oosEvaluations).to.equal(8);
            expect(output.assetDiagnostics.failedAssets).to.have.length(0);

            // A grouped Rust transport failure must rerun the whole dispatch
            // through the shared TypeScript gate. This proves fallback is
            // visible in diagnostics without pretending Rust and TypeScript
            // are interchangeable engines.
            forceRustFallback = true;
            activeGenericCalls = 0;
            maxActiveGenericCalls = 0;
            const fallbackOutput = await runAssetOpportunityIteration(
                {
                    runId: "rust-routing-fallback",
                    interval: "5m",
                    symbols: ["ASSET_A", "ASSET_B"],
                    options: makeOptions(),
                    settings,
                    capitalSettings,
                    selectedStrategies,
                    useRustEnginePreference: true,
                    rustCapabilities: RUST_CAPABILITIES,
                    typescriptSimulationConcurrency: {
                        enter: () => {
                            activeTypescriptSimulations += 1;
                            maxTypescriptSimulations = Math.max(maxTypescriptSimulations, activeTypescriptSimulations);
                        },
                        leave: () => {
                            activeTypescriptSimulations -= 1;
                        },
                    },
                    abortSignal: abortController.signal,
                    loadDataset: async () => data,
                    candidatePoolSize: 3,
                    minFreshSupport: 1,
                    generateParamSets: () => [{ threshold: 1 }],
                },
                { onProgress: () => undefined, onAssetResult: () => undefined },
                () => false,
            );
            const fallbackUsage = fallbackOutput.totals.engineUsage!;
            expect(fallbackUsage.rustFallbackRuns).to.be.greaterThan(0);
            expect(fallbackUsage.typescriptCompletedRuns).to.be.greaterThan(0);
            expect(fallbackUsage.typescriptReasons?.some(({ reason }) => reason.includes("Rust batch fallback"))).to.equal(true);
            expect(maxActiveGenericCalls).to.be.greaterThan(1);
            expect(maxTypescriptSimulations).to.equal(1);
        } finally {
            rustEngine.runAssetOpportunityBatchBacktestWithStatus = originalBatch;
            rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus = originalMultiBatch;
            rustEngine.runMultiAssetFreshEntryBatchBacktestWithStatus = originalMultiFresh;
            rustEngine.runBacktestWithStatus = originalGeneric;
            rustEngine.cacheData = originalCacheData;
            rustEngine.cacheMultiAssetDataWithStatus = originalMultiCacheData;
        }
    });

    it("loads real built-in strategy implementations from the manifest", async () => {
        const keys = getBuiltInStrategyKeys();
        const loaded = await Promise.all(keys.map(async (key) => ({
            key,
            strategy: await ensureBuiltInStrategyLoaded(key),
        })));
        expect(keys.length).to.equal(45);
        expect(loaded.every(({ strategy }) => strategy !== undefined)).to.equal(true);
        expect(loaded.map(({ key }) => key)).to.deep.equal(keys);
    });

    it("executes every real built-in with requested settings and keeps Rust routing deterministic", async () => {
        const keys = getBuiltInStrategyKeys();
        expect(keys).to.have.length(45);
        const loaded = await Promise.all(keys.map(async (key) => ({
            key,
            strategy: await ensureBuiltInStrategyLoaded(key),
        })));
        const seenSignals = new Map<string, Signal[][]>();
        const selectedStrategies = instrumentRealStrategies(
            loaded.map(({ key, strategy }) => ({ key, strategy: strategy! })),
            seenSignals,
        );
        const data = makeLongCandles();
        const originalMultiBatch = rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus;
        const originalGeneric = rustEngine.runBacktestWithStatus;
        const originalCache = rustEngine.cacheMultiAssetDataWithStatus;
        const originalBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        let multiCalls = 0;
        let genericCalls = 0;
        let unsupportedRustCalls = 0;
        const rustSignals: Signal[] = [];
        rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus = async (workloads): Promise<RustBatchTransportResult> => {
            multiCalls += 1;
            for (const workload of workloads) {
                for (const item of workload.items) {
                    rustSignals.push(...item.signals);
                    if (hasUnsupportedRustSignalShape(item.signals)) unsupportedRustCalls += 1;
                }
            }
            return makeRustBatchResponse(workloads.flatMap((workload) => workload.items));
        };
        rustEngine.runBacktestWithStatus = async (
            replayData,
            signals,
        ): Promise<RustBacktestTransportResult> => {
            genericCalls += 1;
            rustSignals.push(...signals);
            if (hasUnsupportedRustSignalShape(signals)) unsupportedRustCalls += 1;
            return { ok: true, result: makeRustGenericResult(replayData, signals) };
        };
        rustEngine.cacheMultiAssetDataWithStatus = async () => ({ ok: false, reason: "network_error" as const });
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";

        const run = () => runAssetOpportunityIteration(
            {
                runId: "real-built-in-routing",
                interval: "4h",
                symbols: ["ASSET_A", "ASSET_B"],
                options: makeOptions(),
                settings,
                capitalSettings,
                selectedStrategies,
                useRustEnginePreference: true,
                rustCapabilities: RUST_CAPABILITIES,
                abortSignal: new AbortController().signal,
                loadDataset: async () => data,
                candidatePoolSize: 3,
                minFreshSupport: 1,
                generateParamSets: (defaults) => [defaults],
            },
            { onProgress: () => undefined, onAssetResult: () => undefined },
            () => false,
        );

        try {
            const first = await run();
            const firstOrder = first.results.map((result) => `${result.symbol}:${result.strategyKey}:${result.historicalRank}`);
            const second = await run();
            const secondOrder = second.results.map((result) => `${result.symbol}:${result.strategyKey}:${result.historicalRank}`);

            expect(seenSignals.size).to.equal(45);
            expect([...seenSignals.values()].flat(2).every((signal) => !hasUnsupportedRustSignalShape([signal]))).to.equal(true);
            expect(rustSignals.every((signal) => !hasUnsupportedRustSignalShape([signal]))).to.equal(true);
            expect(unsupportedRustCalls).to.equal(0);
            expect(multiCalls).to.be.greaterThan(0, "compatible candidates should use grouped Rust IS execution");
            expect(genericCalls).to.be.greaterThan(0, "next_exit follow-up should execute through the generic Rust path");
            expect(secondOrder).to.deep.equal(firstOrder);

            const usage = first.totals.engineUsage!;
            const work = first.assetDiagnostics.work!;
            expect(usage.rustAttemptedRuns).to.equal((usage.rustCompletedRuns ?? 0) + (usage.rustFallbackRuns ?? 0));
            expect(work.candidateEvaluationsAttempted).to.equal(
                work.candidateEvaluationsCompleted + work.candidateEvaluationFailures,
            );
            expect(first.assetDiagnostics.failedAssets).to.deep.equal([]);
            expect(first.assetDiagnostics.totalAssets).to.equal(2);
            expect(first.assetDiagnostics.work!.selectedStrategies).to.equal(45);
        } finally {
            rustEngine.runMultiAssetAssetOpportunityBatchBacktestWithStatus = originalMultiBatch;
            rustEngine.runBacktestWithStatus = originalGeneric;
            rustEngine.cacheMultiAssetDataWithStatus = originalCache;
            if (originalBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
            else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = originalBatchFlag;
        }
    });
});
