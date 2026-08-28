import { performance } from "node:perf_hooks";
import { runAssetOpportunityIteration } from "../lib/finder/server/asset-opportunity-iteration";
import { rustEngine, hasUnsupportedRustSignalShape, type RustBuildProfile } from "../lib/rust-engine-client";
import { prepareClosedCandleData } from "../lib/backtest-executor";
import { hasRequiredRustCapabilities } from "../lib/rust-settings-sanitizer";
import { createAssetOpportunitySignalCache } from "../lib/finder/finder-asset-opportunity-search-cache";
import { FinderParamSpace } from "../lib/finder/finder-param-space";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type {
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
} from "../lib/types/strategies";
import type { FinderSelectedStrategy } from "../lib/finder/finder-runner";

const FOUR_HOURS_SECONDS = 4 * 60 * 60;
const BASE_TIME = 1_700_000_000;
const DEFAULT_BAR_COUNT = 3_600;
const DEFAULT_ASSET_COUNT = 64;
const DEFAULT_STRATEGY_COUNT = 45;
const DEFAULT_MAX_RUNS = 1;
const DEFAULT_CANDIDATE_POOL_SIZE = 3;
const DEFAULT_TOP_N = 3;
const DEFAULT_ITERATIONS = 1;
const DEFAULT_REPETITIONS = 3;
const DEFAULT_WORKERS = 1;
const OOS_HOLDOUT_BARS = 26;
const RUST_WARM_CACHE_MAX_ASSETS = 512;
const RUST_ENGINE_URL = (process.env.RUST_ENGINE_URL ?? "http://127.0.0.1:3030").replace(/\/+$/, "");

type EngineName = "typescript" | "rust";
type BenchmarkArm = "real-built-ins" | "coverage-synthetic";
type CacheMode = "cold" | "warm";
type OosCase = "next_exit" | "complementary";
type RoutingVariant = "all-ts" | "all-path-rust" | "rust-is-ts-followups" | "rust-per-asset";
type RustTransportPhase = "is_candidate" | "fresh_entry" | "winner_analytics" | "next_exit" | "complementary_oos" | "cache_bootstrap";
type RustTransportEndpoint = "multi_asset_is" | "asset_opportunity_is" | "fresh_entry_batch" | "generic_backtest" | "cache_bootstrap";
type RustTransportMethod =
    | "runBacktestWithStatus"
    | "runBatchBacktestWithStatus"
    | "runCachedBatchBacktestWithStatus"
    | "runFreshEntryBatchBacktestWithStatus"
    | "runCachedFreshEntryBatchBacktestWithStatus"
    | "runAssetOpportunityBatchBacktestWithStatus"
    | "runCachedAssetOpportunityBatchBacktestWithStatus"
    | "runMultiAssetAssetOpportunityBatchBacktestWithStatus"
    | "runMultiAssetFreshEntryBatchBacktestWithStatus"
    | "cacheData"
    | "cacheMultiAssetDataWithStatus";

const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
    const separator = arg.indexOf("=");
    if (separator > 2) args.set(arg.slice(0, separator), arg.slice(separator + 1));
    else if (arg.startsWith("--")) args.set(arg, "true");
}

