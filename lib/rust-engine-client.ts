/**
 * Rust Trading Engine Client
 *
 * Provides interface to the high-performance Rust backend for:
 * - Backtesting through the optional Rust service
 *
 * Falls back to TypeScript implementation when Rust server is unavailable.
 */

import { OHLCVData, Signal, BacktestResult, BacktestSettings, Time } from './types/strategies';
import { debugLogger } from './debug-logger';
import { isRustSupportedTradeSizingMode, type AdvancedSizingSettings, type TradeSizingMode } from './types/backtest';
import { validateRustBacktestResult } from './rust-backtest-result-validator';

export type RustBatchRequestOptions = {
    signal?: AbortSignal;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    /** Test/diagnostic override; production callers use the 120s default. */
    timeoutMs?: number;
    /** A caller that already serialized this exact request can reuse it. */
    preparedRequest?: PreparedRustRequest;
    /** Internal benchmark label; never serialized into the Rust request body. */
    rustDiagnosticPhase?: RustDiagnosticPhase;
    /** Preserve the TypeScript compact-engine option when drawdown is unused. */
    skipDrawdown?: boolean;
    /** Preserve the TypeScript compact-engine option when Sharpe is unused. */
    skipSharpeRatio?: boolean;
};

export type RustDiagnosticPhase =
    | "is_candidate"
    | "fresh_entry"
    | "winner_analytics"
    | "next_exit"
    | "complementary_oos"
    | "cache_bootstrap";

export type RustCapabilities = ReadonlySet<string> | readonly string[];
export const RUST_PROTOCOL_VERSION = 2;

export interface PreparedRustRequest {
    body: string;
    requestBytes: number;
}

export type RustOutputOptions = {
    compact?: boolean;
    retainTrades?: boolean;
    skipDrawdown?: boolean;
    skipSharpeRatio?: boolean;
};

export type RustBatchTransportFailureReason =
    | 'health_unavailable'
    | 'unsupported_sizing'
    | 'unsupported_signal_shape'
    | 'request_too_large'
    | 'response_too_large'
    | 'http_error'
    | 'timeout'
    | 'cancelled'
    | 'network_error'
    | 'malformed_response';

export type RustBatchTransportResult =
    | {
        ok: true;
        response: unknown;
        requestBytes: number;
        responseBytes?: number;
        elapsedMs: number;
    }
    | {
        ok: false;
        reason: RustBatchTransportFailureReason;
        requestBytes?: number;
        responseBytes?: number;
        message?: string;
    };

function rejectUnsupportedRustBatchSignals(
    items: readonly { signals: readonly Signal[] }[],
    signal?: AbortSignal,
): RustBatchTransportResult | null {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    return items.some((item) => hasUnsupportedRustSignalShape(item.signals))
        ? {
            ok: false,
            reason: 'unsupported_signal_shape',
            message: 'Rust batches cannot represent behavior-bearing signal fields',
        }
        : null;
}

export type RustBacktestFailureReason =
    | 'health_unavailable'
    | 'unsupported_sizing'
    | 'http_error'
    | 'timeout'
    | 'network_error'
    | 'malformed_response'
    | 'cancelled'
    | 'unsupported_signal_shape'
    | 'inconsistent_result';

export type RustBacktestTransportResult =
    | { ok: true; result: BacktestResult; processingTimeMs?: number }
    | { ok: false; reason: RustBacktestFailureReason; message?: string };

export interface RustFreshEntryTradeSummary {
    type: 'long' | 'short';
    entryTime: Time;
    entryPrice: number;
    exitReason: string;
}

export interface RustFreshEntrySummary {
    totalTrades: number;
    latestTrade: RustFreshEntryTradeSummary | null;
    isOpen: boolean;
}

export interface RustFreshEntryBatchResponse {
    results: Array<{ id: string; result: RustFreshEntrySummary }>;
    processingTimeMs: number;
}

export interface RustAssetOpportunityMetricSummary {
    netProfit: number;
    netProfitPercent: number;
    winRate: number;
    expectancy: number;
    avgTrade: number;
    profitFactor: number | null;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
}

export interface RustAssetOpportunityCandidateSummary {
    result: RustAssetOpportunityMetricSummary;
    selectionResult: RustAssetOpportunityMetricSummary;
    endpointAdjusted: boolean;
    endpointRemovedTrades: number;
}

export interface RustAssetOpportunityBatchResponse {
    results: Array<{
        id: string;
        result: RustAssetOpportunityMetricSummary;
        selectionResult: RustAssetOpportunityMetricSummary;
        endpointAdjusted: boolean;
        endpointRemovedTrades: number;
    }>;
    processingTimeMs: number;
}

export interface RustMultiAssetBatchWorkload {
    id: string;
    data?: OHLCVData[];
    packedData?: number[];
    items: Array<{
        id: string;
        signals: Signal[];
        packedSignals?: number[];
        settings?: BacktestSettings;
    }>;
    lastDataTime?: Time | null;
    cacheId?: string;
    dataStartIndex?: number;
    dataEndIndex?: number;
}

