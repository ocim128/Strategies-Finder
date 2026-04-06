/**
 * Shared request/response types for the backtest HTTP endpoint.
 *
 * These types define the execution contract: any caller (UI, Flux.Native, batch,
 * or random search) that supplies the same explicit inputs must receive the
 * same result because both paths use the same shared executor.
 */

import type {
    OHLCVData,
    StrategyParams,
    BacktestSettings,
    BacktestResult,
} from "./types/strategies";
import type { CapitalSettings } from "./types/backtest";
import {
    buildBacktestPolymarketPerformanceSummary,
    type BacktestPolymarketPerformanceSummary,
} from "./polymarket-diagnostics-utils";

// ============================================================================
// Engine mode
// ============================================================================

export type EngineMode = "auto" | "typescript" | "rust_preferred";

/**
 * Intentional endpoint simplification: every HTTP backtest uses the same
 * fixed-dollar sizing profile. This removes endpoint-side capital knobs and is
 * not a bug.
 */
export const BACKTEST_ENDPOINT_CAPITAL_SETTINGS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    sizingMode: "fixed",
    fixedTradeAmount: 1000,
} satisfies CapitalSettings);

// ============================================================================
// Execution context
// ============================================================================

export interface BacktestExecutionContext {
    /**
     * Current wall-clock time in unix seconds. Drives closed-candle trimming
     * so the endpoint does not treat the latest bar as closed when it is not.
     */
    nowSec: number;

    /**
     * Optional chart-block range to slice signals and candles.
     * Both values are unix seconds.
     */
    blockRange: { from: number; to: number } | null;

    /**
     * When true, annotate the result with Polymarket outcome data if the
     * symbol supports it. Keep this opt-in so bulk search stays fast.
     */
    annotatePolymarket: boolean;

    /**
     * Engine selection preference. "typescript" forces the TS path for
     * deterministic parity testing. "auto" follows the global toggle.
     * "rust_preferred" attempts Rust but falls back on failure.
     */
    engineMode: EngineMode;
}

// ============================================================================
// Dataset payload
// ============================================================================

export interface BacktestDatasetPayload {
    /** Full candle array when the caller does not use a cached dataset ref. */
    candles: OHLCVData[];
}

// ============================================================================
// Single-run request
// ============================================================================

export interface BacktestSingleRequest {
    symbol: string;
    interval: string;

    /** Either a full candle array or a cached dataset reference id. */
    dataset: BacktestDatasetPayload | { ref: string };

    strategyParams: StrategyParams;

    /**
     * Raw backtest settings as they would come from the UI or an external
     * orchestrator. The executor will resolve them through the shared
     * resolver so defaults and guard rules are identical.
     */
    backtestSettings: BacktestSettings | Record<string, unknown>;

    /** Execution-time context that replaces implicit DOM / global reads. */
    context: BacktestExecutionContext;
}

// ============================================================================
// Batch item
// ============================================================================

export interface BacktestBatchItem {
    /** Caller-supplied identifier for correlating results. */
    id: string;
    strategyParams: StrategyParams;
    /** Per-item overrides; when omitted the top-level settings are used. */
    backtestSettings?: BacktestSettings | Record<string, unknown>;
    context?: Partial<BacktestExecutionContext>;
}

// ============================================================================
// Batch request
// ============================================================================

export interface BacktestBatchRequest {
    symbol: string;
    interval: string;

    /**
     * Dataset can be either:
     * - raw candle array for small batches
     * - { ref: "cache_..." } when the dataset was pre-uploaded
     */
    dataset: BacktestDatasetPayload | { ref: string };

    items: BacktestBatchItem[];

    backtestSettings?: BacktestSettings | Record<string, unknown>;
    context?: BacktestExecutionContext;

    /**
     * When true, return only compact ranking fields per item instead of
     * the full backtest result body. Useful for large sweeps.
     */
    compact?: boolean;
}

// ============================================================================
// Dataset upload
// ============================================================================

export interface DatasetUploadRequest {
    candles: OHLCVData[];
    /** Optional caller-supplied hint for the cache key. */
    keyHint?: string;
}

export interface DatasetUploadResponse {
    ok: true;
    datasetRef: string;
    hash: string;
    candleCount: number;
    firstTime: number;
    lastTime: number;
}

// ============================================================================
// Randomized search request
// ============================================================================

export interface RandomSearchParamSpec {
    /**
     * A map of param keys that should be randomized instead of using the
     * exact value from baseParams. The value can be:
     * - A single number -> treated as a fixed override (no randomization).
     * - An array [min, max] -> uniform integer range.
     * - An array [min, max, step] -> stepped integer range.
     */
    [paramKey: string]: number | [number, number] | [number, number, number];
}

export interface BacktestRandomizationSpec {
    /**
     * Symmetric percentage range around each baseParams value.
     * E.g. 35 means [base * 0.65, base * 1.35].
     */
    rangePercent: number;

    /** Number of random parameter sets to generate and evaluate. */
    count: number;

    /**
     * Deterministic seed for reproducible searches.
     * When null/undefined the search is non-deterministic.
     */
    seed?: number;

