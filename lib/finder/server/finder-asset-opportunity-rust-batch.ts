/**
 * Server-only Rust batch seam for Asset Opportunity in-sample candidates.
 *
 * The external Rust service accepts one OHLCV dataset per batch request and
 * runs the candidate signal sets in parallel. This module keeps the service
 * behind an independently disableable gate, partitions request bodies by serialized
 * size, validates the complete response, and returns a whole-batch fallback
 * signal. No partial Rust result is ever treated as a successful iteration.
 */

import type { BacktestSettings, BacktestResult, OHLCVData, Signal, Time } from "../../types/strategies";
import type { CapitalSettings, TradeSizingMode } from "../../types/backtest";
import type { FinderSelectedStrategy } from "../finder-runner";
import { isRustSupportedTradeSizingMode } from "../../types/backtest";
import { buildSelectionResult } from "../endpoint";
import { isSameEventPolymarketExitMode } from "../../polymarket-exit-mode";
import {
    type RustEngineClient,
    type RustAssetOpportunityCandidateSummary,
    type RustFreshEntrySummary,
    type RustBatchTransportFailureReason,
    type RustBatchTransportResult,
} from "../../rust-engine-client";

export const FINDER_ASSET_OPPORTUNITY_RUST_BATCH_ENV = "FINDER_ASSET_OPPORTUNITY_RUST_BATCH";
export const FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES_ENV = "FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES";
export const FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES_ENV = "FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES";
export const DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MIN_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES = 1 * 1024 * 1024;
const MAX_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES = 128 * 1024 * 1024;
const MIN_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const MIN_RUST_BATCH_CANDIDATES_PER_ASSET = 8;

export function shouldUseRustAssetOpportunityBatch(candidateCount: number, evalLastBars = 0): boolean {
    if (!Number.isFinite(evalLastBars) || evalLastBars <= 0) return true;
    return Number.isFinite(candidateCount) && candidateCount >= MIN_RUST_BATCH_CANDIDATES_PER_ASSET;
}

export type AssetOpportunityRustBatchFailureReason =
    | "feature_disabled"
    | "rust_preference_disabled"
    | "execution_model_unsupported"
    | "slippage_unsupported"
    | "direction_unsupported"
    | "multiple_positions_unsupported"
    | "risk_control_unsupported"
    | "smart_sizing_unsupported"
    | "cross_symbol_unsupported"
    | "exit_override_unsupported"
    | "request_too_large"
    | "response_too_large"
    | "cancelled"
    | "health_unavailable"
    | "timeout"
    | "network_error"
    | "http_error"
    | "transport_failure"
    | "malformed_response"
    | "missing_result_id"
    | "unknown_result_id"
    | "duplicate_result_id"
    | "inconsistent_result";

export interface AssetOpportunityRustBatchFeatureConfig {
    enabled: boolean;
    maxRequestBytes: number;
    maxResponseBytes: number;
}

export interface AssetOpportunityRustBatchItem {
    id: string;
    signals: Signal[];
    settings?: BacktestSettings;
}

export interface RustAssetOpportunityCandidateResult {
    id: string;
    result: BacktestResult;
    selectionResult?: BacktestResult;
    endpointAdjusted?: boolean;
    endpointRemovedTrades?: number;
}

export function buildAssetOpportunityRustDatasetCacheKey(args: {
    symbol: string;
    interval: string;
    data: OHLCVData[];
    client?: Partial<Pick<RustEngineClient, "getDataCacheKey">>;
}): string {
    const dataKey = args.client?.getDataCacheKey?.(args.data);
    if (dataKey) return JSON.stringify([args.symbol, args.interval, dataKey]);
    const first = args.data[0];
    const last = args.data[args.data.length - 1];
    return JSON.stringify([
        args.symbol,
        args.interval,
        args.data.length,
        first?.time ?? null,
        first?.open ?? null,
        first?.close ?? null,
        last?.time ?? null,
        last?.open ?? null,
        last?.close ?? null,
    ]);
}

export interface RustAssetOpportunityFreshEntryCandidateResult {
    id: string;
    summary: RustFreshEntrySummary;
}

export interface RustAssetOpportunitySummaryCandidateResult {
    id: string;
    summary: RustAssetOpportunityCandidateSummary;
}

export interface CompactAssetOpportunityCandidateResult {
    result: BacktestResult;
    selectionResult: BacktestResult;
    endpointAdjusted: boolean;
    endpointRemovedTrades: number;
}

