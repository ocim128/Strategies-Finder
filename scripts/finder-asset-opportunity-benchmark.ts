import { performance } from "node:perf_hooks";
import { debugLogger } from "../lib/debug-logger";
import { runAssetOpportunityIteration } from "../lib/finder/server/asset-opportunity-iteration";
import { rustEngine } from "../lib/rust-engine-client";
import { prepareClosedCandleData } from "../lib/backtest-executor";
import {
    createRealWorkerAssetOpportunityBatchRunner,
    runAssetOpportunityBatchSweep,
    type AssetOpportunityBatchWorkerTask,
} from "../lib/finder/server/finder-asset-opportunity-batch-worker-pool";
import { createAssetOpportunitySignalCache } from "../lib/finder/finder-asset-opportunity-search-cache";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams, Time } from "../lib/types/strategies";

const BAR_COUNT = 3_589;
const ASSET_COUNT = Number(process.argv.find((arg) => arg.startsWith("--assets="))?.slice(9) ?? 64);
const STRATEGY_COUNT = Number(process.argv.find((arg) => arg.startsWith("--strategies="))?.slice(13) ?? 45);
const CANDIDATE_COUNT = Number(process.argv.find((arg) => arg.startsWith("--candidates="))?.slice(13) ?? 2);
const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const USE_REAL_STRATEGIES = process.argv.includes("--real-strategies");
const ENGINE_ONLY = process.argv.find((arg) => arg.startsWith("--engine="))?.slice(9);
const WARM_RUST_CACHE = process.argv.includes("--warm-rust-cache");
const WORKER_COUNT = Number(process.argv.find((arg) => arg.startsWith("--workers="))?.slice(10) ?? 0);
const HOLDOUT_COUNT = Number(process.argv.find((arg) => arg.startsWith("--holdouts="))?.slice(11) ?? 1);
// `--holdouts=N` repeats the same asset universe sequentially so the
// worker-local signal cache can amortize its cold full-series pass.
const DISABLE_SIGNAL_CACHE = process.argv.includes("--no-signal-cache");

// These are the 45 built-ins used by the production-shaped Asset Opportunity
// run. The deterministic strategy remains available as the small smoke case,
// but it must not be the only performance comparison: signal generation is
// part of the real Finder wall clock.
const REAL_STRATEGY_KEYS = [
    "decay_anchor_reversion",
    "entropy_ratio_regime_alignment",
    "open_clearance_collapse_reversal",
    "wick_responsive_boundary_retest",
    "probability_boundary_eigen_shift",
    "pivot_midpoint_anchor_fade",
    "true_range_skewness_initiation",
    "true_range_skew_acceptance",
    "efficiency_keltner_router",
    "cumulative_return_zscore_reversion",
    "cumulative_return_percentile_reversion",
    "body_proportion_percentile_fade",
    "return_sign_streak_fade",
    "close_location_gradient_acceleration",
    "modern_arbitrage_speed_reversion",
    "ema_confirmation",
    "typical_close_skewness_acceptance",
    "kelly_streak_exhaustion_reversion",
    "dmi_direction_confirmation",
    "parabolic_sar_confirmation",
    "dema_confirmation",
    "donchian_midpoint_confirmation",
    "mcginley_dynamic_confirmation",
    "n_bar_momentum_confirmation",
    "rolling_median_confirmation",
    "typical_price_ema_confirmation",
    "volume_weighted_median_confirmation",
    "wilder_ma_confirmation",
    "zero_lag_ema_confirmation",
    "body_direction_placement_coherence",
    "nested_bar_oscillation_fade",
    "median_deviation_fade_chop",
    "short_return_streak_fade_chop",
    "short_term_overextension_fade",
    "open_location_zscore_reversion",
    "defended_low_reversion",
    "lagged_value_anchor_reversion",
    "rejection_confirmed_depth_fade",
    "vwap_deviation_reversion",
    "robust_zscore_typical_fade",
    "whipsaw_crossing_burst_reversal",
    "body_impulse_zscore_exhaustion",
    "open_lower_quartile_clearance_reversal",
    "open_prior_midpoint_displacement_reversion",
    "return_autocorrelation_alternation",
] as const;

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
    riskMinHoldBars: 1,
    riskMaxHoldBars: 1,
    riskCooldownBars: 2,
    slippageBps: 0,
    tradeDirection: "long",
    executionModel: "signal_close",
    pathExitEnabled: false,
    disableSignalExits: false,
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 0,
};