type RustFetch = typeof fetch;

export function prepareRustRequest(request: unknown): PreparedRustRequest {
    const body = JSON.stringify(request);
    if (typeof body !== 'string') {
        throw new Error('Rust request could not be serialized');
    }
    return {
        body,
        requestBytes: new TextEncoder().encode(body).byteLength,
    };
}

function packMultiAssetData(data: OHLCVData[]): number[] | null {
    const packed: number[] = [];
    for (const bar of data) {
        const time = typeof bar.time === 'number' ? bar.time : Number(bar.time);
        if (!Number.isFinite(time)) return null;
        packed.push(time, bar.open, bar.high, bar.low, bar.close, bar.volume);
    }
    return packed;
}

/** Compact signal rows: time, direction (0=buy/1=sell), price, bar index (-1 when absent). */
export function packMultiAssetSignals(signals: Signal[]): number[] | null {
    const packed: number[] = [];
    for (const signal of signals) {
        const time = typeof signal.time === 'number' ? signal.time : Number(signal.time);
        const barIndex = signal.barIndex === undefined ? -1 : signal.barIndex;
        // These fields have semantics that the Rust contract does not carry;
        // leave such signals in the lossless object form.
        if (
            !Number.isFinite(time)
            || !Number.isFinite(signal.price)
            || (signal.type !== 'buy' && signal.type !== 'sell')
            || !Number.isInteger(barIndex)
            || signal.triggerPrice !== undefined
            || signal.sizeFraction !== undefined
            || signal.exitOnly === true
            || isBehaviorBearingRustSignalReason(signal.reason)
        ) return null;
        packed.push(time, signal.type === 'buy' ? 0 : 1, signal.price, barIndex);
    }
    return packed;
}

export function compactMultiAssetWorkload(workload: RustMultiAssetBatchWorkload): RustMultiAssetBatchWorkload {
    const compactItems = workload.items.map((item) => {
        if (item.packedSignals !== undefined) return item;
        const packedSignals = packMultiAssetSignals(item.signals);
        if (!packedSignals) return item;
        const { signals: _signals, ...withoutSignals } = item;
        return { ...withoutSignals, signals: [], packedSignals };
    });
    const withCompactItems = { ...workload, items: compactItems };
    if (!workload.data) return withCompactItems;
    const packedData = packMultiAssetData(workload.data);
    if (!packedData) return withCompactItems;
    const { data: _data, ...withoutData } = withCompactItems;
    return { ...withoutData, packedData };
}

type BoundedResponseText =
    | { ok: true; text: string; bytes: number }
    | { ok: false; bytes: number };