function readPositiveInteger(name: string, fallback: number): number {
    const value = Number(args.get(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

function readEngine(): EngineName | "both" {
    const value = args.get("--engine") ?? "both";
    if (value !== "typescript" && value !== "rust" && value !== "both") {
        throw new Error("--engine must be typescript, rust, or both");
    }
    return value;
}

function readCacheModes(): CacheMode[] {
    const value = args.get("--cache") ?? "both";
    if (value === "both") return ["cold", "warm"];
    if (value === "cold" || value === "warm") return [value];
    throw new Error("--cache must be cold, warm, or both");
}

function readRoutingVariants(): RoutingVariant[] {
    const value = args.get("--routing") ?? "all";
    if (value === "all") return ["all-ts", "all-path-rust", "rust-is-ts-followups", "rust-per-asset"];
    const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    const valid: RoutingVariant[] = ["all-ts", "all-path-rust", "rust-is-ts-followups", "rust-per-asset"];
    if (values.length === 0 || values.some((entry) => !valid.includes(entry as RoutingVariant))) {
        throw new Error("--routing must be all or a comma-separated list of all-ts, all-path-rust, rust-is-ts-followups, rust-per-asset");
    }
    return values as RoutingVariant[];
}

function readOosCases(): OosCase[] {
    const value = args.get("--oos") ?? "next_exit";
    if (value === "both") return ["next_exit", "complementary"];
    if (value === "next_exit" || value === "complementary") return [value];
    throw new Error("--oos must be next_exit, complementary, or both");
}

function readArms(): BenchmarkArm[] {
    const value = args.get("--arm") ?? (args.has("--real-strategies") ? "real-built-ins" : "both");
    if (value === "both") return ["coverage-synthetic", "real-built-ins"];
    if (value === "coverage-synthetic" || value === "real-built-ins") return [value];
    throw new Error("--arm must be coverage-synthetic, real-built-ins, or both");
}

const BAR_COUNT = readPositiveInteger("--bars", DEFAULT_BAR_COUNT);
const ASSET_COUNT = readPositiveInteger("--assets", DEFAULT_ASSET_COUNT);
const MAX_RUNS = readPositiveInteger("--max-runs", DEFAULT_MAX_RUNS);
const CANDIDATE_POOL_SIZE = readPositiveInteger("--candidate-pool-size", DEFAULT_CANDIDATE_POOL_SIZE);
const TOP_N = readPositiveInteger("--top-n", DEFAULT_TOP_N);
const ITERATIONS = readPositiveInteger("--iterations", DEFAULT_ITERATIONS);
const REPETITIONS = readPositiveInteger("--repetitions", DEFAULT_REPETITIONS);
const STRATEGY_COUNT = readPositiveInteger("--strategies", DEFAULT_STRATEGY_COUNT);
const WORKER_COUNT = readPositiveInteger("--workers", DEFAULT_WORKERS);
const ENGINE = readEngine();
const CACHE_MODES = readCacheModes();
const ROUTING_VARIANTS = readRoutingVariants();
const OOS_CASES = readOosCases();
const DISABLE_SIGNAL_CACHE = args.has("--no-signal-cache");
const paramSpace = new FinderParamSpace();

if (WORKER_COUNT !== 1) {
    throw new Error("--workers must be 1: the corrected benchmark uses one identical worker for both engines");
}
if (STRATEGY_COUNT !== DEFAULT_STRATEGY_COUNT) {
    throw new Error(`--strategies must remain exactly ${DEFAULT_STRATEGY_COUNT} for the real built-in arm`);
}
if (CANDIDATE_POOL_SIZE < TOP_N) {
    throw new Error("--candidate-pool-size must be at least --top-n");
}
if (CACHE_MODES.includes("warm") && ASSET_COUNT > RUST_WARM_CACHE_MAX_ASSETS) {
    throw new Error(`--cache=warm supports at most ${RUST_WARM_CACHE_MAX_ASSETS} assets`);
}

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

if (REAL_STRATEGY_KEYS.length !== DEFAULT_STRATEGY_COUNT) {
    throw new Error(`Benchmark catalog has ${REAL_STRATEGY_KEYS.length} strategies; expected ${DEFAULT_STRATEGY_COUNT}`);
}

interface SignalInspectionCounts {
    invocations: number;
    signals: number;
    unsupportedGenerated: number;
}

interface SignalInspection {
    byStrategy: Record<string, SignalInspectionCounts>;
    invocations: number;
    signals: number;
    unsupportedGenerated: number;
    unsupportedRustRequests: number;
}

interface RustMeasurement {
    actualHttpRequests: number;
    unsupportedRequests: number;
    serviceProcessingMs: number;
    serviceProcessingSamples: number;
    maxRustConcurrency: number;
    byEndpoint: Record<RustTransportEndpoint, {
        calls: number;
        actualHttpRequests: number;
        elapsedMs: number;
        serviceProcessingMs: number;
        serviceProcessingSamples: number;
    }>;
    byMethod: Record<RustTransportMethod, {
        calls: number;
        actualHttpRequests: number;
        elapsedMs: number;
        serviceProcessingMs: number;
        serviceProcessingSamples: number;
    }>;
    byPhase: Record<RustTransportPhase, {
        calls: number;
        actualHttpRequests: number;
        elapsedMs: number;
        serviceProcessingMs: number;
        serviceProcessingSamples: number;
    }>;
}

function createSignalInspection(): SignalInspection {
    return { byStrategy: {}, invocations: 0, signals: 0, unsupportedGenerated: 0, unsupportedRustRequests: 0 };
}

function instrumentStrategy(key: string, source: Strategy, inspection: SignalInspection): Strategy {
    const counts = { invocations: 0, signals: 0, unsupportedGenerated: 0 };
    inspection.byStrategy[key] = counts;
    const inspect = (signals: Signal[]): Signal[] => {
        const unsupported = signals.filter((signal) => hasUnsupportedRustSignalShape([signal])).length;
        counts.invocations += 1;
        counts.signals += signals.length;
        counts.unsupportedGenerated += unsupported;
        inspection.invocations += 1;
        inspection.signals += signals.length;
        inspection.unsupportedGenerated += unsupported;
        return signals;
    };
    const wrapped: Strategy = {
        ...source,
        execute: (data, params, context) => inspect(source.execute(data, params, context)),
    };
    if (source.executePrepared) {
        wrapped.executePrepared = (preparedData, params, data, context) =>
            inspect(source.executePrepared!(preparedData, params, data, context));
    }
    return wrapped;
}

function buildCoverageStrategy(): Strategy {
    return {
        name: "Production-shaped next-open coverage strategy",
        description: "Deterministic benchmark signal at the visible/OOS boundary.",
        defaultParams: { lookback: 22 },
        paramLabels: { lookback: "Lookback" },
        execute(data) {
            const target = data.length - 1;
            const bar = data[target];
            return bar ? [{ time: bar.time, type: "buy", price: bar.close, barIndex: target }] : [];
        },
    };
}

function buildDataset(assetIndex: number): OHLCVData[] {
    return Array.from({ length: BAR_COUNT }, (_, index) => {
        const time = BASE_TIME + index * FOUR_HOURS_SECONDS;
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

function buildOptions(symbols: string[], oosCase: OosCase): FinderOptions {
    return {
        scope: "asset_opportunity",
        mode: "random",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        dataSlice: oosCase === "complementary" ? "half_oldest" : "all",
        oosValidationEnabled: oosCase === "complementary",
        randomSeed: 1,
        topN: TOP_N,
        steps: 1,
        rangePercent: 0,
        maxRuns: MAX_RUNS,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols,
            candidatePoolSize: CANDIDATE_POOL_SIZE,
            minFreshSupport: 1,
            evalLastBars: 1_000,
            oosMeasurementMode: oosCase === "next_exit" ? "next_exit" : "fixed_horizon",
            oosIgnoreLastBars: oosCase === "next_exit" ? OOS_HOLDOUT_BARS : 0,
        },
    };
}

async function loadStrategies(arm: BenchmarkArm, inspection: SignalInspection): Promise<FinderSelectedStrategy[]> {
    if (arm === "coverage-synthetic") {
        const strategy = buildCoverageStrategy();
        return [{
            key: "benchmark_production_shaped_synthetic",
            name: strategy.name,
            strategy: instrumentStrategy("benchmark_production_shaped_synthetic", strategy, inspection),
        }];
    }
    const selected: FinderSelectedStrategy[] = [];
    for (const key of REAL_STRATEGY_KEYS) {
        const loaded = await loadBuiltInStrategyByKey(key);
        if (!loaded) throw new Error(`Benchmark strategy not found: ${key}`);
        selected.push({ key, name: loaded.name, strategy: instrumentStrategy(key, loaded, inspection) });
    }
    return selected;
}

function createTypescriptTracker(): { tracker: { enter(): void; leave(): void }; maxConcurrency: () => number } {
    let active = 0;
    let maxConcurrency = 0;
    return {
        tracker: {
            enter() {
                active += 1;
                maxConcurrency = Math.max(maxConcurrency, active);
            },
            leave() {
                active -= 1;
            },
        },
        maxConcurrency: () => maxConcurrency,
    };
}

function resultProcessingMs(value: unknown): number | null {
    if (!value || typeof value !== "object") return null;
    const direct = (value as { processingTimeMs?: unknown }).processingTimeMs;
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    const nested = (value as { response?: { processingTimeMs?: unknown } }).response?.processingTimeMs;
    return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

function isActualHttpResult(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if ((value as { ok?: unknown }).ok === true) return true;
    const reason = (value as { reason?: unknown }).reason;
    return reason === "http_error"
        || reason === "timeout"
        || reason === "network_error"
        || reason === "malformed_response"
        || reason === "response_too_large";
}

function createTransportBuckets<T extends string>(keys: readonly T[]): Record<T, RustMeasurement["byEndpoint"][RustTransportEndpoint]> {
    return Object.fromEntries(keys.map((key) => [key, {
        calls: 0,
        actualHttpRequests: 0,
        elapsedMs: 0,
        serviceProcessingMs: 0,
        serviceProcessingSamples: 0,
    }])) as Record<T, RustMeasurement["byEndpoint"][RustTransportEndpoint]>;
}

function transportEndpoint(method: string): RustTransportEndpoint {
    if (method === "runMultiAssetAssetOpportunityBatchBacktestWithStatus") return "multi_asset_is";
    if (method === "runAssetOpportunityBatchBacktestWithStatus" || method === "runCachedAssetOpportunityBatchBacktestWithStatus") return "asset_opportunity_is";
    if (method === "runMultiAssetFreshEntryBatchBacktestWithStatus") return "fresh_entry_batch";
    if (method === "runFreshEntryBatchBacktestWithStatus" || method === "runCachedFreshEntryBatchBacktestWithStatus") return "fresh_entry_batch";
    if (method === "cacheData" || method === "cacheMultiAssetDataWithStatus") return "cache_bootstrap";
    return "generic_backtest";
}

function transportPhase(method: string, methodArgs: unknown[]): RustTransportPhase {
    if (method === "runMultiAssetAssetOpportunityBatchBacktestWithStatus"
        || method === "runAssetOpportunityBatchBacktestWithStatus"
        || method === "runCachedAssetOpportunityBatchBacktestWithStatus") return "is_candidate";
    if (method === "runMultiAssetFreshEntryBatchBacktestWithStatus"
        || method === "runFreshEntryBatchBacktestWithStatus"
        || method === "runCachedFreshEntryBatchBacktestWithStatus") return "fresh_entry";
    if (method === "cacheData" || method === "cacheMultiAssetDataWithStatus") return "cache_bootstrap";
    const options = methodArgs.at(-1);
    if (options && typeof options === "object") {
        const phase = (options as { rustDiagnosticPhase?: unknown }).rustDiagnosticPhase;
        if (phase === "is_candidate" || phase === "fresh_entry" || phase === "winner_analytics"
            || phase === "next_exit" || phase === "complementary_oos" || phase === "cache_bootstrap") {
            return phase;
        }
    }
    return "is_candidate";
}

function instrumentRust(inspection: SignalInspection): {
    measurement: RustMeasurement;
    restore: () => void;
} {
    const measurement: RustMeasurement = {
        actualHttpRequests: 0,
        unsupportedRequests: 0,
        serviceProcessingMs: 0,
        serviceProcessingSamples: 0,
        maxRustConcurrency: 0,
        byEndpoint: createTransportBuckets(["multi_asset_is", "asset_opportunity_is", "fresh_entry_batch", "generic_backtest", "cache_bootstrap"]),
        byMethod: createTransportBuckets([
            "runBacktestWithStatus",
            "runBatchBacktestWithStatus",
            "runCachedBatchBacktestWithStatus",
            "runFreshEntryBatchBacktestWithStatus",
            "runCachedFreshEntryBatchBacktestWithStatus",
            "runAssetOpportunityBatchBacktestWithStatus",
            "runCachedAssetOpportunityBatchBacktestWithStatus",
            "runMultiAssetAssetOpportunityBatchBacktestWithStatus",
            "runMultiAssetFreshEntryBatchBacktestWithStatus",
            "cacheData",
            "cacheMultiAssetDataWithStatus",
        ]),
        byPhase: createTransportBuckets(["is_candidate", "fresh_entry", "winner_analytics", "next_exit", "complementary_oos", "cache_bootstrap"]),
    };
    let active = 0;
    const methods = [
        "runBacktestWithStatus",
        "runBatchBacktestWithStatus",
        "runCachedBatchBacktestWithStatus",
        "runFreshEntryBatchBacktestWithStatus",
        "runCachedFreshEntryBatchBacktestWithStatus",
        "runAssetOpportunityBatchBacktestWithStatus",
        "runCachedAssetOpportunityBatchBacktestWithStatus",
        "runMultiAssetAssetOpportunityBatchBacktestWithStatus",
        "runMultiAssetFreshEntryBatchBacktestWithStatus",
        "cacheData",
        "cacheMultiAssetDataWithStatus",
    ] as const;
    const client = rustEngine as unknown as Record<string, unknown>;
    const originals = new Map<string, unknown>();
    for (const method of methods) {
        const original = client[method];
        if (typeof original !== "function") continue;
        originals.set(method, original);
        client[method] = async (...methodArgs: unknown[]): Promise<unknown> => {
            const endpoint = transportEndpoint(method);
            const phase = transportPhase(method, methodArgs);
            const endpointStats = measurement.byEndpoint[endpoint];
            const phaseStats = measurement.byPhase[phase];
            const methodStats = measurement.byMethod[method as RustTransportMethod];
            endpointStats.calls += 1;
            phaseStats.calls += 1;
            methodStats.calls += 1;
            const signalLists: Signal[][] = [];
            if (method === "runBacktestWithStatus" && Array.isArray(methodArgs[1])) {
                signalLists.push(methodArgs[1] as Signal[]);
            } else if (method !== "runBacktestWithStatus" && Array.isArray(methodArgs[0])) {
                for (const workload of methodArgs[0] as Array<{ items?: Array<{ signals?: Signal[] }> }>) {
                    for (const item of workload.items ?? []) {
                        if (Array.isArray(item.signals)) signalLists.push(item.signals);
                    }
                }
            }
            if (signalLists.some((signals) => hasUnsupportedRustSignalShape(signals))) {
                measurement.unsupportedRequests += 1;
                inspection.unsupportedRustRequests += 1;
            }
            active += 1;
            measurement.maxRustConcurrency = Math.max(measurement.maxRustConcurrency, active);
            const startedAt = performance.now();
            try {
                const result = await (original as (...values: unknown[]) => Promise<unknown>).apply(rustEngine, methodArgs);
                if (isActualHttpResult(result)) {
                    measurement.actualHttpRequests += 1;
                    endpointStats.actualHttpRequests += 1;
                    phaseStats.actualHttpRequests += 1;
                    methodStats.actualHttpRequests += 1;
                }
                const processingMs = resultProcessingMs(result);
                if (processingMs !== null) {
                    measurement.serviceProcessingMs += processingMs;
                    measurement.serviceProcessingSamples += 1;
                    endpointStats.serviceProcessingMs += processingMs;
                    endpointStats.serviceProcessingSamples += 1;
                    phaseStats.serviceProcessingMs += processingMs;
                    phaseStats.serviceProcessingSamples += 1;
                    methodStats.serviceProcessingMs += processingMs;
                    methodStats.serviceProcessingSamples += 1;
                }
                return result;
            } finally {
                const elapsedMs = performance.now() - startedAt;
                endpointStats.elapsedMs += elapsedMs;
                phaseStats.elapsedMs += elapsedMs;
                methodStats.elapsedMs += elapsedMs;
                active -= 1;
            }
        };
    }
    return {
        measurement,
        restore: () => {
            for (const [method, original] of originals) client[method] = original;
        },
    };
}

async function clearRustServiceCache(): Promise<void> {
    rustEngine.clearLocalCache();
    const response = await fetch(`${RUST_ENGINE_URL}/api/data/clear`, { method: "POST" });
    if (!response.ok) throw new Error(`Rust cache clear failed: ${response.status} ${response.statusText}`);
}

async function warmRustServiceCache(datasets: Map<string, OHLCVData[]>): Promise<{
    cache: Map<string, Promise<string | null>>;
    warmupMs: number;
}> {
    const cache = new Map<string, Promise<string | null>>();
    const symbols = [...datasets.keys()];
    const startedAt = performance.now();
    for (let start = 0; start < symbols.length; start += 32) {
        const workloads = symbols.slice(start, start + 32).map((symbol, offset) => ({
            id: `benchmark-warm-${start + offset}`,
            data: prepareClosedCandleData(datasets.get(symbol)!, "4h", settings),
        }));
        const response = await rustEngine.cacheMultiAssetDataWithStatus(workloads, {
            maxRequestBytes: 128 * 1024 * 1024,
            maxResponseBytes: 4 * 1024 * 1024,
        });
        if (!response.ok) throw new Error(`Rust cache warmup failed: ${response.reason}`);
        const payload = response.response as { datasets?: Array<{ id?: unknown; cacheId?: unknown }> };
        for (const entry of payload.datasets ?? []) {
            const index = typeof entry.id === "string" ? Number(entry.id.replace("benchmark-warm-", "")) : NaN;
            const symbol = Number.isInteger(index) ? symbols[index] : undefined;
            const cacheId = typeof entry.cacheId === "string" ? entry.cacheId : undefined;
            if (!symbol || !cacheId) continue;
            const rawData = datasets.get(symbol)!;
            const preparedData = prepareClosedCandleData(rawData, "4h", settings);
            cache.set(rustEngine.getDataCacheKey(rawData), Promise.resolve(cacheId));
            cache.set(rustEngine.getDataCacheKey(preparedData), Promise.resolve(cacheId));
        }
    }
    return { cache, warmupMs: performance.now() - startedAt };
}

function diagnosticsFor(outputs: Array<Awaited<ReturnType<typeof runAssetOpportunityIteration>>>) {
    const noSignalShortcuts = outputs.reduce((total, output) => total + ((output.totals.engineUsage?.typescriptReasons ?? [])
        .filter((entry) => entry.reason === "no signals required trade simulation")
        .reduce((sum, entry) => sum + entry.runs, 0) ?? 0), 0);
    const phaseCounts = outputs.reduce((total, output) => {
        const work = output.assetDiagnostics.work;
        total.fixedHorizon += work?.fixedHorizonEvaluations ?? 0;
        total.nextExit += work?.nextExitEvaluations ?? 0;
        total.complementaryWindow += work?.complementaryOosEvaluations ?? 0;
        total.winnerAnalytics += work?.winnerAnalyticsRecomputations ?? 0;
        return total;
    }, { fixedHorizon: 0, nextExit: 0, complementaryWindow: 0, winnerAnalytics: 0 });
    const usage = usageFor(outputs);
    const phaseExecutionCount = outputs.reduce((total, output) => {
        const work = output.assetDiagnostics.work;
        return total
            + (work?.candidateEvaluationsCompleted ?? 0)
            + (work?.freshEntryExecutions ?? 0)
            + (work?.nextExitEvaluations ?? 0)
            + (work?.complementaryOosEvaluations ?? 0)
            + (work?.winnerAnalyticsRecomputations ?? 0);
    }, 0);
    const engineCompletionCount = usage.rustCompleted + usage.typescriptCompleted;
    return {
        isCandidateSimulations: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.candidateEvaluationsAttempted ?? 0), 0),
        isCandidateCompletions: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.candidateEvaluationsCompleted ?? 0), 0),
        isCandidateFailures: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.candidateEvaluationFailures ?? 0), 0),
        freshnessSimulations: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.freshEntryRechecks ?? 0), 0),
        freshnessExecutions: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.freshEntryExecutions ?? 0), 0),
        fixedHorizonEvaluations: phaseCounts.fixedHorizon,
        nextExitReplays: phaseCounts.nextExit,
        oosValidations: {
            fixedHorizon: phaseCounts.fixedHorizon,
            nextExit: phaseCounts.nextExit,
            complementaryWindow: phaseCounts.complementaryWindow,
            total: phaseCounts.fixedHorizon + phaseCounts.nextExit + phaseCounts.complementaryWindow,
            complementaryEnabled: outputs.some((output) => (output.assetDiagnostics.work?.complementaryOosEvaluations ?? 0) > 0),
        },
        winnerAnalyticsRecomputations: phaseCounts.winnerAnalytics,
        noSignalShortcutsByEngine: {
            typescript: noSignalShortcuts,
            rust: 0,
        },
        phaseExecutionCount,
        engineCompletionCount,
        phaseCountsReconcile: phaseExecutionCount === engineCompletionCount,
    };
}