const strategy: Strategy = {
    name: "Finder benchmark strategy",
    description: "Deterministic benchmark-only signal generator.",
    defaultParams: { lookback: 22 },
    paramLabels: { lookback: "Lookback" },
    execute(data) {
    const signals = [] as Array<{ time: Time; type: "buy" | "sell"; price: number }>;
        for (let index = 20; index + 3 < data.length; index += 16) {
            const entry = data[index]!;
            const exit = data[index + 3]!;
            signals.push(
                { time: entry.time, type: "buy", price: entry.close },
                { time: exit.time, type: "sell", price: exit.close },
            );
        }
        return signals;
    },
};

function buildDataset(assetIndex: number): OHLCVData[] {
    return Array.from({ length: BAR_COUNT }, (_, index) => {
        const time = 1_700_000_000 + index * FOUR_HOURS_SECONDS;
        const base = 100 + assetIndex * 0.01 + Math.sin(index / 13) * 2 + index * 0.002;
        return {
            time: time as Time,
            open: base,
            high: base + 0.5,
            low: base - 0.5,
            close: base + Math.cos(index / 7) * 0.15,
            volume: 1_000 + (index % 17),
        };
    });
}

function buildOptions(symbols: string[], holdoutIndex = 0): FinderOptions {
    return {
        mode: "random",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        scope: "asset_opportunity",
        dataSlice: "all",
        randomSeed: 1,
        topN: CANDIDATE_COUNT,
        steps: 1,
        rangePercent: 0,
        maxRuns: CANDIDATE_COUNT,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: 0,
        assetOpportunity: {
            symbols,
            candidatePoolSize: CANDIDATE_COUNT,
            minFreshSupport: 1,
            ...(USE_REAL_STRATEGIES
                ? { evalLastBars: 500, oosIgnoreLastBars: 12 * (holdoutIndex + 1) }
                : {}),
        },
    };
}

async function buildSelectedStrategies(): Promise<Array<{ key: string; name: string; strategy: Strategy }>> {
    if (!USE_REAL_STRATEGIES) {
        return Array.from({ length: STRATEGY_COUNT }, (_, index) => ({
            key: `finder_benchmark_strategy_${index}`,
            name: `${strategy.name} ${index + 1}`,
            strategy,
        }));
    }
    const selected = [] as Array<{ key: string; name: string; strategy: Strategy }>;
    for (const key of REAL_STRATEGY_KEYS.slice(0, STRATEGY_COUNT)) {
        const loaded = await loadBuiltInStrategyByKey(key);
        if (!loaded) throw new Error(`Benchmark strategy not found: ${key}`);
        selected.push({ key, name: loaded.name, strategy: loaded });
    }
    return selected;
}