export type AssetOpportunityRustBatchClient = Pick<RustEngineClient, "runBatchBacktestWithStatus">
    & Partial<Pick<RustEngineClient,
        | "cacheData"
        | "runCachedBatchBacktestWithStatus"
        | "runAssetOpportunityBatchBacktestWithStatus"
        | "runCachedAssetOpportunityBatchBacktestWithStatus"
        | "getDataCacheKey"
    >>;

export type AssetOpportunityRustFreshBatchClient = Pick<RustEngineClient, "runFreshEntryBatchBacktestWithStatus">
    & Partial<Pick<RustEngineClient, "cacheData" | "runCachedFreshEntryBatchBacktestWithStatus" | "getDataCacheKey">>;

export interface AssetOpportunityRustBatchEligibilityInput {
    featureConfig: AssetOpportunityRustBatchFeatureConfig;
    useRustEnginePreference?: boolean;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    exitStrategyCandidates?: FinderSelectedStrategy[];
    dataFetcherPresent?: boolean;
}

export interface AssetOpportunityRustBatchEligibility {
    eligible: boolean;
    reason?: AssetOpportunityRustBatchFailureReason;
}

export interface AssetOpportunityRustBatchDispatchInput {
    client: AssetOpportunityRustBatchClient;
    data: OHLCVData[];
    /** Optional common full window used by the multi-asset cache transport. */
    cacheData?: OHLCVData[];
    items: AssetOpportunityRustBatchItem[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    baseSettings: BacktestSettings;
    lastDataTime?: Time | null;
    sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: CapitalSettings["advancedSizing"] };
    maxRequestBytes: number;
    maxResponseBytes?: number;
    cacheId?: string;
    datasetEndIndex?: number;
    signal?: AbortSignal;
}

export type AssetOpportunityRustBatchDispatch =
    | {
        status: "completed";
        results: Map<string, RustAssetOpportunityCandidateResult>;
        requests: number;
        requestBytes: number;
        latencyMs: number;
    }
    | {
        status: "fallback" | "cancelled";
        reason: AssetOpportunityRustBatchFailureReason;
        requests: number;
        requestBytes: number;
        latencyMs: number;
        message?: string;
    };

export interface AssetOpportunityRustFreshBatchDispatchInput {
    client: AssetOpportunityRustFreshBatchClient;
    data: OHLCVData[];
    cacheData?: OHLCVData[];
    datasetEndIndex?: number;
    items: AssetOpportunityRustBatchItem[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    baseSettings: BacktestSettings;
    sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: CapitalSettings["advancedSizing"] };
    maxRequestBytes: number;
    maxResponseBytes?: number;
    cacheId?: string;
    signal?: AbortSignal;
}

export type AssetOpportunityRustFreshBatchDispatch =
    | {
        status: "completed";
        results: Map<string, RustAssetOpportunityFreshEntryCandidateResult>;
        requests: number;
        requestBytes: number;
        latencyMs: number;
    }
    | {
        status: "fallback" | "cancelled";
        reason: AssetOpportunityRustBatchFailureReason;
        requests: number;
        requestBytes: number;
        latencyMs: number;
        message?: string;
    };

function parseBoundedPositiveInteger(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    return Math.min(maximum, Math.floor(parsed));
}

export function resolveAssetOpportunityRustBatchFeatureConfig(
    env: NodeJS.ProcessEnv = process.env,
): AssetOpportunityRustBatchFeatureConfig {
    const enabled = env[FINDER_ASSET_OPPORTUNITY_RUST_BATCH_ENV] !== "0";
    return {
        enabled,
        maxRequestBytes: parseBoundedPositiveInteger(
            env[FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES_ENV],
            DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
            MIN_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
            MAX_ASSET_OPPORTUNITY_RUST_BATCH_MAX_BYTES,
        ),
        maxResponseBytes: parseBoundedPositiveInteger(
            env[FINDER_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES_ENV],
            DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
            MIN_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
            MAX_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
        ),
    };
}

/**
 * Eligibility deliberately repeats the Rust capability fence instead of
 * weakening the generic single-run `rust-settings-sanitizer` gate. The Rust
 * server has no execution-model or slippage fields, and its `Both` direction
 * normalizes to long, so those cases must remain TypeScript.
 */