    /**
     * Param keys that must keep their baseParams value unchanged during
     * randomization (e.g. stopLossAtr, takeProfitAtr when testing only
     * lookback windows).
     */
    freezeKeys?: string[];

    /**
     * Explicit param specs for full control. When provided, rangePercent is
     * used as the fallback for keys not listed here.
     */
    paramSpecs?: RandomSearchParamSpec;
}

export interface BacktestRankingSpec {
    /** Return only the top N results after filtering and sorting. */
    topN: number;

    /**
     * Sort priority list. The executor will sort descending by the first
     * available metric in the list.
     */
    sortPriority: Array<"expectancy" | "profitFactor" | "netProfitPercent" | "winRate" | "totalTrades" | "sharpeRatio">;

    /** Minimum closed trades required to be included in the ranking. */
    minTrades?: number;

    /** Maximum trades allowed (protects against runaway parameter sets). */
    maxTrades?: number;
}

export interface BacktestRandomSearchRequest {
    symbol: string;
    interval: string;

    dataset: BacktestDatasetPayload | { ref: string };

    /** Base parameters to randomize around. */
    baseParams: StrategyParams;

    randomization: BacktestRandomizationSpec;

    backtestSettings?: BacktestSettings | Record<string, unknown>;
    context?: BacktestExecutionContext;

    /** Ranking and filtering applied after all runs complete. */
    ranking?: BacktestRankingSpec;

    /** When true, return only compact metric rows instead of full results. */
    compact?: boolean;
}

// ============================================================================
// Response shapes
// ============================================================================

export interface StrategyManifestFingerprint {
    /** Number of strategies registered in the manifest. */
    strategyCount: number;
    /** Simple hash over the sorted key list for quick equality checks. */
    hash: string;
}

export interface BacktestSingleResponse {
    ok: true;
    strategyKey: string;
    engineUsed: "rust" | "typescript";
    result: SlimBacktestSingleResult;
    /** Output only if randomized via random-parameter-range header */
    strategyParams?: StrategyParams;
    /** Hex hash of the effective inputs (symbol + interval + dataset + params + settings + fixed endpoint capital profile + context). */
    requestFingerprint: string;
    strategyManifestFingerprint: StrategyManifestFingerprint;
    /** Execution wall-clock duration in milliseconds. */
    timingMs: number;
}

export interface BacktestBatchItemResult {
    id: string;
    ok: boolean;
    error?: string;
    strategyKey: string;
    engineUsed: string;
    /** Full result when compact is false, otherwise compact metrics. */
    result: BacktestResult | CompactBacktestMetrics;
    timingMs: number;
}

export interface BacktestBatchResponse {
    ok: true;
    strategyKey: string;
    datasetRef?: string;
    processed: number;
    returned: number;
    topN: number;
    results: BacktestBatchItemResult[];
    totalTimingMs: number;
}

/**
 * Compact metrics returned when the caller only needs ranking / screening
 * values instead of the full trade list and equity curve.
 */
export interface CompactBacktestMetrics {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    netProfit: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    avgTrade: number;
    avgWin: number;
    avgLoss: number;
}

export interface SlimBacktestSingleResult extends CompactBacktestMetrics {
    marketContext?: BacktestResult["marketContext"];
    polymarketTradeSummary?: BacktestResult["polymarketTradeSummary"];
    polymarketPerformance?: BacktestPolymarketPerformanceSummary;
}

export interface BacktestRandomSearchResponse {
    ok: true;
    strategyKey: string;
    datasetRef?: string;
    processed: number;
    returned: number;
    topN: number;
    results: Array<{
        rank: number;
        params: StrategyParams;
        metrics: CompactBacktestMetrics;
        /** Full result included only when compact is false and within topN. */
        result?: BacktestResult | CompactBacktestMetrics;
    }>;
    totalTimingMs: number;
    seed?: number;
}

export interface BacktestHealthResponse {
    ok: true;
    version: string;
    manifest: StrategyManifestFingerprint;
    enginePreference: {
        rustAvailable: boolean;
        rustPreferred: boolean;
    };
}

// ============================================================================
// Error response
// ============================================================================

export interface BacktestErrorResponse {
    ok: false;
    error: string;
    code?: string;
}

// ============================================================================
// Helpers
// ============================================================================

export function toCompactMetrics(result: BacktestResult): CompactBacktestMetrics {
    return {
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        winRate: result.winRate,
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        profitFactor: result.profitFactor,
        maxDrawdown: result.maxDrawdown,
        maxDrawdownPercent: result.maxDrawdownPercent,
        sharpeRatio: result.sharpeRatio,
        avgTrade: result.avgTrade,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
    };
}

export function toSlimSingleResult(result: BacktestResult): SlimBacktestSingleResult {
    return {
        ...toCompactMetrics(result),
        marketContext: result.marketContext,
        polymarketTradeSummary: result.polymarketTradeSummary,
        polymarketPerformance: buildBacktestPolymarketPerformanceSummary(result),
    };
}