async function runInWorkerPool(
    datasets: Map<string, OHLCVData[]>,
    selectedStrategies: Array<{ key: string; name: string; strategy: Strategy }>,
    workerCount: number,
): Promise<{
    iterations: number;
    assets: number;
    results: number;
    engineUsage: Record<string, unknown>;
}> {
    const symbols = [...datasets.keys()];
    const chunkCount = Math.max(1, Math.min(workerCount, symbols.length));
    const chunkSize = Math.ceil(symbols.length / chunkCount);
    const tasks: AssetOpportunityBatchWorkerTask[] = Array.from({ length: chunkCount }, (_, assetChunkIndex) => {
        const chunkSymbols = symbols.slice(assetChunkIndex * chunkSize, (assetChunkIndex + 1) * chunkSize);
        return {
            taskIndex: assetChunkIndex,
            holdoutBars: 0,
            assetChunkIndex,
            assetChunkCount: chunkCount,
            runId: `finder-engine-benchmark-worker-${assetChunkIndex}`,
            interval: "4h",
            symbols: chunkSymbols,
            options: buildOptions(chunkSymbols),
            settings,
            capitalSettings,
            strategyKeys: selectedStrategies.map((strategy) => strategy.key),
            exitStrategyKeys: [],
            useRustEnginePreference: true,
            providerBySymbol: null,
            candidatePoolSize: CANDIDATE_COUNT,
            minFreshSupport: 1,
            inlineDatasets: Object.fromEntries(chunkSymbols.map((symbol) => [symbol, datasets.get(symbol)!])),
        };
    });
    const completed: Array<Awaited<ReturnType<typeof runAssetOpportunityIteration>>> = [];
    await runAssetOpportunityBatchSweep({
        tasks,
        runnerCount: chunkCount,
        createRunner: createRealWorkerAssetOpportunityBatchRunner,
        onIterationResult: async (_task, iteration) => {
            completed.push(iteration);
        },
        onProgress: () => undefined,
        onRunLog: () => undefined,
        isCancelled: () => false,
    });
    const usageFor = (iteration: Awaited<ReturnType<typeof runAssetOpportunityIteration>>) => {
        const usage = iteration.totals.engineUsage;
        return {
            rustAttemptedRuns: usage?.rustAttemptedRuns ?? 0,
            rustCompletedRuns: usage?.rustCompletedRuns ?? 0,
            rustFallbackRuns: usage?.rustFallbackRuns ?? 0,
            typescriptCompletedRuns: usage?.typescriptCompletedRuns ?? 0,
        };
    };
    const usage = completed.reduce((totals, iteration) => {
        const iterationUsage = usageFor(iteration);
        totals.rustAttemptedRuns += iterationUsage.rustAttemptedRuns;
        totals.rustCompletedRuns += iterationUsage.rustCompletedRuns;
        totals.rustFallbackRuns += iterationUsage.rustFallbackRuns;
        totals.typescriptCompletedRuns += iterationUsage.typescriptCompletedRuns;
        return totals;
    }, {
        rustRequested: true,
        rustAttemptedRuns: 0,
        rustCompletedRuns: 0,
        rustFallbackRuns: 0,
        typescriptCompletedRuns: 0,
    });
    return {
        iterations: completed.length,
        assets: symbols.length,
        results: completed.reduce((total, iteration) => total + iteration.results.length, 0),
        engineUsage: usage,
    };
}