export function resolveAssetOpportunityRustBatchEligibility(
    input: AssetOpportunityRustBatchEligibilityInput,
): AssetOpportunityRustBatchEligibility {
    if (!input.featureConfig.enabled) return { eligible: false, reason: "feature_disabled" };
    if (input.useRustEnginePreference !== true) return { eligible: false, reason: "rust_preference_disabled" };
    if (input.selectedStrategy.strategy.crossSymbolConfig || input.dataFetcherPresent) {
        return { eligible: false, reason: "cross_symbol_unsupported" };
    }
    if (input.exitStrategyCandidates && input.exitStrategyCandidates.length > 0) {
        return { eligible: false, reason: "exit_override_unsupported" };
    }
    if ((input.settings.executionModel ?? "signal_close") !== "signal_close") {
        return { eligible: false, reason: "execution_model_unsupported" };
    }
    if ((input.settings.slippageBps ?? 0) !== 0) {
        return { eligible: false, reason: "slippage_unsupported" };
    }
    const direction = input.settings.tradeDirection ?? "long";
    if (direction !== "long" && direction !== "short") {
        return { eligible: false, reason: "direction_unsupported" };
    }
    if ((input.settings.maxOpenTrades ?? 1) !== 1) {
        return { eligible: false, reason: "multiple_positions_unsupported" };
    }
    if (
        input.settings.riskMinHoldEnabled === true
        || input.settings.riskMaxHoldEnabled === true
        || input.settings.riskCooldownEnabled === true
        || input.settings.riskWinStreakStopLossEnabled === true
        || input.settings.disableSignalExits === true
        || input.settings.pathExitEnabled === true
        || input.settings.strategyTimeframeEnabled === true
        || input.settings.polymarketProtectionTakeProfitEnabled === true
        || input.settings.polymarketProtectionStopLossEnabled === true
        || isSameEventPolymarketExitMode(input.settings.polymarketExitMode)
    ) {
        return { eligible: false, reason: "risk_control_unsupported" };
    }
    if (input.settings.riskMode === "percentage" && input.settings.takeProfitEnabled === true && input.settings.takeProfitMode !== "fixed") {
        return { eligible: false, reason: "risk_control_unsupported" };
    }
    if (!isRustSupportedTradeSizingMode(input.capitalSettings.sizingMode)) {
        return { eligible: false, reason: "smart_sizing_unsupported" };
    }
    return { eligible: true };
}

function jsonByteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function estimateAssetOpportunityRustBatchRequestBytes(args: {
    data: OHLCVData[];
    items: AssetOpportunityRustBatchItem[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    baseSettings: BacktestSettings;
    sizing?: AssetOpportunityRustBatchDispatchInput["sizing"];
    compact: boolean;
    cacheId?: string;
}): number {
    const request = {
        ...(args.cacheId ? { cacheId: args.cacheId } : { data: args.data }),
        items: args.items,
        initialCapital: args.initialCapital,
        positionSizePercent: args.positionSizePercent,
        commissionPercent: args.commissionPercent,
        baseSettings: args.baseSettings,
        ...(args.sizing ? { sizing: args.sizing } : {}),
        compact: args.compact,
    };
    return jsonByteLength(request);
}

export function partitionAssetOpportunityRustBatchItems(args: {
    data: OHLCVData[];
    items: AssetOpportunityRustBatchItem[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    baseSettings: BacktestSettings;
    sizing?: AssetOpportunityRustBatchDispatchInput["sizing"];
    maxRequestBytes: number;
    cacheId?: string;
}): { chunks: AssetOpportunityRustBatchItem[][]; tooLargeItemId?: string } {
    const chunks: AssetOpportunityRustBatchItem[][] = [];
    let current: AssetOpportunityRustBatchItem[] = [];
    for (const item of args.items) {
        const candidate = [...current, item];
        const bytes = estimateAssetOpportunityRustBatchRequestBytes({
            data: args.data,
            items: candidate,
            initialCapital: args.initialCapital,
            positionSizePercent: args.positionSizePercent,
            commissionPercent: args.commissionPercent,
            baseSettings: args.baseSettings,
            ...(args.sizing ? { sizing: args.sizing } : {}),
            compact: false,
            ...(args.cacheId ? { cacheId: args.cacheId } : {}),
        });
        if (bytes > args.maxRequestBytes && current.length === 0) {
            return { chunks: [], tooLargeItemId: item.id };
        }
        if (bytes > args.maxRequestBytes) {
            chunks.push(current);
            current = [item];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) chunks.push(current);
    return { chunks };
}

const REQUIRED_RESULT_FIELDS = [
    "netProfit",
    "netProfitPercent",
    "winRate",
    "expectancy",
    "avgTrade",
    "profitFactor",
    "maxDrawdown",
    "maxDrawdownPercent",
    "totalTrades",
    "winningTrades",
    "losingTrades",
    "avgWin",
    "avgLoss",
    "sharpeRatio",
] as const;

function isFiniteOrPositiveInfinity(value: unknown): value is number {
    return typeof value === "number" && (Number.isFinite(value) || value === Number.POSITIVE_INFINITY);
}

function normalizeBacktestResult(value: unknown): BacktestResult | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (!Array.isArray(raw.trades) || !Array.isArray(raw.equityCurve)) return null;
    for (const field of REQUIRED_RESULT_FIELDS) {
        if (field === "profitFactor" && raw[field] === null) continue;
        if (!isFiniteOrPositiveInfinity(raw[field])) return null;
    }
    const totalTrades = raw.totalTrades as number;
    const winningTrades = raw.winningTrades as number;
    const losingTrades = raw.losingTrades as number;
    if (![totalTrades, winningTrades, losingTrades].every(Number.isInteger)) return null;
    if (totalTrades < 0 || winningTrades < 0 || losingTrades < 0 || totalTrades !== winningTrades + losingTrades) return null;
    const profitFactor = raw.profitFactor === null && totalTrades === 0
        ? 0
        : raw.profitFactor === null && winningTrades > 0 && losingTrades === 0
            ? Number.POSITIVE_INFINITY
            : raw.profitFactor;
    if (!isFiniteOrPositiveInfinity(profitFactor)) return null;
    if (totalTrades > 0) {
        const expectedWinRate = (winningTrades / totalTrades) * 100;
        const expectedAvgTrade = (raw.netProfit as number) / totalTrades;
        const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
        if (Math.abs(expectedWinRate - (raw.winRate as number)) > 1) return null;
        if (Math.abs(expectedAvgTrade - (raw.avgTrade as number)) > tolerance) return null;
    }
    return { ...raw, profitFactor } as unknown as BacktestResult;
}

export function validateAssetOpportunityRustBatchResponse(
    response: unknown,
    expectedIds: readonly string[],
): { ok: true; results: Map<string, RustAssetOpportunityCandidateResult>; processingTimeMs: number } | {
    ok: false;
    reason: Extract<AssetOpportunityRustBatchFailureReason, "malformed_response" | "missing_result_id" | "unknown_result_id" | "duplicate_result_id" | "inconsistent_result">;
    message: string;
} {
    if (!response || typeof response !== "object") {
        return { ok: false, reason: "malformed_response", message: "Rust batch response is not an object" };
    }
    const payload = response as { results?: unknown; processingTimeMs?: unknown };
    if (!Array.isArray(payload.results) || !Number.isFinite(payload.processingTimeMs)) {
        return { ok: false, reason: "malformed_response", message: "Rust batch response has invalid results or processingTimeMs" };
    }
    const expected = new Set(expectedIds);
    const results = new Map<string, RustAssetOpportunityCandidateResult>();
    for (const entry of payload.results) {
        if (!entry || typeof entry !== "object") {
            return { ok: false, reason: "malformed_response", message: "Rust batch result item is not an object" };
        }
        const item = entry as { id?: unknown; result?: unknown };
        if (typeof item.id !== "string" || item.id.length === 0) {
            return { ok: false, reason: "missing_result_id", message: "Rust batch result item has no string id" };
        }
        if (!expected.has(item.id)) {
            return { ok: false, reason: "unknown_result_id", message: `Rust batch returned unknown id ${item.id}` };
        }
        if (results.has(item.id)) {
            return { ok: false, reason: "duplicate_result_id", message: `Rust batch returned duplicate id ${item.id}` };
        }
        const normalizedResult = normalizeBacktestResult(item.result);
        if (!normalizedResult) {
            return { ok: false, reason: "inconsistent_result", message: `Rust batch returned inconsistent result for ${item.id}` };
        }
        results.set(item.id, { id: item.id, result: normalizedResult });
    }
    if (results.size !== expected.size) {
        const missing = expectedIds.find((id) => !results.has(id));
        return { ok: false, reason: "missing_result_id", message: `Rust batch omitted id ${missing ?? "unknown"}` };
    }
    return { ok: true, results, processingTimeMs: payload.processingTimeMs as number };
}

const ASSET_OPPORTUNITY_SUMMARY_FIELDS = [
    "netProfit",
    "netProfitPercent",
    "winRate",
    "expectancy",
    "avgTrade",
    "maxDrawdown",
    "maxDrawdownPercent",
    "avgWin",
    "avgLoss",
    "sharpeRatio",
] as const;

function isAssetOpportunityMetricSummary(value: unknown): value is RustAssetOpportunityCandidateSummary["result"] {
    if (!value || typeof value !== "object") return false;
    const summary = value as Record<string, unknown>;
    if (!ASSET_OPPORTUNITY_SUMMARY_FIELDS.every((field) => Number.isFinite(summary[field]))) return false;
    if (summary.profitFactor !== null && !Number.isFinite(summary.profitFactor)) return false;
    return ["totalTrades", "winningTrades", "losingTrades"].every((field) =>
        Number.isInteger(summary[field]) && (summary[field] as number) >= 0,
    ) && summary.totalTrades === (summary.winningTrades as number) + (summary.losingTrades as number);
}

export function validateAssetOpportunityRustSummaryBatchResponse(
    response: unknown,
    expectedIds: readonly string[],
): { ok: true; results: Map<string, RustAssetOpportunitySummaryCandidateResult>; processingTimeMs: number } | {
    ok: false;
    reason: Extract<AssetOpportunityRustBatchFailureReason, "malformed_response" | "missing_result_id" | "unknown_result_id" | "duplicate_result_id" | "inconsistent_result">;
    message: string;
} {
    if (!response || typeof response !== "object") {
        return { ok: false, reason: "malformed_response", message: "Rust Asset Opportunity response is not an object" };
    }
    const payload = response as { results?: unknown; processingTimeMs?: unknown };
    if (!Array.isArray(payload.results) || !Number.isFinite(payload.processingTimeMs)) {
        return { ok: false, reason: "malformed_response", message: "Rust Asset Opportunity response has invalid results or processingTimeMs" };
    }
    const expected = new Set(expectedIds);
    const results = new Map<string, RustAssetOpportunitySummaryCandidateResult>();
    for (const entry of payload.results) {
        if (!entry || typeof entry !== "object") {
            return { ok: false, reason: "malformed_response", message: "Rust Asset Opportunity result item is not an object" };
        }
        const item = entry as {
            id?: unknown;
            result?: unknown;
            selectionResult?: unknown;
            endpointAdjusted?: unknown;
            endpointRemovedTrades?: unknown;
        };
        if (typeof item.id !== "string" || item.id.length === 0) {
            return { ok: false, reason: "missing_result_id", message: "Rust Asset Opportunity result item has no string id" };
        }
        if (!expected.has(item.id)) {
            return { ok: false, reason: "unknown_result_id", message: `Rust Asset Opportunity returned unknown id ${item.id}` };
        }
        if (results.has(item.id)) {
            return { ok: false, reason: "duplicate_result_id", message: `Rust Asset Opportunity returned duplicate id ${item.id}` };
        }
        if (
            !isAssetOpportunityMetricSummary(item.result)
            || !isAssetOpportunityMetricSummary(item.selectionResult)
            || typeof item.endpointAdjusted !== "boolean"
            || !Number.isInteger(item.endpointRemovedTrades)
            || (item.endpointRemovedTrades as number) < 0
        ) {
            return { ok: false, reason: "inconsistent_result", message: `Rust Asset Opportunity returned no summary for ${item.id}` };
        }
        const endpointRemovedTrades = item.endpointRemovedTrades as number;
        results.set(item.id, {
            id: item.id,
            summary: {
                result: item.result,
                selectionResult: item.selectionResult,
                endpointAdjusted: item.endpointAdjusted,
                endpointRemovedTrades,
            },
        });
    }
    if (results.size !== expected.size) {
        const missing = expectedIds.find((id) => !results.has(id));
        return { ok: false, reason: "missing_result_id", message: `Rust Asset Opportunity omitted id ${missing ?? "unknown"}` };
    }
    return { ok: true, results, processingTimeMs: payload.processingTimeMs as number };
}

export function validateAssetOpportunityRustFreshBatchResponse(
    response: unknown,
    expectedIds: readonly string[],
): { ok: true; results: Map<string, RustAssetOpportunityFreshEntryCandidateResult>; processingTimeMs: number } | {
    ok: false;
    reason: Extract<AssetOpportunityRustBatchFailureReason, "malformed_response" | "missing_result_id" | "unknown_result_id" | "duplicate_result_id" | "inconsistent_result">;
    message: string;
} {
    if (!response || typeof response !== "object") {
        return { ok: false, reason: "malformed_response", message: "Rust fresh batch response is not an object" };
    }
    const payload = response as { results?: unknown; processingTimeMs?: unknown };
    if (!Array.isArray(payload.results) || !Number.isFinite(payload.processingTimeMs)) {
        return { ok: false, reason: "malformed_response", message: "Rust fresh batch response has invalid results or processingTimeMs" };
    }
    const expected = new Set(expectedIds);
    const results = new Map<string, RustAssetOpportunityFreshEntryCandidateResult>();
    for (const entry of payload.results) {
        if (!entry || typeof entry !== "object") {
            return { ok: false, reason: "malformed_response", message: "Rust fresh batch result item is not an object" };
        }
        const item = entry as { id?: unknown; result?: unknown };
        if (typeof item.id !== "string" || item.id.length === 0) {
            return { ok: false, reason: "missing_result_id", message: "Rust fresh batch result item has no string id" };
        }
        if (!expected.has(item.id)) {
            return { ok: false, reason: "unknown_result_id", message: `Rust fresh batch returned unknown id ${item.id}` };
        }
        if (results.has(item.id)) {
            return { ok: false, reason: "duplicate_result_id", message: `Rust fresh batch returned duplicate id ${item.id}` };
        }
        if (!item.result || typeof item.result !== "object") {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned no summary for ${item.id}` };
        }
        const summary = item.result as Record<string, unknown>;
        const totalTrades = summary.totalTrades;
        const isOpen = summary.isOpen;
        const latestTrade = summary.latestTrade;
        if (!Number.isInteger(totalTrades) || (totalTrades as number) < 0 || typeof isOpen !== "boolean") {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned invalid summary for ${item.id}` };
        }
        if (latestTrade !== null && (typeof latestTrade !== "object" || latestTrade === undefined)) {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned invalid latest trade for ${item.id}` };
        }
        if ((totalTrades as number) === 0 && latestTrade !== null) {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned a latest trade with zero trades for ${item.id}` };
        }
        if ((totalTrades as number) > 0 && (!latestTrade || typeof latestTrade !== "object")) {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch omitted latest trade for ${item.id}` };
        }
        if (latestTrade) {
            const trade = latestTrade as Record<string, unknown>;
            if (trade.type !== "long" && trade.type !== "short") {
                return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned invalid trade type for ${item.id}` };
            }
            if (!Number.isFinite(trade.entryPrice) || typeof trade.exitReason !== "string") {
                return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned invalid latest trade fields for ${item.id}` };
            }
            if (trade.entryTime === undefined || trade.entryTime === null) {
                return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch returned no entry time for ${item.id}` };
            }
        }
        if (isOpen && latestTrade === null) {
            return { ok: false, reason: "inconsistent_result", message: `Rust fresh batch marked ${item.id} open without a latest trade` };
        }
        results.set(item.id, {
            id: item.id,
            summary: summary as unknown as RustFreshEntrySummary,
        });
    }
    if (results.size !== expected.size) {
        const missing = expectedIds.find((id) => !results.has(id));
        return { ok: false, reason: "missing_result_id", message: `Rust fresh batch omitted id ${missing ?? "unknown"}` };
    }
    return { ok: true, results, processingTimeMs: payload.processingTimeMs as number };
}