async function readResponseTextWithinLimit(response: Response, maxResponseBytes?: number): Promise<BoundedResponseText> {
    if (maxResponseBytes === undefined || !response.body) {
        const text = await response.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        return maxResponseBytes !== undefined && bytes > maxResponseBytes
            ? { ok: false, bytes }
            : { ok: true, text, bytes };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            totalBytes += value.byteLength;
            if (totalBytes > maxResponseBytes) {
                await reader.cancel();
                return { ok: false, bytes: totalBytes };
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(bytes), bytes: totalBytes };
}

const rustLog = {
    info: (message: string, ...data: unknown[]) => debugLogger.info(message, data.length <= 1 ? data[0] : data),
    warn: (message: string, ...data: unknown[]) => debugLogger.warn(message, data.length <= 1 ? data[0] : data),
    error: (message: string, ...data: unknown[]) => debugLogger.error(message, data.length <= 1 ? data[0] : data),
};

// ============================================================================
// Types
// ============================================================================

export type RustBuildProfile = 'debug' | 'release';

interface RustHealthResponse {
    status: string;
    version?: string;
    engine: string;
    protocolVersion?: number;
    buildProfile?: RustBuildProfile;
    capabilities?: Record<string, boolean> | string[];
}

export function hasUnsupportedRustSignalShape(signals: readonly Signal[]): boolean {
    return signals.some((signal) => signal.triggerPrice !== undefined
        || signal.sizeFraction !== undefined
        || signal.exitOnly === true
        || isBehaviorBearingRustSignalReason(signal.reason));
}

/** Reasons whose meaning is not represented by the Rust signal contract. */
export function isBehaviorBearingRustSignalReason(reason: unknown): boolean {
    return reason === "polymarket_take_profit" || reason === "polymarket_stop_loss";
}

function parseRustCapabilities(value: unknown, protocolVersion: unknown): Set<string> {
    if (protocolVersion !== RUST_PROTOCOL_VERSION) return new Set();
    if (Array.isArray(value)) {
        return new Set(value.filter((capability): capability is string => typeof capability === 'string'));
    }
    if (!value || typeof value !== 'object') return new Set();
    return new Set(Object.entries(value as Record<string, unknown>)
        .filter(([, supported]) => supported === true)
        .map(([capability]) => capability));
}

interface RustBacktestRequest {
    data: OHLCVData[];
    signals: Signal[];
    initialCapital: number;
    positionSizePercent: number;
    commissionPercent: number;
    settings: BacktestSettings;
    sizing?: {
        mode: TradeSizingMode;
        fixedTradeAmount: number;
        advancedSizing?: AdvancedSizingSettings;
    };
    compact?: boolean;
    retainTrades?: boolean;
    skipDrawdown?: boolean;
    skipSharpeRatio?: boolean;
}

// ============================================================================
// Rust Engine Client
// ============================================================================

const DEFAULT_RUST_ENGINE_URL = 'http://127.0.0.1:3030';

function resolveDefaultRustEngineUrl(): string {
    const configured = typeof process !== 'undefined' ? process.env.RUST_ENGINE_URL?.trim() : undefined;
    return configured ? configured.replace(/\/+$/, '') : DEFAULT_RUST_ENGINE_URL;
}

export class RustEngineClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: RustFetch;
    private isAvailable: boolean = false;
    private engineVersion: string | null = null;
    private engineProtocolVersion: number | null = null;
    private engineBuildProfile: RustBuildProfile | null = null;
    private engineCapabilities = new Set<string>();
    private lastHealthCheck: number = 0;
    private readonly healthCheckInterval = 30000; // 30 seconds
    private readonly healthCheckFailureBackoff = 5000; // 5 seconds negative cache
    private lastHealthCheckFailed: boolean = false;
    private healthCheckInFlight?: Promise<boolean>;
    private lastHealthFailureReason: string | null = null;
    private lastHealthLatencyMs: number | null = null;
    private readonly backtestTimeoutMs = 30_000;
    private readonly batchBacktestTimeoutMs = 120_000;
    private readonly cacheTimeoutMs = 180_000;

    // Data caching for large datasets
    private readonly maxCachedDataEntries = 4;
    private readonly cachedDataIdsByHash = new Map<string, string>();

    constructor(baseUrl: string = resolveDefaultRustEngineUrl(), fetchImpl: RustFetch = fetch) {
        this.baseUrl = baseUrl;
        this.fetchImpl = fetchImpl;
    }

    /**
     * Generate a simple hash for OHLCV data to detect changes
     */
    private generateDataHash(data: OHLCVData[]): string {
        if (data.length === 0) return 'empty';
        let hashA = 0x811c9dc5;
        let hashB = 0x01000193;

        for (let i = 0; i < data.length; i++) {
            hashA = this.hashBar(hashA, data[i], i);
            hashB = this.hashBar(hashB, data[i], i);
        }

        const lastIndex = data.length - 1;
        const firstTime = this.normalizeTimeForHash(data[0].time);
        const lastTime = this.normalizeTimeForHash(data[lastIndex].time);
        return `${data.length}-${firstTime}-${lastTime}-${hashA.toString(16)}-${hashB.toString(16)}`;
    }

    /** Stable local key for callers that share the server-side data cache. */
    getDataCacheKey(data: OHLCVData[]): string {
        return this.generateDataHash(data);
    }

    private hashBar(hash: number, bar: OHLCVData, index: number): number {
        let next = hash;
        next = this.mixHash(next, index);
        next = this.mixHash(next, this.normalizeTimeForHash(bar.time));
        next = this.mixHash(next, bar.open);
        next = this.mixHash(next, bar.high);
        next = this.mixHash(next, bar.low);
        next = this.mixHash(next, bar.close);
        next = this.mixHash(next, bar.volume);
        return next;
    }

    private normalizeTimeForHash(time: OHLCVData['time']): number {
        if (typeof time === 'number' && Number.isFinite(time)) {
            return Math.round(time);
        }
        if (typeof time === 'string') {
            let hash = 0;
            for (let i = 0; i < time.length; i++) {
                hash = ((hash * 31) + time.charCodeAt(i)) >>> 0;
            }
            return hash;
        }
        if (time && typeof time === 'object') {
            const businessDay = time as { year?: number; month?: number; day?: number };
            const year = Number.isFinite(businessDay.year) ? Number(businessDay.year) : 0;
            const month = Number.isFinite(businessDay.month) ? Number(businessDay.month) : 0;
            const day = Number.isFinite(businessDay.day) ? Number(businessDay.day) : 0;
            return (year * 10000) + (month * 100) + day;
        }
        return 0;
    }

    private mixHash(hash: number, value: number): number {
        const normalized = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
        const mixed = hash ^ (normalized + 0x9e3779b9 + ((hash << 6) >>> 0) + (hash >>> 2));
        return mixed >>> 0;
    }

    private getCachedDataId(dataHash: string): string | null {
        const cacheId = this.cachedDataIdsByHash.get(dataHash);
        if (!cacheId) return null;
        this.cachedDataIdsByHash.delete(dataHash);
        this.cachedDataIdsByHash.set(dataHash, cacheId);
        return cacheId;
    }

    private rememberCachedDataId(dataHash: string, cacheId: string): void {
        this.cachedDataIdsByHash.delete(dataHash);
        this.cachedDataIdsByHash.set(dataHash, cacheId);
        while (this.cachedDataIdsByHash.size > this.maxCachedDataEntries) {
            const oldestHash = this.cachedDataIdsByHash.keys().next().value;
            if (oldestHash === undefined) break;
            this.cachedDataIdsByHash.delete(oldestHash);
        }
    }

    private forgetCachedDataId(cacheId: string): void {
        for (const [dataHash, cachedId] of this.cachedDataIdsByHash) {
            if (cachedId === cacheId) {
                this.cachedDataIdsByHash.delete(dataHash);
                return;
            }
        }
    }

    /** Drop a server cache id after a cached request reports that it is gone. */
    invalidateCachedDataId(cacheId: string): void {
        this.forgetCachedDataId(cacheId);
    }

    // ========================================================================
    // Connection Management
    // ========================================================================

    /**
     * Check if the Rust server is available
     */
    async checkHealth(signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return false;
        const now = Date.now();

        // Use cached positive result if recent
        if (now - this.lastHealthCheck < this.healthCheckInterval && this.isAvailable) {
            return true;
        }

        // Use cached negative result for shorter backoff (avoid repeated timeouts while down)
        if (now - this.lastHealthCheck < this.healthCheckFailureBackoff && this.lastHealthCheckFailed) {
            return false;
        }

        // A caller-owned signal must not be shared with other callers. An
        // uncancellable probe, however, is safe to share during cold-start
        // bursts such as Finder cache/bootstrap setup.
        if (signal) return this.performHealthCheck(signal);
        if (this.healthCheckInFlight) return this.healthCheckInFlight;
        const probe = this.performHealthCheck();
        this.healthCheckInFlight = probe;
        try {
            return await probe;
        } finally {
            if (this.healthCheckInFlight === probe) this.healthCheckInFlight = undefined;
        }
    }

    private async performHealthCheck(signal?: AbortSignal): Promise<boolean> {
        const startedAt = performance.now();
        try {
            const healthTimeoutSignal = AbortSignal.timeout(2000);
            const healthSignal = signal
                ? AbortSignal.any([signal, healthTimeoutSignal])
                : healthTimeoutSignal;
            const response = await this.fetchImpl(`${this.baseUrl}/api/health`, {
                method: 'GET',
                signal: healthSignal,
            });

            if (response.ok) {
                const data = await response.json() as Partial<RustHealthResponse>;
                this.isAvailable = data.status === 'healthy' && data.engine === 'trading-engine-rust';
                this.engineVersion = typeof data.version === 'string' ? data.version : null;
                this.engineProtocolVersion = typeof data.protocolVersion === 'number' ? data.protocolVersion : null;
                this.engineBuildProfile = data.buildProfile === 'debug' || data.buildProfile === 'release'
                    ? data.buildProfile
                    : null;
                this.engineCapabilities = this.isAvailable
                    ? parseRustCapabilities(data.capabilities, data.protocolVersion)
                    : new Set();
                this.lastHealthCheckFailed = !this.isAvailable;
                this.lastHealthCheck = Date.now();
                this.lastHealthLatencyMs = performance.now() - startedAt;
                this.lastHealthFailureReason = this.isAvailable
                    ? null
                    : data.status !== 'healthy'
                        ? `invalid_status:${String(data.status)}`
                        : `invalid_engine:${String(data.engine)}`;
                if (this.isAvailable) {
                    rustLog.info(`[RustEngine] Connected: v${this.engineVersion ?? 'unknown'} (${this.lastHealthLatencyMs.toFixed(1)}ms)`);
                } else {
                    rustLog.warn(`[RustEngine] Health check rejected (${this.lastHealthFailureReason}), using TypeScript fallback`);
                }
                return this.isAvailable;
            }
            this.isAvailable = false;
            this.engineVersion = null;
            this.engineProtocolVersion = null;
            this.engineBuildProfile = null;
            this.engineCapabilities = new Set();
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = Date.now();
            this.lastHealthLatencyMs = performance.now() - startedAt;
            this.lastHealthFailureReason = `http_status:${response.status}`;
        } catch (error) {
            if (signal?.aborted) return false;
            this.isAvailable = false;
            this.engineVersion = null;
            this.engineProtocolVersion = null;
            this.engineBuildProfile = null;
            this.engineCapabilities = new Set();
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = Date.now();
            this.lastHealthLatencyMs = performance.now() - startedAt;
            this.lastHealthFailureReason = error instanceof Error ? error.name : 'unknown_error';
            rustLog.warn(`[RustEngine] Server not available (${this.lastHealthFailureReason}), using TypeScript fallback`);
        }

        return false;
    }

    /**
     * Get whether Rust engine is currently available
     */
    get available(): boolean {
        return this.isAvailable;
    }

    get version(): string | null {
        return this.engineVersion;
    }

    get protocolVersion(): number | null {
        return this.engineProtocolVersion;
    }

    get buildProfile(): RustBuildProfile | null {
        return this.engineBuildProfile;
    }

    get capabilities(): ReadonlySet<string> {
        return this.engineCapabilities;
    }

    supportsCapabilities(required: readonly string[]): boolean {
        return required.every((capability) => this.engineCapabilities.has(capability));
    }

    get healthDiagnostics(): { latencyMs: number | null; failureReason: string | null } {
        return {
            latencyMs: this.lastHealthLatencyMs,
            failureReason: this.lastHealthFailureReason,
        };
    }

    // ========================================================================
    // Backtest API
    // ========================================================================

    /**
     * Run backtest on Rust engine
     */
    async runBacktestWithStatus(
        data: OHLCVData[],
        signals: Signal[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        outputOptions?: RustOutputOptions,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBacktestTransportResult> {
        if (requestOptions?.signal?.aborted) return { ok: false, reason: 'cancelled' };
        if (hasUnsupportedRustSignalShape(signals)) {
            return { ok: false, reason: 'unsupported_signal_shape' };
        }
        if (!await this.checkHealth(requestOptions?.signal)) {
            if (requestOptions?.signal?.aborted) return { ok: false, reason: 'cancelled' };
            return { ok: false, reason: 'health_unavailable' };
        }
        if (sizing && !isRustSupportedTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust backend, using TypeScript fallback`);
            return { ok: false, reason: 'unsupported_sizing' };
        }

        try {
            const request: RustBacktestRequest = {
                data,
                signals,
                initialCapital,
                positionSizePercent,
                commissionPercent,
                settings,
                sizing,
                compact: outputOptions?.compact ?? false,
                retainTrades: outputOptions?.retainTrades ?? false,
                ...(outputOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
                ...(outputOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
            };

            const startTime = performance.now();

            const timeoutSignal = AbortSignal.timeout(this.backtestTimeoutMs);
            const requestSignal = requestOptions?.signal
                ? AbortSignal.any([requestOptions.signal, timeoutSignal])
                : timeoutSignal;
            const response = await this.fetchImpl(`${this.baseUrl}/api/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: requestSignal,
            });

            if (requestOptions?.signal?.aborted) return { ok: false, reason: 'cancelled' };

            if (!response.ok) {
                rustLog.error('[RustEngine] Backtest failed:', response.statusText);
                return { ok: false, reason: 'http_error', message: response.statusText };
            }

            const responseJson = await response.json();
            if (requestOptions?.signal?.aborted) return { ok: false, reason: 'cancelled' };
            const validation = validateRustBacktestResult(responseJson, {
                // Protocol v2 makes exitReason part of the generic trade
                // contract. Older healthy services remain usable only for
                // legacy signal_close requests, which do not require the
                // newly capability-gated execution semantics.
                requireExitReason: this.engineProtocolVersion === RUST_PROTOCOL_VERSION,
            });
            if (!validation.ok) {
                rustLog.error('[RustEngine] Backtest returned malformed output:', validation.message);
                return { ok: false, reason: 'malformed_response', message: validation.message };
            }
            const result = validation.result;
            const elapsed = performance.now() - startTime;
            const processingTimeMs = responseJson && typeof responseJson === 'object'
                ? (responseJson as { processingTimeMs?: unknown }).processingTimeMs
                : undefined;

            rustLog.info(`[RustEngine] Backtest completed in ${elapsed.toFixed(2)}ms (Rust: ${String(processingTimeMs ?? 'unknown')}ms, ${data.length} bars)`);

            return {
                ok: true,
                result,
                ...(typeof processingTimeMs === 'number' && Number.isFinite(processingTimeMs)
                    ? { processingTimeMs }
                    : {}),
            };
        } catch (error) {
            rustLog.error('[RustEngine] Backtest error:', error);
            return {
                ok: false,
                reason: requestOptions?.signal?.aborted
                    || (error instanceof DOMException && error.name === 'AbortError')
                    ? 'cancelled'
                    : error instanceof DOMException && error.name === 'TimeoutError'
                        ? 'timeout'
                        : 'network_error',
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async runBacktest(
        data: OHLCVData[],
        signals: Signal[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        outputOptions?: RustOutputOptions,
    ): Promise<BacktestResult | null> {
        const outcome = await this.runBacktestWithStatus(
            data,
            signals,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            settings,
            sizing,
            outputOptions,
        );
        return outcome.ok ? outcome.result : null;
    }

    /**
     * Run batch backtests on Rust engine - all backtests run in parallel.
     * The batch contract reduces repeated request/data overhead and lets the
     * Rust service schedule the items with Rayon; end-to-end performance still
     * depends on signal generation, serialization, transport, and validation.
     */
    async runBatchBacktest(
        data: OHLCVData[],
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        const outcome = await this.runBatchBacktestWithStatus(
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
            requestOptions,
        );
        return outcome.ok ? outcome.response as { results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } : null;
    }

    /**
     * Run a batch request while preserving the failure reason needed by the
     * Asset Opportunity TypeScript fallback. Existing callers should keep using
     * `runBatchBacktest`; this status surface is intentionally opt-in.
     */
    async runBatchBacktestWithStatus(
        data: OHLCVData[],
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
            ...(requestOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
            ...(requestOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
        };
        return this.runBatchRequestWithStatus(
            '/api/backtest/batch',
            request,
            items.length,
            sizing,
            requestOptions,
        );
    }

    async runCachedBatchBacktest(
        cacheId: string,
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<{ results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } | null> {
        const outcome = await this.runCachedBatchBacktestWithStatus(
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
            requestOptions,
        );
        return outcome.ok ? outcome.response as { results: Array<{ id: string; result: BacktestResult }>; processingTimeMs: number } : null;
    }

    async runCachedBatchBacktestWithStatus(
        cacheId: string,
        items: Array<{
            id: string;
            signals: Signal[];
            settings?: BacktestSettings;
        }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        compact: boolean = true,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
            ...(requestOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
            ...(requestOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
        };
        const outcome = await this.runBatchRequestWithStatus(
            '/api/backtest/batch/cached',
            request,
            items.length,
            sizing,
            requestOptions,
        );
        if (!outcome.ok && outcome.reason === 'http_error') {
            this.forgetCachedDataId(cacheId);
        }
        return outcome;
    }

    async runFreshEntryBatchBacktest(
        data: OHLCVData[],
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustFreshEntryBatchResponse | null> {
        const outcome = await this.runFreshEntryBatchBacktestWithStatus(
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            requestOptions,
        );
        return outcome.ok ? outcome.response as RustFreshEntryBatchResponse : null;
    }

    async runFreshEntryBatchBacktestWithStatus(
        data: OHLCVData[],
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
        };
        return this.runBatchRequestWithStatus(
            '/api/backtest/fresh-entry/batch',
            request,
            items.length,
            sizing,
            requestOptions,
        );
    }

    async runCachedFreshEntryBatchBacktest(
        cacheId: string,
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustFreshEntryBatchResponse | null> {
        const outcome = await this.runCachedFreshEntryBatchBacktestWithStatus(
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            requestOptions,
        );
        return outcome.ok ? outcome.response as RustFreshEntryBatchResponse : null;
    }

    async runCachedFreshEntryBatchBacktestWithStatus(
        cacheId: string,
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
        };
        return this.runBatchRequestWithStatus(
            '/api/backtest/fresh-entry/batch/cached',
            request,
            items.length,
            sizing,
            requestOptions,
        );
    }

    async runAssetOpportunityBatchBacktest(
        data: OHLCVData[],
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        lastDataTime: Time | null,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustAssetOpportunityBatchResponse | null> {
        const outcome = await this.runAssetOpportunityBatchBacktestWithStatus(
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            lastDataTime,
            sizing,
            requestOptions,
        );
        return outcome.ok ? outcome.response as RustAssetOpportunityBatchResponse : null;
    }

    async runAssetOpportunityBatchBacktestWithStatus(
        data: OHLCVData[],
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        lastDataTime: Time | null,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            lastDataTime,
            ...(requestOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
            ...(requestOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
        };
        return this.runBatchRequestWithStatus(
            '/api/backtest/asset-opportunity/batch',
            request,
            items.length,
            sizing,
            requestOptions,
        );
    }

    async runCachedAssetOpportunityBatchBacktest(
        cacheId: string,
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        lastDataTime: Time | null,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustAssetOpportunityBatchResponse | null> {
        const outcome = await this.runCachedAssetOpportunityBatchBacktestWithStatus(
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            lastDataTime,
            sizing,
            requestOptions,
        );
        return outcome.ok ? outcome.response as RustAssetOpportunityBatchResponse : null;
    }

    async runCachedAssetOpportunityBatchBacktestWithStatus(
        cacheId: string,
        items: Array<{ id: string; signals: Signal[]; settings?: BacktestSettings }>,
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        lastDataTime: Time | null,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(items, requestOptions?.signal);
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            lastDataTime,
            ...(requestOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
            ...(requestOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
        };
        const outcome = await this.runBatchRequestWithStatus(
            '/api/backtest/asset-opportunity/batch/cached',
            request,
            items.length,
            sizing,
            requestOptions,
        );
        if (!outcome.ok && outcome.reason === 'http_error') {
            this.forgetCachedDataId(cacheId);
        }
        return outcome;
    }

    async runMultiAssetAssetOpportunityBatchBacktestWithStatus(
        workloads: RustMultiAssetBatchWorkload[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(
            workloads.flatMap((workload) => workload.items),
            requestOptions?.signal,
        );
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            workloads: workloads.map(compactMultiAssetWorkload),
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            ...(requestOptions?.skipDrawdown === true ? { skipDrawdown: true } : {}),
            ...(requestOptions?.skipSharpeRatio === true ? { skipSharpeRatio: true } : {}),
        };
        const itemCount = workloads.reduce((total, workload) => total + workload.items.length, 0);
        return this.runBatchRequestWithStatus(
            '/api/backtest/asset-opportunity/multi-batch',
            request,
            itemCount,
            sizing,
            requestOptions,
        );
    }

    async runMultiAssetFreshEntryBatchBacktestWithStatus(
        workloads: RustMultiAssetBatchWorkload[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        baseSettings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings },
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        const unsupportedSignals = rejectUnsupportedRustBatchSignals(
            workloads.flatMap((workload) => workload.items),
            requestOptions?.signal,
        );
        if (unsupportedSignals) return unsupportedSignals;
        const request = {
            workloads: workloads.map(compactMultiAssetWorkload),
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
        };
        const itemCount = workloads.reduce((total, workload) => total + workload.items.length, 0);
        return this.runBatchRequestWithStatus(
            '/api/backtest/fresh-entry/multi-batch',
            request,
            itemCount,
            sizing,
            requestOptions,
        );
    }

    private async runBatchRequestWithStatus(
        endpoint: string,
        request: unknown,
        itemCount: number,
        sizing: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings } | undefined,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        if (requestOptions?.signal?.aborted) {
            return { ok: false, reason: 'cancelled' };
        }
        if (!await this.checkHealth(requestOptions?.signal)) {
            if (requestOptions?.signal?.aborted) {
                return { ok: false, reason: 'cancelled' };
            }
            return { ok: false, reason: 'health_unavailable' };
        }
        if (sizing && !isRustSupportedTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust batch backtests, using TypeScript fallback`);
            return { ok: false, reason: 'unsupported_sizing' };
        }

        let preparedRequest: PreparedRustRequest;
        try {
            preparedRequest = requestOptions?.preparedRequest ?? prepareRustRequest(request);
        } catch (error) {
            return {
                ok: false,
                reason: 'malformed_response',
                message: error instanceof Error ? error.message : String(error),
            };
        }
        const body = preparedRequest.body;
        const requestBytes = preparedRequest.requestBytes;
        if (requestOptions?.maxRequestBytes !== undefined && requestBytes > requestOptions.maxRequestBytes) {
            return { ok: false, reason: 'request_too_large', requestBytes };
        }
        const maxResponseBytes = requestOptions?.maxResponseBytes;

        const startTime = performance.now();
        const timeoutSignal = AbortSignal.timeout(requestOptions?.timeoutMs ?? this.batchBacktestTimeoutMs);
        const requestSignal = requestOptions?.signal
            ? AbortSignal.any([requestOptions.signal, timeoutSignal])
            : timeoutSignal;
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: requestSignal,
            });

            if (requestOptions?.signal?.aborted) {
                return { ok: false, reason: 'cancelled', requestBytes };
            }

            if (!response.ok) {
                rustLog.error('[RustEngine] Batch backtest failed:', response.statusText);
                return { ok: false, reason: 'http_error', requestBytes, message: response.statusText };
            }

            const declaredResponseBytes = Number(response.headers.get('content-length'));
            if (
                maxResponseBytes !== undefined
                && Number.isFinite(declaredResponseBytes)
                && declaredResponseBytes > maxResponseBytes
            ) {
                return { ok: false, reason: 'response_too_large', requestBytes };
            }
            const responseTextResult = await readResponseTextWithinLimit(response, maxResponseBytes);
            if (!responseTextResult.ok) {
                return { ok: false, reason: 'response_too_large', requestBytes, message: `response exceeded ${maxResponseBytes} bytes` };
            }
            const responseText = responseTextResult.text;
            const responseBytes = responseTextResult.bytes;
            let responseJson: unknown;
            try {
                responseJson = JSON.parse(responseText);
            } catch (error) {
                return {
                    ok: false,
                    reason: 'malformed_response',
                    requestBytes,
                    responseBytes,
                    message: error instanceof Error ? error.message : String(error),
                };
            }
            if (requestOptions?.signal?.aborted) {
                return { ok: false, reason: 'cancelled', requestBytes, responseBytes };
            }
            const elapsed = performance.now() - startTime;
            const processingTimeMs = responseJson && typeof responseJson === 'object'
                ? (responseJson as { processingTimeMs?: unknown }).processingTimeMs
                : undefined;
            rustLog.info(`[RustEngine] Batch ${endpoint}: ${itemCount} runs in ${elapsed.toFixed(2)}ms (Rust: ${String(processingTimeMs ?? 'unknown')}ms)`);
            return { ok: true, response: responseJson, requestBytes, responseBytes, elapsedMs: elapsed };
        } catch (error) {
            const reason = requestOptions?.signal?.aborted
                ? 'cancelled'
                : timeoutSignal.aborted
                    ? 'timeout'
                    : 'network_error';
            rustLog.error('[RustEngine] Batch backtest error:', error);
            return {
                ok: false,
                reason,
                requestBytes,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ========================================================================
    // Data Caching API (for large datasets)
    // ========================================================================

    /**
     * Cache OHLCV data on the Rust server for reuse in subsequent batch requests.
     * This is critical for large datasets (1M+ bars) where sending data once
     * is much more efficient than sending it with every batch.
     * 
     * Returns cache ID to use in runCachedBatchBacktest.
     */
    async cacheData(data: OHLCVData[], requestOptions?: RustBatchRequestOptions): Promise<string | null> {
        if (requestOptions?.signal?.aborted || !await this.checkHealth(requestOptions?.signal)) {
            return null;
        }

        const dataHash = this.generateDataHash(data);

        // If we already have this data cached, return existing ID
        const cachedDataId = this.getCachedDataId(dataHash);
        if (cachedDataId) {
            rustLog.info(`[RustEngine] Using existing cache ID: ${cachedDataId}`);
            return cachedDataId;
        }

        try {
            rustLog.info(`[RustEngine] Caching ${data.length} bars...`);
            const startTime = performance.now();
            const packedData = packMultiAssetData(data);
            const body = JSON.stringify(packedData ? { packedData } : { data });
            const requestBytes = new TextEncoder().encode(body).byteLength;
            if (requestOptions?.maxRequestBytes !== undefined && requestBytes > requestOptions.maxRequestBytes) {
                rustLog.warn(`[RustEngine] Cache request exceeds ${requestOptions.maxRequestBytes} bytes`);
                return null;
            }
            const timeoutSignal = AbortSignal.timeout(requestOptions?.timeoutMs ?? this.cacheTimeoutMs);
            const requestSignal = requestOptions?.signal
                ? AbortSignal.any([requestOptions.signal, timeoutSignal])
                : timeoutSignal;

            const response = await this.fetchImpl(`${this.baseUrl}/api/data/cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: requestSignal,
            });

            if (requestOptions?.signal?.aborted) return null;

            if (!response.ok) {
                rustLog.error('[RustEngine] Cache data failed:', response.statusText);
                return null;
            }

            const declaredResponseBytes = Number(response.headers.get('content-length'));
            if (
                requestOptions?.maxResponseBytes !== undefined
                && Number.isFinite(declaredResponseBytes)
                && declaredResponseBytes > requestOptions.maxResponseBytes
            ) {
                return null;
            }
            const responseTextResult = await readResponseTextWithinLimit(response, requestOptions?.maxResponseBytes);
            if (!responseTextResult.ok) {
                return null;
            }
            if (requestOptions?.signal?.aborted) return null;
            const responseText = responseTextResult.text;
            const result = JSON.parse(responseText) as { cacheId?: unknown; barCount?: unknown };
            if (requestOptions?.signal?.aborted) return null;
            const elapsed = performance.now() - startTime;
            const cacheId = typeof result?.cacheId === "string" && result.cacheId.length > 0
                ? result.cacheId
                : null;
            if (!cacheId) {
                rustLog.error('[RustEngine] Cache data returned an invalid cache ID');
                return null;
            }
            const barCount = Number.isFinite(result?.barCount) ? result.barCount : data.length;

            this.rememberCachedDataId(dataHash, cacheId);

            rustLog.info(`[RustEngine] Cached ${barCount} bars in ${elapsed.toFixed(2)}ms, ID: ${cacheId}`);

            return cacheId;
        } catch (error) {
            rustLog.error('[RustEngine] Cache data error:', error);
            return null;
        }
    }

    async cacheMultiAssetDataWithStatus(
        workloads: Array<{ id: string; data: OHLCVData[] }>,
        requestOptions?: RustBatchRequestOptions,
    ): Promise<RustBatchTransportResult> {
        return this.runBatchRequestWithStatus(
            '/api/data/multi-cache',
            {
                workloads: workloads.map((workload) => {
                    const packedData = packMultiAssetData(workload.data);
                    return {
                        id: workload.id,
                        ...(packedData ? { packedData } : { data: workload.data }),
                    };
                }),
            },
            workloads.length,
            undefined,
            requestOptions,
        );
    }

    /**
     * Clear the local cache tracking (server cache is managed automatically)
     */
    clearLocalCache(): void {
        this.cachedDataIdsByHash.clear();
    }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/** Global Rust engine client instance */
export const rustEngine = new RustEngineClient();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if Rust engine is available and return it, otherwise return null
 */
export async function getRustEngine(): Promise<RustEngineClient | null> {
    if (await rustEngine.checkHealth()) {
        return rustEngine;
    }
    return null;
}

/**
 * Get engine status for display
 */
export async function getEngineStatus(): Promise<{
    engine: 'rust' | 'typescript';
    version?: string;
}> {
    if (await rustEngine.checkHealth()) {
        return { engine: 'rust', version: rustEngine.version ?? undefined };
    }
    return { engine: 'typescript' };
}