async function run(useRustEnginePreference: boolean, datasets: Map<string, OHLCVData[]>): Promise<void> {
    const symbols = [...datasets.keys()];
    const selectedStrategies = await buildSelectedStrategies();
    // Worker tasks resolve strategy keys in the worker's built-in catalog,
    // exactly like the production server route. The deterministic smoke
    // strategy is intentionally main-thread-only because it is not a
    // production-loadable built-in and must not be silently replaced by a
    // different workload.
    if (useRustEnginePreference && WORKER_COUNT > 1 && !USE_REAL_STRATEGIES) {
        throw new Error("--workers requires --real-strategies so the benchmark uses production-loadable strategies");
    }
    const effectiveWorkerCount = WORKER_COUNT > 1
        ? WORKER_COUNT
        : useRustEnginePreference && USE_REAL_STRATEGIES && symbols.length >= 32
            ? 4
            : 0;
    if (useRustEnginePreference && effectiveWorkerCount > 1 && HOLDOUT_COUNT === 1) {
        const startedAt = performance.now();
        const workerOutput = await runInWorkerPool(datasets, selectedStrategies, effectiveWorkerCount);
        console.log(JSON.stringify({
            engine: "rust",
            strategyMode: USE_REAL_STRATEGIES ? "real-built-ins" : "deterministic-smoke",
            assets: workerOutput.assets,
            workerCount: effectiveWorkerCount,
            executionMode: "rust-asset-workers",
            wallMs: Number((performance.now() - startedAt).toFixed(2)),
            iterations: workerOutput.iterations,
            results: workerOutput.results,
            engineUsage: workerOutput.engineUsage,
            progressMonotonic: true,
        }));
        return;
    }
    let rustBatchDatasetCache: Map<string, Promise<string | null>> | undefined;
    let rustCacheWarmupMs: number | undefined;
    if (useRustEnginePreference) {
        // A benchmark must not reuse ids from a prior Rust process. The
        // service cache is intentionally process-local and the client keeps a
        // small local id map for production reuse.
        rustEngine.clearLocalCache();
        await fetch("http://127.0.0.1:3030/api/data/clear", { method: "POST" });
        if (WARM_RUST_CACHE) {
            rustBatchDatasetCache = new Map();
            const warmupStartedAt = performance.now();
            for (let start = 0; start < symbols.length; start += 32) {
                const workloads = symbols.slice(start, start + 32).map((symbol, offset) => ({
                    id: `warm-${start + offset}`,
                    data: prepareClosedCandleData(datasets.get(symbol)!, "4h", settings),
                }));
                const cached = await rustEngine.cacheMultiAssetDataWithStatus(workloads, {
                    maxRequestBytes: 128 * 1024 * 1024,
                    maxResponseBytes: 4 * 1024 * 1024,
                });
                if (!cached.ok) throw new Error(`Rust cache warmup failed: ${cached.reason}`);
                const payload = cached.response as { datasets?: Array<{ id?: unknown; cacheId?: unknown }> };
                for (const entry of payload.datasets ?? []) {
                    const index = typeof entry.id === "string" ? Number(entry.id.slice("warm-".length)) : NaN;
                    const symbol = Number.isInteger(index) ? symbols[index] : undefined;
                    const cacheId = typeof entry.cacheId === "string" ? entry.cacheId : undefined;
                    if (symbol && cacheId) {
                        const rawData = datasets.get(symbol)!;
                        const preparedData = prepareClosedCandleData(rawData, "4h", settings);
                        rustBatchDatasetCache.set(
                            rustEngine.getDataCacheKey(preparedData),
                            Promise.resolve(cacheId),
                        );
                        rustBatchDatasetCache.set(rustEngine.getDataCacheKey(rawData), Promise.resolve(cacheId));
                    }
                }
            }
            rustCacheWarmupMs = performance.now() - warmupStartedAt;
        }
    }
    const startedAt = performance.now();
    const progressValues: number[] = [];
    const transportLogs: string[] = [];
    const seenLogIds = new Set<number>(debugLogger.getEntries().map((entry) => entry.id));
    const unsubscribe = useRustEnginePreference
        ? debugLogger.subscribe((entries) => {
            for (const entry of entries) {
                if (seenLogIds.has(entry.id)) continue;
                seenLogIds.add(entry.id);
                if (entry.level === "info" && entry.message.startsWith("[RustEngine] Batch ")) {
                    transportLogs.push(entry.message);
                }
            }
        })
        : undefined;
    const signalCache = DISABLE_SIGNAL_CACHE ? undefined : createAssetOpportunitySignalCache();
    const paramSetCache = new Map<string, StrategyParams[]>();
    const outputs: Array<Awaited<ReturnType<typeof runAssetOpportunityIteration>>> = [];
    for (let holdoutIndex = 0; holdoutIndex < HOLDOUT_COUNT; holdoutIndex += 1) {
        const output = await runAssetOpportunityIteration(
            {
                runId: `finder-engine-benchmark-${useRustEnginePreference ? "rust" : "typescript"}-${holdoutIndex}`,
                interval: "4h",
                symbols,
                options: buildOptions(symbols, holdoutIndex),
                settings,
                capitalSettings,
                selectedStrategies,
                useRustEnginePreference,
                abortSignal: new AbortController().signal,
                loadDataset: async (symbol) => datasets.get(symbol)!,
                candidatePoolSize: CANDIDATE_COUNT,
                minFreshSupport: 1,
                ...(rustBatchDatasetCache ? { rustBatchDatasetCache } : {}),
                ...(signalCache ? { signalCache } : {}),
                paramSetCache,
                ...(USE_REAL_STRATEGIES
                    ? {}
                    : {
                        generateParamSets: () => Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({ lookback: 22 + index })),
                    }),
            },
            {
                onProgress: (progress) => progressValues.push(holdoutIndex * 100 + progress.percent),
                onAssetResult: () => undefined,
            },
            () => false,
        );
        outputs.push(output);
    }
    unsubscribe?.();
    const wallMs = performance.now() - startedAt;
    const transportElapsedMs = transportLogs.reduce((total, message) => {
        const match = message.match(/ in ([0-9.]+)ms \(Rust:/);
        return total + (match ? Number(match[1]) : 0);
    }, 0);
    console.log(JSON.stringify({
        engine: useRustEnginePreference ? "rust" : "typescript",
        strategyMode: USE_REAL_STRATEGIES ? "real-built-ins" : "deterministic-smoke",
        assets: symbols.length,
        wallMs: Number(wallMs.toFixed(2)),
        ...(rustCacheWarmupMs !== undefined
            ? {
                rustCacheWarmupMs: Number(rustCacheWarmupMs.toFixed(2)),
                totalWithWarmupMs: Number((wallMs + rustCacheWarmupMs).toFixed(2)),
            }
            : {}),
        holdouts: HOLDOUT_COUNT,
        signalCache: {
            enabled: !DISABLE_SIGNAL_CACHE,
            hits: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.signalCacheHits ?? 0), 0),
            misses: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.signalCacheMisses ?? 0), 0),
        },
        diagnosticsMs: outputs.length === 1
            ? outputs[0]!.assetDiagnostics.timingsMs
            : outputs.map((output) => output.assetDiagnostics.timingsMs),
        timingSummary: outputs.length === 1
            ? outputs[0]!.assetDiagnostics.timingSummary
            : outputs.map((output) => output.assetDiagnostics.timingSummary),
        engineUsage: outputs.length === 1
            ? outputs[0]!.totals.engineUsage
            : outputs.map((output) => output.totals.engineUsage),
        results: outputs.reduce((total, output) => total + output.results.length, 0),
        progressMonotonic: progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]!),
        ...(transportLogs.length > 0
            ? {
                transport: {
                    requests: transportLogs.length,
                    elapsedMs: Number(transportElapsedMs.toFixed(2)),
                    endpoints: transportLogs.map((message) => message.match(/Batch (\/api\/[^:]+):/)?.[1] ?? "unknown"),
                    rustServiceMs: Number(transportLogs.reduce((total, message) => {
                        const match = message.match(/\(Rust: ([0-9.]+)ms\)/);
                        return total + (match ? Number(match[1]) : 0);
                    }, 0).toFixed(2)),
                },
            }
            : {}),
    }));
}

async function main(): Promise<void> {
    if (!Number.isInteger(ASSET_COUNT) || ASSET_COUNT < 1) throw new Error("--assets must be a positive integer");
    if (!Number.isInteger(STRATEGY_COUNT) || STRATEGY_COUNT < 1) throw new Error("--strategies must be a positive integer");
    if (!Number.isInteger(CANDIDATE_COUNT) || CANDIDATE_COUNT < 1) throw new Error("--candidates must be a positive integer");
    if (!Number.isInteger(HOLDOUT_COUNT) || HOLDOUT_COUNT < 1) throw new Error("--holdouts must be a positive integer");
    const datasets = new Map<string, OHLCVData[]>();
    for (let index = 0; index < ASSET_COUNT; index += 1) {
        datasets.set(`BENCH${index.toString().padStart(4, "0")}`, buildDataset(index));
    }
    if (ENGINE_ONLY !== "rust") await run(false, datasets);
    if (ENGINE_ONLY !== "typescript") await run(true, datasets);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