function compactResult(result: BacktestResult): BacktestResult {
    return {
        ...result,
        trades: [],
        equityCurve: [],
    };
}

function materializeAssetOpportunityMetricSummary(
    summary: RustAssetOpportunityCandidateSummary["result"],
): BacktestResult {
    const profitFactor = summary.profitFactor === null
        ? (summary.winningTrades > 0 && summary.losingTrades === 0 ? Number.POSITIVE_INFINITY : 0)
        : summary.profitFactor;
    return {
        trades: [],
        equityCurve: [],
        netProfit: summary.netProfit,
        netProfitPercent: summary.netProfitPercent,
        winRate: summary.winRate,
        expectancy: summary.expectancy,
        avgTrade: summary.avgTrade,
        profitFactor,
        maxDrawdown: summary.maxDrawdown,
        maxDrawdownPercent: summary.maxDrawdownPercent,
        totalTrades: summary.totalTrades,
        winningTrades: summary.winningTrades,
        losingTrades: summary.losingTrades,
        avgWin: summary.avgWin,
        avgLoss: summary.avgLoss,
        sharpeRatio: summary.sharpeRatio,
    };
}

export function normalizeAssetOpportunityRustSummaryCandidateResult(
    summary: RustAssetOpportunityCandidateSummary,
): CompactAssetOpportunityCandidateResult {
    return {
        result: materializeAssetOpportunityMetricSummary(summary.result),
        selectionResult: materializeAssetOpportunityMetricSummary(summary.selectionResult),
        endpointAdjusted: summary.endpointAdjusted,
        endpointRemovedTrades: summary.endpointRemovedTrades,
    };
}