function usageFor(outputs: Array<Awaited<ReturnType<typeof runAssetOpportunityIteration>>>) {
    return outputs.reduce((total, output) => {
        const usage = output.totals.engineUsage;
        total.rustAttempted += usage?.rustAttemptedRuns ?? 0;
        total.rustCompleted += usage?.rustCompletedRuns ?? 0;
        total.rustFallback += usage?.rustFallbackRuns ?? 0;
        total.typescriptCompleted += usage?.typescriptCompletedRuns ?? 0;
        for (const reason of usage?.typescriptReasons ?? []) {
            total.typescriptReasons[reason.reason] = (total.typescriptReasons[reason.reason] ?? 0) + reason.runs;
        }
        return total;
    }, {
        rustAttempted: 0,
        rustCompleted: 0,
        rustFallback: 0,
        typescriptCompleted: 0,
        typescriptReasons: {} as Record<string, number>,
    });
}

interface BenchmarkMeasurement {
    repetition: number;
    arm: BenchmarkArm;
    cacheMode: CacheMode;
    oosCase: OosCase;
    routing: RoutingVariant;
    engine: EngineName;
    buildProfile: RustBuildProfile | null;
    wallMs: number;
    warmupMs?: number;
    coverage: ReturnType<typeof diagnosticsFor>;
    engineUsage: ReturnType<typeof usageFor>;
    rustTransport: RustMeasurement | null;
    maxTypescriptSimulationConcurrency: number;
    signalInspection: SignalInspection;
    progressMonotonic: boolean;
    resultRows: Awaited<ReturnType<typeof runAssetOpportunityIteration>>["results"];
    resultOrder: string[];
    determinism: "checked" | "fail" | "not checked";
    signalCache: {
        enabled: boolean;
        hits: number;
        misses: number;
    };
}

