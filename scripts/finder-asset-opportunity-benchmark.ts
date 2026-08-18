import { performance } from "node:perf_hooks";
import { debugLogger } from "../lib/debug-logger";
import { runAssetOpportunityIteration } from "../lib/finder/server/asset-opportunity-iteration";
import { rustEngine } from "../lib/rust-engine-client";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const BAR_COUNT = 3_589;
const ASSET_COUNT = Number(process.argv.find((arg) => arg.startsWith("--assets="))?.slice(9) ?? 64);
const STRATEGY_COUNT = Number(process.argv.find((arg) => arg.startsWith("--strategies="))?.slice(13) ?? 45);
const CANDIDATE_COUNT = Number(process.argv.find((arg) => arg.startsWith("--candidates="))?.slice(13) ?? 2);
const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const USE_REAL_STRATEGIES = process.argv.includes("--real-strategies");
const ENGINE_ONLY = process.argv.find((arg) => arg.startsWith("--engine="))?.slice(9);

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

function buildOptions(symbols: string[]): FinderOptions {
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
                ? { evalLastBars: 500, oosIgnoreLastBars: 12 }
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

async function run(useRustEnginePreference: boolean, datasets: Map<string, OHLCVData[]>): Promise<void> {
    const symbols = [...datasets.keys()];
    const selectedStrategies = await buildSelectedStrategies();
    if (useRustEnginePreference) {
        // A benchmark must not reuse ids from a prior Rust process. The
        // service cache is intentionally process-local and the client keeps a
        // small local id map for production reuse.
        rustEngine.clearLocalCache();
        await fetch("http://127.0.0.1:3030/api/data/clear", { method: "POST" });
    }
    const startedAt = performance.now();
    const progressValues: number[] = [];
    const transportLogs: string[] = [];
    const seenLogIds = new Set<number>();
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
    const output = await runAssetOpportunityIteration(
        {
            runId: `finder-engine-benchmark-${useRustEnginePreference ? "rust" : "typescript"}`,
            interval: "4h",
            symbols,
            options: buildOptions(symbols),
            settings,
            capitalSettings,
            selectedStrategies,
            useRustEnginePreference,
            abortSignal: new AbortController().signal,
            loadDataset: async (symbol) => datasets.get(symbol)!,
            candidatePoolSize: CANDIDATE_COUNT,
            minFreshSupport: 1,
            ...(USE_REAL_STRATEGIES
                ? {}
                : {
                    generateParamSets: () => Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({ lookback: 22 + index })),
                }),
        },
        {
            onProgress: (progress) => progressValues.push(progress.percent),
            onAssetResult: () => undefined,
        },
        () => false,
    );
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
        diagnosticsMs: output.assetDiagnostics.timingsMs,
        engineUsage: output.totals.engineUsage,
        results: output.results.length,
        progressMonotonic: progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]!),
        ...(transportLogs.length > 0
            ? {
                transport: {
                    requests: transportLogs.length,
                    elapsedMs: Number(transportElapsedMs.toFixed(2)),
                },
            }
            : {}),
    }));
}

async function main(): Promise<void> {
    if (!Number.isInteger(ASSET_COUNT) || ASSET_COUNT < 1) throw new Error("--assets must be a positive integer");
    if (!Number.isInteger(STRATEGY_COUNT) || STRATEGY_COUNT < 1) throw new Error("--strategies must be a positive integer");
    if (!Number.isInteger(CANDIDATE_COUNT) || CANDIDATE_COUNT < 1) throw new Error("--candidates must be a positive integer");
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