export function normalizeAssetOpportunityRustCandidateResult(
    result: BacktestResult,
    lastDataTime: BacktestResult["equityCurve"][number]["time"] | null,
    initialCapital: number,
): CompactAssetOpportunityCandidateResult {
    const selection = buildSelectionResult(result, lastDataTime, initialCapital);
    return {
        result: compactResult(result),
        selectionResult: compactResult(selection.result),
        endpointAdjusted: selection.adjusted,
        endpointRemovedTrades: selection.removedTrades,
    };
}

function mapTransportFailure(reason: RustBatchTransportFailureReason): AssetOpportunityRustBatchFailureReason {
    if (reason === "request_too_large") return "request_too_large";
    if (reason === "response_too_large") return "response_too_large";
    if (reason === "cancelled") return "cancelled";
    if (reason === "health_unavailable") return "health_unavailable";
    if (reason === "timeout") return "timeout";
    if (reason === "network_error") return "network_error";
    if (reason === "http_error") return "http_error";
    if (reason === "malformed_response") return "malformed_response";
    return "transport_failure";
}

export async function dispatchAssetOpportunityRustBatch(
    args: AssetOpportunityRustBatchDispatchInput,
): Promise<AssetOpportunityRustBatchDispatch> {
    const startedAt = performance.now();
    const partition = partitionAssetOpportunityRustBatchItems({
        ...args,
        ...(args.cacheId ? { cacheId: args.cacheId } : {}),
    });
    if (partition.tooLargeItemId) {
        return {
            status: "fallback",
            reason: "request_too_large",
            requests: 0,
            requestBytes: 0,
            latencyMs: performance.now() - startedAt,
            message: `Rust batch item ${partition.tooLargeItemId} exceeds the request budget`,
        };
    }

    const allResults = new Map<string, RustAssetOpportunityCandidateResult>();
    let requestBytes = 0;
    let requests = 0;
    for (const chunk of partition.chunks) {
        if (args.signal?.aborted) {
            return { status: "cancelled", reason: "cancelled", requests, requestBytes, latencyMs: performance.now() - startedAt };
        }
        const requestOptions = {
            signal: args.signal,
            maxRequestBytes: args.maxRequestBytes,
            maxResponseBytes: args.maxResponseBytes ?? DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
        };
        const useSummaryEndpoint = args.lastDataTime !== undefined
            && Boolean(args.client.runAssetOpportunityBatchBacktestWithStatus);
        let transport: RustBatchTransportResult = useSummaryEndpoint
            ? args.cacheId && args.client.runCachedAssetOpportunityBatchBacktestWithStatus
                ? await args.client.runCachedAssetOpportunityBatchBacktestWithStatus(
                    args.cacheId,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.lastDataTime ?? null,
                    args.sizing,
                    requestOptions,
                )
                : await args.client.runAssetOpportunityBatchBacktestWithStatus!(
                    args.data,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.lastDataTime ?? null,
                    args.sizing,
                    requestOptions,
                )
            : args.cacheId && args.client.runCachedBatchBacktestWithStatus
                ? await args.client.runCachedBatchBacktestWithStatus(
                    args.cacheId,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.sizing,
                    false,
                    requestOptions,
                )
                : await args.client.runBatchBacktestWithStatus(
                    args.data,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.sizing,
                    false,
                    requestOptions,
                );
        let requestsForChunk = 1;
        let requestBytesForChunk = transport.requestBytes ?? 0;
        // The Rust data cache is intentionally bounded and may evict an asset
        // while a large multi-asset run is still in flight. Recover that case
        // with the raw Rust endpoint instead of replaying every candidate in
        // TypeScript. Only retry HTTP failures: timeouts and network failures
        // should remain a single bounded attempt.
        if (!transport.ok && transport.reason === "http_error" && args.cacheId) {
            const rawTransport = useSummaryEndpoint
                ? await args.client.runAssetOpportunityBatchBacktestWithStatus!(
                    args.data,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.lastDataTime ?? null,
                    args.sizing,
                    requestOptions,
                )
                : await args.client.runBatchBacktestWithStatus(
                    args.data,
                    chunk,
                    args.initialCapital,
                    args.positionSizePercent,
                    args.commissionPercent,
                    args.baseSettings,
                    args.sizing,
                    false,
                    requestOptions,
                );
            transport = rawTransport;
            requestsForChunk += 1;
            requestBytesForChunk += rawTransport.requestBytes ?? 0;
        }
        requests += requestsForChunk;
        requestBytes += requestBytesForChunk;
        if (!transport.ok) {
            const reason = mapTransportFailure(transport.reason);
            return {
                status: reason === "cancelled" ? "cancelled" : "fallback",
                reason,
                requests,
                requestBytes,
                latencyMs: performance.now() - startedAt,
                ...(transport.message ? { message: transport.message } : {}),
            };
        }
        if (useSummaryEndpoint) {
            const validated = validateAssetOpportunityRustSummaryBatchResponse(transport.response, chunk.map((item) => item.id));
            if (!validated.ok) {
                return {
                    status: "fallback",
                    reason: validated.reason,
                    requests,
                    requestBytes,
                    latencyMs: performance.now() - startedAt,
                    message: validated.message,
                };
            }
            for (const [id, result] of validated.results) {
                const normalized = normalizeAssetOpportunityRustSummaryCandidateResult(result.summary);
                allResults.set(id, {
                    id,
                    result: normalized.result,
                    selectionResult: normalized.selectionResult,
                    endpointAdjusted: normalized.endpointAdjusted,
                    endpointRemovedTrades: normalized.endpointRemovedTrades,
                });
            }
        } else {
            const validated = validateAssetOpportunityRustBatchResponse(transport.response, chunk.map((item) => item.id));
            if (!validated.ok) {
                return {
                    status: "fallback",
                    reason: validated.reason,
                    requests,
                    requestBytes,
                    latencyMs: performance.now() - startedAt,
                    message: validated.message,
                };
            }
            for (const [id, result] of validated.results) allResults.set(id, result);
        }
    }
    return {
        status: "completed",
        results: allResults,
        requests,
        requestBytes,
        latencyMs: performance.now() - startedAt,
    };
}

