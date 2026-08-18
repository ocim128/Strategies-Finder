/**
 * Rust Trading Engine Client
 *
 * Provides interface to the high-performance Rust backend for:
 * - Backtesting (100x faster than TypeScript)
 *
 * Falls back to TypeScript implementation when Rust server is unavailable.
 */

import { OHLCVData, Signal, BacktestResult, BacktestSettings } from './types/strategies';
import { debugLogger } from './debug-logger';
import { isSmartTradeSizingMode, type AdvancedSizingSettings, type TradeSizingMode } from './types/backtest';

export type RustBatchRequestOptions = {
    signal?: AbortSignal;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    /** Test/diagnostic override; production callers use the 120s default. */
    timeoutMs?: number;
};

export type RustBatchTransportFailureReason =
    | 'health_unavailable'
    | 'unsupported_sizing'
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

type RustFetch = typeof fetch;

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

interface RustHealthResponse {
    status: string;
    version?: string;
    engine: string;
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
}

// ============================================================================
// Rust Engine Client
// ============================================================================

export class RustEngineClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: RustFetch;
    private isAvailable: boolean = false;
    private engineVersion: string | null = null;
    private lastHealthCheck: number = 0;
    private readonly healthCheckInterval = 30000; // 30 seconds
    private readonly healthCheckFailureBackoff = 5000; // 5 seconds negative cache
    private lastHealthCheckFailed: boolean = false;
    private readonly backtestTimeoutMs = 30_000;
    private readonly batchBacktestTimeoutMs = 120_000;
    private readonly cacheTimeoutMs = 180_000;

    // Data caching for large datasets
    private readonly maxCachedDataEntries = 4;
    private readonly cachedDataIdsByHash = new Map<string, string>();

    constructor(baseUrl: string = 'http://127.0.0.1:3030', fetchImpl: RustFetch = fetch) {
        this.baseUrl = baseUrl;
        this.fetchImpl = fetchImpl;
    }

    /**
     * Generate a simple hash for OHLCV data to detect changes
     */
    private generateDataHash(data: OHLCVData[]): string {
        if (data.length === 0) return 'empty';
        const maxSamples = 200_000;
        const stride = Math.max(1, Math.floor(data.length / maxSamples));
        let hash = 0x811c9dc5;

        for (let i = 0; i < data.length; i += stride) {
            hash = this.hashBar(hash, data[i], i);
        }

        const lastIndex = data.length - 1;
        if (lastIndex % stride !== 0) {
            hash = this.hashBar(hash, data[lastIndex], lastIndex);
        }

        const firstTime = this.normalizeTimeForHash(data[0].time);
        const lastTime = this.normalizeTimeForHash(data[lastIndex].time);
        return `${data.length}-${firstTime}-${lastTime}-${hash.toString(16)}`;
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
                const data: RustHealthResponse = await response.json();
                this.isAvailable = data.status === 'healthy';
                this.engineVersion = typeof data.version === 'string' ? data.version : null;
                this.lastHealthCheckFailed = !this.isAvailable;
                this.lastHealthCheck = now;
                if (this.isAvailable) {
                    rustLog.info(`[RustEngine] Connected: v${this.engineVersion ?? 'unknown'}`);
                } else {
                    rustLog.warn(`[RustEngine] Health check returned status "${data.status}", using TypeScript fallback`);
                }
                return this.isAvailable;
            }
            this.isAvailable = false;
            this.engineVersion = null;
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = now;
        } catch (error) {
            this.isAvailable = false;
            this.engineVersion = null;
            this.lastHealthCheckFailed = true;
            this.lastHealthCheck = now;
            rustLog.warn('[RustEngine] Server not available, using TypeScript fallback');
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

    // ========================================================================
    // Backtest API
    // ========================================================================

    /**
     * Run backtest on Rust engine
     */
    async runBacktest(
        data: OHLCVData[],
        signals: Signal[],
        initialCapital: number,
        positionSizePercent: number,
        commissionPercent: number,
        settings: BacktestSettings,
        sizing?: { mode: TradeSizingMode; fixedTradeAmount: number; advancedSizing?: AdvancedSizingSettings }
    ): Promise<BacktestResult | null> {
        if (!await this.checkHealth()) {
            return null;
        }
        if (sizing && isSmartTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust backend, using TypeScript fallback`);
            return null;
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
            };

            const startTime = performance.now();

            const response = await this.fetchImpl(`${this.baseUrl}/api/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.backtestTimeoutMs),
            });

            if (!response.ok) {
                rustLog.error('[RustEngine] Backtest failed:', response.statusText);
                return null;
            }

            const result: BacktestResult = await response.json();
            const elapsed = performance.now() - startTime;

            rustLog.info(`[RustEngine] Backtest completed in ${elapsed.toFixed(2)}ms (${data.length} bars)`);

            return result;
        } catch (error) {
            rustLog.error('[RustEngine] Backtest error:', error);
            return null;
        }
    }

    /**
     * Run batch backtests on Rust engine - all backtests run in parallel
     * This is MUCH faster than individual backtest calls due to:
     * 1. Single HTTP request (no per-request overhead)
     * 2. OHLCV data sent only once
     * 3. All backtests run in parallel using Rayon
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
        const request = {
            data,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
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
        const request = {
            cacheId,
            items,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            baseSettings,
            sizing,
            compact,
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
        if (sizing && isSmartTradeSizingMode(sizing.mode)) {
            rustLog.warn(`[RustEngine] ${sizing.mode} sizing is not supported on Rust batch backtests, using TypeScript fallback`);
            return { ok: false, reason: 'unsupported_sizing' };
        }

        let body: string;
        try {
            body = JSON.stringify(request);
        } catch (error) {
            return {
                ok: false,
                reason: 'malformed_response',
                message: error instanceof Error ? error.message : String(error),
            };
        }
        const requestBytes = new TextEncoder().encode(body).byteLength;
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
            const body = JSON.stringify({ data });
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
            const responseText = responseTextResult.text;
            const result = JSON.parse(responseText) as { cacheId?: unknown; barCount?: unknown };
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