function engineForRouting(routing: RoutingVariant): EngineName {
    return routing === "all-ts" ? "typescript" : "rust";
}

type ExecutionPhase = Exclude<RustTransportPhase, "cache_bootstrap">;

function phaseExecutionCounts(coverage: ReturnType<typeof diagnosticsFor>): Record<ExecutionPhase, number> {
    return {
        is_candidate: coverage.isCandidateCompletions,
        fresh_entry: coverage.freshnessExecutions,
        winner_analytics: coverage.winnerAnalyticsRecomputations,
        next_exit: coverage.nextExitReplays,
        complementary_oos: coverage.oosValidations.complementaryWindow,
    };
}

function validateRouteExecution(measurement: BenchmarkMeasurement): void {
    const usage = measurement.engineUsage;
    if (measurement.routing === "all-ts") {
        if (usage.rustAttempted !== 0 || usage.rustCompleted !== 0 || usage.rustFallback !== 0) {
            throw new Error(`Benchmark route all-ts used Rust: ${JSON.stringify(usage)}`);
        }
        return;
    }

    if (!measurement.rustTransport) {
        throw new Error(`Benchmark route ${measurement.routing} produced no Rust transport diagnostics`);
    }
    if (usage.rustAttempted <= 0 || usage.rustCompleted <= 0) {
        throw new Error(`Benchmark route ${measurement.routing} performed zero Rust executions: ${JSON.stringify(usage)}`);
    }
    if (usage.rustFallback !== 0) {
        throw new Error(`Benchmark route ${measurement.routing} recorded an unexpected TypeScript fallback: ${JSON.stringify(usage)}`);
    }

    const counts = phaseExecutionCounts(measurement.coverage);
    const rustPhases = measurement.routing === "rust-is-ts-followups"
        ? new Set<ExecutionPhase>(["is_candidate"])
        : new Set<ExecutionPhase>([
            "is_candidate",
            "winner_analytics",
            "next_exit",
            "complementary_oos",
            // The complementary fixed-horizon route only needs generated
            // signals for fresh detection; its signal-only execution is an
            // intentional TypeScript-only phase. next_exit needs the
            // executable fresh replay and is Rust-applicable.
            ...(measurement.oosCase === "next_exit" ? ["fresh_entry" as const] : []),
        ]);
    for (const phase of Object.keys(counts) as ExecutionPhase[]) {
        const expectedExecutions = counts[phase];
        const rustCalls = measurement.rustTransport.byPhase[phase].calls;
        if (expectedExecutions > 0 && rustPhases.has(phase) && rustCalls === 0) {
            throw new Error(`Benchmark route ${measurement.routing} did not exercise Rust phase ${phase}: executions=${expectedExecutions}`);
        }
        if (expectedExecutions > 0 && !rustPhases.has(phase) && rustCalls !== 0) {
            throw new Error(`Benchmark route ${measurement.routing} unexpectedly exercised Rust phase ${phase}: calls=${rustCalls}`);
        }
    }

    // A zero-signal fresh recheck is intentionally completed by the
    // TypeScript signal-only shortcut even on an all-path Rust run. Therefore
    // total engine completions cannot be equated with every diagnostic phase
    // count; phase transport coverage and the no-fallback invariant are the
    // authoritative route checks here.
    if (measurement.routing === "rust-per-asset" && measurement.rustTransport.byPhase.is_candidate.calls > 0
        && measurement.rustTransport.byEndpoint.multi_asset_is.calls !== 0) {
        throw new Error("Benchmark route rust-per-asset unexpectedly used the multi-asset endpoint");
    }
}