export async function dispatchAssetOpportunityRustFreshEntryBatch(
    args: AssetOpportunityRustFreshBatchDispatchInput,
): Promise<AssetOpportunityRustFreshBatchDispatch> {
    const startedAt = performance.now();
    const partition = partitionAssetOpportunityRustBatchItems({
        ...args,
        ...(args.cacheId ? { cacheId: args.cacheId } : {}),
    });
    if (partition.tooLargeItemId) {
        return {
            status: "fallback",
            reason: "request_too_large",
            requests: 0,
            requestBytes: 0,
            latencyMs: performance.now() - startedAt,
            message: `Rust fresh batch item ${partition.tooLargeItemId} exceeds the request budget`,
        };
    }

    const allResults = new Map<string, RustAssetOpportunityFreshEntryCandidateResult>();
    let requestBytes = 0;
    let requests = 0;
    for (const chunk of partition.chunks) {
        if (args.signal?.aborted) {
            return { status: "cancelled", reason: "cancelled", requests, requestBytes, latencyMs: performance.now() - startedAt };
        }
        const requestOptions = {
            signal: args.signal,
            maxRequestBytes: args.maxRequestBytes,
            maxResponseBytes: args.maxResponseBytes ?? DEFAULT_ASSET_OPPORTUNITY_RUST_BATCH_MAX_RESPONSE_BYTES,
        };
        let transport: RustBatchTransportResult = args.cacheId && args.client.runCachedFreshEntryBatchBacktestWithStatus
            ? await args.client.runCachedFreshEntryBatchBacktestWithStatus(
                args.cacheId,
                chunk,
                args.initialCapital,
                args.positionSizePercent,
                args.commissionPercent,
                args.baseSettings,
                args.sizing,
                requestOptions,
            )
            : await args.client.runFreshEntryBatchBacktestWithStatus(
                args.data,
                chunk,
                args.initialCapital,
                args.positionSizePercent,
                args.commissionPercent,
                args.baseSettings,
                args.sizing,
                requestOptions,
            );
        let requestsForChunk = 1;
        let requestBytesForChunk = transport.requestBytes ?? 0;
        if (!transport.ok && transport.reason === "http_error" && args.cacheId) {
            const rawTransport = await args.client.runFreshEntryBatchBacktestWithStatus(
                args.data,
                chunk,
                args.initialCapital,
                args.positionSizePercent,
                args.commissionPercent,
                args.baseSettings,
                args.sizing,
                requestOptions,
            );
            transport = rawTransport;
            requestsForChunk += 1;
            requestBytesForChunk += rawTransport.requestBytes ?? 0;
        }
        requests += requestsForChunk;
        requestBytes += requestBytesForChunk;
        if (!transport.ok) {
            const reason = mapTransportFailure(transport.reason);
            return {
                status: reason === "cancelled" ? "cancelled" : "fallback",
                reason,
                requests,
                requestBytes,
                latencyMs: performance.now() - startedAt,
                ...(transport.message ? { message: transport.message } : {}),
            };
        }
        const validated = validateAssetOpportunityRustFreshBatchResponse(
            transport.response,
            chunk.map((item) => item.id),
        );
        if (!validated.ok) {
            return {
                status: "fallback",
                reason: validated.reason,
                requests,
                requestBytes,
                latencyMs: performance.now() - startedAt,
                message: validated.message,
            };
        }
        for (const [id, result] of validated.results) allResults.set(id, result);
    }
    return {
        status: "completed",
        results: allResults,
        requests,
        requestBytes,
        latencyMs: performance.now() - startedAt,
    };
}