async function runMeasurement(
    repetition: number,
    arm: BenchmarkArm,
    cacheMode: CacheMode,
    oosCase: OosCase,
    routing: RoutingVariant,
    datasets: Map<string, OHLCVData[]>,
): Promise<BenchmarkMeasurement> {
    const engine = engineForRouting(routing);
    const previousBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
    const previousMultiBatchFlag = process.env.FINDER_ASSET_OPPORTUNITY_RUST_MULTI_BATCH;
    const restoreEnvironment = () => {
        if (previousBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH;
        else process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = previousBatchFlag;
        if (previousMultiBatchFlag === undefined) delete process.env.FINDER_ASSET_OPPORTUNITY_RUST_MULTI_BATCH;
        else process.env.FINDER_ASSET_OPPORTUNITY_RUST_MULTI_BATCH = previousMultiBatchFlag;
    };
    if (engine === "rust") {
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_BATCH = "1";
        process.env.FINDER_ASSET_OPPORTUNITY_RUST_MULTI_BATCH = routing === "rust-per-asset" ? "0" : "1";
    }
    const inspection = createSignalInspection();
    let rustBatchDatasetCache: Map<string, Promise<string | null>> | undefined;
    let warmupMs: number | undefined;
    const typescript = createTypescriptTracker();
    const rust = engine === "rust" ? instrumentRust(inspection) : undefined;
    const signalCache = DISABLE_SIGNAL_CACHE ? undefined : createAssetOpportunitySignalCache();
    const paramSetCache = new Map<string, StrategyParams[]>();
    const outputs: Array<Awaited<ReturnType<typeof runAssetOpportunityIteration>>> = [];
    const progressSequences: number[][] = [];
    const symbols = [...datasets.keys()];
    let startedAt = 0;
    let buildProfile: RustBuildProfile | null = null;
    let rustCapabilities;
    try {
        if (engine === "rust") {
            if (!(await rustEngine.checkHealth())) throw new Error("Rust engine health check failed");
            if (rustEngine.buildProfile !== "release") {
                throw new Error(`Rust performance benchmark requires buildProfile=\"release\"; connected service advertised ${rustEngine.buildProfile ?? "missing"}`);
            }
            buildProfile = rustEngine.buildProfile;
            rustCapabilities = rustEngine.capabilities;
            if (!hasRequiredRustCapabilities(rustCapabilities, settings)) {
                throw new Error("Rust engine is healthy but does not advertise the capabilities required by this benchmark");
            }
            await clearRustServiceCache();
        }
        const selectedStrategies = await loadStrategies(arm, inspection);
        if (engine === "rust" && cacheMode === "warm") {
            const warmup = await warmRustServiceCache(datasets);
            rustBatchDatasetCache = warmup.cache;
            warmupMs = warmup.warmupMs;
        }
        startedAt = performance.now();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const iterationProgressValues: number[] = [];
            progressSequences.push(iterationProgressValues);
            outputs.push(await runAssetOpportunityIteration({
                runId: `finder-asset-opportunity-benchmark-${arm}-${oosCase}-${routing}-${cacheMode}-${repetition}-${iteration}`,
                interval: "4h",
                symbols,
                options: buildOptions(symbols, oosCase),
                settings,
                capitalSettings,
                selectedStrategies,
                useRustEnginePreference: engine === "rust",
                ...(routing === "rust-is-ts-followups" ? { useRustEngineForFollowups: false } : {}),
                rustCapabilities,
                typescriptSimulationConcurrency: typescript.tracker,
                abortSignal: new AbortController().signal,
                loadDataset: async (symbol) => datasets.get(symbol)!,
                candidatePoolSize: CANDIDATE_POOL_SIZE,
                minFreshSupport: 1,
                ...(rustBatchDatasetCache ? { rustBatchDatasetCache } : {}),
                ...(signalCache ? { signalCache } : {}),
                paramSetCache,
                generateParamSets: (defaults, finderOptions) => arm === "coverage-synthetic"
                    ? [defaults]
                    : paramSpace.generateParamSets(defaults, finderOptions),
            }, {
                onProgress: (progress) => iterationProgressValues.push(progress.percent),
                onAssetResult: () => undefined,
            }, () => false));
        }
    } finally {
        rust?.restore();
        restoreEnvironment();
    }
    const usage = usageFor(outputs);
    const coverage = diagnosticsFor(outputs);
    const resultOrders = outputs.map((output) => output.results.map((result) => `${result.symbol}:${result.strategyKey}:${result.historicalRank}`));
    const progressMonotonic = progressSequences.every((values) =>
        values.every((value, index) => index === 0 || value >= values[index - 1]!),
    );
    const determinism = ITERATIONS >= 2
        ? (resultOrders.every((order) => JSON.stringify(order) === JSON.stringify(resultOrders[0] ?? [])) ? "checked" : "fail")
        : "not checked";
    const resultOrder = resultOrders.flat();
    const wallMs = performance.now() - startedAt;
    const measurement: BenchmarkMeasurement = {
        repetition,
        arm,
        cacheMode,
        oosCase,
        routing,
        engine,
        buildProfile,
        wallMs,
        ...(warmupMs === undefined ? {} : { warmupMs }),
        coverage,
        engineUsage: usage,
        rustTransport: rust?.measurement ?? null,
        maxTypescriptSimulationConcurrency: typescript.maxConcurrency(),
        signalInspection: inspection,
        progressMonotonic,
        resultRows: outputs.flatMap((output) => output.results),
        resultOrder,
        determinism,
        signalCache: {
            enabled: !DISABLE_SIGNAL_CACHE,
            hits: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.signalCacheHits ?? 0), 0),
            misses: outputs.reduce((total, output) => total + (output.assetDiagnostics.work?.signalCacheMisses ?? 0), 0),
        },
    };
    if (!coverage.phaseCountsReconcile) {
        throw new Error(`Benchmark phase counts do not reconcile: phaseExecutionCount=${coverage.phaseExecutionCount}, engineCompletionCount=${coverage.engineCompletionCount}`);
    }
    if (!measurement.progressMonotonic) {
        throw new Error("Benchmark progress is not monotonic");
    }
    if (measurement.determinism === "fail") {
        throw new Error("Benchmark iteration result ordering is not deterministic");
    }
    validateRouteExecution(measurement);
    return measurement;
}

function compareScalarValues(
    left: unknown,
    right: unknown,
    path: string,
    mismatches: string[],
): boolean {
    if (mismatches.length >= 20) return false;
    if (typeof left === "number" && typeof right === "number") {
        if (left === right) return true;
        if (Number.isNaN(left) && Number.isNaN(right)) return true;
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            mismatches.push(`${path}: ${left} !== ${right}`);
            return false;
        }
        const tolerance = 1e-8 * Math.max(1, Math.abs(left), Math.abs(right));
        if (Math.abs(left - right) <= tolerance) return true;
        mismatches.push(`${path}: ${left} !== ${right}`);
        return false;
    }
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            mismatches.push(`${path}: array shape differs`);
            return false;
        }
        let equal = true;
        for (let index = 0; index < left.length; index += 1) {
            if (!compareScalarValues(left[index], right[index], `${path}[${index}]`, mismatches)) equal = false;
        }
        return equal;
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
            .filter((key) => key !== "exitControlDiagnostics" && key !== "processingTimeMs")
            .sort();
        let equal = true;
        for (const key of keys) {
            if (!compareScalarValues(leftRecord[key], rightRecord[key], path ? `${path}.${key}` : key, mismatches)) equal = false;
        }
        return equal;
    }
    mismatches.push(`${path}: ${String(left)} !== ${String(right)}`);
    return false;
}

function compareMeasurements(
    typescript: BenchmarkMeasurement,
    rust: BenchmarkMeasurement,
): {
    ordering: { equal: boolean; typescriptRows: number; rustRows: number; firstMismatch?: number };
    scalarResults: { equal: boolean; mismatches: string[] };
    engineDiagnostics: { equal: boolean; typescript: unknown; rust: unknown; issues: string[] };
} {
    const firstMismatch = typescript.resultOrder.findIndex((key, index) => key !== rust.resultOrder[index]);
    const orderingEqual = firstMismatch < 0 && typescript.resultOrder.length === rust.resultOrder.length;
    const mismatches: string[] = [];
    let scalarEqual = typescript.resultRows.length === rust.resultRows.length;
    if (!scalarEqual) mismatches.push(`result row count: ${typescript.resultRows.length} !== ${rust.resultRows.length}`);
    const rowCount = Math.min(typescript.resultRows.length, rust.resultRows.length);
    for (let index = 0; index < rowCount; index += 1) {
        if (!compareScalarValues(typescript.resultRows[index], rust.resultRows[index], `rows[${index}]`, mismatches)) scalarEqual = false;
    }
    const issues: string[] = [];
    if (!typescript.coverage.phaseCountsReconcile) issues.push("TypeScript phase counts do not reconcile");
    if (!rust.coverage.phaseCountsReconcile) issues.push("Rust phase counts do not reconcile");
    if (typescript.coverage.phaseExecutionCount !== rust.coverage.phaseExecutionCount) {
        issues.push(`phase execution count: ${typescript.coverage.phaseExecutionCount} !== ${rust.coverage.phaseExecutionCount}`);
    }
    const diagnosticFields: Array<keyof typeof typescript.coverage> = [
        "isCandidateSimulations",
        "isCandidateCompletions",
        "isCandidateFailures",
        "freshnessSimulations",
        "freshnessExecutions",
        "fixedHorizonEvaluations",
        "nextExitReplays",
        "winnerAnalyticsRecomputations",
    ];
    for (const field of diagnosticFields) {
        if (typescript.coverage[field] !== rust.coverage[field]) {
            issues.push(`${field}: ${typescript.coverage[field]} !== ${rust.coverage[field]}`);
        }
    }
    if (typescript.coverage.oosValidations.fixedHorizon !== rust.coverage.oosValidations.fixedHorizon
        || typescript.coverage.oosValidations.nextExit !== rust.coverage.oosValidations.nextExit
        || typescript.coverage.oosValidations.complementaryWindow !== rust.coverage.oosValidations.complementaryWindow) {
        issues.push("OOS phase diagnostics differ");
    }
    if (typescript.engineUsage.rustAttempted !== 0) issues.push("TypeScript arm attempted Rust");
    if (typescript.engineUsage.rustFallback !== 0) issues.push("TypeScript arm recorded Rust fallback");
    if (rust.engineUsage.rustFallback !== 0) issues.push("Rust arm recorded fallback");
    if (rust.rustTransport?.unsupportedRequests !== 0) issues.push("Rust arm sent unsupported signal requests");
    if (!typescript.progressMonotonic || !rust.progressMonotonic) issues.push("progress is not monotonic");
    if (typescript.determinism === "fail" || rust.determinism === "fail") issues.push("determinism check failed");
    return {
        ordering: {
            equal: orderingEqual,
            typescriptRows: typescript.resultOrder.length,
            rustRows: rust.resultOrder.length,
            ...(firstMismatch >= 0 ? { firstMismatch } : {}),
        },
        scalarResults: { equal: scalarEqual && orderingEqual, mismatches },
        engineDiagnostics: {
            equal: issues.length === 0,
            typescript: typescript.engineUsage,
            rust: rust.engineUsage,
            issues,
        },
    };
}

function serialiseMeasurement(measurement: BenchmarkMeasurement): Record<string, unknown> {
    const { resultRows: _resultRows, ...report } = measurement;
    return {
        benchmark: "finder-asset-opportunity-corrected",
        benchmarkKind: "production-shaped Finder iteration",
        strategyArm: measurement.arm === "coverage-synthetic"
            ? "deterministic coverage strategy"
            : "45 real built-ins",
        dataSource: measurement.arm === "coverage-synthetic"
            ? "deterministic generated OHLCV; not production market data"
            : "deterministic generated OHLCV with 45 real built-in strategy implementations; not production market data",
        ...report,
        resolvedConfig: {
            scope: "asset_opportunity",
            strategyCount: measurement.arm === "coverage-synthetic" ? 1 : DEFAULT_STRATEGY_COUNT,
            mode: "random",
            maxRuns: MAX_RUNS,
            candidatePoolSize: CANDIDATE_POOL_SIZE,
            topN: TOP_N,
            evalLastBars: 1_000,
            dataSlice: measurement.oosCase === "complementary" ? "half_oldest" : "all",
            oosValidationEnabled: measurement.oosCase === "complementary",
            oosMeasurementMode: measurement.oosCase === "next_exit" ? "next_exit" : "fixed_horizon",
            oosHoldoutBars: measurement.oosCase === "next_exit" ? OOS_HOLDOUT_BARS : 0,
            settings,
            capitalSettings,
            assets: ASSET_COUNT,
            bars: BAR_COUNT,
            iterations: ITERATIONS,
            repetitions: REPETITIONS,
            filters: { tradeFilterEnabled: false, minTrades: 0, maxTrades: "Infinity" },
            cacheMode: measurement.cacheMode,
            cacheSemantics: measurement.cacheMode === "cold"
                ? "Rust local and service dataset caches were cleared immediately before measurement; no warmup is included."
                : "Rust local and service dataset caches were explicitly warmed before measurement; warmup is reported separately and excluded from wallMs; the TypeScript process is reused.",
            routing: measurement.routing,
            workerCount: WORKER_COUNT,
        },
        wallMs: Number(measurement.wallMs.toFixed(2)),
        ...(measurement.warmupMs === undefined ? {} : { warmupMs: Number(measurement.warmupMs.toFixed(2)) }),
        rustTransport: measurement.rustTransport
            ? {
                ...measurement.rustTransport,
                serviceProcessingMs: Number(measurement.rustTransport.serviceProcessingMs.toFixed(2)),
                byEndpoint: measurement.rustTransport.byEndpoint,
                byPhase: measurement.rustTransport.byPhase,
                concurrencyScope: "client transport calls; Rust batch-internal Rayon width is not exposed",
            }
            : null,
        determinism: measurement.determinism,
        note: "TS and Rust use the same direct iteration seam; this report makes no speedup claim.",
    };
}

function percentile(values: number[], quantile: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * quantile;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function summarizeMeasurements(measurements: BenchmarkMeasurement[]): Array<Record<string, unknown>> {
    const groups = new Map<string, BenchmarkMeasurement[]>();
    for (const measurement of measurements) {
        const key = `${measurement.arm}|${measurement.cacheMode}|${measurement.oosCase}|${measurement.routing}`;
        const group = groups.get(key) ?? [];
        group.push(measurement);
        groups.set(key, group);
    }
    return [...groups.values()].map((group) => {
        const values = group.map((measurement) => measurement.wallMs);
        return {
            arm: group[0]!.arm,
            cacheMode: group[0]!.cacheMode,
            oosCase: group[0]!.oosCase,
            routing: group[0]!.routing,
            buildProfile: group[0]!.buildProfile,
            repetitions: values.length,
            wallMs: {
                median: Number(percentile(values, 0.5).toFixed(2)),
                min: Number(Math.min(...values).toFixed(2)),
                max: Number(Math.max(...values).toFixed(2)),
                p95: Number(percentile(values, 0.95).toFixed(2)),
            },
        };
    });
}

async function main(): Promise<void> {
    const datasets = new Map<string, OHLCVData[]>();
    for (let index = 0; index < ASSET_COUNT; index += 1) {
        datasets.set(`BENCH${index.toString().padStart(4, "0")}`, buildDataset(index));
    }
    const routing = ROUTING_VARIANTS.filter((variant) => {
        if (ENGINE === "both") return true;
        return engineForRouting(variant) === ENGINE;
    });
    if (routing.length === 0) throw new Error("No routing variants remain after --engine filtering");
    const measurements: BenchmarkMeasurement[] = [];
    for (const arm of readArms()) {
        for (const cacheMode of CACHE_MODES) {
            for (const oosCase of OOS_CASES) {
                for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
                    // Alternate route order between repetitions so thermal drift,
                    // service cache state, and process-wide JIT effects do not
                    // consistently favor one arm.
                    const orderedRouting = repetition % 2 === 0 ? routing : [...routing].reverse();
                    for (const route of orderedRouting) {
                        const measurement = await runMeasurement(repetition + 1, arm, cacheMode, oosCase, route, datasets);
                        measurements.push(measurement);
                        console.log(JSON.stringify(serialiseMeasurement(measurement)));
                    }
                }
            }
        }
    }

    const parityComparisons: Array<Record<string, unknown>> = [];
    for (const arm of readArms()) {
        for (const cacheMode of CACHE_MODES) {
            for (const oosCase of OOS_CASES) {
                for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
                    const typescript = measurements.find((measurement) =>
                        measurement.arm === arm
                        && measurement.cacheMode === cacheMode
                        && measurement.oosCase === oosCase
                        && measurement.repetition === repetition
                        && measurement.routing === "all-ts");
                    if (!typescript) continue;
                    for (const route of routing.filter((variant) => variant !== "all-ts")) {
                        const rust = measurements.find((measurement) =>
                            measurement.arm === arm
                            && measurement.cacheMode === cacheMode
                            && measurement.oosCase === oosCase
                            && measurement.repetition === repetition
                            && measurement.routing === route);
                        if (!rust) continue;
                        const comparison = compareMeasurements(typescript, rust);
                        parityComparisons.push({ arm, cacheMode, oosCase, repetition, routing: route, ...comparison });
                    }
                }
            }
        }
    }
    const parityStatus = parityComparisons.length === 0
        ? "not_measured"
        : parityComparisons.every((comparison) => {
            const ordering = comparison.ordering as { equal?: boolean };
            const scalar = comparison.scalarResults as { equal?: boolean };
            const diagnostics = comparison.engineDiagnostics as { equal?: boolean };
            return ordering.equal === true && scalar.equal === true && diagnostics.equal === true;
        }) ? "pass" : "fail";
    console.log(JSON.stringify({
        benchmark: "finder-asset-opportunity-corrected-summary",
        resolvedConfig: {
            bars: BAR_COUNT,
            assets: ASSET_COUNT,
            candidatePoolSize: CANDIDATE_POOL_SIZE,
            topN: TOP_N,
            iterations: ITERATIONS,
            repetitions: REPETITIONS,
            workerCount: WORKER_COUNT,
            oosCases: OOS_CASES,
            routing,
        },
        performance: {
            summaries: summarizeMeasurements(measurements),
            comparisonBasis: "median wallMs by identical arm/cache/repetition configuration; no speedup claim",
            groupedFreshEntry: CANDIDATE_POOL_SIZE < 8
                ? { status: "not_applicable", reason: "candidatePoolSize is below the production density gate of 8" }
                : { status: "measured", route: "all-path-rust" },
        },
        parity: {
            comparisons: parityComparisons,
            status: parityStatus,
        },
    }));
    if (parityStatus === "fail") {
        throw new Error("Finder Asset Opportunity benchmark parity validation failed");
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
